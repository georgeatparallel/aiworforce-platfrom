// THE CHAOS LAB'S ONE MIRROR, PINNED TO PRODUCTION.
//
// `ChaosLab.handle` (lib/chaos.ts) writes out run-agent's V2 slice sequence
// because run-agent cannot be imported without its network and database. Every
// step calls the production function; this file pins the ORDER and the guards
// it copies to run-agent's and the worker's source, so a reorder in production
// turns this red before the failure-injection results silently stop meaning
// anything. Update the lab and this pin together.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(`../../../${rel}`, import.meta.url));

/** Each marker must occur, and after the one before it. */
function assertInOrder(src: string, file: string, markers: string[]) {
  let from = 0;
  for (const m of markers) {
    const at = src.indexOf(m, from);
    assert(at >= 0, `${file}: "${m}" is missing, or no longer after the step before it`);
    from = at + m.length;
  }
}

Deno.test("[failure] source order: run-agent's V2 slice runs claim → lease → ledger recovery → engine (stage writes) → fold → end write → claim release → lineage release, as the chaos lab mirrors", () => {
  const file = "supabase/functions/run-agent/index.ts";
  assertInOrder(read(file), file, [
    // 1. a resumed slice takes the continuation claim; refused → 409
    "await claimContinuationViaRpc(",
    // 2. the lineage lease, then this slice's generation — the token every
    // result write is fenced on in SQL (D1, `fencedTaskUpdate`)
    "await acquireLineageLease(",
    "const sliceFence: SliceFence = {",
    // 3. the ledger recovers what a lost checkpoint forgot
    "recoverCompletedRuns(completedRunRows)",
    "recoverPendingRuns(startedRunRows",
    // replenishment debt only after a `replenishment_required` decision
    'priorContinuationDecision === "replenishment_required"',
    // 4. the engine, writing a checkpoint at stage boundaries …
    "await runCapabilityPlan(",
    "onCheckpoint: async (snap)",
    'reason: "nothing_bought_yet"',
    // … never over a finalized verdict
    'priorTerminal && priorTerminal !== "continuation_required"',
    'guardResult("stage_boundary"',
    // … resumed from the checkpoint merged with the ledger's pending runs
    "mergePendingRuns(",
    // 5. the fold and the decision — a pending run holds the lineage only
    // within its bound (D3), exactly as the lab's `foldAndDecide` counts it
    "const progress = foldSlice(priorProgress",
    "pendingRuns: awaitedPendingRuns(capabilityRun?.state.pending_runs, Date.now()).awaited +",
    // 6. the end-of-slice write
    'guardResult("slice_result"',
    // 7. the claim release, retried, the row status from the slice's own verdict
    "releaseContinuationViaRpc({",
    "rowStatus: statuses.rowStatus",
    // 8. the lineage release, terminal only when nothing is left to resume,
    // carrying the slice's verdict in the same call (D4: the worker reads it)
    "mergeLineageState(leaseState, {",
    "terminal_status: statuses.terminalStatus,",
    "releaseLineageLease({",
    "lineageIsFinished(autoDecision)",
    'r.reason === "release_unavailable"',
  ]);
});

Deno.test("[failure] source order: both releases retry exactly as the lab does (3 attempts)", () => {
  const src = read("supabase/functions/run-agent/index.ts");
  const retries = src.match(/\{ attempts: 3, delaysMs: \[1_000, 3_000\] \}/g) ?? [];
  assert(retries.length >= 2, `expected the claim and lineage releases to retry 3×, found ${retries.length}`);
});

Deno.test("[failure] source order: the worker reads the queue's continuations at claim, reads the outcome from the task ROW, and reconciles only a terminal release", () => {
  const main = "worker/main.ts";
  const src = read(main);
  assert(src.includes('select("continuations,created_at")'), `${main}: the continuations read at claim is gone`);
  assertInOrder(src, main, ["readTaskOutcome: async (taskId) =>", 'from("tasks").select(TASK_OUTCOME_COLUMNS)']);
  // D4: the lineage's status and verdict, as the lab's `readLineageOutcome` reads them.
  assertInOrder(src, main, ["readLineageOutcome: async (lineageId) =>", 'from("lead_lineages")',
    "status, terminal_reason, r_terminal_status:current_state->>terminal_status"]);
  assertInOrder(src, main, ["if (isTerminalQueueStatus(finalStatus)) {", "await reconcileTerminal(finalStatus, reason, {"]);
  // The runner the lab runs is the production one: the outcome comes from the
  // task row, and from the lineage row when the task row says it did not end (D4).
  const runner = "worker/leadMissionRunner.ts";
  assertInOrder(read(runner), runner, [
    "res = await call(() => d.handler(", "const row = await d.readTaskOutcome(taskId);", "d.readLineageOutcome(lineageId ?? taskId)",
    "mapTaskOutcome(row, lineage)",
  ]);
});

Deno.test("[failure] source order: a terminal lineage is never claimed again (the queue SQL the lab runs)", () => {
  // The latest definition the lab's migrations install.
  const sql = read("supabase/migrations-held/20261003120000_lead_mission_v2_continuations_not_retries.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.claim_next_lead_mission("));
  assert(fn.length < sql.length, "claim_next_lead_mission is no longer redefined here");
  assert(fn.slice(0, fn.indexOf("$function$;")).includes("l.status in ('cancelled', 'terminal')"));
});

Deno.test("[failure] source order: a SUPERSEDED slice (its verdict fenced) releases no lineage, dispatches nothing, finalizes no plan, writes no panel, and its terminal guard stands down — as the lab mirrors", () => {
  const file = "supabase/functions/run-agent/index.ts";
  const src = read(file);
  assertInOrder(src, file, [
    'guardResult("slice_result"',
    "const sliceSuperseded = sliceResultWrite.fenced;",
    'terminalGuard.disarm("fenced_stale_generation");',
    "if (holdsLease && leaseVersion !== null && !sliceSuperseded) {",
    "releaseLineageLease({",
    "!queueOwnsContinuation && !sliceSuperseded) {",
    "dispatchContinuation({",
    "if (!sliceSuperseded) {",
    "await finalizeCompanyFirstPlan(",
    "if (!sliceSuperseded) await persistLeadResultsPanel(",
  ]);
  // The guard's own write is fenced on the slice's generation once it is known.
  assertInOrder(src, file, [
    "let guardFence: SliceFence | null = null;",
    "writeTask: async (id, patch) => {",
    "fencedTaskUpdate(supabase as unknown as FencedTaskDb, id, guardFence, { requireOpen: false }",
    "const sliceFence: SliceFence = {",
    "guardFence = sliceFence;",
  ]);
  const lab = read("tests/replay/lib/chaos.ts");
  assertInOrder(lab, "tests/replay/lib/chaos.ts", ["superseded = w.fenced;", "if (superseded) {", '"lineage_release_skipped"', "releaseLineageLease({"]);
});
