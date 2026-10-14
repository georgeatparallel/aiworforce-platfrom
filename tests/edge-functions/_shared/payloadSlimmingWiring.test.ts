// THE PAYLOAD CHANGES ARE WIRED WHERE THE PRODUCTION SLICE WRITES.
//
// Query B eb0d520f (2026-10-13): a 2.15 MB task result was read and rewritten
// in full about sixteen times a slice; the slice-result write ran 161 s and was
// lost without a word. These pin, in run-agent:
//
//   * the stage-boundary progress rides on the checkpoint write (one whole-result
//     rewrite per boundary, not two), and is still written whenever no
//     checkpoint write follows;
//   * a continuing slice writes the research-fabric summary; the full fabric
//     once, when the lineage ends;
//   * a failed slice-result write is reported;
//   * every task-result write, checkpoint, lineage state and Workbench view is
//     measured against its budget.
//
// PURE (reads source files; the size measure is exercised directly).

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { measurePayload, PAYLOAD_WARN_BYTES, payloadBytes } from "../../../supabase/functions/_shared/payloadSize.ts";
import { researchFabricSummary } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";

const src = await Deno.readTextFile(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const between = (from: string, to: string) => {
  const i = code.indexOf(from);
  assert(i >= 0, from);
  return code.slice(i, code.indexOf(to, i));
};

Deno.test("progress is owed, not written, and the checkpoint write carries it", () => {
  const onProgress = between("onProgress: (p) => {", "},");
  assert(onProgress.includes("progressOwed = p"));
  assertFalse(onProgress.includes(".update("), "no whole-result rewrite for progress alone");
  const boundary = between('guardResult("stage_boundary"', "capability_execution_state: snap.state");
  assert(boundary.includes("workbench_progress: progressCarried"));
});

Deno.test("every way a checkpoint write is skipped still writes the owed progress", () => {
  const onCheckpoint = between("onCheckpoint: async (snap) => {", "verifyEmployer");
  const returns = [...onCheckpoint.matchAll(/return \{ written: false/g)].length;
  const flushed = [...onCheckpoint.matchAll(/await flushProgress\(\);\s*\n\s*return \{ written: false/g)].length;
  assert(returns >= 4, `${returns} skip paths`);
  assertEquals(flushed, returns, "each skip path flushes first");
  assert(code.includes('guardResult("progress_publish"'), "the flush is still a guarded progress write");
});

Deno.test("a continuing slice writes the research-fabric summary; the full fabric once, at the end", () => {
  assert(/return autoDecision\.continue \? researchFabricSummary\(fabric\) : fabric;/.test(code));
  const f = researchFabricSummary({ version: "v", union: { unique_companies: 3, multi_source_companies: 0, observations: 3, merged_sightings: 0 }, companies: [{} as never, {} as never], waves: [], route_controls: [] } as never);
  assertEquals([f.companies.length, f.companies_deferred, f.union.unique_companies], [0, 2, 3]);
});

Deno.test("a failed slice-result write is reported, not ignored", () => {
  // Fenced since D1: the outcome is read off the fenced write.
  assert(/const sliceResultWrite = await fencedTaskUpdate\(/.test(code));
  assert(code.includes("const sliceResultError = sliceResultWrite.error;"));
  assert(code.includes('"[run-agent][slice-result] persist failed"'));
});

Deno.test("task result, checkpoints, lineage state and Workbench view are all measured", () => {
  assert(code.includes('measurePayload("task_result", g.result)'), "every guarded task-result write");
  assertEquals([...code.matchAll(/sized\("checkpoint", buildCheckpoint\(/g)].length, 2, "stage boundary and final snapshot");
  assert(code.includes('measurePayload("lineage_state", merged.state)'));
  assert(code.includes('sized("canonical_view", '));
});

Deno.test("the size measure: UTF-8 bytes, a warning only past the budget, and where the bytes are", () => {
  assertEquals(payloadBytes({ a: "é" }), 10);
  const small = measurePayload("checkpoint", { companies: [] });
  assertFalse(small.over);
  assertEquals(small.largest, undefined);
  const big = measurePayload("checkpoint", { companies: "x".repeat(PAYLOAD_WARN_BYTES.checkpoint), meta: 1 });
  assert(big.over);
  assertEquals(big.largest?.[0][0], "companies");
  assertEquals(payloadBytes({ toJSON() { throw new Error("cyclic"); } }), null);
});
