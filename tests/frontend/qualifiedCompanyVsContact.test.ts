// A QUALIFIED COMPANY IS NEVER REPORTED AS "0 QUALIFIED" BECAUSE IT HAS NO CONTACT.
//
// Query B d22d9ee6 (2026-10-12): the backend held one qualified company,
// Continuum AI, with no contact yet. The Workbench read "46 discovered · 43
// triaged out · … · 3 verified · 0 qualified" and "3 short of the 3 you asked
// for" — the funnel was handed the count of CONTACT-READY lead rows, and the
// shortfall was measured in them. Company qualification and contact readiness
// are separate facts: the funnel counts qualified companies, the caption says
// which still need a contact, and a qualified company counts toward the
// request. The headline keeps its existing precedence ("N leads in review"),
// which never claims a number of qualified companies.
//
// PURE.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRunSummary, summaryCaption, summaryHeadline } from "../../src/lib/workbench/runSummary.ts";
import { funnelCaption, workbenchFunnelCounts } from "../../src/lib/workbench/evaluationRows.ts";

const canonical = (bucket: string) => ({ canonical: { bucket, hard_check_details: [], missing_evidence: [], caveats: [] } });
const rows = [
  ...Array.from({ length: 43 }, () => canonical("screened_out")),
  ...Array.from({ length: 3 }, () => canonical("pending")),
] as never[];

const summary = (o: { leads: number; companies: number; pending: number; unverifiable: number; inProgress?: boolean }) => buildRunSummary({
  qualifiedLeads: o.leads, leadsInReview: o.pending, quota: { requested: 3 } as never, portfolio: null,
  progress: { in_progress: o.inProgress === true, qualified_companies: o.companies, evaluated: 47 } as never,
  rows: { total: o.pending + o.leads, qualified: o.leads, pending: o.pending },
  canonical: { qualifiedCompanies: o.companies, reviewed: 47, pending: o.pending, unverifiable: o.unverifiable },
} as never);

Deno.test("a qualified company with no contact: the funnel and caption say 1 qualified, the shortfall counts it", () => {
  const s = summary({ leads: 0, companies: 1, pending: 3, unverifiable: 3 });
  const funnel = funnelCaption(workbenchFunnelCounts(rows, Math.max(s.qualified.value, s.qualifiedCompanies.value)));
  assert(funnel.includes("1 qualified"), funnel);
  assert(funnel.startsWith("47 discovered"), `the qualified company is part of what was discovered: ${funnel}`);
  assertFalse(/\b0 qualified\b/.test(funnel));
  assert(summaryCaption(s).includes("1 company qualified · needs a contact"), summaryCaption(s));
  assertEquals(s.shortfall, 2, "1 of the 3 requested companies qualified");
  assertFalse(/\b0 (companies )?qualified\b/.test(`${summaryHeadline(s)} ${summaryCaption(s)}`));
});

Deno.test("a qualified company with a contact is a qualified lead; no 'needs a contact'", () => {
  const s = summary({ leads: 1, companies: 1, pending: 0, unverifiable: 0 });
  assertEquals(summaryHeadline(s), "1 qualified lead");
  assertFalse(summaryCaption(s).includes("needs a contact"));
  assertEquals(s.shortfall, 2);
});

Deno.test("unverifiable companies read 'could not be verified'; actively verifying ones 'still being checked'", () => {
  const unv = summary({ leads: 0, companies: 0, pending: 3, unverifiable: 3 });
  assert(summaryCaption(unv).includes("3 could not be verified"), summaryCaption(unv));
  const act = summary({ leads: 0, companies: 0, pending: 2, unverifiable: 0, inProgress: true });
  assert(summaryCaption(act).includes("2 still being checked"), summaryCaption(act));
});

Deno.test("mixed: 1 contact-ready lead, 2 qualified companies, 1 verifying, 2 unverifiable", () => {
  const s = summary({ leads: 1, companies: 2, pending: 3, unverifiable: 2 });
  const c = summaryCaption(s);
  assertEquals(summaryHeadline(s), "1 qualified lead");
  assert(c.includes("1 company qualified · needs a contact"), c);
  assert(c.includes("1 still being checked") && c.includes("2 could not be verified"), c);
  assertEquals(s.shortfall, 1);
});

Deno.test("the Workbench hands the funnel the qualified-company count, not the contact-ready lead count", async () => {
  const src = await Deno.readTextFile(new URL("../../src/components/chat/workspace/workbench/LeadResultsView.tsx", import.meta.url));
  assert(/workbenchFunnelCounts\(evaluationRows,\s*Math\.max\(partition\.qualified\.length,\s*summary\.qualifiedCompanies\.value\)\)/.test(src));
});
