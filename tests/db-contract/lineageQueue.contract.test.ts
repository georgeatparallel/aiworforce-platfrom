// Lineage leases, continuation claims and the V2 queue against real PostgREST:
// the production wrappers (lineageLease.ts, continuationClaim.ts,
// leadMissionTerminal.ts) and the worker's own query text, read from
// worker/main.ts so a change there is tested here.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acquireLineageLease, readLineageLease, releaseLineageLease,
} from "../../supabase/functions/_shared/lineageLease.ts";
import {
  claimContinuationViaRpc, releaseContinuationViaRpc,
} from "../../supabase/functions/_shared/continuationClaim.ts";
import { releaseQueuedMission } from "../../supabase/functions/_shared/leadMissionTerminal.ts";
import { mapTaskOutcome } from "../../supabase/functions/_shared/leadMissionV2Request.ts";
import { seedLineage, seedTask, seedWorkspace, serviceClient, sql, uuid } from "./lib/harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const WORKER = await Deno.readTextFile(new URL("../../worker/main.ts", import.meta.url));

/** The worker's lineage read, verbatim from worker/main.ts. */
const WORKER_LINEAGE_SELECT = (() => {
  const m = /from\("lead_lineages"\)\s*\.select\("(status, terminal_reason, r_terminal_status:[^"]+)"\)/.exec(WORKER);
  if (!m) throw new Error("worker/main.ts no longer reads the lineage outcome the way this test expects");
  return m[1];
})();

Deno.test("lineage lease: acquire, a second holder refused, release with the state, then terminal", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const lineage = await seedLineage(ws, { current_state: { round: 1 } });
  const holder = await seedTask(ws, { lineage_id: lineage });
  // One LIVE task per lineage (tasks_one_live_generation_per_lineage): the rival waits.
  const rival = await seedTask(ws, { lineage_id: lineage, status: "ready" });

  const got = await acquireLineageLease({ db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: holder });
  assert(got.acquired, JSON.stringify(got));
  const refused = await acquireLineageLease({ db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: rival });
  assertEquals(refused.acquired, false);
  assertEquals((refused as { reason: string }).reason, "already_leased");
  assertEquals((await readLineageLease(db as never, lineage)).leased, true);

  // A release by the non-holder is refused; the holder's release lands its state.
  const notHolder = await releaseLineageLease({ db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: rival, expectedVersion: got.acquired ? got.stateVersion : 0 });
  assertEquals(notHolder.released, false);
  const rel = await releaseLineageLease({
    db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: holder,
    expectedVersion: got.acquired ? got.stateVersion : 0,
    nextState: { round: 2, terminal_status: "search_exhausted" }, terminalReason: "search_exhausted", madeProgress: true,
  });
  assert(rel.released, JSON.stringify(rel));
  const [row] = await sql`select status, terminal_reason, current_state, lease_holder from public.lead_lineages where lineage_id = ${lineage}`;
  assertEquals(row.status, "terminal");
  assertEquals(row.terminal_reason, "search_exhausted");
  assertEquals((row.current_state as { round: number }).round, 2);
  assertEquals(row.lease_holder, null);

  // A terminal lineage grants no further lease.
  const after = await acquireLineageLease({ db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: rival });
  assertEquals((after as { reason?: string }).reason, "already_terminal");
});

Deno.test("lineage lease: a stale holder's release after a newer version is a version conflict", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const lineage = await seedLineage(ws, { current_state: {} });
  const holder = await seedTask(ws, { lineage_id: lineage });
  const got = await acquireLineageLease({ db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: holder });
  assert(got.acquired);
  await sql`update public.lead_lineages set state_version = state_version + 1 where lineage_id = ${lineage}`;
  const rel = await releaseLineageLease({ db: db as never, lineageId: lineage, workspaceId: ws, holderTaskId: holder, expectedVersion: got.stateVersion, nextState: { stale: true } });
  assertEquals(rel, { released: false, reason: "version_conflict", stateVersion: got.stateVersion + 1 });
});

Deno.test("D4: the worker's lineage read (verbatim) projects the terminal verdict mapTaskOutcome trusts", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const lineage = await seedLineage(ws, { status: "terminal", terminal_reason: "search_exhausted", current_state: { terminal_status: "search_exhausted", big: "x".repeat(1000) } });
  const { data, error } = await db.from("lead_lineages").select(WORKER_LINEAGE_SELECT).eq("lineage_id", lineage).maybeSingle();
  assertEquals(error, null);
  assertEquals(data as unknown, { status: "terminal", terminal_reason: "search_exhausted", r_terminal_status: "search_exhausted" });
  // A task row left at continuation_required (its last write lost) defers to the lineage.
  const l = data as unknown as { status: string; terminal_reason: string; r_terminal_status: string };
  const outcome = mapTaskOutcome(
    { status: "ready", terminal_status: "continuation_required" },
    { status: l.status, terminal_reason: l.terminal_reason, terminal_status: l.r_terminal_status },
  );
  assertEquals(outcome, { status: "search_exhausted", terminal: true });
});

Deno.test("continuation claim: refused on a cancelled or terminal lineage; released through the production wrapper", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const checkpoint = { terminal_status: "continuation_required", company_first_state: { round: 1 } };
  for (const [status, reason] of [["cancelled", "lineage_cancelled"], ["terminal", "already_terminal"]] as const) {
    const lineage = await seedLineage(ws, { status, terminal_reason: status });
    const task = await seedTask(ws, { status: "ready", lineage_id: lineage, result: checkpoint });
    const r = await claimContinuationViaRpc({ db: db as never, taskId: task, workspaceId: ws, claimId: uuid() });
    assert(r.available && !r.claimed, JSON.stringify(r));
    assertEquals((r as { reason: string }).reason, reason);
  }
  const lineage = await seedLineage(ws);
  const task = await seedTask(ws, { status: "ready", lineage_id: lineage, result: checkpoint });
  const claimId = uuid();
  const r = await claimContinuationViaRpc({ db: db as never, taskId: task, workspaceId: ws, claimId });
  assert(r.available && r.claimed, JSON.stringify(r));
  const again = await claimContinuationViaRpc({ db: db as never, taskId: task, workspaceId: ws, claimId: uuid() });
  assertEquals((again as { reason?: string }).reason, "already_claimed");
  const rel = await releaseContinuationViaRpc({ db: db as never, taskId: task, workspaceId: ws, claimId, rowStatus: "ready" });
  assertEquals(rel.available && rel.released, true, JSON.stringify(rel));
  const [row] = await sql`select continuation_claim_id from public.tasks where id = ${task}`;
  assertEquals(row.continuation_claim_id, null);
});

/** Only this test's rows are claimable: park everything else the lane created. */
async function isolateQueue(keep: string[]) {
  await sql`update public.lead_mission_queue set status = 'complete' where status in ('queued','resumable') and not (id = any(${keep}))`;
}

Deno.test("queue lease: claim, heartbeat, bind, a stranger's heartbeat refused, expiry reclaim, release refunds a clean continuation", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const queueId = uuid();
  await sql`insert into public.lead_mission_queue (id, workspace_id, request, status) values (${queueId}, ${ws}, ${sql.json({ plan_id: null })}, 'queued')`;
  await isolateQueue([queueId]);
  const w1 = uuid(), w2 = uuid();

  // The worker's argument names, exactly as worker/main.ts sends them.
  assert(WORKER.includes(`db.rpc("claim_next_lead_mission", { p_worker_id: wid, p_lease_seconds: lease })`), "worker claim call changed");
  const { data: c1, error: e1 } = await db.rpc("claim_next_lead_mission", { p_worker_id: w1, p_lease_seconds: 60 });
  assertEquals(e1, null);
  const row = (Array.isArray(c1) ? c1[0] : c1) as Record<string, unknown>;
  assertEquals(row.claimed, true);
  assertEquals(row.queue_id, queueId);
  assertEquals(row.attempts, 1);

  const { data: hb } = await db.rpc("heartbeat_lead_mission", { p_queue_id: queueId, p_worker_id: w1, p_lease_seconds: 60 });
  assertEquals((hb as Array<{ ok: boolean }>)[0].ok, true);
  const { data: hb2 } = await db.rpc("heartbeat_lead_mission", { p_queue_id: queueId, p_worker_id: w2, p_lease_seconds: 60 });
  assertEquals((hb2 as Array<{ ok: boolean }>)[0].ok, false, "a worker that does not hold the lease cannot renew it");

  const lineage = await seedLineage(ws);
  const task = await seedTask(ws, { lineage_id: lineage });
  const { data: bound } = await db.rpc("bind_lead_mission_execution", { p_queue_id: queueId, p_worker_id: w1, p_task_id: task, p_lineage_id: lineage });
  assertEquals((bound as Array<{ bound: boolean }>)[0].bound, true);

  // The lease expires (a stalled worker): another worker reclaims the mission.
  await sql`update public.lead_mission_queue set lease_expires_at = now() - interval '1 second' where id = ${queueId}`;
  const { data: c2 } = await db.rpc("claim_next_lead_mission", { p_worker_id: w2, p_lease_seconds: 60 });
  const row2 = (c2 as Array<Record<string, unknown>>)[0];
  assertEquals(row2.claimed, true);
  assertEquals(row2.task_id, task, "the reclaim resumes the bound task, not a fresh one");

  // The stalled worker's release is refused: it no longer holds the row.
  const stale = await releaseQueuedMission((fn, a) => db.rpc(fn, a), {
    queueId, workerId: w1, attempts: 1, outcome: { status: "continuation_required", terminal: false, lineageSlices: 1, continuationDecision: null }, outcomeDoc: {},
  });
  assertEquals(stale.released, false);

  // The holder's clean continuation is released resumable without spending a retry.
  const ok = await releaseQueuedMission((fn, a) => db.rpc(fn, a), {
    queueId, workerId: w2, attempts: Number(row2.attempts), outcome: { status: "continuation_required", terminal: false, lineageSlices: 1, continuationDecision: null }, outcomeDoc: {},
  });
  assert(ok.released, JSON.stringify(ok));
  assertEquals(ok.fallback, false, "the held 5-argument release_lead_mission is the one called");
  const [q] = await sql`select status, attempts, continuations from public.lead_mission_queue where id = ${queueId}`;
  assertEquals(q.status, "resumable");
  assertEquals(q.continuations, 1);
  assertEquals(q.attempts, Number(row2.attempts) - 1, "a clean continuation refunds its claim");
});

Deno.test("queue: a terminal release completes the mission and it is never claimed again", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const queueId = uuid();
  await sql`insert into public.lead_mission_queue (id, workspace_id, request, status) values (${queueId}, ${ws}, ${sql.json({})}, 'queued')`;
  await isolateQueue([queueId]);
  const w = uuid();
  const { data } = await db.rpc("claim_next_lead_mission", { p_worker_id: w, p_lease_seconds: 60 });
  assertEquals((data as Array<{ claimed: boolean }>)[0].claimed, true);
  const r = await releaseQueuedMission((fn, a) => db.rpc(fn, a), {
    queueId, workerId: w, attempts: 1, outcome: { status: "complete", terminal: true }, outcomeDoc: { status: "complete" },
  });
  assert(r.released);
  assertEquals(r.finalStatus, "complete");
  const { data: again } = await db.rpc("claim_next_lead_mission", { p_worker_id: uuid(), p_lease_seconds: 60 });
  const row = (again as Array<{ claimed: boolean; queue_id: string | null }>)[0];
  assert(!row.claimed || row.queue_id !== queueId, "a completed mission is not claimable");
});
