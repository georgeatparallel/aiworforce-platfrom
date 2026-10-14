// Shared backend tool registry for the AI workforce.
// All external tool calls go through `runTool` so that:
//   - tool_calls rows are written (queued → running → succeeded|failed|unavailable)
//   - activity_feed gets a "tool_used" or "tool_failed" entry
//   - allowed_agents is enforced server-side
//   - missing API keys produce a graceful "unavailable" instead of a crash
//
// Edge functions import this with a relative path:
//   import { runTool } from "../_shared/toolRegistry.ts";

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hashInput } from "./hiringActorInputs.ts";
import { paidCallInputHash } from "./paidCallInputHash.ts";
import {
  PERSISTENCE_AUTHORITIES, type PersistenceAuthority,
} from "./capabilityExecution.ts";
import { validateFinalActorPayload, finalPayloadDiagnostics } from "./finalActorPayload.ts";
import { ACTOR_REGISTRY, getActorByKey, isActorRuntimeEnabled } from "./actorRegistry.ts";
import { COMPANY_DETAILS_ACTOR_KEY, COMPANY_DETAILS_ACTOR_ID, extractProviderCompanyLinkedInUrl } from "./structuredCompanyEnrichment.ts";
import {
  assertResponseKindConsistent, buildCountLedger,
} from "./providerResponseContract.ts";
import { buildHarvestApiPeopleInput, buildHarvestApiCompanyEmployeesInput } from "./harvestApiPeople.ts";
import { buildCuriousCoderLinkedInJobsInput } from "./curiousCoderJobsInput.ts";
// ONE OBSERVABILITY LAYER for every paid lead-sourcing call. Observes only —
// it never selects a provider, sets a budget, decides a retry or gates a result.
import {
  withExecutionAudit, createLedgerWriter, inferStage, logicalCallKey, type LedgerProgress,
  type ExecutionCallSpec, type ExecutionOutcome, type ExecutionStage,
  type ExecutionReason, type LedgerDb,
} from "./executionLedger.ts";
import { writeMemoryFromToolCall } from "./memoryWriter.ts";
import { buildLinkedinEngagementInput, buildLinkedinProfilePostsInput } from "./linkedinEngagementInput.ts";
import { normalizeLinkedinEngagementItem } from "./linkedinEngagementOutput.ts";
import { normalizeApifyJobRow } from "./apifyJobsNormalizer.ts";

/**
 * How deep a paid jobs dataset is read.
 *
 * Bounds memory, never evidence: the dataset is already bought, so stopping
 * short of it discards rows this run paid for. Every hiring dataset this system
 * has produced fits well inside it, and one that does not is reported by the
 * response's count ledger rather than silently shortened.
 */
export const JOBS_POOL_READ_CEILING = 200;

export interface ToolContext {
  admin: SupabaseClient;
  /**
   * Called the moment a provider run exists, before anything waits on it.
   *
   * The run id is created by the start POST and used to live only in memory
   * until the call returned or the poll gave up. A function killed inside that
   * window — which is what the Edge wall clock does — left a billed, running
   * Apify job that nothing durable named, so the resume machinery could not
   * adopt it (run 78cff5e5).
   */
  onRunStarted?: (info: { run_id: string; dataset_id: string | null }) => Promise<void> | void;
  /**
   * Stop WAITING on a started Apify run — never stop the run. Asked between
   * polls; when true the call returns exactly what the poll window's end
   * returns: the run is RUNNING, `pending`, its id already recorded by
   * `onRunStarted`, adopted later with a free status read. Set only by the
   * Lead V2 verification phase once its slice must stop (deadline, lost lease,
   * cancellation). Absent: the full poll window, as before.
   */
  stopWaiting?: () => boolean;
  workspace_id: string;
  agent_slug: string;
  agent_id: string | null;
  agent_name?: string;
  plan_id?: string | null;
  task_id?: string | null;
  /**
   * The lineage this call belongs to — the root task of the continuation chain.
   *
   * THE IDEMPOTENCY SCOPE FOR MONEY. `logical_call_key` is built from this, so
   * the same question asked by a later generation replays the reservation
   * instead of making a second one. Absent, the key falls back to `task_id`,
   * which is correct for a caller with no chain: such a task is its own lineage.
   */
  lineage_root?: string | null;
  user_id?: string | null;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  unavailable?: boolean;
  awaiting_approval?: boolean;
}

interface ToolDef {
  name: string;
  provider: string;
  description: string;
  allowed_agents: string[];
  requires_approval: boolean;
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

// ---------- RETIRED: research_web (Perplexity) ----------
//
// The executor is GONE, not disabled. It called `api.perplexity.ai` directly —
// outside `aiProvider` and `gptProvider`, so outside the only two seams that
// reach `ModelCallCollector`. It was live (13 calls, last 2026-08-31),
// uncaptured by the model ledger, absent from `PAID_TOOLS` and therefore
// unmetered by credits too: the one production path that could spend without
// appearing in any of the three accounting systems.
//
// Deleting the function rather than gating it is the point. A flag can be set;
// an absent `fetch` cannot be. `RETIRED_TOOLS` below keeps the NAME known so
// callers get a truthful "retired" rather than the `{ready: true}` that
// `isToolConfigured` returns for any name it has never heard of — which would
// have told every caller that research was available.
//
// Reintroducing it means routing it through the shared model accounting and
// budget layers, not restoring this function.

// ---------- Tool: scrape_url (Firecrawl v2) ----------

const FIRECRAWL_V2 = "https://api.firecrawl.dev/v2";

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function truncate(s: unknown, max = 6000): string {
  const str = typeof s === "string" ? s : "";
  return str.length > max ? str.slice(0, max) + "\n…[truncated]" : str;
}

async function firecrawlFetch(
  apiKey: string,
  path: string,
  body: unknown,
  timeoutMs = 25_000,
): Promise<{ ok: boolean; status: number; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FIRECRAWL_V2}${path}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function firecrawlGet(
  apiKey: string,
  path: string,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FIRECRAWL_V2}${path}`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function execScrapeUrl(input: unknown): Promise<ToolResult> {
  const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
  if (!FIRECRAWL_API_KEY) {
    return { ok: false, unavailable: true, error: "FIRECRAWL_API_KEY not configured" };
  }

  const i = (input ?? {}) as { url?: string; extraction_goal?: string; max_pages?: number; mode?: string };
  const url = (i.url ?? "").toString().trim();
  const extraction_goal = (i.extraction_goal ?? "").toString();
  const max_pages = Math.min(5, Math.max(1, Number(i.max_pages) || 1));

  if (!url) return { ok: false, error: "missing 'url'" };
  if (!isValidHttpUrl(url)) return { ok: false, error: "invalid_url" };

  // ── MAP: WHICH PAGES DOES THIS SITE ACTUALLY HAVE? ────────────────────────
  //
  // Firecrawl `/map` lists a site's URLs without fetching their content, so one
  // cheap call replaces a handful of guessed paths. The claim verifier asks for
  // this before it buys anything; without it, live run 3bc526e2 spent 7 of its
  // 12 page purchases on 404s and left one company with no evidence at all.
  //
  // It travels through `scrape_url` deliberately: the credit reservation, the
  // ledger row, the idempotency key and the readiness checks are all keyed to
  // this tool, and a second paid tool would need every one of them rebuilt.
  if ((i.mode ?? "").toString().toLowerCase() === "map") {
    const limit = Math.min(500, Math.max(1, Number(i.max_pages) || 120));
    try {
      const r = await firecrawlFetch(FIRECRAWL_API_KEY, "/map", { url, limit });
      if (!r.ok) return { ok: false, error: `firecrawl_map_${r.status}` };
      const body = (r.data ?? {}) as Record<string, unknown>;
      const raw = (Array.isArray(body.links) ? body.links : Array.isArray(body.data) ? body.data : []) as unknown[];
      const links = raw
        .map((x) => typeof x === "string" ? x : String((x as Record<string, unknown>)?.url ?? ""))
        .filter((u) => !!u && isValidHttpUrl(u))
        .slice(0, limit);
      return { ok: true, data: { mode: "map", url, links, count: links.length } };
    } catch (e) {
      return { ok: false, error: `firecrawl_map_failed: ${String(e).slice(0, 120)}` };
    }
  }

  // Single-page scrape
  if (max_pages === 1) {
    let last: { ok: boolean; status: number; data: any } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        last = await firecrawlFetch(FIRECRAWL_API_KEY, "/scrape", {
          url,
          formats: ["markdown", "summary"],
          onlyMainContent: true,
        });
        if (last.ok) break;
        if (last.status >= 500 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        break;
      } catch (e) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        return { ok: false, error: `Firecrawl fetch failed: ${String(e)}` };
      }
    }
    if (!last) return { ok: false, error: "Firecrawl no response" };
    if (last.status === 402) {
      return { ok: false, unavailable: true, error: "firecrawl_insufficient_credits" };
    }
    if (last.status === 401 || last.status === 403) {
      return { ok: false, unavailable: true, error: "firecrawl_unauthorized" };
    }
    if (!last.ok) {
      return { ok: false, error: `Firecrawl ${last.status}: ${JSON.stringify(last.data?.error ?? last.data).slice(0, 300)}` };
    }
    // v2 returns { success, data: { markdown, summary, metadata } }
    const doc = last.data?.data ?? last.data ?? {};
    const metadata = doc.metadata ?? {};
    return {
      ok: true,
      data: {
        url,
        source_url: metadata.sourceURL ?? url,
        title: metadata.title ?? null,
        markdown: truncate(doc.markdown, 12_000),
        summary: doc.summary ?? null,
        metadata,
        extraction_goal,
        // ── WHAT THIS COST, STATED BY THE CALL THAT MADE IT ────────────────
        //
        // `/scrape` reports no credits and no charge — its response carries
        // only `success`, `data` and `warning` — so the count comes from the
        // published per-page rule instead. The request above asks for markdown
        // + summary, neither of which is surcharged, so this is the plain
        // 1-credit case.
        //
        // `producedResult` is true because a document came back. A page that
        // answered 404 and still returned content IS charged, which is why
        // this keys on the document rather than on the page's health.
        firecrawl_cost: {
          credits: firecrawlCredits({
            pages: 1, formats: ["markdown", "summary"], producedResult: true,
          }),
          basis: "published_rate" as const,
        },
      },
    };
  }

  // Multi-page crawl
  const startRes = await firecrawlFetch(FIRECRAWL_API_KEY, "/crawl", {
    url,
    limit: max_pages,
    scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
  }).catch((e) => ({ ok: false, status: 0, data: { error: String(e) } }));

  if (startRes.status === 402) return { ok: false, unavailable: true, error: "firecrawl_insufficient_credits" };
  if (startRes.status === 401 || startRes.status === 403) return { ok: false, unavailable: true, error: "firecrawl_unauthorized" };
  if (!startRes.ok) return { ok: false, error: `Firecrawl crawl ${startRes.status}` };

  const jobId = startRes.data?.id ?? startRes.data?.data?.id;
  if (!jobId) {
    // Some responses return data inline.
    const docs = startRes.data?.data ?? [];
    return {
      ok: true,
      data: {
        url,
        source_url: url,
        extraction_goal,
        pages: (Array.isArray(docs) ? docs : []).map((d: any) => ({
          url: d?.metadata?.sourceURL ?? null,
          markdown: truncate(d?.markdown, 6000),
          metadata: d?.metadata ?? {},
        })),
        // Inline results carry no `creditsUsed`, so the published rule answers.
        firecrawl_cost: {
          credits: firecrawlCredits({
            pages: (Array.isArray(docs) ? docs : []).length,
            formats: ["markdown"],
            producedResult: (Array.isArray(docs) ? docs : []).length > 0,
          }),
          basis: "published_rate" as const,
        },
      },
    };
  }

  // Poll up to ~25s
  const deadline = Date.now() + 25_000;
  let status: any = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await firecrawlGet(FIRECRAWL_API_KEY, `/crawl/${jobId}`).catch(() => null);
    if (!s) continue;
    status = s.data;
    if (status?.status === "completed" || status?.status === "failed") break;
  }

  const docs = Array.isArray(status?.data) ? status.data : [];
  // ── FIRECRAWL'S OWN COUNT, WHEN IT GIVES ONE ───────────────────────────────
  //
  // `/crawl/{id}` returns `creditsUsed`, unlike `/scrape`. It is still a CREDIT
  // count and not a charge, so it cannot reach `provider_reported` — but it
  // beats deriving the number from a page count, especially when a crawl ends
  // `partial` and the pages returned are not the pages billed.
  const reportedCredits = Number(status?.creditsUsed);
  const crawlCost = Number.isFinite(reportedCredits) && reportedCredits >= 0
    ? { credits: Math.floor(reportedCredits), basis: "provider_reported_credits" as const }
    : {
      credits: firecrawlCredits({
        pages: docs.length, formats: ["markdown"], producedResult: docs.length > 0,
      }),
      basis: "published_rate" as const,
    };
  return {
    ok: true,
    data: {
      url,
      source_url: url,
      extraction_goal,
      firecrawl_cost: crawlCost,
      partial: status?.status !== "completed",
      pages: docs.slice(0, max_pages).map((d: any) => ({
        url: d?.metadata?.sourceURL ?? null,
        markdown: truncate(d?.markdown, 6000),
        metadata: d?.metadata ?? {},
      })),
      truncated: docs.length > max_pages,
    },
  };
}

// ---------- Tool: source_with_apify (Apify) ----------

import { apifyEventPrices, billableResultCount,
  priceProviderCall, type ProviderRunUsage,
} from "./providerCostModel.ts";
import {
  firecrawlCredits, priceFirecrawlCall, type FirecrawlCreditBasis,
} from "./firecrawlCostModel.ts";
import type { ExecutionCost } from "./executionLedger.ts";
import {
  authorizeProviderCall, settleProviderCall, resolveCreditEnforcement,
  CREDIT_REFUSED_ERROR, type CreditDb,
} from "./creditAuthorization.ts";
import { priceFor } from "./creditPricing.ts";

const APIFY_BASE = "https://api.apify.com/v2";

// Actor catalog. Fill `actor_id` once the user provides the Apify actor for that source_type.
// `null` => unavailable for that source_type until configured.
type ApifyActorCfg = {
  actor_id: string | null;
  description: string;
  source_type?: string;
  enabled_by_default?: boolean;
  use_for?: string[];
  input_adapter?: (i: {
    query?: string | null;
    location?: string | null;
    role_keywords?: string[] | null;
    max_results: number;
    user_input?: Record<string, unknown>;
  }) => Record<string, unknown>;
};

// URL construction + native payload live in the dedicated actor adapter so the
// jobs actor and the Harvest actor can never share a serializer.

// Apify actor registry. Apify is reserved for structured sourcing actors
// (jobs/hiring/company data). Broad web search stays on `search_web`
// (Gemini/Lovable grounded search) — `apify/google-search-scraper` is an
// opt-in fallback only and is disabled by default.
const APIFY_ACTORS: Record<string, ApifyActorCfg> = {
  jobs: {
    actor_id: "curious_coder/linkedin-jobs-scraper",
    source_type: "jobs",
    enabled_by_default: true,
    use_for: ["hiring signals", "companies hiring roles", "job openings"],
    description: "LinkedIn jobs search with company details",
    // Dedicated Curious-Coder adapter — maps generic Agentory input to the actor's
    // native { urls, count, scrapeCompany, … } schema. Never forwards raw Agentory
    // wrapper fields (query / max_results / defer_persistence) to the actor.
    input_adapter: ({ query, location, role_keywords, max_results, user_input }) => {
      const kwFromRoles = Array.isArray(role_keywords) && role_keywords.length > 0
        ? role_keywords.join(" ")
        : null;
      const keywords = (user_input?.keywords as string | undefined) ?? kwFromRoles ?? query ?? null;
      return buildCuriousCoderLinkedInJobsInput({
        urls: Array.isArray(user_input?.urls) ? (user_input!.urls as string[]) : null,
        keywords, location, maxResults: max_results,
        scrapeCompany: typeof user_input?.scrapeCompany === "boolean" ? user_input.scrapeCompany : undefined,
        useIncognitoMode: typeof user_input?.useIncognitoMode === "boolean" ? user_input.useIncognitoMode : undefined,
        splitByLocation: typeof user_input?.splitByLocation === "boolean" ? user_input.splitByLocation : undefined,
      }) as unknown as Record<string, unknown>;
    },
  },
  advanced_jobs: {
    actor_id: "curious_coder/linkedin-jobs-search-scraper",
    source_type: "advanced_jobs",
    enabled_by_default: false,
    use_for: ["advanced LinkedIn job search", "boolean job search"],
    description: "Advanced LinkedIn jobs scraper with richer filters",
  },
  indeed_jobs: {
    actor_id: "curious_coder/indeed-scraper",
    source_type: "indeed_jobs",
    enabled_by_default: false,
    use_for: ["Indeed jobs", "non-LinkedIn hiring signals", "backup jobs source"],
    description: "Indeed jobs scraper (backup hiring source)",
  },
  website_content: {
    actor_id: "apify/website-content-crawler",
    source_type: "website_content",
    enabled_by_default: false,
    use_for: ["website content fallback if Firecrawl fails"],
    description: "Website content crawler — fallback if Firecrawl fails",
  },
  custom_web: {
    actor_id: "apify/web-scraper",
    source_type: "custom_web",
    enabled_by_default: false,
    use_for: ["custom websites", "directories", "niche job boards"],
    description: "Generic web scraper for niche/custom sites",
  },
  people_profiles: {
    actor_id: "harvestapi/linkedin-profile-search",
    source_type: "people_profiles",
    enabled_by_default: false,
    use_for: ["individual people/candidate profile search (opt-in only)"],
    description: "LinkedIn profile search — restricted, opt-in only",
    // Dedicated HarvestAPI adapter — maps generic Agentory input to the
    // actor's official schema. Never forwards raw Agentory fields.
    input_adapter: ({ query, location, role_keywords, max_results, user_input }) =>
      buildHarvestApiPeopleInput({ query, location, role_keywords, max_results, user_input }),
  },
  apify_linkedin_company_employees: {
    actor_id: "harvestapi/linkedin-company-employees",
    source_type: "people_profiles",
    enabled_by_default: false,
    use_for: ["company-scoped LinkedIn employee search", "finding contacts at specific company LinkedIn URLs"],
    description: "LinkedIn company employees scraper — restricted, opt-in only",
    input_adapter: ({ query, location, role_keywords, max_results, user_input }) =>
      buildHarvestApiCompanyEmployeesInput({ query, location, role_keywords, max_results, user_input }),
  },
  profile_enrichment: {
    actor_id: "atomus/linkedin-profile-scraper",
    source_type: "profile_enrichment",
    enabled_by_default: false,
    use_for: ["enrich known LinkedIn profile URLs (opt-in only)"],
    description: "LinkedIn profile enrichment — restricted, opt-in only",
  },
  search_fallback: {
    actor_id: "apify/google-search-scraper",
    source_type: "search",
    enabled_by_default: false,
    use_for: ["optional fallback only if grounded search is unavailable and user explicitly enables it"],
    description: "Google SERP via Apify — opt-in fallback only",
  },
  // Phase 3 — LinkedIn engagement. actor_id is supplied by the registry from
  // APIFY_ACTOR_LINKEDIN_POSTS; this catalog entry exists so the registry path
  // picks up the dedicated input adapter. enabled_by_default: false → gated by
  // the registry's APIFY_ENABLE_LINKEDIN_POSTS flag (registryApproved).
  linkedin_engagement: {
    actor_id: "harvestapi/linkedin-post-search",
    source_type: "linkedin_engagement",
    enabled_by_default: false,
    use_for: ["LinkedIn posts/engagement by topic", "people discussing GTM pain", "warm comment/DM opportunities"],
    description: "LinkedIn posts / engagement search — opt-in only",
    input_adapter: ({ query, location, role_keywords, max_results, user_input }) =>
      buildLinkedinEngagementInput({
        query,
        keywords: Array.isArray(user_input?.keywords) ? (user_input!.keywords as string[]) : null,
        topics: Array.isArray(user_input?.topics) ? (user_input!.topics as string[]) : null,
        roles: Array.isArray(role_keywords) ? role_keywords : null,
        companies: Array.isArray(user_input?.companies) ? (user_input!.companies as string[]) : null,
        location,
        max_results,
        user_input,
      }),
  },
  // Phase 3 — profile/company post monitoring. Matched by actor_id when the
  // registry resolves apify_linkedin_profile_posts.
  linkedin_profile_posts: {
    actor_id: "harvestapi/linkedin-profile-posts",
    source_type: "linkedin_engagement",
    enabled_by_default: false,
    use_for: ["recent posts from specific LinkedIn profile/company URLs", "monitoring known founders/competitors"],
    description: "LinkedIn profile/company posts — opt-in only",
    input_adapter: ({ max_results, user_input }) => {
      const res = buildLinkedinProfilePostsInput({
        targetUrls: Array.isArray(user_input?.targetUrls) ? (user_input!.targetUrls as string[]) : null,
        profile_urls: Array.isArray(user_input?.profile_urls) ? (user_input!.profile_urls as string[]) : null,
        company_urls: Array.isArray(user_input?.company_urls) ? (user_input!.company_urls as string[]) : null,
        max_results,
        user_input,
      });
      // Caller (classifier/pilot) is responsible for the no-URL clarification
      // before invoking; if it slips through, send empty targetUrls so the
      // actor rejects cleanly rather than scraping something unintended.
      return res.ok && res.payload ? res.payload : { targetUrls: [] };
    },
  },
  // Phase 4.2 — company-page-only monitor (resolved via apify_linkedin_company_posts).
  linkedin_company_posts: {
    actor_id: "harvestapi/linkedin-company-posts",
    source_type: "linkedin_engagement",
    enabled_by_default: false,
    use_for: ["company-page-only monitoring", "competitor company pages"],
    description: "LinkedIn company posts — opt-in only",
    input_adapter: ({ max_results, user_input }) => {
      const res = buildLinkedinProfilePostsInput({
        targetUrls: Array.isArray(user_input?.targetUrls) ? (user_input!.targetUrls as string[]) : null,
        company_urls: Array.isArray(user_input?.company_urls) ? (user_input!.company_urls as string[]) : null,
        max_results, user_input,
      });
      return res.ok && res.payload ? res.payload : { targetUrls: [] };
    },
  },
  // Phase 4.2 — deep commenter/engagement extraction for a specific post (opt-in).
  linkedin_comments: {
    actor_id: "api-empire/post-comments-engagements-scraper-linkedin",
    source_type: "linkedin_comments",
    enabled_by_default: false,
    use_for: ["extract commenters/engagers from a specific post URL"],
    description: "LinkedIn post comments/engagements — opt-in only",
    input_adapter: ({ max_results, user_input }) => {
      const postUrls = Array.isArray(user_input?.postUrls) ? (user_input!.postUrls as string[])
        : Array.isArray(user_input?.targetUrls) ? (user_input!.targetUrls as string[]) : [];
      return {
        postUrls,
        maxComments: Math.max(1, Math.min(50, max_results)),
        includeReactions: false, // reactions off by default
      };
    },
  },
  // Phase 4.2 — optional Google SERP competitor discovery/validation (opt-in).
  serp: {
    actor_id: "scrapemesh/google-search-results-scraper",
    source_type: "serp",
    enabled_by_default: false,
    use_for: ["competitor discovery/validation via search (\"alternatives to X\")"],
    description: "Google SERP scraper — opt-in only",
    input_adapter: ({ query, max_results, user_input }) => {
      const queries = Array.isArray(user_input?.queries) ? (user_input!.queries as string[]) : (query ? [query] : []);
      return { queries, maxResults: Math.max(1, Math.min(20, max_results)) };
    },
  },
};

// Alias map: planner / agent vocabularies often differ from the actor registry keys.
// Anything that means "find companies hiring people" routes to the jobs actor today,
// since no people/profile actor is configured yet.
const SOURCE_TYPE_ALIASES: Record<string, string> = {
  jobs: "jobs",
  job: "jobs",
  hiring: "jobs",
  hiring_signals: "jobs",
  job_search: "jobs",
  linkedin_jobs: "jobs",
  companies_hiring: "jobs",
  source_companies: "jobs",
  source_candidates: "jobs",
  candidates: "jobs",
  candidate: "jobs",
  people: "jobs",
  person: "jobs",
  profiles: "jobs",
  profile: "jobs",
  engineers: "jobs",
  engineer: "jobs",
  developers: "jobs",
  developer: "jobs",
  marketers: "jobs",
  marketer: "jobs",
  roles: "jobs",
  role: "jobs",
  companies: "jobs",
  company: "jobs",
  founders: "jobs",
  founder: "jobs",
  generic: "jobs",
  indeed_jobs: "indeed_jobs",
  website_content: "website_content",
  custom_web: "custom_web",
  search: "search_fallback",
  search_fallback: "search_fallback",
  // Phase 3 — LinkedIn engagement (explicit; never falls back to jobs).
  linkedin_engagement: "linkedin_engagement",
  linkedin_posts: "linkedin_engagement",
  linkedin_post: "linkedin_engagement",
  // Phase 4.2 — explicit; never falls back to jobs.
  linkedin_comments: "linkedin_comments",
  linkedin_commenters: "linkedin_comments",
  serp: "serp",
  google_search: "serp",
};

export function normalizeApifySourceType(raw?: string | null): string {
  const k = (raw ?? "").toString().trim().toLowerCase();
  if (!k) return "jobs";
  if (SOURCE_TYPE_ALIASES[k]) return SOURCE_TYPE_ALIASES[k];
  if (APIFY_ACTORS[k]) return k;
  return "jobs";
}

// Actors that must NEVER run without explicit opt-in, regardless of how
// the orchestrator/planner resolved them.
const OPT_IN_ONLY_ACTOR_IDS = new Set<string>([
  "apify/google-search-scraper",
  "harvestapi/linkedin-profile-search",
  "harvestapi/linkedin-company-employees",
  "atomus/linkedin-profile-scraper",
]);


const APIFY_ACTOR_ID_RE = /^[a-zA-Z0-9_~][a-zA-Z0-9_\-~]{0,127}(?:\/[a-zA-Z0-9_\-~]+)?$/;

function signalFromSourceType(source_type: string): string {
  switch (source_type) {
    case "jobs":                return "hiring";
    case "linkedin_engagement": return "linkedin_engagement";
    case "linkedin_comments":   return "linkedin_engagement";
    case "serp":                return "search";
    case "linkedin_posts":      return "post";
    case "companies":           return "company";
    case "comments":            return "comment";
    case "websites":            return "website";
    default:                    return "generic";
  }
}

function pickStr(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function truncObj(v: unknown, max = 4000): unknown {
  try {
    const s = JSON.stringify(v);
    if (s.length <= max) return v;
    return { _truncated: true, preview: s.slice(0, max) };
  } catch {
    return { _unserializable: true };
  }
}

export function normalizeApifyItem(raw: any, source_type: string) {
  const r = raw && typeof raw === "object" ? raw : {};
  // Jobs sources: promote the LinkedIn-Jobs scraper's rich company/job fields to
  // clean top-level names so downstream (memoryWriter / Workbench / CSV / Aria)
  // stop losing companyWebsite / companyLinkedinUrl / poster / industries, etc.
  const isJobs = /jobs/i.test(source_type);
  const nj = isJobs ? normalizeApifyJobRow(r) : null;
  return {
    name:        pickStr(r, ["name", "fullName", "authorName", "personName"]),
    company:     nj?.company ?? pickStr(r, ["companyName", "company", "employer", "organization", "org"]),
    title:       nj?.jobTitle ?? pickStr(r, ["title", "jobTitle", "position", "headline", "postTitle"]),
    url:         nj?.jobUrl ?? pickStr(r, ["url", "link", "jobUrl", "postUrl", "profileUrl", "sourceUrl"]),
    location:    nj?.location ?? pickStr(r, ["location", "city", "jobLocation", "geo", "place"]),
    description: nj?.jobDescription ?? pickStr(r, ["description", "snippet", "text", "summary", "body"]),
    source:      "apify",
    signal_type: signalFromSourceType(source_type),
    confidence:  null,
    // Preserved, clearly-named source fields (Phase 1). Only for jobs.
    ...(nj ? {
      website: nj.website,
      domain: nj.domain,
      company_website: nj.website,
      company_linkedin_url: nj.linkedinUrl,
      company_logo: nj.companyLogo,
      company_slogan: nj.companySlogan,
      company_address: nj.companyAddress,
      job_url: nj.jobUrl,
      apply_url: nj.applyUrl,
      job_title: nj.jobTitle,
      job_description: nj.jobDescription,
      company_description: nj.companyDescription,
      industries: nj.industries,
      employee_count: nj.employeeCount,
      employment_type: nj.employmentType,
      seniority_level: nj.seniorityLevel,
      job_function: nj.jobFunction,
      salary: nj.salary,
      posted_at: nj.postedAt,
      applicants_count: nj.applicantsCount,
      poster_contact_hint: nj.posterContactHint,
      provider_job_id: nj.providerJobId,
      provider_ref_id: nj.providerRefId,
      provider_tracking_id: nj.providerTrackingId,
      input_url: nj.inputUrl,
      exact_hiring_signal: nj.exactHiringSignal,
      signal_summary: nj.signalSummary,
      source_proof: nj.sourceProof,
      source_quality: nj.sourceQuality,
    } : {}),
    raw:         nj ? { ...nj.raw, provider_payload: truncObj(r, 4000) } : truncObj(r, 4000),
  };
}

// Phase 4.2 — normalize a LinkedIn post commenter/engager item. Never invents
// email/phone.
function normalizeLinkedinCommenterItem(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  const author = (r.author && typeof r.author === "object") ? r.author : r;
  return {
    type: "linkedin_commenter",
    commenter_name: pickStr(author, ["name", "fullName", "full_name", "authorName", "commenterName"]),
    commenter_profile_url: pickStr(author, ["profileUrl", "profile_url", "linkedinUrl", "url", "authorUrl"]),
    commenter_headline: pickStr(author, ["headline", "occupation", "subtitle", "title"]),
    comment_text: pickStr(r, ["commentText", "text", "comment", "body", "content"]),
    post_url: pickStr(r, ["postUrl", "post_url", "sourceUrl", "permalink", "url"]),
    source: "apify_linkedin_post_comments",
    raw: truncObj(r, 4000),
  };
}

function normalizeApifyPeopleItem(raw: any) {
  const r = raw && typeof raw === "object" ? raw : {};
  // HarvestAPI profile-search nests the useful fields: name = firstName+lastName
  // (no combined field), title/company in currentPosition[0], location is an
  // object. Flat pickStr alone returned nulls → real founders rejected. Extract
  // the nested shapes too, and emit a top-level `name` for generic consumers.
  const cp = Array.isArray(r.currentPosition) ? (r.currentPosition[0] ?? {}) : (r.currentPosition ?? {});
  const exp = Array.isArray(r.experience) ? (r.experience[0] ?? {}) : {};
  const nameCombo = [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || null;
  const full_name = pickStr(r, ["full_name", "fullName", "name", "personName", "displayName"]) ?? nameCombo;
  // Provider `location` is loosely typed: a string OR a nested object. Annotate its
  // real runtime shape so the nested extraction type-checks (behavior unchanged).
  const locObj = r.location as string | { parsed?: { text?: string | null; city?: string | null } | null; linkedinText?: string | null } | null | undefined;
  const location = typeof locObj === "string"
    ? locObj
    : (locObj?.parsed?.text ?? locObj?.linkedinText ?? locObj?.parsed?.city ?? pickStr(r, ["geoLocation", "city", "place", "country"]) ?? null);
  const company = pickStr(r, ["currentCompany", "companyName", "company", "employer", "organization"])
    ?? pickStr(cp, ["companyName", "company"]) ?? pickStr(exp, ["companyName", "company"]) ?? null;
  const title = pickStr(r, ["currentJobTitle", "jobTitle", "title", "position"])
    ?? pickStr(cp, ["position", "title"]) ?? pickStr(exp, ["position", "title"]) ?? null;
  // GROUNDED company LinkedIn URL from documented provider fields only (see
  // extractProviderCompanyLinkedInUrl). When absent, downstream enrichment keeps
  // the company-name search fallback — a URL is NEVER invented/derived.
  const company_linkedin_url = extractProviderCompanyLinkedInUrl(r);
  return {
    name:        full_name, // generic consumers (run-agent mapItem) read `name`
    full_name,
    headline:    pickStr(r, ["headline", "title_headline", "subtitle", "occupation"]),
    title,
    location,
    company,
    ...(company_linkedin_url ? { company_linkedin_url } : {}),
    profile_url: pickStr(r, ["profileUrl", "profile_url", "linkedinUrl", "linkedin_url", "url", "publicProfileUrl"]),
    summary:     pickStr(r, ["summary", "about", "description"]),
    source:      "apify",
    signal_type: "people_profile",
    raw:         truncObj(r, 4000),
  };
}

async function apifyFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data: any }> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${APIFY_BASE}${path}`, { ...rest, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function execSourceWithApify(
  input: unknown, ctx?: ToolContext,
): Promise<ToolResult> {
  const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN");
  if (!APIFY_API_TOKEN) {
    return { ok: false, unavailable: true, error: "apify_not_configured" };
  }

  const i = (input ?? {}) as {
    actor_id?: string;
    selected_actor_key?: string;
    /** Set when `input` is already this capability's own compiled Actor payload. */
    compiled_actor_input?: boolean;
    capability_key?: string;
    compiled_input_hash?: string;
    /** Which component owns persistence for this call. Explicit, never inferred. */
    persistence_authority?: "capability_engine" | "legacy";
    source_type?: string;
    search_goal?: string;
    query?: string;
    location?: string;
    role_keywords?: string[];
    max_results?: number;
    input?: Record<string, unknown>;
    allow_disabled?: boolean;
  };

  const requested_source_type = (i.source_type ?? null) as string | null;
  const selected_actor_key = (i.selected_actor_key ?? null) as string | null;
  const max_results = Math.min(100, Math.max(1, Number(i.max_results) || 25));
  const search_goal = (i.search_goal ?? "").toString();
  const allow_disabled = i.allow_disabled === true;

  // Resolve actor: prefer explicit actor_id, then selected_actor_key (registry), then source_type alias.
  let actor_id = (i.actor_id ?? "").toString().trim();
  let actorCfg: ApifyActorCfg | undefined;
  let registry_actor_key: string | null = null;

  if (actor_id) {
    if (!APIFY_ACTOR_ID_RE.test(actor_id)) return { ok: false, error: "invalid_actor_id" };
    actorCfg = Object.values(APIFY_ACTORS).find((c) => c.actor_id === actor_id);
  } else if (selected_actor_key) {
    const reg = getActorByKey(selected_actor_key);
    if (!reg) {
      return {
        ok: false,
        unavailable: true,
        error: "actor_key_unknown",
        data: {
          actor_key: selected_actor_key,
          source_type: requested_source_type,
          reason: `selected_actor_key "${selected_actor_key}" is not in ACTOR_REGISTRY.`,
          configured_actor_keys: Object.keys(ACTOR_REGISTRY),
        },
      };
    }
    if (!isActorRuntimeEnabled(reg) && !allow_disabled) {
      return {
        ok: false,
        unavailable: true,
        error: "actor_missing",
        data: {
          actor_key: reg.key,
          actor_id: reg.actor_id,
          source_type: reg.source_type,
          reason: reg.missing_message
            ?? `Actor "${reg.key}" is disabled or its required environment is not configured.`,
          configured_actor_keys: Object.values(ACTOR_REGISTRY).filter(isActorRuntimeEnabled).map((a) => a.key),
        },
      };
    }
    if (!reg.actor_id) {
      return {
        ok: false,
        unavailable: true,
        error: "actor_missing",
        data: {
          actor_key: reg.key,
          source_type: reg.source_type,
          reason: reg.missing_message ?? `Actor "${reg.key}" has no actor_id configured.`,
          configured_actor_keys: Object.values(ACTOR_REGISTRY).filter(isActorRuntimeEnabled).map((a) => a.key),
        },
      };
    }
    actor_id = reg.actor_id;
    registry_actor_key = reg.key;
    actorCfg = Object.values(APIFY_ACTORS).find((c) => c.actor_id === actor_id)
      ?? APIFY_ACTORS[reg.source_type ?? "jobs"];
  } else {
    const source_type_alias = normalizeApifySourceType(requested_source_type ?? "jobs");
    const cfg = APIFY_ACTORS[source_type_alias];
    if (!cfg?.actor_id) {
      return {
        ok: false,
        unavailable: true,
        error: "apify_actor_not_configured",
        data: {
          requested_source_type,
          normalized_source_type: source_type_alias,
          expected_actor_key: source_type_alias,
          actor_configured: false,
          message: `No Apify actor configured for source_type=${source_type_alias} (requested=${requested_source_type ?? "null"}).`,
        },
      };
    }
    actor_id = cfg.actor_id;
    actorCfg = cfg;
  }

  const source_type = actorCfg?.source_type ?? normalizeApifySourceType(requested_source_type ?? "jobs");

  // ── THE RESPONSE SHAPE IS A PROPERTY OF THE ACTOR ───────────────────────────
  //
  // `source_type` above defaults to "jobs" whenever the caller sent none AND the
  // actor has no `APIFY_ACTORS` entry. memo23 is exactly that case: the
  // capability engine sends `actor_id` + `selected_actor_key` and no
  // `source_type`, and there is no APIFY_ACTORS row for
  // memo23/y-combinator-scraper. On TEST task 41342269 that default turned 50
  // correct YC company rows into 25 fabricated LinkedIn job records.
  //
  // Classification therefore reads the actor key AS SENT (`i.selected_actor_key`)
  // and the resolved `actor_id` — never the defaulted source_type. The old
  // single-actor `isCompanyDetails` check was the right idea scoped to one
  // provider; this is the same idea applied to every structured-company actor.
  const responseKind = assertResponseKindConsistent({
    actorKey: registry_actor_key ?? selected_actor_key,
    actorId: actor_id,
    // Only a source_type the CALLER asked for can conflict; the "jobs" default
    // is exactly what must not be treated as a request.
    sourceType: requested_source_type,
    declared: (i as { response_kind?: string }).response_kind ?? null,
  });
  const isStructuredCompanies = responseKind === "structured_companies";
  const isCompanyDetails = registry_actor_key === COMPANY_DETAILS_ACTOR_KEY || actor_id === COMPANY_DETAILS_ACTOR_ID;

  // If the registry explicitly approved this actor (it passed isActorRuntimeEnabled
  // via env flags + required_env), treat it as opted in.
  const registryApproved = !!registry_actor_key;

  // Hard gate: opt-in-only actors never run without explicit opt-in.
  if (OPT_IN_ONLY_ACTOR_IDS.has(actor_id) && !allow_disabled && !registryApproved) {
    return {
      ok: false,
      unavailable: true,
      error: "apify_actor_disabled_by_default",
      data: {
        actor_id,
        source_type: actorCfg?.source_type ?? source_type,
        use_for: actorCfg?.use_for ?? [],
        message:
          `${actor_id} is opt-in only. Enable it via the matching APIFY_ENABLE_* env flag, or pass allow_disabled: true.`,
      },
    };
  }

  // Soft gate: any local-catalog actor marked enabled_by_default: false requires opt-in.
  if (actorCfg && actorCfg.enabled_by_default === false && !allow_disabled && !registryApproved) {
    return {
      ok: false,
      unavailable: true,
      error: "apify_actor_disabled_by_default",
      data: {
        actor_id,
        source_type: actorCfg.source_type ?? source_type,
        use_for: actorCfg.use_for ?? [],
        message: `Apify actor ${actor_id} is opt-in only. Pass allow_disabled: true to enable.`,
      },
    };
  }




  // Apify accepts `username~actor-name` or actorId in the URL path.
  const actorPath = encodeURIComponent(actor_id.replace("/", "~"));

  const userInput = (i.input && typeof i.input === "object") ? (i.input as Record<string, unknown>) : {};

  // ---- CAPABILITY-COMPILED PAYLOADS ARE AUTHORITATIVE --------------------
  //
  // The actor id resolves from ACTOR_REGISTRY; the adapter below resolves from
  // APIFY_ACTORS keyed by `source_type`. For a dynamic-source actor with no
  // matching APIFY_ACTORS entry those two disagree, and the adapter silently
  // rewrites a correct payload into another vendor's shape. Production task
  // 2425ec4f: Crawlworks was resolved correctly and then handed
  // `{urls, count, scrapeCompany, useIncognitoMode, splitByLocation}`.
  //
  // When the caller has already compiled this capability's own payload, it is sent
  // verbatim. No legacy adapter, no merge, no re-derivation.
  const compiledPassthrough = (i as { compiled_actor_input?: unknown }).compiled_actor_input === true;
  const compiledCapability = (i as { capability_key?: unknown }).capability_key;

  let actorInput: Record<string, unknown>;
  if (compiledPassthrough) {
    // ── TRANSPORT INTEGRITY: FAIL CLOSED ────────────────────────────────────
    //
    // A compiled invocation that arrives with no payload is a WIRING BUG, never
    // a legitimate "run with defaults". run-agent sent the payload under
    // `user_input`, which is not the key read three lines above, so `userInput`
    // resolved to `{}` and `JSON.stringify({})` reached Apify. The Actor then
    // applied its own schema defaults and ran a Jobs-mode scrape. Runs
    // rWikfnKgnp5DazDYr and eGzD7gzJNGFm4c4IZ were both empty bodies, and both
    // looked successful.
    //
    // An empty compiled payload can never be correct, so it stops here rather
    // than being spent.
    if (!i.input || typeof i.input !== "object" || Array.isArray(i.input)) {
      return {
        ok: false,
        error: "compiled_input_missing",
        data: {
          actor_id, actor_key: registry_actor_key,
          capability: typeof compiledCapability === "string" ? compiledCapability : null,
          reason: "compiled_actor_input=true but the envelope carried no `input` object; " +
            "no provider call was made",
          received_envelope_keys: Object.keys(i as Record<string, unknown>).sort(),
        },
      };
    }
    if (Object.keys(userInput).length === 0) {
      return {
        ok: false,
        error: "compiled_input_missing",
        data: {
          actor_id, actor_key: registry_actor_key,
          capability: typeof compiledCapability === "string" ? compiledCapability : null,
          reason: "the compiled payload is empty; Apify would substitute its own defaults",
          received_envelope_keys: Object.keys(i as Record<string, unknown>).sort(),
        },
      };
    }
    actorInput = userInput;
  } else {
    actorInput = actorCfg?.input_adapter
      ? actorCfg.input_adapter({
          query: i.query ?? search_goal ?? null,
          location: i.location ?? null,
          role_keywords: Array.isArray(i.role_keywords) ? i.role_keywords : null,
          max_results,
          user_input: userInput,
        })
      : {
          query: i.query ?? search_goal ?? null,
          location: i.location ?? null,
          role_keywords: Array.isArray(i.role_keywords) ? i.role_keywords : null,
          max_results,
          ...userInput,
        };
  }

  // ---- FINAL GATE: validate the object that is ACTUALLY about to be sent ----
  //
  // Validating the compiled input and then invoking a different object is the
  // defect. This runs on `actorInput` itself, after every transformation, and
  // fails LOCALLY — a known-bad payload never reaches Apify and never costs money.
  const finalVerdict = validateFinalActorPayload(
    typeof compiledCapability === "string" ? compiledCapability : null,
    actorInput,
  );
  if (!finalVerdict.ok) {
    return {
      ok: false,
      error: "final_payload_schema_invalid",
      data: {
        ...finalPayloadDiagnostics(finalVerdict),
        actor_key: registry_actor_key,
        reason: "the compiled payload failed final validation; no provider call was made",
      },
    };
  }

  // ── OUTBOUND HASH EQUALITY, ON THE OBJECT ABOUT TO BE SERIALIZED ─────────
  //
  // `compiled_input_hash` was declared on this envelope and written by one
  // caller, and read by nothing. Had it been enforced, the empty-body defect
  // would have failed closed instead of running twice. It is checked HERE —
  // after every transformation, against the exact object handed to
  // JSON.stringify below — because validating one object and sending another is
  // the failure this whole path keeps repeating.
  // THE SAME FUNCTION AND THE SAME ACTOR KEY THE COMPILER USED. `hashInput` now
  // hashes `{actorKey, input}`, so an outbound check that omitted the key would
  // never equal the compiled value and every compiled call would fail closed.
  const outboundHash = hashInput(
    actorInput, typeof compiledCapability === "string" ? compiledCapability : "");
  const expectedHash = typeof i.compiled_input_hash === "string" ? i.compiled_input_hash : null;
  if (compiledPassthrough && expectedHash && expectedHash !== outboundHash) {
    console.error("[toolRegistry] compiled_input_hash_mismatch", {
      actor_id, expected: expectedHash, actual: outboundHash,
    });
    return {
      ok: false,
      error: "compiled_input_hash_mismatch",
      data: {
        actor_id, actor_key: registry_actor_key,
        capability: typeof compiledCapability === "string" ? compiledCapability : null,
        expected_hash: expectedHash,
        outbound_hash: outboundHash,
        outbound_keys: Object.keys(actorInput).sort(),
        reason: "the payload about to be sent is not the payload that was compiled and validated; " +
          "no provider call was made",
      },
    };
  }

  // ── RESUME AN EXISTING RUN INSTEAD OF STARTING A NEW ONE ──────────────────
  //
  // A run that was still RUNNING when the previous invocation's 90s poll window
  // closed is a PAID run that already exists. TEST run rWikfnKgnp5DazDYr was
  // abandoned exactly that way: started, billed, never read. Adopting the run id
  // is the difference between resuming and paying twice for the same question.
  //
  // `resume_run_id` therefore SKIPS the start call entirely. No POST /runs, no
  // second Actor, no additional charge.
  const resumeRunId = typeof (i as { resume_run_id?: unknown }).resume_run_id === "string"
    ? String((i as { resume_run_id?: unknown }).resume_run_id).trim()
    : "";

  const startRes = resumeRunId
    ? await apifyFetch(`/actor-runs/${resumeRunId}?token=${APIFY_API_TOKEN}`, {
      method: "GET",
      timeoutMs: 20_000,
    }).catch((e) => ({ ok: false, status: 0, data: { error: String(e) } }))
    : await apifyFetch(`/acts/${actorPath}/runs?token=${APIFY_API_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
      timeoutMs: 20_000,
    }).catch((e) => ({ ok: false, status: 0, data: { error: String(e) } }));

  if (startRes.status === 401 || startRes.status === 403) {
    // Token reached Apify but was rejected — almost always actor access/rental,
    // not a malformed token. Surface a clear, actionable hint (rule 9).
    console.error("[toolRegistry] apify_unauthorized", { actor_id, source_type, status: startRes.status });
    return {
      ok: false,
      unavailable: true,
      error: "apify_unauthorized",
      data: {
        actor_id,
        source_type,
        status: startRes.status,
        hint: "Apify rejected the request (401/403). Check that this token's account has access to / has rented the actor, and that APIFY_API_TOKEN is valid.",
      },
    };
  }
  if (startRes.status === 402) {
    return { ok: false, unavailable: true, error: "apify_insufficient_credits" };
  }
  if (startRes.status === 400) {
    // Malformed actor input. Log the SHAPE only (keys), never values or the
    // token (token lives in the URL query, not in actorInput) — rule 8.
    const apifyMessage =
      (startRes.data?.error?.message ?? startRes.data?.error ?? startRes.data?.message ?? null) as string | null;
    console.error("[toolRegistry] apify_input_schema_error", {
      actor_id,
      source_type,
      payload_keys: Object.keys(actorInput),
      apify_message: apifyMessage,
    });
    return {
      ok: false,
      error: "apify_input_schema_error",
      data: {
        actor_id,
        source_type,
        payload_keys: Object.keys(actorInput),
        apify_message: apifyMessage,
        hint: "Apify rejected the actor input (400). The input payload shape does not match the actor's schema.",
      },
    };
  }
  if (!startRes.ok) {
    return { ok: false, error: `apify_start_failed:${startRes.status}` };
  }

  const run = startRes.data?.data ?? startRes.data ?? {};
  const run_id: string | undefined = run.id;
  const dataset_id: string | undefined = run.defaultDatasetId;
  if (!run_id) return { ok: false, error: "apify_missing_run_id" };

  // ── PERSIST BEFORE WAITING ───────────────────────────────────────────────
  //
  // Everything below this line can be killed by the platform without warning.
  // From here the run is billed and running, so its identifiers are written now
  // rather than when the poll gives up — that is the difference between a
  // resumable run and an abandoned one. Awaited so the write actually lands,
  // and never allowed to fail the call.
  try {
    await ctx?.onRunStarted?.({ run_id, dataset_id: dataset_id ?? null });
  } catch (e) {
    console.error("[toolRegistry] onRunStarted failed", String(e));
  }

  const deadline = Date.now() + 90_000;
  let status: string = run.status ?? "READY";
  let finalRun: any = run;
  while (Date.now() < deadline) {
    if (status === "SUCCEEDED" || status === "FAILED" || status === "TIMED-OUT" || status === "ABORTED") break;
    if (ctx?.stopWaiting?.()) {
      console.log("[toolRegistry] stopped waiting on a running Apify run; it stays pending", { run_id, status });
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await apifyFetch(`/actor-runs/${run_id}?token=${APIFY_API_TOKEN}`, {
      method: "GET",
      timeoutMs: 10_000,
    }).catch(() => null);
    if (!poll) continue;
    if (poll.status === 401 || poll.status === 403) {
      return { ok: false, unavailable: true, error: "apify_unauthorized", data: { run_id } };
    }
    finalRun = poll.data?.data ?? poll.data ?? finalRun;
    status = finalRun?.status ?? status;
  }

  const resolvedDatasetId: string | undefined = finalRun?.defaultDatasetId ?? dataset_id;

  // THE BUILD IS RECORDED, NOT PINNED BLIND. Apify reports the build the run
  // actually used; persisting it is what makes "which schema did this validate
  // against" answerable later without guessing.
  const build_id: string | null = finalRun?.buildId ?? null;
  const build_number: string | null = finalRun?.buildNumber ?? null;

  if (status !== "SUCCEEDED") {
    // RUNNING/READY is PENDING, not failure. The run exists and is billable, so
    // the identifiers travel back for a later resume rather than being discarded.
    const pending = status === "RUNNING" || status === "READY";
    return {
      ok: false,
      error: `apify_run_${(status || "timeout").toLowerCase()}`,
      data: {
        run_id, dataset_id: resolvedDatasetId, status,
        pending, resumable: pending, actor_id, build_id, build_number,
        resumed_from: resumeRunId || null,
        outbound_input_hash: outboundHash,
      },
    };
  }

  if (!resolvedDatasetId) {
    return {
      ok: true,
      data: { actor_id, run_id, dataset_id: null, items: [], total: 0, no_results: true, summary: "no_dataset", citations: [] },
    };
  }

  // Jobs: fetch a POOL (up to 25 already-run rows — $0 extra, the dataset exists)
  // so run-agent can pre-rank against the Company Brain ICP and process the BEST
  // max_results, not the first returned. Other sources fetch exactly max_results.
  // Company details are never a "jobs" pool even though the alias resolves to
  // "jobs" — fetch exactly max_results, never the 25-row pre-rank pool.
  // A STRUCTURED-COMPANY ACTOR IS NEVER A JOBS SOURCE, whatever `source_type`
  // defaulted to. The 25-row cap below is a LinkedIn-Jobs pre-rank pool; applied
  // to a company scraper it silently discarded half of a paid 50-row dataset.
  const isJobsSource = /jobs/i.test(source_type) && !isCompanyDetails && !isStructuredCompanies;
  // Bounds memory, not evidence. Every hiring dataset this system has produced
  // fits inside it; a run that does not will say so in its count ledger.
  // THE COMPILED INPUT ALREADY SAYS HOW MANY ROWS WERE ASKED FOR.
  //
  // `max_results` is an ENVELOPE field, and the capability engine does not send
  // one — so it fell back to the generic default of 25 while the compiled
  // memo23 input asked Apify for `maxItems: 50`. The Actor produced the larger
  // set and we downloaded 25 of it. A quieter version of the same 50→25 loss
  // fixed one commit ago, arriving by a different default.
  //
  // For a structured-company actor the Actor's own `maxItems` is the
  // authoritative count; the envelope value is only a fallback.
  const compiledMaxItems = (() => {
    const ui = (i.input && typeof i.input === "object") ? i.input as Record<string, unknown> : null;
    const v = ui?.maxItems;
    return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 1000 ? v : null;
  })();
  const structuredLimit = compiledMaxItems ?? max_results;
  //
  // ── THE JOBS POOL WAS A CAP, NOT A POOL ─────────────────────────────────
  //
  // This was `Math.min(25, Math.max(max_results, 10))`, described above as a
  // pre-rank POOL — a number chosen to be LARGER than the handful of rows a
  // caller wanted, so ranking had something to rank. It stopped being larger.
  //
  // Task 5c461aa3's four paid hiring searches produced datasets of 74, 98, 59
  // and 3 rows. We downloaded 25, 25, 25 and 3. **156 of 234 rows this run paid
  // for were never read**, and the assessment that found no sales roles was
  // scoring a truncated third of the evidence.
  //
  // The comment's own reasoning is the fix: the dataset already exists and
  // reading further into it costs nothing. The ceiling is explicit and bounds
  // memory rather than evidence, and `buildCountLedger` below reports any row
  // that still does not make it back — the exact loss, made visible, being what
  // the structured path already learned to do after the identical 50→25 bug.
  const fetchLimit = isJobsSource
    ? Math.max(JOBS_POOL_READ_CEILING, compiledMaxItems ?? 0, max_results)
    : (isStructuredCompanies || isCompanyDetails ? structuredLimit : max_results);
  const itemsRes = await apifyFetch(
    `/datasets/${resolvedDatasetId}/items?clean=true&limit=${fetchLimit}&token=${APIFY_API_TOKEN}`,
    { method: "GET", timeoutMs: 20_000 },
  ).catch((e) => ({ ok: false, status: 0, data: { error: String(e) } }));

  if (!itemsRes.ok) {
    return {
      ok: false,
      error: `apify_items_failed:${itemsRes.status}`,
      data: { run_id, dataset_id: resolvedDatasetId },
    };
  }

  const rawItems: any[] = Array.isArray(itemsRes.data) ? itemsRes.data : [];

  // ── Structured company-details result path ──────────────────────────────────
  // Return the COMPLETE dataset items untouched via a dedicated `company_items`
  // field so the company normalizer sees every firmographic field. No job/people
  // normalization, no provider_payload, no 4,000-char truncation, and no fake job
  // records fabricated in `items`. Respects max_results (fetchLimit == max_results
  // above). Provider run provenance is preserved; sanitization happens downstream
  // in the normalizer — the raw items never enter observability from here.
  if (isStructuredCompanies) {
    // SLICED TO THE SAME LIMIT WE FETCHED. Slicing to `max_results` here while
    // fetching `structuredLimit` above would re-impose the 25-row default one
    // line after removing it.
    const company_items = rawItems.slice(0, fetchLimit);
    const ledger = buildCountLedger(
      fetchLimit, rawItems.length, company_items.length,
      company_items.length < rawItems.length ? "fetch_limit_cap" : null,
      compiledMaxItems,
    );
    // VISIBLE, NOT SILENT. A company-discovery response that lost rows between
    // the dataset and the caller is reported in the payload rather than looking
    // like a smaller dataset — the 50→25 loss was invisible for exactly this
    // reason.
    if (ledger.truncated) {
      console.warn("[runTool][structured-companies][truncated]", {
        actor_id, requested_limit: ledger.requested_limit,
        downloaded: ledger.downloaded, returned: ledger.returned,
      });
    }
    const kindLabel = isCompanyDetails ? "company_details" : "structured_companies";
    return {
      ok: true,
      data: {
        actor_id,
        selected_actor_key: registry_actor_key ?? selected_actor_key,
        response_kind: responseKind,
        actor_output_type: kindLabel,
        requested_source_type,
        normalized_source_type: kindLabel,
        run_id,
        dataset_id: resolvedDatasetId,
      // ── THE PROVIDER'S OWN USAGE, CARRIED OUT OF THE POLLER ─────────────
      //
      // `finalRun` is the full `/actor-runs/{id}` document and it dies here
      // otherwise. `priceProviderCall` reads `usageTotalUsd` if Apify sends it
      // and falls back to the verified card price table if not — so passing it
      // through is what turns "does the run object carry a charge?" from a
      // comment into a recorded fact. Three fields, never the whole document:
      // this travels into a jsonb column.
      provider_usage: {
        usageTotalUsd: finalRun?.usageTotalUsd ?? null,
        usage: finalRun?.usage ? { totalUsd: finalRun.usage.totalUsd ?? null } : null,
        stats: finalRun?.stats ? { computeUnits: finalRun.stats.computeUnits ?? null } : null,
        // THE RUN'S OWN EVENT COUNTS AND PRICES. `usageTotalUsd` settles after
        // SUCCEEDED; these let the ledger price what the run actually did.
        chargedEventCounts: finalRun?.chargedEventCounts ?? null,
        eventPrices: apifyEventPrices(finalRun?.pricingInfo),
      },
        // ONE CONTRACT, TWO NAMES. `company_items` is what the structured branch
        // has always been authoritative on; `items` is what every consumer
        // actually reads — including `invokeJobs`, which is why company
        // enrichment has been receiving `[]` from this branch all along. They
        // are the SAME array, so they cannot drift apart.
        company_items,
        items: company_items,
        count: company_items.length,
        total: company_items.length,
        result_ledger: ledger,
        no_results: company_items.length === 0,
        summary:
          `${kindLabel} actor returned ${company_items.length} complete company record(s) ` +
          `(downloaded ${ledger.downloaded} of a ${ledger.requested_limit}-row request)`,
        citations: [],
      },
    };
  }

  const topicForNorm = (i.query ?? search_goal ?? null) as string | null;
  // For jobs, return the whole pool (run-agent pre-ranks + caps to max_results);
  // other sources stay capped here.
  const items: any[] = source_type === "people_profiles"
    ? rawItems.slice(0, max_results).map((r) => normalizeApifyPeopleItem(r))
    : source_type === "linkedin_engagement"
      ? rawItems.slice(0, max_results).map((r) => normalizeLinkedinEngagementItem(r, topicForNorm))
      : source_type === "linkedin_comments"
        ? rawItems.slice(0, max_results).map((r) => normalizeLinkedinCommenterItem(r))
        : rawItems.slice(0, fetchLimit).map((r) => normalizeApifyItem(r, source_type));

  // Phase 4.2 — competitor discovery context (Hawk's inferred competitors,
  // threaded via user_input). Tag items that have no per-item seed match with
  // the inferred competitor so the Workbench + memory reflect competitor_engagement.
  const ui = (i.input && typeof i.input === "object") ? (i.input as Record<string, unknown>) : {};
  const discovery = ui.competitor_discovery
    ? {
        inferred_competitors: Array.isArray(ui.inferred_competitors) ? ui.inferred_competitors : [],
        competitor_category: typeof ui.competitor_category === "string" ? ui.competitor_category : null,
        matched_query: typeof ui.matched_query === "string" ? ui.matched_query : null,
        original_business_description: typeof ui.original_business_description === "string" ? ui.original_business_description : null,
        original_website_url: typeof ui.original_website_url === "string" ? ui.original_website_url : null,
        hypothesis_reason: typeof ui.hypothesis_reason === "string" ? ui.hypothesis_reason : null,
      }
    : null;
  if (discovery && source_type === "linkedin_engagement") {
    const inferredName = (discovery.inferred_competitors[0] as string) ?? null;
    for (const it of items) {
      if (!it.competitor_key && !it.competitor_name) {
        it.competitor_name = inferredName;
        it.competitor_category = discovery.competitor_category;
        it.competitor_source = "ai_inferred";
      }
    }
  }
  const citations = items
    .map((it: any) => (it as any).url ?? (it as any).profile_url ?? (it as any).post_url ?? (it as any).post_author_profile_url)
    .filter((u: any): u is string => typeof u === "string" && !!u)
    .slice(0, 10);

  const registryEntry = registry_actor_key ? getActorByKey(registry_actor_key) : null;
  return {
    ok: true,
    data: {
      actor_id,
      selected_actor_key: registry_actor_key,
      actor_label: registryEntry?.label ?? null,
      actor_output_type: registryEntry?.output_type ?? null,
      requested_source_type,
      normalized_source_type: source_type,
      expected_actor_key: source_type,
      actor_configured: true,
      discovery,
      run_id,
      dataset_id: resolvedDatasetId,
      // ── THE PROVIDER'S OWN USAGE, CARRIED OUT OF THE POLLER ─────────────
      //
      // `finalRun` is the full `/actor-runs/{id}` document and it dies here
      // otherwise. `priceProviderCall` reads `usageTotalUsd` if Apify sends it
      // and falls back to the verified card price table if not — so passing it
      // through is what turns "does the run object carry a charge?" from a
      // comment into a recorded fact. Three fields, never the whole document:
      // this travels into a jsonb column.
      provider_usage: {
        usageTotalUsd: finalRun?.usageTotalUsd ?? null,
        usage: finalRun?.usage ? { totalUsd: finalRun.usage.totalUsd ?? null } : null,
        stats: finalRun?.stats ? { computeUnits: finalRun.stats.computeUnits ?? null } : null,
        // THE RUN'S OWN EVENT COUNTS AND PRICES. `usageTotalUsd` settles after
        // SUCCEEDED; these let the ledger price what the run actually did.
        chargedEventCounts: finalRun?.chargedEventCounts ?? null,
        eventPrices: apifyEventPrices(finalRun?.pricingInfo),
      },
      items,
      // ── THE DATASET, UNTOUCHED, BESIDE THE PROJECTION ───────────────────
      //
      // `items` above is the LEGACY shape: every row flattened by
      // `normalizeApifyJobRow`, which the company-first path, the Workbench,
      // the CSV export and memory all read. It is not the dataset.
      //
      // The capability engine owns a normalizer per Actor, written against the
      // output contracts in `hiringActorCatalog`, and normalizing twice is what
      // silently emptied task a76c7b4c's hiring stage — see
      // `readProviderResultItems`. So the rows travel BOTH ways out of here,
      // exactly as `company_items` and `items` already do on the structured
      // branch, and each consumer reads the one it owns a normalizer for.
      //
      // Same slice, same ledger: the two can differ in SHAPE and never in
      // which rows they carry.
      job_items: isJobsSource ? rawItems.slice(0, fetchLimit) : undefined,
      total: items.length,
      // ── WHAT WAS BOUGHT vs WHAT CAME BACK ───────────────────────────────
      //
      // The structured path has reported this since the 50→25 loss; the jobs
      // path never did, and that is why 156 of 234 paid rows disappeared
      // without a trace on task 5c461aa3. `buildCountLedger` also flags the
      // quieter case — a read shallower than the `maxItems` the Actor was paid
      // for — so an under-read can never again look like a small dataset.
      count_ledger: buildCountLedger(
        fetchLimit, rawItems.length, items.length,
        items.length < rawItems.length ? "fetch_limit_cap" : null,
        compiledMaxItems,
      ),
      // Success with zero items is `no_results`, not a failure (rule 10).
      no_results: items.length === 0,
      summary: items.length === 0
        ? `Apify actor ran successfully but returned 0 ${source_type} results for: ${search_goal || i.query || "(no goal)"}`
        : `Apify actor returned ${items.length} ${source_type} result(s) for: ${search_goal || i.query || "(no goal)"}`,
      citations,
    },
  };
}

// ---------- Tool: send_email (Resend) — approval-gated stub ----------

async function execSendEmail(input: unknown): Promise<ToolResult> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) return { ok: false, unavailable: true, error: "RESEND_API_KEY not configured" };
  const i = (input ?? {}) as { to?: string; subject?: string; html?: string; from?: string };
  if (!i.to || !i.subject || !i.html) return { ok: false, error: "missing to/subject/html" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: i.from ?? "Workforce <onboarding@resend.dev>",
        to: [i.to],
        subject: i.subject,
        html: i.html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Resend ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Resend fetch failed: ${String(e)}` };
  }
}

// ---------- Tool: search_web (broad grounded web search) ----------
// Placeholder: returns `unavailable` unless a real grounded-search backend
// (e.g. Gemini Enterprise webGroundingSpec) is wired up. This lets the
// orchestrator honestly report "broad web search unavailable" without
// pretending Perplexity is the only option.
async function execSearchWeb(_input: unknown): Promise<ToolResult> {
  return {
    ok: false,
    unavailable: true,
    error: "broad_web_search_not_configured",
  };
}

// ---------- Registry ----------

const REGISTRY: Record<string, ToolDef> = {
  search_web: {
    name: "search_web",
    provider: "gemini_search",
    description: "Broad grounded web search (Gemini/Lovable). Reports unavailable until a grounded-search backend is configured.",
    allowed_agents: ["hawk", "scout"],
    requires_approval: false,
    execute: execSearchWeb,
  },
  scrape_url: {
    name: "scrape_url",
    provider: "firecrawl",
    description: "Primary tool for URL/page extraction — scrape a single URL to markdown via Firecrawl.",
    allowed_agents: ["hawk", "scout"],
    requires_approval: false,
    execute: execScrapeUrl,
  },
  source_with_apify: {
    name: "source_with_apify",
    provider: "apify",
    description: "Primary tool for hiring/company/job/lead signal sourcing — runs an Apify actor.",
    // ── WHO MAY SPEND ON A PROVIDER ─────────────────────────────────────
    //
    // `signals_monitor` joined when Signals became a caller of the shared
    // capability engine. It is listed EXPLICITLY rather than borrowing a Lead
    // agent's slug: `logToolCall` writes this slug to `tool_calls`, so a
    // monitoring run masquerading as `scout` would put monitoring's spend in
    // the Lead agent's audit trail — the one record that says who bought what.
    allowed_agents: ["scout", "hawk", "signals_monitor"],
    requires_approval: false,
    execute: execSourceWithApify,
  },
  send_email: {
    name: "send_email",
    provider: "resend",
    description: "Send a transactional email via Resend (approval-gated).",
    allowed_agents: ["penn"],
    requires_approval: true,
    execute: execSendEmail,
  },
};

/**
 * TOOLS THAT ONCE EXISTED AND MUST NOT SILENTLY REAPPEAR AS "READY".
 *
 * `isToolConfigured` answers `{ready: true}` for any name absent from
 * `TOOL_ENV` — the sensible default for a tool needing no key, and exactly the
 * wrong answer for one that has been removed. Without this entry, deleting
 * `research_web` would have made every caller believe research was available
 * and reachable, which is a worse failure than the one being fixed.
 */
export const RETIRED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  research_web:
    "retired 2026-09-07 — the Perplexity path spent outside the model ledger, " +
    "the credit system and the spend ceilings; reintroduce it through those, not around them",
});

const TOOL_ENV: Record<string, string> = {
  search_web: "GEMINI_SEARCH",
  scrape_url: "FIRECRAWL_API_KEY",
  source_with_apify: "APIFY_API_TOKEN",
  send_email: "RESEND_API_KEY",
};

export function isToolConfigured(
  name: string,
): { ready: boolean; env?: string; retired?: string } {
  // CHECKED FIRST. A retired tool is never ready, whatever the environment
  // holds — the Perplexity key is still set in production and must not be read
  // as "research is available".
  const retired = RETIRED_TOOLS[name];
  if (retired) return { ready: false, retired };
  const env = TOOL_ENV[name];
  if (!env) return { ready: true };
  return { ready: !!Deno.env.get(env), env };
}

export function listTools() {
  return Object.values(REGISTRY).map((t) => ({
    name: t.name,
    provider: t.provider,
    allowed_agents: t.allowed_agents,
    requires_approval: t.requires_approval,
  }));
}


/**
 * The persistence authority a caller declared, or `legacy` if it declared none.
 *
 * Recognised engine authorities pass through unchanged. Anything unrecognised
 * is `legacy` — an unknown value must not silently acquire engine privileges,
 * and the legacy writer is the safe default because it is the one that existed
 * before authorities did.
 */
function engineAuthorityOf(input: unknown): PersistenceAuthority | "legacy" {
  const a = (input as { persistence_authority?: unknown } | null)?.persistence_authority;
  return (PERSISTENCE_AUTHORITIES as readonly string[]).includes(String(a ?? ""))
    ? (a as PersistenceAuthority)
    : "legacy";
}

// ---------- Main entry point ----------

export async function runTool(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = REGISTRY[toolName];
  if (!tool) {
    // A RETIRED TOOL IS UNAVAILABLE, NOT MISSING. Callers already branch on
    // `unavailable` to mean "an optional capability is absent, continue
    // without it" — `run-agent`'s broad-research step does exactly that — while
    // `tool_not_found` reads as a bug and is handled as a failure. Saying which
    // is which is the difference between a clean degrade and a broken step.
    const retired = RETIRED_TOOLS[toolName];
    if (retired) {
      console.warn("[toolRegistry] tool_retired:", { tool: toolName, reason: retired });
      return { ok: false, unavailable: true, error: `tool_retired:${toolName}` };
    }
    console.error("[toolRegistry] tool_not_found:", toolName);
    return { ok: false, error: `tool_not_found:${toolName}` };
  }

  if (!tool.allowed_agents.includes(ctx.agent_slug)) {
    console.warn("[toolRegistry] tool_forbidden:", { tool: toolName, agent: ctx.agent_slug });
    await logToolCall(ctx, tool, input, {
      ok: false,
      error: `agent '${ctx.agent_slug}' not allowed to use '${toolName}'`,
    }, "failed");
    return { ok: false, error: "tool_forbidden" };
  }

  // Insert queued row + write activity.
  const startedAt = new Date().toISOString();
  const { data: row } = await ctx.admin
    .from("tool_calls")
    .insert({
      workspace_id: ctx.workspace_id,
      plan_id: ctx.plan_id ?? null,
      task_id: ctx.task_id ?? null,
      agent_id: ctx.agent_id ?? null,
      tool_name: tool.name,
      provider: tool.provider,
      input_json: safeJson(input),
      status: "running",
      started_at: startedAt,
      created_by: ctx.user_id ?? null,
    })
    .select("id")
    .single();

  // Approval gate — refuse to execute, create approval, return awaiting_approval.
  if (tool.requires_approval) {
    await ctx.admin.from("approvals").insert({
      workspace_id: ctx.workspace_id,
      plan_id: ctx.plan_id ?? null,
      task_id: ctx.task_id ?? null,
      agent_id: ctx.agent_id ?? null,
      title: `${ctx.agent_name ?? ctx.agent_slug} requests ${tool.name}`,
      description: `Approval required to execute ${tool.name} via ${tool.provider}.`,
      status: "pending",
    });
    if (row?.id) {
      await ctx.admin.from("tool_calls").update({ status: "queued" }).eq("id", row.id);
    }
    await ctx.admin.from("activity_feed").insert({
      workspace_id: ctx.workspace_id,
      plan_id: ctx.plan_id ?? null,
      agent_id: ctx.agent_id ?? null,
      event_type: "tool_awaiting_approval",
      title: `${ctx.agent_name ?? ctx.agent_slug} ${tool.name} awaiting approval`,
      body: `${tool.name} requires approval before running.`,
      metadata: { tool: tool.name, provider: tool.provider, tool_call_id: row?.id },
    });
    return { ok: false, awaiting_approval: true, error: "awaiting_approval" };
  }

  // ══ EXECUTE, UNDER THE EXECUTION LEDGER ═══════════════════════════════════
  //
  // ONE OBSERVABILITY LAYER, NOT ONE PER PATH. All three lead-sourcing entry
  // points funnel through here — company-first `invokeJobs` and `invokePeople`,
  // and the generic `runAdaptiveSourcing` attempt — so instrumenting this single
  // seam covers both execution paths with the same schema. That is the property a
  // future people-first migration needs in order to compare them.
  //
  // Scoped to `source_with_apify`: it is the paid provider boundary. Other tools
  // keep exactly their existing `tool_calls` record and are untouched, which is
  // why "auditing on" and "auditing off" are the same run for them.
  //
  // The ledger never alters `result`. It observes and finalizes in a `finally`,
  // so a throw still leaves a terminal row.
  let result: ToolResult;
  // ── WHICH TOOLS PASS THE MONEY BOUNDARY ────────────────────────────────
  //
  // This read `tool.name === "source_with_apify"` alone, which covered the
  // lead-sourcing Actor and the people search that `find_decision_makers`
  // dispatches — but NOT `scrape_url`, the Firecrawl call behind
  // `research_company`. So one unlockable column reserved credits and its
  // neighbour did not, for no reason anyone had decided: the gate was written
  // when sourcing was the only paid path and never revisited when the Workbench
  // grew per-row unlocks.
  //
  // Both are paid provider calls against a workspace. Both go through the
  // ledger and the reserve.
  const PAID_TOOLS = new Set(["source_with_apify", "scrape_url"]);
  const audited = PAID_TOOLS.has(tool.name) && ctx.workspace_id;
  const auditInput = (input ?? {}) as Record<string, unknown>;
  const auditSpec = audited
    ? {
      workspace_id: ctx.workspace_id,
      task_id: ctx.task_id ?? null,
      plan_id: ctx.plan_id ?? null,
      execution_owner: (auditInput.execution_owner as string | undefined) ?? null,
      // THE WHOLE PROVENANCE TRIPLE, not just the selected adapter. Without the
      // outcome, "the ladder planned by design" and "a model adapter ran and
      // degraded" are the same row again.
      planner_owner: (auditInput.planner_owner as string | undefined) ?? null,
      planner_adapter: (auditInput.planner_adapter as "gpt" | "claude" | "none" | undefined) ?? null,
      planner_outcome: (auditInput.planner_outcome as
        "selected_directly" | "model_validated" | "deterministic_fallback" | undefined) ?? null,
      planner_fallback_reason: (auditInput.planner_fallback_reason as string | undefined) ?? null,
      stage: (auditInput.audit_stage as ExecutionStage | undefined)
        ?? inferStage(
          (auditInput.capability_key ?? auditInput.selected_actor_key) as string | null,
          auditInput.source_type as string | null,
        ),
      capability: (auditInput.capability_key as string | undefined)
        ?? (auditInput.selected_actor_key as string | undefined) ?? null,
      reason: (auditInput.audit_reason as ExecutionReason | undefined)
        ?? (auditInput.resume_run_id ? "resumed_run" : "unspecified"),
      provider_id: tool.provider,
      actor_id: (auditInput.actor_id as string | undefined) ?? null,
      request_input: auditInput,
      logical_call_key: logicalCallKey({
        lineage_root: ctx.lineage_root ?? null,
        task_id: ctx.task_id ?? null,
        capability: (auditInput.capability_key as string | undefined) ?? null,
        stage: inferStage(
          (auditInput.capability_key ?? auditInput.selected_actor_key) as string | null,
          auditInput.source_type as string | null,
        ),
        // NEVER "no-hash" FOR TWO DIFFERENT FIRECRAWL CALLS. This key is the
        // credit reservation's idempotency key; canary 4's maps shared one, and
        // every map after the first was replayed rather than charged.
        input_hash: paidCallInputHash(tool.name, auditInput),
      }),
      // Supplied by the caller when it knows it is retrying. Attempt 1 otherwise,
      // and the unique index means a genuine second attempt that forgets to say so
      // fails loudly rather than overwriting the first.
      attempt_number: typeof auditInput.audit_attempt === "number" ? auditInput.audit_attempt : 1,
    } satisfies ExecutionCallSpec
    : null;

  const executeOnce = async (
    progress: LedgerProgress,
  ): Promise<{ result: ToolResult; outcome: ExecutionOutcome }> => {
    let r: ToolResult;
    try {
      // The run id reaches the ledger row the instant it exists, so a hard kill
      // leaves a row that names the run instead of `provider_run_id: null`.
      r = await tool.execute(input, {
        ...ctx,
        onRunStarted: async ({ run_id, dataset_id }) => {
          await progress({ provider_run_id: run_id, dataset_id });
        },
      });
    } catch (e) {
      r = { ok: false, error: `tool_threw:${String(e)}` };
    }
    return { result: r, outcome: outcomeFromToolResult(r, auditInput) };
  };

  if (auditSpec) {
    const writer = createLedgerWriter(ctx.admin as unknown as LedgerDb);

    // ── AUTHORISE, EXECUTE, SETTLE ──────────────────────────────────────
    //
    // Here, and not at the planning layer, because a future path that reaches
    // a provider without knowing about credits is the failure being designed
    // out — and the only defence against it is that the money boundary and the
    // call boundary are the same line. `logical_call_key` is the idempotency
    // key, so a retried or replayed call reserves nothing further.
    const creditMode = resolveCreditEnforcement();
    // THE PRICE THE UI QUOTED, or the flat default for anything the pricing
    // table does not name. `unlock_capability` is set by the lead-action
    // executor, which is the only caller that has a user-facing price on a
    // button — and the number reserved here is the number that button showed,
    // by construction rather than by coincidence.
    const quoted = typeof auditInput.unlock_capability === "string"
      ? priceFor(auditInput.unlock_capability)
      : null;
    const auth = await authorizeProviderCall({
      db: ctx.admin as unknown as CreditDb,
      workspace_id: auditSpec.workspace_id,
      logical_call_key: auditSpec.logical_call_key,
      task_id: auditSpec.task_id,
      capability: auditSpec.capability,
      mode: creditMode,
      // The authority already resolved for the persistence guard, reused so the
      // ledger can tell unattended spend from a person clicking Scan.
      persistence_authority: engineAuthorityOf(input),
      ...(quoted != null ? { amount: quoted } : {}),
    });
    console.log("[credits][authorization]", {
      mode: auth.mode, allowed: auth.allowed, reserved: auth.reserved,
      reason: auth.reason, balance_after: auth.balance_after,
      capability: auditSpec.capability, detail: auth.detail,
    });

    if (!auth.allowed) {
      // REFUSED, AND NOTHING WAS STARTED. Reported with its own error code so
      // the engine can tell this from a provider fault and checkpoint instead
      // of recording a verdict about the company.
      return {
        ok: false,
        error: CREDIT_REFUSED_ERROR,
        data: {
          credit_refusal: {
            reason: auth.reason, balance_after: auth.balance_after,
            detail: auth.detail, mode: auth.mode,
          },
        },
      };
    }

    result = await withExecutionAudit(writer, auditSpec, executeOnce);

    // SETTLED ON WHAT ACTUALLY HAPPENED. A call that never reached the
    // provider refunds in full; `credits_release_stale` is the backstop if this
    // never runs at all.
    const started = result.ok || typeof (result.data as { run_id?: unknown } | null)
      ?.run_id === "string";
    const settled = await settleProviderCall({
      db: ctx.admin as unknown as CreditDb,
      transaction_id: auth.transaction_id,
      started,
      reason: result.ok ? "provider_call_succeeded" : String(result.error ?? "failed"),
    });
    console.log("[credits][settlement]", {
      transaction_id: auth.transaction_id, started,
      charged: settled.charged, settled: settled.settled, detail: settled.detail,
    });
  } else {
    try {
      result = await tool.execute(input, ctx);
    } catch (e) {
      result = { ok: false, error: `tool_threw:${String(e)}` };
    }
  }

  const status = result.ok ? "succeeded" : result.unavailable ? "unavailable" : "failed";
  const completedAt = new Date().toISOString();

  if (row?.id) {
    await ctx.admin.from("tool_calls").update({
      status,
      output_json: safeJson(result.data ?? null),
      error: result.error ?? null,
      completed_at: completedAt,
    }).eq("id", row.id);
  }

  // Phase 2: persist outputs into structured GTM memory. Fire-and-forget.
  // `defer_persistence` lets an adaptive multi-attempt loop skip per-attempt
  // writes and persist ONCE with the capped/deduped accepted set instead.
  if (result.ok && (tool.name === "source_with_apify" || tool.name === "scrape_url") && (input as any)?.defer_persistence !== true) {
    const actorKey = (input as any)?.selected_actor_key ?? null;
    const data = (result.data ?? {}) as Record<string, unknown>;
    // source_with_apify is a PROVIDER-backed lead source. Even though the live
    // Find Leads flow defers persistence to run-agent, a non-deferred call MUST NOT
    // bypass provenance: thread the real provider run context from the actor result
    // and enforce — an invalid/missing provenance now FAILS CLOSED (no insert), it
    // never falls back to user_entered. scrape_url is Firecrawl (attaches to existing
    // leads, no provider lead insert) so it is not provider-enforced.
    const isProviderSource = tool.name === "source_with_apify";
    const providerCtx = isProviderSource
      ? {
          provider: "apify",
          actor_id: (data["actor_id"] as string) ?? actorKey ?? "apify",
          provider_run_id: (data["run_id"] as string) ?? null,
          workflow_run_id: (data["run_id"] as string) ?? null,
          trace_id: (data["run_id"] as string) ?? null,
          enforce_provenance: true,
          lead_origin: "provider_sourced" as const,
        }
      : {};
    await writeMemoryFromToolCall({
      // Declared by the caller, never inferred. The capability engine sets this
      // so the legacy writer publishes nothing for a LeadMissionV1 run.
      // ── THE AUTHORITY IS PASSED THROUGH, NOT RE-DECIDED ─────────────────
      //
      // This narrowed anything that was not exactly `capability_engine` to
      // `legacy`, which is the same mistake `memoryWriter` had and is where it
      // actually bit: monitoring spends under `monitoring_engine`, that value
      // was flattened to `legacy` HERE, and the guard downstream — already
      // fixed to accept any engine — never saw it. Live run 2026-08-24: ten v1
      // `signals` rows written into a monitoring-only workspace, one per pass,
      // from a watchlist nobody asked to turn into a pipeline.
      //
      // Membership in the shared list, so a future authority is carried by
      // default instead of being silently downgraded to the legacy writer.
      persistence_authority: engineAuthorityOf(input),
      admin: ctx.admin,
      workspace_id: ctx.workspace_id,
      plan_id: ctx.plan_id ?? null,
      task_id: ctx.task_id ?? null,
      tool_call_id: row?.id ?? null,
      tool_name: tool.name,
      selected_actor_key: actorKey,
      ...providerCtx,
      output: result.data ?? null,
    });
  }

  await ctx.admin.from("activity_feed").insert({
    workspace_id: ctx.workspace_id,
    plan_id: ctx.plan_id ?? null,
    agent_id: ctx.agent_id ?? null,
    event_type: result.ok ? "tool_used" : "tool_failed",
    title: `${ctx.agent_name ?? ctx.agent_slug} ${result.ok ? "used" : "could not use"} ${tool.name}`,
    body: result.ok
      ? `${tool.provider} responded successfully.`
      : result.unavailable
        ? `${tool.provider} is not configured. ${result.error ?? ""}`
        : `${tool.provider} failed: ${result.error ?? "unknown"}`,
    metadata: {
      tool: tool.name,
      provider: tool.provider,
      tool_call_id: row?.id ?? null,
      status,
    },
  });

  return result;
}

/**
 * Translate a ToolResult into the ledger's outcome shape.
 *
 * COUNTS ARE ONLY REPORTED WHEN THEY ARE KNOWN. `raw` is the row count this call
 * actually returned; `normalized` and the gate counts belong to stages further
 * down and are deliberately left undefined here rather than guessed, because a
 * `0` would read as "checked and found none" instead of "not measured at this
 * layer".
 *
 * NEXT_DECISION IS ONLY EVER RELAYED, NEVER DERIVED. A provider call knows what
 * it returned; it does not know whether the workflow will continue, stop at
 * quota, or exhaust its budget — those are decided upstream, after this row is
 * already closed. So the field is written only when a caller that genuinely
 * knows one passes it as `audit_next_decision`, and stays NULL otherwise.
 * Inventing "completed" or "quota_satisfied" here would put a workflow-level
 * claim on a row that cannot support it.
 *
 * COST IS PRICED HERE, WITH ITS PROVENANCE. This said "Apify does not return a
 * charge on the run object we poll, so nothing here may claim
 * `provider_reported`. A per-actor price table can promote this later; until
 * then the row says estimated and `actual_cost_usd` stays null."
 *
 * Two claims, and neither survived being checked. The per-actor price table it
 * defers to already existed and was already verified — `hiringActorCatalog`'s
 * `cost_model`, with named per-event prices — and nothing consulted it. And the
 * row did NOT say "estimated": it said `unknown` on every one of the 118 rows
 * this table holds, because `cost: { source: "unknown" }` is hardcoded below.
 *
 * Whether Apify reports a charge is now a question the code asks rather than
 * one a comment answers: `provider_usage` carries the run document's own
 * figures out of the poller, `priceProviderCall` prefers them, and falls back
 * to the card table with `event_priced` when they are absent. The first live
 * run tells us which, and the ledger records it either way.
 */
/**
 * A Firecrawl cost, when the call stated one.
 *
 * EXPLICIT, not inferred from the result's shape. `execScrapeUrl` attaches
 * `firecrawl_cost` on every path Firecrawl actually charges for; a call that
 * produced no document attaches nothing, and returning null here lets the
 * Apify pricing stand for every other tool.
 *
 * Returns `unknown` rather than zero when no per-credit rate is configured:
 * "we spent nothing" and "we cannot price what we spent" are different answers,
 * and the ledger already carries a record of the one time they were merged —
 * 39 failed scrapes written as `event_priced` at $0.00.
 */
function firecrawlCost(d: Record<string, unknown>): ExecutionCost | null {
  const raw = d.firecrawl_cost as
    { credits?: unknown; basis?: unknown } | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  const credits = Number(raw.credits);
  if (!Number.isFinite(credits) || credits < 0) return null;
  const basis = raw.basis === "provider_reported_credits"
    ? "provider_reported_credits"
    : "published_rate";
  const priced = priceFirecrawlCall({ credits, basis: basis as FirecrawlCreditBasis });
  return {
    actual_usd: priced.actual_usd,
    estimated_usd: priced.estimated_usd,
    source: priced.source,
  };
}

/**
 * The actor input this call SENT — what its price depends on.
 *
 * A compiled invocation carries `compiled_actor_input: true` as a FLAG and the
 * payload under `input` (the passthrough above sends exactly that). Pricing
 * read `input.compiled_actor_input ?? input`, i.e. the boolean `true`, so a
 * mode-priced actor lost its mode: company search's `scraperMode: "full"` was
 * invisible, no per-row price applied, and the completion figure was the start
 * fee alone — $0.001 for runs Apify billed $0.009 (canary 6e4a93b9).
 */
export function sentActorInput(input: Record<string, unknown>): Record<string, unknown> {
  const inner = input.input;
  if (input.compiled_actor_input === true && inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return input;
}

function outcomeFromToolResult(
  r: ToolResult,
  input: Record<string, unknown>,
): ExecutionOutcome {
  const d = (r.data ?? {}) as Record<string, unknown>;
  const items = Array.isArray(d.items) ? d.items : null;
  const runId = typeof d.run_id === "string" ? d.run_id : null;
  const datasetId = typeof d.dataset_id === "string" ? d.dataset_id : null;
  const resumed = typeof input.resume_run_id === "string" && input.resume_run_id.length > 0;

  // Non-empty string only: an empty string or a non-string is "not known", not a
  // decision, and must not reach the row.
  const relayed = typeof input.audit_next_decision === "string" && input.audit_next_decision.trim()
    ? input.audit_next_decision.trim()
    : null;

  if (r.ok) {
    return {
      next_decision: relayed,
      // A resumed run is a real, distinct state: the rows arrived without a
      // second charge. Recording it as a plain success would make the ledger
      // overstate what was spent.
      status: resumed ? "reused" : "succeeded",
      provider_run_id: runId,
      dataset_id: datasetId,
      // EVERY STAGE THE ROWS PASSED THROUGH, not just the last one. These were
      // all NULL on every provider_call row in production, so "the provider
      // returned nothing" and "we read a third of it and dropped the rest" were
      // the same picture in the ledger.
      counts: (() => {
        const cl = (d.count_ledger ?? null) as
          { downloaded?: number; returned?: number } | null;
        const returned = items ? items.length : null;
        return {
          raw: cl?.downloaded ?? returned,
          normalized: returned,
          unique: returned,
          accepted: returned,
          rejected: cl && typeof cl.downloaded === "number" && typeof cl.returned === "number"
            ? Math.max(0, cl.downloaded - cl.returned)
            : null,
        };
      })(),
      // PRICED FROM WHAT THIS RUN ACTUALLY DID: its own row count, its own
      // input (short and full company rows are a 2x difference), and the
      // provider's usage figures when it sends any. `started: !resumed` keeps a
      // reused run from being charged a second start fee it never paid.
      // FIRECRAWL PRICES ITSELF, because it has no actor card to price from.
      // `priceProviderCall` resolves cost through `hiringActorCard(actorKey)`,
      // and a Firecrawl call arrives with no actor key at all — it matched no
      // card, fell through to `unknown`, and 214 successful scrapes recorded no
      // cost for three weeks. The call now states its own credit count and this
      // converts it, so the fall-through is no longer the only answer.
      cost: firecrawlCost(d) ?? priceProviderCall({
        actorKey: String(d.selected_actor_key ?? d.actor_id ?? ""),
        // BILLED rows, not returned rows: a funding actor's "not found" row is free.
        itemCount: billableResultCount(String(d.selected_actor_key ?? d.actor_id ?? ""), items),
        input: sentActorInput(input),
        run: (d.provider_usage ?? null) as ProviderRunUsage | null,
        started: !resumed,
        // THE POSITIVE SIGNAL. `resumed` is the only thing that knows this call
        // re-read a run another row already paid for.
        adopted: resumed === true,
      }),
      metadata: {
        actor_id: d.actor_id ?? null,
        build_id: d.build_id ?? null,
        build_number: d.build_number ?? null,
        no_results: d.no_results ?? null,
      },
    };
  }

  const code = String(r.error ?? "unknown_error");
  const pending = d.pending === true;
  return {
    next_decision: relayed,
    // A RUNNING Apify run is not a failure — it exists and is billable. Recorded
    // as timed_out so a later resume is visibly a resume, not a first attempt.
    status: /timeout|timed[-_ ]?out/i.test(code) || pending ? "timed_out" : "failed",
    provider_run_id: runId,
    dataset_id: datasetId,
    failure_code: code.split(":")[0],
    failure_message: code,
    // A FAILED CALL IS NOT A FREE CALL. An Actor that started and then timed out
    // has already been charged its start fee, and a run left RUNNING is
    // explicitly "billable" per the branch that returns it. Pricing it at zero
    // would let the expensive failures disappear from the run's economics.
    cost: firecrawlCost(d) ?? priceProviderCall({
      actorKey: String(d.selected_actor_key ?? d.actor_id ?? ""),
      // No rows arrived, so only the start charge applies.
      itemCount: 0,
      input: sentActorInput(input),
      run: (d.provider_usage ?? null) as ProviderRunUsage | null,
      started: runId !== null,
    }),
    metadata: { resumable: d.resumable ?? null, status: d.status ?? null },
  };
}

/**
 * Test seam for `outcomeFromToolResult`.
 *
 * Exported so the "never fabricate a decision" rule is provable without booting
 * the whole registry. The function itself stays module-private so no adapter can
 * reach around the one instrumented call site.
 */
export function outcomeFromToolResultForTest(
  r: ToolResult, input: Record<string, unknown>,
): ExecutionOutcome {
  return outcomeFromToolResult(r, input);
}

async function logToolCall(
  ctx: ToolContext,
  tool: ToolDef,
  input: unknown,
  result: ToolResult,
  status: string,
) {
  try {
    await ctx.admin.from("tool_calls").insert({
      workspace_id: ctx.workspace_id,
      plan_id: ctx.plan_id ?? null,
      task_id: ctx.task_id ?? null,
      agent_id: ctx.agent_id ?? null,
      tool_name: tool.name,
      provider: tool.provider,
      input_json: safeJson(input),
      output_json: safeJson(result.data ?? null),
      status,
      error: result.error ?? null,
      created_by: ctx.user_id ?? null,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[toolRegistry] logToolCall failed:", e);
  }
}

function safeJson(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return { _unserializable: true };
  }
}
