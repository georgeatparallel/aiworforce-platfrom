// THE MONOTONIC-PROGRESS DEFENCE IS WIRED WHERE THE PRODUCTION LOOP RUNS.
//
// `lineageProgressGuard.ts` is pure; these tests pin that run-agent and the
// worker actually use it (Query B d22d9ee6: slice 4 reset the lineage to 1).
//
// PURE (reads source files only).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const runAgent = await Deno.readTextFile(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
const runner = await Deno.readTextFile(new URL("../../../worker/leadMissionRunner.ts", import.meta.url));
const workerMain = await Deno.readTextFile(new URL("../../../worker/main.ts", import.meta.url));
const code = (src: string) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

Deno.test("every task-result write in run-agent goes through the progress guard", () => {
  const src = code(runAgent);
  const writes = [...src.matchAll(/from\("tasks"\)\s*\.update\(\{\s*(?:\/\/[^\n]*\n\s*)*result:\s*([^\n]{0,40})/g)];
  const multi = [...src.matchAll(/\.from\("tasks"\)\.update\(\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*result:\s*([^\n]{0,40})/g)];
  const all = [...writes, ...multi].map((m) => m[1].trim());
  assert(all.length >= 6, `found ${all.length} result writes`);
  for (const w of all) assert(w.startsWith("guardResult("), `unguarded result write: ${w}`);
  assertEquals((src.match(/guardResult\("/g) ?? []).length, 9, "nine write paths, each named");
});

Deno.test("the slice folds from the maximum of the task copy, the lineage copy and the queue count", () => {
  assert(runAgent.includes("resolveLineageProgress({"));
  assert(/lineageState:\s*leaseState/.test(runAgent), "the lineage's durable copy is consulted");
  assert(/queueContinuations:\s*inProcess\.queueContinuations/.test(runAgent), "the queue floor is consulted");
  assert(/\[LINEAGE_PROGRESS_KEY\]:\s*progress,\s*\n\s*\}\);/.test(runAgent), "the lineage state carries the progress at release");
});

Deno.test("the worker reads the queue's continuation count and hands it to run-agent", () => {
  assert(/select\("continuations"\)/.test(workerMain));
  assert(/queueContinuations:\s*mission\.continuations/.test(runner));
});
