// A TASK RESULT IS ACCUMULATED, NEVER REPLACED.
//
// ── THE SAME BUG, TWICE, IN ONE FILE ───────────────────────────────────────
//
// `tasks.result` is written by a dozen places in one invocation — the paid
// preflight, stage progress, the capability execution state, the resume
// checkpoint, the evaluation rows, the terminal record. Each is a PART. A
// writer that assigns a fresh object literal deletes everyone else's.
//
//   Run 85192217, 2026-08-19: a continuation's first write replaced the
//   parent's row, destroying `lead_resume_checkpoint` four seconds before the
//   code tried to read it back. Fixed at that ONE site.
//
//   Task ca3d047d, 2026-08-29: the engine discovered 30 companies, resolved 5
//   identities and reached the Company Brain. A second invocation started one
//   second before it finished, took the generic agent path, and its tail wrote
//   `result: { output, tokens_in, tokens_out }` — erasing
//   `capability_execution_state`, `workbench_evaluation_rows`,
//   `mission_funnel`, `lead_resume_checkpoint` and `lead_mission`, including
//   the record of what that continuation had decided. The loss destroyed its
//   own explanation.
//
// The first fix repaired an instance. Five other sites still assigned a bare
// literal. The last test in this file is the one that was missing: it fails on
// the SHAPE, so the sixth site cannot be written.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mergeTaskResult, writeTaskResult, type TaskResultDb,
} from "../../../supabase/functions/_shared/taskResultMerge.ts";

/** A tasks table that records what it was asked to write. */
function fakeDb(current: unknown, opts: { readFails?: boolean } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve(opts.readFails
              ? { data: null, error: "connection lost" }
              : { data: { result: current }, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => { writes.push(patch); return Promise.resolve({ error: null }); },
      }),
    }),
  } as unknown as TaskResultDb;
  return { db, writes };
}

/** The keys task ca3d047d lost. */
const ENGINE_RESULT = {
  capability_execution_state: { company_keys: ["a", "b"], mission_hash: "2cd1ff07" },
  workbench_evaluation_rows: [{ company_name: "Pursuit" }],
  mission_funnel: { stages: [] },
  lead_resume_checkpoint: { companies: [] },
  lead_mission: { version: "lead-mission-v1" },
};

Deno.test("1. a contribution is added to the record, not swapped for it", async () => {
  const m = await mergeTaskResult(fakeDb(ENGINE_RESULT).db, "t1",
    { output: "done", tokens_in: 10 });
  assert(m.ok);
  for (const key of Object.keys(ENGINE_RESULT)) {
    assert(key in m.result, `${key} must survive the write that ended the task`);
  }
  assertEquals(m.result.output, "done");
});

Deno.test("2. the newer value wins on a key both sides hold", async () => {
  const m = await mergeTaskResult(fakeDb({ task_status: "partial", keep: 1 }).db, "t1",
    { task_status: "completed" });
  assert(m.ok);
  assertEquals(m.result.task_status, "completed");
  assertEquals(m.result.keep, 1);
});

Deno.test("3. a caller holding the row under a claim does not read again", async () => {
  // The continuation path reads the parent's result once under its lease; a
  // second read could race the parent's final write.
  const { db, writes } = fakeDb({ should_not_be_read: true });
  const m = await mergeTaskResult(db, "t1", { added: 1 }, { from_claim: true });
  assert(m.ok);
  assertEquals(m.result, { from_claim: true, added: 1 });
  assertEquals(writes.length, 0);
});

Deno.test("4. a failed read writes the status and NEVER a partial result", async () => {
  // The safe direction: if the merge cannot be performed, a status-only write
  // loses nothing. Writing the patch alone would be the original bug.
  const { db, writes } = fakeDb(ENGINE_RESULT, { readFails: true });
  await writeTaskResult(db, "t1", { output: "done" }, { status: "complete" });
  assertEquals(writes.length, 1);
  assertEquals(writes[0], { status: "complete" });
  assertEquals("result" in writes[0], false, "no result may be written blind");
});

Deno.test("5. an empty prior result behaves exactly as a plain write", async () => {
  const m = await mergeTaskResult(fakeDb(null).db, "t1", { output: "done" });
  assert(m.ok);
  assertEquals(m.result, { output: "done" });
});

Deno.test("6. writeTaskResult carries the status fields alongside the merge", async () => {
  const { db, writes } = fakeDb(ENGINE_RESULT);
  await writeTaskResult(db, "t1", { error: "boom" },
    { status: "failed", error_message: "boom" });
  assertEquals(writes.length, 1);
  assertEquals(writes[0].status, "failed");
  assertEquals(writes[0].error_message, "boom");
  const result = writes[0].result as Record<string, unknown>;
  assert("lead_mission" in result, "and still merges");
});

// ══ THE GUARD THAT WAS MISSING THE FIRST TIME ══════════════════════════════

Deno.test("7. no writer in run-agent may replace tasks.result wholesale", async () => {
  // This is the test that would have caught the second occurrence. It fails on
  // the SHAPE — an `update({ … result: { … } })` on `tasks` whose result object
  // does not begin by spreading what is already there.
  const src = await Deno.readTextFile(new URL(
    "../../../supabase/functions/run-agent/index.ts", import.meta.url));

  const offenders: string[] = [];
  const re = /from\("tasks"\)\s*\.update\(\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // Walk the update object to its matching brace.
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    // COMMENTS ARE NOT CODE. The site fixed in 2026-08 carries a comment
    // quoting the old `result: { … }` shape, and matching that would report the
    // history of the fix as the fix being absent.
    const body = src.slice(m.index, i + 1)
      .split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
    const at = body.indexOf("result:");
    if (at < 0) continue;                     // status-only writes are fine
    const after = body.slice(at + "result:".length, at + 120);
    // Merged forms: `{ ...prior`, `{\n ...x`, or a variable (`result: cf`).
    if (/^\s*\{\s*(\/\/[^\n]*\n\s*)*\.\.\./.test(after)) continue;
    // The lineage-progress guard (Query B d22d9ee6) wraps the same merge:
    // `guardResult("path", prior, { ...prior, … })` — its object must still
    // begin with a spread.
    if (/^\s*guardResult\("[^"]+",[\s\S]*?,\s*\{\s*(\/\/[^\n]*\n\s*)*\.\.\./.test(body.slice(at + "result:".length))) continue;
    if (/^\s*[A-Za-z_$][\w$]*\s*[,}]/.test(after)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`line ${line}: ${after.replace(/\s+/g, " ").slice(0, 70)}`);
  }

  assertEquals(offenders, [],
    "every tasks.result write must merge — use writeTaskResult from taskResultMerge.ts");
});
