// ONE TRIGGER, ONE GENERATION — WHEN AN ACCEPTANCE RUN ASKS FOR IT.
//
// The 2026-08-30 acceptance run was told to execute exactly one generation. One
// deliberate trigger produced generation 8, which self-dispatched generation 9
// unattended. That is correct product behaviour — "the request continues itself"
// — but it left no way to observe a single slice, and the run had to be stopped
// by marking the live task terminal after the fact.
//
// The flag DEFAULTS OFF and is honoured only for a verified service-role caller,
// because switching off the mechanism that makes a request finish itself is not
// something a browser may ask for.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RUN_AGENT = Deno.readTextFileSync(new URL(
  "../../../supabase/functions/run-agent/index.ts", import.meta.url));
const code = RUN_AGENT.split("\n").filter((l) => {
  const t = l.trim();
  return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}).join("\n");

Deno.test("THE DEFAULT IS UNCHANGED PRODUCTION BEHAVIOUR", () => {
  // Strict `=== true`: absent, null, "false" and 0 all leave the flag off, so no
  // existing caller can trip it by accident.
  assert(/single_generation === true/.test(code),
    "only an explicit boolean true may enable it");
  assert(!/single_generation \?\?|single_generation \|\|/.test(code),
    "no coercion, no default-on path");
});

Deno.test("IT IS REFUSED FOR A NON-SERVICE-ROLE CALLER", () => {
  assert(/const singleGeneration = singleGenerationRequested && bearerIsServiceRole/.test(code),
    "the flag must be gated on the verified bearer, never on the body alone");
  assert(code.includes("single_generation ignored"),
    "and a browser that asks must be told it was ignored, not silently obeyed");
});

Deno.test("it suppresses ONLY the self-dispatch", () => {
  // `!queueOwnsContinuation` (Lead V2): inside the worker the queue re-claims the
  // mission, so the self-dispatch is skipped there too — still ONLY the dispatch.
  // `!sliceSuperseded`: a slice whose verdict was fenced dispatches nothing either
  // (sourceOrder.test.ts) — still only the dispatch is gated by single-generation.
  assert(/if \(autoDecision\.continue && !deferToSweeper && !singleGeneration && !queueOwnsContinuation && !sliceSuperseded\) \{/.test(code),
    "the dispatch is the only thing gated");
  // Everything before it — the checkpoint, the result write, the lease release —
  // must be untouched, or a single-generation run is not the same run.
  const built = code.indexOf("const runOutcome = buildRunOutcome({");
  const gate = code.indexOf("const singleGenerationRequested");
  assert(built < gate, "the outcome is still computed and persisted first");
  const release = code.indexOf("const leaseReleased = await releaseLineageLease({");
  assert(release < gate, "and the lease is still released first");
});

Deno.test("the suppression is logged with what WOULD have happened", () => {
  // A silent stop is indistinguishable from a run that had nothing left to do.
  const block = code.slice(code.indexOf('"[run-agent][auto-continuation] single_generation"'));
  for (const field of ["would_have_continued", "reason"]) {
    assert(block.slice(0, 400).includes(field), `must record ${field}`);
  }
});

Deno.test("the work is PARKED, not finished — this is not a kill switch", () => {
  // This used to assert the log said "the sweeper may still adopt this task",
  // which was true and was the defect: `single_generation` stopped run-agent's
  // own dispatch and nothing else, so the sweeper continued the lineage ~5
  // minutes later anyway. The durable marker closes that, and the property to
  // assert is now that parking does not END the run.
  const block = code.slice(code.indexOf('"[run-agent][auto-continuation] single_generation"'));
  assert(block.slice(0, 500).includes("an explicit Continue still works"),
    "suppressing the dispatch must not pretend the work is finished");
  // The row is never given a terminal status here — that is what the 2026-08-30
  // acceptance run had to do by hand, and it destroys resumability.
  const branch = code.slice(code.indexOf("if (singleGeneration) {"));
  const body = branch.slice(0, branch.indexOf("const deferToSweeper"));
  assert(!/status:\s*"complete"|finished_at/.test(body),
    "parking a run must not terminate its task");
});

Deno.test("normal auto-continuation is otherwise intact", () => {
  assert(code.includes("const deferToSweeper = autoDecision.continue &&"),
    "the existing deferral path is unchanged");
  assert(code.includes("dispatchOutcome = await dispatchContinuation({"),
    "and the dispatch itself still exists");
});
