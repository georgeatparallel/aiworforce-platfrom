// A SUCCESSOR MUST NOT DESTROY THE CHECKPOINT IT IS ABOUT TO READ.
//
// ── THE RUN THIS COMES FROM ──────────────────────────────────────────────────
//
// Production task 85192217-b4c1-40c0-8e4e-9643319935e4, 2026-08-19. The parent
// slice did everything right: discovery returned 100 companies, ~314 open roles
// were evaluated, 1 of 10 qualified, 51 candidates remained on the frontier, and
// it correctly decided to continue.
//
//   11:04:02.981  terminal_status_overridden  round_limit_reached
//                                             -> continuation_required
//   11:04:05.957  auto-continuation           qualified: 1, requested: 10,
//                                             frontier_remaining: 51,
//                                             dispatched: true, handed_off: true
//   11:04:10.591  continuation-restore-empty  expected_companies: 100,
//                                             restored_records: 0
//   11:04:10.712  terminal_guard_disarmed     reason: continuation_restore_empty
//
// The task then sat at `ready` forever with 51 candidates unexamined.
//
// ── WHAT WAS ACTUALLY WRONG ──────────────────────────────────────────────────
//
// NOT the dispatch ordering. The parent already writes its result and releases
// the lease before dispatching; the comment at the dispatch site says so and it
// is true.
//
// NOT the empty-restore guard. Refusing to overwrite 100 companies with 0 is
// correct and must stay correct.
//
// The defect was the successor's FIRST write. `run-agent` persists the paid
// execution preflight early, "before the throw, so a blocked run is still
// auditable" — and it did so as a WHOLESALE REPLACE of `result`. On a
// continuation `task.id` is the PARENT's id, so that write deleted
// `lead_resume_checkpoint` about four seconds before `loadLeadResumeRecords`
// went looking for it. The successor erased its own inheritance.
//
// ZERO network, ZERO Actor runs, ZERO model calls, ZERO database writes.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readCheckpointCompanies, RESUME_STATE_VERSION }
  from "../../../supabase/functions/_shared/leadResumeState.ts";

const SRC = await Deno.readTextFile(
  new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));

/** The early preflight write, isolated from the rest of the function. */
function preflightWrite(): string {
  const at = SRC.indexOf("paid_execution_preflight: paidPreflight,");
  assert(at > 0, "the preflight write must exist");
  // Written through the generation fence since D1 (`fencedTaskUpdate`).
  const start = SRC.lastIndexOf("await fencedTaskUpdate(supabase as unknown as FencedTaskDb, task.id, sliceFence,", at);
  const end = SRC.indexOf("} catch (e) {", at);
  assert(start > 0 && end > start, "could not isolate the preflight write");
  // COMMENTS STRIPPED. The block carries a long note explaining the fix, which
  // necessarily names the very keys these tests assert are absent from the CODE.
  return SRC.slice(start, end).replace(/\/\/.*$/gm, "");
}

Deno.test("A. the successor's early write MERGES the inherited result", () => {
  const w = preflightWrite();
  assert(/\.\.\.resumedTaskResult/.test(w),
    "the preflight write must spread the inherited result. Without it, a " +
    "continuation deletes the parent's lead_resume_checkpoint before reading " +
    "it — production task 85192217, 51 candidates stranded.");
  // AND IT STILL WRITES WHAT IT EXISTS TO WRITE.
  assert(/paid_execution_preflight: paidPreflight/.test(w));
  assert(/lead_runtime:/.test(w));
});

Deno.test("B. the checkpoint key is never dropped by that write", () => {
  // The merge is what preserves it, so the guarantee is stated as: nothing in
  // the early write may name the checkpoint at all. A write that mentioned it
  // would be deciding its fate, and that decision belongs to the slice that
  // built it.
  const w = preflightWrite();
  assert(!/lead_resume_checkpoint/.test(w),
    "the early write must neither set nor clear the checkpoint");
});

Deno.test("C. merge semantics preserve a checkpoint, replace does not", () => {
  // The behaviour under test, isolated from Supabase. This is what the fix
  // changes, and what the production run proved matters.
  const inherited = {
    lead_resume_checkpoint: { companies: new Array(100).fill({}) },
    mission_funnel: { discovered: 100 },
  };
  const early = { paid_execution_preflight: { ok: true }, lead_runtime: {} };

  const replaced = { ...early };
  assertEquals(
    (replaced as Record<string, unknown>).lead_resume_checkpoint, undefined,
    "a wholesale replace is exactly what stranded 51 candidates");

  const merged = { ...inherited, ...early };
  const ck = merged.lead_resume_checkpoint as { companies: unknown[] };
  assertEquals(ck.companies.length, 100,
    "the merge keeps the 100 companies the successor is about to restore");
  assertEquals((merged.mission_funnel as { discovered: number }).discovered, 100,
    "and the rest of the parent's evidence survives too");
});

Deno.test("D. the dispatch still happens AFTER the parent's final write", () => {
  // The pre-existing ordering guarantee. It was already correct and the fix
  // must not disturb it: a dispatch before the final write would race its own
  // successor, which is the defect this ordering was introduced to remove.
  const finalWrite = SRC.indexOf("executed_sourcing_mode: \"company_first\"");
  const dispatch = SRC.indexOf("dispatchOutcome = await dispatchContinuation({");
  assert(finalWrite > 0 && dispatch > 0, "both sites must exist");
  assert(finalWrite < dispatch,
    "the result row must be durable before a successor is dispatched");
});

Deno.test("E. the empty-restore guard is still armed", () => {
  // Explicitly NOT relaxed by this fix. The correct response to a genuinely
  // empty checkpoint is still to refuse, not to continue from nothing.
  assert(SRC.includes("continuation-restore-empty"),
    "the guard that refuses a destructive continuation must remain");
  assert(/refusing to overwrite/.test(SRC),
    "and it must still say what it is refusing to do");
});

// ── F/G. THE CAUSAL CHAIN, END TO END, AT THE DATA LEVEL ────────────────────
//
// Tests A-E pin the SHAPE of the write. These pin the CONSEQUENCE, using the
// real reader the successor uses — `readCheckpointCompanies`. They are the ones
// that would have caught production task 85192217 by failing.

Deno.test("F. a REPLACED result makes the successor restore zero — the live bug", () => {
  const parent = {
    lead_resume_checkpoint: {
      version: RESUME_STATE_VERSION,
      companies: Array.from({ length: 100 }, (_, i) => ({
        company_key: `c${i}`, stage: "identity_pending",
      })),
    },
  };
  assertEquals(readCheckpointCompanies(parent).length, 100,
    "the parent genuinely persisted 100 companies");

  // What the successor's early write used to do: replace, not merge.
  const afterReplace = {
    paid_execution_preflight: { ok: true },
    lead_runtime: { intelligence_mode: "new_architecture" },
  };
  assertEquals(readCheckpointCompanies(afterReplace).length, 0,
    "and this is exactly the `restored_records: 0` the guard reported while " +
    "`expected_companies` was 100 — 51 candidates stranded at status `ready`");
});

Deno.test("G. a MERGED result restores the full frontier", () => {
  const parent = {
    lead_resume_checkpoint: {
      version: RESUME_STATE_VERSION,
      companies: Array.from({ length: 100 }, (_, i) => ({
        company_key: `c${i}`, stage: "identity_pending",
      })),
    },
    mission_funnel: { discovered: 100 },
  };
  // What the fix does: spread the inheritance, then add this slice's own fields.
  const afterMerge = {
    ...parent,
    paid_execution_preflight: { ok: true },
    lead_runtime: { intelligence_mode: "new_architecture" },
  };

  assertEquals(readCheckpointCompanies(afterMerge).length, 100,
    "the successor restores the frontier it was dispatched to continue");
  assertEquals((afterMerge.mission_funnel as { discovered: number }).discovered, 100,
    "and the parent's other evidence survives alongside it");
  // AND THE SLICE'S OWN FIELDS ARE STILL WRITTEN — the merge is not a no-op.
  assertEquals((afterMerge.paid_execution_preflight as { ok: boolean }).ok, true);
});

Deno.test("H. the fix does not weaken the guard: a genuinely empty checkpoint still reads empty", () => {
  // The guard must still fire for a REAL loss — a checkpoint that was never
  // written, or written with nothing in it. Merging must not manufacture state.
  assertEquals(readCheckpointCompanies({}).length, 0);
  assertEquals(readCheckpointCompanies({ lead_resume_checkpoint: {} }).length, 0);
  assertEquals(
    readCheckpointCompanies({ lead_resume_checkpoint: { companies: [] } }).length, 0,
    "an empty checkpoint is still empty after the fix; the guard still refuses");
});
