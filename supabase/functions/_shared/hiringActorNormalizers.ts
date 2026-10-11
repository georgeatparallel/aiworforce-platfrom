// NORMALIZERS — Actor rows into Agentory's canonical company/job/person shapes.
//
// Built ONLY from fields observed in live output on 2026-08-01. Where an Actor
// does not supply a field, the normalizer emits null and records WHY in
// `missing_fields`. It never infers one field from another: the benchmark's
// central lesson is that a plausible-looking value from the wrong field
// (one LinkedIn size figure standing in for another, a provider industry label
// standing in for a real industry) is worse than an honest null, because a null
// stops a gate while a wrong value passes one.
//
// Pure. No I/O.

import { linkedInAssociatedMemberCount, linkedInDeclaredSizeBand, type CompanySizeBand } from "./companySize.ts";
import { normalizeCompanyLinkedInUrl, normalizeWebsite, sanitizeUrl } from "./structuredCompanyEnrichment.ts";

export type FieldTrust = "direct" | "alias" | "transformed" | "semantic" | "unsafe";

export interface NormalizedHiringCompany {
  /** Namespaced so YC id 705 never collides with LinkedIn id 705. */
  external_source_id: string;
  company_name: string | null;
  canonical_domain: string | null;
  linkedin_company_url: string | null;
  website: string | null;
  description: string | null;
  /** The provider's own label. NEVER proof of industry. */
  provider_industry: string | null;
  /** LinkedIn industry id + hierarchy, when enrichment supplied it. */
  industry_ids: Array<{ id: string; name: string; hierarchy: string | null }>;
  /**
   * LinkedIn ASSOCIATED MEMBERS — members who list this company as a current
   * position. NOT a staff headcount (see companySize.ts): it never passes,
   * fails or contests a size claim. Informational only.
   */
  linkedin_associated_member_count: number | null;
  /**
   * The company's DECLARED size band (LinkedIn About tab, `employeeCountRange`).
   * The canonical answer to an "N–M employees" criterion. Structured, never text.
   */
  company_size_band: CompanySizeBand | null;
  /**
   * A NON-LinkedIn provider's own size wording (YC `teamSize`, a funding
   * bucket). ADVISORY text; never the LinkedIn band, which is structured above.
   */
  employee_range_advisory: string | null;
  geography: string | null;
  /**
   * The structured locations `geography` was rendered from, when the provider
   * sent them — each with its own headquarters flag and country. Facts only:
   * how much they prove is `evidenceAuthority`'s decision.
   */
  location_entries?: LinkedInLocationEntry[];
  /** Ownership type ("Privately Held"), NOT a business model. */
  company_type: string | null;
  /** YC vertical/batch evidence. Kept out of canonical industry on purpose. */
  startup_evidence: Record<string, unknown> | null;
  hiring_status: boolean | null;
  source_provenance: string;
  /** Field-level trust, so downstream never has to guess. */
  field_trust: Record<string, FieldTrust>;
  missing_fields: string[];
  /** Raw row kept for evidence refs; never re-derived from. */
  raw_ref: { actor_key: string; source_id: string | number | null };
}

export interface NormalizedHiringJob {
  job_id: string | null;
  job_url: string | null;
  title: string | null;
  company_name: string | null;
  company_linkedin_url: string | null;
  company_source_id: string | null;
  location: string | null;
  workplace_mode: string | null;
  posted_date: string | null;
  description: string | null;
  source: string;
  retrieved_at: string | null;
  missing_fields: string[];
}

export interface NormalizedHiringPerson {
  /** STABLE profile id. Dedupe on this, never on the URL. */
  source_profile_id: string | null;
  external_source_id: string;
  full_name: string | null;
  title: string | null;
  /** Opaque ACwAAA... member URL, not a vanity slug. */
  linkedin_url: string | null;
  current_employer: string | null;
  current_employer_linkedin_url: string | null;
  current_employer_is_current: boolean | null;
  tenure_years: number | null;
  source_provenance: string;
  missing_fields: string[];
}

const s = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : null;
};
const n = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function domainFrom(website: unknown): string | null {
  const w = normalizeWebsite(website) ?? s(website);
  if (!w) return null;
  return w.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] || null;
}

function miss(o: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => o[k] === null || o[k] === undefined ||
    (Array.isArray(o[k]) && (o[k] as unknown[]).length === 0));
}

// ── COMPANY: memo23 YC ───────────────────────────────────────────────────────

export function normalizeMemo23Company(r: Record<string, unknown>): NormalizedHiringCompany {
  const out: NormalizedHiringCompany = {
    external_source_id: `yc_memo23:${r.id ?? "unknown"}`,
    company_name: s(r.name),
    canonical_domain: domainFrom(r.website),
    // THIS ACTOR HAS NO LINKEDIN FIELD. Not "missing data" — absent from schema.
    linkedin_company_url: null,
    website: normalizeWebsite(r.website) ?? s(r.website),
    description: s(r.longDescription) ?? s(r.oneLiner),
    // YC "B2B" is a YC VERTICAL, not an industry. Kept out of industry_ids.
    provider_industry: null,
    industry_ids: [],
    // teamSize is self-reported and stale (ShipBob returned 1) — never a band,
    // never a member count; advisory text only.
    linkedin_associated_member_count: null,
    company_size_band: null,
    employee_range_advisory: n(r.teamSize) !== null ? `yc_self_reported:${r.teamSize}` : null,
    geography: s(r.allLocations) ?? (Array.isArray(r.regions) ? (r.regions as string[]).join(", ") : null),
    company_type: null,
    startup_evidence: {
      source: "y_combinator", yc_batch: s(r.batch), yc_status: s(r.status),
      yc_stage: s(r.stage), yc_vertical: s(r.industry), yc_subvertical: s(r.subindustry),
      yc_top_company: r.topCompany === true,
      yc_team_size_self_reported: n(r.teamSize),
    },
    hiring_status: typeof r.isHiring === "boolean" ? r.isHiring : null,
    source_provenance: "memo23/y-combinator-scraper",
    field_trust: {
      company_name: "direct", website: "direct", canonical_domain: "transformed",
      description: "alias", employee_range_advisory: "unsafe",
      startup_evidence: "direct", hiring_status: "direct", geography: "alias",
    },
    missing_fields: [],
    raw_ref: { actor_key: "apify_yc_companies_memo23", source_id: (r.id as number) ?? null },
  };
  out.missing_fields = [
    "linkedin_company_url:absent_from_actor_schema",
    "company_size_band:yc_team_size_is_self_reported_advisory_only",
    "provider_industry:yc_vertical_is_not_an_industry",
    ...miss(out as unknown as Record<string, unknown>, ["company_name", "website", "description"]),
  ];
  return out;
}

/** memo23 embeds open jobs on the company row. */
export function normalizeMemo23OpenJobs(
  r: Record<string, unknown>,
): NormalizedHiringJob[] {
  const jobs = Array.isArray(r.openJobs) ? r.openJobs as Record<string, unknown>[] : [];
  return jobs.map((j) => ({
    job_id: j.jobId !== undefined && j.jobId !== null ? `yc_memo23:${j.jobId}` : null,
    job_url: sanitizeUrl(j.url),
    title: s(j.title),
    company_name: s(r.name),
    company_linkedin_url: null,
    company_source_id: `yc_memo23:${r.id ?? "unknown"}`,
    location: s(j.location),
    workplace_mode: null,
    // postedAgo is RELATIVE ("5 days ago"). Converting needs the run timestamp,
    // which the row does not carry, so it stays unresolved rather than guessed.
    posted_date: null,
    description: null,
    source: "memo23/y-combinator-scraper",
    retrieved_at: s(r.scrapedAt),
    missing_fields: [
      "posted_date:actor_returns_relative_postedAgo_only",
      "description:absent_from_openJobs",
      "workplace_mode:absent_from_openJobs",
    ],
  }));
}

// ── COMPANY: solidcode YC ────────────────────────────────────────────────────

export function normalizeSolidcodeCompany(r: Record<string, unknown>): NormalizedHiringCompany {
  const out: NormalizedHiringCompany = {
    external_source_id: `yc_solidcode:${r.companyId ?? "unknown"}`,
    company_name: s(r.name),
    canonical_domain: domainFrom(r.website),
    linkedin_company_url: normalizeCompanyLinkedInUrl(r.linkedin),
    website: normalizeWebsite(r.website) ?? s(r.website),
    description: s(r.longDescription) ?? s(r.shortDescription),
    provider_industry: null,
    industry_ids: [],
    linkedin_associated_member_count: null,
    company_size_band: null,
    employee_range_advisory: n(r.teamSize) !== null ? `yc_self_reported:${r.teamSize}` : null,
    geography: s(r.location) ?? s(r.country),
    company_type: null,
    startup_evidence: {
      source: "y_combinator", yc_batch: s(r.batch), yc_status: s(r.status),
      yc_vertical: s(r.industry), year_founded: n(r.yearFounded),
      yc_team_size_self_reported: n(r.teamSize),
      open_jobs_count: n(r.openJobsCount),
    },
    hiring_status: typeof r.isHiring === "boolean" ? r.isHiring : null,
    source_provenance: "solidcode/ycombinator-scraper",
    field_trust: {
      company_name: "direct", website: "direct", canonical_domain: "transformed",
      linkedin_company_url: "alias", description: "alias",
      employee_range_advisory: "unsafe", startup_evidence: "direct", hiring_status: "direct",
    },
    missing_fields: [],
    raw_ref: { actor_key: "apify_yc_companies_solidcode", source_id: (r.companyId as number) ?? null },
  };
  out.missing_fields = [
    "company_size_band:yc_team_size_is_self_reported_advisory_only",
    "provider_industry:yc_vertical_is_not_an_industry",
    ...miss(out as unknown as Record<string, unknown>, ["linkedin_company_url", "website", "description"]),
  ];
  return out;
}

// ── COMPANY: LinkedIn search (CANDIDATE) vs enrichment (AUTHORITATIVE) ───────

function linkedinIndustries(r: Record<string, unknown>) {
  const arr = Array.isArray(r.industries) ? r.industries as Record<string, unknown>[] : [];
  return arr.filter((x) => x && typeof x === "object").map((x) => ({
    id: String(x.id ?? ""), name: String(x.name ?? ""),
    hierarchy: s(x.hierarchy),
  })).filter((x) => x.id || x.name);
}

/**
 * Why a LinkedIn search row is not a company anyone can sell to.
 *
 * A REASON, not a boolean, because the drop is recorded and a count of
 * anonymous exclusions is not auditable.
 */
export type NonCompanyPageReason =
  | "showcase_page"
  | "auto_generated_page"
  | `non_company_page_type:${string}`;

/** LinkedIn page types that are surfaces of a company, not a company. */
const NON_COMPANY_URL_PATH = /linkedin\.com\/(showcase|school)\//i;

/**
 * Is this search row something other than a company?
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * Discovery for run 783fa163 returned 30 rows, of which FIVE were LinkedIn
 * showcase pages: "LinkedIn Guide to Creating", "Zip, a puzzle by LinkedIn",
 * "LinkedIn Guide to Networking", "LinkedIn News" and "Google for Developers".
 * A showcase page is a marketing surface belonging to a parent company. It has
 * no headcount to gate on, nobody to contact, and it DUPLICATES a company
 * already in the pool — LinkedIn News is LinkedIn, Google for Developers is
 * Google.
 *
 * They were not free. `normalizeCompanyLinkedInUrl` requires a `/company/`
 * path, so every showcase row normalised to a null `linkedin_company_url`,
 * which sent identity resolution to its NAME fallback — and it spent a paid
 * search on the literal string "LinkedIn Guide to Creating". Two rows ended the
 * run as `identity_unresolved` for a question that had no answer.
 *
 * One of them was worse than wasted. "LinkedIn News" reports `employeeCount: 8`
 * and was therefore the ONLY row in that entire pool inside the workspace's
 * 1-150 headcount policy — the single company a size-filtered search would have
 * kept. An editorial page was the run's best candidate.
 *
 * ── WHY A DENY-LIST, AND NOT `pageType === "COMPANY"` ──────────────────────
 *
 * Because `pageType` is a `full`-mode field. Identity resolution runs this same
 * Actor in `short` mode, whose rows carry only `followers, id, industry,
 * linkedinUrl, logo, name, summary, universalName, location` — no `pageType`,
 * no `employeeCount` (run xpbBeCelqBx6zU7RF). An allow-list would drop every
 * identity row ever resolved. So: ABSENCE IS NEVER A DROP. When the provider
 * states the page type, believe it; when it does not, the URL path still says
 * `/showcase/` in both modes, and that is the signal that survives.
 *
 * `autoGenerated` is checked too, but note it was FALSE on all 30 rows of that
 * run including the five showcases — it is a real field and a different case,
 * not the one that caught these.
 */
export function nonCompanyPageReason(
  r: Record<string, unknown>,
): NonCompanyPageReason | null {
  if (r.autoGenerated === true) return "auto_generated_page";

  const url = typeof r.linkedinUrl === "string" ? r.linkedinUrl : "";
  if (NON_COMPANY_URL_PATH.test(url)) return "showcase_page";

  const pageType = typeof r.pageType === "string" ? r.pageType.trim() : "";
  if (pageType && pageType.toUpperCase() !== "COMPANY") {
    return pageType.toUpperCase() === "SHOWCASE"
      ? "showcase_page"
      : `non_company_page_type:${pageType.toUpperCase().slice(0, 24)}`;
  }
  return null;
}

/**
 * company-search output. `candidate_only` is always true — this Actor's
 * industry and size filters were both wrong in the benchmark, so nothing here
 * may satisfy a Brain hard gate until enrichment runs.
 */
export function normalizeLinkedInCompanyCandidate(
  r: Record<string, unknown>,
): NormalizedHiringCompany & { candidate_only: true } {
  const inds = linkedinIndustries(r);
  const out: NormalizedHiringCompany & { candidate_only: true } = {
    external_source_id: `li_company:${r.id ?? "unknown"}`,
    company_name: s(r.name),
    canonical_domain: domainFrom(r.website),
    linkedin_company_url: normalizeCompanyLinkedInUrl(r.linkedinUrl),
    website: normalizeWebsite(r.website) ?? s(r.website),
    description: s(r.description),
    // short mode gives `industry` (string); full mode gives `industries` (array).
    provider_industry: inds[0]?.name ?? s(r.industry),
    industry_ids: inds,
    // Two different facts (companySize.ts). Both arrive in FULL mode only:
    // short-mode rows carry neither (run 4250f181, 108 of 108 rows).
    linkedin_associated_member_count: linkedInAssociatedMemberCount(r),
    company_size_band: linkedInDeclaredSizeBand(r),
    employee_range_advisory: null,
    geography: s((Array.isArray(r.locations) && (r.locations as Record<string, unknown>[])[0]
      ? (r.locations as Record<string, unknown>[])[0].linkedinText : null)) ??
      s((r.location as Record<string, unknown> | undefined)?.linkedinText),
    company_type: s(r.companyType),
    startup_evidence: null,
    hiring_status: null,
    source_provenance: "harvestapi/linkedin-company-search",
    field_trust: {
      company_name: "direct", linkedin_company_url: "direct", website: "direct",
      description: "direct", provider_industry: "unsafe",
      linkedin_associated_member_count: "direct", company_size_band: "direct",
      company_type: "semantic", geography: "transformed",
    },
    missing_fields: [],
    raw_ref: { actor_key: "apify_linkedin_company_search", source_id: s(r.id) },
    candidate_only: true,
  };
  out.missing_fields = [
    "provider_industry:filter_returned_wrong_industries_use_enrichment",
    out.company_size_band === null
      ? "company_size_band:absent_on_row_short_mode_or_undeclared"
      : "company_size_band:discovery_row_plausible_until_company_record_read",
    ...(out.linkedin_associated_member_count === null ? ["linkedin_associated_member_count:null_in_short_mode"] : []),
  ];
  return out;
}

/** linkedin-company enrichment. The authoritative company record. */
/**
 * EVERY PLACE THIS COMPANY IS, NOT THE FIRST FIELD THAT PARSED.
 *
 * ── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 *
 * This read `locations[0].linkedinText`. `linkedinText` is a field on the JOB
 * actor's `location`; the COMPANY actor has never emitted it. So the expression
 * was `undefined` on every row and every enriched company carried
 * `geography: null` — not flattened, never populated.
 *
 * `hardFactsForPrompt` hands that null to the evaluator, which then cannot
 * establish where a company is. On lineage e70cbf3a it held four companies for
 * exactly that reason:
 *
 *   Metaview  "four London openings … however, the supplied evidence does not
 *              establish that the company is located in the United Kingdom"
 *   Kody      "a verified SDR opening in London … company geography is not
 *              independently established beyond the job location"
 *
 * Kody's London office was in the payload we had already paid for:
 *
 *   locations: [ { country: "GB", city: "London",    headquarter: false, … },
 *                { country: "CN", city: "Shenzhen",  headquarter: false, … },
 *                { country: "US", city: "Sunnyvale", headquarter: true,  … } ]
 *
 * ── WHY EVERY LOCATION, AND WHY THE HEADQUARTERS IS NOT SPECIAL ────────────
 *
 * Geography means REAL PRESENCE in the requested market, not where the company
 * is registered. Kody and Termgrid are both US-headquartered with genuine
 * London offices, and both are legitimately "in the UK" for a mission that asks
 * for UK companies. Reading `locations[0]`, or filtering to `headquarter:
 * true`, would drop exactly the companies the rule exists to keep.
 *
 * `parsed.text` is preferred because it is the provider's own normalised
 * rendering ("London, United Kingdom"); the raw `city`/`country` pair is the
 * fallback for a row that failed to parse. Order is the provider's, and
 * duplicates are dropped so a company with three London entries reads once.
 */
/** One office, as the provider describes it. */
export interface LinkedInLocationEntry {
  /** "London, United Kingdom" — the provider's rendering, or city+country. */
  text: string;
  /** The provider's own `headquarter` flag. Never inferred from position. */
  is_headquarters: boolean;
  /**
   * The structured country the provider attached to this entry, when it did
   * (`parsed.countryFull`, else `country`). Null when only free text exists —
   * which is what makes a location list ambiguous (see `evidenceAuthority`).
   */
  country: string | null;
}

/**
 * Read `locations[]` into plain text, entry by entry.
 *
 * Extracted so there is ONE implementation of this shape. The Company Brain's
 * company enrichment used to parse the same payload with
 * `asStringArray(row.locations)`, which yields nothing at all for an array of
 * objects — so every company researched through onboarding lost its offices and
 * its headquarters silently, while the call reported success.
 *
 * String entries are OPT-IN. `enrichedGeography` has always treated a bare
 * string inside `locations[]` as malformed (a pinned test: `[null, 3, "x"]` is
 * null, not "x"), and that judgement is not this refactor's to change. The
 * Company Brain path opts in, because the company actors it calls do sometimes
 * send plain strings there.
 */
export function linkedInLocationEntries(
  raw: unknown, opts: { acceptStrings?: boolean } = {},
): LinkedInLocationEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LinkedInLocationEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    let text: string | null = null;
    let hq = false;
    let country: string | null = null;
    if (typeof entry === "string") {
      if (!opts.acceptStrings) continue;
      text = s(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const parsed = e.parsed as Record<string, unknown> | undefined;
      text = s(parsed?.text) ??
        ([s(e.city), s(parsed?.countryFull) ?? s(e.country)].filter(Boolean).join(", ") || null);
      hq = e.headquarter === true || e.isHeadquarter === true || e.is_headquarters === true;
      country = s(parsed?.countryFull) ?? s(e.country) ?? s(parsed?.country);
    }
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, is_headquarters: hq, country });
  }
  return out;
}

export function enrichedGeography(raw: unknown): string | null {
  const entries = linkedInLocationEntries(raw);
  return entries.length > 0 ? entries.map((e) => e.text).join("; ") : null;
}

export function normalizeLinkedInCompanyEnriched(
  r: Record<string, unknown>,
): NormalizedHiringCompany {
  const inds = linkedinIndustries(r);
  const founded = r.foundedOn as Record<string, unknown> | undefined;
  const out: NormalizedHiringCompany = {
    external_source_id: `li_company:${r.id ?? "unknown"}`,
    company_name: s(r.name),
    canonical_domain: domainFrom(r.website),
    linkedin_company_url: normalizeCompanyLinkedInUrl(r.linkedinUrl),
    website: normalizeWebsite(r.website) ?? s(r.website),
    description: s(r.description),
    provider_industry: inds[0]?.name ?? null,
    industry_ids: inds,
    linkedin_associated_member_count: linkedInAssociatedMemberCount(r),
    company_size_band: linkedInDeclaredSizeBand(r),
    employee_range_advisory: null,
    geography: enrichedGeography(r.locations),
    location_entries: linkedInLocationEntries(r.locations),
    company_type: s(r.companyType),
    startup_evidence: founded && n(founded.year) !== null
      ? { year_founded: n(founded.year) } : null,
    hiring_status: null,
    source_provenance: "harvestapi/linkedin-company",
    field_trust: {
      company_name: "direct", linkedin_company_url: "direct", website: "direct",
      description: "direct", provider_industry: "direct", industry_ids: "direct",
      linkedin_associated_member_count: "direct", company_size_band: "direct",
      company_type: "semantic", geography: "transformed",
    },
    missing_fields: [],
    raw_ref: { actor_key: "apify_linkedin_company_details", source_id: s(r.id) },
  };
  out.missing_fields = [
    ...(out.startup_evidence === null ? ["founded_year:frequently_null_from_actor"] : []),
    ...(out.company_size_band === null ? ["company_size_band:not_declared_on_record"] : []),
  ];
  return out;
}

// ── JOB ──────────────────────────────────────────────────────────────────────

export function normalizeLinkedInJob(r: Record<string, unknown>): NormalizedHiringJob {
  const c = (r.company ?? {}) as Record<string, unknown>;
  const loc = r.location as Record<string, unknown> | undefined;
  return {
    job_id: r.id !== undefined && r.id !== null ? `li_job:${r.id}` : null,
    job_url: sanitizeUrl(r.linkedinUrl),
    title: s(r.title),
    company_name: s(c.name),
    company_linkedin_url: normalizeCompanyLinkedInUrl(c.linkedinUrl),
    company_source_id: c.id !== undefined && c.id !== null ? `li_company:${c.id}` : null,
    location: s(loc?.linkedinText) ?? s(r.location),
    workplace_mode: s(r.workplaceType),
    posted_date: s(r.postedDate),
    description: s(r.descriptionText),
    source: "harvestapi/linkedin-job-search",
    retrieved_at: s((r._meta as Record<string, unknown> | undefined)?.timestamp),
    missing_fields: [],
  };
}

/**
 * A structured employer is not sufficient when the same provider row carries
 * an explicit, contradictory employer. Only high-signal identity fields count:
 * a second LinkedIn company URL, an Employer/Company label, or the employer
 * line in a syndicated job-card header. General mentions in prose are ignored.
 */
export function jobEmployerIdentityConflict(r: Record<string, unknown>):
  "structured_employer_conflict" | "posting_employer_conflict" | null {
  const company = (r.company ?? {}) as Record<string, unknown>;
  const structuredUrl = normalizeCompanyLinkedInUrl(company.linkedinUrl);
  const alternateUrl = normalizeCompanyLinkedInUrl(r.companyLinkedinUrl);
  if (structuredUrl && alternateUrl && structuredUrl !== alternateUrl) {
    return "structured_employer_conflict";
  }

  const structuredName = s(company.name);
  if (!structuredName) return null;
  const body = s(r.descriptionText);
  if (!body) return null;
  const lines = body.slice(0, 1200).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let explicitEmployer: string | null = null;
  for (const line of lines.slice(0, 12)) {
    const labeled = line.match(/^(?:employer|company)\s*:\s*(.{2,100})$/i);
    if (labeled) { explicitEmployer = labeled[1]; break; }
  }
  const looksLikeLocation = (line: string) => /,\s*[A-Z]{2}(?:\b|(?=[A-Z]))/i.test(line);
  if (!explicitEmployer && /^←\s*All jobs$/i.test(lines[0] ?? "") &&
      lines[1] === s(r.title) && lines.length >= 4 &&
      !looksLikeLocation(lines[2]) &&
      (looksLikeLocation(lines[3]) || /\bPosted\s+\d/i.test(lines[3]))) {
    explicitEmployer = lines[2];
  }
  if (!explicitEmployer) return null;
  const canonical = (name: string) => name.toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\b/g, "")
    .replace(/\s+/g, " ").trim();
  return canonical(explicitEmployer) === canonical(structuredName)
    ? null : "posting_employer_conflict";
}

// ── JOB-FIRST DISCOVERY (LEAD V2 P3) ─────────────────────────────────────────
//
// A discovery job row carries the EMPLOYER'S LinkedIn company record, not just
// a name — verified live 2026-09-16 on 10/10 rows: `company.linkedinUrl`,
// `website`, `universalName`, `employeeCountRange` (declared band) and
// `employeeCount` (associated members), `industries`, `locations`
// (with the headquarter flagged). So identity is taken from the posting and the
// guarded Company Search is never needed for these employers.

/** The employer a discovery job row names, as a pipeline company. Null without a LinkedIn company URL. */
export function jobEmployerToCompany(r: Record<string, unknown>): NormalizedHiringCompany | null {
  const c = (r.company ?? {}) as Record<string, unknown>;
  const url = normalizeCompanyLinkedInUrl(c.linkedinUrl);
  if (!url) return null;
  const inds = linkedinIndustries(c);
  const locs = Array.isArray(c.locations) ? c.locations as Record<string, unknown>[] : [];
  const hq = locs.find((l) => l && l.headquarter === true) ?? locs[0];
  const hqText = hq ? s((hq.parsed as Record<string, unknown> | undefined)?.text) ??
    [s(hq.city), s(hq.geographicArea), s(hq.country)].filter(Boolean).join(", ") : null;
  const out: NormalizedHiringCompany = {
    external_source_id: `li_company:${c.id ?? s(c.universalName) ?? "unknown"}`,
    company_name: s(c.name),
    canonical_domain: domainFrom(c.website),
    linkedin_company_url: url,
    website: normalizeWebsite(c.website) ?? s(c.website),
    description: s(c.description),
    provider_industry: inds[0]?.name ?? null,
    industry_ids: inds,
    linkedin_associated_member_count: linkedInAssociatedMemberCount(c),
    company_size_band: linkedInDeclaredSizeBand(c),
    employee_range_advisory: null,
    geography: hqText || null,
    company_type: null,
    startup_evidence: null,
    // The posting itself: this company has at least one open role.
    hiring_status: true,
    source_provenance: "harvestapi/linkedin-job-search",
    field_trust: {
      company_name: "direct", linkedin_company_url: "direct", website: "direct",
      description: "direct", provider_industry: "direct", linkedin_associated_member_count: "direct",
      company_size_band: "direct", geography: "transformed",
    },
    missing_fields: [],
    raw_ref: { actor_key: "apify_linkedin_job_search", source_id: s(r.id) },
  };
  out.missing_fields = [
    ...(out.company_size_band === null ? ["company_size_band:absent_on_job_row"] : []),
    ...(out.geography === null ? ["geography:no_headquarter_on_job_row"] : []),
  ];
  return out;
}

const AGENCY_INDUSTRY_RE = /staffing|recruit|executive search|human resources services|employment/i;
const AGENCY_NAME_RE = /\b(recruit(?:ing|ers|ment)?|staffing|talent (?:partners|solutions|group)|headhunt\w*|search partners)\b/i;
/** Agency requisition codes seen live: "[AQ-18078]", "[SK-18057]". */
const REQUISITION_CODE_RE = /\[[A-Z]{2,4}-\d{3,}\]/;

/**
 * Why this posting's employer is a staffing agency, or null. Deterministic —
 * the Actor's `industryIds` filter matches the JOB's industry, so an agency
 * posting a software role survives it (Scion Staffing, probe 2026-09-16).
 */
export function jobEmployerAgencyReason(r: Record<string, unknown>): string | null {
  const c = (r.company ?? {}) as Record<string, unknown>;
  const inds = linkedinIndustries(c).map((x) => x.name);
  const hit = inds.find((x) => AGENCY_INDUSTRY_RE.test(x));
  if (hit) return `employer_industry:${hit}`;
  if (AGENCY_NAME_RE.test(String(c.name ?? ""))) return "employer_name_is_agency";
  if (REQUISITION_CODE_RE.test(String(r.title ?? ""))) return "agency_requisition_code";
  return null;
}

/** A posting no longer open is not a hiring signal. */
export function jobIsOpen(r: Record<string, unknown>): boolean {
  if (r.closedAt) return false;
  const st = String(r.jobState ?? "LISTED").toUpperCase();
  return st === "LISTED" || st === "";
}

const FIRST_HIRE_TEXT_RE =
  /\b(?:(?:our|the|as (?:our|the)|you(?:'| a)?ll be (?:our|the))\s+(?:very\s+)?first\s+(?:[a-z-]+\s+){0,3}?(?:hire|marketer|marketing|growth|sales|seller|engineer|designer|person|employee|team member)|founding\s+(?:[a-z-]+\s+){0,2}?(?:marketer|marketing|growth|sales|engineer|designer|hire|team|member|ae|sdr|lead)|first\s+(?:marketing|growth|sales)\s+hire|build(?:ing)? (?:the|our) (?:marketing|growth|sales) (?:function|team) from (?:scratch|the ground up|zero))\b/i;

/** Where the posting itself says the hire is the first in its function. */
export function firstHireLanguage(r: Record<string, unknown>): { field: "title" | "description"; quote: string } | null {
  for (const field of ["title", "descriptionText"] as const) {
    const text = String(r[field] ?? "");
    const m = FIRST_HIRE_TEXT_RE.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 60);
      return { field: field === "title" ? "title" : "description", quote: text.slice(at, m.index + m[0].length + 60).replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

/** Deduplicate on job id — the Actor returned 25% duplicate rows in one pack. */
export function dedupeJobs(jobs: NormalizedHiringJob[]): NormalizedHiringJob[] {
  const seen = new Set<string>(); const out: NormalizedHiringJob[] = [];
  for (const j of jobs) {
    const k = j.job_id ?? j.job_url ?? `${j.company_name}|${j.title}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(j);
  }
  return out;
}

// ── PERSON ───────────────────────────────────────────────────────────────────

export function normalizeHarvestPerson(
  r: Record<string, unknown>, provenance: string,
): NormalizedHiringPerson {
  const positions = Array.isArray(r.currentPositions)
    ? r.currentPositions as Record<string, unknown>[] : [];
  const cp = positions[0] ?? {};
  const tenure = cp.tenureAtCompany as Record<string, unknown> | undefined;
  const name = [s(r.firstName), s(r.lastName)].filter(Boolean).join(" ") || null;
  const out: NormalizedHiringPerson = {
    source_profile_id: s(r.id),
    external_source_id: `li_profile:${s(r.id) ?? "unknown"}`,
    full_name: name,
    title: s(cp.title),
    linkedin_url: sanitizeUrl(r.linkedinUrl),
    current_employer: s(cp.companyName),
    current_employer_linkedin_url: normalizeCompanyLinkedInUrl(cp.companyLinkedinUrl),
    current_employer_is_current: typeof cp.current === "boolean" ? cp.current : null,
    tenure_years: n(tenure?.numYears),
    source_provenance: provenance,
    missing_fields: [],
  };
  out.missing_fields = miss(out as unknown as Record<string, unknown>,
    ["source_profile_id", "full_name", "title", "current_employer", "current_employer_linkedin_url"]);
  return out;
}

/**
 * Deduplicate people by STABLE PROFILE ID.
 *
 * Both founder Actors return the opaque `ACwAAA...` member URL rather than a
 * vanity slug, and the same person can surface with different URL forms across
 * Actors. The id is the only stable key.
 */
export function dedupePeople(people: NormalizedHiringPerson[]): NormalizedHiringPerson[] {
  const seen = new Set<string>(); const out: NormalizedHiringPerson[] = [];
  for (const p of people) {
    const k = p.source_profile_id ?? p.linkedin_url ?? p.full_name ?? "";
    if (!k || seen.has(k)) { if (k) continue; }
    seen.add(k); out.push(p);
  }
  return out;
}

// ── FUNDING ROUND: datahyena ─────────────────────────────────────────────────
//
// ── WHY THIS NORMALIZER IS DEFENSIVE AND EVERY OTHER ONE IS NOT ──────────────
//
// Every other normalizer in this file was written against fields OBSERVED in
// live output on 2026-08-01. This one was written against a vendor schema and
// README read from the Store API on 2026-08-22, with no run performed. The
// exact key names are therefore unconfirmed.
//
// Two consequences, both deliberate:
//
//   1. Each field accepts a small set of plausible spellings. That is not
//      inference between DIFFERENT facts — the thing this file's header
//      forbids — it is tolerance of one fact's naming. `amount_usd` and
//      `amountUsd` are the same number; `amount_usd` and `valuation` are not,
//      and no alias here crosses that line.
//
//   2. It FAILS CLOSED. A funding row without a company name or without an
//      announced date yields `is_evidence: false`, and the qualification layer
//      must then treat the signal as unproven. A dated event is the whole of
//      what makes funding evidence rather than rumour, so a row that cannot
//      supply one proves nothing — no matter how confident the rest of it looks.

export interface NormalizedFundingRound {
  company_name: string | null;
  canonical_domain: string | null;
  linkedin_company_url: string | null;
  /** Round stage as the provider reported it. Never inferred from the amount. */
  round_stage: string | null;
  /** Announced amount normalized to USD. An announcement, not an audited figure. */
  amount_usd: number | null;
  currency: string | null;
  /** ISO date the round was ANNOUNCED. Without this there is no evidence. */
  announced_date: string | null;
  investors: string[];
  /** Article URLs the provider matched. The citation for the claim. */
  source_articles: string[];
  provider_industry: string | null;
  provider_verticals: string[];
  employee_range_advisory: string | null;
  geography: string | null;
  source_provenance: string;
  field_trust: Record<string, FieldTrust>;
  missing_fields: string[];
  /**
   * TRUE only when this row can stand as funding evidence: a named company AND
   * an announced date. Read by qualification; a false here must never become a
   * positive funding signal.
   */
  is_evidence: boolean;
  raw_ref: { actor_key: string; source_id: string | number | null };
}

/** First non-empty string among several candidate keys. */
function pick(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = s(r[k]);
    if (v) return v;
  }
  return null;
}
function pickNum(r: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = n(r[k]);
    if (v !== null) return v;
  }
  return null;
}
function pickList(r: Record<string, unknown>, keys: string[]): string[] {
  for (const k of keys) {
    const v = r[k];
    if (!Array.isArray(v)) continue;
    const out = v
      .map((x) => typeof x === "string" ? s(x) : s((x as Record<string, unknown>)?.name))
      .filter((x): x is string => !!x);
    if (out.length) return out;
  }
  return [];
}

/** ISO-8601 date, or null. A malformed date is NOT a date. */
function isoDate(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : t.slice(0, 10);
}

export function normalizeDatahyenaFundingRound(
  r: Record<string, unknown>,
): NormalizedFundingRound {
  // ── CORRECTED AGAINST LIVE OUTPUT, RUN 0XchPqe0cJpx0Yc2T (2026-08-22) ────
  //
  // The first version of this function read every company field from the TOP
  // level — `company_name`, `company_domain`, `company_linkedin`. The real rows
  // nest all of them under `company`, so it would have produced a null name for
  // every row, `is_evidence: false` for all 18, and a funding capability that
  // silently returned nothing. That is precisely what a validation run is for.
  //
  // Corrected field names, verbatim from the run:
  //   company.{name,domain,linkedinUrl,hqCity,hqCountry.name,employeeCountBucket,
  //            industryGroup,verticals,businessModel,description,foundedYear}
  //   round            — the stage, and NULL on 6 of 18 rows
  //   amountUsd        — dollars (amountUsdCents is the same figure in cents)
  //   announcedAt      — date-only, "2026-08-21"
  //   investors[]      — {id, name}
  //   sources[]        — {url}, and NOT {name}
  const company = (r["company"] ?? {}) as Record<string, unknown>;
  const hqCountry = (company["hqCountry"] ?? {}) as Record<string, unknown>;

  const company_name = pick(company, ["name"]) ?? pick(r, ["company_name", "companyName"]);
  const announced_date = isoDate(r["announcedAt"] ?? r["announced_date"] ?? r["announcedDate"]);

  // `sources` is a list of OBJECTS KEYED BY url. The generic list reader maps
  // `.name` for objects, which returned an empty list here — so the citation,
  // the one field that makes an amount checkable, was being dropped.
  const sources = Array.isArray(r["sources"])
    ? (r["sources"] as Array<Record<string, unknown>>)
      .map((x) => typeof x === "string" ? s(x) : s(x?.["url"]))
      .filter((x): x is string => !!x)
    : [];

  const geoParts = [pick(company, ["hqCity"]), s(hqCountry["name"])].filter(Boolean);

  const out: NormalizedFundingRound = {
    company_name,
    canonical_domain: domainFrom(company["domain"] ?? r["company_domain"]),
    linkedin_company_url: normalizeCompanyLinkedInUrl(company["linkedinUrl"]) ?? null,
    round_stage: pick(r, ["round", "round_stage", "roundStage", "stage"]),
    amount_usd: pickNum(r, ["amountUsd", "amount_usd"]),
    currency: pick(r, ["amountOriginalCurrency", "currency"]),
    announced_date,
    investors: pickList(r, ["investors"]),
    source_articles: sources,
    provider_industry: pick(company, ["industryGroup"]),
    provider_verticals: pickList(company, ["verticals"]),
    employee_range_advisory: pick(company, ["employeeCountBucket"]),
    geography: geoParts.length ? geoParts.join(", ") : null,
    source_provenance: "apify_funding_rounds_datahyena",
    field_trust: {
      company_name: "direct",
      round_stage: "direct",
      // The provider converts from the original currency; that is a transform.
      amount_usd: "transformed",
      announced_date: "direct",
      investors: "direct",
      source_articles: "direct",
      // OBSERVED WRONG ON LIVE DATA. Run 0XchPqe0cJpx0Yc2T returned a biotech
      // tagged industryGroup "Retail" / verticals ["commerce"], and an
      // Australian fintech resolved to a Montreal music ensemble's domain and
      // "Performing Arts". These tags are not merely unproven, they are
      // sometimes about a different company — see the identity-collision defect.
      provider_industry: "unsafe",
      provider_verticals: "unsafe",
      employee_range_advisory: "unsafe",
    },
    missing_fields: [],
    is_evidence: false,
    raw_ref: {
      actor_key: "apify_funding_rounds_datahyena",
      source_id: (s(r["id"]) ?? s(r["round_id"]) ?? null),
    },
  };

  out.missing_fields = miss(out as unknown as Record<string, unknown>, [
    "company_name", "announced_date", "round_stage", "amount_usd",
    "investors", "source_articles", "canonical_domain", "linkedin_company_url",
  ]);

  // THE GATE, unchanged: a named company and an announced date, or this is not
  // evidence. Live data shows both are present on 18 of 18 rows, so the gate
  // costs nothing in recall and still refuses a malformed row.
  out.is_evidence = company_name !== null && announced_date !== null;
  return out;
}

/**
 * Is this round recent enough to satisfy a mission's window?
 *
 * Separate from the normalizer because recency is a MISSION requirement, not a
 * property of the row. A row with no date is never fresh — it fails closed for
 * the same reason `is_evidence` does.
 */
export function fundingRoundIsWithin(
  round: Pick<NormalizedFundingRound, "announced_date">,
  maxAgeDays: number,
  now: Date = new Date(),
): boolean {
  if (!round.announced_date) return false;
  const t = new Date(round.announced_date).getTime();
  if (Number.isNaN(t)) return false;
  const ageDays = (now.getTime() - t) / 86_400_000;
  return ageDays >= 0 && ageDays <= maxAgeDays;
}

/**
 * A funding round, projected into the canonical company shape.
 *
 * The round is the EVIDENCE and the company is the candidate; the pool holds
 * companies, so the round has to yield one. What it must not do is smuggle the
 * provider's tags in as facts: `provider_industry` stays advisory and
 * `employee_range_advisory` stays advisory, exactly as they do for every other
 * discovery source, so a company that raised a Series A still has to be
 * enriched before any ICP gate reads its industry or its size.
 *
 * `hiring_status` is null and not false. This source says nothing about hiring,
 * and false would be a claim.
 */
export function fundingRoundToCompany(
  r: NormalizedFundingRound,
): NormalizedHiringCompany {
  const out: NormalizedHiringCompany = {
    external_source_id: `datahyena:${r.raw_ref.source_id ?? r.company_name ?? "unknown"}`,
    company_name: r.company_name,
    canonical_domain: r.canonical_domain,
    linkedin_company_url: r.linkedin_company_url,
    website: r.canonical_domain ? `https://${r.canonical_domain}` : null,
    description: null,
    provider_industry: r.provider_industry,
    industry_ids: [],
    linkedin_associated_member_count: null,
    company_size_band: null,
    employee_range_advisory: r.employee_range_advisory,
    geography: r.geography,
    company_type: null,
    startup_evidence: {
      funding_round_stage: r.round_stage,
      funding_amount_usd: r.amount_usd,
      funding_announced_date: r.announced_date,
      funding_investors: r.investors,
      funding_sources: r.source_articles,
    },
    hiring_status: null,
    source_provenance: r.source_provenance,
    field_trust: {
      company_name: "direct",
      canonical_domain: "direct",
      provider_industry: "unsafe",
      employee_range_advisory: "unsafe",
      geography: "direct",
    },
    missing_fields: [],
    raw_ref: r.raw_ref,
  };
  out.missing_fields = miss(out as unknown as Record<string, unknown>, [
    "company_name", "canonical_domain", "linkedin_company_url", "company_size_band",
  ]);
  return out;
}

// ── SOCIAL POSTS AND COMMENTS ────────────────────────────────────────────────
//
// Written against vendor READMEs, not observed rows — same defensive posture as
// the funding normalizer, and for the same reason. Each field accepts a small
// set of plausible spellings of ONE fact; no alias crosses between facts.
//
// THE GATE: a post is evidence only with a URL and a date. A comment is evidence
// only with a commenter identity and a date. Undated social activity is not a
// signal, it is a screenshot.

export type PostAuthorType = "company" | "person" | "unknown";

export interface NormalizedSocialPost {
  post_url: string | null;
  posted_at: string | null;
  text: string | null;
  /**
   * WHO PUBLISHED IT. The subject boundary, carried on the evidence itself.
   *
   * Derived from the author's own LinkedIn URL shape wherever possible, because
   * that is the one signal the provider cannot get wrong: a `/company/` URL is
   * a page and an `/in/` URL is a person. A provider-supplied `type` string is
   * only consulted when no URL is present.
   */
  author_type: PostAuthorType;
  author_name: string | null;
  author_url: string | null;
  /**
   * The STABLE person identity, when the author is a person.
   *
   * `author.id` / `author.profileId` is the opaque `ACoAAA…` member urn, which
   * is the only author field that does not change: the public handle can be
   * edited and the URL carries a rotating `miniProfileUrn` tracking parameter.
   * Dedupe and identity matching key on this, never on the URL.
   */
  author_member_id: string | null;
  /** The vanity handle — "hnshah". Human-readable, and editable by its owner. */
  author_public_id: string | null;
  /** Self-written. NOT verified employment — see the post-search card. */
  author_headline: string | null;
  reaction_count: number | null;
  comment_count: number | null;
  source_provenance: string;
  field_trust: Record<string, FieldTrust>;
  missing_fields: string[];
  /** TRUE only with a post URL and a date. */
  is_evidence: boolean;
}

export interface NormalizedSocialComment {
  comment_url: string | null;
  posted_at: string | null;
  text: string | null;
  commenter_name: string | null;
  commenter_url: string | null;
  /** `actor.position` — self-written, and it names a role and an employer. */
  commenter_headline: string | null;
  /** Stable commenter key. One person may comment across many posts. */
  commenter_member_id: string | null;
  /** TRUE when the commenter is the post's own author replying to their thread. */
  is_post_author: boolean;
  /** The post the comment was left ON. A comment without one is unanchored. */
  parent_post_url: string | null;
  parent_post_id: string | null;
  source_provenance: string;
  missing_fields: string[];
  /** TRUE only with a commenter identity, a date AND a parent post. */
  is_evidence: boolean;
}

/** A LinkedIn URL decides the author's kind. The provider's label does not. */
export function authorTypeFromUrl(url: unknown, claimed?: unknown): PostAuthorType {
  const u = (s(url) ?? "").toLowerCase();
  if (/linkedin\.com\/company\//.test(u)) return "company";
  if (/linkedin\.com\/in\//.test(u)) return "person";
  const c = (s(claimed) ?? "").toLowerCase();
  if (c === "company" || c === "organization") return "company";
  // OBSERVED: the provider's label for a person is "profile", not "person" —
  // run 8Ks7TvqIiejDct5ha returned `author.type: "profile"` throughout, against
  // `"company"` on the company run. Both spellings are accepted.
  if (c === "person" || c === "profile" || c === "member") return "person";
  return "unknown";
}

function isoDateTime(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeSocialPost(
  r: Record<string, unknown>, actorKey: string,
): NormalizedSocialPost {
  const author = (r["author"] ?? {}) as Record<string, unknown>;
  const engagement = (r["engagement"] ?? r["socialCounts"] ?? {}) as Record<string, unknown>;

  // ── CORRECTED AGAINST LIVE OUTPUT, RUN 34dB6dpHJr34h8bIr (2026-08-22) ────
  //
  // Two misses, and either alone would have failed every row:
  //
  //   the post URL is `linkedinUrl`, not `postUrl` or `url`; and
  //   `postedAt` is an OBJECT — {timestamp, date, postedAgoShort,
  //   postedAgoText} — not a string. Passing the object to a date reader
  //   yielded null, so `is_evidence` was false for all 8 rows.
  //
  // The run also confirmed `author.type` is a real discriminator ("company"),
  // and that `author.linkedinUrl` carries a `/posts` suffix — which the
  // URL-shape check tolerates, since it matches on `/company/`.
  const postedAt = (r["postedAt"] ?? {}) as Record<string, unknown>;
  const post_url = pick(r, ["linkedinUrl", "shareLinkedinUrl", "postUrl", "post_url", "url"]);
  const posted_at = isoDateTime(
    postedAt["date"] ?? r["posted_at"] ?? r["publishedAt"] ?? r["date"]);
  // OBSERVED, run 8Ks7TvqIiejDct5ha: a person's `linkedinUrl` arrives as
  // `https://www.linkedin.com/in/hnshah?miniProfileUrn=urn%3Ali%3Afsd_profile%3A…`.
  // The query string is a rotating tracking parameter, so two posts by the same
  // person can carry two different URLs. Stripping it is what makes the URL
  // comparable at all; the stable key remains `author_member_id`.
  const author_url_raw = pick(author, ["linkedinUrl", "url", "profileUrl", "publicUrl"]);
  const author_url = author_url_raw ? author_url_raw.split("?")[0] : null;

  const out: NormalizedSocialPost = {
    post_url,
    posted_at,
    text: pick(r, ["content", "text", "postText", "commentary"]),
    author_type: authorTypeFromUrl(author_url, author["type"] ?? r["authorType"]),
    author_name: pick(author, ["name", "fullName", "title"]),
    author_url,
    // For a PERSON this is the headline. For a COMPANY the live run showed
    // `info` holding "1,649,614 followers" — a follower count, not a headline —
    // so it is only read when the author is a person.
    author_member_id: pick(author, ["profileId", "id"]),
    author_public_id: pick(author, ["publicIdentifier", "universalName"]),
    // OBSERVED, run 8Ks7TvqIiejDct5ha: for a PERSON `info` is the headline —
    // "CEO @ Crazy Egg (est. 2005), building tools teams use to make marketing
    // decisions." — which carries both the role and the employer. For a COMPANY
    // the same field held "1,649,614 followers". Same key, different facts, so
    // it is read only when the author is a person.
    author_headline: authorTypeFromUrl(author_url, author["type"]) === "person"
      ? pick(author, ["headline", "subtitle", "occupation", "info"])
      : pick(author, ["headline", "subtitle", "occupation"]),
    // `engagement.reactions` is an ARRAY of {type,count} breakdowns, so the
    // scalar total is `likes`. Reading `reactions` first would have returned
    // null from an array.
    reaction_count: pickNum(engagement, ["likes", "reactionCount"]),
    comment_count: pickNum(engagement, ["comments", "commentCount"]),
    source_provenance: actorKey,
    field_trust: {
      post_url: "direct",
      posted_at: "direct",
      text: "direct",
      // Derived from the URL shape, which is why it is trustworthy at all.
      author_type: "transformed",
      // Self-written by the author. Never employment evidence.
      author_headline: "unsafe",
    },
    missing_fields: [],
    is_evidence: false,
  };
  out.missing_fields = miss(out as unknown as Record<string, unknown>, [
    "post_url", "posted_at", "text", "author_name", "author_url",
    "author_member_id",
  ]);
  // THE GATE. A post with no URL cannot be cited and a post with no date cannot
  // be recent, so neither is evidence of anything.
  out.is_evidence = post_url !== null && posted_at !== null;
  return out;
}

export function normalizeSocialComment(
  r: Record<string, unknown>, actorKey: string, parentPostUrl: string | null = null,
): NormalizedSocialComment {
  // ── CORRECTED AGAINST LIVE OUTPUT, RUN 6YHiwmXEcP933uqst (2026-08-22) ────
  //
  // A COMMENT IS NOT A POST WITH A DIFFERENT NAME. The post-search actor emits
  // comments as SEPARATE dataset items discriminated by `type`, and almost
  // every field differs from the post shape:
  //
  //   post                        comment
  //   ----------------------      ---------------------------
  //   author.{name,linkedinUrl}   actor.{name,linkedinUrl}
  //   author.info (headline)      actor.position (headline)
  //   content                     commentary
  //   postedAt.date (object)      createdAt (flat ISO string)
  //   —                           postId  (the parent post)
  //   —                           actor.author (is this the OP replying?)
  //
  // Written from the post shape, this returned null for the commenter, the text
  // and the date on every comment — the whole comment-intent capability.
  //
  // The commenter's URL is also CLEAN here (`/in/apoorva-growth`), unlike a post
  // author's, which carries a rotating `miniProfileUrn` parameter.
  const author = (r["actor"] ?? r["author"] ?? r["commenter"] ?? {}) as Record<string, unknown>;
  const commenter_url_raw = pick(author, ["linkedinUrl", "url", "profileUrl"]);
  const commenter_url = commenter_url_raw ? commenter_url_raw.split("?")[0] : null;
  const posted_at = isoDateTime(
    r["createdAt"] ?? r["postedAt"] ?? r["posted_at"] ?? r["date"]);
  const commenter_name = pick(author, ["name", "fullName"]);
  const query = (r["query"] ?? {}) as Record<string, unknown>;

  const out: NormalizedSocialComment = {
    comment_url: pick(r, ["linkedinUrl", "commentUrl", "url", "permalink"]),
    posted_at,
    text: pick(r, ["commentary", "text", "content", "comment"]),
    commenter_name,
    commenter_url,
    // `actor.position` IS the headline on a comment, and it names role and
    // employer — "Co-founder, TriForge Labs", "CEO @ FastForward". It is
    // self-written, so it proposes an identity and verifies none of it.
    commenter_headline: pick(author, ["position", "headline", "subtitle", "occupation"]),
    // The STABLE commenter key. Observed: one person commented on three
    // different posts in a single run, under the same `actor.id`.
    commenter_member_id: pick(author, ["id", "profileId"]),
    // TRUE when the commenter is the post's own author replying in their own
    // thread — which is a different thing from a third party engaging.
    is_post_author: author["author"] === true,
    // `postId` is the parent's id; `query.post` is its URL. Both are provenance
    // that a comment cannot be read without: a comment with no parent has no
    // subject, and its words mean nothing on their own.
    parent_post_id: pick(r, ["postId"]),
    parent_post_url: parentPostUrl ?? pick(query, ["post"]) ?? pick(r, ["parentPostUrl"]),
    source_provenance: actorKey,
    missing_fields: [],
    is_evidence: false,
  };
  out.missing_fields = miss(out as unknown as Record<string, unknown>, [
    "posted_at", "text", "commenter_name", "commenter_url",
    "commenter_headline", "parent_post_url", "parent_post_id",
  ]);
  // THE GATE. A comment proves that a PERSON said something ABOUT something.
  // Without an identity there is no person; without a date there is no
  // "recently"; without a parent there is no subject the words are about.
  out.is_evidence = (commenter_url !== null || commenter_name !== null) &&
    posted_at !== null &&
    (out.parent_post_url !== null || out.parent_post_id !== null);
  return out;
}

/**
 * Split a post-search dataset into posts and comments.
 *
 * OBSERVED: one run with `maxPosts: 6` and `maxComments: 4` returned 28 items —
 * 5 posts and 23 comments — in ONE flat dataset, discriminated only by `type`.
 * A caller that assumed every row was a post would have normalised 23 comments
 * as malformed posts and billed for all of them.
 */
export function splitPostSearchRows(
  rows: readonly Record<string, unknown>[],
): { posts: Record<string, unknown>[]; comments: Record<string, unknown>[] } {
  const posts: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  for (const r of rows) {
    // The discriminator is explicit; the shape check is the fallback for a row
    // that somehow lacks it.
    const t = (s(r["type"]) ?? "").toLowerCase();
    if (t === "comment" || (r["postId"] != null && r["commentary"] != null)) {
      comments.push(r);
    } else {
      posts.push(r);
    }
  }
  return { posts, comments };
}

// ── NEWS ─────────────────────────────────────────────────────────────────────

export interface NormalizedNewsArticle {
  title: string | null;
  url: string | null;
  source: string | null;
  published_at: string | null;
  description: string | null;
  source_provenance: string;
  missing_fields: string[];
  /** TRUE only with a followable URL and a publication date. */
  is_evidence: boolean;
}

export function normalizeNewsArticle(r: Record<string, unknown>): NormalizedNewsArticle {
  // ── CORRECTED AGAINST LIVE OUTPUT, RUN ak9nBcyYkolVrLQhM (2026-08-22) ────
  //
  // The field is `url`, not `link`; `source` is a PLAIN STRING ("CNBC"), not an
  // object; and `description` is absent unless `extractDescriptions` is on —
  // which the compiler now forces, because the claim text is the evidence.
  // `decodeUrls: true` was confirmed working: the run returned real cnbc.com and
  // bloomberg.com URLs rather than Google redirects.
  const url = sanitizeUrl(pick(r, ["url", "link", "articleUrl"]));
  const published_at = isoDateTime(
    r["publishedAt"] ?? r["published_at"] ?? r["date"] ?? r["pubDate"]);
  const src = r["source"];
  const out: NormalizedNewsArticle = {
    title: pick(r, ["title", "headline"]),
    url,
    source: typeof src === "string" ? s(src)
      : s((src as Record<string, unknown>)?.["name"] ?? (src as Record<string, unknown>)?.["title"]),
    published_at,
    description: pick(r, ["description", "summary", "snippet"]),
    source_provenance: "apify_google_news",
    missing_fields: [],
    is_evidence: false,
  };
  out.missing_fields = miss(out as unknown as Record<string, unknown>, [
    "title", "url", "source", "published_at", "description",
  ]);
  // A claim with no article behind it is a rumour, and an undated article
  // cannot support "recently".
  out.is_evidence = url !== null && published_at !== null;
  return out;
}

// ── TECHNOLOGY ───────────────────────────────────────────────────────────────

export interface NormalizedTechnologyProfile {
  domain: string | null;
  technologies: string[];
  categories: string[];
  source_provenance: string;
  missing_fields: string[];
  /** TRUE with a domain and at least one detected technology. */
  is_evidence: boolean;
  /**
   * ALWAYS NULL, and deliberately present.
   *
   * BuiltWith reports what a domain runs NOW. It publishes no adoption date, so
   * "recently adopted X" is unanswerable. A field that is always null is louder
   * than an absent one: it says the question was asked and has no answer.
   */
  adopted_at: null;
}

export function normalizeTechnologyProfile(
  r: Record<string, unknown>,
): NormalizedTechnologyProfile {
  // ── CORRECTED AGAINST LIVE OUTPUT, RUN PD0F1XtytK3Z7juwM (2026-08-22) ────
  //
  // The row has exactly two top-level keys, `domain` and `techs`, and each tech
  // is {name, tag, categories[], link}. Categories are NESTED PER TECHNOLOGY,
  // so reading them from the top level returned an empty list — losing the
  // field that answers an AI-adoption question, since "AI" appears there.
  //
  // Volume observed: 120 technologies for notion.so, 260 for stripe.com, across
  // 22 distinct tags. Billing is per DOMAIN, so the volume is free in money and
  // expensive in payload.
  const domain = pick(r, ["domain", "rootDomain", "url", "hostname"]);
  const techs = Array.isArray(r["techs"]) ? r["techs"] as Array<Record<string, unknown>> : [];
  const technologies = techs.length
    ? techs.map((t) => s(t?.["name"])).filter((x): x is string => !!x)
    : pickList(r, ["technologies", "detected", "names"]);
  const categories = techs.length
    ? [...new Set(techs.flatMap((t) =>
        Array.isArray(t?.["categories"]) ? (t["categories"] as unknown[]).map((c) => s(c)) : []))]
      .filter((x): x is string => !!x)
    : pickList(r, ["categories", "groups"]);
  const out: NormalizedTechnologyProfile = {
    domain: domain ? domain.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] : null,
    technologies,
    categories,
    source_provenance: "apify_builtwith_technology",
    missing_fields: [],
    is_evidence: false,
    adopted_at: null,
  };
  out.missing_fields = miss(out as unknown as Record<string, unknown>, [
    "domain", "technologies", "categories",
  ]);
  out.is_evidence = out.domain !== null && technologies.length > 0;
  return out;
}
