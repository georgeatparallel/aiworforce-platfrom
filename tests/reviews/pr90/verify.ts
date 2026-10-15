import { jobsInput, toolContext, withTool } from "./runtimeHarness.ts";
// Explicit review runner, not an automatically discovered production test.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  admission,
  ai,
  DETAILS,
  gpt,
  type H,
  hex,
  installCredits,
  JOBS,
  MAP,
  MODEL,
  open,
  QUEUE,
  SCRAPE,
  strategist,
  TASK,
  tools,
  WORKER,
} from "./harness.ts";
const REQUIRE_SAFE = Deno.env.get("PR90_REQUIRE_SAFE") === "1";
async function test(
  fn: (h: H) => Promise<void>,
  over: Record<string, unknown> = {},
) {
  const h = await open(over);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function modelQuote(cost = 10000) {
  return {
    allowed_kinds: ["model"],
    allowed_actors: [MODEL],
    maximum_microusd: cost,
    source: "synthetic",
    liability_bound_ref: "synthetic",
    observed_at: new Date(Date.now() - 1000).toISOString(),
    request_limits: { max_request_bytes: 20000, max_output_tokens: 1000 },
  };
}
Deno.test("PR90 native: concurrent final-dollar reservations serialize before spending", () =>
  test(async (h) => {
    let pending: Promise<Record<string, unknown>> | undefined;
    await h.a.begin(async (tx) => {
      await tx.unsafe(
        `select id from ${h.schema}.discovery_smoke_authorizations for update`,
      );
      pending = h.admit(h.op("second"), h.b);
      await h.blocked();
      const r = await tx.unsafe(
        `select ${h.schema}.admit_discovery_smoke($1,$2,$3,3,'first','model',$4,'model',$5,null) as r`,
        [QUEUE, WORKER, TASK, MODEL, hex(500)],
      );
      assertEquals(r[0].r.decision, "admitted");
    });
    assertEquals((await pending!).decision, "usd_limit");
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("PR90 native: twelve concurrent model retries admit four attempts, not twelve", () =>
  test(async (h) => {
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) => h.admit(h.op("m" + i), i % 2 ? h.a : h.b),
      ),
    );
    assertEquals(results.filter((r) => r.decision === "admitted").length, 4);
    assertEquals(
      results.filter((r) => r.decision === "model_attempt_limit").length,
      8,
    );
  }, { model: modelQuote(10000) }));
Deno.test("PR90 native: duplicate provider contention issues only one admission", () =>
  test(async (h) => {
    const op = h.op("provider", {
      kind: "provider",
      actor: JOBS,
      template: "jobs",
    });
    let pending: Promise<Record<string, unknown>> | undefined;
    await h.a.begin(async (tx) => {
      const first = await tx.unsafe(
        `select ${h.schema}.admit_discovery_smoke($1,$2,$3,3,$4,'provider',$5,'jobs',$6,null) as r`,
        [QUEUE, WORKER, TASK, op.key, JOBS, op.hash],
      );
      assertEquals(first[0].r.decision, "admitted");
      pending = h.admit(op, h.b);
      await h.blocked();
    });
    assertEquals((await pending!).decision, "uncertain");
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("PR90 native: lock-wait expiry uses post-lock wall clock", () =>
  test(async (h) => {
    let pending: Promise<Record<string, unknown>> | undefined;
    await h.a.begin(async (tx) => {
      await tx.unsafe(
        `with c as(select clock_timestamp() as t) update ${h.schema}.discovery_smoke_authorizations
   set authorized_at=c.t-interval '299 seconds',deadline_at=c.t+interval '1 second' from c`,
      );
      pending = h.admit(h.op("late"), h.b);
      await h.blocked();
      await tx.unsafe(
        `select pg_sleep(greatest(0,extract(epoch from deadline_at-clock_timestamp()))::double precision+0.02) from ${h.schema}.discovery_smoke_authorizations`,
      );
    });
    assertEquals((await pending!).decision, "stopped");
    assertEquals((await h.rows()).length, 0);
  }));
Deno.test("PR90 native: service and client roles cannot mint, widen or erase authorizations", () =>
  test(async (h) => {
    for (const role of ["service_role", "anon", "authenticated"]) {
      await h.a.unsafe(`set role ${role}`);
      await assertRejects(
        () =>
          h.a.unsafe(
            `select ${h.schema}.authorize_discovery_smoke($1,'v','{}','{}',300)`,
            [QUEUE],
          ),
        Error,
        "permission denied",
      );
      await assertRejects(
        () =>
          h.a.unsafe(
            `update ${h.schema}.discovery_smoke_authorizations set total_microusd=0`,
          ),
        Error,
        "permission denied",
      );
      await assertRejects(
        () => h.a.unsafe(`delete from ${h.schema}.discovery_smoke_operations`),
        Error,
        "permission denied",
      );
      if (role === "service_role") {
        assertEquals((await h.admit(h.op("service"))).decision, "admitted");
      } else {await assertRejects(
          () =>
            h.a.unsafe(
              `select * from ${h.schema}.discovery_smoke_authorizations`,
            ),
          Error,
          "permission denied",
        );}
      await h.a.unsafe("reset role");
    }
  }));
Deno.test("PR90 native: crash before admission consumes no hold, after admission consumes a persistent hold", () =>
  test(async (h) => {
    assertEquals((await h.rows()).length, 0);
    const op = h.op("pending");
    assertEquals((await h.admit(op)).decision, "admitted");
    await h.admin.unsafe(`update ${h.schema}.tasks set checkpoint_version=4`);
    assertEquals(
      (await h.admit({ ...op, generation: 4 }, h.b)).decision,
      "uncertain",
    );
    assertEquals((await h.admit(op)).decision, "stale_generation");
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("PR90 native: run attachment survives lost checkpoint; re-keyed question adopts without new purchase", () =>
  test(async (h) => {
    const op = h.op("pending", {
      kind: "provider",
      actor: JOBS,
      template: "jobs",
    });
    const d = await h.admit(op);
    assert(
      await admission.recordReceipt(h.db, {
        queueId: QUEUE,
        key: op.key,
        token: d.reservation_token,
        runId: "synthetic-run",
        datasetId: "synthetic-ds",
      }),
    );
    await h.admin.unsafe(`update ${h.schema}.tasks set checkpoint_version=4`);
    assertEquals(
      (await h.admit({ ...op, key: "new-key", generation: 4 }, h.b)).decision,
      "adopt",
    );
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("PR90 native: a new queue cannot inherit or reset a prior authorization", () =>
  test(async (h) => {
    const next = crypto.randomUUID();
    await h.admit(h.op("old"));
    await h.admin.unsafe(
      `insert into ${h.schema}.lead_mission_queue select $1,workspace_id,request,status,claimed_by,lease_expires_at,task_id,lineage_id,clock_timestamp() from ${h.schema}.lead_mission_queue where id=$2`,
      [next, QUEUE],
    );
    assertEquals(
      (await h.admit(h.op("new", { queue: next }))).decision,
      "not_authorized",
    );
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("PR90 native: cancellation and expired queue/lineage leases refuse new work", () =>
  test(async (h) => {
    await h.admin.unsafe(
      `update ${h.schema}.lead_mission_queue set lease_expires_at=clock_timestamp()-interval '1 second'`,
    );
    assertEquals((await h.admit(h.op("expired"))).decision, "lost_ownership");
    await h.admin.unsafe(
      `update ${h.schema}.lead_mission_queue set lease_expires_at=clock_timestamp()+interval '1 hour',status='cancelled'`,
    );
    assertEquals((await h.admit(h.op("cancelled"))).decision, "stopped");
    assertEquals((await h.rows()).length, 0);
  }));
Deno.test("PR90 native: unknown price, absent parent and global poll exhaustion refuse", () =>
  test(async (h) => {
    assertEquals(
      (await h.admit(h.op("unknown", { template: "unknown" }))).decision,
      "unknown_quote",
    );
    assertEquals(
      (await h.admit(
        h.op("orphan", {
          kind: "poll",
          actor: JOBS,
          template: "polls",
          parent: "missing",
        }),
      )).decision,
      "missing_parent",
    );
    const p = h.op("p", { kind: "provider", actor: JOBS, template: "jobs" });
    assertEquals((await h.admit(p)).decision, "admitted");
    for (let i = 0; i < 5; i++) {
      assertEquals(
        (await h.admit(
          h.op("poll" + i, {
            kind: "poll",
            actor: JOBS,
            template: "polls",
            parent: "p",
          }),
        )).decision,
        "admitted",
      );
    }
    assertEquals(
      (await h.admit(
        h.op("poll6", {
          kind: "poll",
          actor: JOBS,
          template: "polls",
          parent: "p",
        }),
      )).decision,
      "poll_limit",
    );
  }));
async function heldStatus(h: H) {
  const r = await h.admin.unsafe(
    `select status,reserved_credits,refunded_credits from ${h.schema}.credit_transactions`,
  );
  return r.map((x) => ({
    status: x.status,
    reserved: x.reserved_credits,
    refunded: x.refunded_credits,
  }));
}
Deno.test("PR90 native billing control: uncertain start and ordinary replay keep the existing credit held", () =>
  test(async (h) => {
    await installCredits(h);
    let calls = 0;
    await withTool(h, () => {
      calls++;
      return Promise.resolve(
        json(503, { error: "synthetic uncertain vendor" }),
      );
    }, async () => {
      const first = await tools.runTool(
        "source_with_apify",
        jobsInput,
        toolContext(h),
      );
      assert(String(first.error).includes("apify_start_uncertain"));
      assertEquals((await heldStatus(h))[0].status, "reserved");
      await tools.runTool("source_with_apify", jobsInput, toolContext(h));
      assertEquals((await heldStatus(h))[0].status, "reserved");
    });
    assertEquals(calls, 1);
  }));
for (const failure of ["rpc-outage", "cancelled-replay"]) {
  Deno.test(
    (failure === "rpc-outage" ? "SAF-001 [P1] " : "SAF-002 [P1] ") +
      "PR90 DEFECT characterization: " + failure +
      " refunds an existing uncertain purchase hold",
    () =>
      test(async (h) => {
        await installCredits(h);
        let calls = 0;
        const vendor = () => {
          calls++;
          return Promise.resolve(
            json(503, { error: "synthetic uncertain vendor" }),
          );
        };
        await withTool(h, vendor, async () => {
          await tools.runTool("source_with_apify", jobsInput, toolContext(h));
        });
        assertEquals((await heldStatus(h))[0].status, "reserved");
        if (failure === "cancelled-replay") {
          await h.admin.unsafe(
            `select ${h.schema}.stop_discovery_smoke($1,'review cancellation')`,
            [QUEUE],
          );
        }
        const failedDb = failure === "rpc-outage"
          ? {
            ...h.db,
            rpc: (fn: string, args: Record<string, unknown>) =>
              fn === "admit_discovery_smoke"
                ? Promise.resolve({
                  data: null,
                  error: { message: "synthetic admission outage" },
                })
                : h.db.rpc(fn, args),
          }
          : h.db;
        await withTool(h, vendor, async () => {
          await tools.runTool("source_with_apify", jobsInput, toolContext(h));
        }, failedDb);
        assertEquals(calls, 1);
        assertEquals(
          (await heldStatus(h))[0].status,
          REQUIRE_SAFE ? "reserved" : "not_charged",
        );
        assertEquals((await heldStatus(h))[0].refunded, REQUIRE_SAFE ? 0 : 1);
        assertEquals((await h.rows()).length, 1);
      }),
  );
}
Deno.test("SAF-004 [P1] PR90 bounds: absent output limit refuses, remote multimodal input remains accepted", () => {
  const url = new URL("https://api.openai.com/v1/chat/completions");
  const req = {
    method: "POST",
    url,
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "https://images.example/large-image.png" },
        }],
      }],
      max_tokens: 10,
    }),
  };
  const c = admission.classifyRequest(req, null);
  assertEquals(
    admission.boundRequest(req, c, { max_request_bytes: 20000 }).ok,
    false,
  );
  assertEquals(
    admission.boundRequest(req, c, {
      max_request_bytes: 20000,
      max_output_tokens: 1000,
    }).ok,
    !REQUIRE_SAFE,
  );
  assert(
    new TextEncoder().encode(req.body).length < 300,
    "small serialized request does not include the remote image bytes",
  );
});
Deno.test("SAF-006 [P1] PR90 DEFECT characterization: malformed admitted deadline fails open at send", () =>
  test(async (h) => {
    let calls = 0;
    const db = {
      ...h.db,
      rpc: (fn: string, args: Record<string, unknown>) =>
        fn === "admit_discovery_smoke"
          ? Promise.resolve({
            data: { decision: "admitted", reservation_token: "synthetic" },
            error: null,
          })
          : h.db.rpc(fn, args),
    };
    const gate = admission.createAdmissionFetch({
      db,
      baseFetch: () => {
        calls++;
        return Promise.resolve(json(200, {}));
      },
      ownApi: "https://project.invalid",
      log: () => {},
    });
    await admission.missionAdmission.run(
      h.ctx,
      () =>
        gate("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [],
            max_tokens: 1,
          }),
        }),
    );
    assertEquals(calls, REQUIRE_SAFE ? 0 : 1);
  }));
Deno.test("PR90 native: a committed admission whose response is lost consumes a slot but sends nothing", () =>
  test(async (h) => {
    let sent = 0;
    const db = {
      ...h.db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        const result = await h.db.rpc(fn, args);
        if (fn === "admit_discovery_smoke") {
          throw new Error("synthetic lost RPC answer after commit");
        }
        return result;
      },
    };
    const gate = admission.createAdmissionFetch({
      db,
      baseFetch: () => {
        sent++;
        return Promise.resolve(json(201, {}));
      },
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const req = { method: "POST", body: "{}" };
    const first = await admission.missionAdmission.run(
      { ...h.ctx },
      () =>
        gate(
          "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
          req,
        ),
    );
    assertEquals(first.status, 409);
    await first.body?.cancel();
    assertEquals(sent, 0);
    assertEquals((await h.rows()).length, 1);
    const recovered = admission.createAdmissionFetch({
      db: h.db,
      baseFetch: () => {
        sent++;
        return Promise.resolve(json(201, {}));
      },
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const second = await admission.missionAdmission.run(
      { ...h.ctx },
      () =>
        recovered(
          "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
          req,
        ),
    );
    assertEquals(second.status, 503);
    await second.body?.cancel();
    assertEquals(sent, 0);
  }));
Deno.test("PR90 native: post-admission revocation refuses transport and retains its reservation", () =>
  test(async (h) => {
    const controller = new AbortController();
    let sent = 0;
    const db = {
      ...h.db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        const result = await h.db.rpc(fn, args);
        if (fn === "admit_discovery_smoke") {
          controller.abort("synthetic cancellation after commit");
        }
        return result;
      },
    };
    const gate = admission.createAdmissionFetch({
      db,
      baseFetch: () => {
        sent++;
        return Promise.resolve(json(200, {}));
      },
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const r = await admission.missionAdmission.run(
      { ...h.ctx, signal: controller.signal },
      () =>
        gate("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            max_tokens: 10,
            messages: [],
          }),
        }),
    );
    assertEquals(r.status, 409);
    await r.body?.cancel();
    assertEquals(sent, 0);
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("SAF-007 [P1] PR90 DEFECT characterization: a handler closing during admission still allows transport", () =>
  test(async (h) => {
    let sent = 0;
    const ctx = { ...h.ctx, closedReason: null as string | null };
    const db = {
      ...h.db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        const result = await h.db.rpc(fn, args);
        if (fn === "admit_discovery_smoke") {
          ctx.closedReason = "mission_call_ended";
        }
        return result;
      },
    };
    const gate = admission.createAdmissionFetch({
      db,
      baseFetch: () => {
        sent++;
        return Promise.resolve(json(200, {}));
      },
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const response = await admission.missionAdmission.run(
      ctx,
      () =>
        gate("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [],
            max_tokens: 1,
          }),
        }),
    );
    await response.body?.cancel();
    assertEquals(sent, REQUIRE_SAFE ? 0 : 1);
    assertEquals((await h.rows()).length, 1);
  }));
Deno.test("PR90 native: successful vendor execution with lost run receipt stays uncertain after checkpoint loss", () =>
  test(async (h) => {
    let sent = 0;
    const db = {
      ...h.db,
      rpc: (fn: string, args: Record<string, unknown>) =>
        fn === "record_discovery_smoke_receipt"
          ? Promise.resolve({
            data: null,
            error: { message: "synthetic lost receipt" },
          })
          : h.db.rpc(fn, args),
    };
    const gate = admission.createAdmissionFetch({
      db,
      baseFetch: () => {
        sent++;
        return Promise.resolve(
          json(201, {
            data: {
              id: "synthetic-paid-run",
              defaultDatasetId: "synthetic-dataset",
              status: "RUNNING",
            },
          }),
        );
      },
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const req = { method: "POST", body: "{}" },
      url =
        "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs";
    const first = await admission.missionAdmission.run(
      { ...h.ctx },
      () => gate(url, req),
    );
    await first.body?.cancel();
    await h.admin.unsafe(`update ${h.schema}.tasks set checkpoint_version=4`);
    const second = await admission.missionAdmission.run({
      ...h.ctx,
      generation: 4,
    }, () => gate(url, req));
    assertEquals(second.status, 503);
    await second.body?.cancel();
    assertEquals(sent, 1);
    assertEquals((await h.rows())[0].provider_run_id, null);
  }));
for (const scenario of ["generation", "cancellation"]) {
  Deno.test(
    "PR90 RACE characterization: " + scenario +
      " can change before an already-checked admission commits",
    () =>
      test(async (h) => {
        const lock = Math.floor(Math.random() * 1000000000);
        await h.admin.unsafe(
          `create function ${h.schema}.review_pause() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${lock});return new;end $$;
 create trigger review_pause before insert on ${h.schema}.discovery_smoke_operations for each row execute function ${h.schema}.review_pause()`,
        );
        await h.a.unsafe("select pg_advisory_lock($1)", [lock]);
        let pending: Promise<Record<string, unknown>> | undefined;
        try {
          pending = h.admit(h.op("race"), h.b);
          await h.blocked();
          if (scenario === "generation") {
            await h.admin.unsafe(
              `update ${h.schema}.tasks set checkpoint_version=4`,
            );
          } else {await h.admin.unsafe(
              `update ${h.schema}.lead_mission_queue set status='cancelled'`,
            );}
          await h.a.unsafe("select pg_advisory_unlock($1)", [lock]);
          assertEquals((await pending).decision, "admitted");
          assertEquals((await h.rows()).length, 1);
        } finally {
          await h.a.unsafe("select pg_advisory_unlock($1)", [lock]);
          if (pending) await pending.catch(() => {});
        }
      }),
  );
}
Deno.test("SAF-003 [P1] PR90 Firecrawl characterization: retry is suppressed but uncertain credit is refunded", () =>
  test(async (h) => {
    await installCredits(h);
    let calls = 0;
    await withTool(h, () => {
      calls++;
      return Promise.resolve(
        json(503, { error: "synthetic uncertain Firecrawl failure" }),
      );
    }, async () => {
      const result = await tools.runTool("scrape_url", {
        url: "https://company.example",
        max_pages: 1,
        defer_persistence: true,
      }, toolContext(h));
      assertEquals(result.ok, false);
      assertEquals(calls, 1, "the gate suppresses the second physical attempt");
      assertEquals(
        (await heldStatus(h))[0].status,
        REQUIRE_SAFE ? "reserved" : "not_charged",
      );
      assertEquals((await h.rows()).length, 1);
    });
  }));
Deno.test("PR90 native: provider, model and combined USD caps refuse prospective excess", () =>
  test(async (h) => {
    await h.admin.unsafe(
      `update ${h.schema}.discovery_smoke_authorizations set total_microusd=210000`,
    );
    assertEquals(
      (await h.admit(
        h.op("provider200", {
          kind: "provider",
          actor: JOBS,
          template: "jobs",
        }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        h.op("provider-extra", {
          kind: "provider",
          actor: DETAILS,
          template: "details",
        }),
      )).decision,
      "usd_limit",
    );
    assertEquals((await h.admit(h.op("combined-extra"))).decision, "usd_limit");
    await h.admin.unsafe(
      `update ${h.schema}.discovery_smoke_authorizations set total_microusd=250000`,
    );
    assertEquals((await h.admit(h.op("model20"))).decision, "admitted");
    assertEquals((await h.admit(h.op("model40"))).decision, "admitted");
    assertEquals((await h.admit(h.op("model60"))).decision, "usd_limit");
  }, {
    jobs: {
      ...({
        allowed_kinds: ["provider"],
        allowed_actors: [JOBS],
        maximum_microusd: 200000,
        discovery_page: true,
        source: "synthetic",
        liability_bound_ref: "synthetic",
        observed_at: new Date(Date.now() - 1000).toISOString(),
        request_limits: { max_request_bytes: 4096 },
      }),
    },
    model: modelQuote(20000),
  }));
Deno.test("PR90 native: actor, purchase and discovery-page counters each refuse independently", () =>
  test(async (h) => {
    await h.admin.unsafe(
      `update ${h.schema}.discovery_smoke_authorizations set provider_purchases=1`,
    );
    assertEquals(
      (await h.admit(
        h.op("map", { kind: "provider", actor: MAP, template: "map" }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        h.op("scrape", { kind: "provider", actor: SCRAPE, template: "scrape" }),
      )).decision,
      "purchase_limit",
    );
    await h.admin.unsafe(
      `update ${h.schema}.discovery_smoke_authorizations set provider_purchases=5`,
    );
    assertEquals(
      (await h.admit(
        h.op("map2", { kind: "provider", actor: MAP, template: "map" }),
      )).decision,
      "actor_limit",
    );
    assertEquals(
      (await h.admit(
        h.op("page1", { kind: "provider", actor: JOBS, template: "jobs" }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        h.op("page2", { kind: "provider", actor: JOBS, template: "jobs" }),
      )).decision,
      "page_limit",
    );
  }));
Deno.test("PR90 receipt characterization: over-quote usage in the start response is not recorded", () =>
  test(async (h) => {
    const gate = admission.createAdmissionFetch({
      db: h.db,
      baseFetch: () =>
        Promise.resolve(
          json(201, {
            data: {
              id: "synthetic-overrun",
              defaultDatasetId: "ds-overrun",
              status: "SUCCEEDED",
              usageTotalUsd: 1,
            },
          }),
        ),
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const r = await admission.missionAdmission.run(
      { ...h.ctx },
      () =>
        gate(
          "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
          { method: "POST", body: "{}" },
        ),
    );
    await r.body?.cancel();
    assertEquals((await h.rows())[0].reported_microusd, null);
    assertEquals(
      (await h.admit(
        h.op("still-admitted", {
          kind: "provider",
          actor: MAP,
          template: "map",
        }),
      )).decision,
      "admitted",
    );
  }));

Deno.test("PR90 actual GPT transport: each physical retry obtains its own durable admission", () =>
  test(async (h) => {
    let calls = 0;
    await withTool(h, () => {
      calls++;
      return Promise.resolve(
        calls === 1 ? json(503, {}) : json(200, {
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    }, async () => {
      const r = await gpt.gptStructured({
        purpose: "synthetic retry",
        model: "gpt-4.1-mini",
        system: "synthetic",
        user: "return {}",
        maxTokens: 10,
      }, {
        readEnv: (k: string) =>
          k === "OPENAI_API_KEY" ? "synthetic" : undefined,
        sleep: () => Promise.resolve(),
        log: () => {},
      });
      assertEquals(r.ok, true);
      assertEquals(calls, 2);
      assertEquals((await h.rows()).length, 2);
    });
  }, { model: modelQuote(10000) }));
Deno.test("PR90 actual GPT transport: missing request output-token limit refuses before admission or vendor", () =>
  test(async (h) => {
    let calls = 0;
    await withTool(h, () => {
      calls++;
      return Promise.resolve(json(200, {}));
    }, async () => {
      const r = await gpt.gptStructured({
        purpose: "synthetic missing output bound",
        model: "gpt-4.1-mini",
        system: "synthetic",
        user: "return {}",
      }, {
        readEnv: (k: string) =>
          k === "OPENAI_API_KEY" ? "synthetic" : undefined,
        log: () => {},
      });
      assertEquals(r.ok, false);
      assertEquals(calls, 0);
      assertEquals((await h.rows()).length, 0);
    });
  }));

Deno.test("PR90 actual generic model fallback: both physical vendors require distinct reservations", () =>
  test(async (h) => {
    const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
    const saved = names.map((k) => Deno.env.get(k));
    const calls: string[] = [];
    try {
      names.forEach((k) => Deno.env.set(k, "synthetic"));
      await withTool(h, (input) => {
        const url = String(input);
        calls.push(new URL(url).hostname);
        return Promise.resolve(
          url.includes("api.anthropic.com") ? json(500, {}) : json(200, {
            choices: [{ message: { content: "synthetic fallback response" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      }, async () => {
        const result = await ai.generateText({
          taskType: "helper",
          messages: [{ role: "user", content: "synthetic control" }],
          maxTokens: 10,
        });
        assertEquals(result.ok, true);
        assertEquals(calls, ["api.anthropic.com", "api.openai.com"]);
        assertEquals((await h.rows()).length, 2);
      });
    } finally {
      names.forEach((k, i) =>
        saved[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[i]!)
      );
    }
  }, {
    model: modelQuote(10000),
    anthropic: {
      ...modelQuote(10000),
      allowed_actors: ["anthropic:claude-haiku-4-5-20251001"],
    },
  }));

Deno.test("PR90 actual strategist transport: OpenAI is admitted and the gateway cannot escape the allowlist", () =>
  test(async (h) => {
    let sent = 0;
    await withTool(h, () => {
      sent++;
      return Promise.resolve(json(200, {
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    }, async () => {
      const call = {
        model: "gpt-4.1-mini",
        systemPrompt: "synthetic",
        userMessage: "{}",
        maxCompletionTokens: 10,
      };
      const allowed = await strategist.completeOpenAiCompatible(call, {
        provider: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        headers: {},
      });
      assertEquals(allowed.ok, true);
      assertEquals(sent, 1);
      const blocked = await strategist.completeOpenAiCompatible(call, {
        provider: "lovable_ai",
        endpoint: "https://ai.gateway.lovable.dev/v1/chat/completions",
        headers: {},
      });
      assertEquals(blocked.ok, false);
      assertEquals(sent, 1);
      assertEquals((await h.rows()).length, 1);
    });
  }, { model: modelQuote(10000) }));
