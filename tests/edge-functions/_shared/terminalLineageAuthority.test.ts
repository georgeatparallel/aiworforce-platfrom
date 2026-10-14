// D4 — THE LINEAGE ROW DECIDES WHETHER THE MISSION ENDED.
//
// Query B (chaos lab, tests/replay/failure): the last slice's result write is
// lost; the slice still releases its lineage `terminal`; the task row reads the
// previous slice's `continuation_required`. The worker used to release the
// queue `resumable` from that row — and `claim_next_lead_mission` never claims
// a row whose lineage is terminal or cancelled, so the queue, task and plan
// were stranded. The worker now asks the lineage row when the task row says
// the run did not end. ZERO network, ZERO database.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type LineageOutcomeRow, mapTaskOutcome, queueStatusFor,
} from "../../../supabase/functions/_shared/leadMissionV2Request.ts";
import {
  finalQueueStatus, planTerminalReconciliation, terminalReasonFor, terminalViolations,
} from "../../../supabase/functions/_shared/leadMissionTerminal.ts";
import { createLeadMissionRunner, type LeadMissionRunnerDeps } from "../../../worker/leadMissionRunner.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import type { ClaimedMission } from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";

const stale = { status: "complete", terminal_status: "continuation_required", lineage_slices: 2, continuation_decision: "replenishment_required" };
const ended: LineageOutcomeRow = { status: "terminal", terminal_reason: "frontier_exhausted", terminal_status: "search_exhausted" };

// ── THE MAPPING ─────────────────────────────────────────────────────────────

Deno.test("D4 a terminal lineage ends a run whose task row still says continuation_required — with the slice's own verdict", () => {
  const out = mapTaskOutcome(stale, ended);
  assertEquals(out, { status: "search_exhausted", terminal: true });
  assertEquals(queueStatusFor(out), "complete");
  assertEquals(finalQueueStatus(out, 1), "complete");
  assertEquals(terminalReasonFor(out, 1), "search_exhausted", "the reason the reconciliation writes onto the task");
});

Deno.test("D4 the verdict falls back to the lineage's terminal reason when its state carries none", () => {
  assertEquals(mapTaskOutcome(stale, { ...ended, terminal_status: null }), { status: "frontier_exhausted", terminal: true });
  // A state that itself still says continue is no verdict.
  assertEquals(mapTaskOutcome(stale, { ...ended, terminal_status: "continuation_required" }),
    { status: "frontier_exhausted", terminal: true });
  assertEquals(mapTaskOutcome(stale, { status: "terminal", terminal_reason: null, terminal_status: null }),
    { status: "lineage_terminal", terminal: true });
});

Deno.test("D4 CANCELLATION: a cancelled lineage releases the queue cancelled, never resumable", () => {
  const out = mapTaskOutcome(stale, { status: "cancelled", terminal_reason: "user_cancelled", terminal_status: null });
  assertEquals(out, { status: "cancelled", terminal: true });
  assertEquals(queueStatusFor(out), "cancelled");
});

Deno.test("D4 the task row still wins whenever it says how the run ended", () => {
  // A failure the task row records is never rewritten into the lineage's success.
  assertEquals(mapTaskOutcome({ status: "failed", terminal_status: "provider_failure" }, ended),
    { status: "failed:provider_failure", terminal: true });
  assertEquals(mapTaskOutcome({ status: "complete", terminal_status: "quota_met" }, ended),
    { status: "quota_met", terminal: true });
});

Deno.test("D4 an ACTIVE lineage, or none, changes nothing: a continuation stays resumable", () => {
  const active: LineageOutcomeRow = { status: "active", terminal_reason: null, terminal_status: "continuation_required" };
  assertEquals(mapTaskOutcome(stale, active), { status: "continuation_required", terminal: false });
  assertEquals(mapTaskOutcome(stale, null), { status: "continuation_required", terminal: false });
  assertEquals(mapTaskOutcome(stale), { status: "continuation_required", terminal: false });
  assertEquals(finalQueueStatus(mapTaskOutcome(stale, active), 1), "resumable");
});

// ── THE RECONCILIATION THAT FOLLOWS ─────────────────────────────────────────

Deno.test("D4 the queue's terminal release then makes the task and plan agree — the stale row gets the lineage's verdict", () => {
  const rows = {
    // The claim release had already set `complete` from the slice's memory.
    task: { status: "complete", result: { terminal_status: "continuation_required", task_status: "partial" } },
    lineage: { status: "terminal" },
    plan: { status: "executing" },
  };
  const reason = terminalReasonFor(mapTaskOutcome(stale, ended), 1);
  const patch = planTerminalReconciliation("complete", reason, rows, "2026-10-14T00:00:00Z");
  assert(patch.violations.includes("task.terminal_status=continuation_required"));
  assertEquals(patch.task?.result.terminal_status, "search_exhausted");
  assertEquals(patch.task?.status, "complete", "a finished row is not re-statused");
  assertEquals(patch.lineage, undefined, "the lineage already ended: not rewritten");
  assertEquals(patch.plan?.status, "partial", "a mission that stopped short reads partial, as a clean ending would");
  const after = {
    task: { status: patch.task!.status, result: patch.task!.result },
    lineage: rows.lineage, plan: { status: patch.plan!.status },
  };
  assertEquals(terminalViolations("complete", after), []);
});

// ── THE RUNNER ──────────────────────────────────────────────────────────────

const fresh: ClaimedMission = {
  queueId: "q1", workspaceId: "ws-1", request: { plan_id: "plan-1", tool_input: {} }, taskId: null, lineageId: null,
  attempts: 1, isResume: false, heldUntil: null,
};
const ctl = () => ({ executionBudgetMs: 300_000, signal: new AbortController().signal });
function deps(over: Partial<LeadMissionRunnerDeps>, reads: string[]): LeadMissionRunnerDeps {
  return {
    serviceRoleKey: "k", functionsBaseUrl: "https://fake.test/functions/v1",
    createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs }),
    bind: async () => true,
    readTaskOutcome: async () => stale,
    readLineageOutcome: async (id) => { reads.push(id); return ended; },
    handler: async (_req, opts) => {
      await opts.onExecutionBound?.({ taskId: "task-1", lineageId: "lineage-1", holdsLease: true });
      return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
    },
    ...over,
  };
}

Deno.test("D4 runner: a stale task row behind a terminal lineage is released TERMINAL — read by the lineage id the handler bound", async () => {
  const reads: string[] = [];
  const out = await createLeadMissionRunner(deps({}, reads)).run(fresh, ctl());
  assertEquals(reads, ["lineage-1"]);
  assertEquals([out.status, out.terminal, out.taskId], ["search_exhausted", true, "task-1"]);
});

Deno.test("D4 runner: the lineage is never read when the task row already ended the run", async () => {
  const reads: string[] = [];
  const out = await createLeadMissionRunner(deps({ readTaskOutcome: async () => ({ status: "complete", terminal_status: "quota_met" }) }, reads))
    .run(fresh, ctl());
  assertEquals(reads, []);
  assertEquals([out.status, out.terminal], ["quota_met", true]);
});

Deno.test("D4 runner: no lineage reader, or a failed read, keeps today's behaviour — resumable", async () => {
  const reads: string[] = [];
  const noReader = await createLeadMissionRunner(deps({ readLineageOutcome: undefined }, reads)).run(fresh, ctl());
  assertFalse(noReader.terminal);
  const failedRead = await createLeadMissionRunner(deps({ readLineageOutcome: async () => null }, reads)).run(fresh, ctl());
  assertFalse(failedRead.terminal);
  assertEquals(failedRead.status, "continuation_required");
});

Deno.test("D4 runner: a resumed mission's lineage is the one the queue row names until the handler binds", async () => {
  const reads: string[] = [];
  await createLeadMissionRunner(deps({
    handler: async () => new Response(JSON.stringify({ task_id: "task-1" }), { status: 409 }),
  }, reads)).run({ ...fresh, taskId: "task-1", lineageId: "lineage-1", isResume: true }, ctl());
  // A refused resume (409) of a mission whose lineage already ended: released terminal, not retried for ever.
  assertEquals(reads, ["lineage-1"]);
});
