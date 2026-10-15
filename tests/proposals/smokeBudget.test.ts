import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  ACTOR,
  ADMIT,
  APPROVED_QUOTES,
  args,
  type Decision,
  DOWN,
  HASH,
  LINEAGE,
  PRELUDE,
  quote,
  type Request,
  request,
  ROOT,
  UP,
  WS,
} from "./smokeBudgetHarness.ts";

async function open(dataDir?: string, initialize = true, sql = UP) {
  const db = new PGlite(dataDir);
  if (initialize) {
    await db.exec(PRELUDE);
    await db.exec(sql);
  }
  const authorize = async () =>
    (await db.query<{ id: string }>(
      "select public.authorize_discovery_smoke($1,$2,$3,$4,$5) as id",
      [WS, LINEAGE, HASH, "synthetic-v1", APPROVED_QUOTES],
    )).rows[0].id;
  const admit = async (r: Request) =>
    (await db.query<{ result: Decision }>(ADMIT, args(r))).rows[0].result;
  const record = async (
    id: string,
    key: string,
    token: string,
    run: string | null = null,
    receipt: unknown = null,
  ) =>
    (await db.query<{ ok: boolean }>(
      "select public.record_discovery_smoke_receipt($1,$2,$3,$4,$5) as ok",
      [id, key, token, run, receipt],
    )).rows[0].ok;
  return { db, authorize, admit, record };
}
async function testCase(
  fn: (h: Awaited<ReturnType<typeof open>>, id: string) => Promise<void>,
) {
  const h = await open();
  try {
    await fn(h, await h.authorize());
  } finally {
    await h.db.close();
  }
}

Deno.test("proposal: pending model/provider maxima consume separate and combined USD ceilings", () =>
  testCase(async (h, id) => {
    assertEquals(
      (await h.admit(
        request(id, "provider", { amount: 200000, quote: quote(200000) }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        request(id, "model", {
          kind: "model",
          actor: "priced-model",
          amount: 50000,
          quote: quote(50000),
        }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        request(id, "over", {
          kind: "model",
          actor: "priced-model",
          amount: 1,
          quote: quote(1),
        }),
      )).decision,
      "usd_limit",
    );
    const rows = await h.db.query<{ total: string; actual: null }>(
      "select sum(committed_microusd)::text as total,max(actual_microusd) as actual from public.discovery_smoke_operations",
    );
    assertEquals(rows.rows[0], { total: "250000", actual: null });
  }));

Deno.test("proposal: concurrent submitted requests cannot share a final USD slot (PGlite serializes sessions)", () =>
  testCase(async (h, id) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.admit(request(id, `m${i}`, {
          kind: "model",
          actor: "priced-model",
          amount: 30000,
          quote: quote(30000),
        }))),
    );
    assertEquals(results.filter((r) => r.decision === "admitted").length, 1);
    assertEquals(results.filter((r) => r.decision === "usd_limit").length, 7);
  }));

Deno.test("proposal: same-key concurrent contenders admit once; re-keyed identical provider payload never buys again", () =>
  testCase(async (h, id) => {
    const r = request(id, "same");
    const out = await Promise.all(Array.from({ length: 6 }, () => h.admit(r)));
    assertEquals(out.filter((r) => r.decision === "admitted").length, 1);
    assertEquals(out.filter((r) => r.decision === "uncertain").length, 5);
    assertEquals(
      (await h.admit({ ...r, key: "different-key" })).decision,
      "uncertain",
    );
    assertEquals(
      (await h.admit({ ...r, amount: 1 })).decision,
      "operation_mismatch",
    );
  }));

Deno.test("proposal: crash after transport before run/checkpoint stays uncertain; attached run is adopted once", () =>
  testCase(async (h, id) => {
    const r = request(id, "crash");
    const first = await h.admit(r);
    await h.db.exec(`update public.tasks set checkpoint_version=2`);
    assertEquals((await h.admit(r)).decision, "stale_generation");
    assertEquals(
      (await h.admit({ ...r, generation: 2 })).decision,
      "uncertain",
    );
    assert(
      await h.record(id, r.key, first.reservation_token!, "run-synthetic"),
    );
    assertEquals((await h.admit({ ...r, generation: 2 })).decision, "adopt");
    assertEquals(
      await h.record(id, r.key, first.reservation_token!, "different-run"),
      false,
    );
  }));

Deno.test("proposal: pending reservations and fixed deadline survive database close/reopen and a new worker", async () => {
  const dir = await Deno.makeTempDir({ prefix: "offline-smoke-budget-" });
  let h: Awaited<ReturnType<typeof open>> | undefined;
  try {
    h = await open(dir);
    const id = await h.authorize();
    const r = request(id, "pending", {
      kind: "model",
      actor: "priced-model",
      amount: 50000,
      quote: quote(50000),
    });
    assertEquals((await h.admit(r)).decision, "admitted");
    const before = (await h.db.query(
      "select deadline_at from public.discovery_smoke_authorizations",
    )).rows;
    await h.db.close();
    h = undefined;
    h = await open(dir, false);
    await h.db.exec("update public.tasks set checkpoint_version=2");
    assertEquals(await h.authorize(), id);
    assertEquals(
      (await h.db.query(
        "select deadline_at from public.discovery_smoke_authorizations",
      )).rows,
      before,
    );
    assertEquals(
      (await h.admit(
        request(id, "next", {
          generation: 2,
          kind: "model",
          actor: "priced-model",
          amount: 1,
          quote: quote(1),
        }),
      )).decision,
      "usd_limit",
    );
    assertEquals(
      (await h.admit({ ...r, generation: 2 })).decision,
      "uncertain",
    );
  } finally {
    if (h) await h.db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("proposal: all five pending purchases and actor caps survive a generation change", () =>
  testCase(async (h, id) => {
    const actors = [
      ACTOR,
      ACTOR,
      "apify_linkedin_company_details",
      "firecrawl_map",
      "firecrawl_scrape",
    ];
    for (const [i, actor] of actors.entries()) {
      assertEquals(
        (await h.admit(request(id, `p${i}`, { actor }))).decision,
        "admitted",
      );
    }
    await h.db.exec("update public.tasks set checkpoint_version=2");
    assertEquals(
      (await h.admit(request(id, "six", { generation: 2 }))).decision,
      "purchase_limit",
    );
  }));

Deno.test("proposal: actor limit independently rejects a third search before the total purchase cap", () =>
  testCase(async (h, id) => {
    for (const key of ["one", "two"]) {
      assertEquals((await h.admit(request(id, key))).decision, "admitted");
    }
    assertEquals((await h.admit(request(id, "three"))).decision, "actor_limit");
    assertEquals(
      (await h.admit(request(id, "unexpected", { actor: "unapproved-actor" })))
        .decision,
      "actor_limit",
    );
  }));

Deno.test("proposal: polling and pagination are global across generations and fresh keys", () =>
  testCase(async (h, id) => {
    assertEquals((await h.admit(request(id, "purchase"))).decision, "admitted");
    for (let n = 0; n < 5; n++) {
      assertEquals(
        (await h.admit(
          request(id, `poll-${n}`, {
            kind: "poll",
            parent: "purchase",
            amount: 0,
            quote: quote(0),
          }),
        )).decision,
        "admitted",
      );
    }
    assertEquals(
      (await h.admit(
        request(id, "page", { kind: "page", amount: 0, quote: quote(0) }),
      )).decision,
      "admitted",
    );
    await h.db.exec("update public.tasks set checkpoint_version=2");
    assertEquals(
      (await h.admit(
        request(id, "poll-6", {
          kind: "poll",
          parent: "purchase",
          generation: 2,
          amount: 0,
          quote: quote(0),
        }),
      )).decision,
      "transport_limit",
    );
    assertEquals(
      (await h.admit(
        request(id, "page-2", {
          kind: "page",
          generation: 2,
          amount: 0,
          quote: quote(0),
        }),
      )).decision,
      "transport_limit",
    );
    assertEquals(
      (await h.admit(
        request(id, "orphan", {
          kind: "poll",
          parent: "absent",
          generation: 2,
        }),
      )).decision,
      "missing_parent",
    );
  }));

Deno.test("proposal: a billable poll also consumes purchase, actor and provider USD capacity", () =>
  testCase(async (h, id) => {
    assertEquals((await h.admit(request(id, "purchase"))).decision, "admitted");
    assertEquals(
      (await h.admit(
        request(id, "paid-read", { kind: "poll", parent: "purchase" }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        request(id, "third-read", { kind: "poll", parent: "purchase" }),
      )).decision,
      "actor_limit",
    );
  }));

Deno.test("proposal: model attempts include priced/zero-priced calls even when no receipt arrives", () =>
  testCase(async (h, id) => {
    for (let n = 0; n < 4; n++) {
      assertEquals(
        (await h.admit(
          request(id, `m-${n}`, {
            kind: "model",
            actor: "model",
            amount: 0,
            quote: quote(0),
          }),
        )).decision,
        "admitted",
      );
    }
    assertEquals(
      (await h.admit(
        request(id, "m-5", {
          kind: "model",
          actor: "model",
          amount: 0,
          quote: quote(0),
        }),
      )).decision,
      "purchase_limit",
    );
  }));

Deno.test("proposal: absent, stale, unknown or mismatched maximum quotes never admit", () =>
  testCase(async (h, id) => {
    for (
      const q of [
        null,
        {},
        quote(1),
        quote(10000, { currency: "EUR" }),
        quote(10000, { basis: "estimated" }),
        quote(10000, { observed_at: "infinity" }),
        quote(10000, { observed_at: "not-a-date" }),
        quote(10000, { pricing_version: "unknown" }),
        quote(10000, { observed_at: "2000-01-01T00:00:00Z" }),
        quote(10000, { observed_at: "2999-01-01T00:00:00Z" }),
      ]
    ) {
      assert(
        ["unknown_quote", "stale_quote"].includes(
          (await h.admit(request(id, "bad", { quote: q }))).decision,
        ),
      );
    }
    assertEquals(
      (await h.admit(request(id, "null", { amount: null }))).decision,
      "unknown_quote",
    );
    assertEquals(
      (await h.db.query(
        "select count(*)::int as n from public.discovery_smoke_operations",
      )).rows[0],
      { n: 0 },
    );
  }));

Deno.test("proposal: cancellation stops admission but permits late attachment without refund", () =>
  testCase(async (h, id) => {
    const r = request(id, "pending");
    const first = await h.admit(r);
    await h.db.query("select public.stop_discovery_smoke($1)", [id]);
    assertEquals((await h.admit(request(id, "new"))).decision, "stopped");
    assertEquals(await h.authorize(), id);
    assert(await h.record(id, r.key, first.reservation_token!, "late-run"));
    assertEquals(
      (await h.db.query(
        "select sum(committed_microusd)::text as total from public.discovery_smoke_operations",
      )).rows[0],
      { total: "10000" },
    );
  }));

Deno.test("proposal: expiry applies to every operation and cannot be renewed by continuation or reauthorization", () =>
  testCase(async (h, id) => {
    // Owner-only clock fixture; the worker role is denied this UPDATE below.
    await h.db.exec(
      "update public.discovery_smoke_authorizations set authorized_at=authorized_at-interval '6 minutes',deadline_at=deadline_at-interval '6 minutes'",
    );
    const before = (await h.db.query(
      "select deadline_at from public.discovery_smoke_authorizations",
    )).rows;
    await h.db.exec("update public.tasks set checkpoint_version=2");
    assertEquals(await h.authorize(), id);
    assertEquals(
      (await h.db.query(
        "select deadline_at from public.discovery_smoke_authorizations",
      )).rows,
      before,
    );
    for (const kind of ["provider", "model", "page", "poll"]) {
      assertEquals(
        (await h.admit(request(id, kind, { kind, generation: 2 }))).decision,
        "stopped",
      );
    }
  }));

Deno.test("proposal: workspace, criteria, lineage lease and task generation are mandatory", () =>
  testCase(async (h, id) => {
    assertEquals(
      (await h.admit(request(id, "x", { workspace: LINEAGE }))).decision,
      "stale_generation",
    );
    assertEquals(
      (await h.admit(request(id, "x", { criteria: "b".repeat(64) }))).decision,
      "identity_mismatch",
    );
    await h.db.exec(
      "update public.lead_lineages set lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    assertEquals((await h.admit(request(id, "x"))).decision, "stopped");
    await h.db.exec("update public.lead_lineages set status='cancelled'");
    assertEquals((await h.admit(request(id, "x"))).decision, "lost_ownership");
  }));

Deno.test("proposal: actual receipts stay separate, cannot release holds, and over-quote bills stop admission", () =>
  testCase(async (h, id) => {
    const r = request(id, "p");
    const first = await h.admit(r);
    assertEquals(
      await h.record(id, r.key, first.reservation_token!, null, {
        kind: "token_table_estimate",
        amount_microusd: "1",
      }),
      false,
    );
    const receipt = {
      kind: "actual_provider_receipt",
      source: "synthetic receipt control",
      receipt_id: "r1",
      amount_microusd: "10001",
    };
    assert(await h.record(id, r.key, first.reservation_token!, null, receipt));
    assertEquals(
      (await h.db.query(
        "select committed_microusd::text as committed,actual_microusd::text as actual from public.discovery_smoke_operations",
      )).rows[0],
      { committed: "10000", actual: "10001" },
    );
    assertEquals((await h.admit(request(id, "next"))).decision, "stopped");
  }));

Deno.test("proposal: worker cannot mint/reset authorizations, mutate tables, or bypass RPC-only permissions", () =>
  testCase(async (h, id) => {
    await h.db.exec("set role service_role");
    await assertRejects(() => h.authorize(), Error, "permission denied");
    await assertRejects(
      () =>
        h.db.query(
          "update public.discovery_smoke_authorizations set status='active'",
        ),
      Error,
      "permission denied",
    );
    await assertRejects(
      () => h.db.query("delete from public.discovery_smoke_operations"),
      Error,
      "permission denied",
    );
    assertEquals(
      (await h.admit(request(id, "permitted"))).decision,
      "admitted",
    );
    await h.db.exec("reset role");
    for (const role of ["anon", "authenticated"]) {
      await h.db.exec(`set role ${role}`);
      await assertRejects(
        () => h.admit(request(id, "denied")),
        Error,
        "permission denied",
      );
      await assertRejects(
        () => h.db.query("select * from public.discovery_smoke_authorizations"),
        Error,
        "permission denied",
      );
      await h.db.exec("reset role");
    }
  }));

Deno.test("proposal: rollback refuses to destroy authorization/audit; empty schema can roll back and reapply", async () => {
  const h = await open();
  try {
    await h.db.exec(DOWN);
    await h.db.exec(UP);
    await h.authorize();
    await assertRejects(() => h.db.exec(DOWN), Error, "smoke audit exists");
    assertEquals(
      (await h.db.query(
        "select count(*)::int as n from public.discovery_smoke_authorizations",
      )).rows[0],
      { n: 1 },
    );
  } finally {
    await h.db.close();
  }
});

Deno.test("proposal: a newly enqueued task retains the same logical deadline and held purchases", () =>
  testCase(async (h, id) => {
    const r = request(id, "original");
    assertEquals((await h.admit(r)).decision, "admitted");
    const next = "44444444-4444-4444-8444-444444444444";
    await h.db.query(`insert into public.tasks values($1,$2,$3,1,'running')`, [
      next,
      WS,
      LINEAGE,
    ]);
    await h.db.query("update public.lead_lineages set lease_holder=$1", [next]);
    assertEquals(await h.authorize(), id);
    assertEquals((await h.admit({ ...r, task: next })).decision, "uncertain");
    await h.db.exec(
      "update public.discovery_smoke_authorizations set authorized_at=authorized_at-interval '6 minutes',deadline_at=deadline_at-interval '6 minutes'",
    );
    assertEquals(
      (await h.admit(request(id, "new", { task: next }))).decision,
      "stopped",
    );
  }));

Deno.test("proposal: failed durable insert grants no admission and leaves no partial accounting", () =>
  testCase(async (h, id) => {
    await h.db.exec(
      `create function public.synthetic_insert_failure() returns trigger language plpgsql as $$
    begin raise exception 'synthetic checkpoint/storage fault'; end $$;
    create trigger synthetic_failure before insert on public.discovery_smoke_operations
    for each row execute function public.synthetic_insert_failure()`,
    );
    await assertRejects(
      () => h.admit(request(id, "failed")),
      Error,
      "synthetic checkpoint/storage fault",
    );
    assertEquals(
      (await h.db.query(
        "select count(*)::int as n from public.discovery_smoke_operations",
      )).rows[0],
      { n: 0 },
    );
    await h.db.exec(
      "drop trigger synthetic_failure on public.discovery_smoke_operations",
    );
    assertEquals((await h.admit(request(id, "failed"))).decision, "admitted");
  }));

Deno.test("proposal: no migration, runtime, bootstrap or workflow automatically loads this SQL", async () => {
  for (
    const directory of [
      "supabase/migrations/",
      "supabase/migrations-held/",
      ".github/workflows/",
    ]
  ) {
    for await (const entry of Deno.readDir(new URL(directory, ROOT))) {
      if (!entry.isFile) continue;
      assert(!entry.name.includes("smoke_budget"));
      const text = await Deno.readTextFile(
        new URL(directory + entry.name, ROOT),
      );
      assert(!text.includes("proposals/smoke-budget/0001.up.sql"));
    }
  }
  for (
    const path of [
      "tests/db-contract/bootstrap.sh",
      "scripts/local-supabase/rebuild-local-db.sh",
      "supabase/functions/run-agent/index.ts",
      "worker/main.ts",
    ]
  ) {
    let text = "";
    try {
      text = await Deno.readTextFile(new URL(path, ROOT));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    assert(!text.includes("admit_discovery_smoke"));
    assert(!text.includes("smoke-budget/0001.up.sql"));
  }
});
