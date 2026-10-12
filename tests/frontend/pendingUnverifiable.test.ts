// A PENDING COMPANY NOTHING IS CHECKING ANY MORE IS NOT "STILL BEING CHECKED".
//
// Query B a9a6791a (2026-10-12) ended search_exhausted with four companies
// pending — every route that could prove their hiring had already answered —
// and the Workbench said "4 still being checked". The backend view now marks
// each pending lead `verifying` or `unverifiable` (and counts the latter); the
// Workbench says which. Still pending, still in review — never "not a fit".
//
// PURE.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readMissionView } from "../../src/lib/workbench/missionView.ts";
import { canonicalEvaluationRows } from "../../src/lib/workbench/evaluationRows.ts";
import { readWorkbenchProgress } from "../../src/lib/workbench/workbenchProgress.ts";
import { buildRunSummary, summaryCanonicalInput, summaryCaption } from "../../src/lib/workbench/runSummary.ts";

const lead = (key: string, bucket: string, pending_state: string | null) => ({
  company: { key, name: key, domain: null, linkedin_url: null },
  label: bucket === "exact_match" ? "EXACT MATCH" : null, bucket, found_by: [], hard_checks: {},
  hard_check_details: [{ criterion_id: "hard_hiring", dimension: "hiring", result: "unknown", reason: "no open sales role proven", provenance: null }],
  why_surfaced: [], key_evidence: [], missing_evidence: ["hiring"], caveats: [], evidence_coverage: 0.4,
  evidence_gaps: [], ...(pending_state === undefined ? {} : { pending_state }),
});

const result = (inProgress: boolean) => ({
  workbench_mission_view: {
    version: "workbench-mission-view-v1", stage: inProgress ? "retrieving" : "complete",
    counts: { discovered: 22, screened_out: 16, investigating: 0, identity_unresolved: 0, pending: 5,
      exact_match: 1, strong_opportunity: 0, worth_considering: 0, low_priority: 0, ineligible: 0 },
    pending_unverifiable: 4,
    leads: [
      lead("perfect-venue", "exact_match", null),
      lead("acme", "pending", "verifying"),
      lead("shift-group", "pending", "unverifiable"), lead("sonicjobs", "pending", "unverifiable"),
      lead("remotehunter", "pending", "unverifiable"), lead("talenthop", "pending", "unverifiable"),
    ],
  },
});

const caption = (inProgress: boolean) => {
  const progress = readWorkbenchProgress(result(inProgress));
  const s = buildRunSummary({
    qualifiedLeads: 1, leadsInReview: 5, quota: null, portfolio: null, progress,
    rows: { total: 6, qualified: 1, pending: 5 },
    canonical: summaryCanonicalInput(progress, { canonical: true, inReview: 5 }),
  } as never);
  return summaryCaption(s);
};

Deno.test("the reader keeps each pending lead's state and the unverifiable count", () => {
  const v = readMissionView(result(false))!;
  assertEquals(v.pending_unverifiable, 4);
  assertEquals(v.leads.map((l) => l.pending_state), [null, "verifying", "unverifiable", "unverifiable", "unverifiable", "unverifiable"]);
});

Deno.test("the caption separates 'still being checked' from 'could not be verified'", () => {
  const c = caption(false);
  assert(c.includes("1 still being checked"), c);
  assert(c.includes("4 could not be verified"), c);
  assertFalse(c.includes("5 still being checked"), c);
});

Deno.test("an unverifiable company is still in review — explained, never ruled out", () => {
  const rows = canonicalEvaluationRows(readMissionView(result(false))!);
  const shift = rows.find((r) => r.company_key === "shift-group")!;
  assertEquals([shift.status, shift.decided], ["held_for_evidence", false]);
  assert(/could not be verified/i.test(shift.explanation), shift.explanation);
  const acme = rows.find((r) => r.company_key === "acme")!;
  assert(/^Needs verification/.test(acme.explanation), acme.explanation);
});

Deno.test("a view written before the field existed reads exactly as before", () => {
  const old = structuredClone(result(false)) as { workbench_mission_view: Record<string, unknown> & { leads: Array<Record<string, unknown>> } };
  delete old.workbench_mission_view.pending_unverifiable;
  for (const l of old.workbench_mission_view.leads) delete l.pending_state;
  const v = readMissionView(old)!;
  assertEquals(v.pending_unverifiable, 0);
  const progress = readWorkbenchProgress(old);
  const s = buildRunSummary({
    qualifiedLeads: 1, leadsInReview: 5, quota: null, portfolio: null, progress,
    rows: { total: 6, qualified: 1, pending: 5 },
    canonical: summaryCanonicalInput(progress, { canonical: true, inReview: 5 }),
  } as never);
  assert(summaryCaption(s).includes("5 still being checked"));
});
