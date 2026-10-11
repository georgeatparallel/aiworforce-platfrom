// A PRODUCTIVE CONTINUATION IS NOT A RETRY — AND DOES NOT WAIT LIKE ONE.
//
// Query B rerun (task 255c333f, 2026-10-10): 9 slices, 48.2 minutes, of which
// 1,054 s (36%) was the queue holding a slice that had just finished cleanly
// and asked to continue: `release_lead_mission` set `not_before = now() + 2
// minutes` on EVERY resumable release. That backoff is right for a retry and
// for a run that is only waiting on a provider; it is pure idle for a slice
// that ran and has work ready now.
//
// The held migration 20261011120000 lifts it for one case only: the lineage's
// own slice counter moved (the same test that refunds the claim) AND the worker
// states the run's own continuation decision was `immediate`. Everything else —
// a retry, a no-op, a run waiting on a provider, an old worker, an old database
// — keeps the 2 minutes. Real SQL in PGlite; the worker side is production code.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  type ClaimedMission, type MissionOutcome, type WorkerDeps, workerTick,
} from "../../supabase/functions/_shared/leadMissionWorkerCore.ts";
import {
  continuationDispatch, type QueueRpc, releaseQueuedMission, V2_MAX_ATTEMPTS,
} from "../../supabase/functions/_shared/leadMissionTerminal.ts";
import {
  decideAutoContinuation, IMMEDIATE_CONTINUATION_REASONS,
} from "../../supabase/functions/_shared/leadAutoContinuation.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const QUEUE_SQL = read("supabase/migrations-held/20260910140000_lead_mission_v2_claim.sql");
const CONT_SQL = read("supabase/migrations-held/20261003120000_lead_mission_v2_continuations_not_retries.sql");
const NAME = "20261011120000_lead_mission_v2_productive_continuation_no_backoff";
const FIX_SQL = read(`supabase/migrations-held/${NAME}.sql`);
const DOWN_SQL = read(`supabase/migrations-held/rollback/${NAME}.down.sql`);

const PRELUDE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create table public.workspaces (id uuid primary key);
  create table public.lead_lineages (
    lineage_id uuid primary key, workspace_id uuid not null, status text not null default 'active',
    lease_holder uuid, lease_expires_at timestamptz, updated_at timestamptz default now()
  );
  create table public.tasks (
    id uuid primary key, status text, updated_at timestamptz default now(),
    continuation_claim_id uuid, continuation_claim_expires_at timestamptz
  );
`;
const WS = "e8af257d-4c42-4fc2-9d62-037cdfac27c4";
const TASK = "255c333f-0000-4000-8000-000000000000";

async function database(o: { fixed: boolean }): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(PRELUDE);
  await db.exec(QUEUE_SQL);
  await db.exec(CONT_SQL);
  if (o.fixed) await db.exec(FIX_SQL);
  await db.query(`insert into public.workspaces (id) values ($1)`, [WS]);
  return db;
}

function rpcOf(db: PGlite): QueueRpc {
  return async (fn, args) => {
    const keys = Object.keys(args);
    const vals = keys.map((k) => { const v = args[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
    const call = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    try {
      const r = await db.query(`select * from public.${fn}(${call})`, vals);
      return { data: r.rows, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "42883") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  };
}

async function enqueue(db: PGlite): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.lead_mission_queue (workspace_id, request) values ($1, '{}') returning id`, [WS]);
  return r.rows[0].id;
}

interface Row { status: string; attempts: number; continuations: number; held: boolean; hold_s: number | null }
async function row(db: PGlite, id: string): Promise<Row> {
  return (await db.query<Row>(`
    select status, attempts, continuations,
           coalesce(not_before, '-infinity'::timestamptz) > now() as held,
           extract(epoch from (not_before - now()))::int as hold_s
      from public.lead_mission_queue where id = $1`, [id])).rows[0];
}

/** The production worker core and release; `oldWorker` sends no dispatch, as today's worker. */
function worker(db: PGlite, handler: (m: ClaimedMission) => Promise<MissionOutcome>, o: { oldWorker?: boolean } = {}) {
  const rpc = rpcOf(db);
  const workerId = crypto.randomUUID();
  const deps: WorkerDeps = {
    workerId,
    config: { leaseSeconds: 180, heartbeatIntervalMs: 60_000, missionCeilingMs: 300_000, idlePollMs: 1, cancelSweepIntervalMs: 60_000 },
    claim: async (wid, lease) => {
      const { data, error } = await rpc("claim_next_lead_mission", { p_worker_id: wid, p_lease_seconds: lease });
      const r = (data as Array<Record<string, unknown>> | null)?.[0];
      if (error || !r || r.claimed !== true) return { claimed: false, reason: String(r?.reason ?? "error") };
      return { claimed: true, mission: {
        queueId: String(r.queue_id), workspaceId: String(r.workspace_id), request: {},
        taskId: (r.task_id as string | null) ?? null, lineageId: null,
        attempts: Number(r.attempts), isResume: !!r.task_id, heldUntil: null,
      } };
    },
    heartbeatFor: () => ({ start() {}, stop() {} }),
    runMission: (m) => handler(m),
    release: async (m, outcome) => {
      const facts = o.oldWorker ? { ...outcome, continuationDecision: undefined } : outcome;
      await releaseQueuedMission(rpc, {
        queueId: m.queueId, workerId, attempts: m.attempts, outcome: facts, outcomeDoc: { status: outcome.status },
      });
    },
    sleep: async () => {},
  };
  return { tick: () => workerTick(deps) };
}

/** A slice that ran (the lineage counter moved) and continues for `decision`. */
function slices(decision: string) {
  let n = 0;
  return async (m: ClaimedMission): Promise<MissionOutcome> => ({
    status: "continuation_required", terminal: false, taskId: m.taskId ?? TASK,
    lineageSlices: ++n, continuationDecision: decision,
  });
}

// ═══ THE FOUR CASES THE QUEUE MUST GET RIGHT ════════════════════════════════

Deno.test("PRODUCTIVE CONTINUATION: a new slice whose decision is immediate is claimable at once — no 2-minute hold", async () => {
  for (const decision of ["quota_unmet_frontier_remains", "replenishment_required", "verification_required"]) {
    const db = await database({ fixed: true });
    const id = await enqueue(db);
    const w = worker(db, slices(decision));
    assert((await w.tick()).claimed);
    const r = await row(db, id);
    assertEquals([r.status, r.held, r.attempts, r.continuations], ["resumable", false, 0, 1], decision);
    assert((await w.tick()).claimed, `${decision}: the next slice is claimed with no time travel`);
    await db.close();
  }
});

Deno.test("TRANSIENT FAILURE RETRY: a faulted run keeps its attempt AND its 2-minute backoff", async () => {
  const db = await database({ fixed: true });
  const id = await enqueue(db);
  const w = worker(db, async () => { throw new Error("provider transport failure"); });
  assert((await w.tick()).claimed);
  const r = await row(db, id);
  assertEquals([r.status, r.held, r.attempts], ["resumable", true, 1]);
  assert(r.hold_s! >= 110 && r.hold_s! <= 120, `held ~2 minutes, got ${r.hold_s}s`);
  assertFalse((await w.tick()).claimed, "not reclaimed inside the backoff");
  await db.close();
});

Deno.test("NO-OP RUN: a 409 that folded no slice keeps the backoff, even if it claims to be immediate", async () => {
  const db = await database({ fixed: true });
  const id = await enqueue(db);
  // First a real slice (1), then a run that re-reads the same counter.
  let calls = 0;
  const w = worker(db, async (m) => ({ status: "continuation_required", terminal: false, taskId: m.taskId ?? TASK,
    lineageSlices: 1, continuationDecision: calls++ === 0 ? "quota_unmet_frontier_remains" : "quota_unmet_frontier_remains" }));
  assert((await w.tick()).claimed);
  assertFalse((await row(db, id)).held, "the first, real slice is not held");
  assert((await w.tick()).claimed);
  const r = await row(db, id);
  assertEquals([r.held, r.attempts, r.continuations], [true, 1, 1], "no slice moved: a retry, held and not refunded");
  await db.close();
});

Deno.test("WAITING ON A PROVIDER: awaiting_provider_run is a clean slice but keeps the 2-minute cadence (no spin)", async () => {
  const db = await database({ fixed: true });
  const id = await enqueue(db);
  const w = worker(db, slices("awaiting_provider_run"));
  assert((await w.tick()).claimed);
  const r = await row(db, id);
  assertEquals([r.status, r.held, r.attempts, r.continuations], ["resumable", true, 0, 1], "refunded, but held");
  assertFalse((await w.tick()).claimed);
  await db.close();
});

Deno.test("STALE / FAILED RECOVERY unchanged: a dead worker's lease is reclaimed; a failed release is never requeued", async () => {
  const db = await database({ fixed: true });
  const id = await enqueue(db);
  const rpc = rpcOf(db);
  const claim = async () => ((await rpc("claim_next_lead_mission", { p_worker_id: crypto.randomUUID(), p_lease_seconds: 60 })).data as Array<{ claimed: boolean }>)[0].claimed;
  assert(await claim());
  await db.exec(`update public.lead_mission_queue set lease_expires_at = now() - interval '1 second' where status = 'running'`);
  assert(await claim(), "a lapsed lease is reclaimable, as before");
  assertEquals((await row(db, id)).attempts, 2, "the dead worker's attempt stands");

  const db2 = await database({ fixed: true });
  const id2 = await enqueue(db2);
  const w = worker(db2, async () => { throw new Error("fault"); });
  for (let i = 0; i < V2_MAX_ATTEMPTS; i++) {
    assert((await w.tick()).claimed);
    await db2.exec(`update public.lead_mission_queue set not_before = null`);
  }
  const r = await row(db2, id2);
  assertEquals([r.status, r.held, r.hold_s], ["failed", false, null]);
  assertFalse((await w.tick()).claimed, "failed is terminal");
  await db.close(); await db2.close();
});

Deno.test("NORMAL COMPLETION: a terminal run completes and is never requeued", async () => {
  const db = await database({ fixed: true });
  const id = await enqueue(db);
  const w = worker(db, async (m) => ({ status: "search_exhausted", terminal: true, taskId: m.taskId ?? TASK, lineageSlices: 9,
    continuationDecision: "frontier_exhausted" }));
  assert((await w.tick()).claimed);
  const r = await row(db, id);
  assertEquals([r.status, r.held, r.hold_s], ["complete", false, null]);
  assertFalse((await w.tick()).claimed);
  await db.close();
});

// ═══ DEPLOY ORDER IS FREE ═══════════════════════════════════════════════════

Deno.test("OLD WORKER, NEW DATABASE: no dispatch stated → the 2-minute backoff, exactly as today", async () => {
  const db = await database({ fixed: true });
  const id = await enqueue(db);
  const w = worker(db, slices("quota_unmet_frontier_remains"), { oldWorker: true });
  assert((await w.tick()).claimed);
  assertEquals([(await row(db, id)).held, (await row(db, id)).attempts], [true, 0], "refunded, held");
  await db.close();
});

Deno.test("NEW WORKER, OLD DATABASE (this migration held): the dispatch field is ignored → the 2-minute backoff", async () => {
  const db = await database({ fixed: false });
  const id = await enqueue(db);
  const w = worker(db, slices("quota_unmet_frontier_remains"));
  assert((await w.tick()).claimed);
  const r = await row(db, id);
  assertEquals([r.status, r.held, r.attempts, r.continuations], ["resumable", true, 0, 1]);
  await db.close();
});

// ═══ THE DISPATCH THE WORKER STATES ═════════════════════════════════════════

Deno.test("the worker states `immediate` only for a clean continuation whose decision is immediate", () => {
  const clean = { status: "continuation_required", terminal: false, lineageSlices: 3 };
  assertEquals(continuationDispatch({ ...clean, continuationDecision: "quota_unmet_frontier_remains" }), "immediate");
  assertEquals(continuationDispatch({ ...clean, continuationDecision: "awaiting_provider_run" }), "deferred");
  assertEquals(continuationDispatch({ ...clean, continuationDecision: null }), "deferred", "unknown decision: conservative");
  assertEquals(continuationDispatch({ ...clean, continuationDecision: "something_new" }), "deferred");
  assertEquals(continuationDispatch({ ...clean, continuationDecision: "replenishment_required", error: "boom" }), null);
  assertEquals(continuationDispatch({ ...clean, continuationDecision: "replenishment_required", aborted: true }), null);
  assertEquals(continuationDispatch({ ...clean, lineageSlices: null, continuationDecision: "replenishment_required" }), null);
  assertEquals(continuationDispatch({ status: "search_exhausted", terminal: true, lineageSlices: 3, continuationDecision: "frontier_exhausted" }), null);
});

Deno.test("IMMEDIATE_CONTINUATION_REASONS cannot drift from decideAutoContinuation's own dispatch_mode", () => {
  const base = {
    cancelled: false, qualified: 0, requestedCount: 3, continuationsUsed: 1, maxContinuations: 10,
    costUnitsUsed: 1, maxCostUnits: 120, barrenSlices: 0, providerFailed: false,
  };
  const cases = [
    { ...base, frontierRemaining: 5, pendingRuns: 0, discoveryRoutesRemain: true },
    { ...base, frontierRemaining: 0, pendingRuns: 2, discoveryRoutesRemain: true },
    { ...base, frontierRemaining: 0, pendingRuns: 0, discoveryRoutesRemain: true },
    { ...base, frontierRemaining: 0, pendingRuns: 0, discoveryRoutesRemain: true, verificationRoutesRemain: 2 },
  ];
  const seen = new Set<string>();
  for (const c of cases) {
    const d = decideAutoContinuation(c as never);
    assert(d.continue, JSON.stringify(c));
    seen.add(String(d.reason));
    assertEquals(IMMEDIATE_CONTINUATION_REASONS.has(String(d.reason)), d.dispatch_mode === "immediate", String(d.reason));
  }
  assertEquals([...seen].sort(),
    ["awaiting_provider_run", "quota_unmet_frontier_remains", "replenishment_required", "verification_required"]);
});

// ═══ THE MIGRATION ITSELF ═══════════════════════════════════════════════════

async function definitions(db: PGlite) {
  return (await db.query<{ proname: string; args: string; def: string }>(`
    select p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('claim_next_lead_mission', 'release_lead_mission')
     order by 1, 2`)).rows;
}

Deno.test("THE MIGRATION is idempotent, keeps one release signature, and its rollback restores 20261003 exactly", async () => {
  const before = await database({ fixed: false });
  const db = await database({ fixed: true });
  await db.exec(FIX_SQL);
  const fixed = await definitions(db);
  assertEquals(fixed.map((d) => `${d.proname}(${d.args})`), [
    "claim_next_lead_mission(p_worker_id uuid, p_lease_seconds integer)",
    "release_lead_mission(p_queue_id uuid, p_worker_id uuid, p_status text, p_outcome jsonb, p_lineage_slices integer)",
  ], "no signature change — PostgREST and the worker's fallbacks see exactly what they see today");
  assertEquals(fixed[0].def, (await definitions(before))[0].def, "claim is untouched");
  await db.exec(DOWN_SQL);
  assertEquals(await definitions(db), await definitions(before), "rolled back byte-for-byte");
  await db.exec(FIX_SQL);
  await db.close(); await before.close();
});

Deno.test("THE MIGRATION changes only the hold, and stays service-role only", async () => {
  // Every line of the release body but the not_before assignment is 20261003's.
  const body = (sql: string) => sql.slice(sql.search(/create\s+or\s+replace\s+function\s+public\.release_lead_mission\(/i));
  const strip = (s: string) => s.slice(0, s.indexOf("$function$;"))
    .replace(/not_before\s*=\s*case[\s\S]*?\bend,/, "not_before = <hold>,")
    .split("\n").filter((l) => !/v_immediate|^\s*--/.test(l)).map((l) => l.trim()).filter(Boolean).join("\n");
  assertEquals(strip(body(FIX_SQL)), strip(body(CONT_SQL)));
  const db = await database({ fixed: true });
  const g = (await db.query<{ anon: boolean; authed: boolean; svc: boolean }>(`
    select has_function_privilege('anon', p.oid, 'execute') anon,
           has_function_privilege('authenticated', p.oid, 'execute') authed,
           has_function_privilege('service_role', p.oid, 'execute') svc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'release_lead_mission'`)).rows;
  assertEquals(g, [{ anon: false, authed: false, svc: true }]);
  await db.close();
});

Deno.test("THE MIGRATION is HELD: it lives in migrations-held, never in the production-synced directory", () => {
  assert(Deno.statSync(new URL(`supabase/migrations-held/${NAME}.sql`, ROOT)).isFile);
  assertFalse([...Deno.readDirSync(new URL("supabase/migrations/", ROOT))].some((e) => e.name.includes("productive_continuation")));
  assert(read("supabase/migrations-held/README.md").includes(NAME), "documented in the held README");
});
