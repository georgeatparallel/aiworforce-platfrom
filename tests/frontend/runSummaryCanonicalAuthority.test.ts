// THE CANONICAL MISSION VIEW IS THE AUTHORITY FOR THE RUN SUMMARY WHENEVER IT EXISTS.
//
// Production Salvo, plan ce80738e / task 8455db21 (2026-09-26): one known
// company, funding verified, qualified, one Lead Library row, run_outcome
// canonical qualified = 1, SATISFIED — and the Workbench footer said "counts
// disagree". The summary chose its path by asking whether any EVALUATION ROW
// carried a canonical decision; a company that qualifies is a lead row, so a
// run whose every company qualified has none, and the summary fell back to
// reconciling the stored `workbench_portfolio` (written by the engine BEFORE
// the funding verifier ran: qualified 0) against the lead.
//
// The values below are the production task's stored fields, verbatim where
// the summary reads them.
//
// Pure. No React, no network.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRunSummary, summaryCanonicalInput } from "../../src/lib/workbench/runSummary.ts";
import { readWorkbenchProgress } from "../../src/lib/workbench/workbenchProgress.ts";
import { readPortfolio } from "../../src/lib/workbench/portfolioView.ts";
import { readEvaluationRows } from "../../src/lib/workbench/evaluationRows.ts";
import { resultTabCounts } from "../../src/lib/workbench/leadTabs.ts";

const lead = {
  label: "low_priority", bucket: "low_priority", caveats: [], found_by: [], next_action: null,
  company: { key: "https://www.linkedin.com/company/salvosoftware", name: "Salvo Software", domain: "salvosoftware.com", linkedin_url: "https://www.linkedin.com/company/salvosoftware" },
  hard_checks: { funding: "pass", company_size: "pass", known_companies: "pass" },
  key_evidence: [], why_surfaced: [], evidence_gaps: [], signal_strength: 0, missing_evidence: [], evidence_coverage: 0.6, hard_check_details: [],
};
const counts = (o: Record<string, number>) => ({
  discovered: 0, screened_out: 0, investigating: 0, identity_unresolved: 0, pending: 0, ineligible: 0,
  exact_match: 0, strong_opportunity: 0, worth_considering: 0, low_priority: 0, ...o,
});
/** Salvo's stored task result: stale legacy projections beside the canonical view. */
const SALVO = {
  task_status: "completed", terminal_status: "completed", quota: null,
  workbench_progress: {
    stage: "qualified", evaluated: 0, in_progress: false, shortlisted: 1, accounts_found: 1, qualified_companies: 0,
    identity_resolved: 1, companies_enriched: 1, identity_unresolved: 0, hiring_verified: 0, open_jobs_evaluated: 0,
    awaiting_external_run: false, eligible_opportunities: 0, decision_makers_verified: 0, exclusion_reasons: {},
  },
  workbench_evaluation_rows: [{ status: "verifying", company_key: lead.company.key, company_name: "Salvo Software", decided: false, counts_as_qualified: false }],
  workbench_portfolio: {
    version: "opportunity-portfolio-v1", entries: [],
    counts: { watch: 0, review: 0, tier_a: 0, tier_b: 0, tier_c: 0, delivered: 0, qualified: 0, contact_ready: 0, opportunities: 0, rejected_by_floor: 0 },
    targets: { interpretation: "legacy_lead_count", requested_lead_count: 1, requested_opportunity_count: 1, requested_contact_ready_count: null },
    shortfall: { contact_ready: 0, opportunities: 1, opportunity_reason: "0 of 1 companies qualified or are under review", contact_ready_reason: null },
  },
  workbench_mission_view: {
    version: "workbench-mission-view-v1", stage: "complete", leads: [lead], routes: [],
    counts: counts({ discovered: 1, low_priority: 1 }),
    mission: { criteria: [], unsupported: [], execution_limit: 1, requested_count: 1 },
  },
};

/** Exactly what LeadResultsView feeds `buildRunSummary`, for a run with `qualifiedLeads` lead rows. */
function footer(result: Record<string, unknown>, qualifiedLeads: number, inReview = 0) {
  const progress = readWorkbenchProgress(result);
  const tab = resultTabCounts({ qualifiedLeads, inReviewLeads: inReview, evaluationRows: readEvaluationRows(result) as never });
  const input = {
    qualifiedLeads, leadsInReview: inReview,
    quota: { requested: 1, qualifiedCompanies: qualifiedLeads } as never, // the run contract, from the lead rows
    portfolio: readPortfolio(result), progress,
    rows: { total: qualifiedLeads + inReview, qualified: 0, pending: 0 },
  };
  return { tab, summary: buildRunSummary({ ...input, canonical: summaryCanonicalInput(progress, tab) }), input };
}

Deno.test("SALVO: the shape that fooled the old rule — no canonical evaluation row, a stale portfolio", () => {
  const { tab, input } = footer(SALVO, 1);
  assertEquals(tab.canonical, false, "every company qualified, so no evaluation row carries `canonical`");
  assertEquals(input.portfolio?.counts.qualified, 0, "the portfolio was written before the funding verifier");
  // The old decision (evaluation rows only) and what it produced:
  const old = buildRunSummary({ ...input, canonical: tab.canonical && input.progress ? {} as never : null });
  assertEquals(old.hasDisagreement, true, "production: 'counts disagree'");
});

Deno.test("SALVO: the canonical view is authoritative — no disagreement, one qualified company", () => {
  const { summary } = footer(SALVO, 1);
  assertEquals(summary.hasDisagreement, false);
  assertEquals([summary.qualifiedCompanies.value, summary.qualifiedCompanies.source], [1, "canonical"]);
  assertEquals([summary.reviewed.value, summary.pending.value, summary.notAFit.value], [1, 0, 0]);
  assertEquals(summary.qualifiedCompanies.disagreements, [], "the stale portfolio is never consulted");
  assertEquals(summary.shortfall, 0, "1 requested, 1 qualified lead");
});

Deno.test("progress carries the canonical counts exactly when a mission view exists", () => {
  assertEquals(readWorkbenchProgress(SALVO)?.canonical, { qualified_companies: 1, reviewed: 1, pending: 0, unverifiable: 0 });
  const { workbench_mission_view: _v, ...legacy } = SALVO;
  assertEquals(readWorkbenchProgress(legacy)?.canonical, undefined);
});

Deno.test("canonical pending and ineligible companies are counted from the view", () => {
  const r = { ...SALVO, workbench_mission_view: { ...SALVO.workbench_mission_view,
    counts: counts({ discovered: 4, low_priority: 1, pending: 2, ineligible: 1 }) } };
  const { summary } = footer(r, 1, 0);
  assertEquals([summary.qualifiedCompanies.value, summary.reviewed.value, summary.pending.value, summary.notAFit.value], [1, 4, 2, 1]);
  assertEquals(summary.hasDisagreement, false);
});

Deno.test("a LEGACY run (no mission view) still reconciles its projections and still reports real dissent", () => {
  const { workbench_mission_view: _v, ...legacy } = SALVO;
  const { summary } = footer(legacy, 1);
  assert(summary.hasDisagreement, "without a canonical view, disagreeing projections are still shown");
  assertEquals(summary.qualifiedCompanies.source, "engine_quota");
});
