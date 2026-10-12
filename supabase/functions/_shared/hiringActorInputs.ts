// TYPED PROVIDER INPUTS + DETERMINISTIC COMPILERS.
//
// Every compiler here REJECTS an invalid input rather than sending it. That
// matters because the benchmark found three ways an Actor accepts bad input and
// fails quietly instead of erroring:
//
//   * solidcode multi-value teamSize  -> zero rows, reported as "no matches"
//   * an unknown profileScraperMode   -> silent fallback to the expensive default
//   * job-search maxItems             -> per title PER location, so a "cap" of 25
//                                        with 4 titles is really 100 paid rows
//
// A silent wrong answer costs more than a loud failure, so the checks are up
// front and total. Nothing here performs I/O.

import {
  COMPANY_EMPLOYEES_SCRAPER_MODES, COMPANY_SCRAPER_MODES, COMPANY_SIZE_BANDS,
  EMAIL_ENRICHMENT_MODES, HIRING_ACTOR_CATALOG, JOB_EMPLOYMENT_TYPES,
  JOB_EXPERIENCE_LEVELS, JOB_POSTED_LIMITS, JOB_SORT_BY, JOB_WORKPLACE_TYPES, PROFILE_SEARCH_SCRAPER_MODES,
  PROFILE_SCRAPER_MODES, PROFILE_SCRAPER_EMAIL_MODE,
  YC_MEMO23_INDUSTRIES, YC_MEMO23_MAX_SIZES, YC_MEMO23_MIN_SIZES, YC_MEMO23_MODES,
  YC_SOLIDCODE_INDUSTRIES, YC_SOLIDCODE_REGIONS, YC_SOLIDCODE_STATUSES,
  YC_SOLIDCODE_TEAM_SIZES,
  FUNDING_ROUND_STAGES, FUNDING_COUNTRIES, FUNDING_VERTICALS,
  FUNDING_EMPLOYEE_BUCKETS, FUNDING_STAGES_WITHOUT_COVERAGE,
  POST_POSTED_LIMITS, COMMENT_POSTED_LIMITS, POST_SEARCH_SORT_BY,
  POST_PROFILE_SCRAPER_MODES, POST_CONTEXT_COUNTRIES, POST_CONTENT_TYPES,
  NEWS_TIMEFRAMES, NEWS_TOPICS, NEWS_REGION_LANGUAGES, perResultPriceUsd
} from "./hiringActorCatalog.ts";

// ── CONTRACTS ────────────────────────────────────────────────────────────────

export interface Memo23YcCompanyInput {
  mode: "companies" | "jobs";
  regions?: string[];
  industries?: string[];
  batch?: string[];
  isHiring?: boolean;
  minEmployeeSize?: string;
  maxEmployeeSize?: string;
  queries?: string[];
  /** Sentinel-bearing multi-selects. "All …" values are stripped by the Actor. */
  topCompany?: boolean;
  nonprofit?: boolean;
  scrapeOpenJobs?: boolean;
  scrapeFounderDetails?: boolean;
  maxItems: number;
  /** Always false. Email enrichment is out of scope for this architecture. */
  enrichEmails?: false;
}

export interface SolidcodeYcCompanyInput {
  searchQuery?: string;
  status?: string[];
  regions?: string[];
  industries?: string[];
  /** AT MOST ONE VALUE. Multiple values silently return zero rows. */
  teamSize?: string[];
  isHiring?: boolean;
  includeJobs?: boolean;
  includeFounders?: boolean;
  maxResults: number;
}

/** The ONLY keys solidcode/ycombinator-scraper accepts. */
export const SOLIDCODE_FIELDS: readonly string[] = [
  "searchQuery", "status", "regions", "industries", "teamSize",
  "isHiring", "includeJobs", "includeFounders", "maxResults",
];

export interface HarvestCompanySearchInput {
  /** A company NAME keyword. Never a concept phrase. */
  searchQuery?: string;
  locations?: string[];
  industryIds?: string[];
  companySize?: string[];
  scraperMode: "short" | "full";
  maxItems: number;
}

export interface HarvestCompanyDetailsInput {
  companies?: string[];
  searches?: string[];
}

export interface HarvestJobSearchInput {
  /** MAX 10. Verified live schema limit. */
  company: string[];
  jobTitles: string[];
  locations?: string[];
  postedLimit?: typeof JOB_POSTED_LIMITS[number];
  workplaceType?: string[];
  employmentType?: string[];
  sortBy?: typeof JOB_SORT_BY[number];
  /** PER jobTitle PER location. Not a total. */
  maxItems: number;
}

/**
 * LEAD V2 P3 — the same Actor asked a DISCOVERY question: open roles across
 * employers, no `company[]`. Verified live 2026-09-16 (run
 * `p3/probe_rows.json`, 10 rows): every row carried `company.linkedinUrl`,
 * `website`, `universalName`, the declared `employeeCountRange` and
 * `employeeCount` (LinkedIn associated members), so the employer's identity
 * arrives with the posting.
 */
export interface HarvestJobDiscoveryInput {
  /** LinkedIn boolean syntax is supported: `"growth marketer" OR "head of growth"`. */
  jobTitles: string[];
  locations?: string[];
  /** Freshness is REQUIRED for discovery: a hiring signal without a window is not a signal. */
  postedLimit: typeof JOB_POSTED_LIMITS[number];
  industryIds?: string[];
  experienceLevel?: string[];
  workplaceType?: string[];
  employmentType?: string[];
  sortBy?: typeof JOB_SORT_BY[number];
  /** PER jobTitle PER location. Not a total. */
  maxItems: number;
  page?: number;
}

export interface HarvestCompanyEmployeesInput {
  companies: string[];
  jobTitles?: string[];
  locations?: string[];
  /** MUST come from COMPANY_EMPLOYEES_SCRAPER_MODES (price is in the value). */
  profileScraperMode: typeof COMPANY_EMPLOYEES_SCRAPER_MODES[number];
  companyBatchMode?: "all_at_once" | "one_by_one";
  maxItems: number;
  maxItemsPerCompany?: number;
}

export interface HarvestProfileSearchInput {
  currentCompanies?: string[];
  currentJobTitles?: string[];
  locations?: string[];
  /** MUST come from PROFILE_SEARCH_SCRAPER_MODES — NOT the employees enum. */
  profileScraperMode: typeof PROFILE_SEARCH_SCRAPER_MODES[number];
  maxItems: number;
}

/**
 * ONE KNOWN PERSON, ENRICHED. Never a search.
 *
 * ── THIS IS THE PAYLOAD, AND ONLY THE PAYLOAD ───────────────────────────────
 *
 * Every field here exists in the live Actor schema. `build()` sends the input
 * object through verbatim, so a convenience field added to this type would be
 * transmitted to an Actor that has no such input — and the contract guard in
 * `actorInputContracts.test.ts` fails the build when one is. It caught exactly
 * that during this change: a `maxItems` ceiling, invented here, that the Actor
 * does not accept. The row count of this call IS the length of the target list.
 *
 * Compiler-only arguments — the email authorisation — live in
 * `ProfileScraperCompileArgs` and never reach the wire.
 */
export interface HarvestProfileScraperInput {
  /** Full profile URLs. Vanity slugs work; the opaque member-id form does not. */
  urls?: string[];
  /** The last path segment of a profile URL. */
  publicIdentifiers?: string[];
  /**
   * The opaque `ACwAAA…` member id.
   *
   * THIS IS THE HANDOFF FROM DISCOVERY. `company-employees` returns that form
   * and never a vanity slug — its own `company_employees_opaque_profile_url`
   * defect says so — so a decision maker found there arrives here as a profile
   * ID, not a URL. Putting it in `urls` is the mistake this field exists to
   * prevent.
   */
  profileIds?: string[];
  /** MUST come from PROFILE_SCRAPER_MODES — a third, incompatible vocabulary. */
  profileScraperMode: typeof PROFILE_SCRAPER_MODES[number];
}

export interface ProfileScraperCompileArgs extends HarvestProfileScraperInput {
  /**
   * THE USER PRESSED FIND CONTACT DETAILS.
   *
   * ── WHY AUTHORISATION IS A FLAG AND NOT AN ENUM VALUE ────────────────────
   *
   * Every other compiler forbids email modes by REJECTING the enum value. That
   * works while no layer may ever run one. Here one layer may, so absence of a
   * ban is not the same as presence of consent — and a caller that simply set
   * the expensive enum would have obtained an email purchase by typing a
   * string.
   *
   * Compiler-only: it is stripped before the payload is built, because it is a
   * statement about the USER, not an instruction to the Actor.
   */
  emailLookupAuthorized?: boolean;
}

// ── COMPILATION RESULT ───────────────────────────────────────────────────────

export interface CostEstimate {
  start_usd: number;
  per_result_usd: number | null;
  /** Worst case for THIS input, including multiplier fields. */
  estimated_max_usd: number;
  /** Rows this input could return at worst — the multiplier made explicit. */
  max_expected_rows: number;
  multiplier_explanation?: string;
}

export interface CompiledActorCall<T> {
  ok: true;
  actorKey: string;
  actorId: string;
  input: T;
  inputHash: string;
  /** Stable identity for the batch this call belongs to (idempotency + audit). */
  batchIdentity: string;
  expectedOutputType: "company" | "job" | "person";
  cost: CostEstimate;
  schemaBuild: string;
  warnings: string[];
}

export interface CompileFailure {
  ok: false;
  actorKey: string;
  errors: string[];
}

export type CompileResult<T> = CompiledActorCall<T> | CompileFailure;

// ── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * The compiled call's fingerprint.
 *
 * ── WAS FNV-1a 32-BIT, WITHOUT THE ACTOR ──────────────────────────────────
 *
 * 4.3e9 values, and the thing it protects is "do not buy this again": a
 * collision does not corrupt a row, it silently skips a paid call that should
 * have been made. It also omitted the actor, so one input aimed at two actors
 * hashed identically and only the surrounding key told them apart.
 *
 * Now `SHA-256(canonicalJson({actorKey, input}))`, the same function the
 * checkpoint and the outbound guard use — one fingerprint boundary, not three.
 *
 * `actorKey` is optional so the pre-existing one-argument shape still compiles
 * for callers that hash something other than an actor payload; every compiler
 * in this file passes it.
 */
export function hashInput(v: unknown, actorKey = ""): string {
  return providerInputFingerprint(actorKey, v);
}

/** The pre-v2 hash. READ ONLY — for recognising historical keys. */
export function legacyHashInput(v: unknown): string {
  const s = canonical(v);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

import { providerInputFingerprint } from "./providerInputFingerprint.ts";
import { classifyRoleFamily, ROLE_FAMILY_ALIASES, type RoleFamily, roleMatchesFamily } from "./roleFamilies.ts";

const LINKEDIN_COMPANY_URL =
  /^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/(company|school|showcase)\/[A-Za-z0-9_\-%.]+\/?$/i;

/**
 * A SCALAR WHERE A LIST BELONGS IS ONE VALUE, NOT A LIST OF CHARACTERS.
 *
 * `for (const v of values)` over a STRING iterates its characters. On the live
 * end-to-end run of 2026-08-19 the planner sent
 *
 *     industries: "Engineering, Product and Design"
 *
 * — a correct enum value, in the wrong container — and the compiler answered
 * with thirty-one violations reading `industries: "E" is not a verified enum
 * value`, `"n"`, `"g"`, `"i"`… roughly four kilobytes of it. The capability died
 * with `provider_input_validation_failed` and the whole run returned zero.
 *
 * Wrapping a scalar is the "useful normalization" side of the split: it changes
 * no decision, cannot admit a value the enum forbids, and turns a container slip
 * into the call the model plainly meant. An actually-invalid value is still
 * refused below, once, by name.
 */
export function asList<T = string>(values: unknown): T[] {
  if (values == null) return [];
  if (Array.isArray(values)) return values as T[];
  return [values as T];
}

function enumValues(values: unknown): string[] {
  if (values == null) return [];
  if (Array.isArray(values)) return values.map((v) => String(v));
  return [String(values)];
}

function checkEnum(errors: string[], field: string, values: unknown,
                   allowed: readonly string[]): void {
  // DEDUPED. A repeated value produced a repeated sentence, and the repair round
  // is handed this text — a model reading the same violation thirty-one times
  // learns nothing it did not learn the first time.
  const seen = new Set<string>();
  for (const v of enumValues(values)) {
    if (!allowed.includes(v) && !seen.has(v)) {
      seen.add(v);
      errors.push(`${field}: "${v}" is not a verified enum value (allowed: ${allowed.join(" | ")})`);
    }
  }
}

function checkMax(errors: string[], field: string, arr: unknown[] | undefined, max: number): void {
  if (arr && arr.length > max) errors.push(`${field}: ${arr.length} exceeds the verified limit of ${max}`);
}

function fail(actorKey: string, errors: string[]): CompileFailure {
  return { ok: false, actorKey, errors };
}

function build<T>(actorKey: string, input: T, outType: "company" | "job" | "person",
                  cost: CostEstimate, warnings: string[], batchSeed: string): CompiledActorCall<T> {
  const card = HIRING_ACTOR_CATALOG[actorKey];
  const inputHash = hashInput(input, actorKey);
  return {
    ok: true, actorKey, actorId: card.actor_id, input, inputHash,
    batchIdentity: `${actorKey}:${batchSeed}:${inputHash}`,
    expectedOutputType: outType, cost, schemaBuild: card.schema_build, warnings,
  };
}

function cost(actorKey: string, rows: number, perResultOverride?: number,
              explanation?: string): CostEstimate {
  const c = HIRING_ACTOR_CATALOG[actorKey].cost_model;
  const per = perResultOverride ?? c.per_result_usd ?? 0;
  const raw = c.start_usd + rows * per;
  return {
    start_usd: c.start_usd, per_result_usd: per,
    estimated_max_usd: Number(Math.max(raw, c.minimum_total_usd ?? 0).toFixed(6)),
    max_expected_rows: rows,
    ...(explanation ? { multiplier_explanation: explanation } : {}),
  };
}

// ── COMPILERS ────────────────────────────────────────────────────────────────

export function compileMemo23YcInput(i: Memo23YcCompanyInput): CompileResult<Memo23YcCompanyInput> {
  const K = "apify_yc_companies_memo23";
  const e: string[] = []; const w: string[] = [];
  if (!YC_MEMO23_MODES.includes(i.mode)) e.push(`mode: "${i.mode}" invalid`);
  checkEnum(e, "industries", i.industries, YC_MEMO23_INDUSTRIES);
  if (i.minEmployeeSize && !YC_MEMO23_MIN_SIZES.includes(i.minEmployeeSize as never)) {
    e.push(`minEmployeeSize: "${i.minEmployeeSize}" is not a verified value`);
  }
  if (i.maxEmployeeSize && !YC_MEMO23_MAX_SIZES.includes(i.maxEmployeeSize as never)) {
    e.push(`maxEmployeeSize: "${i.maxEmployeeSize}" is not a verified value`);
  }
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1) e.push("maxItems must be a positive integer");
  // COST + CONTACT SAFETY
  if (i.enrichEmails) e.push("enrichEmails is forbidden — no email enrichment in this architecture");
  if ((i.mode ?? "companies") !== "companies" && i.scrapeOpenJobs) {
    w.push("scrapeOpenJobs applies to Companies mode only and will be ignored");
  }
  if (i.scrapeFounderDetails) w.push("scrapeFounderDetails adds one HTTP request per company and slows the run");
  if (e.length) return fail(K, e);
  w.push("teamSize from this Actor is advisory and may be stale — never satisfies a size gate");
  w.push("this Actor supplies no LinkedIn company URL");
  // NORMALISED ON THE WAY OUT, not merely accepted on the way in. `checkEnum`
  // tolerates a scalar where a list belongs; the object actually SENT to Apify
  // has to carry the list, or the run is validated against one shape and billed
  // against another.
  return build(K, {
    ...i,
    ...(i.industries !== undefined ? { industries: asList<string>(i.industries) } : {}),
    ...(i.regions !== undefined ? { regions: asList<string>(i.regions) } : {}),
    ...(i.batch !== undefined ? { batch: asList<string>(i.batch) } : {}),
    ...(i.queries !== undefined ? { queries: asList<string>(i.queries) } : {}),
    enrichEmails: false as const,
  }, "company",
    cost(K, i.maxItems, undefined, "maxItems is a PER-URL / per-filter-run cap, not a global cap"),
    w, i.mode);
}

export function compileSolidcodeYcInput(i: SolidcodeYcCompanyInput): CompileResult<SolidcodeYcCompanyInput> {
  const K = "apify_yc_companies_solidcode";
  const e: string[] = []; const w: string[] = [];
  checkEnum(e, "status", i.status, YC_SOLIDCODE_STATUSES);
  checkEnum(e, "regions", i.regions, YC_SOLIDCODE_REGIONS);
  checkEnum(e, "industries", i.industries, YC_SOLIDCODE_INDUSTRIES);
  checkEnum(e, "teamSize", i.teamSize, YC_SOLIDCODE_TEAM_SIZES);
  // THE HARD RULE. Two values return zero rows and look like a true negative.
  if (i.teamSize && i.teamSize.length > 1) {
    e.push(
      `teamSize: ${i.teamSize.length} values supplied, but this Actor ANDs them and returns ZERO rows ` +
      `(verified 2026-08-01). Fan out one call per band via fanOutSolidcodeTeamSizes().`,
    );
  }
  if (!Number.isInteger(i.maxResults) || i.maxResults < 1) e.push("maxResults must be a positive integer");
  // FIELD WHITELIST. `build` spreads whatever it is given, so an unrecognised
  // key — most likely a memo23 field like `minEmployeeSize` or `batch` reaching
  // the wrong compiler — would be forwarded to SolidCode verbatim. The two
  // Actors share a subject and share no schema; emitting only known keys is what
  // makes that class of mix-up unrepresentable rather than merely discouraged.
  const foreign = Object.keys(i).filter((k) => !SOLIDCODE_FIELDS.includes(k));
  if (foreign.length) {
    e.push(`unsupported field(s) for solidcode/ycombinator-scraper: ${foreign.join(", ")}`);
  }
  if (e.length) return fail(K, e);
  // ── NORMALISED ON THE WAY OUT, SAME AS memo23 ─────────────────────────────
  //
  // The live build schema types `status`, `regions`, `industries`, `teamSize`
  // and `batches` as ARRAYS. On production run 53c99b8a the planner sent
  // `status: "Active"` — the right value in the wrong container — and Apify
  // rejected the whole run with `apify_input_schema_error`, three times.
  // `checkEnum` tolerates the scalar so the VALUE can be judged; the object
  // actually sent has to carry the array, or the run is validated against one
  // shape and billed against another.
  const SOLIDCODE_LIST_FIELDS = new Set([
    "status", "regions", "industries", "teamSize", "batches", "startUrls",
  ]);
  const clean: SolidcodeYcCompanyInput = { maxResults: i.maxResults };
  for (const k of SOLIDCODE_FIELDS) {
    const v = (i as unknown as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    (clean as unknown as Record<string, unknown>)[k] =
      SOLIDCODE_LIST_FIELDS.has(k) ? asList(v) : v;
  }
  w.push("fallback Actor only — prefer memo23 for primary YC discovery");
  return build(K, clean, "company", cost(K, i.maxResults), w, i.teamSize?.[0] ?? "any-size");
}

/**
 * Turn a multi-band size request into one VALID call per band.
 *
 * The whole point of the hard rule above: the caller still gets every band, but
 * as separately identified calls whose cost is visible, instead of one silently
 * empty call.
 */
export function fanOutSolidcodeTeamSizes(
  base: Omit<SolidcodeYcCompanyInput, "teamSize">, bands: string[],
): CompileResult<SolidcodeYcCompanyInput>[] {
  if (bands.length === 0) return [compileSolidcodeYcInput({ ...base })];
  return bands.map((b) => compileSolidcodeYcInput({ ...base, teamSize: [b] }));
}

/**
 * Why this string is not a usable company-NAME query — or null if it is fine.
 *
 * `harvestapi/linkedin-company-search` matches company names. Anything that is
 * a URL, a domain, an email or a descriptive sentence will match nothing, and
 * the Actor reports that as a successful empty run, so the cost is real and the
 * failure is silent. That is exactly what happened six times on TEST task
 * 42e39fb1.
 *
 * Deliberately permissive about NAMES: "Tara AI", "Y Combinator" and
 * "Acme Software Group" are all legitimate and must pass. The rejections are
 * for things that are structurally not names.
 */
export function invalidCompanyNameQueryReason(query: string): string | null {
  const q = query.trim();
  if (!q) return "empty query";
  const lower = q.toLowerCase();
  if (/^https?:\/\//.test(lower)) return "protocol string — this field takes a company name";
  if (lower.includes("/")) return "URL path — this field takes a company name";
  if (/\S+@\S+/.test(lower)) return "email-like value — this field takes a company name";
  // A DOMAIN ANYWHERE IN THE STRING, not just as the whole value. "SnapMagic
  // snapmagic.com" was two tokens, and the second one is what broke it.
  for (const tok of lower.split(/\s+/)) {
    const t = tok.replace(/[(),]/g, "");
    if (COMPANY_NAME_DOMAIN_TOKEN.test(t)) {
      return `token "${tok}" is a domain — the domain belongs in match verification, not the query`;
    }
  }
  // A DESCRIPTION, NOT A NAME. Real company names are short; a benchmark concept
  // phrase returned exactly one company literally named that.
  if (q.split(/\s+/).length > 6) return "too many words to be a company name";
  if (q.length > 80) return "too long to be a company name";
  return null;
}

/** Hostname shape with a real TLD. Kept in sync with the prequalification copy. */
const COMPANY_NAME_DOMAIN_TOKEN =
  /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|io|ai|co|net|org|dev|app|xyz|inc|tech|so|to|sh|me|us|uk|de|fr|ca)$/i;

export function compileHarvestCompanySearchInput(
  i: HarvestCompanySearchInput,
): CompileResult<HarvestCompanySearchInput> {
  const K = "apify_linkedin_company_search";
  const e: string[] = []; const w: string[] = [];
  if (!COMPANY_SCRAPER_MODES.includes(i.scraperMode)) e.push(`scraperMode: "${i.scraperMode}" invalid`);
  checkEnum(e, "companySize", i.companySize, COMPANY_SIZE_BANDS);
  checkMax(e, "locations", i.locations, 20);
  checkMax(e, "industryIds", i.industryIds, 20);
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1 || i.maxItems > 1000) {
    e.push("maxItems must be an integer between 1 and 1000");
  }
  // ── searchQuery MUST BE A COMPANY NAME ──────────────────────────────────────
  //
  // This used to be a WARNING keyed on word count: "more than two words looks
  // conceptual". It measured the wrong property and missed the real failure.
  // "SnapMagic snapmagic.com" is exactly two tokens, so nothing fired — and all
  // six live searches on TEST task 42e39fb1 returned zero rows, because this
  // field is a NAME index and a domain is not a name.
  //
  // Now it is an ERROR, checked before anything is spent, and it validates what
  // actually matters: is this a name, or is it a URL/domain/sentence?
  //
  // ── AN EMPTY STRING IS AN ABSENT QUERY, NOT AN INVALID ONE ────────────────
  //
  // The gate below is `!== undefined` on purpose: this actor searches on
  // `industryIds` + `companySize` alone, and an industry-only pool is a
  // legitimate — often the correct — discovery shape. The strategy model asked
  // for exactly that on 2026-08-28 16:23, and expressed "no name filter" as
  // `searchQuery: ""` rather than by omitting the field. The empty string is
  // defined, so the gate opened, `invalidCompanyNameQueryReason` returned
  // "empty query", and the run was refused at the provider boundary:
  //
  //   provider_input_validation_failed: apify_linkedin_company_search:
  //   invalid_company_name_search_query: empty query (searchQuery: "")
  //
  // Zero companies discovered, zero spent — and the user was told "0 of 3",
  // as though a search had run and the market were empty.
  //
  // FILLING IT WOULD BE WORSE. This field is a NAME index; the comment below
  // records what a concept phrase returns. "recruiting staffing" is not a
  // company name, so deriving a query from the mission's verticals would buy a
  // search already known to return garbage. Dropping the empty value is the
  // only change that matches both the schema and the strategy's own stated
  // intent.
  const normalized: HarvestCompanySearchInput = { ...i };
  if (typeof normalized.searchQuery === "string" && normalized.searchQuery.trim() === "") {
    delete normalized.searchQuery;
    w.push("searchQuery was empty and has been dropped — this is an industry/size search, not a name search");
  }
  i = normalized;

  const q = (i.searchQuery ?? "").trim();
  if (i.searchQuery !== undefined) {
    const reason = invalidCompanyNameQueryReason(q);
    if (reason) {
      e.push(`invalid_company_name_search_query: ${reason} (searchQuery: ${JSON.stringify(i.searchQuery)})`);
    }
  }
  // AND AN INDUSTRY-ONLY SEARCH STILL NEEDS SOMETHING TO SEARCH ON. With no
  // name, no industry and no location this actor would enumerate LinkedIn.
  if (i.searchQuery === undefined
      && !(i.industryIds?.length) && !(i.locations?.length)) {
    e.push("no searchQuery, industryIds or locations — this would be an unbounded search");
  }
  // FAIL BEFORE THE ACTOR STARTS. A malformed name query is not a preference,
  // it is a call that cannot succeed — and six of them were paid for.
  if (e.length) return fail(K, e);
  if (i.companySize?.length) {
    w.push("companySize filters the DECLARED band (employeeCountRange) — plausible on a search row; the company record settles it");
  }
  if (i.industryIds?.length) w.push("provider industry is not proof of industry — enrichment is required");
  if (i.scraperMode === "short") w.push("short mode returns no size band and no member count — size is unreadable here");
  w.push("CANDIDATES ONLY — output cannot satisfy a Company Brain hard gate without enrichment");
  const per = i.scraperMode === "full" ? 0.004 : 0.002;
  return build(K, i, "company", cost(K, i.maxItems, per), w, i.scraperMode);
}

export function compileHarvestCompanyDetailsInput(
  i: HarvestCompanyDetailsInput,
): CompileResult<HarvestCompanyDetailsInput> {
  const K = "apify_linkedin_company_details";
  const e: string[] = [];
  const companies = i.companies ?? []; const searches = i.searches ?? [];
  if (companies.length === 0 && searches.length === 0) {
    e.push("supply at least one of companies[] or searches[]");
  }
  for (const c of companies) {
    if (!LINKEDIN_COMPANY_URL.test(c)) e.push(`companies: "${c}" is not a LinkedIn company URL`);
  }
  if (e.length) return fail(K, e);
  return build(K, i, "company", cost(K, companies.length + searches.length), [
    "foundedOn is frequently null — never require it",
  ], "enrich");
}

export function compileHarvestJobSearchInput(
  i: HarvestJobSearchInput,
): CompileResult<HarvestJobSearchInput> {
  const K = "apify_linkedin_job_search";
  const e: string[] = []; const w: string[] = [];
  if (!i.company?.length) e.push("company[] is required — this Actor is for company-scoped verification only");
  checkMax(e, "company", i.company, 10);
  if (!i.jobTitles?.length) e.push("jobTitles[] is required");
  if (i.postedLimit && !JOB_POSTED_LIMITS.includes(i.postedLimit)) {
    e.push(`postedLimit: "${i.postedLimit}" invalid — verified enum is ${JOB_POSTED_LIMITS.join(" | ")} (never numeric days)`);
  }
  checkEnum(e, "workplaceType", i.workplaceType, JOB_WORKPLACE_TYPES);
  checkEnum(e, "employmentType", i.employmentType, JOB_EMPLOYMENT_TYPES);
  if (i.sortBy && !JOB_SORT_BY.includes(i.sortBy)) e.push(`sortBy: "${i.sortBy}" invalid`);
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1) e.push("maxItems must be a positive integer");
  if (e.length) return fail(K, e);
  // THE MULTIPLIER, MADE EXPLICIT.
  const locs = Math.max(1, i.locations?.length ?? 1);
  const rows = i.maxItems * i.jobTitles.length * locs;
  w.push("jobTitles matching is FUZZY — a deterministic title post-filter is mandatory");
  w.push("the posting company may not be the employer — run aggregator evidence before trusting it");
  return build(K, i, "job",
    cost(K, rows, undefined,
      `maxItems(${i.maxItems}) x jobTitles(${i.jobTitles.length}) x locations(${locs}) = up to ${rows} paid rows`),
    w, `${i.company.length}co`);
}

/** Bounds for a discovery call: titles × locations × maxItems is the bill. */
export const JOB_DISCOVERY_LIMITS = Object.freeze({ jobTitles: 3, locations: 2, maxItems: 50, industryIds: 10 });

/**
 * THE TITLES A JOB-DISCOVERY CALL MAY SEND, BOUNDED BEFORE IT IS COMPILED.
 *
 * Query B a9a6791a: route control proposed FOUR titles to an actor that accepts
 * three. The compiler refused it (correctly), the refusal became the slice's
 * `schema_failure`, and the query was never asked. The slice-2 selector also
 * searched "account manager" for a sales mission — an account-care title the
 * role filter then rejected, 22 of 30 rows at a time. Both are fixed here, in
 * one deterministic pass, before `compileHarvestJobDiscoveryInput` sees them:
 *
 *   1. every entry is split into its LinkedIn boolean terms (`a OR "b c"`);
 *   2. a term that names a DIFFERENT known role family than the mission asked
 *      for is dropped ("Account Manager" / "Customer Success Manager" for
 *      gtm_sales); a term no family recognises is kept — the post-filter
 *      decides it, the query is not narrowed on a guess;
 *   3. duplicates are removed (case-insensitive) BEFORE anything is counted;
 *   4. entries beyond the limit are FOLDED into the last allowed entry as one
 *      OR expression — never truncated, so every surviving title is asked.
 *
 * Order is the planner's (first appearance), so the answer is a pure function
 * of the input. An input that needs none of this is returned unchanged, which
 * keeps its input hash — and its idempotency key — exactly as before.
 */
export function boundJobDiscoveryTitles(
  titles: readonly string[],
  requested: { role_families: readonly string[] } | null,
  limit: number,
): string[] {
  const families = (requested?.role_families ?? []).filter((f): f is Exclude<RoleFamily, null | "custom"> =>
    Object.hasOwn(ROLE_FAMILY_ALIASES, f));
  const offFamily = (term: string): boolean => {
    if (families.length === 0) return false;
    const fam = classifyRoleFamily(term);
    if (!fam || fam === "custom" || families.includes(fam as never)) return false;
    return !families.some((f) => roleMatchesFamily(term, f));
  };
  const terms = (entry: string) => String(entry).split(/\s+OR\s+/)
    .map((t) => t.trim().replace(/^[("']+|[)"']+$/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set<string>();
  let changed = false;
  const kept: string[][] = [];
  for (const entry of titles) {
    const all = terms(entry);
    const out: string[] = [];
    for (const t of all) {
      const key = t.toLowerCase();
      if (seen.has(key) || offFamily(t)) { changed = true; continue; }
      seen.add(key);
      out.push(t);
    }
    if (out.length) kept.push(out);
    else changed = true;
  }
  // Nothing in the mission's family survived: keep the planner's question (deduped)
  // rather than send none — the post-filter still decides every row.
  if (kept.length === 0) return titles.length <= limit ? [...titles] : boundJobDiscoveryTitles(titles, null, limit);
  if (!changed && kept.length <= limit) return [...titles];
  const quote = (t: string) => /\s/.test(t) ? `"${t}"` : t;
  const join = (ts: string[]) => ts.length === 1 ? ts[0] : ts.map(quote).join(" OR ");
  const head = kept.slice(0, Math.max(0, limit - 1));
  const tail = kept.slice(head.length).flat();
  return [...head.map(join), ...(tail.length ? [join(tail)] : [])];
}

export function compileHarvestJobDiscoveryInput(
  i: HarvestJobDiscoveryInput & { company?: unknown },
): CompileResult<HarvestJobDiscoveryInput> {
  const K = "apify_linkedin_job_search";
  const e: string[] = []; const w: string[] = [];
  if (i.company !== undefined) {
    e.push("company[] must be absent — a discovery call finds employers; a company-scoped call verifies them (compileHarvestJobSearchInput)");
  }
  if (!i.jobTitles?.length) e.push("jobTitles[] is required — the role IS the discovery question");
  checkMax(e, "jobTitles", i.jobTitles, JOB_DISCOVERY_LIMITS.jobTitles);
  checkMax(e, "locations", i.locations, JOB_DISCOVERY_LIMITS.locations);
  checkMax(e, "industryIds", i.industryIds, JOB_DISCOVERY_LIMITS.industryIds);
  if (!i.postedLimit || !JOB_POSTED_LIMITS.includes(i.postedLimit)) {
    e.push(`postedLimit is required for discovery — verified enum is ${JOB_POSTED_LIMITS.join(" | ")}`);
  }
  checkEnum(e, "workplaceType", i.workplaceType, JOB_WORKPLACE_TYPES);
  checkEnum(e, "employmentType", i.employmentType, JOB_EMPLOYMENT_TYPES);
  checkEnum(e, "experienceLevel", i.experienceLevel, JOB_EXPERIENCE_LEVELS);
  if (i.sortBy && !JOB_SORT_BY.includes(i.sortBy)) e.push(`sortBy: "${i.sortBy}" invalid`);
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1) e.push("maxItems must be a positive integer");
  else if (i.maxItems > JOB_DISCOVERY_LIMITS.maxItems) e.push(`maxItems ${i.maxItems} exceeds the discovery bound ${JOB_DISCOVERY_LIMITS.maxItems}`);
  for (const t of i.jobTitles ?? []) {
    if (typeof t !== "string" || !t.trim()) e.push("jobTitles entries must be non-empty strings");
  }
  if (e.length) return fail(K, e);
  const locs = Math.max(1, i.locations?.length ?? 1);
  const rows = i.maxItems * i.jobTitles.length * locs;
  w.push("jobTitles matching is FUZZY — the role vocabulary decides, never the query");
  w.push("staffing agencies post on behalf of clients — the agency guard drops them before any paid stage");
  return build(K, i as HarvestJobDiscoveryInput, "job",
    cost(K, rows, undefined,
      `maxItems(${i.maxItems}) x jobTitles(${i.jobTitles.length}) x locations(${locs}) = up to ${rows} paid rows`),
    w, `discovery:${i.jobTitles.length}q`);
}

export function compileHarvestCompanyEmployeesInput(
  i: HarvestCompanyEmployeesInput,
): CompileResult<HarvestCompanyEmployeesInput> {
  const K = "apify_linkedin_company_employees";
  const e: string[] = []; const w: string[] = [];
  if (!i.companies?.length) e.push("companies[] is required");
  checkMax(e, "companies", i.companies, 1000);
  checkMax(e, "jobTitles", i.jobTitles, 50);
  for (const c of i.companies ?? []) {
    if (!LINKEDIN_COMPANY_URL.test(c)) e.push(`companies: "${c}" is not a LinkedIn company URL`);
  }
  if (!COMPANY_EMPLOYEES_SCRAPER_MODES.includes(i.profileScraperMode)) {
    // The most valuable single check here: the sibling Actor's value is the
    // likeliest wrong input, and it fails SILENTLY on the platform.
    const looksLikeProfileSearch = (PROFILE_SEARCH_SCRAPER_MODES as readonly string[])
      .includes(i.profileScraperMode as string);
    e.push(
      `profileScraperMode: "${i.profileScraperMode}" invalid for this Actor` +
      (looksLikeProfileSearch
        ? " — that is the linkedin-profile-search enum. This Actor embeds the price in the value."
        : "") +
      ` Allowed: ${COMPANY_EMPLOYEES_SCRAPER_MODES.join(" | ")}`,
    );
  }
  if (EMAIL_ENRICHMENT_MODES.includes(i.profileScraperMode)) {
    e.push("email search mode is forbidden — no contact enrichment in this layer");
  }
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1) e.push("maxItems must be a positive integer");
  if (e.length) return fail(K, e);
  if (i.maxItemsPerCompany === undefined) {
    w.push("no maxItemsPerCompany set — results are unbounded per company");
  }
  const per = i.profileScraperMode.startsWith("Short") ? 0.003 : 0.008;
  return build(K, i, "person", cost(K, i.maxItems, per), w, `${i.companies.length}co`);
}

export function compileHarvestProfileSearchInput(
  i: HarvestProfileSearchInput,
): CompileResult<HarvestProfileSearchInput> {
  const K = "apify_people_search";
  const e: string[] = []; const w: string[] = [];
  checkMax(e, "currentCompanies", i.currentCompanies, 50);
  checkMax(e, "currentJobTitles", i.currentJobTitles, 50);
  if (!PROFILE_SEARCH_SCRAPER_MODES.includes(i.profileScraperMode)) {
    const looksLikeEmployees = (COMPANY_EMPLOYEES_SCRAPER_MODES as readonly string[])
      .includes(i.profileScraperMode as string);
    e.push(
      `profileScraperMode: "${i.profileScraperMode}" invalid for this Actor` +
      (looksLikeEmployees
        ? " — that is the linkedin-company-employees enum, which embeds a price string."
        : "") +
      ` Allowed: ${PROFILE_SEARCH_SCRAPER_MODES.join(" | ")}`,
    );
  }
  if (EMAIL_ENRICHMENT_MODES.includes(i.profileScraperMode)) {
    e.push("email search mode is forbidden — no contact enrichment in this layer");
  }
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1) e.push("maxItems must be a positive integer");
  if (e.length) return fail(K, e);
  w.push("fallback only — no per-company cap exists and the run minimum is $0.10");
  return build(K, i, "person", cost(K, i.maxItems), w, "profile-search");
}


/**
 * Compile a contact-enrichment call against ONE known person.
 *
 * ── THE THREE THINGS THIS REFUSES ───────────────────────────────────────────
 *
 *   NO TARGET          the Actor accepts urls / publicIdentifiers / profileIds
 *                      and needs at least one. With none it runs, returns
 *                      nothing, and still bills.
 *   A SIBLING'S ENUM   three people Actors, three vocabularies for one idea. An
 *                      unrecognised value does not error on the platform, it
 *                      falls back to the Actor default — the expensive one.
 *   UNAUTHORISED EMAIL the email mode is a purchase the user makes, not a mode
 *                      a caller selects. See `emailLookupAuthorized`.
 */
export function compileHarvestProfileScraperInput(
  i: ProfileScraperCompileArgs,
): CompileResult<HarvestProfileScraperInput> {
  const K = "apify_linkedin_profile_enrichment";
  const e: string[] = []; const w: string[] = [];

  const targets = (i.urls?.length ?? 0) + (i.publicIdentifiers?.length ?? 0) +
    (i.profileIds?.length ?? 0);
  if (targets === 0) {
    e.push(
      "no target: one of urls[], publicIdentifiers[] or profileIds[] is required. " +
      "This Actor enriches a KNOWN person and never searches for one.");
  }
  checkMax(e, "urls", i.urls, 1000);
  checkMax(e, "publicIdentifiers", i.publicIdentifiers, 1000);
  checkMax(e, "profileIds", i.profileIds, 1000);

  // A LinkedIn COMPANY url in a person field is the wrong entity entirely.
  for (const u of i.urls ?? []) {
    if (LINKEDIN_COMPANY_URL.test(u)) {
      e.push(`urls: "${u}" is a company page, not a person`);
    }
  }

  if (!(PROFILE_SCRAPER_MODES as readonly string[]).includes(i.profileScraperMode)) {
    const sibling =
      (COMPANY_EMPLOYEES_SCRAPER_MODES as readonly string[]).includes(i.profileScraperMode as string)
        ? " — that is the linkedin-company-employees enum."
        : (PROFILE_SEARCH_SCRAPER_MODES as readonly string[]).includes(i.profileScraperMode as string)
        ? " — that is the linkedin-profile-search enum."
        : "";
    e.push(
      `profileScraperMode: "${i.profileScraperMode}" invalid for this Actor${sibling}` +
      ` Allowed: ${PROFILE_SCRAPER_MODES.join(" | ")}`);
  }

  // ── CONSENT, BOTH WAYS ───────────────────────────────────────────────────
  //
  // An email mode without authorisation is a silent purchase. Authorisation
  // without the email mode is a caller that thinks it bought something it did
  // not ask for — and would report "no email found" for a lookup that never ran.
  const wantsEmail = i.profileScraperMode === PROFILE_SCRAPER_EMAIL_MODE;
  if (wantsEmail && i.emailLookupAuthorized !== true) {
    e.push(
      "email search requires emailLookupAuthorized: true. Finding a person and " +
      "buying their contact details are separate, separately-priced actions.");
  }
  if (!wantsEmail && i.emailLookupAuthorized === true) {
    e.push(
      "emailLookupAuthorized is set but the mode performs no lookup — this would " +
      "report 'no email found' for a search that never ran.");
  }

  if (e.length) return fail(K, e);

  if (targets > 1) {
    w.push(`${targets} profiles in one call — each is billed separately`);
  }
  if (wantsEmail) {
    w.push(
      "email search is BEST EFFORT and bills whether or not an address is found; " +
      "a miss is an honest not_found, never an inferred address");
  }

  // THE PAYLOAD, WITH THE AUTHORISATION STRIPPED. `emailLookupAuthorized` is a
  // fact about the user's consent and would be a field this Actor has never
  // heard of. Destructured out rather than deleted, so a future field added to
  // the args type has to be handled here deliberately.
  const { emailLookupAuthorized: _consent, ...payload } = i;

  // ROWS ARE TARGETS. There is no maxItems on this Actor — the number of
  // profiles billed is the number asked for, which is the length of the list.
  // Read from the live Store schema: $0.004 details, $0.010 details+email.
  const per = wantsEmail ? 0.01 : 0.004;
  return build(K, payload as HarvestProfileScraperInput, "person",
    cost(K, targets, per), w, `${targets}p`);
}

// ── FUNDING ROUNDS (datahyena/company-funding-rounds) ────────────────────────

export interface DatahyenaFundingInput {
  /** ISO date. The recency filter, and the ONLY one this Actor offers. */
  since?: string;
  round?: string[];
  verticals?: string[];
  countries?: string[];
  employeeBuckets?: string[];
  minAmountUsd?: number;
  maxAmountUsd?: number;
  /** Billed PER RECORD RETURNED. The single cost multiplier. */
  maxItems: number;
  cursor?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

/**
 * Compile a bounded, verified funding-discovery call.
 *
 * ── WHAT THIS REFUSES, AND WHY ──────────────────────────────────────────────
 *
 * `maxItems` is the whole cost model here: one charge per record returned, at
 * the highest per-row price of any Actor in this catalog (see its card). An
 * unbounded or accidentally large value is the most expensive mistake available
 * in the system, so it is required and capped rather than defaulted.
 *
 * The stage warning matters as much as the errors. Five stages are accepted by
 * the schema and documented by the vendor as having no coverage yet; a mission
 * asking only for those would run, cost the start fee, return nothing, and look
 * exactly like "no companies matched". The warning is what lets a zero-row
 * result be reported as an unserved filter instead of an empty market.
 */
export function compileDatahyenaFundingInput(
  i: DatahyenaFundingInput,
): CompileResult<DatahyenaFundingInput> {
  const K = "apify_funding_rounds_datahyena";
  const e: string[] = []; const w: string[] = [];

  checkEnum(e, "round", i.round, FUNDING_ROUND_STAGES);
  checkEnum(e, "verticals", i.verticals, FUNDING_VERTICALS);
  checkEnum(e, "countries", i.countries, FUNDING_COUNTRIES);
  checkEnum(e, "employeeBuckets", i.employeeBuckets, FUNDING_EMPLOYEE_BUCKETS);

  if (i.since !== undefined && !ISO_DATE_RE.test(String(i.since))) {
    e.push(`since: "${i.since}" is not an ISO date (YYYY-MM-DD)`);
  }
  if (!Number.isInteger(i.maxItems) || i.maxItems < 1) {
    e.push("maxItems must be a positive integer — this Actor bills per record");
  } else if (i.maxItems > 500) {
    // A ceiling, not a preference. The price is READ FROM THE CARD, never
    // written here: this message once quoted the old price after the Store
    // had repriced, and a refusal that under-states the cost is worse than none.
    const price = perResultPriceUsd(K);
    e.push(`maxItems ${i.maxItems} exceeds the 500-record ceiling for this Actor` +
      (price === null ? "" :
        ` (billed per record at $${price}; ${i.maxItems} rows would cost ~$${(i.maxItems * price).toFixed(2)})`));
  }
  if (i.minAmountUsd !== undefined && i.maxAmountUsd !== undefined &&
      i.minAmountUsd > i.maxAmountUsd) {
    e.push("minAmountUsd is greater than maxAmountUsd — no row can match");
  }
  if (e.length) return fail(K, e);

  const dead = (i.round ?? []).filter((r) =>
    (FUNDING_STAGES_WITHOUT_COVERAGE as readonly string[]).includes(r));
  if (dead.length > 0 && dead.length === (i.round ?? []).length) {
    w.push(
      `every requested stage (${dead.join(", ")}) is documented by the provider ` +
      `as having no coverage yet — this run will return zero rows, and that is ` +
      `an unserved filter rather than an empty market`);
  } else if (dead.length > 0) {
    w.push(`stage(s) ${dead.join(", ")} have no coverage yet and will contribute nothing`);
  }
  if (i.countries?.length && !i.countries.includes("unknown")) {
    w.push("about a quarter of companies have no HQ country on record and are " +
      "excluded by any country filter — add \"unknown\" to keep those deals in");
  }
  if (i.since === undefined) {
    w.push("no `since` filter — results start from the newest records but are " +
      "not bounded by date, so recency cannot be claimed from the input alone");
  }
  w.push("amounts are announced figures normalized to USD, not audited numbers");

  return build(K, {
    ...i,
    ...(i.round !== undefined ? { round: asList<string>(i.round) } : {}),
    ...(i.verticals !== undefined ? { verticals: asList<string>(i.verticals) } : {}),
    ...(i.countries !== undefined ? { countries: asList<string>(i.countries) } : {}),
    ...(i.employeeBuckets !== undefined
      ? { employeeBuckets: asList<string>(i.employeeBuckets) } : {}),
  }, "company", cost(K, i.maxItems, undefined,
    "one charge per record returned; maxItems is the cap"), w,
  `funding:${i.since ?? "any"}`);
}


// ── SOCIAL POSTS ─────────────────────────────────────────────────────────────
//
// ── WHERE THE COMPANY/PERSON BOUNDARY ACTUALLY LIVES ────────────────────────
//
// `harvestapi/linkedin-company-posts` and `harvestapi/linkedin-profile-posts`
// have IDENTICAL input schemas and both accept `/company/` and `/in/` URLs. The
// company Actor's own prefill ships a personal profile. So calling "the company
// Actor" guarantees nothing about scope: two Actors that do the same thing
// cannot enforce a distinction between them.
//
// These two compilers are the boundary. One refuses a person URL, the other
// refuses a company URL, and `socialEvidence.test.ts` asserts both refusals.
// Everything downstream — the evidence table's subject scope, the unlock gate on
// person-level signals, the separation of a company post from a leadership post
// — rests on this being enforced HERE rather than assumed elsewhere.

const COMPANY_URL_RE = /^https?:\/\/(www\.)?linkedin\.com\/company\/[^/?#]+/i;
const PERSON_URL_RE = /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+/i;

export interface LinkedInPostsInput {
  targetUrls: string[];
  maxPosts: number;
  postedLimit?: string;
  postedLimitDate?: string;
  includeQuotePosts?: boolean;
  includeReposts?: boolean;
  scrapeComments?: boolean;
  maxComments?: number;
  commentsPostedLimit?: string;
  scrapeReactions?: boolean;
  maxReactions?: number;
  contextCountry?: string;
}

/** Shared validation for the two URL-fed post Actors. */
function checkPostsInput(
  K: string, i: LinkedInPostsInput, want: "company" | "person",
): { e: string[]; w: string[] } {
  const e: string[] = []; const w: string[] = [];
  const urls = asList<string>(i.targetUrls ?? []);
  if (urls.length === 0) e.push("targetUrls must name at least one LinkedIn URL");

  const re = want === "company" ? COMPANY_URL_RE : PERSON_URL_RE;
  const other = want === "company" ? PERSON_URL_RE : COMPANY_URL_RE;
  for (const u of urls) {
    if (re.test(u)) continue;
    if (other.test(u)) {
      // THE SCOPE VIOLATION, named precisely. This is the refusal that keeps a
      // leadership post from being collected under a company capability and
      // vice versa — including the unlock boundary, since a person URL reaching
      // the ungated company Actor would buy person data with no unlock.
      e.push(
        `targetUrls: "${u}" is a ${want === "company" ? "PERSON" : "COMPANY"} URL ` +
        `and this capability is ${want}-scoped. The two post Actors accept both ` +
        `shapes, so scope is enforced here or nowhere.`);
    } else {
      e.push(`targetUrls: "${u}" is not a LinkedIn ${want} URL`);
    }
  }

  if (!Number.isInteger(i.maxPosts) || i.maxPosts < 1) {
    // 0 is the Actor's "ALL POSTS" sentinel — an unbounded spend, not an empty run.
    e.push("maxPosts must be a positive integer (0 means ALL posts on this Actor)");
  } else if (i.maxPosts > 50) {
    e.push(`maxPosts ${i.maxPosts} exceeds the 50-per-target ceiling`);
  }
  if (i.postedLimit !== undefined &&
      !(POST_POSTED_LIMITS as readonly string[]).includes(i.postedLimit)) {
    e.push(`postedLimit: "${i.postedLimit}" is not a verified value`);
  }
  if (i.commentsPostedLimit !== undefined &&
      !(COMMENT_POSTED_LIMITS as readonly string[]).includes(i.commentsPostedLimit)) {
    e.push(`commentsPostedLimit: "${i.commentsPostedLimit}" is not verified on this Actor`);
  }
  if (i.contextCountry !== undefined &&
      !(POST_CONTEXT_COUNTRIES as readonly string[]).includes(i.contextCountry)) {
    e.push(`contextCountry: "${i.contextCountry}" is not a verified value`);
  }
  if (i.scrapeComments && (!Number.isInteger(i.maxComments) || (i.maxComments ?? 0) < 1)) {
    e.push("maxComments must be a positive integer when scrapeComments is on");
  }
  if (i.scrapeComments && (i.maxComments ?? 0) > 25) {
    e.push(`maxComments ${i.maxComments} exceeds the 25-per-post ceiling — ` +
      `comments are billed at the same price as posts`);
  }
  if (i.scrapeReactions) {
    // Reactions cost the same as a post and prove nothing this architecture uses.
    e.push("scrapeReactions is forbidden — a reaction count is not evidence and " +
      "each reaction is billed at the price of a post");
  }
  if (i.postedLimit === undefined && i.postedLimitDate === undefined) {
    w.push("no date bound — recency cannot be claimed from the input alone and " +
      "must be re-checked from each post's own date");
  }
  return { e, w };
}

function postsCostNote(i: LinkedInPostsInput): string {
  const posts = i.maxPosts;
  const comments = i.scrapeComments ? (i.maxComments ?? 0) * posts : 0;
  return `up to ${posts} posts + ${comments} comments per target, each billed as a result`;
}

/** COMPANY-scoped post reading. Refuses a person URL. */
export function compileCompanyPostsInput(
  i: LinkedInPostsInput,
): CompileResult<LinkedInPostsInput> {
  const K = "apify_linkedin_company_posts";
  const { e, w } = checkPostsInput(K, i, "company");
  if (e.length) return fail(K, e);
  w.push("comments on a company's post are engagement RECEIVED from other " +
    "people — never a statement by the company");
  const rows = i.maxPosts * i.targetUrls.length * (i.scrapeComments ? 1 + (i.maxComments ?? 0) : 1);
  return build(K, { ...i, targetUrls: asList<string>(i.targetUrls), scrapeReactions: false },
    "company", cost(K, rows, undefined, postsCostNote(i)), w,
    `companyposts:${i.targetUrls.join(",")}`);
}

/** PERSON-scoped post reading. Refuses a company URL. Unlock-gated upstream. */
export function compileProfilePostsInput(
  i: LinkedInPostsInput,
): CompileResult<LinkedInPostsInput> {
  const K = "apify_linkedin_profile_posts";
  const { e, w } = checkPostsInput(K, i, "person");
  if (e.length) return fail(K, e);
  w.push("this Actor reads an IDENTIFIED person's profile; producing that " +
    "profile URL is the unlock-gated people stage and is never automatic");
  const rows = i.maxPosts * i.targetUrls.length * (i.scrapeComments ? 1 + (i.maxComments ?? 0) : 1);
  return build(K, { ...i, targetUrls: asList<string>(i.targetUrls), scrapeReactions: false },
    "person", cost(K, rows, undefined, postsCostNote(i)), w,
    `profileposts:${i.targetUrls.join(",")}`);
}

// ── SOCIAL: TOPIC SEARCH ─────────────────────────────────────────────────────

export interface LinkedInPostSearchInput {
  searchQueries: string[];
  maxPosts: number;
  postedLimit?: string;
  postedLimitDate?: string;
  sortBy?: string;
  authorUrls?: string[];
  authorsCompanies?: string[];
  authorKeywords?: string;
  contentType?: string;
  profileScraperMode?: string;
  scrapeComments?: boolean;
  maxComments?: number;
  commentsPostedLimit?: string;
  commentsProfileScraperMode?: string;
  scrapeReactions?: boolean;
  scrapePages?: number;
}

/**
 * Compile a topic post search.
 *
 * COMMENTS ARE THE EXPENSIVE PART AND THE VALUABLE PART. They are billed at the
 * same price as a post, so `maxPosts: 50` with `maxComments: 10` is up to 550
 * billable items rather than 50 — the estimate says so rather than discovering
 * it on the invoice. They are also the only way "who commented on this topic"
 * is answerable at all, because the commenter's profile arrives with them.
 */
export function compilePostSearchInput(
  i: LinkedInPostSearchInput,
): CompileResult<LinkedInPostSearchInput> {
  const K = "apify_linkedin_post_search";
  const e: string[] = []; const w: string[] = [];

  const queries = asList<string>(i.searchQueries ?? []).filter((q) => q.trim().length > 0);
  if (queries.length === 0) e.push("searchQueries must contain at least one non-empty query");

  if (!Number.isInteger(i.maxPosts) || i.maxPosts < 1) {
    e.push("maxPosts must be a positive integer (0 means ALL posts on this Actor)");
  } else if (i.maxPosts > 100) {
    e.push(`maxPosts ${i.maxPosts} exceeds the 100-per-query ceiling`);
  }
  if (i.postedLimit !== undefined &&
      !(POST_POSTED_LIMITS as readonly string[]).includes(i.postedLimit)) {
    e.push(`postedLimit: "${i.postedLimit}" is not a verified value`);
  }
  if (i.sortBy !== undefined && !(POST_SEARCH_SORT_BY as readonly string[]).includes(i.sortBy)) {
    e.push(`sortBy: "${i.sortBy}" is not a verified value`);
  }
  if (i.contentType !== undefined &&
      !(POST_CONTENT_TYPES as readonly string[]).includes(i.contentType)) {
    e.push(`contentType: "${i.contentType}" is not a verified value`);
  }
  for (const [field, v] of [
    ["profileScraperMode", i.profileScraperMode],
    ["commentsProfileScraperMode", i.commentsProfileScraperMode],
  ] as const) {
    if (v !== undefined && !(POST_PROFILE_SCRAPER_MODES as readonly string[]).includes(v)) {
      e.push(`${field}: "${v}" is not a verified value`);
    }
  }
  if (i.scrapeComments && (!Number.isInteger(i.maxComments) || (i.maxComments ?? 0) < 1)) {
    e.push("maxComments must be a positive integer when scrapeComments is on");
  }
  if (i.scrapeComments && (i.maxComments ?? 0) > 25) {
    e.push(`maxComments ${i.maxComments} exceeds the 25-per-post ceiling`);
  }
  if (i.scrapeReactions) {
    e.push("scrapeReactions is forbidden — a reaction is billed at the price of a " +
      "post and proves nothing this architecture uses");
  }
  if (i.scrapePages !== undefined && i.scrapePages > 1) {
    e.push(`scrapePages ${i.scrapePages} would fetch ${i.scrapePages * 100} posts; ` +
      `bound the run with maxPosts instead`);
  }
  if (e.length) return fail(K, e);

  if (i.postedLimit === undefined && i.postedLimitDate === undefined) {
    w.push("no date bound — a topic search returns whatever ranks, at any age");
  }
  w.push("LinkedIn relevance decides what matches, not a topic model; the topic " +
    "qualifier must be re-checked against each post's own text");
  if (i.authorKeywords) {
    w.push("authorKeywords matches a self-written headline — a headline claiming " +
      "CEO is not verified employment");
  }
  const perQuery = i.maxPosts * (i.scrapeComments ? 1 + (i.maxComments ?? 0) : 1);
  const rows = perQuery * queries.length;
  if (i.scrapeComments) {
    w.push(`comments are billed as results: up to ${rows} billable items, not ${i.maxPosts * queries.length}`);
  }
  return build(K, {
    ...i, searchQueries: queries, scrapeReactions: false,
    ...(i.authorUrls !== undefined ? { authorUrls: asList<string>(i.authorUrls) } : {}),
    ...(i.authorsCompanies !== undefined
      ? { authorsCompanies: asList<string>(i.authorsCompanies) } : {}),
  }, "company", cost(K, rows, undefined,
    `maxPosts x (1 + maxComments) x ${queries.length} queries`), w,
  `postsearch:${queries.join("|")}`);
}

// ── NEWS ─────────────────────────────────────────────────────────────────────

export interface GoogleNewsInput {
  keywords?: string[];
  topics?: string[];
  maxArticles: number;
  timeframe?: string;
  region_language?: string;
  decodeUrls?: boolean;
  extractDescriptions?: boolean;
  extractImages?: boolean;
}

/**
 * Compile a news search.
 *
 * `decodeUrls` is FORCED ON. The vendor notes it slows the run, and that is the
 * right trade: an undecoded link is a Google redirect, and a citation nobody can
 * follow is not a source. Expansion and launch evidence both rest on being able
 * to show the article that made the claim.
 */
export function compileGoogleNewsInput(
  i: GoogleNewsInput,
): CompileResult<GoogleNewsInput> {
  const K = "apify_google_news";
  const e: string[] = []; const w: string[] = [];

  const keywords = asList<string>(i.keywords ?? []).filter((k) => k.trim().length > 0);
  const topics = asList<string>(i.topics ?? []);
  if (keywords.length === 0 && topics.length === 0) {
    e.push("keywords or topics must be supplied — an unfiltered news run has no subject");
  }
  for (const t of topics) {
    if (!(NEWS_TOPICS as readonly string[]).includes(t)) {
      e.push(`topics: "${t}" is not a verified value`);
    }
  }
  if (i.timeframe !== undefined && !(NEWS_TIMEFRAMES as readonly string[]).includes(i.timeframe)) {
    e.push(`timeframe: "${i.timeframe}" is not a verified value`);
  }
  if (i.region_language !== undefined &&
      !(NEWS_REGION_LANGUAGES as readonly string[]).includes(i.region_language)) {
    e.push(`region_language: "${i.region_language}" is not in the verified subset`);
  }
  if (!Number.isInteger(i.maxArticles) || i.maxArticles < 1) {
    // 0 is the Actor's "NO LIMIT" sentinel.
    e.push("maxArticles must be a positive integer (0 means NO LIMIT on this Actor)");
  } else if (i.maxArticles > 100) {
    e.push(`maxArticles ${i.maxArticles} exceeds the 100-per-query ceiling`);
  }
  if (e.length) return fail(K, e);

  if (topics.length > 0 && i.timeframe !== undefined) {
    w.push("timeframe applies to KEYWORD searches only — topic pages return their " +
      "own curated results at any age, so recency must be re-checked per article");
  }
  w.push("an article names a company in prose; a name is not an identity and must " +
    "never attach an article to a company on its own");
  // OBSERVED, run ak9nBcyYkolVrLQhM: a literal phrase search returned a court
  // system "expanding into family courts" and a payments company "expanding
  // deeper into AI" alongside two genuine office openings. Roughly half the
  // rows were not the signal asked for.
  w.push("Google News matches the phrase, not the meaning: a keyword search for " +
    "expansion language returns metaphorical uses and non-company subjects, so " +
    "each article's own claim must be read before it counts as evidence");
  const rows = i.maxArticles * Math.max(1, keywords.length + topics.length);
  return build(K, {
    ...i,
    ...(keywords.length ? { keywords } : {}),
    ...(topics.length ? { topics } : {}),
    decodeUrls: true,
    // ── FORCED ON AFTER THE VALIDATION RUN ────────────────────────────────
    //
    // Run ak9nBcyYkolVrLQhM returned no `description` at all, because the
    // vendor only extracts it when this is set. The description IS the claim —
    // "the Berlin security firm said it is entering the US market" — and
    // expansion and launch evidence are claims, not headlines. A title alone
    // cannot distinguish a company entering a market from a court system
    // expanding its e-filing, which that same run demonstrated.
    //
    // It costs time and not money: billing is per RESULT, not per field.
    extractDescriptions: true,
    // Images are billed as part of the same result but slow the run and are
    // never evidence here.
    extractImages: false,
  }, "company", cost(K, rows, undefined,
    "maxArticles per keyword AND per topic"), w,
  `news:${[...keywords, ...topics].join("|")}`);
}

// ── TECHNOLOGY ───────────────────────────────────────────────────────────────

export interface BuiltWithInput {
  startDomains: string[];
  maxRequestsPerCrawl: number;
}

const ROOT_DOMAIN_RE = /^(?:[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*\.){1,3}[A-Za-z]{2,}$/;

/**
 * Compile a technology verification call.
 *
 * There is nothing to search here. The Actor's entire input is a list of domains
 * and a request cap, which is why technology is declared verification-only: a
 * mission that wants companies BY technology has no route through this, and
 * saying so is more useful than compiling a call that cannot answer it.
 */
export function compileBuiltWithInput(
  i: BuiltWithInput,
): CompileResult<BuiltWithInput> {
  const K = "apify_builtwith_technology";
  const e: string[] = []; const w: string[] = [];

  const domains = asList<string>(i.startDomains ?? []);
  if (domains.length === 0) {
    e.push("startDomains must name at least one root domain — this Actor cannot search");
  }
  for (const d of domains) {
    if (!ROOT_DOMAIN_RE.test(d)) {
      e.push(`startDomains: "${d}" is not a root domain (the schema enforces this pattern)`);
    }
  }
  if (!Number.isInteger(i.maxRequestsPerCrawl) || i.maxRequestsPerCrawl < 1) {
    // The published DEFAULT is 10,000,000. Never inherit it.
    e.push("maxRequestsPerCrawl must be set explicitly — the Actor's own default is 10,000,000");
  } else if (i.maxRequestsPerCrawl > 500) {
    e.push(`maxRequestsPerCrawl ${i.maxRequestsPerCrawl} exceeds the 500 ceiling`);
  }
  if (e.length) return fail(K, e);

  w.push("a detection is present-tense: it carries no adoption date, so " +
    "'recently adopted' cannot be answered from this Actor");
  return build(K, { ...i, startDomains: domains }, "company",
    cost(K, domains.length, undefined, "one result per domain"), w,
    `builtwith:${domains.join(",")}`);
}
