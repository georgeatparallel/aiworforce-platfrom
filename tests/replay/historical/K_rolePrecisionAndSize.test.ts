// HISTORICAL K — ROLE PRECISION AND SIZE FILTERING (Query B a9a6791a, production 2026-10-12).
//
// D. Every title the production search returned, judged by hand: which prove a
//    quota-carrying sales hire, and which do not. "Account Manager" and
//    "Customer Success Manager" are account care; "Inside Sales Support
//    Specialist" supports sellers and carries no quota.
// E. The declared bands production read, through the real normalizer and the
//    real discovery-time gate: below, in range, above, partial overlap,
//    unknown, identity conflict.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { roleMatchesFamily } from "../../../supabase/functions/_shared/roleFamilies.ts";
import { jobEmployerToCompany, jobProvesRequestedHiring, normalizeLinkedInJob } from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import { discoverySizeRejectBlocker, prequalifyNormalizedCompany } from "../../../supabase/functions/_shared/leadGenericPrequalification.ts";
import { queryBFixture } from "../lib/queryB.ts";

const fx = queryBFixture();
const PAGE_1 = fx.provider_responses.find((r) => r.actor === "apify_linkedin_job_search" && r.rows.length === 30)!.rows;
const SALES = { role_families: ["gtm_sales"], window_days: null };

// ══════════ D. ROLE PRECISION ═══════════════════════════════════════════════

const GENUINE_SALES = [
  "Account Executive", "Senior Account Executive", "Account Executive - HCM", "Sales Development Representative",
  "Business Development Representative", "Founding Business Development Representative (BDR) - Marketplace",
  "SaaS Business Development Representative (m/f/d)", "Enterprise Sales Director", "Regional Sales Director",
  "Territory Account Executive, Retail - Middlebury, VT", "Channel Sales Executive, SaaS Platforms",
  "North America - Tech Sales Leader, West Coast", "Sales Account Manager", "Sales Growth Associate",
  "Enterprise Account Executive", "Sales Manager",
];
const NOT_SALES = [
  "Account Manager", "Customer Success Manager", "Customer Support Specialist", "Inside Sales Support Specialist, Enterprise Mobility",
  "Store Manager", "Operations Analyst", "Product Designer", "Firmware Engineer", "Clinical Field Specialist",
];

Deno.test("[historical] K D: every genuine sales title proves a sales hire", () => {
  for (const t of GENUINE_SALES) assert(roleMatchesFamily(t, "gtm_sales"), t);
});

Deno.test("[historical] K D: account care, support and unrelated titles do not", () => {
  for (const t of NOT_SALES) assertFalse(roleMatchesFamily(t, "gtm_sales"), t);
});

Deno.test("[historical] K D: the production postings, through the posting gate", () => {
  const proving = PAGE_1.filter((r) => jobProvesRequestedHiring(normalizeLinkedInJob(r), SALES)).map((r) => String(r.title));
  assert(proving.includes("Founding Business Development Representative (BDR) - Marketplace"), "Perfect Venue's BDR");
  assert(proving.includes("Account Executive"), "Shipday's AE");
  for (const t of NOT_SALES) assertFalse(proving.includes(t), t);
});

// ══════════ E. SIZE FILTERING ═══════════════════════════════════════════════

const employer = (slug: string) => jobEmployerToCompany(PAGE_1.find((r) => (r.company as { universalName: string }).universalName === slug)!)!;
const RANGE = { min: 11, max: 50 };
const BASIS = "disjoint_declared_band_at_discovery";

Deno.test("[historical] K E: below (O-HIVE 2-10) and above (Stripe 5001-10000) are rejected at discovery", () => {
  for (const slug of ["o-hive-ai", "stripe"]) {
    const v = prequalifyNormalizedCompany(employer(slug), RANGE);
    assertEquals([v.exclusion, v.size_exclusion_basis], ["employee_size", BASIS], slug);
  }
});

Deno.test("[historical] K E: in range (Shipday 11-50) continues", () => {
  assertEquals(prequalifyNormalizedCompany(employer("shipdayinc"), RANGE).eligible, true);
});

Deno.test("[historical] K E: partial overlap (Buynomics 51-200 against 40-70) continues to enrichment", () => {
  const v = prequalifyNormalizedCompany(employer("buynomics"), { min: 40, max: 70 });
  assertEquals([v.exclusion, v.eligible], [null, true]);
});

Deno.test("[historical] K E: an unknown band continues", () => {
  const c = { ...employer("shipdayinc"), company_size_band: null };
  assertEquals(prequalifyNormalizedCompany(c, RANGE).exclusion, null);
});

Deno.test("[historical] K E: an identity conflict keeps a disjoint company (Stripe) in play", () => {
  const c = employer("stripe");
  const blocker = discoverySizeRejectBlocker({
    identity_conflicts: [{ kind: "linkedin_url", existing: "https://www.linkedin.com/company/other", incoming: c.linkedin_company_url }],
  });
  const v = prequalifyNormalizedCompany(c, RANGE, { early_size_reject_blocker: () => blocker });
  assertEquals([v.exclusion, v.eligible], [null, true]);
});
