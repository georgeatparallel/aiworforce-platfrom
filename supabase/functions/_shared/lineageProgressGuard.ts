// LINEAGE PROGRESS IS MONOTONIC — WHICHEVER COPY SURVIVED.
//
// `lead_lineage_progress` lives on the task row, and the next slice folds from
// it. Query B d22d9ee6 (2026-10-12): slice 3 recorded `continuations_used: 3`;
// slice 4 read the key as ABSENT, folded from zero and wrote 1. The queue then
// saw no new slice (1 ≤ 3), charged real slices as retries and held each one
// for two minutes. The write that dropped the key was not identified from the
// logs, so the defence does not depend on finding it:
//
//   • the effective progress is resolved from EVERY durable copy — the task
//     row, the lineage's own state (`lead_lineages.current_state`, written at
//     release) and the queue row's continuation count — and monotonic counters
//     take the maximum;
//   • no task-result write may drop the key or lower it (`guardProgressWrite`),
//     and every write reports, in one structured line, what it did to it.
//
// Pure. The caller does the I/O and the logging.

import {
  LINEAGE_PROGRESS_KEY, type LineageProgress, readLineageProgress,
} from "./leadAutoContinuation.ts";

/** A copy is trusted only when it is an object whose counter is a real number. */
function validCopy(raw: unknown): LineageProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const c = (raw as Record<string, unknown>).continuations_used;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0) return null;
  return readLineageProgress(raw);
}

const MONOTONIC = [
  "continuations_used", "cost_units_used", "brain_decided", "claim_progress", "qualified_high_water",
  "unique_companies_investigated", "investigation_authorisations",
] as const;

export interface ResolvedLineageProgress {
  progress: LineageProgress;
  /** True when a copy other than the task row's raised the result (a lost or stale task copy). */
  floored: boolean;
  sources: { stored: number | null; lineage: number | null; queue: number | null };
}

/**
 * THE PROGRESS THE NEXT SLICE FOLDS FROM.
 *
 * Monotonic counters take the maximum over the valid copies; the queue row's
 * continuation count floors `continuations_used` (it is the queue's own record
 * of slices it refunded as continuations, so it can only be behind, never
 * ahead of the truth). `barren_slices` and the stop fields are NOT maxima —
 * they reset on progress — so they come from the most advanced copy.
 */
export function resolveLineageProgress(i: {
  stored: unknown;
  /** `lead_lineages.current_state`, or null. */
  lineageState: unknown;
  queueContinuations: number | null | undefined;
}): ResolvedLineageProgress {
  const stored = validCopy(i.stored);
  const lineage = validCopy((i.lineageState as Record<string, unknown> | null | undefined)?.[LINEAGE_PROGRESS_KEY]);
  const queue = typeof i.queueContinuations === "number" && Number.isFinite(i.queueContinuations) && i.queueContinuations >= 0
    ? Math.trunc(i.queueContinuations) : null;
  const copies = [stored, lineage].filter((x): x is LineageProgress => x !== null);
  // The most advanced copy carries the non-monotonic fields; ties prefer the task row.
  const leader = copies.reduce<LineageProgress | null>((a, b) =>
    !a || b.continuations_used > a.continuations_used ? b : a, null) ?? readLineageProgress({});
  const progress: LineageProgress = { ...leader };
  for (const k of MONOTONIC) {
    const values = copies.map((c) => Number(c[k] ?? 0));
    (progress as unknown as Record<string, number>)[k] = Math.max(0, ...values);
  }
  if (queue !== null && queue > progress.continuations_used) progress.continuations_used = queue;
  return {
    progress,
    floored: progress.continuations_used > (stored?.continuations_used ?? -1) ||
      (stored === null && progress.continuations_used > 0),
    sources: {
      stored: stored?.continuations_used ?? null,
      lineage: lineage?.continuations_used ?? null,
      queue,
    },
  };
}

export interface ProgressWriteDiagnostic {
  path: string;
  present_before: boolean;
  present_in_write: boolean;
  continuations_before: number | null;
  continuations_after: number | null;
  /** True when the write would have dropped or lowered the progress, and was corrected. */
  restored: boolean;
}

/**
 * A TASK-RESULT WRITE MAY NOT TAKE LINEAGE PROGRESS BACKWARDS.
 *
 * `prior` is the row as the writer read it; `next` is what it is about to
 * write. If `next` drops the key or carries fewer continuations than `prior`,
 * the prior progress is kept (everything else the writer wrote stands) and the
 * diagnostic says so. Returns the result to write.
 */
export function guardProgressWrite(
  path: string, prior: Record<string, unknown> | null | undefined, next: Record<string, unknown>,
): { result: Record<string, unknown>; diagnostic: ProgressWriteDiagnostic } {
  const before = validCopy(prior?.[LINEAGE_PROGRESS_KEY]);
  const presentInWrite = Object.hasOwn(next, LINEAGE_PROGRESS_KEY);
  const written = validCopy(next[LINEAGE_PROGRESS_KEY]);
  const lowers = before !== null && (written === null || written.continuations_used < before.continuations_used);
  const result = lowers ? { ...next, [LINEAGE_PROGRESS_KEY]: prior![LINEAGE_PROGRESS_KEY] } : next;
  const after = validCopy(result[LINEAGE_PROGRESS_KEY]);
  return {
    result,
    diagnostic: {
      path,
      present_before: before !== null,
      present_in_write: presentInWrite,
      continuations_before: before?.continuations_used ?? null,
      continuations_after: after?.continuations_used ?? null,
      restored: lowers,
    },
  };
}
