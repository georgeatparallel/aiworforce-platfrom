// A RUN THE LEAD V2 QUEUE IS CARRYING ON IS RUNNING, NOT "PARTIAL".
//
// Canary 11 (plan 76194e61): the first save point, 34 seconds in, wrote the task
// row `ready` / `continuation_required` and the plan `partial` — the shape of a
// run that stopped and waits for Continue. The chat's plan pill read it as
// "Partial" while the worker was still mid-slice, and again between slices.
//
// Read through the browser's real fetch path (`TASK_LIST_COLUMNS` applied the
// way PostgREST applies it), because a key the projection drops is a rule that
// never fires. PURE.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { projectTaskListRow, TASK_LIST_COLUMNS } from "../../src/lib/taskListProjection.ts";
import { deriveWorkflowUiState, taskQueueContinuing } from "../../src/lib/chat/state.ts";

const NOW = Date.parse("2026-09-28T10:00:00.000Z");
const PLAN_CREATED = "2026-09-28T09:55:00.000Z";

/** `select=<TASK_LIST_COLUMNS>` as PostgREST answers it. */
function postgrestSelect(columns: string, row: Record<string, unknown>, result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns.split(",")) {
    const m = /^(\w+):result->(.+)$/.exec(col);
    if (!m) { out[col] = row[col] ?? null; continue; }
    let v: unknown = result;
    for (const key of m[2].split("->")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    out[m[1]] = v ?? null;
  }
  return out;
}
const fetchedTask = (status: string, result: Record<string, unknown>) =>
  projectTaskListRow(postgrestSelect(TASK_LIST_COLUMNS, { id: "t1", status, plan_id: "p1" }, result)) as { status: string; result: Record<string, unknown> | null };

const state = (planStatus: string, task: { status: string; result: unknown }, lastActivityAt: string | null = "2026-09-28T09:59:30.000Z") =>
  deriveWorkflowUiState({
    plan: { status: planStatus, created_at: PLAN_CREATED } as never,
    tasks: [task as never], approvals: [], lastActivityAt, now: NOW,
  });

// The checkpoint write, as run-agent now makes it at the FIRST save point (top-level owner only).
const firstSavePoint = { task_status: "partial", terminal_status: "continuation_required", continuation_owner: "v2_queue" };
// A slice end the queue will continue (owner inside `company_first`, as the slice-end write carries it).
const sliceEnd = { task_status: "partial", terminal_status: "continuation_required",
  company_first: { status: "continuation_required", continuation_owner: "v2_queue", quota: { requested_leads: 1, eligible_leads: 0 } } };

Deno.test("SLICE PAUSE / SAVE POINT: a queue-owned checkpoint reaches the browser and reads as RUNNING", () => {
  const t = fetchedTask("ready", firstSavePoint);
  assertEquals(t.result?.continuation_owner, "v2_queue", "TASK_LIST_COLUMNS projects the owner");
  assertEquals(taskQueueContinuing(t.result), true);
  assertEquals(state("partial", t), "running");
});

Deno.test("CONTINUATION: between slices (owner inside company_first) it still reads as RUNNING", () => {
  assertEquals(state("partial", fetchedTask("ready", sliceEnd)), "running");
});

Deno.test("COMPLETION AFTER CONTINUATION: the terminal row wins — COMPLETE", () => {
  const done = { task_status: "completed", terminal_status: "completed", continuation_owner: "v2_queue",
    company_first: { status: "completed", continuation_owner: "v2_queue", quota: { requested_leads: 1, eligible_leads: 1 } } };
  assertEquals(state("complete", fetchedTask("complete", done)), "complete");
  assertEquals(state("executing", fetchedTask("complete", done)), "complete",
    "a lagging plan row cannot keep a terminal task visually Running");
});

Deno.test("A LEGACY PAUSE (no queue) is still PARTIAL — the user does owe it a Continue", () => {
  assertEquals(state("partial", fetchedTask("ready", { task_status: "partial", terminal_status: "continuation_required" })), "partial");
});

Deno.test("ACTUAL TIMEOUT / DEAD WORKER: a queue-owned checkpoint with no activity for a day is STALE, not running forever", () => {
  assertEquals(state("partial", fetchedTask("ready", firstSavePoint), "2026-09-27T09:00:00.000Z"), "stale");
});

Deno.test("TERMINAL FAILURE and BUDGET STOP read from the terminal row, never the checkpoint", () => {
  const failed = { task_status: "failed", terminal_status: "retry_budget_exhausted", continuation_owner: "v2_queue" };
  assertEquals(state("failed", fetchedTask("failed", failed)), "failed");
  const budget = { task_status: "partial", terminal_status: "budget_exhausted", continuation_owner: "v2_queue",
    company_first: { status: "budget_exhausted", quota: { requested_leads: 2, eligible_leads: 1 } } };
  assertEquals(state("partial", fetchedTask("complete", budget)), "partial", "stopped short of the ask — not running, not complete");
});
