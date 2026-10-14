// EVIDENCE RUNNER (P2) — plan, fetch, extract, persist. Dependency-injected.
//
// The only module that spends. Everything it needs to reach the outside world
// arrives as a function, so the whole path is exercisable offline: the tests
// drive it with a fake fetcher and a fake model and assert on what it would
// have bought.
//
// ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
//
// It does not re-evaluate a company, touch the frontier, write a checkpoint,
// or change any qualification outcome. Those are P4 and P5. P2 collects
// evidence and stores it; nothing downstream reads it yet. That ordering is
// what makes this phase safe to run against a live mission: the worst case is
// pages bought and filed, never a decision changed by half-built machinery.
//
// ── THE BUDGET IS A CEILING, NOT A TARGET ──────────────────────────────────
//
// Three independent caps — companies per slice, pages per company, pages per
// run — because a single cap fails differently at each scale. A company with
// six plausible intents must not consume the run's whole allowance, and a pool
// of forty blocked candidates must not multiply into a hundred fetches.
//
// ── NOR IS IT A REASON TO OUTLIVE THE SLICE ────────────────────────────────
//
// `deps.stop` (`verificationStop.ts`) is asked before the planner, every
// `/map`, every page fetch and the extraction call. Once it answers, nothing
// new starts: the company being collected and every company after it are
// reported `stopped` — not an answer, so the caller leaves their claims open.
// Pages already fetched were written the moment they arrived, so the next
// slice reads them free. A fetch already in flight is NOT aborted: whether the
// provider bills an abandoned request is not something this code can know, and
// its page is worth more written than discarded.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { EvidenceRequestV1, PageIntent, WebEvidencePage } from "./evidenceRequest.ts";
import type { EvidenceDebt } from "./webEvidenceDebt.ts";
import {
  buildEvidencePlannerInput,
  DEFAULT_PLANNER_BUDGET,
  parseEvidencePlanStrict,
  type PlannerBudget,
} from "./webEvidencePlanner.ts";
import {
  buildExtractionInput,
  parseExtractionStrict,
} from "./webEvidenceExtraction.ts";
import {
  looksLikeMissingPage, resolvePages, resolvePagesFromMap, sameSite,
  type ResolvedPage,
} from "./pageIntentResolver.ts";
import { canonicalPageUrl, toStoredRows, writeWebEvidence } from "./webEvidenceStore.ts";
import { VERIFICATION_OPS } from "./verificationStop.ts";

/** Mapped URLs a `map` log line may carry, at most. */
export const MAP_LOG_SAMPLE = 12;

/** Up to `n` distinct mapped paths, in map order — enough to diagnose selection, never the whole map. */
export function mappedSample(mapped: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (const u of mapped) {
    if (out.length >= n) break;
    let path: string;
    try { path = new URL(u).pathname || "/"; } catch { continue; }
    if (!out.includes(path)) out.push(path);
  }
  return out;
}


export interface EvidenceRunBudget extends PlannerBudget {
  max_companies: number;
  /** Across the whole slice, all companies together. */
  max_pages_total: number;
}

export const DEFAULT_RUN_BUDGET: Readonly<EvidenceRunBudget> = Object.freeze({
  ...DEFAULT_PLANNER_BUDGET,
  max_companies: 5,
  max_pages_total: 30,
});

/** One page fetch. Implemented over the paid tool path by the caller. */
export type PageFetcher = (i: {
  url: string;
  request_id: string;
  company_key: string;
}) => Promise<{
  ok: boolean;
  /** Page text, when there is any. */
  markdown: string;
  /** The URL actually served, after redirects, when the provider reports one. */
  final_url?: string | null;
  status: "ok" | "empty" | "blocked" | "not_found" | "timeout";
  /** The provider's own HTTP status, when it reports one. Decides over the
   * content heuristic: a real 404 needs no guessing. */
  status_code?: number | null;
  provider_run_id?: string | null;
}>;

/**
 * Fresh pages already held for a site, keyed by page intent.
 *
 * THE CACHE READ THAT STOPS THE LOOP AT THE FETCH LAYER. The debt gate stops
 * the same company being re-raised; this stops the same PAGE being re-bought
 * when a different requirement, or a different mission, asks for it.
 */
export type CacheReader = (domain: string) => Promise<Map<string, CachedEntry>>;

/**
 * One cached page, KEYED BY ITS CANONICAL URL (`canonicalPageUrl`) — a page is
 * its URL, not its intent. The intent travels with it so held pages can still
 * be chosen for the intents a request asks for.
 */
export interface CachedEntry {
  source_url: string;
  source_text: string;
  fetched_at: string;
  /** ok | empty | blocked | not_found | timeout. Only `ok` may be cited. */
  status: string;
  page_intent?: string;
}

export interface EvidenceRunnerDeps {
  plan: (payload: Record<string, unknown>) => Promise<unknown>;
  /**
   * Optional. The legacy route extracts claims for its mission re-evaluation;
   * a claim verifier re-grounds the canonical claim from the stored pages
   * instead, so it collects without extracting (no model call).
   */
  extract?: ((payload: Record<string, unknown>) => Promise<unknown>) | null;
  fetchPage: PageFetcher;
  /**
   * Firecrawl `/map` for one domain: the URLs the site ACTUALLY exposes.
   *
   * Optional, and its absence preserves the old behaviour exactly — V1 callers
   * that do not pass it keep resolving intents against conventional paths. When
   * it IS passed, the conventional paths become matchers against real URLs and
   * nothing is fabricated.
   */
  mapSite?: ((i: { domain: string; company_key: string }) => Promise<string[]>) | null;
  /** Optional. Omitted, every page is bought — the pre-fix behaviour. */
  readCache?: CacheReader | null;
  db?: SupabaseClient | null;
  now?: () => string;
  log?: (event: string, meta: Record<string, unknown>) => void;
  /**
   * Optional. Non-null once no new external operation may start — the slice's
   * deadline, a cancellation, a lost lease (`verificationStopGate.check`).
   * Omitted, the runner never stops early: the previous behaviour.
   */
  stop?: ((op?: string | null) => { reason: string; detail: string } | null) | null;
  /**
   * Optional. The pages a `/map` this mission ALREADY BOUGHT selected for a
   * domain and intent set. A later collection for the same company — a slice
   * that stopped between the map and its pages, a re-grounding that failed —
   * recalls them instead of asking `/map` again: the ledger skips a repeated
   * map as already executed and returns nothing, which read as
   * `site_unavailable` and lost an answer this mission had paid for.
   * Omitted: every collection asks the map, as before.
   */
  mapMemory?: MapSelectionMemory | null;
}

/** What one bought map selected, kept for the mission (`EvidenceRunnerDeps.mapMemory`). */
export interface MapSelection {
  targets: ResolvedPage[];
  /** How many URLs the map returned — `site_unavailable` vs `no_useful_pages`. */
  mapped: number;
}

export interface MapSelectionMemory {
  recall(domain: string, intents: readonly string[]): MapSelection | null;
  remember(domain: string, intents: readonly string[], selection: MapSelection): void;
}

/**
 * A map memory over a plain record — the engine state's
 * `web_evidence_map_selections`, which the checkpoint carries between slices.
 * Keyed by domain and the sorted intent set: the selection is a function of
 * both. Holds only the selected pages (a handful per site), never the map.
 */
export function recordMapMemory(store: Record<string, MapSelection>): MapSelectionMemory {
  const key = (domain: string, intents: readonly string[]) =>
    `${domain.trim().toLowerCase()}|${[...intents].sort().join(",")}`;
  return {
    recall: (domain, intents) => {
      const s = store[key(domain, intents)];
      return s && Array.isArray(s.targets) && Number.isFinite(s.mapped) ? s : null;
    },
    remember: (domain, intents, selection) => {
      store[key(domain, intents)] = {
        targets: selection.targets.map((t) => ({ intent: t.intent, url: t.url })), mapped: selection.mapped,
      };
    },
  };
}

export interface CompanyEvidenceOutcome {
  company_key: string;
  company_name: string | null;
  domain: string;
  requirement_id: string;
  pages_fetched: number;
  /** Served from cache. Free: no fetch, no credit, no ledger row. */
  pages_reused: number;
  /** Known absent from a previous attempt. Not bought, not evidence. */
  pages_known_missing: number;
  pages_ok: number;
  claims_kept: number;
  claims_rejected: number;
  /** The reason nothing was collected, when nothing was. */
  outcome:
    | "collected"
    | "no_pages_planned"
    | "site_unavailable"
    | "no_useful_pages"
    | "budget_exhausted"
    /** Cut short by `deps.stop`: NOT an answer — the claim stays open. */
    | "stopped";
}

export interface EvidenceRunReport {
  planned: number;
  companies: CompanyEvidenceOutcome[];
  pages_fetched: number;
  pages_reused: number;
  pages_known_missing: number;
  claims_kept: number;
  claims_rejected: number;
  rows_written: number;
  store_error: string | null;
  /** Planner entries that were refused, by reason. */
  plan_rejections: Record<string, number>;
  /** Extraction claims that were refused, by reason. */
  claim_rejections: Record<string, number>;
  /** What stopped the run early (`deps.stop`), or null. */
  stopped: { reason: string; detail: string } | null;
}

const EMPTY_REPORT: EvidenceRunReport = {
  planned: 0,
  companies: [],
  pages_fetched: 0,
  pages_reused: 0,
  pages_known_missing: 0,
  claims_kept: 0,
  claims_rejected: 0,
  rows_written: 0,
  store_error: null,
  plan_rejections: {},
  claim_rejections: {},
  stopped: null,
};

/**
 * Collect web evidence for a set of debts.
 *
 * NEVER THROWS. Every failure resolves to a reported outcome, because this runs
 * inside a mission that was working before it was called and must still be
 * working after.
 */
/**
 * What the cache holds for ONE selected URL: its own row, looked up by
 * canonical URL, or nothing.
 *
 * This read the row of the URL's INTENT, so the entry for "about" answered
 * whichever URL the map selected as "about": production Fuse AI (task
 * 0553512c) skipped fuseai.com/company because fuseai.com/about had 404'd. A
 * different URL of the same intent is a different page: it answers nothing, and
 * the selected URL is fetched. (A usable page of that intent is still read —
 * as a held page, below — not as this URL's answer.)
 */
export function cachedPageFor<T extends CachedEntry>(cached: ReadonlyMap<string, T>, url: string): T | undefined {
  return cached.get(canonicalPageUrl(url));
}

/**
 * Fresh, usable pages held for the requested intents that the map did NOT
 * select — the newest per intent, never one the map also selected.
 */
export function heldPages<T extends CachedEntry>(
  cached: ReadonlyMap<string, T>, intents: readonly string[], selectedUrls: readonly string[],
): Array<{ intent: string; hit: T }> {
  const selected = new Set(selectedUrls.map(canonicalPageUrl));
  const out: Array<{ intent: string; hit: T }> = [];
  for (const intent of intents) {
    let best: T | undefined;
    for (const [key, e] of cached) {
      if (e.page_intent !== intent || selected.has(key)) continue;
      if (e.status !== "ok" || !e.source_text.trim()) continue;
      if (!best || e.fetched_at > best.fetched_at) best = e;
    }
    if (best) out.push({ intent, hit: best });
  }
  return out;
}

export async function runEvidenceCollection(i: {
  workspace_id: string;
  debts: readonly EvidenceDebt[];
  deps: EvidenceRunnerDeps;
  budget?: EvidenceRunBudget;
}): Promise<EvidenceRunReport> {
  const budget = i.budget ?? DEFAULT_RUN_BUDGET;
  const now = i.deps.now ?? (() => new Date().toISOString());
  const log = i.deps.log ?? (() => {});
  const debts = i.debts.slice(0, budget.max_companies);
  if (debts.length === 0) return { ...EMPTY_REPORT };

  const report: EvidenceRunReport = {
    ...EMPTY_REPORT,
    companies: [],
    plan_rejections: {},
    claim_rejections: {},
  };
  // ── MAY ANOTHER EXTERNAL OPERATION START? ─────────────────────────────────
  // Sticky once it says no; recorded on the report the first time.
  const halted = (op: string | null): boolean => {
    if (report.stopped) return true;
    const s = i.deps.stop?.(op) ?? null;
    if (!s) return false;
    report.stopped = s;
    log("evidence-stopped", { reason: s.reason, detail: s.detail });
    return true;
  };
  const stoppedOutcome = (d: EvidenceDebt, domain: string, requirementId: string): CompanyEvidenceOutcome => ({
    company_key: d.company_key, company_name: d.company_name, domain, requirement_id: requirementId,
    pages_fetched: 0, pages_reused: 0, pages_known_missing: 0, pages_ok: 0,
    claims_kept: 0, claims_rejected: 0, outcome: "stopped",
  });
  if (halted(VERIFICATION_OPS.model)) {
    for (const d of debts) report.companies.push(stoppedOutcome(d, d.domain, d.requirement_id));
    return report;
  }

  // ── ONE PLANNER CALL FOR THE WHOLE SLICE ──────────────────────────────────
  //
  // Batched deliberately: the planner reads a requirement and a list of
  // companies, and asking it once per company would multiply the cheapest part
  // of the loop by the size of the pool for no better answer.
  let requests: EvidenceRequestV1[] = [];
  try {
    const raw = await i.deps.plan(
      buildEvidencePlannerInput(debts) as unknown as Record<string, unknown>,
    );
    const parsed = parseEvidencePlanStrict(raw, debts, budget);
    requests = parsed.requests;
    for (const r of parsed.rejected) {
      report.plan_rejections[r.reason] = (report.plan_rejections[r.reason] ?? 0) + 1;
    }
  } catch (e) {
    log("evidence-plan-failed", { error: String(e) });
    return report;
  }
  report.planned = requests.length;

  // Companies the planner declined to plan for are reported, not researched.
  const plannedKeys = new Set(requests.map((r) => r.company_key));
  for (const d of debts) {
    if (plannedKeys.has(d.company_key)) continue;
    report.companies.push({
      company_key: d.company_key,
      company_name: d.company_name,
      domain: d.domain,
      requirement_id: d.requirement_id,
      pages_fetched: 0,
      pages_reused: 0,
      pages_known_missing: 0,
      pages_ok: 0,
      claims_kept: 0,
      claims_rejected: 0,
      outcome: "no_pages_planned",
    });
  }

  let pagesSpent = 0;

  for (const req of requests) {
    const debt = debts.find((d) => d.company_key === req.company_key)!;
    const outcome: CompanyEvidenceOutcome = {
      company_key: req.company_key,
      company_name: debt.company_name,
      domain: req.domain,
      requirement_id: req.requirement_id,
      pages_fetched: 0,
      pages_reused: 0,
      pages_known_missing: 0,
      pages_ok: 0,
      claims_kept: 0,
      claims_rejected: 0,
      outcome: "no_useful_pages",
    };

    if (pagesSpent >= budget.max_pages_total) {
      outcome.outcome = "budget_exhausted";
      report.companies.push(outcome);
      continue;
    }
    if (halted(null)) {
      outcome.outcome = "stopped";
      report.companies.push(outcome);
      continue;
    }

    const allowance = Math.min(
      req.max_pages,
      budget.max_pages,
      budget.max_pages_total - pagesSpent,
    );
    // ── DISCOVER, THEN SELECT — NEVER GUESS ──────────────────────────────
    //
    // Live run 3bc526e2 bought 12 pages from the conventional-path table and 7
    // were 404s; Studycast got no usable page at all, so its business model
    // could never be settled. One `/map` per domain replaces up to three
    // fabricated URLs with the ones the site really serves.
    //
    // A map that fails, returns nothing, or yields nothing useful leaves
    // `targets` empty and the company is reported `no_pages_planned` — the
    // claim stays PENDING. That is the honest answer, and it is NOT a FAIL.
    let targets: ResolvedPage[] = [];
    let mappedCount = 0;
    const recalled = i.deps.mapSite ? i.deps.mapMemory?.recall(req.domain, req.page_intents) ?? null : null;
    if (recalled) {
      // ALREADY MAPPED THIS MISSION: no purchase, the same selection.
      targets = recalled.targets.slice(0, allowance);
      mappedCount = recalled.mapped;
      log("map-recalled", { company: debt.company_name, domain: req.domain, mapped: mappedCount, selected: targets.map((t) => t.url) });
    } else if (i.deps.mapSite) {
      if (halted(VERIFICATION_OPS.map)) {
        outcome.outcome = "stopped";
        report.companies.push(outcome);
        continue;
      }
      const mapped = await i.deps.mapSite({ domain: req.domain, company_key: req.company_key })
        .catch(() => [] as string[]);
      mappedCount = Array.isArray(mapped) ? mapped.length : 0;
      targets = resolvePagesFromMap(req.domain, req.page_intents, mapped ?? [], allowance);
      // ── THE HOMEPAGE, WHEN NO PREFERRED PAGE EXISTS ────────────────────
      //
      // Canary 3be88a89: comfy.org mapped 120 URLs, none served product,
      // pricing, customers, docs or about, so nothing was read and ComfyUI's
      // business model stayed PENDING one claim short of qualifying. The site's
      // own root is the page most likely to say what the company sells and to
      // whom. Fallback ONLY: preferred pages win whenever one matches; the root
      // must be same-site (it is resolved from the same mapped, same-site,
      // non-excluded URLs); and it is one page inside the existing allowance.
      let homepageFallback = false;
      if (targets.length === 0 && mappedCount > 0 && allowance > 0 && !req.page_intents.includes("homepage")) {
        targets = resolvePagesFromMap(req.domain, ["homepage"], mapped ?? [], 1);
        homepageFallback = targets.length > 0;
      }
      log("map", {
        company: debt.company_name, domain: req.domain,
        mapped: mappedCount, selected: targets.map((t) => t.url), homepage_fallback: homepageFallback,
        // A bounded sample for diagnosis — never the whole map.
        mapped_sample: mappedSample(mapped ?? [], MAP_LOG_SAMPLE),
      });
      // Only a map that ANSWERED is remembered: an empty reply may be the
      // ledger's idempotent skip, which is not what the site serves.
      if (mappedCount > 0) i.deps.mapMemory?.remember(req.domain, req.page_intents, { targets, mapped: mappedCount });
    } else {
      // V1 / Company Brain callers: unchanged.
      targets = resolvePages(req.domain, req.page_intents, allowance);
    }
    // ── WHAT WE ALREADY HAVE, BEFORE WE BUY ANYTHING ──────────────────────
    //
    // Read BEFORE deciding there is nothing to do: a map that selects nothing
    // (or selects other pages) does not make a page we already hold disappear.
    let cached = new Map<string, CachedEntry>();
    if (i.deps.readCache) {
      try {
        cached = await i.deps.readCache(req.domain);
      } catch (e) {
        // A cache that cannot be read degrades to buying, never to failing.
        log("evidence-cache-read-failed", { domain: req.domain, error: String(e) });
      }
    }

    // ── PAGES WE HOLD FOR INTENTS THE MAP DID NOT SELECT ──────────────────
    //
    // Production Fuse AI (task 0553512c, 2026-09-27): this run's map (118
    // URLs) did not surface /pricing, so the fresh /pricing page cached eleven
    // days earlier — the page the previous run was grounded on — was never
    // counted, `pages_ok` was 0, and the claim was never re-read. Firecrawl's
    // map varies between calls; what we already hold should not. A held page is
    // free: no fetch, no credit, no ledger row.
    //
    // Chosen by intent, identified by URL: the newest fresh usable page of each
    // requested intent, unless the map selected that very URL (it is then read
    // once, below). A map selecting /pricing-2 does not hide a held /pricing.
    const held = heldPages(cached, req.page_intents, targets.map((t) => t.url));

    if (targets.length === 0 && held.length === 0) {
      // The existing vocabulary already distinguishes these: a map that
      // returned nothing means the site did not answer; a map that returned
      // URLs none of which serve the intents means nothing useful is there.
      outcome.outcome = !i.deps.mapSite
        ? "no_pages_planned"
        : mappedCount === 0
        ? "site_unavailable"
        : "no_useful_pages";
      report.companies.push(outcome);
      continue;
    }

    const pages: WebEvidencePage[] = [];

    for (const { intent, hit } of held) {
      outcome.pages_reused++;
      report.pages_reused++;
      outcome.pages_ok++;
      pages.push({ url: hit.source_url, intent: intent as PageIntent, markdown: hit.source_text, fetched_at: hit.fetched_at, status: "ok" });
      log("evidence-cache-held", { company: debt.company_name, url: hit.source_url, intent });
    }

    for (const t of targets) {
      const hit = cachedPageFor(cached, t.url);
      if (!hit) {
        const sameIntent = [...cached.values()].filter((e) => e.page_intent === t.intent);
        if (sameIntent.length > 0) {
          log("evidence-cache-other-url", {
            company: debt.company_name, url: t.url, intent: t.intent,
            cached: sameIntent.map((e) => `${e.source_url} (${e.status})`),
          });
        }
      }
      if (hit) {
        // ── A KNOWN-ABSENT PAGE IS AN ANSWER, AND IT IS FREE ───────────────
        //
        // "We asked and it is not there" is as good a reason not to spend as a
        // successful fetch. Filtering these out of the cache is what made run
        // d3a79c32 buy diligencevault.com 16 times for 4 URLs.
        //
        // It is NOT evidence: no text, never shown to the extractor, and it
        // cannot make a company look investigated when nothing was learned.
        if (hit.status !== "ok" || !hit.source_text.trim()) {
          outcome.pages_known_missing++;
          report.pages_known_missing++;
          pages.push({
            url: hit.source_url,
            intent: t.intent,
            markdown: "",
            fetched_at: hit.fetched_at,
            // Narrowed against the vocabulary rather than cast: a status the
            // table somehow holds outside it becomes `empty`, which is the
            // conservative reading — we asked, we got nothing usable.
            status: (["empty", "blocked", "not_found", "timeout"] as const)
                .includes(hit.status as "empty" | "blocked" | "not_found" | "timeout")
              ? hit.status as "empty" | "blocked" | "not_found" | "timeout"
              : "empty",
          });
          log("evidence-cache-known-missing", {
            company: debt.company_name, url: hit.source_url,
            intent: t.intent, status: hit.status,
          });
          continue;
        }
        // FREE. No fetch, no credit, no ledger row. Counted separately from
        // `pages_fetched` so the telemetry cannot make reuse look like spend.
        outcome.pages_reused++;
        report.pages_reused++;
        pages.push({
          url: hit.source_url,
          intent: t.intent,
          markdown: hit.source_text,
          fetched_at: hit.fetched_at,
          status: "ok",
        });
        outcome.pages_ok++;
        log("evidence-cache-hit", {
          company: debt.company_name, url: hit.source_url, intent: t.intent,
        });
        continue;
      }

      // ── A PURCHASE: ASK FIRST ──────────────────────────────────────────
      if (halted(VERIFICATION_OPS.page)) {
        outcome.outcome = "stopped";
        break;
      }
      let res;
      try {
        res = await i.deps.fetchPage({
          url: t.url,
          request_id: req.request_id,
          company_key: req.company_key,
        });
      } catch (e) {
        log("evidence-fetch-threw", { url: t.url, error: String(e) });
        res = { ok: false, markdown: "", status: "timeout" as const };
      }
      pagesSpent++;
      outcome.pages_fetched++;
      report.pages_fetched++;

      // ── THE REDIRECT GUARD ────────────────────────────────────────────
      //
      // A page that redirected off the company's own registrable domain is
      // not that company's page, whatever it says. Recorded as `blocked` so
      // the attempt is visible, and its text is discarded rather than read.
      const served = res.final_url ?? t.url;
      const offSite = !sameSite(req.domain, served);

      // ── A 200 THAT SAYS "NOT FOUND" IS NOT A PAGE ──────────────────────
      //
      // Sites answer 200 with a not-found body; run 40295080 stored three of
      // them as `ok`. Harmless while every slice re-fetched — durable false
      // evidence now that the cache is read.
      const missing = !offSite && res.ok &&
        looksLikeMissingPage(res.markdown, res.status_code);
      const status = offSite ? "blocked" : missing ? "not_found" : res.status;
      const usable = status === "ok" && !offSite && res.markdown.trim().length > 0;

      const fetched: WebEvidencePage = {
        url: t.url,
        intent: t.intent,
        markdown: usable ? res.markdown : "",
        fetched_at: now(),
        status,
      };
      pages.push(fetched);
      if (usable) outcome.pages_ok++;

      // ── PERSIST BEFORE THE NEXT FETCH, NOT AT THE END ──────────────────
      //
      // The write was batched once per company, after every page. A slice that
      // hit its deadline in between bought pages and lost them, and the next
      // slice bought them again because the cache had nothing to say.
      //
      // Lineage b1348724, `pump.co/about`, verbatim:
      //
      //     16:58:00  call started    -> never finalized, no row
      //     18:35:09  call succeeded  -> no row
      //     18:47:13  call succeeded  -> row written 18:47:16
      //
      // Three purchases of one page; 24 calls for 17 URLs across that run.
      //
      // This is the same interruption that leaves `status: started` rows in the
      // ledger — which I diagnosed as observability-only because they hold no
      // credits and block no sweeper. True, and incomplete: the same death also
      // loses the PAGE, and a lost page is a guaranteed re-buy.
      //
      // One page, one write, before anything else can be interrupted.
      if (i.deps.db) {
        const w = await writeWebEvidence(
          i.deps.db,
          toStoredRows({
            workspace_id: i.workspace_id,
            company_key: req.company_key,
            domain: req.domain,
            requirement_id: req.requirement_id,
            provider_run_id: res.provider_run_id ?? null,
            // Including the pages that are not there: "we asked and it is
            // absent" is what stops the next slice asking again.
            pages: [fetched],
          }),
        );
        report.rows_written += w.written;
        if (w.error) report.store_error = w.error;
      }

      log("evidence-fetch", {
        company: debt.company_name, url: t.url, intent: t.intent,
        status, off_site: offSite, missing_page: missing,
        chars: res.markdown.length,
      });

      if (pagesSpent >= budget.max_pages_total) break;
    }

    // CUT SHORT: whatever was collected is cached; the company is not answered,
    // and no extraction call starts.
    if (outcome.outcome === "stopped" || (outcome.pages_ok > 0 && i.deps.extract && halted(VERIFICATION_OPS.model))) {
      outcome.outcome = "stopped";
    } else if (outcome.pages_ok === 0) {
    // Nothing readable came back. `site_unavailable` and `no_useful_pages` are
    // both ANSWERS — they resolve to insufficient_evidence downstream, never to
    // a failed requirement.
      outcome.outcome = pages.every((p) =>
          p.status === "timeout" || p.status === "not_found" || p.status === "blocked"
        )
        ? "site_unavailable"
        : "no_useful_pages";
    } else if (!i.deps.extract) {
      // Collected and stored; the caller re-reads them.
      outcome.outcome = "collected";
    } else {
      try {
        const raw = await i.deps.extract(
          buildExtractionInput({
            question: req.research_question,
            company_name: debt.company_name,
            pages,
          }) as unknown as Record<string, unknown>,
        );
        const parsed = parseExtractionStrict(raw, {
          company_key: req.company_key,
          requirement_id: req.requirement_id,
          pages,
        });
        outcome.claims_kept = parsed.claims.length;
        outcome.claims_rejected = parsed.rejected.length;
        report.claims_kept += parsed.claims.length;
        report.claims_rejected += parsed.rejected.length;
        for (const r of parsed.rejected) {
          report.claim_rejections[r.reason] =
            (report.claim_rejections[r.reason] ?? 0) + 1;
        }
        outcome.outcome = parsed.claims.length > 0 ? "collected" : "no_useful_pages";
        log("evidence-claims", {
          company: debt.company_name,
          kept: parsed.claims.length,
          rejected: parsed.rejected.length,
          reasons: parsed.rejected.map((r) => r.reason),
        });
      } catch (e) {
        log("evidence-extract-failed", {
          company: debt.company_name, error: String(e),
        });
        outcome.outcome = "no_useful_pages";
      }
    }

    // Nothing to persist here: every page was written the moment it was
    // fetched, above. Batching to the end of the company is precisely where a
    // deadline lands, and what turned interrupted slices into repeat purchases.

    report.companies.push(outcome);
  }

  return report;
}
