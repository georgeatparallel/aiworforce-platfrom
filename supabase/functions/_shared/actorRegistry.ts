// Actor Intelligence Layer — single source of truth.
// Used by toolInputPlanner (Gemini) to pick the right actor/tool,
// and by toolRegistry/run-agent to resolve selected_actor_key -> actor_id.

import { resolveWebSearch } from "./parallelSearch.ts";

export type ActorEntry = {
  key: string;
  tool_name: "source_with_apify" | "scrape_url" | "search_web";
  provider?: string;
  actor_id: string | null;
  source_type: string | null;
  label: string;
  enabled: boolean;
  requires_explicit_opt_in?: boolean;
  best_for: string[];
  not_for: string[];
  example_user_requests?: string[];
  output_type: string;
  default_max_results?: number;
  max_safe_results?: number;
  default_max_pages?: number;
  max_safe_pages?: number;
  compliance_level: string;
  missing_message?: string;
  required_env?: string;
  /**
   * TRUE for provider variants that may ONLY be selected through the semantic
   * hiring-source catalog, never by `source_type` resolution.
   *
   * Several approved variants deliberately share a `source_type` with a
   * long-standing entry (`indeed_jobs` with the legacy Curious Coder Indeed;
   * `jobs` with the canonical LinkedIn jobs Actor) so that both normalize into the
   * same canonical job-signal structure. `resolveActorForSourceType` returns the
   * FIRST match, so without this marker adding a variant silently repoints the
   * legacy path to a different vendor purely because of declaration order.
   */
  dynamic_source_only?: boolean;
};

// ---- Env helpers ---------------------------------------------------------

function envStr(name: string): string | null {
  try {
    // @ts-ignore Deno at runtime
    if (typeof Deno !== "undefined") {
      const v = Deno.env.get(name);
      return v && v.trim() ? v.trim() : null;
    }
  } catch { /* ignore */ }
  return null;
}

function envFlag(name: string): boolean {
  const v = envStr(name);
  if (!v) return false;
  return ["1", "true", "yes", "on", "enabled"].includes(v.toLowerCase());
}

function actorId(envName: string, fallback: string | null): string | null {
  return envStr(envName) ?? fallback;
}

// ---- Registry ------------------------------------------------------------

export const ACTOR_REGISTRY: Record<string, ActorEntry> = {
  // ---- APPROVED HIRING-SOURCE PROVIDER VARIANTS (PR #106) ----------------
  //
  // Actor IDs live HERE and only here. The semantic catalog
  // (hiringSourceCatalog.ts) maps a capability like `indeed_job_discovery` to one
  // of these KEYS, so a planner never sees an implementation id, a build number
  // or a provider field name.
  //
  // COEXISTENCE, not replacement. `apify_indeed_jobs` (curious_coder) already
  // exists and is wired into the legacy deterministic path. Its Actor id, source
  // type and normalization are deliberately untouched: repointing it would swap
  // the vendor behind a live path whose output shape differs. The approved
  // Automation Lab Actor is registered as a SEPARATE variant that only the new
  // semantic capability selects.
  //
  // All five default to DISABLED. Registering a source is not switching it on.
  apify_indeed_jobs_automation_lab: {
    key: "apify_indeed_jobs_automation_lab",
    // Selectable ONLY via the semantic catalog. See `dynamic_source_only`.
    dynamic_source_only: true,
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_INDEED_JOBS_AUTOMATION_LAB", "automation-lab/indeed-scraper"),
    source_type: "indeed_jobs",
    label: "Indeed Jobs Scraper (Automation Lab)",
    // Default OFF: `required_env` is re-read at call time by
    // isActorRuntimeEnabled, so enablement stays dynamic and testable.
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: ["broad role-first hiring discovery", "SMB and mid-market coverage", "companies outside startup ecosystems"],
    not_for: ["individual people profiles", "private contact data"],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 50,
    max_safe_results: 200,
    compliance_level: "public_jobs",
    required_env: "APIFY_ENABLE_INDEED_JOBS_AUTOMATION_LAB",
    missing_message: "Indeed discovery (Automation Lab) is not enabled for this workspace.",
  },
  apify_linkedin_jobs_crawlworks: {
    key: "apify_linkedin_jobs_crawlworks",
    // Selectable ONLY via the semantic catalog. See `dynamic_source_only`.
    dynamic_source_only: true,
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_JOBS_CRAWLWORKS", "crawlworks/linkedin-jobs-scraper"),
    source_type: "jobs",
    label: "LinkedIn Jobs Scraper (crawlworks)",
    // Default OFF: `required_env` is re-read at call time by
    // isActorRuntimeEnabled, so enablement stays dynamic and testable.
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: ["professional-company hiring discovery", "strong company LinkedIn identity", "remote and hybrid filters"],
    not_for: ["individual people profiles", "private contact data"],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 25,
    max_safe_results: 200,
    compliance_level: "public_jobs",
    required_env: "APIFY_ENABLE_LINKEDIN_JOBS_CRAWLWORKS",
    missing_message: "LinkedIn job discovery (crawlworks) is not enabled for this workspace.",
  },
  apify_glassdoor_jobs: {
    key: "apify_glassdoor_jobs",
    // Selectable ONLY via the semantic catalog. See `dynamic_source_only`.
    dynamic_source_only: true,
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_GLASSDOOR_JOBS", "valig/glassdoor-jobs-scraper"),
    source_type: "jobs",
    label: "Glassdoor Jobs Scraper",
    // Default OFF: `required_env` is re-read at call time by
    // isActorRuntimeEnabled, so enablement stays dynamic and testable.
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: ["inexpensive recall expansion", "companies missed by primary sources"],
    not_for: ["individual people profiles", "primary discovery when precision matters"],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 50,
    max_safe_results: 200,
    compliance_level: "public_jobs",
    required_env: "APIFY_ENABLE_GLASSDOOR_JOBS",
    missing_message: "Glassdoor job discovery is not enabled for this workspace.",
  },
  apify_yc_jobs: {
    key: "apify_yc_jobs",
    // Selectable ONLY via the semantic catalog. See `dynamic_source_only`.
    dynamic_source_only: true,
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_YC_JOBS", "parsebird/yc-jobs-scraper"),
    source_type: "jobs",
    label: "Y Combinator Jobs Scraper",
    // Default OFF: `required_env` is re-read at call time by
    // isActorRuntimeEnabled, so enablement stays dynamic and testable.
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: ["high-precision startup hiring discovery", "early-stage SaaS", "founder-led startup teams"],
    not_for: ["local businesses", "enterprise discovery", "non-startup verticals"],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 100,
    max_safe_results: 200,
    compliance_level: "public_jobs",
    required_env: "APIFY_ENABLE_YC_JOBS",
    missing_message: "YC job discovery is not enabled for this workspace.",
  },
  apify_ats_verification: {
    key: "apify_ats_verification",
    // Selectable ONLY via the semantic catalog. See `dynamic_source_only`.
    dynamic_source_only: true,
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_ATS_VERIFICATION", "bovi/greenhouse-lever-ashby-job-scraper"),
    source_type: "jobs",
    label: "Greenhouse / Lever / Ashby ATS Verification",
    // Default OFF: `required_env` is re-read at call time by
    // isActorRuntimeEnabled, so enablement stays dynamic and testable.
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: ["verifying an opening is still live", "canonical requisition evidence", "de-duplicating stale aggregator signals"],
    not_for: ["discovery without a known company", "individual people profiles"],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 50,
    max_safe_results: 200,
    compliance_level: "public_jobs",
    required_env: "APIFY_ENABLE_ATS_VERIFICATION",
    missing_message: "ATS job verification is not enabled for this workspace.",
  },
  apify_jobs: {
    key: "apify_jobs",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_JOBS", "curious_coder/linkedin-jobs-scraper"),
    source_type: "jobs",
    label: "LinkedIn Jobs Scraper",
    enabled: true,
    best_for: [
      "finding companies hiring specific roles",
      "public job openings by role and location",
      "hiring intent signals",
      "companies hiring engineers, marketers, GTM, sales, SDR, BDR, content, SEO roles",
    ],
    not_for: [
      "individual people profiles",
      "candidate profile search",
      "phone numbers",
      "personal contact details",
    ],
    example_user_requests: [
      "Find companies hiring marketing roles in London",
      "Find SaaS companies hiring GTM roles in the US",
      "Find companies hiring engineers in London",
    ],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 5,
    max_safe_results: 100,
    compliance_level: "public_jobs",
    required_env: "APIFY_API_TOKEN",
  },

  apify_advanced_linkedin_jobs: {
    key: "apify_advanced_linkedin_jobs",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_ADVANCED_LINKEDIN_JOBS", "curious_coder/linkedin-jobs-search-scraper"),
    source_type: "advanced_jobs",
    label: "Advanced LinkedIn Jobs Scraper",
    enabled: envFlag("APIFY_ENABLE_ADVANCED_LINKEDIN_JOBS"),
    best_for: [
      "advanced LinkedIn jobs search",
      "boolean job search",
      "richer LinkedIn job filters",
    ],
    not_for: ["individual people profiles", "private contact data"],
    output_type: "advanced_job_posts_and_company_data",
    default_max_results: 5,
    max_safe_results: 100,
    compliance_level: "public_or_authorized_jobs",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Advanced LinkedIn Jobs actor is not configured. I can use the standard LinkedIn Jobs actor instead.",
  },

  apify_indeed_jobs: {
    key: "apify_indeed_jobs",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_INDEED_JOBS", "curious_coder/indeed-scraper"),
    source_type: "indeed_jobs",
    label: "Indeed Jobs Scraper",
    enabled: envFlag("APIFY_ENABLE_INDEED_JOBS"),
    best_for: [
      "Indeed job listings",
      "non-LinkedIn hiring signals",
      "backup job source",
      "company hiring data from Indeed",
    ],
    not_for: ["individual people profiles", "private contact data"],
    output_type: "job_posts_and_hiring_companies",
    default_max_results: 5,
    max_safe_results: 100,
    compliance_level: "public_jobs",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Indeed Jobs actor is not configured. I can use LinkedIn Jobs instead.",
  },

  apify_website_content: {
    key: "apify_website_content",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_WEBSITE_CONTENT", "apify/website-content-crawler"),
    source_type: "website_content",
    label: "Website Content Crawler",
    enabled: envFlag("APIFY_ENABLE_WEBSITE_CONTENT"),
    best_for: [
      "multi-page website crawling",
      "clean text or Markdown extraction",
      "RAG-ready content",
      "fallback if Firecrawl fails",
      "docs, blogs, help centers, resource pages",
    ],
    not_for: ["job search", "people search"],
    output_type: "website_markdown_content",
    default_max_pages: 5,
    max_safe_pages: 20,
    compliance_level: "public_web",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Apify Website Content Crawler is not enabled. Try Firecrawl for single-page extraction, or enable APIFY_ENABLE_WEBSITE_CONTENT for multi-page crawls.",
  },

  apify_custom_web: {
    key: "apify_custom_web",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_CUSTOM_WEB", "apify/web-scraper"),
    source_type: "custom_web",
    label: "Generic Web Scraper",
    enabled: envFlag("APIFY_ENABLE_CUSTOM_WEB"),
    best_for: [
      "custom directories",
      "niche job boards",
      "public websites with special structure",
      "custom extraction workflows",
    ],
    not_for: ["broad search by default", "private data", "people scraping without consent"],
    output_type: "custom_structured_results",
    default_max_pages: 10,
    max_safe_pages: 20,
    compliance_level: "public_web_custom",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Apify generic web scraper is not enabled. Enable APIFY_ENABLE_CUSTOM_WEB to use it for niche sites.",
  },

  apify_people_search: {
    key: "apify_people_search",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_PEOPLE_SEARCH", "harvestapi/linkedin-profile-search"),
    source_type: "people_profiles",
    label: "LinkedIn Profile Search",
    enabled: envFlag("APIFY_ENABLE_PEOPLE_SEARCH"),
    requires_explicit_opt_in: true,
    best_for: [
      "finding individual candidate profiles",
      "finding engineers by title/location",
      "finding founder profiles",
      "people search",
      "finding individual LinkedIn profiles",
    ],
    not_for: ["companies hiring", "job opening discovery"],
    output_type: "people_profiles",
    default_max_results: 10,
    max_safe_results: 25,
    compliance_level: "restricted_people_data",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Individual people/profile sourcing is not configured yet. I can find companies hiring those roles using the jobs actor.",
  },

  // Structured company FIRMOGRAPHICS for an already-known company (Phase 2).
  // Enriches company evidence (website/industry/size/HQ/description) for companies
  // already attached to person candidates — it is NOT a discovery/search actor.
  // Verified schema (harvestapi/linkedin-company): input { companies: string[] (
  // LinkedIn company URLs), searches: string[] (company names) }.
  apify_linkedin_company_details: {
    key: "apify_linkedin_company_details",
    tool_name: "source_with_apify",
    provider: "apify",
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_COMPANY_DETAILS", "harvestapi/linkedin-company"),
    source_type: "company_details",
    label: "LinkedIn Company Details Scraper",
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: [
      "enriching a KNOWN company with website/industry/size/HQ evidence",
      "filling company firmographic gaps for person candidates",
    ],
    not_for: [
      "company discovery or filtered company search (use a company search actor)",
      "people search",
      "job search",
    ],
    output_type: "company_details",
    default_max_results: 8,
    max_safe_results: 25,
    compliance_level: "public_company_data",
    required_env: "APIFY_API_TOKEN",
  },
  apify_linkedin_company_employees: {
    key: "apify_linkedin_company_employees",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_COMPANY_EMPLOYEES", "harvestapi/linkedin-company-employees"),
    source_type: "people_profiles",
    label: "LinkedIn Company Employees Scraper",
    enabled: true,
    requires_explicit_opt_in: true,
    best_for: [
      "finding decision-makers at specific companies using company URLs",
      "company-scoped contact discovery",
      "employee search by company page",
    ],
    not_for: ["broad generic search when company URL is missing", "job search"],
    output_type: "people_profiles",
    default_max_results: 10,
    max_safe_results: 25,
    compliance_level: "restricted_people_data",
    required_env: "APIFY_API_TOKEN",
  },

  apify_profile_enrichment: {
    key: "apify_profile_enrichment",
    tool_name: "source_with_apify",
    actor_id: actorId("APIFY_ACTOR_PROFILE_ENRICHMENT", "atomus/linkedin-profile-scraper"),
    source_type: "profile_enrichment",
    label: "LinkedIn Profile Enrichment",
    enabled: envFlag("APIFY_ENABLE_PROFILE_ENRICHMENT"),
    requires_explicit_opt_in: true,
    best_for: [
      "enriching known LinkedIn profile URLs",
      "extracting structured data from provided profile URLs",
      "candidate/founder profile enrichment after URLs are already known",
    ],
    not_for: ["searching for people from scratch", "phone number scraping", "private data"],
    output_type: "profile_enrichment_records",
    default_max_results: 10,
    max_safe_results: 50,
    compliance_level: "restricted_profile_enrichment",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "LinkedIn profile enrichment actor is not configured. Enable APIFY_ENABLE_PROFILE_ENRICHMENT to use it on known profile URLs.",
  },

  apify_linkedin_posts: {
    key: "apify_linkedin_posts",
    tool_name: "source_with_apify",
    provider: "apify",
    // Default to the HarvestAPI LinkedIn post search actor; override via env.
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_POSTS", "harvestapi/linkedin-post-search"),
    source_type: "linkedin_engagement",
    label: "LinkedIn Posts / Engagement Search",
    enabled: envFlag("APIFY_ENABLE_LINKEDIN_POSTS"),
    requires_explicit_opt_in: true,
    best_for: [
      "finding LinkedIn posts by keyword/topic",
      "finding authors/commenters engaging with GTM-related topics",
      "finding people discussing pain points (outbound, manual GTM, AI SDRs)",
      "discovering warm engagement opportunities to comment on or DM",
      "ICP conversations and topic discussions on LinkedIn",
    ],
    not_for: [
      "companies hiring (use the jobs actor)",
      "individual profile enrichment (use profile enrichment)",
      "phone numbers or private personal contact data",
    ],
    example_user_requests: [
      "Find LinkedIn posts where founders are talking about outbound problems",
      "Find people discussing AI SDRs or AI agents on LinkedIn",
      "Find posts I should comment on about AI SDRs",
      "Find LinkedIn conversations around Clay or AI sales automation",
    ],
    output_type: "linkedin_posts",
    default_max_results: 10,
    max_safe_results: 20,
    compliance_level: "public_social_engagement",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "LinkedIn engagement sourcing is not configured yet. I can still source hiring signals with Apify Jobs or analyze specific URLs with Firecrawl.",
  },

  apify_linkedin_profile_posts: {
    key: "apify_linkedin_profile_posts",
    tool_name: "source_with_apify",
    provider: "apify",
    // Fetch recent posts from specific LinkedIn profile/company page URLs.
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_PROFILE_POSTS", "harvestapi/linkedin-profile-posts"),
    source_type: "linkedin_engagement",
    label: "LinkedIn Profile / Company Posts",
    enabled: envFlag("APIFY_ENABLE_LINKEDIN_PROFILE_POSTS"),
    requires_explicit_opt_in: true,
    best_for: [
      "monitoring specific LinkedIn profiles",
      "monitoring specific company pages",
      "finding posts from known founders/competitors",
      "collecting recent posts from supplied LinkedIn URLs",
    ],
    not_for: [
      "broad keyword/topic post search (use apify_linkedin_posts)",
      "companies hiring (use the jobs actor)",
      "phone numbers or private personal contact data",
    ],
    example_user_requests: [
      "Check recent posts from this LinkedIn profile: https://linkedin.com/in/...",
      "Monitor posts from this company page",
      "Get recent posts from these founders",
    ],
    output_type: "linkedin_profile_posts",
    default_max_results: 10,
    max_safe_results: 20,
    compliance_level: "public_social_engagement",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "LinkedIn profile/company post monitoring is not configured yet. Enable APIFY_ENABLE_LINKEDIN_PROFILE_POSTS, or I can analyze a specific URL with Firecrawl.",
  },

  // Phase 4.2 — optional company-page-only monitor.
  apify_linkedin_company_posts: {
    key: "apify_linkedin_company_posts",
    tool_name: "source_with_apify",
    provider: "apify",
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_COMPANY_POSTS", "harvestapi/linkedin-company-posts"),
    source_type: "linkedin_engagement",
    label: "LinkedIn Company Posts",
    enabled: envFlag("APIFY_ENABLE_LINKEDIN_COMPANY_POSTS"),
    requires_explicit_opt_in: true,
    best_for: ["company-page-only post monitoring", "competitor company pages"],
    not_for: ["individual profiles (use profile posts)", "broad keyword search (use posts search)"],
    output_type: "linkedin_company_posts",
    default_max_results: 10,
    max_safe_results: 20,
    compliance_level: "public_social_engagement",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "LinkedIn company-page monitoring isn't configured. Enable APIFY_ENABLE_LINKEDIN_COMPANY_POSTS, or I can use the profile-posts actor for company pages.",
  },

  // Phase 4.2 — deep commenter/engagement extraction for HOT posts only (opt-in,
  // explicit). Never used by default for every search result.
  apify_linkedin_post_comments: {
    key: "apify_linkedin_post_comments",
    tool_name: "source_with_apify",
    provider: "apify",
    actor_id: actorId("APIFY_ACTOR_LINKEDIN_POST_COMMENTS", "api-empire/post-comments-engagements-scraper-linkedin"),
    source_type: "linkedin_comments",
    label: "LinkedIn Post Comments / Engagements",
    enabled: envFlag("APIFY_ENABLE_LINKEDIN_POST_COMMENTS"),
    requires_explicit_opt_in: true,
    best_for: [
      "extracting commenters/repliers on a specific post",
      "people commenting on a competitor post",
      "deep engagement extraction for hot posts (explicit, capped)",
    ],
    not_for: ["default per-result extraction", "reactions by default", "private data"],
    output_type: "linkedin_post_commenters",
    default_max_results: 20,
    max_safe_results: 50,
    compliance_level: "public_social_engagement",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Comment/engagement extraction isn't configured. Enable APIFY_ENABLE_LINKEDIN_POST_COMMENTS to pull commenters from a specific post.",
  },

  // Phase 4.2 — optional Google SERP competitor discovery/validation (disabled by default).
  apify_google_search: {
    key: "apify_google_search",
    tool_name: "source_with_apify",
    provider: "apify",
    actor_id: actorId("APIFY_ACTOR_GOOGLE_SEARCH", "scrapemesh/google-search-results-scraper"),
    source_type: "serp",
    label: "Google Search (SERP)",
    enabled: envFlag("APIFY_ENABLE_GOOGLE_SEARCH"),
    requires_explicit_opt_in: true,
    best_for: [
      "competitor discovery/validation (\"alternatives to X\", \"competitors of X\", \"best AI SDR tools\")",
      "validating competitor hypotheses from a website/description",
    ],
    not_for: ["LinkedIn engagement (use the LinkedIn actors)", "broad grounded chat search (use search_web)"],
    output_type: "serp_results",
    default_max_results: 10,
    max_safe_results: 20,
    compliance_level: "public_web",
    required_env: "APIFY_API_TOKEN",
    missing_message:
      "Google SERP discovery isn't configured. Enable APIFY_ENABLE_GOOGLE_SEARCH to validate competitor hypotheses via search.",
  },

  firecrawl_scrape_url: {
    key: "firecrawl_scrape_url",
    tool_name: "scrape_url",
    provider: "firecrawl",
    actor_id: null,
    source_type: null,
    label: "Firecrawl",
    enabled: true,
    best_for: [
      "specific URL extraction",
      "company website analysis",
      "careers page extraction",
      "pricing/about/customer page analysis",
      "single-page or small-site enrichment",
    ],
    not_for: ["broad search", "people search"],
    output_type: "page_markdown_and_summary",
    compliance_level: "public_web",
    required_env: "FIRECRAWL_API_KEY",
  },

  search_web: {
    key: "search_web",
    tool_name: "search_web",
    provider: "parallel",
    actor_id: null,
    source_type: "search",
    label: "Parallel Search",
    enabled: true,
    best_for: [
      "broad current web search",
      "market updates",
      "competitor news",
      "discovery when no structured actor fits",
    ],
    not_for: ["claiming current facts without grounded search"],
    output_type: "search_results_with_citations",
    compliance_level: "public_search",
  },
};

// ---- Helpers -------------------------------------------------------------

export function getActorByKey(key: string | null | undefined): ActorEntry | null {
  if (!key) return null;
  return ACTOR_REGISTRY[key] ?? null;
}

export function isActorRuntimeEnabled(entry: ActorEntry): boolean {
  if (!entry.enabled) return false;
  if (entry.key === "search_web") return resolveWebSearch() === "parallel";
  if (entry.required_env && !envStr(entry.required_env)) return false;
  return true;
}

export function getEnabledActors(): ActorEntry[] {
  return Object.values(ACTOR_REGISTRY).filter(isActorRuntimeEnabled);
}

/**
 * The canonical Actor for a `source_type`.
 *
 * Variants marked `dynamic_source_only` are SKIPPED. They are reachable only
 * through the semantic hiring-source catalog, which resolves them by registry key.
 *
 * Without that skip this function is order-dependent in a dangerous way: it
 * returns the first declaration match, so registering the Automation Lab Indeed
 * variant above the legacy Curious Coder entry silently changes which vendor
 * `indeed_jobs` resolves to — and registering the LinkedIn/Glassdoor/YC/ATS
 * variants above `apify_jobs` does the same to the canonical `jobs` path that
 * company-first sourcing depends on. Coexistence has to survive declaration order,
 * not depend on it.
 */
export function resolveActorForSourceType(source_type: string | null | undefined): ActorEntry | null {
  if (!source_type) return null;
  for (const a of Object.values(ACTOR_REGISTRY)) {
    if (a.dynamic_source_only) continue;
    if (a.source_type === source_type) return a;
  }
  return null;
}

export function summarizeRegistryForPrompt(): string {
  return Object.values(ACTOR_REGISTRY).map((a) => {
    const status = isActorRuntimeEnabled(a) ? "ENABLED" : "DISABLED";
    const lines = [
      `- ${a.key} [${status}] tool=${a.tool_name}${a.actor_id ? ` actor=${a.actor_id}` : ""}${a.source_type ? ` source_type=${a.source_type}` : ""}`,
      `  label: ${a.label}`,
      `  best_for: ${a.best_for.join("; ")}`,
    ];
    if (a.not_for.length > 0) lines.push(`  not_for: ${a.not_for.join("; ")}`);
    if (a.example_user_requests?.length) lines.push(`  examples: ${a.example_user_requests.join(" | ")}`);
    if (!isActorRuntimeEnabled(a) && a.missing_message) lines.push(`  missing: ${a.missing_message}`);
    if (a.requires_explicit_opt_in) lines.push(`  requires_explicit_opt_in: true`);
    return lines.join("\n");
  }).join("\n\n");
}

// ---- Intent detection regexes -------------------------------------------

export const PEOPLE_INTENT_RE =
  /\b(individual|specific)\s+(people|candidates?|profiles?|persons?|engineers?|developers?|marketers?|founders?|designers?)\b|\b(profile|profiles|phone numbers?|emails?|linkedin profiles?|candidate profiles?)\b/i;

export const COMPANY_INTENT_RE =
  /\b(compan(?:y|ies)|hiring|hir(?:e|es|ed)|jobs?|roles?|openings?|careers?|recruit)/i;

export const AMBIGUOUS_ROLE_RE =
  /\b(find|source|get|show)\b.*\b(engineers?|developers?|marketers?|designers?|founders?|recruiters?|sales|sdrs?|bdrs?|people)\b/i;

export const INDEED_INTENT_RE = /\b(indeed|avoid linkedin|not linkedin|non[- ]?linkedin)\b/i;

export const ADVANCED_JOBS_INTENT_RE =
  /\b(advanced (?:linkedin )?(?:job )?search|boolean (?:job )?search|advanced filters?)\b/i;

export const ENRICHMENT_INTENT_RE =
  /\b(enrich(?:ment)?|extract (?:data|profile) from|scrape (?:this )?(?:profile|linkedin profile))\b/i;

export const MULTIPAGE_CRAWL_INTENT_RE =
  /\b(crawl (?:this |the )?(?:whole |entire )?(?:site|website)|multi[- ]?page (?:crawl|scrape)|crawl multiple pages|with apify)\b/i;

export const LINKEDIN_PROFILE_URL_RE =
  /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_\-%]+/i;

// Phase 3 — LinkedIn profile OR company page URL (for profile-posts monitoring).
export const LINKEDIN_ENTITY_URL_RE =
  /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company|school|showcase)\/[A-Za-z0-9_\-%.]+/ig;

// Phase 3 — LinkedIn engagement signal intent. Detects requests about LinkedIn
// posts/comments/conversations, people discussing a topic or pain, and
// "posts I should comment on / engage with". This is engagement sourcing, NOT
// hiring (jobs) or profile search (people). Deliberately requires a LinkedIn /
// post / comment / engagement cue so generic "find founders" stays on jobs.
export const LINKEDIN_ENGAGEMENT_RE =
  /\b(linkedin\s+(?:posts?|comments?|conversations?|threads?|engagement)|posts?\s+(?:about|on|discussing|where|i\s+should\s+comment|to\s+comment)|comment\s+on\b|engag(?:e|ing)\s+with\b|(?:people|founders?|operators?|prospects?|users?)\s+(?:talking|posting|discussing|engaging|commenting)|conversations?\s+(?:about|around|on)|discussions?\s+(?:about|around|on))\b/i;

// Phase 4.2 — extract commenters/engagers from a specific post.
export const COMMENTER_EXTRACT_RE =
  /\b(extract|find|get|pull|list|scrape)\b[^.]*\b(commenters?|people commenting|repliers?|who commented|engagers?|reactors?)\b|\bcomment(?:er)?s?\s+(?:on|from)\s+(?:this|the)\s+(?:post|linkedin)/i;

// "draft a comment" vs "draft a DM" sub-intent for LinkedIn engagement.
export const COMMENT_DRAFT_INTENT_RE =
  /\b(draft|write|suggest|generate)\b.*\bcomments?\b|\bcomments?\s+(?:to|i\s+should)\b|\bposts?\s+i\s+should\s+comment\b/i;
export const DM_DRAFT_INTENT_RE =
  /\b(draft|write|send|soft)\b.*\b(dms?|direct messages?|messages?|follow[- ]?ups?)\b|\bdm\s+(?:them|these|the)\b/i;

export const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
