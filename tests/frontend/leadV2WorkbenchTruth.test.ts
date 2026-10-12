// LEAD V2 RUN 4250f181 — THE WORKBENCH SAID "10 REVIEWED / 8 RULED OUT".
//
// The truth: 33 discovered across five attempts, 20 triaged out, 8 still
// waiting on identity resolution, none verified, none qualified — and not one
// company ruled out on fit. Eight identity_unresolved rows carried a note from
// the free prequalification pass (`insufficient_commercial`, `technical_only`),
// and that note alone sent them to "Ruled out".
//
// PURE.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bucketFor } from "../../src/lib/workbench/leadTabs.ts";
import {
  funnelCaption, workbenchFunnelCounts, type EvaluationRow,
} from "../../src/lib/workbench/evaluationRows.ts";
import { buildContinuationView } from "../../src/lib/qualifiedLead/continuation.ts";

function row(name: string, status: string, exclusion: string | null, shortlist: string | null,
  triage: "relevant" | "uncertain" | "irrelevant" | null = null): EvaluationRow {
  return {
    company_key: name.toLowerCase(), company_name: name, domain: null, employee_count: null,
    strongest_signal: null, signal_tier: null, supporting_job_title: null, supporting_job_url: null,
    prequalification_score: 0, status: status as EvaluationRow["status"], explanation: "", reasons: [],
    exclusion, decided: false, decision_source: "not_evaluated", resumable: false,
    triage_relevance: triage, triage_signal_strength: null, triage_reasons: [],
    shortlist_exclusion: shortlist, shortlist_exclusion_explanation: null,
    enrichment_state: "not_attempted", enrichment_explanation: "", mission_decision: null,
    mission_match_score: null, mission_reasoning: null, mission_failed_requirements: [],
  };
}

/** The final task's ten evaluation rows, verbatim in status and exclusion. */
const AUDITED = [
  row("Fuse AI", "identity_unresolved", null, null),
  row("Pasito", "identity_unresolved", null, null),
  row("Every", "identity_unresolved", "insufficient_commercial", null),
  row("FurtherAI", "identity_unresolved", "technical_only", null),
  row("Gojiberry AI", "identity_unresolved", "insufficient_commercial", null),
  row("Lab0", "identity_unresolved", "insufficient_commercial", null),
  row("Nango", "identity_unresolved", "technical_only", null),
  row("SafetyKit", "identity_unresolved", "technical_only", null),
  row("PropelAuth", "not_investigated", "technical_only", "triage_irrelevant", "irrelevant"),
  row("Poly", "not_investigated", "technical_only", "triage_irrelevant", "irrelevant"),
];

Deno.test("identity-unresolved companies are in review, never ruled out", () => {
  for (const r of AUDITED.slice(0, 8)) assertEquals(bucketFor(r as never), "in_review", r.company_name);
  for (const s of ["shortlisted", "verifying", "held_for_evidence"]) {
    assertEquals(bucketFor(row("X", s, "insufficient_commercial", null) as never), "in_review", s);
  }
});

Deno.test("a stated rejection and a triage exclusion still read as ruled out", () => {
  assertEquals(bucketFor(AUDITED[8] as never), "rejected");
  assertEquals(bucketFor(row("X", "not_qualified", null, null) as never), "rejected");
  // A company the free pass stopped — never investigated — is ruled out by that pass.
  assertEquals(bucketFor(row("X", "evaluated", "employee_size", null) as never), "rejected");
});

Deno.test("the audited slice's truthful counts", () => {
  const c = workbenchFunnelCounts(AUDITED, 0);
  assertEquals(c, {
    discovered: 10, triaged_out: 2, investigating: 0, identity_unresolved: 8, verified: 0, qualified: 0,
  });
  assertEquals(funnelCaption(c),
    "10 discovered · 2 triaged out · 0 investigating · 8 identity unresolved · 0 verified · 0 qualified");
});

Deno.test("counts aggregate every attempt the projection carries", () => {
  // The lineage's 33: the ten above plus 23 earlier-attempt companies, 18 of
  // them triaged out and five stopped at identity.
  const earlier = [
    ...Array.from({ length: 18 }, (_, i) =>
      row(`T${i}`, "not_investigated", null, "triage_irrelevant", "irrelevant")),
    ...Array.from({ length: 5 }, (_, i) => row(`I${i}`, "identity_unresolved", null, null)),
  ];
  const c = workbenchFunnelCounts([...AUDITED, ...earlier], 0);
  assertEquals(c.discovered, 33);
  assertEquals(c.triaged_out, 20);
  assertEquals(c.identity_unresolved, 13);
  // Qualified companies leave the evaluation rows; they are added back.
  assertEquals(workbenchFunnelCounts([...AUDITED, ...earlier], 2).discovered, 35);
});

Deno.test("the Workbench hero renders the six counts", () => {
  const view = Deno.readTextFileSync(new URL(
    "../../src/components/chat/workspace/workbench/LeadResultsView.tsx", import.meta.url));
  // Since Query B d22d9ee6 the funnel counts qualified COMPANIES (a company with
  // no contact yet is still qualified) — qualifiedCompanyVsContact.test.ts.
  assert(view.includes("workbenchFunnelCounts(evaluationRows, Math.max(partition.qualified.length, summary.qualifiedCompanies.value))"));
  const hero = Deno.readTextFileSync(new URL(
    "../../src/components/chat/workspace/workbench/RunSummaryHero.tsx", import.meta.url));
  assert(hero.includes("{funnelCaption(funnel)}"));
});

Deno.test("requested and executed quota are both shown, neither replaces the other", () => {
  const v = buildContinuationView({
    terminal_status: "failed", requested_leads: 1, eligible_leads: 0, remaining_leads: 1,
    mission_requested_leads: 3, quota_source: "v2_canary",
  });
  assert(v.lines.includes("0 of 1 CONTACT-ready lead"));
  assert(v.lines.includes("Test run: working toward 1 of the 3 leads you asked for"));
  const same = buildContinuationView({
    terminal_status: "completed", requested_leads: 3, eligible_leads: 3, mission_requested_leads: 3,
  });
  assertEquals(same.lines.some((l) => l.includes("you asked for")), false);
});
