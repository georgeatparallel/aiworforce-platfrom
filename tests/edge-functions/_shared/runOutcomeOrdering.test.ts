// THE LINEAGE MUST HOLD THE SAME OUTCOME THE TASK DOES.
//
// ── WHAT PRODUCTION SHOWED, 2026-08-30 ─────────────────────────────────────
//
//   tasks.result.run_outcome                    correct, every generation
//   lead_lineages.current_state.run_outcome      null,   every generation
//
// The lease release copied `committedResult[RUN_OUTCOME_RESULT_KEY]` from a row
// snapshot read BEFORE the outcome was written — the write happened later, in
// the panel block. So the authority a continuation reads never had the record,
// and Phase 6's "one authoritative outcome" had two copies, one of them empty.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRunOutcome, readPersistedRunOutcome, RUN_OUTCOME_RESULT_KEY,
  type RunFacts,
} from "../../../supabase/functions/_shared/runOutcome.ts";
import {
  mergeLineageState,
} from "../../../supabase/functions/_shared/lineageStateMerge.ts";

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
  requested: 5,
  spend: { credits_charged: 7, provider_calls: 11, usd_reported: 0.3563,
           unsettled_operations: 1, reused_operations: 2 },
  funnel: { discovered: 50, shortlisted: 21, deferred: 14, identity_resolved: 7,
    enriched: 7, hiring_verified: 3, hiring_refuted: 4,
    hiring_evidence_unavailable: 0, cited_rows: 9, excluded: [] },
  qualification: { eligible: 21, evaluated: 3, qualified: 0, rejected: 3,
                   not_reached: 18, not_reached_reason: null },
  persistence: { leads_written: 0, signals_written: 0 },
  continuation: { required: true, resumable: true, reason: "execution_deadline_checkpoint" },
  completed_capabilities: [], gaps: [],
  ...over,
});

Deno.test("THE OUTCOME SURVIVES INTO THE LINEAGE STATE", () => {
  // Generation 9's real numbers.
  const o = buildRunOutcome(facts());
  const released = mergeLineageState(null, {
    version: "lineage-lease-v1", written_by_task: "752d68e9",
    terminal_status: "continuation_required",
    [RUN_OUTCOME_RESULT_KEY]: o,
  });
  const back = readPersistedRunOutcome(
    JSON.parse(JSON.stringify(released.state as Record<string, unknown>)));
  assert(back !== null, "the lineage copy must not be null — this is the production bug");
  assertEquals(back, o, "and it must equal the task copy field for field");
});

Deno.test("the outcome passes through a MERGE unchanged", () => {
  // The merge rewrites only the checkpoint; every other envelope field is the
  // releasing generation's and must survive verbatim.
  const o = buildRunOutcome(facts());
  const stored = { lead_resume_checkpoint: { version: "lead-resume-state-v1", companies: [
    { company_key: "k", company_name: "C", identity: "resolved", enrichment: "completed",
      hiring: "not_started", brain: "not_started", founder: "not_started",
      linkedin_company_url: null, completed_operations: [], updated_at: "2026-08-30T09:00:00.000Z" },
  ] } };
  const next = { ...stored, written_by_task: "752d68e9", [RUN_OUTCOME_RESULT_KEY]: o };
  const { state } = mergeLineageState(stored, next);
  assertEquals(readPersistedRunOutcome(state as Record<string, unknown>), o);
});

Deno.test("a null outcome still reads as 'nothing recorded', not zeros", () => {
  const { state } = mergeLineageState(null, { [RUN_OUTCOME_RESULT_KEY]: null });
  assertEquals(readPersistedRunOutcome(state as Record<string, unknown>), null);
});

// ── THE ORDERING, PINNED AT SOURCE ─────────────────────────────────────────

const RUN_AGENT = Deno.readTextFileSync(new URL(
  "../../../supabase/functions/run-agent/index.ts", import.meta.url));
const code = RUN_AGENT.split("\n").filter((l) => {
  const t = l.trim();
  return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}).join("\n");

Deno.test("THE OUTCOME IS COMPUTED BEFORE THE LEASE IS RELEASED", () => {
  const built = code.indexOf("const runOutcome = buildRunOutcome({");
  // Since Query B d22d9ee6 the release is retried on a transient failure
  // (`retryTransient(() => releaseLineageLease(...))`); the order is unchanged.
  const released = code.indexOf("() => releaseLineageLease({");
  assert(built > -1 && released > -1, "both sites must exist");
  assert(built < released,
    "computing the outcome after the release is exactly the production bug");
});

Deno.test("the release writes the outcome BY VALUE, not by re-reading the row", () => {
  assert(new RegExp(`\\[RUN_OUTCOME_RESULT_KEY\\]: runOutcome,`).test(code),
    "the in-memory outcome must be handed to the release");
  assert(!new RegExp(`\\[RUN_OUTCOME_RESULT_KEY\\]: committedResult\\[`).test(code),
    "re-reading `committedResult` is the snapshot that predates the write");
});

Deno.test("it is computed exactly ONCE", () => {
  assertEquals(code.split("const runOutcome = buildRunOutcome({").length - 1, 1);
  assertEquals(code.split("const lineageSpend = await readSpendFacts(").length - 1, 1);
});

Deno.test("the panel quotes the persisted record rather than re-reading", () => {
  assert(code.includes("readPersistedRunOutcome(panelResult)?.spend"),
    "two ledger reads a second apart are two answers");
});
