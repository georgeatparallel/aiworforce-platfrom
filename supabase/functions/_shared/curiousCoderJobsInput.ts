// ACTOR-NATIVE input for `curious_coder/linkedin-jobs-scraper`.
//
// The actor does NOT accept Agentory's generic wrapper fields. Its native schema is
//   { urls: string[], count: number, scrapeCompany: boolean, ... }
// where each URL is a complete LinkedIn Jobs search URL carrying `keywords` and
// `location` as query parameters.
//
// PROVEN root cause of the 2026-07-25 empty search: `runTool` reads query/location/
// max_results from the TOP LEVEL of the tool input (toolRegistry `i.query`,
// `i.location`), while anything under `input:` becomes `user_input`. The
// company-first closure passed them NESTED under `input:`, so the adapter saw
// keywords=null and location=null and built
//   https://www.linkedin.com/jobs/search/?position=1&pageNum=0
// — the exact unfiltered URL echoed back in every returned row. The sentence never
// even reached LinkedIn; the search had no keywords at all.
//
// `count` is a SINGLE run-level cap that applies across every URL in the run, so
// three keyword variants are ONE invocation with count=25 — never 3 × 25.

const LINKEDIN_JOBS_SEARCH = "https://www.linkedin.com/jobs/search/";

/** Actor minimum is 10; hard ceiling 100. */
export const JOBS_ACTOR_MIN_COUNT = 10;
export const JOBS_ACTOR_MAX_COUNT = 100;

export const CURIOUS_CODER_JOBS_ADAPTER_VERSION = "curious_coder.linkedin-jobs-scraper.v1";

export interface CuriousCoderJobsNativeInput {
  urls: string[];
  count: number;
  scrapeCompany: boolean;
  useIncognitoMode: boolean;
  splitByLocation: boolean;
}

/** Build ONE complete LinkedIn Jobs search URL. Values are URL-encoded — never
 * string-concatenated — so a keyword containing `&`, `#` or a space is safe. */
export function buildLinkedInJobsSearchUrl(keywords: string | null | undefined, location: string | null | undefined): string {
  const url = new URL(LINKEDIN_JOBS_SEARCH);
  const k = (keywords ?? "").trim();
  const l = (location ?? "").trim();
  if (k) url.searchParams.set("keywords", k);
  if (l) url.searchParams.set("location", l);
  url.searchParams.set("position", "1");
  url.searchParams.set("pageNum", "0");
  return url.toString();
}

/** One URL per compiled keyword variant, all sharing the same location. */
export function buildLinkedInJobsSearchUrls(keywordQueries: string[], location: string | null): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const kw of keywordQueries) {
    if (!kw || !kw.trim()) continue;
    const u = buildLinkedInJobsSearchUrl(kw, location);
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
  }
  return urls;
}

export interface CuriousCoderJobsBuildArgs {
  /** Pre-built URLs win (the company-first path supplies compiled variants). */
  urls?: string[] | null;
  keywords?: string | null;
  location?: string | null;
  /** The SHARED run-level ceiling across every URL. */
  maxResults: number;
  scrapeCompany?: boolean;
  useIncognitoMode?: boolean;
  splitByLocation?: boolean;
}

/**
 * Produce the exact native JSON the actor expects. Never emits `query`,
 * `keywords`, `max_results`, `defer_persistence` or any Agentory wrapper control.
 */
export function buildCuriousCoderLinkedInJobsInput(args: CuriousCoderJobsBuildArgs): CuriousCoderJobsNativeInput {
  const urls = args.urls && args.urls.length
    ? args.urls.filter((u) => typeof u === "string" && u.trim().length > 0)
    : [buildLinkedInJobsSearchUrl(args.keywords ?? null, args.location ?? null)];

  return {
    urls,
    // Run-level cap shared by every URL — NOT per URL.
    count: Math.max(JOBS_ACTOR_MIN_COUNT, Math.min(JOBS_ACTOR_MAX_COUNT, Math.floor(args.maxResults))),
    scrapeCompany: args.scrapeCompany ?? true,
    useIncognitoMode: args.useIncognitoMode ?? false,
    splitByLocation: args.splitByLocation ?? false,
  };
}

/** Safe observability — no tokens, no cookies, no personal data. */
export function describeJobsNativeInput(native: CuriousCoderJobsNativeInput, actorId: string, persistenceMode: string) {
  return {
    actor_key: "apify_jobs",
    actor_id: actorId,
    adapter_version: CURIOUS_CODER_JOBS_ADAPTER_VERSION,
    url_count: native.urls.length,
    keywords: native.urls.map((u) => new URL(u).searchParams.get("keywords")),
    location: native.urls.length ? new URL(native.urls[0]).searchParams.get("location") : null,
    count: native.count,
    persistence_mode: persistenceMode,
  };
}

// ── THE FIRST SMOKE'S SHAPE FOR THIS ACTOR ──────────────────────────────────
//
// Read from the Actor's build OpenAPI on 2026-10-16 (version 1.7, build
// cyeFbgtjjz0fqI55Q): there is NO `count` input — the run-level cap this
// adapter sends is not in the schema — and `limitPerSource` ("maximum number
// of jobs to scrape from each input URL … leave empty … up to ~1000") is the
// only result limit. It is PER URL, so the smoke sends exactly one URL.
// `scrapeCompany` is chosen explicitly: true, because the rows then carry the
// employer's industries, headcount and headquarters (apifyJobsNormalizer) and
// the Actor's pricing has no event for it (only the result and the start).
// Smoke only; the customer path above is unchanged.
export const SMOKE_JOBS_LIMIT_PER_SOURCE = 3;
export const SMOKE_JOBS_SCRAPE_COMPANY = true;

export interface CuriousCoderJobsSmokeInput {
  urls: [string];
  limitPerSource: number;
  splitByLocation: false;
  scrapeCompany: boolean;
}

export function buildCuriousCoderSmokeJobsInput(
  args: Pick<CuriousCoderJobsBuildArgs, "urls" | "keywords" | "location">,
): CuriousCoderJobsSmokeInput {
  const first = (args.urls ?? []).find((u) => typeof u === "string" && u.trim().length > 0);
  return {
    urls: [first ?? buildLinkedInJobsSearchUrl(args.keywords ?? null, args.location ?? null)],
    limitPerSource: SMOKE_JOBS_LIMIT_PER_SOURCE,
    splitByLocation: false,
    scrapeCompany: SMOKE_JOBS_SCRAPE_COMPANY,
  };
}
