// ONE TERMINAL TRANSITION FOR A LEAD V2 MISSION.
//
// Run 4250f181 ended as
//
//   queue   failed                     (5 of 5 attempts)
//   task    ready / continuation_required
//   lineage active
//   plan    partial
//
// — four records, three different answers to "is this mission over?", and a UI
// that still offered Continue on a mission nothing would ever run again. The
// queue decided the mission was finished and nobody told the other three.
//
// THE RULE. Once the queue is terminal, every record is:
//
//   queue      complete            failed / cancelled
//   task       not resumable       status `failed`, terminal_status != continuation_required
//   lineage    terminal            terminal (cancelled for a cancellation)
//   plan       complete | partial  failed
//
// PURE. The worker reads the rows, asks this module what to write, and writes
// it. Idempotent: consistent rows produce no writes.

import { queueStatusFor, type QueueReleaseStatus } from "./leadMissionV2Request.ts";
import { IMMEDIATE_CONTINUATION_REASONS } from "./leadAutoContinuation.ts";

/**
 * RETRIES the queue grants a mission. MIRRORS the literal in
 * `claim_next_lead_mission` (`attempts < 5`) and `release_lead_mission`
 * (`attempts >= 5`); a test reads the migrations and fails if they drift.
 *
 * A retry, not a slice. Every claim takes an attempt, and a CLEAN continuation
 * — a run that folded a new slice into the lineage and asked to continue —
 * refunds it at release (20261003120000). What stays counted is what the
 * budget is for: errors, aborts, crashes, lease expiries, and runs that ended
 * without completing a slice. Canary 53784493 was stopped before page 3 by
 * five clean slices spending this as if they were five failures.
 */
export const V2_MAX_ATTEMPTS = 5;

/**
 * The queue's BACKSTOP on clean slices — never the budget that normally ends a
 * mission. The lineage stops itself first, at `resolveMaxContinuations()`
 * (default 10, configurable up to `MAX_CONTINUATIONS_CAP`), its cost ceiling or
 * its barren-slice rule, and returns a terminal status. This only fires if a
 * handler keeps asking to continue past every ceiling it has. Equal to
 * `MAX_CONTINUATIONS_CAP` and to the `25` in both RPCs; a test pins all three.
 */
export const V2_MAX_CONTINUATION_SLICES = 25;

/**
 * The terminal reason for a mission whose attempts were spent by a real,
 * retriable execution failure — an error or an abort on the last attempt.
 */
export const RETRY_BUDGET_EXHAUSTED = "retry_budget_exhausted";
/**
 * The terminal reason for a mission whose retries ran out although its last
 * attempt ended without an error: the allowance went on runs that completed no
 * new slice (a 409 on a still-held resume claim, a crash, a lease expiry), not
 * on failures the run itself reported. A clean slice no longer spends it.
 * (An evidence-exhausted mission never reaches this: it ends `search_exhausted`
 * through continuation — `canStillQualify`.)
 */
export const CONTINUATION_ATTEMPTS_EXHAUSTED = "continuation_attempts_exhausted";
/**
 * The terminal reason for a mission stopped by the queue's slice BACKSTOP
 * (`V2_MAX_CONTINUATION_SLICES`): the handler kept asking to continue past
 * every ceiling it has. Should never be seen; if it is, the lineage's own
 * stopping rules are what broke.
 */
export const CONTINUATION_SLICES_EXHAUSTED = "continuation_slices_exhausted";

export type QueueTerminalStatus = "complete" | "failed" | "cancelled";

/** What the worker knows about a finished run, for the release decision. */
export interface ReleaseFacts {
  status: string;
  terminal: boolean;
  error?: unknown;
  aborted?: boolean;
  /**
   * `lead_lineage_progress.continuations_used` as the run left the task — the
   * lineage's own per-slice counter. Null when there is no task or no counter.
   */
  lineageSlices?: number | null;
  /** `result.auto_continuation.decision` as the run left the task, when it wrote one. */
  continuationDecision?: string | null;
}

/**
 * The lineage slice count to hand `release_lead_mission`, or null.
 *
 * Non-null ONLY for a clean continuation: the run asked to continue, reported
 * no error, and was not aborted. The database refunds the claim only if this
 * count is ahead of the one it has already seen, so a run that folded nothing
 * cannot earn a refund by repeating an old number.
 */
export function cleanContinuationSlices(o: ReleaseFacts): number | null {
  if (o.terminal || o.status !== "continuation_required") return null;
  if (o.error || o.aborted === true) return null;
  const n = o.lineageSlices;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * How soon the queue may hand a clean continuation to the next slice.
 *
 * `immediate` — the run's own decision says its next slice has work ready now
 * (`IMMEDIATE_CONTINUATION_REASONS`). Stated in the outcome document as
 * `dispatch`; the held migration 20261011120000 then releases the row with no
 * backoff, and only when the lineage's slice counter also moved.
 * `deferred` — a clean continuation that is waiting (a provider run still
 * executing) or whose decision is unknown: the queue's backoff is its cadence.
 * null — not a clean continuation; the queue decides as it always has.
 */
export function continuationDispatch(o: ReleaseFacts): "immediate" | "deferred" | null {
  if (cleanContinuationSlices(o) === null) return null;
  return o.continuationDecision && IMMEDIATE_CONTINUATION_REASONS.has(o.continuationDecision)
    ? "immediate" : "deferred";
}

/**
 * The status the worker releases with.
 *
 * A clean continuation is stated `resumable` whatever the attempt count: the
 * database decides — it refunds the claim when the slice is new, and fails the
 * mission only on the retry cap or the slice backstop, saying which. Anything
 * else non-terminal on the last attempt is a failure the worker knows about
 * now, and states now.
 */
export function finalQueueStatus(
  outcome: ReleaseFacts,
  attempts: number,
): QueueReleaseStatus {
  if (outcome.terminal) return queueStatusFor(outcome);
  if (cleanContinuationSlices(outcome) !== null) return "resumable";
  return attempts >= V2_MAX_ATTEMPTS ? "failed" : "resumable";
}

/**
 * Why a released mission ended.
 *
 * `queueReason` is what `release_lead_mission` returned when IT failed a
 * resumable release: `slices_exhausted` or `attempts_exhausted`. Absent (an
 * older database, or a release the database did not override), the worker's
 * own attempt count decides, exactly as before.
 */
export function terminalReasonFor(
  outcome: ReleaseFacts,
  attempts: number,
  queueReason?: string | null,
): string {
  if (!outcome.terminal && queueReason === "slices_exhausted") return CONTINUATION_SLICES_EXHAUSTED;
  if (!outcome.terminal && (queueReason === "attempts_exhausted" || attempts >= V2_MAX_ATTEMPTS)) {
    const failedRun = !!outcome.error || outcome.aborted === true;
    return failedRun ? RETRY_BUDGET_EXHAUSTED : CONTINUATION_ATTEMPTS_EXHAUSTED;
  }
  return outcome.status;
}

/**
 * True for the PostgREST error a call with an argument the database's function
 * does not have produces (`PGRST202`, "could not find the function"). The
 * worker uses it to fall back to the 4-argument release on a database the
 * 20261003120000 migration has not reached, so deploy order cannot strand a
 * mission in `running`.
 */
export function isMissingRpcSignature(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  return typeof error.message === "string" && /could not find the function/i.test(error.message);
}

export function isTerminalQueueStatus(s: string | null | undefined): s is QueueTerminalStatus {
  return s === "complete" || s === "failed" || s === "cancelled";
}

export interface TerminalRows {
  task: { status: string | null; result: Record<string, unknown> | null } | null;
  lineage: { status: string | null } | null;
  plan: { status: string | null } | null;
}

export interface TerminalPatch {
  task?: { status: string; result: Record<string, unknown> };
  lineage?: { status: "terminal" | "cancelled"; terminal_reason: string };
  plan?: { status: string; completed_at: string };
  /** What was inconsistent before the patch — for the log. */
  violations: string[];
}

const RESUMABLE_TASK_STATUSES = new Set(["ready", "running", "pending", "partial"]);
const RESUMABLE_TERMINAL = "continuation_required";
const LIVE_PLAN_STATUSES = new Set(["planning", "executing", "awaiting_approval", "partial"]);

function terminalStatusOf(result: Record<string, unknown> | null): string | null {
  const t = result?.terminal_status;
  return typeof t === "string" && t ? t : null;
}

/** Every way these rows disagree with a terminal queue. Empty means consistent. */
export function terminalViolations(queue: QueueTerminalStatus, rows: TerminalRows): string[] {
  const v: string[] = [];
  const failed = queue !== "complete";
  const t = rows.task;
  if (t) {
    if (RESUMABLE_TASK_STATUSES.has(String(t.status ?? ""))) v.push(`task.status=${t.status} is resumable`);
    if (terminalStatusOf(t.result) === RESUMABLE_TERMINAL) v.push("task.terminal_status=continuation_required");
    if (failed && t.status !== "failed") v.push(`task.status=${t.status}, queue=${queue}`);
  }
  const l = rows.lineage;
  if (l && l.status !== "terminal" && l.status !== "cancelled") v.push(`lineage.status=${l.status}`);
  const p = rows.plan;
  if (p) {
    if (failed && p.status !== "failed") v.push(`plan.status=${p.status}, queue=${queue}`);
    if (!failed && LIVE_PLAN_STATUSES.has(String(p.status ?? "")) && p.status !== "partial") {
      v.push(`plan.status=${p.status} is live`);
    }
    // A SATISFIED MISSION IS COMPLETE EVERYWHERE (canary 9b1b70a2: queue,
    // task and lineage complete, plan `partial`). `partial` stays a legitimate
    // ending only for a mission that stopped short of what was asked.
    if (!failed && p.status === "partial" && taskCompleted(t)) {
      v.push("plan.status=partial but the task completed");
    }
  }
  return v;
}

/**
 * The task delivered what was asked. Its own result says so (`task_status:
 * completed`); a result that predates `task_status` falls back to the row's
 * lifecycle status, as the reconciliation always did.
 */
function taskCompleted(t: TerminalRows["task"]): boolean {
  if (!t) return false;
  const stated = (t.result as Record<string, unknown> | null)?.task_status;
  if (stated != null) return stated === "completed";
  return t.status === "completed" || t.status === "complete";
}

/**
 * What to write so the rows agree with a terminal queue.
 *
 * Only what is wrong is written. A failed task that already says why keeps its
 * own terminal status; one that still says `continuation_required` (or nothing)
 * is given the queue's reason.
 */
export function planTerminalReconciliation(
  queue: QueueTerminalStatus,
  reason: string,
  rows: TerminalRows,
  nowIso: string,
  /** An operator's free-text reason (e.g. a cancellation's), kept on the task result. No schema change. */
  detail?: string | null,
): TerminalPatch {
  const violations = terminalViolations(queue, rows);
  const patch: TerminalPatch = { violations };
  if (violations.length === 0) return patch;
  const failed = queue !== "complete";

  const t = rows.task;
  if (t) {
    const result = { ...(t.result ?? {}) };
    const current = terminalStatusOf(t.result);
    const stillResumable = current === RESUMABLE_TERMINAL || current === null;
    const needsStatus = failed ? t.status !== "failed" : RESUMABLE_TASK_STATUSES.has(String(t.status ?? ""));
    if (needsStatus || stillResumable) {
      const terminal = stillResumable ? reason : current!;
      const prior = (result.auto_continuation && typeof result.auto_continuation === "object")
        ? result.auto_continuation as Record<string, unknown> : {};
      patch.task = {
        status: failed ? "failed" : (needsStatus ? "completed" : String(t.status)),
        result: {
          ...result,
          terminal_status: terminal,
          task_status: failed ? "failed" : (result.task_status ?? "completed"),
          auto_continuation: {
            ...prior,
            continuing: false,
            decision: terminal,
            detail: `the Lead V2 queue ended this mission (${queue}: ${reason})`,
          },
          v2_terminal: { queue_status: queue, reason, reconciled_at: nowIso, ...(detail ? { detail } : {}) },
        },
      };
    }
  }

  const l = rows.lineage;
  if (l && l.status !== "terminal" && l.status !== "cancelled") {
    patch.lineage = { status: queue === "cancelled" ? "cancelled" : "terminal", terminal_reason: reason };
  }

  const p = rows.plan;
  if (p) {
    // Judged on the task AS IT WILL READ after this patch, so the plan and the
    // task are written in agreement rather than one step apart.
    const task = patch.task ?? t;
    const satisfied = taskCompleted(task);
    if (failed && p.status !== "failed") {
      patch.plan = { status: "failed", completed_at: nowIso };
    } else if (!failed && LIVE_PLAN_STATUSES.has(String(p.status ?? "")) && p.status !== "partial") {
      patch.plan = { status: satisfied ? "complete" : "partial", completed_at: nowIso };
    } else if (!failed && p.status === "partial" && satisfied) {
      patch.plan = { status: "complete", completed_at: nowIso };
    }
  }
  return patch;
}

/** The rows as they will read after the patch — for tests and the post-write check. */
export function applyTerminalPatch(rows: TerminalRows, patch: TerminalPatch): TerminalRows {
  return {
    task: rows.task
      ? (patch.task ? { status: patch.task.status, result: patch.task.result } : rows.task)
      : null,
    lineage: rows.lineage ? (patch.lineage ? { status: patch.lineage.status } : rows.lineage) : null,
    plan: rows.plan ? (patch.plan ? { status: patch.plan.status } : rows.plan) : null,
  };
}

// ── THE RELEASE CALL ────────────────────────────────────────────────────────
//
// The worker's half of the release, with the database injected — so the canary
// replay drives exactly this against the real SQL. `worker/main.ts` cannot be
// imported by a test (it starts the worker), which is why this lives here.

export type QueueRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: unknown; message?: unknown } | null }>;

export interface QueueReleaseResult {
  /** False when the database refused (ownership lost) or the call errored. */
  released: boolean;
  finalStatus: string;
  /** Why the mission ended, when this release ended it; null otherwise. */
  terminalReason: string | null;
  /** Counters as the database left them; null on a database without them. */
  attempts: number | null;
  continuations: number | null;
  /** The slice count this release claimed a refund for, or null. */
  lineageSlices: number | null;
  /** True when the 4-argument call was used because the database predates it. */
  fallback: boolean;
  error: string | null;
}

export async function releaseQueuedMission(
  rpc: QueueRpc,
  r: {
    queueId: string;
    workerId: string;
    /** The count the claim returned — this run's attempt included. */
    attempts: number;
    outcome: ReleaseFacts;
    /** Stored verbatim as `last_outcome`. */
    outcomeDoc: Record<string, unknown>;
  },
): Promise<QueueReleaseResult> {
  const stated = finalQueueStatus(r.outcome, r.attempts);
  const slices = cleanContinuationSlices(r.outcome);
  // Rides in the outcome document, not a new parameter: a database without the
  // held 20261011120000 ignores it, and no signature changes for the fallbacks.
  const dispatch = continuationDispatch(r.outcome);
  const args: Record<string, unknown> = {
    p_queue_id: r.queueId, p_worker_id: r.workerId, p_status: stated,
    p_outcome: dispatch ? { ...r.outcomeDoc, dispatch } : r.outcomeDoc,
  };
  if (slices !== null) args.p_lineage_slices = slices;

  let fallback = false;
  let res = await rpc("release_lead_mission", args);
  if (res.error && slices !== null && isMissingRpcSignature(res.error)) {
    fallback = true;
    delete args.p_lineage_slices;
    res = await rpc("release_lead_mission", args);
  }
  const base = { attempts: null, continuations: null, lineageSlices: slices, fallback };
  if (res.error) {
    return { ...base, released: false, finalStatus: stated, terminalReason: null,
      error: String(res.error.message ?? "release_error") };
  }
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as Record<string, unknown> | null;
  // UNCHANGED FROM BEFORE: a refused release (ownership lost) still reports the
  // status the worker stated, and a terminal one is still reconciled.
  const finalStatus = String(row?.final_status ?? stated);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const queueReason = typeof row?.reason === "string" ? row.reason : null;
  return {
    ...base,
    released: row?.released === true,
    finalStatus,
    terminalReason: isTerminalQueueStatus(finalStatus)
      ? terminalReasonFor(r.outcome, r.attempts, queueReason)
      : null,
    attempts: num(row?.attempts),
    continuations: num(row?.continuations),
    error: null,
  };
}
