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
    // 2. the lineage lease
    "await acquireLineageLease(",
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
    // 5. the fold and the decision
    "const progress = foldSlice(priorProgress",
    // 6. the end-of-slice write
    'guardResult("slice_result"',
    // 7. the claim release, retried, the row status from the slice's own verdict
    "releaseContinuationViaRpc({",
    "rowStatus: statuses.rowStatus",
    // 8. the lineage release, terminal only when nothing is left to resume
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
  assert(src.includes('select("continuations")'), `${main}: the continuations read at claim is gone`);
  assertInOrder(src, main, ["readTaskOutcome: async (taskId) =>", 'from("tasks").select(TASK_OUTCOME_COLUMNS)']);
  assertInOrder(src, main, ["if (isTerminalQueueStatus(finalStatus)) {", "await reconcileTerminal(finalStatus, reason, {"]);
  // The runner the lab runs is the production one, and it takes the outcome
  // from the row, not from the HTTP response (why D4 exists).
  const runner = "worker/leadMissionRunner.ts";
  assertInOrder(read(runner), runner, ["res = await d.handler(", "const row = await d.readTaskOutcome(taskId);", "mapTaskOutcome(row)"]);
});

Deno.test("[failure] source order: a terminal lineage is never claimed again (the queue SQL the lab runs)", () => {
  // The latest definition the lab's migrations install.
  const sql = read("supabase/migrations-held/20261003120000_lead_mission_v2_continuations_not_retries.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.claim_next_lead_mission("));
  assert(fn.length < sql.length, "claim_next_lead_mission is no longer redefined here");
  assert(fn.slice(0, fn.indexOf("$function$;")).includes("l.status in ('cancelled', 'terminal')"));
});
