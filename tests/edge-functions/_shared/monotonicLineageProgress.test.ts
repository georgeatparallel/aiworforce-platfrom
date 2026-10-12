// LINEAGE PROGRESS NEVER GOES BACKWARDS.
//
// Query B d22d9ee6 (2026-10-12): slice 3 recorded `continuations_used: 3`;
// slice 4 read the task row's `lead_lineage_progress` as ABSENT and folded
// from zero, so it wrote 1. The queue then saw "no new slice" (1 ≤ 3), charged
// real slices as retries (attempts 1 → 3) and held each one for 2 minutes. The
// write that dropped the key was not identified from the logs, so the defence
// is structural: the effective progress is the maximum of every durable copy —
// the task row, the lineage's own state, and the queue row's continuation
// count — and no result write may lower it.
//
// PURE.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  guardProgressWrite, resolveLineageProgress,
} from "../../../supabase/functions/_shared/lineageProgressGuard.ts";
import { LINEAGE_PROGRESS_KEY, readLineageProgress } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

const P = (continuations_used: number, extra: Record<string, unknown> = {}) => ({
  ...readLineageProgress({}), continuations_used, cost_units_used: continuations_used * 2, ...extra,
});

Deno.test("stored 3, queue 3, the task result lost the key → effective progress stays 3", () => {
  const r = resolveLineageProgress({ stored: undefined, lineageState: { [LINEAGE_PROGRESS_KEY]: P(3) }, queueContinuations: 3 });
  assertEquals(r.progress.continuations_used, 3);
  assert(r.floored, "the missing copy was noticed");
});

Deno.test("only the queue survives (stored and lineage both missing) → continuations floored at the queue's 3", () => {
  const r = resolveLineageProgress({ stored: null, lineageState: null, queueContinuations: 3 });
  assertEquals(r.progress.continuations_used, 3);
});

Deno.test("stored 2, queue 3 → effective 3", () => {
  assertEquals(resolveLineageProgress({ stored: P(2), lineageState: null, queueContinuations: 3 }).progress.continuations_used, 3);
});

Deno.test("stored 4, queue 3 → keep 4 (the task is ahead of the queue)", () => {
  const r = resolveLineageProgress({ stored: P(4), lineageState: P(3), queueContinuations: 3 });
  assertEquals(r.progress.continuations_used, 4);
  assertFalse(r.floored);
});

Deno.test("monotonic counters take the maximum; barren and stop fields come from the furthest-advanced copy", () => {
  const r = resolveLineageProgress({
    stored: P(2, { barren_slices: 1, qualified_high_water: 1, claim_progress: 50 }),
    lineageState: { [LINEAGE_PROGRESS_KEY]: P(3, { barren_slices: 0, qualified_high_water: 1, claim_progress: 59 }) },
    queueContinuations: 3,
  });
  assertEquals([r.progress.continuations_used, r.progress.claim_progress, r.progress.barren_slices], [3, 59, 0]);
});

Deno.test("a malformed copy is ignored, never trusted for a higher value", () => {
  const r = resolveLineageProgress({ stored: { continuations_used: "999" }, lineageState: null, queueContinuations: 2 });
  assertEquals(r.progress.continuations_used, 2);
  assertEquals(resolveLineageProgress({ stored: P(2), lineageState: null, queueContinuations: Number.NaN }).progress.continuations_used, 2);
});

Deno.test("a later stale write that would restore 1 is refused: the row keeps 3, and it is reported", () => {
  const prior = { [LINEAGE_PROGRESS_KEY]: P(3), other: "kept" };
  const g = guardProgressWrite("stage_boundary", prior, { other: "new", [LINEAGE_PROGRESS_KEY]: P(1) });
  assertEquals((g.result[LINEAGE_PROGRESS_KEY] as { continuations_used: number }).continuations_used, 3);
  assertEquals(g.result.other, "new", "everything else the writer wrote stands");
  assert(g.diagnostic.restored);
  assertEquals([g.diagnostic.continuations_before, g.diagnostic.continuations_after], [3, 3]);
});

Deno.test("a write that DROPS the key keeps the prior progress", () => {
  const g = guardProgressWrite("preflight", { [LINEAGE_PROGRESS_KEY]: P(3) }, { paid_execution_preflight: {} });
  assertEquals((g.result[LINEAGE_PROGRESS_KEY] as { continuations_used: number }).continuations_used, 3);
  assert(g.diagnostic.restored && g.diagnostic.present_before && !g.diagnostic.present_in_write);
});

Deno.test("a normal forward write passes untouched and is not flagged", () => {
  const g = guardProgressWrite("slice_result", { [LINEAGE_PROGRESS_KEY]: P(3) }, { [LINEAGE_PROGRESS_KEY]: P(4) });
  assertEquals((g.result[LINEAGE_PROGRESS_KEY] as { continuations_used: number }).continuations_used, 4);
  assertFalse(g.diagnostic.restored);
});

Deno.test("deterministic: the same copies in any order resolve to the same progress", () => {
  const a = resolveLineageProgress({ stored: P(2), lineageState: { [LINEAGE_PROGRESS_KEY]: P(3) }, queueContinuations: 1 });
  const b = resolveLineageProgress({ stored: P(3), lineageState: { [LINEAGE_PROGRESS_KEY]: P(2) }, queueContinuations: 1 });
  assertEquals(a.progress, b.progress);
});
