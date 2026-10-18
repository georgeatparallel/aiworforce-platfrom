// Canonical, deterministic tool-selection contract for Find Leads sourcing.
// Pure (imports only leadIntake). One place decides (a) WHICH tool a plan step
// runs and (b) for a provider-sourcing step, WHICH source/actor — so a founder
// request can never silently run a jobs scraper, and body.tool_needed is honoured.
//
// Root causes it closes:
//  - run-agent recognized Apify sourcing only from tool_input.tool_name /
//    selected_actor_key and ignored body.tool_needed (the plan step's tool).
//  - the sourcing layer's normalizeApifySourceType() collapses "founders"/"people"
//    to the JOBS source type, so a person request ran a jobs scraper.

import { extractLeadDetails } from "./leadIntake.ts";

// --------------------------------------------------------------- tool resolver --

export type PlannedToolKind = "source_with_apify" | "scrape_url" | "search_web" | "generic";

export interface PlannedToolSignals {
  /** body.tool_needed threaded by orchestrate from the plan step (highest precedence). */
  tool_needed?: string | null;
  /** the plan step's own tool_needed (when run-agent reads the plan directly). */
  plan_step_tool_needed?: string | null;
  /** tool_input.tool_name (staged plans). */
  tool_name?: string | null;
  /** tool_input.selected_actor_key (actor routing). */
  selected_actor_key?: string | null;
}

export type ToolMatchSource =
  | "tool_needed" | "plan_step_tool_needed" | "tool_name" | "selected_actor_key" | "none";

export interface ResolvedTool {
  tool: PlannedToolKind;
  matched_from: ToolMatchSource;
}

const s = (v: unknown) => (v ?? "").toString().trim().toLowerCase();

/** Classify a single raw tool string / actor key into a tool kind (or null). */
function kindOf(raw: string): PlannedToolKind | null {
  if (raw === "source_with_apify") return "source_with_apify";
  if (raw === "search_web") return "search_web";
  if (raw === "scrape_url" || raw === "firecrawl_scrape_url") return "scrape_url";
  if (raw.startsWith("apify_")) return "source_with_apify";
  if (raw === "research_web" || raw === "summarize_text" || raw === "extract_structured") return "generic";
  return null;
}

/**
 * Deterministic tool resolution with an explicit precedence:
 *   1. body.tool_needed        (orchestrate threaded the plan step's tool)
 *   2. plan-step tool_needed    (run-agent reading the plan directly)
 *   3. tool_input.tool_name     (staged plans)
 *   4. tool_input.selected_actor_key (apify_* / firecrawl actor keys)
 * The free-text instruction is deliberately NOT consulted here: when the plan has
 * explicitly selected a tool, that selection must win.
 */
export function resolvePlannedTool(sig: PlannedToolSignals | null | undefined): ResolvedTool {
  const ordered: Array<[ToolMatchSource, string]> = [
    ["tool_needed", s(sig?.tool_needed)],
    ["plan_step_tool_needed", s(sig?.plan_step_tool_needed)],
    ["tool_name", s(sig?.tool_name)],
    ["selected_actor_key", s(sig?.selected_actor_key)],
  ];
  for (const [from, raw] of ordered) {
    if (!raw) continue;
    const kind = kindOf(raw);
    if (kind) return { tool: kind, matched_from: from };
  }
  return { tool: "generic", matched_from: "none" };
}

/** True when the resolved plan step is Find Leads provider identity sourcing. */
export function isProviderSourcingTool(sig: PlannedToolSignals | null | undefined): boolean {
  return resolvePlannedTool(sig).tool === "source_with_apify";
}

// ------------------------------------------------------- source/actor selection --

export type ProviderSourceKind = "people" | "jobs" | "company" | "engagement";

export interface ResolvedSource {
  source_type: string;
  actor_key: string;
  kind: ProviderSourceKind;
}

// Deterministic mode → (source_type, actor) map. Mirrors the leadIntake source
// routing (people_profiles→apify_people_search, hiring→apify_jobs, …) so a person
// request selects the people actor and only real hiring asks select jobs.
const MODE_TO_SOURCE: Record<string, ResolvedSource> = {
  people: { source_type: "people_profiles", actor_key: "apify_people_search", kind: "people" },
  hiring: { source_type: "hiring_signal", actor_key: "apify_jobs", kind: "jobs" },
  companies: { source_type: "company_search", actor_key: "apify_jobs", kind: "company" },
  competitor_engagement: { source_type: "competitor_engagement", actor_key: "apify_linkedin_posts", kind: "engagement" },
  signals: { source_type: "linkedin_posts", actor_key: "apify_linkedin_posts", kind: "engagement" },
};

// Person asks leadIntake's PEOPLE_HINT doesn't cover (decision-makers / buying
// committee) are still people search — never jobs.
const DECISION_MAKER_RE = /\b(decision[-\s]?makers?|buying committee|dm\b|dms\b)\b/i;

/**
 * Deterministic source/actor selection for a Find Leads provider-sourcing step
 * whose planner did NOT pin an explicit source_type/actor. Returns null when the
 * intent is genuinely ambiguous (the caller keeps its existing default) — this
 * only OVERRIDES the clear cases, so it never silently widens behavior.
 *
 * Founder/person/decision-maker → people search; hiring/job-opening → jobs;
 * company-only → company search; engagement/commenter → linkedin posts.
 * The Company Brain is never consulted here, so buying signals cannot convert a
 * person-search request into a jobs-search request.
 */
export function resolveProviderSource(instruction: string | null | undefined): ResolvedSource | null {
  const msg = (instruction ?? "").toString();
  if (!msg.trim()) return null;
  if (DECISION_MAKER_RE.test(msg)) return MODE_TO_SOURCE.people;
  const mode = extractLeadDetails(msg).mode;
  if (mode && MODE_TO_SOURCE[mode]) return MODE_TO_SOURCE[mode];
  return null;
}
