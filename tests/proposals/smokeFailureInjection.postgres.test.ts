// INDEPENDENT reference-contract driver. Only the database is real. No runtime
// adapter is installed; mock counters are not vendor receipts or live guarantees.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { creditSettlementFor } from "../../supabase/functions/_shared/creditAuthorization.ts";
import { APIFY_START_UNCERTAIN } from "../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import {
  ADMIT,
  type Decision,
  HASH,
  LINEAGE,
  quote,
  type Request,
  request,
  TASK,
  WS,
} from "./smokeBudgetHarness.ts";
import { nativeUrl, openNative } from "./nativeSmokeHarness.ts";
type H = Awaited<ReturnType<typeof openNative>>;
class InjectedCrash extends Error {}
function driver(h: H) {
  const calls: string[] = [];
  const admit = async (r: Request, worker: "a" | "b" = "a") =>
    (await h[worker].unsafe(h.rewrite(ADMIT), h.params(r)))[0]
      .result as Decision;
  const attach = async (r: Request, token: string, run: string) =>
    (await h.admin.unsafe(
      `select ${h.schema}.record_discovery_smoke_receipt($1,$2,$3,$4) as ok`,
      [h.id, r.key, token, run],
    ))[0].ok as boolean;
  const execute = async (
    r: Request,
    crash?: "before-provider" | "after-provider" | "lost-checkpoint",
  ) => {
    const d = await admit(r);
    if (d.decision !== "admitted") return d;
    if (crash === "before-provider") {
      throw new InjectedCrash("after durable admission, before mock POST");
    }
    calls.push(r.key); // sole mock side effect; NO network provider exists
    if (crash === "after-provider") {
      throw new InjectedCrash(
        "mock POST completed; receipt/run ID not persisted",
      );
    }
    if (r.kind === "provider") {
      assert(await attach(r, d.reservation_token!, "synthetic-run-" + r.key));
    }
    if (crash === "lost-checkpoint") {
      throw new InjectedCrash("run persisted; volatile checkpoint lost");
    }
    return d;
  };
  const bump = () =>
    h.admin.unsafe(
      `update ${h.schema}.tasks set checkpoint_version=checkpoint_version+1`,
    );
  const held = async () =>
    (await h.admin.unsafe<
      Array<{ n: number; committed: string; actual: string | null }>
    >(
      `select count(*)::int as n,sum(committed_microusd)::text as committed,
    sum(actual_microusd)::text as actual from ${h.schema}.discovery_smoke_operations`,
    ))[0];
  return { calls, admit, attach, execute, bump, held };
}
function native(name: string, fn: (h: H) => Promise<void>) {
  Deno.test({
    name: "native reference failure injection: " + name,
    ignore: !nativeUrl,
    fn: async () => {
      const h = await openNative();
      try {
        await fn(h);
      } finally {
        await h.cleanup();
      }
    },
  });
}
native(
  "crash before provider execution strands a conservative hold; restarted worker buys nothing",
  async (h) => {
    const d = driver(h);
    const r = request(h.id, "before");
    await assertRejects(() => d.execute(r, "before-provider"), InjectedCrash);
    await d.bump();
    assertEquals(
      (await d.admit({ ...r, generation: 2 }, "b")).decision,
      "uncertain",
    );
    assertEquals(d.calls, []);
    assertEquals(await d.held(), { n: 1, committed: "10000", actual: null });
  },
);
native(
  "crash after provider execution before receipt persistence never repeats the mock POST",
  async (h) => {
    const d = driver(h);
    const r = request(h.id, "after");
    await assertRejects(() => d.execute(r, "after-provider"), InjectedCrash);
    await d.bump();
    assertEquals(
      (await d.admit({ ...r, generation: 2 }, "b")).decision,
      "uncertain",
    );
    assertEquals(d.calls, ["after"]);
    assertEquals(await d.held(), { n: 1, committed: "10000", actual: null });
  },
);
native(
  "lost checkpoint adopts the persisted run, including duplicate provider questions under a new key",
  async (h) => {
    const d = driver(h);
    const r = request(h.id, "checkpoint");
    await assertRejects(() => d.execute(r, "lost-checkpoint"), InjectedCrash);
    await d.bump();
    const next = { ...r, generation: 2 };
    const recovered = await d.admit(next, "b");
    assertEquals(recovered.decision, "adopt");
    assertEquals(recovered.provider_run_id, "synthetic-run-checkpoint");
    assertEquals(
      (await d.admit({ ...next, key: "same-question-new-key" }, "b")).decision,
      "adopt",
    );
    assertEquals(d.calls, ["checkpoint"]);
    assertEquals((await d.held()).n, 1);
  },
);
native(
  "re-enqueued task retains held purchases and original deadline; worker cannot mint new authority",
  async (h) => {
    const d = driver(h);
    const r = request(h.id, "original");
    await d.admit(r);
    const next = "44444444-4444-4444-8444-444444444444";
    await h.admin.unsafe(
      `insert into ${h.schema}.tasks values($1,$2,$3,1,'running')`,
      [next, WS, LINEAGE],
    );
    await h.admin.unsafe(
      `update ${h.schema}.lead_lineages set lease_holder=$1`,
      [next],
    );
    assertEquals(
      (await d.admit({ ...r, task: next }, "b")).decision,
      "uncertain",
    );
    await h.admin.unsafe(`update ${h.schema}.discovery_smoke_authorizations
    set authorized_at=authorized_at-interval '6 minutes',deadline_at=deadline_at-interval '6 minutes'`);
    assertEquals(
      (await d.admit(request(h.id, "late", { task: next }), "b")).decision,
      "stopped",
    );
    // Even a service role with schema usage cannot create/reset authorizations.
    await h.admin.unsafe(`grant usage on schema ${h.schema} to service_role`);
    await h.a.unsafe("set role service_role");
    await assertRejects(
      () =>
        h.a.unsafe(
          `select ${h.schema}.authorize_discovery_smoke($1,$2,$3,$4,$5)`,
          [WS, LINEAGE, HASH, "synthetic-v1", h.a.json({})],
        ),
      Error,
      "permission denied",
    );
    await h.a.unsafe("reset role");
    assertEquals(d.calls, []);
  },
);
native(
  "stale generation, different lease holder and expired lease refuse new work",
  async (h) => {
    const d = driver(h);
    await d.bump();
    assertEquals(
      (await d.admit(request(h.id, "stale"))).decision,
      "stale_generation",
    );
    await h.admin.unsafe(
      `update ${h.schema}.lead_lineages set lease_holder=$1`,
      [WS],
    );
    assertEquals(
      (await d.admit(request(h.id, "lease", { generation: 2 }))).decision,
      "lost_ownership",
    );
    await h.admin.unsafe(
      `update ${h.schema}.lead_lineages set lease_holder=$1,lease_expires_at=clock_timestamp()-interval '1 second'`,
      [TASK],
    );
    assertEquals(
      (await d.admit(request(h.id, "expired", { generation: 2 }))).decision,
      "stopped",
    );
    assertEquals(d.calls, []);
  },
);
native(
  "cancellation during pending purchase retains liability and permits only safe late attachment",
  async (h) => {
    const d = driver(h);
    const r = request(h.id, "pending");
    const first = await d.admit(r);
    await h.admin.unsafe(`select ${h.schema}.stop_discovery_smoke($1)`, [h.id]);
    assertEquals((await d.admit(request(h.id, "new"))).decision, "stopped");
    assert(await d.attach(r, first.reservation_token!, "late-synthetic-run"));
    assertEquals(await d.held(), { n: 1, committed: "10000", actual: null });
    assertEquals(d.calls, []);
  },
);
native(
  "uncertain billing stays held even when a mock credit reaper refunds customer credits",
  async (h) => {
    const d = driver(h);
    const r = request(h.id, "uncertain");
    await d.admit(r);
    assertEquals(
      creditSettlementFor({
        ok: false,
        error: APIFY_START_UNCERTAIN + ":mock-timeout",
      }).action,
      "hold",
    );
    // Customer credit policy is NOT changed; this is independent synthetic state.
    const mockBilling = { credit_status: "reserved" };
    mockBilling.credit_status = "released";
    assertEquals((await d.admit(r, "b")).decision, "uncertain");
    assertEquals(await d.held(), { n: 1, committed: "10000", actual: null });
    assertEquals(mockBilling.credit_status, "released");
    assertEquals(d.calls, []);
  },
);
native(
  "priced model retries all consume slots and unknown pricing never executes a mock model",
  async (h) => {
    const d = driver(h);
    for (let i = 0; i < 4; i++) {
      assertEquals(
        (await d.execute(request(h.id, "model-" + i, {
          kind: "model",
          actor: "model",
          amount: 1,
          quote: quote(1),
        }))).decision,
        "admitted",
      );
    }
    assertEquals(
      (await d.execute(
        request(h.id, "model-five", {
          kind: "model",
          actor: "model",
          amount: 1,
          quote: quote(1),
        }),
      )).decision,
      "purchase_limit",
    );
    assertEquals(
      (await d.execute(
        request(h.id, "unknown-model", {
          kind: "model",
          actor: "model",
          amount: 1,
          quote: quote(1, { template_id: "unknown" }),
        }),
      )).decision,
      "unknown_quote",
    );
    assertEquals(d.calls.length, 4);
    assertEquals((await d.held()).committed, "4");
  },
);
