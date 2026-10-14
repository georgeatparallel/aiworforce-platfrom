// PROPOSED (held, not applied, not wired): provider purchase claims — ONE buyer
// per idempotency key, decided in the database under D1's generation token.
// supabase/migrations-held/20261015120000_provider_purchase_claims.sql, run
// verbatim against real Postgres (PGlite, in-process, nothing reachable).

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const NAME = "20261015120000_provider_purchase_claims";
const UP = read(`supabase/migrations-held/${NAME}.sql`);
const DOWN = read(`supabase/migrations-held/rollback/${NAME}.down.sql`);

// The two tables the functions read, reduced to the columns they touch.
const PRELUDE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create table public.workspaces (id uuid primary key);
  create table public.tasks (id uuid primary key, checkpoint_version integer not null default 0);
`;
const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";

async function open() {
  const db = new PGlite();
  await db.exec(PRELUDE);
  await db.exec(UP);
  await db.query(`insert into public.workspaces values ($1)`, [WS]);
  await db.query(`insert into public.tasks values ($1, 1)`, [TASK]);
  const claim = async (key: string, generation: number, task = TASK) =>
    (await db.query<{ decision: string; provider_run_id: string | null; holder_generation: number | null }>(
      `select * from public.claim_provider_purchase($1, $2, $3, $4)`, [WS, key, task, generation])).rows[0];
  const attach = async (key: string, run: string) =>
    (await db.query<{ ok: boolean }>(`select public.attach_purchase_run($1, $2, $3) as ok`, [WS, key, run])).rows[0].ok;
  const settle = async (key: string, status: string) =>
    (await db.query<{ ok: boolean }>(`select public.settle_provider_purchase($1, $2, $3) as ok`, [WS, key, status])).rows[0].ok;
  const bump = () => db.query(`update public.tasks set checkpoint_version = checkpoint_version + 1 where id = $1`, [TASK]);
  return { db, claim, attach, settle, bump };
}

Deno.test("purchase claims: the first claimant buys; a STALLED worker whose generation was taken over must not", async () => {
  const { claim, bump } = await open();
  assertEquals((await claim("k1", 1)).decision, "buy");                  // worker A, generation 1
  await bump();                                                           // worker B reclaims: generation 2
  assertEquals((await claim("k2", 1)).decision, "stale_generation", "A cannot start any purchase now");
  assertEquals((await claim("k1", 1)).decision, "stale_generation");
});

Deno.test("purchase claims: the reclaiming generation never buys a key A claimed — it adopts A's run, or waits on an uncertain one", async () => {
  const { claim, attach, bump } = await open();
  assertEquals((await claim("k1", 1)).decision, "buy");                  // A claims and POSTs …
  await bump();                                                           // … stalls; B takes generation 2
  const b1 = await claim("k1", 2);
  assertEquals([b1.decision, b1.holder_generation], ["uncertain", 1], "no run id yet: B must not buy (D2: defer, then hold)");
  assert(await attach("k1", "run-A"));                                   // A's start POST returned
  const b2 = await claim("k1", 2);
  assertEquals([b2.decision, b2.provider_run_id], ["adopt", "run-A"], "B re-reads A's run by id");
});

Deno.test("purchase claims: a failure BEFORE any run existed frees the key; a settled call is never bought again", async () => {
  const { claim, settle, attach } = await open();
  assertEquals((await claim("k1", 1)).decision, "buy");
  assert(await settle("k1", "failed_before_start"));                     // a 4xx refusal: nothing ran
  assertEquals((await claim("k1", 1)).decision, "buy", "taken over: buying again is correct, nothing was bought");
  assertEquals((await claim("k2", 1)).decision, "buy");
  assert(await settle("k2", "settled"));                                 // a synchronous call, no run id
  assertEquals((await claim("k2", 1)).decision, "settled");
  // A run id, once recorded, is never discarded by a later "failed before start".
  assertEquals((await claim("k3", 1)).decision, "buy");
  assert(await attach("k3", "run-3"));
  assert(await settle("k3", "failed_before_start"));
  assertEquals((await claim("k3", 1)).decision, "adopt");
});

Deno.test("purchase claims: the holder's own retry is told it holds the key; a second run id never replaces the first", async () => {
  const { claim, attach } = await open();
  assertEquals((await claim("k1", 1)).decision, "buy");
  assertEquals((await claim("k1", 1)).decision, "held_by_self");
  assert(await attach("k1", "run-A"));
  assertEquals(await attach("k1", "run-B"), false, "the first run id stands");
  assertEquals((await claim("k1", 1)).provider_run_id, "run-A");
});

Deno.test("purchase claims: inputs are validated; anon and authenticated can neither read the table nor call the functions", async () => {
  const { db, claim } = await open();
  await assertRejects(() => claim("", 1));
  await assertRejects(() => db.query(`select * from public.claim_provider_purchase($1, $2, $3, null)`, [WS, "k", TASK]));
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assertRejects(() => db.query(`select * from public.provider_purchase_claims`), Error, "permission denied");
    await assertRejects(() => db.query(`select * from public.claim_provider_purchase($1, 'k', $2, 1)`, [WS, TASK]), Error, "permission denied");
    await db.exec(`reset role`);
  }
});

Deno.test("purchase claims: the rollback removes every object, and the migration re-applies cleanly", async () => {
  const { db } = await open();
  await db.exec(DOWN);
  const left = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_proc where proname in ('claim_provider_purchase','attach_purchase_run','settle_provider_purchase')`);
  assertEquals(left.rows[0].n, 0);
  assertEquals((await db.query(`select to_regclass('public.provider_purchase_claims') as t`)).rows[0], { t: null });
  await db.exec(UP);
});

Deno.test("purchase claims: PROPOSED only — not in the synced migrations, and nothing in the runtime calls it yet", () => {
  for (const e of Deno.readDirSync(new URL("supabase/migrations/", ROOT))) assert(!e.name.includes("provider_purchase_claims"), e.name);
  const runtime = ["supabase/functions/_shared/claimVerifier.ts", "supabase/functions/_shared/leadCapabilityEngine.ts",
    "supabase/functions/run-agent/index.ts", "worker/main.ts"].map(read).join("\n");
  assert(!runtime.includes("claim_provider_purchase"), "wiring it is a separate, approved change");
});
