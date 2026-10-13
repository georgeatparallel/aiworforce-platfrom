// AN EVALUATION THE RUN PAID FOR MUST SURVIVE THE RESUME BUILT TO PRESERVE IT.
//
// ── THE RUN THIS EXISTS FOR ────────────────────────────────────────────────
//
// Lineage 57b937ab evaluated thirty-eight companies and qualified none. Not one
// of them failed a requirement — `mission_failed_requirements: []` on every
// row. Two of the strongest:
//
//   DiligenceVault   67 employees   "clearly offers a B2B software platform"
//   FastSpring      188 employees   "SaaS payments platform, Belfast office"
//
// Both came back `held_for_evidence` with `mission_decision: null`,
// `mission_reasoning: null` and `decision_source: "restored_decision"`.
//
// `brain` was checkpointed. `mission_evaluation` was not — it appeared nowhere
// in `leadResumeState.ts`. So a restored company carried the OUTCOME of an
// evaluation with none of its reasoning, and:
//
//   * `buildLeadVerdict` reads `mission_evaluation.icp_fit` → null
//   * `icpVerdictFrom(null, …)` → "insufficient_evidence"
//   * `qualificationDecision` → "ICP fit could not be established"
//
// and because `brain` DID survive, `restoredBrainKeys` short-circuited the
// evaluator before it could run again. Evaluated once, judgement discarded,
// never re-judged, unqualifiable for ever.
//
// ZERO network, ZERO DB, ZERO provider spend.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCheckpoint, CHECKPOINT_COMPACT_VERSION, readCheckpointCompanies,
} from "../../supabase/functions/_shared/leadResumeState.ts";
import {
  icpVerdictFrom, qualificationDecision,
} from "../../supabase/functions/_shared/leadQualificationVerdict.ts";

const snapshot = (over: Record<string, unknown> = {}) => ({
  company: { company_name: "DiligenceVault", canonical_domain: "diligencevault.com" },
  yc_open_jobs: [], prequalified: null, prequal_key: null,
  shortlisted: true, investigation_state: "investigated",
  enriched: { company_name: "DiligenceVault" }, enrichment_outcome: "success",
  identity: { linkedin_company_url: "https://www.linkedin.com/company/diligencevault" },
  hiring_assessment: { verdict: "verified" }, hiring_jobs: [],
  brain: { outcome: "REVIEW", reason: "held" },
  mission_evaluation: {
    icp_fit: "strong",
    matched_requirements: [{ requirement: "b2b_saas", evidence_id: "e1" }],
    unknown_fields: [],
  },
  ...over,
});

const record = (over: Record<string, unknown> = {}) => ({
  company_key: "https://www.linkedin.com/company/diligencevault",
  company_name: "DiligenceVault",
  identity: "resolved", enrichment: "completed", hiring: "verified_externally",
  brain: "review", founder: "not_started", completed_operations: [],
  snapshot: snapshot(), ...over,
});

const roundTrip = (rec: Record<string, unknown>) => {
  const cp = buildCheckpoint({
    now: Date.now(), deadlineAt: Date.now() + 1000, remainingMs: 1000,
    lastCompletedCapability: null, nextPendingCapability: null,
    companies: [rec as never], reason: "execution_deadline_checkpoint",
  });
  // The envelope of a compacted checkpoint (snapshot dictionary); the records inside are unchanged.
  assertEquals(cp.version, CHECKPOINT_COMPACT_VERSION);
  return readCheckpointCompanies({ lead_resume_checkpoint: cp })[0];
};

Deno.test("the evaluation survives the checkpoint round trip", () => {
  const back = roundTrip(record());
  assert(back, "the company must come back");
  const snap = back.snapshot as Record<string, unknown>;
  assert(snap.mission_evaluation,
    "written, declared and read — or it never survives a resume");
  assertEquals(
    (snap.mission_evaluation as Record<string, unknown>).icp_fit, "strong",
    "and it must come back with the fit the evaluator actually decided");
});

Deno.test("the brain decision still survives beside it", () => {
  // The pairing is the point: one without the other is what caused this.
  const snap = roundTrip(record()).snapshot as Record<string, unknown>;
  assertEquals((snap.brain as Record<string, unknown>).outcome, "REVIEW");
  assert(snap.mission_evaluation, "both halves, or neither is usable");
});

Deno.test("a checkpoint written before the field existed still restores", () => {
  const legacy = record({ snapshot: snapshot({ mission_evaluation: undefined }) });
  const back = roundTrip(legacy);
  assert(back, "an older checkpoint must not fail to restore");
  assertEquals(
    (back.snapshot as Record<string, unknown>).mission_evaluation, null,
    "absent narrows to null, and the guard treats that as not-yet-decided");
});

// ══ WHY THE PAIR MATTERS ═══════════════════════════════════════════════════

Deno.test("without the evaluation, a decided company is unqualifiable", () => {
  // The exact chain the production rows walked.
  assertEquals(icpVerdictFrom(null, true), "insufficient_evidence");
  const d = qualificationDecision({
    version: "v", icp: "insufficient_evidence", intent: "confirmed", band: "A",
    signals: [], signal_requirement: { outcome: "met", reason: "hiring verified" },
    rationale: "",
  } as never);
  assertEquals(d.decision, "insufficient_evidence");
  assertEquals(d.reason, "ICP fit could not be established");
});

Deno.test("with it, the same company qualifies", () => {
  assertEquals(icpVerdictFrom("strong", true), "strong");
  const d = qualificationDecision({
    version: "v", icp: "strong", intent: "confirmed", band: "A",
    signals: [], signal_requirement: { outcome: "met", reason: "hiring verified" },
    rationale: "ICP strong; intent confirmed",
  } as never);
  assertEquals(d.decision, "qualified");
});

// ══ THE HALF-RESTORED DECISION GUARD ═══════════════════════════════════════

Deno.test("the engine's own predicate requires the evaluation", async () => {
  // ── WHY THIS READS THE SOURCE ───────────────────────────────────────────
  //
  // The three cases below restate the rule; restating it proves the RULE is
  // right and nothing about the code. This asserts the engine actually applies
  // it, so reverting the guard fails here rather than passing quietly.
  const src = await Deno.readTextFile(
    new URL("../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = src.indexOf("const restoredBrainKeys = new Set(");
  assert(i > 0, "the restored-decision set must exist");
  const block = src.slice(i, src.indexOf(".map((c) => c.key))", i))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(block.includes("c.mission_evaluation !== null"),
    "a non-qualified decision must carry its evaluation to be reused");
  assert(block.includes('c.brain.outcome === "QUALIFIED"'),
    "and a QUALIFIED outcome stays exempt — it is already terminal");
});

/** The engine's own predicate for "this decision may be reused as-is". */
const reusable = (c: { brain: { outcome: string } | null; mission_evaluation: unknown }) =>
  c.brain !== null &&
  (c.brain.outcome === "QUALIFIED" || c.mission_evaluation !== null);

Deno.test("a REVIEW without its evaluation is re-evaluated, not reused", () => {
  assertEquals(
    reusable({ brain: { outcome: "REVIEW" }, mission_evaluation: null }), false,
    "reusing it is what made the loss permanent");
});

Deno.test("a complete decision is reused", () => {
  assert(reusable({ brain: { outcome: "REVIEW" }, mission_evaluation: { icp_fit: "weak" } }));
  assert(reusable({ brain: { outcome: "REJECT" }, mission_evaluation: { icp_fit: "poor" } }));
});

Deno.test("a QUALIFIED decision is reused even without the evaluation", () => {
  // Already the terminal answer; re-running the evaluator would buy a model
  // call to change nothing.
  assert(reusable({ brain: { outcome: "QUALIFIED" }, mission_evaluation: null }));
});
