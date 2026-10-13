// [historical] M — CHECKPOINT SLIMMING CHANGES THE BYTES, NEVER THE DECISIONS.
//
// Query B canaries d22d9ee6 (2026-10-12) and eb0d520f (2026-10-13). With most
// discovered employers rejected at discovery, the resume checkpoint carried
// every closed company with every job row and every restated fact; the task
// result passed 2 MB, slice writes ran 30–160 s and hit the statement timeout,
// and a lost slice-result write made the queue count a real slice as a retry.
//
// Both lineages are replayed resuming through the PERSISTED checkpoint at every
// slice boundary (JSON, then `readCheckpointCompanies`), as production
// resumes: once from what the previous writer stored, once from what this
// code stores. Every slice must decide the same, show the same Workbench rows,
// buy the same provider calls and end the same way.
//
// PURE. Zero provider calls, zero model calls.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { type LineageFixture, replayLineage } from "../lib/lineage.ts";
import { type EngineSlice, missionOf, replayEngineSlice } from "../lib/engine.ts";
import { persistedCarrier, persistedResult, sliceSummary, type SliceSummary } from "../lib/slim.ts";
import { carried, queryBFixture, recordedRouteControl } from "../lib/queryB.ts";
import { benchLineage } from "../bench/payloadBench.ts";

async function d22(full: boolean) {
  const fx = loadFixture("queryBd22d9ee6.loop") as LineageFixture;
  const mission = missionOf(fx);
  const sums: SliceSummary[] = [];
  const bytes: number[] = [];
  const run = await replayLineage(fx, {
    maxSlices: 10,
    carry: persistedCarrier({ full }),
    onSlice: (n, s) => {
      sums.push(sliceSummary(n, s, mission, fx.provenance.task_id));
      bytes.push(persistedResult(s, { full }).length);
    },
  });
  return { sums, bytes, slices: run.slices, terminal: run.terminal };
}

Deno.test("[historical] M d22d9ee6: resuming from the slim checkpoint decides exactly as from the full one, every slice", async () => {
  const full = await d22(true);
  const slim = await d22(false);
  assertEquals(slim.terminal, "search_exhausted");
  assertEquals(slim.terminal, full.terminal);
  assertEquals(slim.slices, full.slices, "decision, continuation, barren count, progress, discovery and job searches per slice");
  assertEquals(slim.sums.length, full.sums.length);
  for (let i = 0; i < full.sums.length; i++) {
    assertEquals(slim.sums[i], full.sums[i], `slice ${i + 1}: companies, Workbench rows, qualified keys, discovery and provider calls`);
  }
  assertEquals(slim.slices.at(-1)!.qualified, ["Continuum AI"]);
});

Deno.test("[historical] M d22d9ee6: the persisted checkpoint is a third smaller by slice 3, and shrinks every slice", async () => {
  const full = await d22(true);
  const slim = await d22(false);
  for (let i = 0; i < full.bytes.length; i++) assert(slim.bytes[i] < full.bytes[i], `slice ${i + 1}: ${slim.bytes[i]} < ${full.bytes[i]}`);
  const last = full.bytes.length - 1;
  assert(slim.bytes[last] <= full.bytes[last] * 0.65, `slice ${last + 1}: ${slim.bytes[last]} ≤ 65% of ${full.bytes[last]}`);
});

Deno.test("[historical] M d22d9ee6 bench: continuing slices write a third less, half the bytes, fewer whole-result rewrites", async () => {
  const before = await benchLineage("queryBd22d9ee6.loop", "before");
  const after = await benchLineage("queryBd22d9ee6.loop", "after");
  assertEquals(after.terminal, before.terminal);
  for (let i = 0; i < before.slices.length; i++) {
    const b = before.slices[i], a = after.slices[i];
    assert(a.checkpoint < b.checkpoint && a.lineage_state < b.lineage_state && a.task_result < b.task_result, `slice ${b.slice}`);
    assert(a.bytes_rewritten <= b.bytes_rewritten * 0.5, `slice ${b.slice}: rewritten ${a.bytes_rewritten} vs ${b.bytes_rewritten}`);
    assert(a.rewrites < b.rewrites, `slice ${b.slice}: ${a.rewrites} < ${b.rewrites} whole-result rewrites`);
    if (b.continuing) {
      assert(a.research_fabric < 10_000, `slice ${b.slice}: a continuing slice writes the fabric summary (${a.research_fabric})`);
      assert(a.task_result <= b.task_result * 0.75, `slice ${b.slice}: task result ${a.task_result} vs ${b.task_result}`);
    } else {
      // In full, once. Built from restored companies, so a closed company's
      // fabric entry lists one statement per dimension (nothing reads the fabric back).
      assert(a.research_fabric > b.research_fabric * 0.8, `slice ${b.slice}: the full fabric (${a.research_fabric} vs ${b.research_fabric})`);
    }
  }
});

/** Query B a9a6791a: slice 1 as production ran it, then two resumed slices. */
async function a9(full: boolean) {
  const fx = queryBFixture();
  const mission = missionOf(fx);
  const carry = persistedCarrier({ full });
  const resumeFrom = (s: EngineSlice) => ({ ...carried(s), resume: carry(s) });
  // Each summary is taken as its slice ends: the next slice is handed this
  // one's discovery state and may advance it.
  const sums: SliceSummary[] = [];
  let s = await replayEngineSlice(fx, { deps: { controlRoutes: recordedRouteControl(fx) } });
  sums.push(sliceSummary(1, s, mission, fx.provenance.task_id));
  for (const n of [2, 3]) {
    s = await replayEngineSlice(fx, resumeFrom(s));
    sums.push(sliceSummary(n, s, mission, fx.provenance.task_id));
  }
  return sums;
}

Deno.test("[historical] M a9a6791a: two resumes from the slim checkpoint match two resumes from the full one", async () => {
  const full = await a9(true);
  const slim = await a9(false);
  assert(full[0].companies.some((c) => c.closed), "the mission has companies closed at discovery");
  assert(full[0].companies.some((c) => !c.closed), "and companies still under investigation");
  for (let i = 0; i < full.length; i++) assertEquals(slim[i], full[i], `slice ${i + 1}`);
});

/**
 * THE SIZE GUARD. The d22d9ee6 lineage at its last slice (68 employers, 64
 * closed at discovery) measured, after this batch: checkpoint 394 KB, lineage
 * state 504 KB, bytes rewritten per slice ~8 whole-result writes. Before: 1,086
 * KB, 1,194 KB, 12 writes. A change that grows them past these limits — about
 * 15% headroom — fails here, offline, instead of as a statement timeout.
 */
Deno.test("[historical] M size guard: the canary-sized lineage stays under its measured checkpoint, lineage and rewrite budget", async () => {
  const after = await benchLineage("queryBd22d9ee6.loop", "after");
  const last = after.slices.at(-1)!;
  assertEquals(last.companies, 68);
  assert(last.checkpoint <= 455_000, `checkpoint ${last.checkpoint} B`);
  assert(last.lineage_state <= 580_000, `lineage state ${last.lineage_state} B`);
  for (const s of after.slices) assert(s.rewrites <= s.stage_boundaries + 4, `slice ${s.slice}: ${s.rewrites} whole-result rewrites`);
  for (const s of after.slices.filter((x) => x.continuing)) assert(s.task_result <= 900_000, `slice ${s.slice}: task result ${s.task_result} B`);
});
