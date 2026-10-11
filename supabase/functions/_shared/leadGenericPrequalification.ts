// FREE PREQUALIFICATION FOR EVERY SOURCE — not only Y Combinator.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
//
// `prequalifyYcCompanies` reads memo23's raw row shape: `openJobs`, `teamSize`,
// `batch`, `oneLiner`. So the engine ran it only when `rawYcRows.length > 0`,
// and its own comment stated the consequence plainly — a pool assembled by the
// LinkedIn company search, the funding source or the news source "loses the
// FREE pre-pass, which is exactly what a source that returns no embedded jobs
// cannot support."
//
// The first half of that is true. The second half is not. A source without
// embedded jobs still returns a declared size band, a description, a domain and
// a LinkedIn URL — and a company whose PROVEN declared band is 501-1000 on a
// 10-150 mission can be refused for free, before two paid calls and roughly 26 seconds
// of identity resolution and enrichment are spent proving what the row already
// said. Every non-YC pool paid that, for every company, including the ones
// qualification was about to reject.
//
// ── HOW THIS AVOIDS BECOMING A ROUTING TABLE ────────────────────────────────
//
// There is no `if actor === "apify_linkedin_company_search"` here, and there
// must never be. This module reads exactly two things:
//
//   the NORMALIZED company   every discovery actor already produces one;
//   its `field_trust` map    the normalizer's own declaration of how far each
//                            field can be trusted.
//
// A gate fires only when the field is PRESENT and its declared trust permits
// it. Add a discovery actor tomorrow, declare its field trust in its
// normalizer — which is required anyway — and it is triaged here with no change
// to this file. That is the same mechanism `MEMBER_COUNT_SERIES_SOURCES` uses for
// the growth series, generalised from one field to all of them.
//
// ── WHAT MAY EXCLUDE, AND WHAT MAY ONLY RANK ────────────────────────────────
//
// TWO gates may exclude, and nothing else:
//
//   artifact       a directory or platform page is not a prospect. Y
//                  Combinator's own page was once counted as a qualified lead.
//   employee_size  a declared size band wholly outside a range the MISSION
//                  set, when either it is PROVEN (`evidenceAuthority`) or
//                  settling it would first need a paid identity search. A
//                  discovery row's band is PLAUSIBLE: for a candidate that
//                  already carries its LinkedIn identity — one cheap enrichment
//                  away from a proven band — it ranks the company down and
//                  enrichment decides, UNLESS the band is the company's own
//                  declared band on a strong identity and clearly disjoint
//                  from the range (see "A CLEARLY DISJOINT DECLARED BAND"
//                  below). The LinkedIn associated-member count is never a
//                  size gate (companySize.ts).
//
// Everything else — a description, an identity, a hiring flag, an industry
// label — ranks. This is the three-valued discipline the ICP gate already
// keeps: absence is `unknown`, never `fail`, and only a contradiction may
// reject. A free pre-pass that excluded on a missing field would delete
// companies for the sin of having been found by a terse actor.
//
// GEOGRAPHY IS DELIBERATELY NOT A GATE HERE. `geographyContradicts` is the
// system's contradiction detector and it answers `true` for
// ("Berlin, Germany", ["Europe"]) — a continent is not a token any country
// string contains. Promoting it into a pre-pass would drop every European
// company from the flagship European mission, for free, before anything could
// reconsider. It stays where it is, after enrichment, until it understands
// continents. See `geographyContradicts` in `leadEligiblePool.ts`.
//
// PURE. No network, provider, model or database access.

import { mayRejectOnReportedSize, type AuthorityDecision } from "./evidenceAuthority.ts";
import {
  bandSatisfies, sizeBandLabel, isSizeBand, DECLARED_SIZE_BANDS, type CompanySizeBand,
} from "./companySize.ts";
import type {
  NormalizedHiringCompany, FieldTrust,
} from "./hiringActorNormalizers.ts";
import {
  ARTIFACT_DOMAINS, normalizeDomain, normalizeCompanyName,
  type PrequalifiedCompany, type PrequalificationResult, type ExcludedArtifact,
  PREQUALIFICATION_VERSION,
} from "./leadCommercialPrequalification.ts";

export const GENERIC_PREQUALIFICATION_VERSION =
  "generic-prequalification-v1" as const;

/**
 * LinkedIn company pages people select as an employer when they have none to
 * name: "Stealth Startup", "Confidential Careers", "Freelance | Self-Employed".
 *
 * ── WHY THIS IS AN IDENTITY RULE, NOT A SIZE RULE ──────────────────────────
 *
 * Run fafd9912 returned all three inside the requested size band — they
 * DECLARE 2-10 or 11-50 — with 414,811, 29,946 and 37,306 LinkedIn associated
 * members. Until 2026-09-24 the member count was misread as staff and kept
 * them out by accident; it is not staff (companySize.ts) and may not exclude
 * anyone, so the thing that actually disqualifies these rows has to be said
 * directly: the page names no company.
 *
 * EXACT normalized names only. A real company that merely contains one of these
 * words ("Confidential Computing Inc", "Stealth Security") is untouched.
 */
const PLACEHOLDER_EMPLOYER_NAMES: ReadonlySet<string> = new Set([
  "stealth", "stealth startup", "stealth mode", "stealth mode startup", "stealth company",
  "confidential", "confidential company", "confidential careers", "empresa confidencial",
  "self employed", "freelance", "freelancer", "freelance self employed", "self employed freelance",
]);

export function isPlaceholderEmployerName(name: string | null | undefined): boolean {
  const n = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return n.length > 0 && PLACEHOLDER_EMPLOYER_NAMES.has(n);
}

/**
 * Trust levels a field may be GATED on.
 *
 * ── WHY `semantic` AND `unsafe` ARE ABSENT ─────────────────────────────────
 *
 * `direct`, `alias` and `transformed` are all the provider's own assertion —
 * copied, renamed, or reshaped. The value is still what the provider said.
 *
 * `semantic` is an INTERPRETATION of what the provider said. `company_type` is
 * marked semantic on both LinkedIn actors and carries "Privately Held", which
 * is ownership and not a business model; the benchmark says so in those words.
 *
 * `unsafe` is a field OBSERVED WRONG on live data. `employee_range_advisory`
 * (a non-LinkedIn provider's size wording) carries it, and the funding source's industry
 * tags carry it because run 0XchPqe0cJpx0Yc2T returned a biotech tagged
 * "Retail". Gating on an unsafe field is not a strict rule, it is a wrong one.
 */
const GATE_WORTHY_TRUST: readonly FieldTrust[] =
  Object.freeze(["direct", "alias", "transformed"]);

/** May this company's `field` be used to EXCLUDE? */
export function mayGateOn(
  company: NormalizedHiringCompany, field: string,
): boolean {
  const trust = company.field_trust?.[field];
  return trust !== undefined && GATE_WORTHY_TRUST.includes(trust);
}

/**
 * The key a generic verdict is filed under.
 *
 * ── EXPORTED SO THE ENGINE CANNOT DERIVE IT DIFFERENTLY ────────────────────
 *
 * The engine has to look a scored verdict back up against the company it came
 * from. Recomputing the key there with a lookalike expression is how a
 * shortlist and its companies quietly stop referring to the same set — the
 * exact failure `prequalificationKey` was extracted to prevent on the YC side.
 * Domain first, normalized name second: the same precedence as the YC key and
 * the internal identity.
 */
export function genericPrequalificationKey(
  company: NormalizedHiringCompany,
): string {
  const domain = company.canonical_domain ?? normalizeDomain(company.website);
  return domain ?? `name:${normalizeCompanyName(company.company_name)}`;
}

export interface GenericSizeBounds { min?: number | null; max?: number | null }

export interface GenericPrequalificationPolicy {
  /**
   * May a size bound REJECT?
   *
   * False when the MISSION expressed no employee range. The workspace Brain's
   * advisory bounds may then still ORDER the pool and may not remove anyone
   * from it — the same rule `prequalifyYcCompanies` keeps, and for the same
   * reason: nothing the user asked for mentioned company size.
   */
  size_enforceable?: boolean;
  /** True when the mission's required signals include hiring. Ranking only. */
  mission_requires_hiring?: boolean;
  /**
   * What the ENGINE knows about a candidate that its normalized row does not:
   * an identity conflict, or size observations that disagree or have gone
   * stale (`discoverySizeRejectBlocker`). A non-null answer keeps a clearly
   * disjoint band from rejecting at discovery; the company is ranked down and
   * enrichment decides, exactly as before.
   */
  early_size_reject_blocker?: (company: NormalizedHiringCompany) => string | null;
}

// ── A CLEARLY DISJOINT DECLARED BAND, SETTLED AT DISCOVERY ──────────────────
//
// Query B (task 255c333f): 62 job-search employers, 53 rejected on size after
// enrichment. Each carried its LinkedIn identity and the company's declared
// `employeeCountRange`, and the company-details read returned the SAME band
// for 62/62 (96/96 across both runs). Ranking them down bought an enrichment
// slot, grounding and queue time per company to restate what the row said.
//
// So a discovery band may now reject, but only on the strongest evidence the
// row can carry, and every weaker shape keeps the old path (ranked down; the
// company record decides):
//   * the band is the provider's own declared field (`direct`) and one of
//     LinkedIn's declared bands — not reshaped, not an advisory text;
//   * the identity is a direct, canonical LinkedIn company URL with a name;
//   * the band's source is not stale and can speak to size;
//   * the engine reports no identity conflict and no disagreeing or stale
//     size observation;
//   * the band and the range share no value — `bandSatisfies` "fail", the
//     verdict the post-enrichment hard check reaches on that same band. A
//     partial overlap is "unknown" there and here, and never rejects.

const CANONICAL_LINKEDIN_COMPANY_URL = /^https:\/\/www\.linkedin\.com\/company\/[a-z0-9][^/?#\s]+$/;

function hasStrongLinkedInIdentity(company: NormalizedHiringCompany): boolean {
  return company.field_trust?.linkedin_company_url === "direct" &&
    CANONICAL_LINKEDIN_COMPANY_URL.test(company.linkedin_company_url ?? "") &&
    (company.company_name ?? "").trim().length > 0;
}

function isDeclaredLinkedInBand(band: CompanySizeBand): boolean {
  return band.source === "linkedin_declared" &&
    DECLARED_SIZE_BANDS.some((b) => b.min === band.min && b.max === band.max);
}

/** Why this clearly disjoint band may NOT reject at discovery, or null when it may. */
function discoveryRejectRefusal(
  company: NormalizedHiringCompany, band: CompanySizeBand,
  authority: AuthorityDecision, policy: GenericPrequalificationPolicy,
): string | null {
  if (company.field_trust?.company_size_band !== "direct") return "band_not_declared_field";
  if (!isDeclaredLinkedInBand(band)) return "band_not_canonical";
  if (authority.authority === "insufficient" || /:stale$/.test(authority.rule)) return "size_source_weak_or_stale";
  if (!hasStrongLinkedInIdentity(company)) return "weak_identity";
  return policy.early_size_reject_blocker?.(company) ?? null;
}

/** The slice of an engine candidate the blocker reads. Structural, so the engine passes its own. */
export interface DiscoveryCandidateContext {
  identity_conflicts?: readonly unknown[] | null;
  observations?: ReadonlyArray<{
    evidence?: ReadonlyArray<{ dimension: string; value: unknown; valid_until?: string | null }>;
  }> | null;
}

/**
 * What would make a discovery-time size rejection unsafe for this candidate:
 * `identity_conflict` (strong identifiers disagreed), `stale_size_evidence`
 * (a band past its validity), `size_band_disagreement` (two observations of
 * this company declare different bands — discovery against a company record
 * already on file, or two discovery routes). Null when none applies.
 */
export function discoverySizeRejectBlocker(
  c: DiscoveryCandidateContext, now: Date = new Date(),
): string | null {
  if ((c.identity_conflicts?.length ?? 0) > 0) return "identity_conflict";
  const bands = new Set<string>();
  for (const o of c.observations ?? []) {
    for (const e of o.evidence ?? []) {
      if (e.dimension !== "company_size_band" || !isSizeBand(e.value)) continue;
      if (e.valid_until && Date.parse(e.valid_until) < now.getTime()) return "stale_size_evidence";
      bands.add(sizeBandLabel(e.value));
    }
  }
  return bands.size > 1 ? "size_band_disagreement" : null;
}

/**
 * Score one normalized company using only fields its source is trusted for.
 *
 * ── THE SCALE IS DELIBERATELY THE SAME AS THE YC PASS ──────────────────────
 *
 * `buildSmartShortlist` orders by relevance tier, signal strength, confidence,
 * then this score — and it reads a missing score as `-1`. So today every
 * non-YC company sorts beneath every scored YC company on that tiebreak, not
 * because it is worse but because nothing scored it.
 *
 * Putting both passes on one scale fixes that. A generic company earns only
 * what its evidence supports: it cannot earn the role-tier points, because it
 * has no job rows, and that is the truth about it rather than a handicap.
 */
export function prequalifyNormalizedCompany(
  company: NormalizedHiringCompany,
  size: GenericSizeBounds = {},
  policy: GenericPrequalificationPolicy = {},
): PrequalifiedCompany {
  const sizeEnforceable = policy.size_enforceable !== false;
  const name = (company.company_name ?? "").trim();
  const domain = company.canonical_domain
    ?? normalizeDomain(company.website);

  const reasons: string[] = [];
  let score = 0;

  // ── SIZE: THE DECLARED BAND, THE ONE GATE WORTH PAYING FOR ───────────────
  //
  // Read from `company_size_band` — the company's own declared band, the field
  // LinkedIn's size filter reads (companySize.ts). NEVER from the LinkedIn
  // associated-member count: that counts members who list the company, not
  // staff, and it neither ranks nor rejects on size. A non-LinkedIn advisory
  // text (a YC `teamSize`) is not a band and stays unverified.
  const band = company.company_size_band && mayGateOn(company, "company_size_band")
    ? company.company_size_band : null;
  const bandVerdict = band ? bandSatisfies(size, band) : null;
  const size_status: PrequalifiedCompany["size_status"] =
    !band || !bandVerdict || bandVerdict.verdict === "unknown" ? "size_unverified"
    : bandVerdict.verdict === "pass" ? "in_range"
    : (size.max != null && band.min > size.max) ? "above_max"
    : "below_min";
  const size_fit = size_status === "in_range";
  // ── A REPORTED BAND RANKS; A PROVEN OR CLEARLY DISJOINT ONE MAY REJECT ───
  //
  // Whether the band may reject before enrichment is the authority layer's
  // decision: a discovery row's band is PLAUSIBLE, so an out-of-range band
  // ranks the company down and the company record's band decides — except a
  // clearly disjoint declared band on a strong identity (`discoveryRejectRefusal`).
  const sizeAuthority = band === null ? null
    : mayRejectOnReportedSize(company.raw_ref?.actor_key ?? company.source_provenance);
  // CHEAP TO SETTLE: a candidate that already carries its LinkedIn identity is
  // one company-record read (~$0.004) from a PROVEN band. One without it would
  // first need a paid identity search (~$0.06), and there the free reported
  // band may still exclude — settling it costs more than the exclusion saves.
  const enrichmentIsCheap = !!company.linkedin_company_url;
  const outOfRange = size_status === "above_max" || size_status === "below_min";
  // Asked only of a clearly disjoint band, and only where a rejection could
  // actually be enforced: the blocker is the engine's to answer and costs a
  // walk over the candidate's observations.
  const discoveryRefusal = band && sizeAuthority && outOfRange && sizeEnforceable &&
      sizeAuthority.authority !== "proven" && enrichmentIsCheap
    ? discoveryRejectRefusal(company, band, sizeAuthority, policy) : undefined;
  const size_exclusion_basis: PrequalifiedCompany["size_exclusion_basis"] =
    !outOfRange ? null
    : sizeAuthority?.authority === "proven" ? "proven_band"
    : !enrichmentIsCheap ? "no_cheap_identity"
    : discoveryRefusal === null ? "disjoint_declared_band_at_discovery"
    : null;
  const sizeMayReject = size_exclusion_basis !== null;
  const bandText = band ? sizeBandLabel(band) : null;

  if (size_fit) {
    score += 30;
    reasons.push(`declared size band ${bandText} is inside the target range`);
  } else if (outOfRange && !sizeMayReject) {
    score -= 25;
    reasons.push(
      `declared size band ${bandText} is ${size_status === "above_max" ? "above the maximum" : "below the minimum"} — ` +
      `ranked down, not excluded: a discovery row's band is not proof (${sizeAuthority?.rule}), ` +
      `the company already carries its LinkedIn identity, and the company record's band decides` +
      (discoveryRefusal ? ` (no early rejection: ${discoveryRefusal})` : ""));
  } else if (size_exclusion_basis === "disjoint_declared_band_at_discovery") {
    reasons.push(
      `declared size band ${bandText} is clearly disjoint from the requested range ` +
      `(${size_status === "above_max" ? "above the maximum" : "below the minimum"}) — excluded at discovery: ` +
      `the company's own declared band on a strong LinkedIn identity, with no conflict or disagreeing ` +
      `observation, so enrichment would read the same band and reach the same verdict`);
  } else if (size_status === "above_max") {
    reasons.push(
      `declared size band ${bandText} exceeds the maximum — excluded before ` +
      `identity resolution and enrichment, which is two paid calls this row ` +
      `already answered`);
  } else if (size_status === "below_min") {
    reasons.push(
      `declared size band ${bandText} is below the minimum — excluded before ` +
      `any paid call`);
  } else if (bandVerdict?.verdict === "unknown") {
    reasons.push(`size unsettled: ${bandVerdict.reason}`);
  } else if (company.employee_range_advisory) {
    // SAID, NOT USED. Naming the figure and refusing to act on it is the
    // difference between a pre-pass that is quiet about what it ignored and
    // one an auditor can check.
    reasons.push(
      `size unverified: the only figure is the advisory text ` +
      `"${company.employee_range_advisory}", which is not a declared band and may ` +
      `not exclude anyone`);
  } else {
    reasons.push("size unverified — ranks below every verified in-range company");
  }

  // ── IDENTITY: WHAT THE NEXT PAID STAGE WOULD HAVE TO BUY ─────────────────
  //
  // A company that already carries a LinkedIn URL skips identity resolution
  // entirely, so it is cheaper to investigate than one that does not. That is
  // a fact about cost, and ranking on it spends the budget further.
  const identity_confidence: PrequalifiedCompany["identity_confidence"] =
    domain ? "domain_exact" : "name_only";
  if (company.linkedin_company_url) {
    score += 20;
    reasons.push("already carries a LinkedIn identity — no resolution to pay for");
  } else if (domain) {
    score += 10;
    reasons.push("has a domain — identity is corroboratable without a name-only match");
  } else {
    reasons.push("no domain and no LinkedIn URL — identity rests on the name alone");
  }

  // ── DESCRIPTION: THE MINIMUM-EVIDENCE FIELD ──────────────────────────────
  //
  // `hasMinimumEvidence` in `leadEligiblePool` drops a company with no
  // description, cohort record, site or opening as
  // `insufficient_evidence_to_evaluate`. A company arriving here without one is
  // therefore already likely to be unjudgeable — worth ranking down, and NOT
  // worth excluding, because enrichment may still supply it.
  if ((company.description ?? "").trim().length > 0) {
    score += 25;
    reasons.push("carries a description — the field the ICP gate reasons from");
  } else {
    reasons.push(
      "no description yet; enrichment may supply one, so this ranks down " +
      "rather than out");
  }

  // ── HIRING: A FACT, WHEN THE MISSION ASKED FOR IT ────────────────────────
  //
  // Ranking only, in both directions. `hiring_status === false` is not proof a
  // company is not hiring — most actors simply do not answer the question, and
  // `hiring_status` is absent from the LinkedIn normalizers' trust maps
  // entirely, so `mayGateOn` refuses it there.
  const has_open_roles = company.hiring_status === true;
  if (policy.mission_requires_hiring && has_open_roles &&
      mayGateOn(company, "hiring_status")) {
    score += 20;
    reasons.push("the source reports this company as hiring");
  }

  const key = genericPrequalificationKey(company);

  return {
    company_key: key,
    name: name || key,
    canonical_domain: domain,
    // YC-SHAPED FIELDS, HONESTLY EMPTY. This company did not come from a YC
    // cohort and inventing a batch or a one-liner to fill the shape would put
    // a fabricated fact where a downstream reader expects a provider's.
    yc_url: null,
    yc_id: null,
    // A YC-SHAPED FIELD: a team size. No non-YC source reports one — the
    // LinkedIn member count is not staff — so it is honestly empty here.
    team_size: null,
    batch: null,
    one_liner: null,
    locations: company.geography,
    jobs: [],
    has_open_roles,
    tier_a: 0, tier_b: 0, tier_c: 0, technical: 0,
    // NULL IS THE TRUTH, NOT A ZERO. `best_tier` means "the highest commercial
    // role tier with evidence". No job rows were seen, so there is no tier —
    // which is different from having looked and found none.
    best_tier: null,
    score,
    strongest_signal: null,
    size_fit, size_status,
    // ── ELIGIBILITY: ONE GATE, AND ONLY WHEN THE MISSION SET A RANGE ───────
    //
    // The YC pass also refuses a company with no commercial role tier. That
    // rule cannot apply here: a source that returns no jobs has not reported
    // the absence of jobs, and reading its silence as "no commercial hiring"
    // would exclude every LinkedIn and funding row on the strength of a
    // question nobody asked the provider.
    eligible: !(sizeEnforceable && sizeMayReject && outOfRange),
    exclusion: (sizeEnforceable && sizeMayReject && outOfRange) ? "employee_size" : null,
    size_exclusion_basis: (sizeEnforceable && sizeMayReject && outOfRange) ? size_exclusion_basis : null,
    reasons,
    linkedin_identity_status: "unresolved",
    identity_confidence,
  };
}

/** A row refused before scoring, with the reason. */
export interface GenericPrequalificationResult {
  version: typeof GENERIC_PREQUALIFICATION_VERSION;
  total_rows: number;
  unique_companies: number;
  excluded: ExcludedArtifact[];
  companies: PrequalifiedCompany[];
  employee_size_excluded: number;
  /**
   * Of `employee_size_excluded`, how many a clearly disjoint declared band
   * settled at discovery — the optimisation's own count, so it can be measured
   * apart from the proven-band and no-identity exclusions.
   */
  employee_size_excluded_at_discovery: number;
  eligible_companies: number;
  /** How many rows carried a trusted declared size band at all. */
  companies_with_trusted_size: number;
  /** How many carried a description — the ICP gate's primary input. */
  companies_with_description: number;
}

/**
 * Score a whole discovered pool.
 *
 * Deduplicated on domain first, then normalized name — the same precedence the
 * YC pass and the internal identity both use, so one company cannot occupy two
 * shortlist slots.
 */
export function prequalifyDiscoveredCompanies(
  companies: readonly NormalizedHiringCompany[],
  size: GenericSizeBounds = {},
  policy: GenericPrequalificationPolicy = {},
): GenericPrequalificationResult {
  const excluded: ExcludedArtifact[] = [];
  const byKey = new Map<string, PrequalifiedCompany>();
  let withTrustedSize = 0;
  let withDescription = 0;

  for (const c of companies) {
    const name = (c.company_name ?? "").trim();
    const domain = c.canonical_domain ?? normalizeDomain(c.website);

    if (!name && !domain) {
      excluded.push({
        name: name || "(unnamed)", domain,
        reason: "no name and no website — not a company row",
      });
      continue;
    }
    // ONE OF TWO EXCLUSIONS THAT REMOVE A ROW OUTRIGHT. Y Combinator's own
    // page reached persistence as a qualified lead on an earlier run.
    if (domain && ARTIFACT_DOMAINS.includes(domain)) {
      excluded.push({
        name, domain, reason: "directory/platform artifact, not a prospect",
      });
      continue;
    }
    // …and the other: a PLACEHOLDER EMPLOYER page, which is an identity fact,
    // not a size one. See `isPlaceholderEmployerName`.
    if (isPlaceholderEmployerName(name)) {
      excluded.push({
        name, domain, reason: "placeholder employer page (not a company anyone can sell to)",
      });
      continue;
    }

    const scored = prequalifyNormalizedCompany(c, size, policy);
    if (byKey.has(scored.company_key)) continue;
    // INVARIANT, held in code rather than in a comment: the verdict's key is
    // the one the engine will look it up by.
    if (scored.company_key !== genericPrequalificationKey(c)) {
      throw new Error(
        `generic prequalification key drift for ${scored.name}: ` +
        `${scored.company_key} !== ${genericPrequalificationKey(c)}`);
    }
    byKey.set(scored.company_key, scored);

    if (c.company_size_band && mayGateOn(c, "company_size_band")) withTrustedSize++;
    if ((c.description ?? "").trim().length > 0) withDescription++;
  }

  const rank = (c: PrequalifiedCompany) => c.size_status === "in_range" ? 0 : 1;
  const out = [...byKey.values()].sort((a, b) =>
    rank(a) - rank(b) || b.score - a.score || a.name.localeCompare(b.name));

  return {
    version: GENERIC_PREQUALIFICATION_VERSION,
    total_rows: companies.length,
    unique_companies: out.length,
    excluded,
    companies: out,
    employee_size_excluded: out.filter((c) => c.exclusion === "employee_size").length,
    employee_size_excluded_at_discovery: out.filter((c) =>
      c.size_exclusion_basis === "disjoint_declared_band_at_discovery").length,
    eligible_companies: out.filter((c) => c.eligible).length,
    companies_with_trusted_size: withTrustedSize,
    companies_with_description: withDescription,
  };
}

/**
 * Fold a generic result into the YC result the run reports.
 *
 * ── WHY MERGE RATHER THAN REPORT TWO ───────────────────────────────────────
 *
 * `state.prequalification` is what the run REPORTS as its free pre-pass, and
 * the funnel reads `eligible_companies` and `employee_size_excluded` off it.
 * Publishing a second, separate result would leave those numbers describing the
 * YC half of a mixed pool while the run acted on both — the same class of
 * mistake as the old shortlist telemetry, which named a set of companies that
 * had not been the ones investigated.
 *
 * The tier counts are NOT summed into: a generic company has no role tiers and
 * adding zeroes would be honest but pointless, while adding it to
 * `companies_with_commercial_roles` would claim a fact nobody established.
 */
export function mergePrequalification(
  yc: PrequalificationResult, generic: GenericPrequalificationResult,
): PrequalificationResult {
  const seen = new Set(yc.companies.map((c) => c.company_key));
  const added = generic.companies.filter((c) => !seen.has(c.company_key));
  return {
    ...yc,
    total_rows: yc.total_rows + generic.total_rows,
    unique_companies: yc.unique_companies + added.length,
    excluded: [...yc.excluded, ...generic.excluded],
    companies: [...yc.companies, ...added],
    companies_with_open_roles:
      yc.companies_with_open_roles + added.filter((c) => c.has_open_roles).length,
    employee_size_excluded: yc.employee_size_excluded +
      added.filter((c) => c.exclusion === "employee_size").length,
    employee_size_excluded_at_discovery: (yc.employee_size_excluded_at_discovery ?? 0) +
      added.filter((c) => c.size_exclusion_basis === "disjoint_declared_band_at_discovery").length,
    eligible_companies: yc.eligible_companies +
      added.filter((c) => c.eligible).length,
  };
}

/** An empty YC-shaped result, for a pool with no YC rows at all. */
export function emptyPrequalificationResult(): PrequalificationResult {
  return {
    version: PREQUALIFICATION_VERSION,
    total_rows: 0, unique_companies: 0, excluded: [], companies: [],
    tier_a_companies: 0, tier_b_companies: 0, tier_c_only_companies: 0,
    technical_only_companies: 0, companies_with_open_roles: 0,
    companies_with_commercial_roles: 0, companies_with_technical_roles: 0,
    technical_roles_satisfy_signal: false, any_open_role_satisfies_signal: false,
    employee_size_excluded: 0, eligible_companies: 0,
  };
}

/**
 * HOW MANY OF THESE ROWS ARE WORTH CONTINUING WITH.
 *
 * ── WHY DISCOVERY NEEDS THIS, AND WHY IT IS NOT A NEW GATE ────────────────
 *
 * The discovery loop used to decide it was finished by counting ROWS. A
 * provider that returned fifty unusable rows was indistinguishable from one
 * that returned fifty good ones, so `shouldRunSelection` could never reach a
 * `breadth` or `fallback` actor: the pool always looked full. Run 7e71d8bc is
 * the worked example — fifty rows, sixteen of them outside the mission's own
 * employee range, discovery satisfied, quota unmet.
 *
 * This is deliberately NOT a second admission system. It is one call into
 * `prequalifyDiscoveredCompanies` — the same free, deterministic, GPT-free and
 * provider-free pass the engine already runs later — reading the count it
 * already computes. Anything that changes what `eligible` means changes this
 * number by construction, which is the only way the two can be kept honest.
 *
 * v1 admission is exactly what that pass already enforces:
 *   * a usable identity — a row with neither name nor domain is not a company;
 *   * a directory/platform artifact, or a placeholder employer page, is not a
 *     prospect;
 *   * the employee range, and ONLY when the mission itself expressed one.
 *
 * No geography. Presence semantics are unchanged, and HQ filtering is not
 * introduced here or anywhere in this change.
 */
export function admittedCandidateCount(
  companies: readonly NormalizedHiringCompany[],
  size: GenericSizeBounds = {},
  policy: GenericPrequalificationPolicy = {},
): number {
  // A row whose REPORTED band is outside an enforced range is no longer
  // excluded when enrichment can cheaply settle it (it is ranked down, and
  // decided on the company record's proven band). It still does not count toward "enough
  // candidates": sizing discovery on rows we already expect to fail is how a
  // pool of 12 usable companies and 38 far too large would read as full.
  return prequalifyDiscoveredCompanies(companies, size, policy).companies
    .filter((c) => isAdmitted(c, policy)).length;
}

/**
 * ADMITTED: counts toward "does discovery have enough candidates".
 *
 * Eligible, and — under an enforced range — not reported outside it. A row
 * ranked down on its reported size stays investigable (enrichment decides) but
 * is not the kind of candidate discovery should size its pool on. One
 * predicate, so the engine's live count and this one cannot disagree.
 */
export function isAdmitted(
  c: Pick<PrequalifiedCompany, "eligible" | "size_status">, policy: GenericPrequalificationPolicy = {},
): boolean {
  const enforce = policy.size_enforceable !== false;
  return c.eligible && !(enforce && (c.size_status === "above_max" || c.size_status === "below_min"));
}
