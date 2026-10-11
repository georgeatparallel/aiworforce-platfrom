// A DISCOVERY POSTING PROVES ONLY THE HIRING THE MISSION ASKED FOR.
//
// Production Query B (task d72bc1ce, 2026-10-11): "currently hiring sales".
// The LinkedIn job search was asked for sales titles and still returned
// "Assistant Manager - 8323" (Domino's), "Retail Key Holder" (Gopuff), a supply
// chain intern (Cisco) and a part-time operations analyst (Clozd). Every one of
// them became `hiring: true, proven` and passed the sales-hiring hard check —
// the eligibility rule trusted that "the search already asked for the role".
// They failed on size, so the run had no false positive; a small software
// company with the same posting would have qualified.
//
// The rule: a posting proves a role-specific hiring requirement only when its
// title matches a requested family (the canonical `roleMatchesFamily`) and,
// under a stated window, it is dated inside it.

import { assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  jobProvesRequestedHiring, requestedHiringFromSignals,
} from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";

const NOW = new Date("2026-10-11T07:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const SALES = { role_families: ["gtm_sales"], window_days: null };
const SALES_30 = { role_families: ["gtm_sales"], window_days: 30 };
const posting = (title: string, posted_date: string | null = daysAgo(1)) => ({ title, posted_date });

Deno.test("A. sales: Enterprise Account Executive proves sales hiring", () => {
  assert(jobProvesRequestedHiring(posting("Enterprise Account Executive"), SALES, NOW));
});

Deno.test("B. sales: an SDR (and other sales titles) proves sales hiring", () => {
  for (const t of ["Sales Development Representative", "SDR", "BDR", "Sales Manager", "Sales Director", "Founding Account Executive"]) {
    assert(jobProvesRequestedHiring(posting(t), SALES, NOW), t);
  }
});

Deno.test("C–F. sales: the production non-sales postings do NOT prove sales hiring", () => {
  for (const t of [
    "Assistant Manager - 8323",
    "Retail Key Holder, San Bruno, #1446",
    "Product Lifecycle Supply Chain Project Specialist I (Intern) - United States",
    "Part-Time Operations Analyst - Outreach & Scheduling (Student Role)",
  ]) {
    assertFalse(jobProvesRequestedHiring(posting(t), SALES, NOW), t);
  }
});

Deno.test("I. a valid sales role outside a 30-day window does not prove current hiring", () => {
  assert(jobProvesRequestedHiring(posting("Account Executive", daysAgo(29)), SALES_30, NOW));
  assertFalse(jobProvesRequestedHiring(posting("Account Executive", daysAgo(45)), SALES_30, NOW));
});

Deno.test("an undated posting cannot prove a stated window (T02)", () => {
  assertFalse(jobProvesRequestedHiring(posting("Account Executive", null), SALES_30, NOW));
  // With no stated window the search's own freshness filter governs, as before.
  assert(jobProvesRequestedHiring(posting("Account Executive", null), SALES, NOW));
});

Deno.test("no requested family: any opening is the evidence (unchanged)", () => {
  assert(jobProvesRequestedHiring(posting("Assistant Manager"), { role_families: [], window_days: null }, NOW));
  assert(jobProvesRequestedHiring(posting("Assistant Manager"), null, NOW));
});

Deno.test("an unrecognised family is not enforced (no second taxonomy is invented)", () => {
  assert(jobProvesRequestedHiring(posting("Assistant Manager"), { role_families: ["custom"], window_days: null }, NOW));
  assert(jobProvesRequestedHiring(posting("Assistant Manager"), { role_families: ["not_a_family"], window_days: null }, NOW));
});

Deno.test("requested hiring is read from the mission's hiring signals", () => {
  const r = requestedHiringFromSignals([{ role_families: ["gtm_sales"] }, { role_families: ["gtm_sales", "marketing_growth"], timeframe_days: 14 }]);
  assert(r && r.role_families.includes("gtm_sales") && r.role_families.includes("marketing_growth"));
  assert(r && r.window_days === 14);
  assert(requestedHiringFromSignals([]) === null);
  assert(requestedHiringFromSignals([{ role_families: ["gtm_sales"] }])?.window_days === null);
});

// ── SALES PRECISION (Query B rerun, task 255c333f) ──────────────────────────
//
// After the role-match fix, three borderline titles still counted as sales:
// a PR "Account Executive" (FINN Partners, Inkhouse), "Global Sales &
// Operations Planning Leader" (ABB) and "Customer Service Sales Representative"
// (MITRU). None is a quota-carrying sales hire.

import { roleMatchesFamily } from "../../../supabase/functions/_shared/roleFamilies.ts";

Deno.test("sales precision: genuine sales titles still match gtm_sales", () => {
  for (const t of ["Account Executive", "Enterprise Account Executive", "Sales Manager", "SDR", "BDR", "Sales Director"]) {
    assert(roleMatchesFamily(t, "gtm_sales"), t);
    assert(jobProvesRequestedHiring(posting(t), SALES, NOW), t);
  }
});

Deno.test("sales precision: borderline and non-sales titles do not match gtm_sales", () => {
  for (const t of [
    "PR Account Executive",
    "Public Relations Account Executive – Polskin Arts PR",
    "Account Executive, Public Relations",
    "Global Sales & Operations Planning Leader",
    "Customer Service Sales Representative, Fully Remote - Career Transition Opportunity",
    "Assistant Manager - 8323",
    "Part-Time Operations Analyst - Outreach & Scheduling (Student Role)",
    "Product Lifecycle Supply Chain Project Specialist I (Intern) - United States",
    "Retail Key Holder, San Bruno, #1446",
  ]) {
    assertFalse(roleMatchesFamily(t, "gtm_sales"), t);
    assertFalse(jobProvesRequestedHiring(posting(t), SALES, NOW), t);
  }
});
