// Role-family library — single source of truth for hiring/people role families,
// their alias sets, and the negative (profile/equity) titles that must never be
// accepted as a hiring signal. Pure / import-free except the shared support set.
//
// Used by LeadIntentExtractor (classify the requested role family), the
// ActorInputPlanner (role_keywords + exclude_keywords), and the filter/quality
// layers (accept only titles that match the requested family).

import { SUPPORT_ROLE_ALIASES, SUPPORT_ROLE_RE } from "./broaden.ts";

export type RoleFamily =
  | "assistant_founder_support"
  | "sales_operations"
  | "gtm_sales"
  | "marketing_growth"
  | "growth"
  | "engineering"
  | "ops"
  | "finance"
  | "customer_success"
  | "custom"
  | null;

export const ROLE_FAMILY_ALIASES: Record<Exclude<RoleFamily, null | "custom">, string[]> = {
  assistant_founder_support: SUPPORT_ROLE_ALIASES,
  // Sales/Revenue OPERATIONS is its own discipline. It is deliberately NOT part of
  // gtm_sales: a "Sales Operations" request must never be widened into SDR/BDR/AE
  // quota-carrying roles. Aligned with the backend jobFamilyRegistry
  // (sales_operations) so the UI and the sourcing runtime agree.
  sales_operations: [
    "Sales Operations", "Revenue Operations", "GTM Operations",
    "Revenue Strategy and Operations", "Sales Strategy and Operations",
  ],
  // Quota-carrying commercial sales. "First salesperson" / "first sales hire"
  // requests belong HERE — they are a company's first revenue-carrying hire, not
  // a Sales-Operations discipline hire.
  gtm_sales: [
    "SDR", "BDR", "Sales Development Representative", "Account Executive",
    // NOT "Growth" (2026-09-24). A bare "growth" alias here made "hiring a
    // growth role" resolve to THIS family, so an ordinary Account Executive or
    // SDR opening satisfied it and the search asked for 20 sales titles. Growth
    // is its own family below.
    "Founding SDR", "Founding AE", "Head of Sales", "GTM",
    "Go-to-Market", "Business Development", "Demand Generation", "Revenue",
    "Salesperson", "Sales Representative", "Territory Sales Manager",
    // COLLOQUIAL FORMS THE LIST WAS MISSING. A request for "enterprise sellers"
    // or "enterprise AEs" is a quota-carrying commercial hire and belongs to
    // exactly this family — but neither word appeared here, so the flagship
    // mission's role requirement resolved to no family at all and the run was
    // free to qualify a Software Engineer posting against it.
    //
    // Added to the ONE alias table rather than to a second reader, so the role
    // gate, the actor input planner and the title filter all learn them at once.
    "AE", "Enterprise AE", "Seller", "Enterprise Seller", "Enterprise Sales",
  ],
  marketing_growth: [
    "Growth Marketer", "Product Marketing", "Content Marketing", "Demand Gen",
    "Lifecycle Marketing", "Performance Marketing", "Growth Marketing", "Brand Marketing",
    // ── THE PEOPLE WHO DO THOSE JOBS, NOT ONLY THE DISCIPLINES ──────────────
    //
    // Titles are matched by substring, so "Product Marketing" never matched a
    // "Founding Product Marketer" and "Growth Marketing" never matched a
    // "Growth Lead". Lead V2 run 4250f181 asked for companies hiring their
    // first growth marketer and marked Lab0 (Founding Product Marketer) and
    // SafetyKit (Growth Lead) as having no qualifying role. These are the
    // marketer and growth-leadership forms of the same family — nothing outside
    // marketing/growth is added, so SDR/AE and engineering titles stay out.
    "Product Marketer", "Content Marketer", "Lifecycle Marketer", "Performance Marketer",
    "Founding Marketer", "Marketing Generalist", "Demand Generation",
    "Growth Lead", "Head of Growth", "Growth Manager",
    "Head of Marketing", "Marketing Lead",
  ],
  // ── GROWTH: THE FUNCTION, NARROWLY ────────────────────────────────────────
  //
  // "A growth role" names the growth function and nothing wider: it is not a
  // sales request (AE/SDR stay out) and not the whole marketing discipline.
  // Titles here are the growth-function forms NOT already in `marketing_growth`
  // (so "growth marketer" / "head of growth" keep resolving to that family by
  // the reader's longest-alias rule), and "Growth" itself, which as a title
  // keyword covers every "…Growth…" title (`hiringSearchTitles` searches the
  // covering keyword once rather than every longer form).
  growth: [
    "Growth", "VP of Growth", "Director of Growth", "Growth Product Manager",
    "Growth Operations", "Growth Analyst",
  ],
  engineering: [
    "Software Engineer", "Backend Engineer", "Frontend Engineer", "Full Stack Engineer",
    "AI Engineer", "ML Engineer", "Developer", "Staff Engineer",
  ],
  ops: [
    "Operations Manager", "Head of Operations", "RevOps", "Revenue Operations",
    "Business Operations", "Operations Lead",
  ],
  finance: [
    "Finance Manager", "Controller", "FP&A", "Accountant", "Head of Finance", "CFO",
  ],
  customer_success: [
    "Customer Success Manager", "CSM", "Account Manager", "Customer Support",
    "Onboarding Specialist", "Support Engineer",
  ],
};

// Profile / equity titles — valid people targets in people_sourcing, but NEVER a
// hiring signal unless the user explicitly requested those roles as job postings.
export const PROFILE_OR_EQUITY_TITLES = [
  "Founder", "Co-Founder", "CEO", "CTO", "CFO", "COO",
  "Entrepreneur in Residence", "Future Founder", "Advisor", "Investor",
];

const PROFILE_OR_EQUITY_RE =
  /\b(co-?founder|ceo|cto|cfo|coo|chief (?:executive|technology|operating|financial) officer|entrepreneur in residence|\beir\b|future (?:ai )?founder|advisor|investor|board member)\b/i;

// Detection order matters: the most specific family (support) is checked first so
// "Operations Associate" / "Chief of Staff" land in assistant, not gtm/ops.
const FAMILY_DETECT: Array<[Exclude<RoleFamily, null | "custom">, RegExp]> = [
  ["assistant_founder_support", SUPPORT_ROLE_RE],
  // MUST precede gtm_sales: its \bsales\b / revenue alternatives would otherwise
  // capture "Sales Operations" and produce SDR/BDR/AE aliases (the 2026-07-26
  // manual-run corruption).
  ["sales_operations", /\b(sales op(?:s|erations)|revenue op(?:s|erations)|rev ?ops|gtm op(?:s|erations)|revenue strategy (?:and|&) operations|sales strategy (?:and|&) operations)\b/i],
  // "first salesperson" / "founding salesperson" / "first sales hire" — a first
  // revenue-carrying hire. Matched here (AFTER sales_operations, so a "Sales
  // Operations" request can never be captured by it) because `\bsales\b` does not
  // reach inside "salesperson"/"salespeople", which is why these resolved to null.
  ["gtm_sales", /\b(sdrs?|bdrs?|account executives?|\baes?\b|sales development|founding (?:sdr|ae)|head of sales|gtm|go-?to-?market|business development|demand gen(?:eration)?|sales ?(?:person|people)|salesperson|salespeople|\bsales\b|revenue)\b/i],
  ["marketing_growth", /\b(growth marketers?|product marketing|content marketing|lifecycle marketing|performance marketing|growth marketing|brand marketing|\bmarketing\b)\b/i],
  // AFTER marketing_growth, so "growth marketing" / "growth marketer" stay
  // marketing; a bare "growth" names the growth function.
  ["growth", /\bgrowth\b/i],
  ["engineering", /\b(software engineers?|backend engineers?|frontend engineers?|full ?stack|ai engineers?|ml engineers?|\bengineers?\b|developers?|\bswe\b)\b/i],
  ["customer_success", /\b(customer success|\bcsm\b|account managers?|customer support|onboarding specialists?|support engineers?)\b/i],
  ["finance", /\b(fp&a|controllers?|accountants?|finance managers?|head of finance|\bcfo\b)\b/i],
  ["ops", /\b(operations managers?|head of operations|revops|revenue operations|business operations|operations leads?|\boperations\b)\b/i],
];

/** The role family a free-text role/query refers to, or null if none. */
export function classifyRoleFamily(text: string | null | undefined): RoleFamily {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  for (const [fam, re] of FAMILY_DETECT) if (re.test(t)) return fam;
  return null;
}

/** Alias keyword set for a family (for actor role_keywords + query OR-expansion). */
export function roleFamilyAliases(fam: RoleFamily): string[] {
  return fam && fam !== "custom" ? (ROLE_FAMILY_ALIASES[fam] ?? []) : [];
}

/** A title that is a founder/equity/advisor profile, not an operational hire. */
export function isProfileOrEquityTitle(title: string | null | undefined): boolean {
  const t = String(title ?? "");
  // Support roles that happen to contain "founder" (Founder's Office, Founder
  // Associate) are NOT equity titles.
  if (SUPPORT_ROLE_RE.test(t)) return false;
  return PROFILE_OR_EQUITY_RE.test(t);
}

/**
 * Titles that carry a sales word without being a quota-carrying sales hire.
 * Query B (task 255c333f): a PR agency's "Account Executive" (client service),
 * "Global Sales & Operations Planning Leader" (supply/demand planning) and a
 * "Customer Service Sales Representative" all matched gtm_sales by the word
 * "account executive" or "sales". Only TITLE matching reads this; classifying a
 * request's own wording (`classifyRoleFamily`) is unchanged.
 */
const NOT_A_SALES_HIRE_RE =
  /\b(?:public relations|pr)\b[^,]*\baccount executives?\b|\baccount executives?\b[^,]*,\s*(?:public relations|pr)\b|\bsales\s*(?:&|and)\s*operations planning\b|\bs&op\b|\bcustomer service\b/i;

/** Does a job title belong to the requested role family? */
export function roleMatchesFamily(title: string | null | undefined, fam: RoleFamily): boolean {
  if (!fam || fam === "custom") return false;
  const t = String(title ?? "");
  if (!t.trim()) return false;
  if (fam === "assistant_founder_support") return SUPPORT_ROLE_RE.test(t);
  if (fam === "gtm_sales" && NOT_A_SALES_HIRE_RE.test(t)) return false;
  // Title matches if it classifies to this family, or contains one of its aliases.
  if (classifyRoleFamily(t) === fam) return true;
  const lc = t.toLowerCase();
  return roleFamilyAliases(fam).some((a) => lc.includes(a.toLowerCase()));
}

/**
 * Titles to EXCLUDE from a hiring search for a given family: the profile/equity
 * titles plus "Intern", so a jobs actor doesn't return founder listings or
 * unpaid roles for e.g. an assistant-support search.
 */
export function hiringExcludeTitles(fam: RoleFamily): string[] {
  const base = [...PROFILE_OR_EQUITY_TITLES, "Intern"];
  // For assistant/support, also exclude unrelated senior IC families that the
  // jobs actor tends to over-return.
  if (fam === "assistant_founder_support") base.push("Engineer", "Software Engineer");
  return base;
}
