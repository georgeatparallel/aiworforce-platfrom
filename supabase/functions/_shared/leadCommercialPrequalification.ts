// FREE PREQUALIFICATION — decide who is worth paying for, before paying.
//
// TEST task c8a6e53d-c227-4405-9fcc-e0791b03a4ec discovered 25 YC companies for
// one memo23 run, then issued ONE paid Actor start per company to resolve a
// LinkedIn identity — 16 runs, every one returning zero rows, until the edge
// function hit its wall clock and the plan hung in Running forever.
//
// Two things were wrong. The lookup used an ENRICHMENT actor as a search index
// (`harvestapi/linkedin-company` with `searches: ["Scale AI"]` returns nothing).
// And it paid to identify companies nobody had yet decided were worth
// identifying.
//
// memo23 already returns everything needed to make that decision for free:
// every company's FULL `openJobs` array, team size, batch, industries and
// one-liner. This module reads that payload and ranks companies by COMMERCIAL
// EXPANSION strength, so the paid LinkedIn stage only ever runs for a bounded
// shortlist.
//
// WHY TIERS RATHER THAN A KEYWORD MATCH. "Senior Software Engineer" and "Head of
// Sales" are both hiring. Only one of them means a company is building a
// go-to-market motion, which is what this mission is actually looking for. A
// flat keyword list cannot express that, and the previous code did not try —
// it displayed `openJobs[0]`, which for a YC startup is almost always an
// engineer.
//
// PURE. No network, provider, model or database access.

import {
  classifyTitle, type SignalTier, type TitleClass, type RoleVocabulary,
} from "./commercialSignalPolicy.ts";

export const PREQUALIFICATION_VERSION = "commercial-prequalification-v1" as const;

export type { SignalTier };

/**
 * Directory and platform artifacts that are not prospects.
 *
 * Y Combinator's own page appeared as a "company" on an earlier run and was
 * counted as a qualified lead.
 */
export const ARTIFACT_DOMAINS: readonly string[] = Object.freeze([
  "ycombinator.com", "workatastartup.com", "news.ycombinator.com",
]);

const lc = (v: unknown) => typeof v === "string" ? v.trim().toLowerCase() : "";

/** Strip protocol, `www.`, path and trailing dot. The canonical internal key. */
export function normalizeDomain(website: unknown): string | null {
  const raw = lc(website).replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").replace(/\.$/, "");
  return raw && raw.includes(".") ? raw : null;
}

export function normalizeCompanyName(name: unknown): string {
  return lc(name).replace(/[.,]/g, "").replace(/\s+(inc|llc|ltd|corp|co)$/i, "").replace(/\s+/g, " ").trim();
}

/**
 * Which tier a single job title belongs to.
 *
 * DELEGATES to the canonical policy. It used to own a private copy of the tier
 * lists, and `hiring_verification` owned a different one — which is how a
 * company could be scored Tier A here and found to have no commercial signal one
 * capability later. A role list that lives in two places disagrees in two places.
 */
export function classifyJobTitle(title: unknown, vocab?: RoleVocabulary | null): TitleClass {
  return classifyTitle(title, vocab);
}

export interface YcCompanyInput {
  name?: string | null;
  website?: string | null;
  teamSize?: number | null;
  batch?: string | null;
  industries?: string[] | null;
  oneLiner?: string | null;
  allLocations?: string | null;
  url?: string | null;
  id?: number | string | null;
  openJobs?: Array<{ title?: string | null; url?: string | null }> | null;
}

/**
 * The dedupe key for one raw provider row.
 *
 * Exported so the ENGINE derives a row's key with the same code that built the
 * shortlist. Recomputing it with a lookalike helper is how a shortlist and its
 * companies quietly stop referring to the same set.
 */
export function prequalificationKey(row: Pick<YcCompanyInput, "name" | "website">): string {
  return normalizeDomain(row?.website) ?? `name:${normalizeCompanyName(row?.name)}`;
}

export type ExclusionKind =
  | "artifact" | "duplicate" | "technical_only" | "employee_size" | "insufficient_commercial";

export interface PrequalifiedCompany {
  company_key: string;
  name: string;
  canonical_domain: string | null;
  yc_url: string | null;
  yc_id: string | null;
  team_size: number | null;
  batch: string | null;
  one_liner: string | null;
  locations: string | null;
  /** Every job, classified. The FULL array — never just the first. */
  jobs: Array<{ title: string; tier: SignalTier | "technical" | "other" }>;
  /**
   * A FACT, not a verdict: does this company have any open role at all?
   *
   * Separated from `best_tier` deliberately. "Is it hiring?" and "is it hiring
   * someone commercial?" are different questions, and collapsing them is what
   * made a mission asking for engineering hires read as `technical_only`.
   */
  has_open_roles: boolean;
  tier_a: number;
  tier_b: number;
  tier_c: number;
  technical: number;
  /** Highest tier with real evidence. C alone requires a second signal. */
  best_tier: SignalTier | null;
  score: number;
  /** The single strongest commercial role, for display. Never `openJobs[0]`. */
  strongest_signal: string | null;
  size_fit: boolean;
  /**
   * HARD ELIGIBILITY, decided before any paid call.
   *
   * `size_unverified` is NOT a pass. It ranks below every verified in-range
   * company and is only reachable when more candidates are genuinely needed.
   */
  size_status: "in_range" | "below_min" | "above_max" | "size_unverified";
  eligible: boolean;
  exclusion: ExclusionKind | null;
  /**
   * WHY an `employee_size` exclusion was allowed to fire before enrichment, so
   * each basis can be counted on its own. Absent on the YC pass and on every
   * row that was not size-excluded.
   *   proven_band                          the band's source proves size;
   *   no_cheap_identity                    settling it would first need a paid
   *                                        identity search;
   *   disjoint_declared_band_at_discovery  a declared band clearly outside the
   *                                        range, on a strong LinkedIn identity
   *                                        (leadGenericPrequalification.ts).
   */
  size_exclusion_basis?: "proven_band" | "no_cheap_identity" | "disjoint_declared_band_at_discovery" | null;
  reasons: string[];
  /** Domain is sufficient internal identity; LinkedIn is resolved later. */
  linkedin_identity_status: "unresolved";
  identity_confidence: "domain_exact" | "name_only";
}

/** Excluded before any scoring. Returned so the dry run can show them. */
export interface ExcludedArtifact { name: string; domain: string | null; reason: string; }

export interface PrequalificationResult {
  version: typeof PREQUALIFICATION_VERSION;
  total_rows: number;
  unique_companies: number;
  excluded: ExcludedArtifact[];
  companies: PrequalifiedCompany[];
  tier_a_companies: number;
  tier_b_companies: number;
  tier_c_only_companies: number;
  technical_only_companies: number;
  /** How many companies have ANY open role. A fact, independent of policy. */
  companies_with_open_roles: number;
  companies_with_commercial_roles: number;
  companies_with_technical_roles: number;
  /** Whether the mission accepted technical roles as its hiring evidence. */
  technical_roles_satisfy_signal: boolean;
  /** Whether the mission accepted ANY open role as its hiring evidence. */
  any_open_role_satisfies_signal: boolean;
  /** Real commercial signal but a KNOWN out-of-range headcount. */
  employee_size_excluded: number;
  /** Of those, settled at discovery on a clearly disjoint declared band. Absent before 2026-10-11. */
  employee_size_excluded_at_discovery?: number;
  eligible_companies: number;
}

interface SizeBounds { min?: number | null; max?: number | null }

/**
 * What the Mission decided, for the stages that used to answer to the workspace
 * Brain alone. Omitted entirely on a missionless run, where behaviour is
 * unchanged.
 */
export interface PrequalificationMissionPolicy {
  /** The run's single role vocabulary. */
  vocabulary?: RoleVocabulary | null;
  /**
   * May a size bound REJECT?
   *
   * False when the Mission expressed no employee range: the workspace Brain's
   * bounds still order the shortlist, but they may not exclude, because nothing
   * the user asked for mentioned company size. This is the rule that keeps the
   * 7 `employee_size` exclusions from TEST run cf6cce3d.
   */
  size_enforceable?: boolean;
  /**
   * Does the MISSION's required signal accept a technical role as evidence?
   *
   * True when the user asked for hiring in an engineering/technical role family
   * — "AI startups currently hiring software engineers". A backend-engineer
   * opening then IS the evidence the mission wants, and calling the company
   * `technical_only / ineligible` states the opposite of the truth.
   *
   * Absent means the previous behaviour: only a commercial tier counts.
   */
  technical_roles_satisfy_signal?: boolean;
  /**
   * Does the MISSION's required signal accept ANY open role as evidence?
   *
   * True when the mission requires hiring and names NO role family — "AI
   * startups in the US currently hiring". The user constrained the company,
   * not the vacancy, so the evidence they asked for is "this company has an
   * opening", full stop. Which department it is in is a fact about the
   * company, not a condition on it.
   *
   * THIS IS THE RULE TEST RUN 486928e8 WAS MISSING. `technical_roles_satisfy_
   * signal` only fires when the mission NAMES an engineering role family, and
   * an unqualified "currently hiring" names none — so all 100 discovered
   * companies were judged against a commercial-roles rule the user never
   * asked for: 78 excluded as `technical_only`, 20 more as
   * `insufficient_commercial` despite having open roles that classified as
   * neither. Eligible: zero. Nothing was shortlisted, enriched or qualified,
   * and the run reported "0 of 10" as though the pool had been bad.
   *
   * A mission that DOES name a role family is unaffected: it keeps its
   * narrower rule, and an engineering opening still proves nothing about GTM
   * expansion when GTM expansion is what was asked for.
   */
  any_open_role_satisfies_signal?: boolean;
}

/**
 * Score and rank YC rows without spending anything.
 *
 * Deduplicated on domain first, then normalized name — the same precedence the
 * internal identity uses, so two rows for one company cannot become two
 * shortlist slots.
 */
export function prequalifyYcCompanies(
  rows: readonly YcCompanyInput[], size: SizeBounds = {},
  missionPolicy: PrequalificationMissionPolicy = {},
): PrequalificationResult {
  const vocab = missionPolicy.vocabulary ?? null;
  // Default TRUE preserves the pre-Mission behaviour exactly.
  const sizeEnforceable = missionPolicy.size_enforceable !== false;
  /** See `technical_roles_satisfy_signal`. Defaults to the previous behaviour. */
  const technicalSatisfies = missionPolicy.technical_roles_satisfy_signal === true;
  /** See `any_open_role_satisfies_signal`. Defaults to the previous behaviour. */
  const anyOpenRoleSatisfies = missionPolicy.any_open_role_satisfies_signal === true;
  /**
   * Does this company's non-commercial hiring count as the mission's evidence?
   *
   * One predicate, read twice below — by `eligible` and by `exclusion`. They
   * were two copies of the same expression, which is how a verdict and its
   * stated reason drift apart.
   */
  const roleEvidence = (openRoles: number, technical: number): boolean =>
    (anyOpenRoleSatisfies && openRoles > 0) || (technicalSatisfies && technical > 0);
  const excluded: ExcludedArtifact[] = [];
  const byKey = new Map<string, PrequalifiedCompany>();

  for (const r of rows) {
    const name = String(r?.name ?? "").trim();
    const domain = normalizeDomain(r?.website);
    if (!name && !domain) {
      excluded.push({ name: name || "(unnamed)", domain, reason: "no name and no website — not a company row" });
      continue;
    }
    if (domain && ARTIFACT_DOMAINS.includes(domain)) {
      excluded.push({ name, domain, reason: "directory/platform artifact, not a prospect" });
      continue;
    }
    const key = prequalificationKey(r);
    if (byKey.has(key)) continue;

    const jobs = (r.openJobs ?? [])
      .map((j) => ({ title: String(j?.title ?? "").trim(), tier: classifyJobTitle(j?.title, vocab) }))
      .filter((j) => j.title.length > 0);

    const tier_a = jobs.filter((j) => j.tier === "A").length;
    const tier_b = jobs.filter((j) => j.tier === "B").length;
    const tier_c = jobs.filter((j) => j.tier === "C").length;
    const technical = jobs.filter((j) => j.tier === "technical").length;

    // TIER C ALONE IS NOT EVIDENCE. "Head of Operations" at a startup may be an
    // office manager; it counts only beside another commercial opening.
    const commercial = tier_a + tier_b;
    const best_tier: SignalTier | null =
      tier_a > 0 ? "A" : tier_b > 0 ? "B" : (tier_c > 1 ? "C" : null);

    const team = typeof r.teamSize === "number" ? r.teamSize : null;
    const size_status: PrequalifiedCompany["size_status"] =
      team === null ? "size_unverified"
      : (size.min != null && team < size.min) ? "below_min"
      : (size.max != null && team > size.max) ? "above_max"
      : "in_range";
    const size_fit = size_status === "in_range";

    const reasons: string[] = [];
    let score = 0;
    if (tier_a > 0) { score += 100 + (tier_a - 1) * 20; reasons.push(`${tier_a} Tier-A commercial role(s)`); }
    if (tier_b > 0) { score += 40 * Math.min(tier_b, 3); reasons.push(`${tier_b} Tier-B commercial role(s)`); }
    if (best_tier === "C") { score += 15; reasons.push(`${tier_c} Tier-C roles with mutual support`); }
    if (commercial >= 2) { score += 25; reasons.push("multiple commercial openings"); }
    if (size_fit) { score += 30; reasons.push(`team size ${team} inside the target range`); }
    else if (size_status === "above_max") reasons.push(`team size ${team} exceeds the maximum — excluded before any paid call`);
    else if (size_status === "below_min") reasons.push(`team size ${team} is below the minimum — excluded before any paid call`);
    else reasons.push("team size unverified — ranks below every verified in-range company");
    if ((r.industries ?? []).some((i) => lc(i) === "b2b")) { score += 10; reasons.push("YC industry B2B"); }
    // THE MISSION DECIDES WHETHER THIS SENTENCE IS TRUE. Under a mission that
    // asked only for "currently hiring", a technical opening IS the evidence,
    // and printing "not commercial evidence" beside it states the opposite of
    // what the run concluded — the reason line and the verdict must agree.
    if (technical > 0 && commercial === 0) {
      reasons.push(anyOpenRoleSatisfies || technicalSatisfies
        ? `${technical} technical role(s) — the mission accepts these as hiring evidence`
        : `${technical} technical role(s) only — not commercial evidence`);
    }

    const strongest = jobs.find((j) => j.tier === "A") ?? jobs.find((j) => j.tier === "B")
      ?? (best_tier === "C" ? jobs.find((j) => j.tier === "C") : undefined);

    byKey.set(key, {
      company_key: key,
      name: name || key,
      canonical_domain: domain,
      yc_url: r.url ?? null,
      yc_id: r.id != null ? String(r.id) : null,
      team_size: team,
      batch: r.batch ?? null,
      one_liner: r.oneLiner ?? null,
      locations: r.allLocations ?? null,
      jobs, tier_a, tier_b, tier_c, technical, best_tier, score,
      has_open_roles: jobs.length > 0,
      strongest_signal: strongest?.title ?? null,
      size_fit, size_status,
      // A KNOWN out-of-range size is disqualifying on its own. Apollo (200) and
      // Magic (350) each have a real commercial opening and are still wrong for
      // a 10-150 mission; paying to resolve them buys a lead that can never
      // pass the Brain gate.
      // ── THE MISSION DECIDES WHAT THE FACTS MEAN ───────────────────────
      //
      // This read `best_tier !== null` — the highest COMMERCIAL role tier — so
      // a company hiring only engineers was `technical_only` and ineligible
      // even when the user had asked for exactly that. The counts above are
      // facts; this line is the interpretation, and interpretation belongs to
      // the mission.
      //
      // `technicalSatisfies` is derived from the mission's own required signal,
      // never from the request's wording — there is no "if AI startup" here and
      // there must not be.
      //
      // `roleEvidence` is the whole of that interpretation, in one place.
      // Widest first: a mission that constrained no role family accepts any
      // opening; one that named engineering families accepts a technical
      // opening; a missionless run keeps the commercial-only rule it always
      // had.
      eligible: (best_tier !== null || roleEvidence(jobs.length, technical)) &&
        (!sizeEnforceable || (size_status !== "above_max" && size_status !== "below_min")),
      exclusion: (sizeEnforceable && (size_status === "above_max" || size_status === "below_min"))
        ? "employee_size"
        : (best_tier === null && !roleEvidence(jobs.length, technical))
        ? (technical > 0 ? "technical_only" : "insufficient_commercial")
        : null,
      reasons,
      linkedin_identity_status: "unresolved",
      identity_confidence: domain ? "domain_exact" : "name_only",
    });
  }

  const rank = (c: PrequalifiedCompany) => c.size_status === "in_range" ? 0 : 1;
  const companies = [...byKey.values()].sort((a, b) =>
    rank(a) - rank(b) || b.score - a.score || a.name.localeCompare(b.name));

  return {
    version: PREQUALIFICATION_VERSION,
    total_rows: rows.length,
    unique_companies: companies.length,
    excluded,
    companies,
    tier_a_companies: companies.filter((c) => c.best_tier === "A").length,
    tier_b_companies: companies.filter((c) => c.best_tier === "B").length,
    tier_c_only_companies: companies.filter((c) => c.best_tier === "C").length,
    technical_only_companies: companies.filter((c) => c.exclusion === "technical_only").length,
    // FACTS, reported next to the verdict so an audit can see what the pool
    // actually contained rather than only what the policy concluded about it.
    companies_with_open_roles: companies.filter((c) => c.has_open_roles).length,
    companies_with_commercial_roles: companies.filter((c) => c.best_tier !== null).length,
    companies_with_technical_roles: companies.filter((c) => c.technical > 0).length,
    technical_roles_satisfy_signal: technicalSatisfies,
    any_open_role_satisfies_signal: anyOpenRoleSatisfies,
    employee_size_excluded: companies.filter((c) => c.exclusion === "employee_size").length,
    eligible_companies: companies.filter((c) => c.eligible).length,
  };
}

// ------------------------------------------------------------- shortlist ----
//
// ── DELETED: `DEFAULT_SHORTLIST_CEILING`, `shortlistSize`,
//            `shortlistForLinkedInResolution` ────────────────────────────────
//
// `shortlistSize(n) = min(10, max(5, n * 2))` derived how many companies could
// be PAID FOR from how many leads the user ASKED FOR. Two unrelated quantities
// collapsed into one number, and the `× 2` encoded an assumed 50% yield that
// nothing measured.
//
// `shortlistForLinkedInResolution` then filtered on `c.eligible` — the
// substring match over a compiled role vocabulary — so a company hiring a
// "Founding Engineer" for a Mission asking for software engineers was removed
// before any stage could reconsider it.
//
// Both are replaced by `leadInvestigationBudget`:
//
//   resolveInvestigationBudget   spend, as its own configurable quantity
//   buildSmartShortlist          who to spend it on, GPT first, vocabulary as
//                                a ranking hint that excludes nobody
//
// The old pair was still being CALLED by `applyPrequalification`, whose result
// `applyMissionIntelligence` then overwrote — so it shaped the reported
// shortlist while the smart shortlist decided the real one.

/**
 * Maximum simultaneous paid Actor starts in the resolution stage.
 *
 * ── WHY THIS IS 4 AND NOT 2 ────────────────────────────────────────────────
 *
 * It bounds how many identity searches are IN FLIGHT, not how many are made:
 * the slice decides that, and the count budget decides the slice. Widening the
 * lanes changes the rate of spend, never its total.
 *
 * What it does change is how much of the run the identity stage can use. On
 * task 83843770 an identity call took ~7.6s and the stage had ~19s; at two
 * lanes that is five companies of a ten-company slice, and the other five were
 * deferred with the run ending 8 short of the requested 10. Latency, not
 * budget, was deciding how many companies got investigated.
 *
 * The ceiling on this is the provider's own concurrent-run limit rather than
 * anything here, which is why it is a small number and not a large one.
 */
export const LINKEDIN_RESOLUTION_CONCURRENCY = 4;

/**
 * The search query for one shortlisted company — THE BARE NAME.
 *
 * This used to return `` `${name} ${domain}` ``. The reasoning was that the
 * domain gave the matcher corroborating evidence; the effect was that all six
 * searches on TEST task 42e39fb1 returned ZERO rows.
 *
 * `harvestapi/linkedin-company-search` matches on company NAME — the Actor card
 * has carried that as a known defect since the benchmark. "SnapMagic
 * snapmagic.com" is not a company name, so LinkedIn's name index matched
 * nothing, six paid runs produced nothing, and every downstream capability
 * correctly reported zero.
 *
 * THE DOMAIN'S JOB IS ON THE WAY BACK, not on the way out. `acceptLinkedInMatch`
 * already compares the returned company's website against
 * `canonical_domain`, which is where an identity is actually proven. Putting it
 * in the query bought nothing and cost the lookup.
 */
export function linkedInSearchQueryFor(c: PrequalifiedCompany): string {
  return normalizeCompanySearchName(c.name);
}

/**
 * The domain a returned candidate must corroborate. Never sent to the Actor.
 */
export function expectedDomainFor(c: PrequalifiedCompany): string | null {
  return c.canonical_domain;
}

/**
 * Trim a company name down to something a NAME index can match.
 *
 * Deliberately conservative: it strips what is provably not part of a name
 * (URLs, bare domains, protocol strings) and leaves everything else alone.
 * "Tara AI" and "Y Combinator" are real names and must survive untouched.
 */
export function normalizeCompanySearchName(name: unknown): string {
  return String(name ?? "")
    .split(/\s+/)
    .filter((tok) => tok && !looksLikeDomainToken(tok))
    .join(" ")
    .trim();
}

/** Common TLDs seen in this corpus, plus the shape of a hostname. */
const DOMAINISH = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|io|ai|co|net|org|dev|app|xyz|inc|tech|so|to|sh|me|us|uk|de|fr|ca)\b/i;

export function looksLikeDomainToken(token: string): boolean {
  const t = token.trim().toLowerCase().replace(/[(),]/g, "");
  if (!t) return false;
  if (t.includes("@")) return true;                 // email-like
  if (t.startsWith("http://") || t.startsWith("https://")) return true;
  if (t.includes("/")) return true;                 // any URL path
  return DOMAINISH.test(t);
}

// ------------------------------------------------------- match acceptance ----

export interface CandidateMatch {
  name?: string | null;
  website?: string | null;
  linkedinUrl?: string | null;
  description?: string | null;
  location?: string | null;
}

/**
 * `corroborated_unconfirmed`: the name matched and something else agreed (the
 * LinkedIn slug, the description), but no WEBSITE confirmed the domain. Recorded
 * as evidence, never accepted as an identity — see `acceptLinkedInMatch`.
 */
export type MatchStrength = "domain_exact" | "corroborated_unconfirmed" | "rejected_weak";

/**
 * WHICH PATH DECIDED, as a stable key.
 *
 * `reason` is prose built for a human reading one decision. It embeds the
 * company's own domain and slug, so it can never be counted — and counting is
 * the whole question here. TEST run 958c86bc rejected 9 of the 20 companies
 * that reached a verdict, and nothing in any persisted record said which of the
 * four acceptance paths nearly fired or what stopped it, because the engine
 * read `.accepted` and discarded the rest.
 *
 * These are the axis a run can be measured along:
 *
 *   domain_exact                       LinkedIn's own website matched ours — the ONLY accepting code
 *   domain_mismatch                    LinkedIn's website names a DIFFERENT domain — refused
 *   name_and_slug                      names equal, slug agrees with our domain, no website — evidence only
 *   name_and_prose                     names equal, description/location carries the domain, no website — evidence only
 *   name_and_one_liner                 names equal, the YC one-liner is echoed, no website — evidence only
 *   name_matched_nothing_corroborated  names equal and NOTHING else agreed
 *   no_name_or_domain_match            the name gate refused before any of that
 *
 * The last two are the ones worth telling apart. A run full of the first means
 * corroboration is too strict; a run full of the second means the NAME GATE is,
 * and those need opposite fixes.
 */
export type MatchOutcomeCode =
  | "domain_exact"
  | "domain_mismatch"
  | "name_and_slug"
  | "name_and_prose"
  | "name_and_one_liner"
  | "name_matched_nothing_corroborated"
  | "no_name_or_domain_match";

/**
 * Accept a LinkedIn search result for a company — or refuse it.
 *
 * A name-only match is REFUSED. "Apollo", "Hub", "Magic" and "Streak" are real
 * YC companies and also extremely common words; accepting a bare name match
 * would attach a founder from the wrong company, which is worse than returning
 * nothing.
 */
/**
 * A comparable identity string: lowercase, alphanumerics only.
 *
 * "Retell AI", "retellai.com" and the slug "retell-ai" all reduce to
 * `retellai`. Comparing raw strings across those three shapes is why a company
 * could match by every human measure and none of the code's.
 */
const identityToken = (v: unknown) => lc(v).replace(/[^a-z0-9]/g, "");

/** The `<slug>` of a `linkedin.com/company/<slug>` URL, tokenised. */
export function linkedInSlugToken(url: unknown): string {
  const path = lc(url).replace(/[?#].*$/, "").replace(/\/+$/, "");
  const m = /\/company\/([^/]+)/.exec(path);
  return m ? identityToken(m[1]) : "";
}

/**
 * Do two identity tokens describe the same company?
 *
 * A PREFIX RELATION IN EITHER DIRECTION, because the two sources shorten
 * differently and neither is authoritative:
 *
 *   godela.ai      → `godela`      vs slug `godela-ai`  → `godelaai`
 *   agentmail.to   → `agentmail`   vs slug `agentmailto`
 *   reacherapp.com → `reacherapp`  vs slug `reacher`
 *
 * Four characters minimum: below that, prefixes stop being evidence.
 */
function tokensAgree(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function acceptLinkedInMatch(
  company: PrequalifiedCompany, candidate: CandidateMatch,
): { accepted: boolean; strength: MatchStrength; reason: string; code: MatchOutcomeCode } {
  const candDomain = normalizeDomain(candidate.website);
  if (company.canonical_domain && candDomain && candDomain === company.canonical_domain) {
    return {
      accepted: true, strength: "domain_exact", code: "domain_exact",
      reason: `domain ${candDomain} matches exactly`,
    };
  }
  const sameName = normalizeCompanyName(candidate.name) === normalizeCompanyName(company.name);
  // ── A WEBSITE THAT NAMES ANOTHER DOMAIN IS EVIDENCE AGAINST ──────────────
  //
  // The candidate told us where it lives, and it is not where our company
  // lives. No name, slug or description can outvote that.
  if (sameName && company.canonical_domain && candDomain && candDomain !== company.canonical_domain) {
    return {
      accepted: false, strength: "rejected_weak", code: "domain_mismatch",
      reason: `name matches but the LinkedIn website is ${candDomain}, not ${company.canonical_domain}`,
    };
  }
  if (sameName) {
    // ── WHAT MAY CORROBORATE A NAME ─────────────────────────────────────
    //
    // The rule is unchanged and correct: a bare name match is not an identity.
    // "Apollo", "Magic", "Hub" and "Streak" are real YC companies and also
    // ordinary words, and accepting one on its name attaches a founder from
    // the wrong company. What was wrong was the EVIDENCE the rule accepted.
    //
    // On task 9e86eb24 ten identity searches returned rows for eight
    // companies and only three were accepted. Five were rejected here, with a
    // name that matched exactly: Retell AI, David AI, Reacher, Simple AI,
    // Artisan, Sixtyfour. Every one of them is a real company the search had
    // found.
    //
    // Both old tests were substring tests against PROSE:
    //
    //   hay.includes(token)  `token` is the domain's first label, so
    //                        "retellai" was looked for inside a description
    //                        that writes it "Retell AI". "usesimple",
    //                        "withdavid" and "reacherapp" can never appear in
    //                        prose at all.
    //   hay.includes(one_liner.slice(0, 24))
    //                        requires 24 verbatim characters shared between a
    //                        YC one-liner and a LinkedIn description — two
    //                        independently written marketing texts. Essentially
    //                        never true.
    //
    // So in practice the branch accepted almost nothing, and the identity
    // stage's yield was set by a substring coincidence.
    const domainToken = identityToken(company.canonical_domain?.split(".")[0] ?? "");
    const hayToken = identityToken(`${candidate.description} ${candidate.location}`);

    // ── ONE AUTHORITY: CORROBORATION IS EVIDENCE, NOT AN IDENTITY ─────────
    //
    // These three paths used to ACCEPT, while the resolver that actually
    // decides identity (`resolveIdentityAgainstLookups`) required a website
    // domain and refused the same candidates. Lead V2 run 4250f181 logged
    // "11 accepted" and "0 resolved" in one line. There can be one answer, and
    // it is the stricter one: in that same run LinkedIn returned "Every Inc."
    // (slug `everyinc`, a New York media company) for every.io — the slug
    // agrees with the domain token by prefix, the names normalise equal, and
    // this branch would have attached the wrong company. A website is what
    // tells two companies with one name apart; the identity search now buys
    // `full` rows precisely so that it has one.
    //
    // The codes stay, so the diagnostics still say which evidence was present.
    //
    // ── THE SIGNAL THAT WAS SITTING UNUSED ──────────────────────────────
    //
    // `candidate.linkedinUrl` is on `CandidateMatch` and was never read. Its
    // slug is chosen by the company on LinkedIn and is INDEPENDENT of the YC
    // record we are matching against — which is exactly what corroboration
    // needs. Deliberately compared against our DOMAIN and not our name: in
    // this branch the names already match, and a LinkedIn slug is derived from
    // the LinkedIn name, so slug-vs-name would only restate the thing we are
    // trying to corroborate.
    const slug = linkedInSlugToken(candidate.linkedinUrl);
    if (tokensAgree(slug, domainToken)) {
      return {
        accepted: false, strength: "corroborated_unconfirmed", code: "name_and_slug",
        reason: `name matches and the LinkedIn slug "${slug}" agrees with domain "${domainToken}", ` +
          "but no website confirms the domain",
      };
    }
    // Prose, compared as tokens so "Retell AI" contains "retellai".
    if (domainToken.length > 3 && hayToken.includes(domainToken)) {
      return {
        accepted: false, strength: "corroborated_unconfirmed", code: "name_and_prose",
        reason: "name matches and description/location corroborates, but no website confirms the domain",
      };
    }
    if (company.one_liner) {
      const onelinerToken = identityToken(company.one_liner).slice(0, 24);
      if (onelinerToken.length >= 16 && hayToken.includes(onelinerToken)) {
        return {
          accepted: false, strength: "corroborated_unconfirmed", code: "name_and_one_liner",
          reason: "name matches and the company description corroborates, but no website confirms the domain",
        };
      }
    }
    return {
      accepted: false, strength: "rejected_weak",
      code: "name_matched_nothing_corroborated",
      reason: "name matches but nothing corroborates it — a bare name match is not an identity",
    };
  }
  return {
    accepted: false, strength: "rejected_weak", code: "no_name_or_domain_match",
    reason: "neither domain nor name matches",
  };
}
