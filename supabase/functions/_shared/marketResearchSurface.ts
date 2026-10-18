// A QUESTION ABOUT A MARKET, NOT ABOUT A COMPANY.
//
// ── WHAT THE VOCABULARY WAS MISSING ────────────────────────────────────────
//
// "What's happening in the AI recruiting space?" names no company and no page.
// It is `research` — a fresh look — but its subject is a category, a topic, a
// problem space. `REQUEST_ENTITIES` had no word for that, so the request had
// nowhere to land except the lead pipeline, which would have tried to find
// companies matching a topic nobody asked to source.
//
// The word already existed elsewhere in this codebase: `signal_events.subject_type`
// is `competitor | company | market`, and `market` is documented there as "a
// category, topic or problem space rather than an organisation". The semantic
// vocabulary was simply describing less than the persisted one. Adding it aligns
// the two rather than inventing a third.
//
// ── AND WHY AVAILABILITY IS ASKED, NOT INFERRED ────────────────────────────
//
// pilot-chat decided this surface was degraded by testing
// `!decision.selected_actor_key` — a field the classifier deliberately left
// unset so that `validateAgainstCapabilities` could clear or fill it. Three
// components had to agree on the meaning of one null for the user to get an
// honest answer, and the question underneath it was never semantic at all: is
// web search configured in this deployment?
//
// `webSearchAvailable` asks that directly. It is the single definition — the
// validator imports it rather than keeping its own copy — so the answer cannot
// differ between the component that decides and the component that explains.
//
// Pure apart from the env reader, which is injected.

import type { RequestV1, RequestPart } from "./requestV1.ts";
import { resolveWebSearch } from "./parallelSearch.ts";

export const MARKET_RESEARCH_VERSION = "market-research-surface-v1" as const;

export type EnvReader = (key: string) => string | undefined;

const defaultReadEnv: EnvReader = (k) => {
  try { return Deno.env.get(k); } catch { return undefined; }
};

/**
 * Anonymous Parallel search is available on an unconfigured installation.
 * Explicit disable settings and configured provider choices still win.
 */
export function webSearchAvailable(readEnv: EnvReader = defaultReadEnv): boolean {
  return resolveWebSearch(readEnv) === "parallel";
}

export interface MarketResearchPlan {
  version: typeof MARKET_RESEARCH_VERSION;
  /** The topic, in the user's own words. Null when the request named none. */
  topic: string | null;
  part_id: string | null;
}

/** What would this request research? Pure and total. */
export function planMarketResearch(request: RequestV1): MarketResearchPlan {
  const base = { version: MARKET_RESEARCH_VERSION };
  const part: RequestPart | undefined = request.parts.find(
    (p) => p.objective === "research" && p.subject.entity === "market");
  if (!part) return { ...base, topic: null, part_id: null };

  // The topic is what the user said. A market has no identifier to resolve and
  // no registry to look it up in, so their words ARE the subject — narrowing
  // them to a keyword list here would answer a smaller question than was asked.
  const named = (part.subject.references ?? [])
    .map((r) => (r.value ?? "").trim()).filter(Boolean);
  return {
    ...base,
    topic: named.length > 0 ? named.join(", ") : request.utterance,
    part_id: part.id,
  };
}

/**
 * What to say when the capability is absent.
 *
 * ONE COPY. The same sentence is reached from the route and from the legacy
 * category branch, so a user cannot get two different explanations of the same
 * missing key depending on which path read their message.
 */
export const SEARCH_WEB_UNAVAILABLE =
  "Broad live web search isn't configured in this workspace, so I can't pull current market or competitor news on demand. What I can do: analyze a specific URL with Hawk + Firecrawl (paste the link), or collect structured signals with Scout + Apify (e.g. \"find companies hiring AI engineers in the US\"). Which would help most?";
