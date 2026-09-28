/**
 * Centralized state model for the Conversations experience.
 *
 * Every chat consumer (history sidebar, ConversationView, ChatView,
 * ExecutionPlanCard) derives its visible UI from these types so that
 * no backend state ever fails silently.
 */

import type { DBPlan, DBTask, DBApproval } from '@/lib/orchestration';

export type ConversationLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error';

export type MessageSendState =
  | 'idle'
  | 'sending'
  | 'sent'
  | 'failed';

export type WorkflowRunUiState =
  | 'not_started'
  | 'preparing'
  | 'waiting_confirmation'
  | 'running'
  | 'streaming_progress'
  | 'partial'
  | 'complete'
  | 'failed'
  | 'stale';

export interface DeriveWorkflowInput {
  plan: Pick<DBPlan, 'status' | 'created_at' | 'completed_at'> | null;
  tasks: (Pick<DBTask, 'status' | 'started_at' | 'finished_at'> & { result?: unknown })[];
  approvals: Pick<DBApproval, 'status'>[];
  /** Most recent backend event timestamp (activity, tool call, task transition). */
  lastActivityAt?: string | null;
  /** Wall-clock now, injectable for tests. Defaults to Date.now(). */
  now?: number;
}

const STALE_MS = 24 * 60 * 60 * 1000; // 24h
const LONG_RUNNING_MS = 90 * 1000;    // 90s

// ------------------------------------------------ checkpointed partial runs ---
//
// PR #115 separated three things that used to share one column:
//
//   tasks.status           DATABASE LIFECYCLE  — `ready` means CHECKPOINTED and
//                                                available for continuation
//   result.task_status     WORKFLOW PROGRESS   — partial / completed / failed
//   result.terminal_status SOURCING OUTCOME    — why sourcing stopped
//
// `ready` is not a lifecycle state this function knew about, and `partial` is
// not a plan status it knew about, so a checkpointed run matched no branch and
// fell through to `preparing` — "Pilot is preparing the workflow", forever,
// after the work was already done. Production run
// 3d54e4fe-b6b6-47a6-9dca-ee032785ea59 sat there for six minutes.
//
// `ready` is explicitly NOT completed: the run still owes the user leads.

/** The row status a checkpointed, resumable task carries. */
const CHECKPOINTED_ROW_STATUS = 'ready';

/** `result.task_status` values that mean "work happened, more is owed". */
const PARTIAL_RESULT_STATUSES: readonly string[] = ['partial'];

/** `result.terminal_status` values that mean "checkpointed, resumable". */
const RESUMABLE_TERMINAL_STATUSES: readonly string[] = ['continuation_required'];

/**
 * Does this task's RESULT describe a checkpointed partial run?
 *
 * Reads the two separated result fields and nothing else — never the row status,
 * which is the lifecycle question answered by the caller.
 */
export function taskResultIsPartial(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { task_status?: unknown; terminal_status?: unknown };
  return PARTIAL_RESULT_STATUSES.includes(String(r.task_status ?? ''))
    || RESUMABLE_TERMINAL_STATUSES.includes(String(r.terminal_status ?? ''));
}

/**
 * Has the backend checkpointed a partial run?
 *
 * Requires BOTH a lifecycle signal — the plan says `partial`, or a task row says
 * `ready` — AND a result that actually describes partial work. The result is
 * what makes this truthful: a bare `ready` row with no result has not proven it
 * did anything, and is left to the existing branches.
 */
export function isCheckpointedPartial(input: Pick<DeriveWorkflowInput, 'plan' | 'tasks'>): boolean {
  const planPartial = String(input.plan?.status ?? '') === 'partial';
  const anyCheckpointedRow = input.tasks.some((t) => String(t.status) === CHECKPOINTED_ROW_STATUS);
  if (!planPartial && !anyCheckpointedRow) return false;
  return input.tasks.some((t) => taskResultIsPartial(t.result));
}

/**
 * IS THE LEAD V2 QUEUE CARRYING THIS TASK ON?
 *
 * A designed pause between slices — or a save point inside one — writes the
 * row `ready` / `continuation_required`, the same shape as a run that stopped
 * and waits for the user's Continue. They are not the same state: the queue
 * re-claims its own mission, and nothing is owed by the user. Canary 11
 * (plan 76194e61) showed "Partial" in the chat while its worker was mid-slice.
 *
 * The owner is read from the top level (written from the first save point on)
 * and from `company_first` (written at every slice end).
 */
export function taskQueueContinuing(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { terminal_status?: unknown; continuation_owner?: unknown; company_first?: { continuation_owner?: unknown } | null };
  if (String(r.terminal_status ?? '') !== 'continuation_required') return false;
  return r.continuation_owner === 'v2_queue' || r.company_first?.continuation_owner === 'v2_queue';
}

// ------------------------------------------------- mission vs. row lifecycle -
//
// A TERMINAL TASK ROW IS NOT MISSION SUCCESS.
//
// Production showed "Execution Plan: Complete" beside "CONTACT-ready: 0 of 5,
// Remaining: 5". Both came from the same plan: the rows finished, so every
// branch below reported `complete`, while the quota contract said the mission
// delivered nothing. The canonical mission result is the quota, not the row.

/**
 * Does this task's result carry a company-first quota that was NOT met?
 *
 * Reads only the persisted quota contract (`requested_leads` / `eligible_leads`).
 * Returns false when no quota is present, so non-Lead workflows are untouched.
 */
export function taskQuotaUnmet(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, any>;
  const quota = r.company_first?.quota ?? r.quota ?? null;
  if (!quota || typeof quota !== 'object') return false;
  const requested = Number(quota.requested_leads);
  if (!Number.isFinite(requested) || requested <= 0) return false;
  const eligible = Number(quota.eligible_leads ?? 0);
  return !Number.isFinite(eligible) || eligible < requested;
}

/** Any task in this plan whose delivered quota falls short of what was asked. */
export function isQuotaShortfall(tasks: Pick<DeriveWorkflowInput, 'tasks'>['tasks']): boolean {
  return tasks.some((t) => taskQuotaUnmet(t.result));
}

export function deriveWorkflowUiState(input: DeriveWorkflowInput): WorkflowRunUiState {
  const { plan, tasks, approvals } = input;
  const now = input.now ?? Date.now();

  if (!plan) return 'not_started';
  if (plan.status === 'failed') return 'failed';

  const anyPendingApproval = approvals.some((a) => a.status === 'pending');
  if (anyPendingApproval) return 'waiting_confirmation';

  const anyFailed = tasks.some((t) => t.status === 'failed');
  const anyRunning = tasks.some((t) => t.status === 'running' || t.status === 'pending');
  const allTerminal = tasks.length > 0 && tasks.every((t) => t.status === 'complete' || t.status === 'skipped' || t.status === 'failed');
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'complete' || t.status === 'skipped');

  if (allTerminal && anyFailed) return 'partial';
  // Quota beats lifecycle: rows may be terminal while the mission is unmet.
  if ((allDone || plan.status === 'complete') && isQuotaShortfall(tasks)) return 'partial';
  if (allDone) return 'complete';
  if (plan.status === 'complete') return 'complete';





  if (anyRunning) {
    // Stale guard: a running plan with no activity for 24h is shown as stale,
    // not auto-marked failed.
    const lastTs = input.lastActivityAt ? Date.parse(input.lastActivityAt) : Date.parse(plan.created_at);
    if (Number.isFinite(lastTs) && now - lastTs > STALE_MS) return 'stale';
    return 'running';
  }

  // THE QUEUE IS STILL WORKING. A queue-owned checkpoint is a continuing run,
  // not a paused one — shown as running, with the same staleness guard, so a
  // worker that has genuinely died still surfaces as stale rather than running.
  if (tasks.some((t) => String(t.status) === CHECKPOINTED_ROW_STATUS && taskQueueContinuing(t.result))) {
    const lastTs = input.lastActivityAt ? Date.parse(input.lastActivityAt) : Date.parse(plan.created_at);
    if (Number.isFinite(lastTs) && now - lastTs > STALE_MS) return 'stale';
    return 'running';
  }

  // A CHECKPOINTED PARTIAL IS NOT PREPARATION. Deliberately below `anyRunning`:
  // a plan with one checkpointed task and another still executing is still
  // running. Only once nothing is in flight does a checkpoint become the state.
  if (isCheckpointedPartial({ plan, tasks })) return 'partial';

  if (plan.status === 'planning') return 'preparing';
  return 'preparing';
}

export function isWorkflowActive(state: WorkflowRunUiState): boolean {
  return state === 'preparing' || state === 'running' || state === 'streaming_progress' || state === 'waiting_confirmation';
}

export function isLongRunning(lastActivityAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastActivityAt) return false;
  const ts = Date.parse(lastActivityAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts > LONG_RUNNING_MS;
}

export const WORKFLOW_UI_LABEL: Record<WorkflowRunUiState, string> = {
  not_started: 'Not started',
  preparing: 'Preparing',
  waiting_confirmation: 'Needs approval',
  running: 'Running',
  streaming_progress: 'Running',
  partial: 'Partial',
  complete: 'Complete',
  failed: 'Failed',
  stale: 'Stale',
};
