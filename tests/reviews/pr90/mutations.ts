import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pathToFileURL } from "node:url";
import {
  admission,
  type H,
  hex,
  MODEL,
  open,
  QUEUE,
  read,
  root,
  sqlText,
  TASK,
  WORKER,
} from "./harness.ts";
async function exercise(
  source: string,
  fn: (h: H) => Promise<void>,
  over: Record<string, unknown> = {},
) {
  const h = await open(over, source);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}
async function dollars(h: H) {
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
}
async function clock(h: H) {
  let pending: Promise<Record<string, unknown>> | undefined;
  await h.a.begin(async (tx) => {
    await tx.unsafe(
      `with c as(select clock_timestamp() as t) update ${h.schema}.discovery_smoke_authorizations set authorized_at=c.t-interval '299 seconds',deadline_at=c.t+interval '1 second' from c`,
    );
    pending = h.admit(h.op("late"), h.b);
    await h.blocked();
    await tx.unsafe(
      `select pg_sleep(greatest(0,extract(epoch from deadline_at-clock_timestamp()))::double precision+0.02) from ${h.schema}.discovery_smoke_authorizations`,
    );
  });
  assertEquals((await pending!).decision, "stopped");
}
function sqlMutant(
  name: string,
  from: string,
  to: string,
  fn: (h: H) => Promise<void>,
  over: Record<string, unknown> = {},
) {
  Deno.test("PR90 mutation killed: " + name, async () => {
    assert(sqlText.includes(from));
    await exercise(sqlText, fn, over);
    await assertRejects(
      () => exercise(sqlText.replace(from, to), fn, over),
      Error,
      "Values are not equal",
    );
  });
}
sqlMutant(
  "admission row lock",
  "select * into a from public.discovery_smoke_authorizations where queue_id = p_queue for update;",
  "select * into a from public.discovery_smoke_authorizations where queue_id = p_queue;",
  dollars,
);
sqlMutant(
  "clock after lock",
  "v_now := clock_timestamp();",
  "v_now := now();",
  clock,
);
sqlMutant(
  "generation fence",
  "t.checkpoint_version is distinct from p_generation",
  "false",
  async (h) => {
    assertEquals(
      (await h.admit(h.op("stale", { generation: 2 }))).decision,
      "stale_generation",
    );
  },
);
sqlMutant(
  "model attempt cap",
  "n_model >= a.model_attempts",
  "false",
  async (h) => {
    for (let i = 0; i < 4; i++) await h.admit(h.op("retry" + i));
    assertEquals(
      (await h.admit(h.op("retry5"))).decision,
      "model_attempt_limit",
    );
  },
  {
    model: {
      allowed_kinds: ["model"],
      allowed_actors: [MODEL],
      maximum_microusd: 1000,
      source: "synthetic",
      liability_bound_ref: "synthetic",
      observed_at: new Date(Date.now() - 1000).toISOString(),
      request_limits: {},
    },
  },
);
sqlMutant(
  "administrative approval privilege",
  "revoke all on function public.authorize_discovery_smoke(uuid, text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;",
  "-- mutation: approval publicly executable",
  async (h) => {
    await h.a.unsafe("set role service_role");
    let allowed = false;
    try {
      await h.a.unsafe(
        `select ${h.schema}.authorize_discovery_smoke($1,'synthetic-v1',$2,$3,300)`,
        [
          QUEUE,
          h.a.json(JSON.parse(JSON.stringify(h.q))),
          h.a.json({
            "apify:curious_coder~linkedin-jobs-scraper": 2,
            "apify:harvestapi~linkedin-company": 1,
            "firecrawl:scrape": 1,
            "firecrawl:map": 1,
          }),
        ],
      );
      allowed = true;
    } catch (e) {
      assert(String(e).includes("permission denied"));
    }
    await h.a.unsafe("reset role");
    assertEquals(allowed, false);
  },
);
async function fork(from: string, to: string) {
  let source = read("supabase/functions/_shared/smokeAdmission.ts");
  assert(source.includes(from));
  source = source.replace(from, to);
  source = source.replaceAll(
    '"./smokeAdmissionRefusal.ts"',
    JSON.stringify(
      pathToFileURL(
        root + "/supabase/functions/_shared/smokeAdmissionRefusal.ts",
      ).href,
    ),
  );
  return await import(
    "data:application/typescript;base64," +
      btoa(String.fromCharCode(...new TextEncoder().encode(source)))
  );
}
Deno.test("PR90 mutation killed: no-context pass-through", async () => {
  const check = async (mod: typeof admission) => {
    let sent = 0;
    const gate = mod.createAdmissionFetch({
      baseFetch: () => {
        sent++;
        return Promise.resolve(new Response("{}"));
      },
      db: {},
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const r = await gate("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: '{"model":"gpt-4.1-mini","max_tokens":1}',
    });
    await r.body?.cancel();
    assertEquals(sent, 0);
  };
  await check(admission);
  const mutant = await fork(
    'if (!ctx) return refuse("no_mission_context");',
    "if (!ctx) return d.baseFetch(input, init);",
  );
  await assertRejects(() => check(mutant), Error, "Values are not equal");
});
Deno.test("PR90 mutation killed: uncertain replay must not become a definite refusal", async () => {
  assertEquals(admission.refusal("uncertain").status, 503);
  const mutant = await fork("PURCHASE_MAY_EXIST.has(decision)", "false");
  assertThrows(
    () => {
      assertEquals(mutant.refusal("uncertain").status, 503);
    },
    Error,
    "Values are not equal",
  );
});
Deno.test("PR90 mutation killed: absence of an approved output bound refuses", async () => {
  const req = {
    method: "POST",
    url: new URL("https://api.openai.com/v1/chat/completions"),
    body: '{"model":"gpt-4.1-mini","max_tokens":1000}',
  };
  const c = admission.classifyRequest(req, null);
  const lim = { max_request_bytes: 20000 };
  assertEquals(admission.boundRequest(req, c, lim).ok, false);
  const mutant = await fork(
    'if (typeof limits.max_output_tokens !== "number") return { ok: false, reason: "no_output_bound" };',
    "// mutation removes output maximum validation",
  );
  assertThrows(
    () => {
      assertEquals(mutant.boundRequest(req, c, lim).ok, false);
    },
    Error,
    "Values are not equal",
  );
});
