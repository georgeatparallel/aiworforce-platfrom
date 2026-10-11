// A CLEARLY DISJOINT DECLARED BAND IS SETTLED AT DISCOVERY — AND NOTHING WEAKER IS.
//
// Query B (task 255c333f, 2026-10-10): 62 job-search employers, 53 of them
// later rejected on size. Every one carried its LinkedIn identity and its
// company's own declared `employeeCountRange`, and the company-details read
// returned the SAME band for 62/62 (96/96 across both runs). Each was still
// carried through enrichment and grounding to reach a verdict its discovery
// row had already stated, because a discovery row's band is only PLAUSIBLE.
//
// The early rejection is gated narrowly. It fires only when ALL hold:
//   * the band is the provider's own declared field (`field_trust` direct) and
//     a canonical LinkedIn declared band;
//   * the company carries a STRONG LinkedIn identity (direct, canonical URL);
//   * the requested range and the band share no value (`bandSatisfies` fail —
//     the same verdict the post-enrichment hard check reaches on that band);
//   * no identity conflict, no disagreeing or stale size observation.
// Anything else keeps the old path: ranked down, enrichment decides.
//
// Every company comes from a real normalizer, fed the row shape its actor
// returns. PURE.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  prequalifyNormalizedCompany, prequalifyDiscoveredCompanies, discoverySizeRejectBlocker,
  type GenericPrequalificationPolicy,
} from "../../../supabase/functions/_shared/leadGenericPrequalification.ts";
import {
  jobEmployerToCompany, normalizeLinkedInCompanyCandidate, type NormalizedHiringCompany,
} from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";

const range = (start: number, end: number | null) => ({ start, ...(end === null ? {} : { end }) });

/** A harvestapi LinkedIn job-search row: the employer object is the company's own page. */
const jobRow = (slug: string, band: ReturnType<typeof range> | null) => ({
  id: `job-${slug}`, title: "Account Executive",
  company: {
    id: slug, name: `${slug} Inc`, universalName: slug,
    linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
    website: `https://${slug}.com`, description: `${slug} sells software.`,
    employeeCount: 40, ...(band ? { employeeCountRange: band } : {}),
    industries: [{ id: 4, name: "Software Development" }],
    locations: [{ parsed: { text: "Austin, TX, United States" }, country: "US", headquarter: true }],
  },
});
const employer = (slug: string, band: ReturnType<typeof range> | null): NormalizedHiringCompany =>
  jobEmployerToCompany(jobRow(slug, band))!;

const M_11_50 = { min: 11, max: 50 };
const M_51_200 = { min: 51, max: 200 };
const M_40_70 = { min: 40, max: 70 };

const BASIS = "disjoint_declared_band_at_discovery";

// ═══════════════ REJECTED AT DISCOVERY ═════════════════════════════════════

Deno.test("clearly ABOVE: 11-50 requested, declared 1001-5000 — rejected at discovery with a distinct basis", () => {
  const v = prequalifyNormalizedCompany(employer("bigco", range(1001, 5000)), M_11_50);
  assertEquals([v.size_status, v.exclusion, v.eligible], ["above_max", "employee_size", false]);
  assertEquals(v.size_exclusion_basis, BASIS);
  assert(v.reasons.some((r) => /clearly disjoint/.test(r) && /1001-5000/.test(r)), v.reasons.join(" | "));
});

Deno.test("clearly BELOW: 51-200 requested, declared 2-10 — rejected at discovery", () => {
  const v = prequalifyNormalizedCompany(employer("tiny", range(2, 10)), M_51_200);
  assertEquals([v.size_status, v.exclusion, v.eligible, v.size_exclusion_basis],
    ["below_min", "employee_size", false, BASIS]);
});

Deno.test("the company-search route qualifies too: same declared field, same identity strength", () => {
  const row = {
    id: "acme", name: "Acme", linkedinUrl: "https://www.linkedin.com/company/acme",
    website: "https://acme.io", description: "Acme.", employeeCount: 900,
    employeeCountRange: range(501, 1000), industries: [], locations: [],
  };
  const v = prequalifyNormalizedCompany(normalizeLinkedInCompanyCandidate(row), M_11_50);
  assertEquals([v.exclusion, v.size_exclusion_basis], ["employee_size", BASIS]);
});

// ═══════════════ CONTINUES TO ENRICHMENT ═══════════════════════════════════

Deno.test("exact inside: declared 11-50 on 11-50 — in range, not excluded", () => {
  const v = prequalifyNormalizedCompany(employer("fit", range(11, 50)), M_11_50);
  assertEquals([v.size_status, v.exclusion, v.eligible], ["in_range", null, true]);
  assertEquals(v.size_exclusion_basis ?? null, null);
});

Deno.test("partial overlap: 40-70 requested, declared 51-200 — unsettled, continues (semantics unchanged)", () => {
  const v = prequalifyNormalizedCompany(employer("straddle", range(51, 200)), M_40_70);
  assertEquals([v.size_status, v.exclusion, v.eligible], ["size_unverified", null, true]);
  assert(v.reasons.some((r) => /only partly overlaps/.test(r)), v.reasons.join(" | "));
});

Deno.test("unknown band: no declared employeeCountRange — continues", () => {
  const v = prequalifyNormalizedCompany(employer("silent", null), M_11_50);
  assertEquals([v.size_status, v.exclusion, v.eligible], ["size_unverified", null, true]);
});

Deno.test("weak identity: a LinkedIn URL the source only aliased — ranked down, enrichment decides", () => {
  const c = employer("aliased", range(1001, 5000));
  const weak = { ...c, field_trust: { ...c.field_trust, linkedin_company_url: "alias" as const } };
  const v = prequalifyNormalizedCompany(weak, M_11_50);
  assertEquals([v.size_status, v.exclusion, v.eligible], ["above_max", null, true]);
  assert(v.reasons.some((r) => /ranked down, not excluded/.test(r)), v.reasons.join(" | "));
});

Deno.test("weak source: a band the normalizer reshaped, or one LinkedIn never declares — continues", () => {
  const c = employer("reshaped", range(1001, 5000));
  const transformed = { ...c, field_trust: { ...c.field_trust, company_size_band: "transformed" as const } };
  assertEquals(prequalifyNormalizedCompany(transformed, M_11_50).exclusion, null);
  const odd = employer("oddband", range(300, 400));
  assertEquals(prequalifyNormalizedCompany(odd, M_11_50).exclusion, null);
});

Deno.test("identity conflict: the engine's blocker keeps a clearly disjoint company in play", () => {
  const c = employer("conflicted", range(1001, 5000));
  const blocker = discoverySizeRejectBlocker({
    identity_conflicts: [{ kind: "linkedin_url", existing: "https://www.linkedin.com/company/other", incoming: c.linkedin_company_url }],
  });
  assertEquals(blocker, "identity_conflict");
  const policy: GenericPrequalificationPolicy = { early_size_reject_blocker: () => blocker };
  const v = prequalifyNormalizedCompany(c, M_11_50, policy);
  assertEquals([v.exclusion, v.eligible], [null, true]);
  assert(v.reasons.some((r) => /identity_conflict/.test(r)), v.reasons.join(" | "));
});

Deno.test("discovery/detail disagreement: observations that disagree on the band never reject early", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const ev = (min: number, max: number | null, actor: string, valid_until = "2027-01-01T00:00:00Z") => ({
    dimension: "company_size_band", value: { min, max, source: "linkedin_declared" }, valid_until, source: { actor },
  });
  // The job row says 1001-5000; the company record already on file says 11-50.
  const disagree = discoverySizeRejectBlocker({ observations: [
    { evidence: [ev(1001, 5000, "apify_linkedin_job_search")] },
    { evidence: [ev(11, 50, "apify_linkedin_company_details")] },
  ] }, now);
  assertEquals(disagree, "size_band_disagreement");
  const v = prequalifyNormalizedCompany(employer("disagree", range(1001, 5000)), M_11_50,
    { early_size_reject_blocker: () => disagree });
  assertEquals([v.exclusion, v.eligible], [null, true]);

  // Agreeing observations do not block; a stale one does.
  assertEquals(discoverySizeRejectBlocker({ observations: [
    { evidence: [ev(1001, 5000, "apify_linkedin_job_search")] },
    { evidence: [ev(1001, 5000, "apify_linkedin_company_search")] },
  ] }, now), null);
  assertEquals(discoverySizeRejectBlocker({ observations: [
    { evidence: [ev(1001, 5000, "apify_linkedin_job_search", "2026-01-01T00:00:00Z")] },
  ] }, now), "stale_size_evidence");
});

Deno.test("no mission range: a Brain advisory bound never rejects early either", () => {
  const v = prequalifyNormalizedCompany(employer("advisory", range(1001, 5000)), M_11_50, { size_enforceable: false });
  assertEquals([v.exclusion, v.eligible], [null, true]);
});

// ═══════════════ MEASURABLE ════════════════════════════════════════════════

Deno.test("the pool result counts discovery-time rejections separately from every other size exclusion", () => {
  const noIdentity = { ...employer("noid", range(1001, 5000)), linkedin_company_url: null };
  const res = prequalifyDiscoveredCompanies([
    employer("alpha", range(1001, 5000)), employer("bravo", range(10001, null)), employer("charlie", range(11, 50)),
    employer("delta", range(51, 200)), noIdentity,
  ], M_11_50);
  assertEquals(res.employee_size_excluded, 4);
  assertEquals(res.employee_size_excluded_at_discovery, 3);
  const basisOf = (n: string) => res.companies.find((c) => c.name === n)?.size_exclusion_basis ?? null;
  assertEquals(basisOf("noid Inc"), "no_cheap_identity");
  assertEquals(basisOf("charlie Inc"), null);
  assertFalse(res.companies.find((c) => c.name === "charlie Inc")!.exclusion !== null);
});
