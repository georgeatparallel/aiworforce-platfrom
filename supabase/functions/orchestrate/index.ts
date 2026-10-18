// orchestrate: plan a multi-agent workflow and kick off the first step.
// Workflow-aware: produces deep plans (sourcing, research, intel, outreach,
// content, screening, brief) with tool + approval metadata, then deterministic
// expansion to guarantee depth. Tool availability is annotated, never faked.

import { withBuildStamp } from "../_shared/buildStamp.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createCanonicalContentItem, type ContentDb,
} from "../_shared/contentOperations.ts";
import { routeQualifiedLead, qualifiedLeadRouteFromMission } from "../_shared/qualifiedLeadRouting.ts";
import { invokeInBackground, describeFailure } from "../_shared/backgroundInvoke.ts";
import {
  planQualifiedLeadBeforePersistence, buildOrchestrateResponsePlan,
} from "../_shared/intelligence/leads/leadPlanOrchestration.ts";
import { generateJson, logProviderCall } from "../_shared/aiProvider.ts";
import { isToolConfigured } from "../_shared/toolRegistry.ts";
import { getAgentorySystemPrompt, AGENTORY_SYSTEM_PROMPT_VERSION } from "../_shared/agentorySystemPrompt.ts";
import { summarizeRegistryForPrompt } from "../_shared/actorRegistry.ts";
import { buildDraftOutreachPlan } from "../_shared/draftOutreachPlan.ts";
import { buildCompetitorDiscoveryPlan } from "../_shared/competitorDiscovery.ts";
import { extractContentLoopInput, buildContentLoopPlan } from "../_shared/contentEngagementLoop.ts";
import { separatedIntentFromMission } from "../_shared/leadIntentModel.ts";
import { filterPlanForMode, isSourceAndQualifyOnly } from "../_shared/executionMode.ts";
import {
  isLeadMissionV1, parseLeadMissionDeterministic,
  effectiveRequestedCount, DEFAULT_REQUESTED_COUNT,
} from "../_shared/leadMission.ts";
import { buildCapabilityGraph, type CapabilityPlan } from "../_shared/leadCapabilityGraph.ts";
import { ModelCallCollector, createLedgerWriter } from "../_shared/executionLedger.ts";
import { resolveLeadExecutionEngine } from "../_shared/leadExecutionEngine.ts";
import { executabilityGateFor } from "../_shared/capabilityExecutability.ts";
import { readinessPolicyFor } from "../_shared/routeReadiness.ts";
import { deriveMissionCriteria } from "../_shared/missionCriteria.ts";
import {
  defaultScreenRunBudget, kickoffRunBudget, screenDownstreamVerifiersUsd, type DefaultScreenBudget,
} from "../_shared/fundingScreenDefaults.ts";
import { validateV2KickoffBody } from "../_shared/leadMissionV2Request.ts";
import {
  resolveRunBudget, authorizeModelSpend, resolveSpendEnforcement, resolveCeiling, spendRefusalMessage,
  describeSpend, MODEL_SPEND_REFUSED, type SpendDb,
} from "../_shared/modelSpendCeiling.ts";
import {
  getLeadIntelligenceCapabilities,
} from "../_shared/leadIntelligencePolicy.ts";
import { functionUrl } from "../_shared/functionEndpoints.ts";
import { parseRunBudget } from "../_shared/runBudget.ts";
import { resolveCreditEnforcement } from "../_shared/creditAuthorization.ts";
import {
  BETA_ACCESS_MESSAGE, CREDITS_REQUIRED, creditStartGate, startBuysProviderData,
} from "../_shared/creditStartGate.ts";
import {
  duplicateStartBody, findStartedPlan, isStartIdempotencyKey,
} from "../_shared/startIdempotency.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// ---------- Types ----------

// A LOCAL COPY OF THE REGISTRY'S TOOL NAMES, and it had drifted.
//
// `search_web` — broad grounded web search, backed by Parallel MCP — is a real
// registered tool (`toolRegistry.ts`) and a member of the planner's own
// `ToolName` in `toolInputPlanner.ts`. It was missing here, so two call sites
// that correctly select it produced a step whose `tool_needed` did not
// typecheck: the "intelligence" plan's non-hiring branch, and the live-pulse
// step that explicitly prefers it over Perplexity when configured.
//
// The type was wrong, not the code — which is why the fix is to admit the tool
// rather than to rewrite the selection as `research_web` and silently downgrade
// every broad-research step to the optional fallback.
type ToolName =
  | "research_web"
  | "search_web"
  | "scrape_url"
  | "source_with_apify"
  | "summarize_text"
  | "extract_structured"
  | "draft_outreach"
  | "send_email"
  | null;

type Step = {
  step_index: number;
  agent_slug: "scout" | "aria" | "penn" | "hawk" | "scribe";
  agent_name: string;
  task_title: string;
  task_description: string;
  instruction: string; // back-compat for run-agent
  capability?: string;
  tool_needed: ToolName;
  expected_output: string;
  success_criteria: string;
  requires_approval: boolean;
  needs_approval: boolean; // alias
  /**
   * Who wrote this step.
   *
   * `capability_graph` means NO planner was consulted: the step was derived
   * from `buildCapabilityGraph(mission)` — the same graph Stage 1 previewed
   * and the engine executes. It is the only source that cannot disagree with
   * the mission, and reading it on a persisted plan is how you tell an
   * approved run from a re-planned one.
   */
  planner_source: "ai" | "fallback" | "expansion" | "capability_graph";
  tool_status?: "ready" | "connector_required";
  connector_required?: string;
};

type Intent =
  | "sourcing"
  | "extraction"
  | "intelligence"
  | "outreach"
  | "content"
  | "screening"
  | "brief"
  | "general";

const KNOWN_AGENTS: Record<string, string> = {
  scout: "Scout",
  aria: "Aria",
  penn: "Penn",
  hawk: "Hawk",
  scribe: "Scribe",
};

// Human-readable, tool-aware limitation messages keyed by tool name.
// We emit these directly into connectors_missing so the UI never shows raw
// env names or surfaces Perplexity for plans that don't actually need it.
const TOOL_LIMITATION_MESSAGE: Record<string, string> = {
  source_with_apify: "Apify token missing — hiring-signal sourcing unavailable.",
  scrape_url: "Firecrawl missing — page extraction unavailable.",
  search_web: "Broad web search is not configured. Use Apify for hiring signals or Firecrawl for specific URLs.",
  // RETIRED, not unconfigured. The key is still set in production, so "not
  // configured" would be a lie that invites someone to "fix" it by checking
  // the env. There is no executor behind this name any more.
  research_web: "Web research via Perplexity has been retired — use scrape_url for a specific URL, or source_with_apify for hiring and company signals.",
  send_email: "Resend missing — outreach can be drafted but not sent.",
};


function normalizeSlug(s: string | undefined | null): Step["agent_slug"] | null {
  if (!s) return null;
  const slug = String(s).trim().toLowerCase();
  return (KNOWN_AGENTS[slug] ? slug : null) as Step["agent_slug"] | null;
}

function detectIntent(t: string): Intent {
  const s = t.toLowerCase();
  if (/brief me|daily brief|today's brief|brief on today/.test(s)) return "brief";
  if (/https?:\/\//.test(s) || /from this (url|website|page|link)/.test(s)) return "extraction";
  if (/(competitor|market|signals?|today|latest|monitor|changed|funding|hiring trend|pricing|launches?)/.test(s))
    return "intelligence";
  if (/(find|source|sourc(?:e|ing)|discover|identify|candidates?|engineers?|developers?|leads?|prospects?|founders?|companies)/.test(s))
    return "sourcing";
  if (/(rank|screen|score|shortlist|evaluate|compare|fit)/.test(s)) return "screening";
  if (/(outreach|email|message|dm|reach out|follow.?up|sequence|\bsend\b)/.test(s)) return "outreach";
  if (/(write|post|linkedin|blog|article|jd|job description|brief|memo|report|summary)/.test(s)) return "content";
  return "general";
}

// ---------- Step factory ----------

function mkStep(
  step_index: number,
  slug: Step["agent_slug"],
  title: string,
  description: string,
  opts: {
    tool_needed?: ToolName;
    expected_output: string;
    success_criteria: string;
    requires_approval?: boolean;
    planner_source?: Step["planner_source"];
  },
): Step {
  const requires_approval = opts.requires_approval === true;
  return {
    step_index,
    agent_slug: slug,
    agent_name: KNOWN_AGENTS[slug],
    task_title: title,
    task_description: description,
    instruction: description,
    tool_needed: opts.tool_needed ?? null,
    expected_output: opts.expected_output,
    success_criteria: opts.success_criteria,
    requires_approval,
    needs_approval: requires_approval,
    planner_source: opts.planner_source ?? "fallback",
  };
}

// ---------- Deterministic fallback plans per intent ----------

function fallbackPlan(instruction: string, intent: Intent): { plan_summary: string; steps: Step[] } {
  switch (intent) {
    case "sourcing":
      return {
        plan_summary: `Source, rank, and prepare outreach for: ${instruction}`,
        steps: [
          mkStep(0, "scout", "Source companies/leads via Apify", `Find companies/leads matching: ${instruction}`, {
            tool_needed: "source_with_apify",
            expected_output: "List of sourced leads (name, company, title, url, location) with Apify run/dataset reference.",
            success_criteria: "Apify actor returns at least a few candidate results, or surfaces a clear actor-not-configured message.",
          }),
          mkStep(1, "aria", "Rank candidates", `Rank and score the sourced candidates against: ${instruction}`, {
            tool_needed: "extract_structured",
            expected_output: "Ranked list with fit score (0-100) and rationale per candidate.",
            success_criteria: "Every candidate has a score and 1-2 sentence rationale.",
          }),
          mkStep(2, "penn", "Draft outreach", `Draft personalized outreach for the strongest candidates from: ${instruction}`, {
            tool_needed: "draft_outreach",
            requires_approval: true,
            expected_output: "Personalized message per top candidate, ready for review.",
            success_criteria: "Each message references the candidate's background; no auto-send.",
          }),
        ],
      };
    case "extraction":
      return {
        plan_summary: `Extract structured data: ${instruction}`,
        steps: [
          mkStep(0, "hawk", "Scrape source", `Scrape and extract from: ${instruction}`, {
            tool_needed: "scrape_url",
            expected_output: "Raw extracted content (markdown) from the target URL.",
            success_criteria: "Page successfully fetched; content non-empty.",
          }),
          mkStep(1, "scribe", "Summarize findings", `Summarize the extracted content into a brief for: ${instruction}`, {
            tool_needed: "summarize_text",
            expected_output: "Concise brief with key signals, bullets, and source citation.",
            success_criteria: "Brief is grounded in scraped content, no fabrication.",
          }),
        ],
      };
    case "intelligence": {
      const sLower = instruction.toLowerCase();
      const hiringShape = /(hiring|jobs?|roles?|companies?|recruit|engineers?|marketers?|developers?|leads?|founders?)/.test(sLower);
      const hawkTool = hiringShape ? "source_with_apify" : "search_web";
      return {
        plan_summary: `Gather intelligence: ${instruction}`,
        steps: [
          mkStep(0, "hawk", hiringShape ? "Source hiring/company signals" : "Research signals", `Investigate: ${instruction}`, {
            tool_needed: hawkTool,
            expected_output: hiringShape
              ? "List of companies/roles with source URLs and metadata from Apify."
              : "Cited list of recent signals (funding, hiring, launches, pricing).",
            success_criteria: hiringShape
              ? "Apify returns results or clearly reports unavailable."
              : "At least 3 cited signals, or a clear unavailable note.",
          }),
          mkStep(1, "scribe", "Brief summary", `Turn findings into a short intel brief for: ${instruction}`, {
            tool_needed: "summarize_text",
            expected_output: "1-page intel brief with bullets and recommended next action.",
            success_criteria: "Brief references only findings above.",
          }),
        ],
      };
    }
    case "outreach": {
      const wantsSend = /\bsend\b|send.*email/.test(instruction.toLowerCase());
      const steps: Step[] = [
        mkStep(0, "penn", "Draft outreach", `Draft personalized outreach: ${instruction}`, {
          tool_needed: "draft_outreach",
          requires_approval: true,
          expected_output: "Personalized draft(s) ready for human review.",
          success_criteria: "Draft references recipient context; no auto-send.",
        }),
      ];
      if (wantsSend) {
        steps.push(
          mkStep(1, "penn", "Send after approval", `Send the approved outreach for: ${instruction}`, {
            tool_needed: "send_email",
            requires_approval: true,
            expected_output: "Delivery confirmation from the email provider.",
            success_criteria: "Email sent only after explicit approval.",
          }),
        );
      }
      return { plan_summary: `Outreach workflow: ${instruction}`, steps };
    }
    case "content":
      return {
        plan_summary: `Draft content: ${instruction}`,
        steps: [
          mkStep(0, "scribe", "Draft content", instruction, {
            tool_needed: "summarize_text",
            expected_output: "Ready-to-publish draft in the requested format.",
            success_criteria: "Matches the requested length and tone.",
          }),
        ],
      };
    case "screening":
      return {
        plan_summary: `Screen and rank: ${instruction}`,
        steps: [
          mkStep(0, "aria", "Evaluate and rank", instruction, {
            tool_needed: "extract_structured",
            expected_output: "Structured ranking with scores and per-criterion rationale.",
            success_criteria: "Every candidate scored against explicit criteria.",
          }),
        ],
      };
    case "brief": {
      const briefSteps: Step[] = [
        mkStep(0, "scribe", "Internal workspace brief", "Summarize today's activity: pending approvals, active plans, recent task results.", {
          tool_needed: "summarize_text",
          expected_output: "Concise daily brief grouped by approvals, active plans, recent results.",
          success_criteria: "Pulled from workspace data only.",
        }),
      ];
      // Only add a live-pulse step if a live-research tool is actually configured.
      const pulseTool = isToolConfigured("search_web").ready
        ? "search_web"
        // `research_web` was the fallback here. It is retired, so the choice is
        // now search_web or nothing — never a silent substitution of another
        // paid provider.
        : null;
      if (pulseTool) {
        briefSteps.push(
          mkStep(1, "hawk", "Live market pulse", "Add a short external intel pulse.", {
            tool_needed: pulseTool,
            expected_output: "3-5 bullet external pulse with citations.",
            success_criteria: "Skipped gracefully if the tool reports unavailable.",
          }),
        );
      }
      return { plan_summary: `Daily brief: ${instruction}`, steps: briefSteps };
    }
    default:
      return {
        plan_summary: `Investigate request: ${instruction}`,
        steps: [
          mkStep(0, "scribe", "Respond from workspace context", instruction, {
            tool_needed: "summarize_text",
            expected_output: "Findings relevant to the user's request from available workspace data.",
            success_criteria: "No fabrication; cite workspace data or clearly note when broader research is unavailable.",
          }),
        ],
      };
  }
}


// ---------- Deterministic expansion ----------

function expandPlan(instruction: string, intent: Intent, steps: Step[]): Step[] {
  const t = instruction.toLowerCase();
  const has = (slug: Step["agent_slug"]) => steps.some((s) => s.agent_slug === slug);
  const find = (slug: Step["agent_slug"]) => steps.find((s) => s.agent_slug === slug);

  if (intent === "sourcing") {
    if (!has("scout")) {
      steps.unshift(
        mkStep(0, "scout", "Source companies/leads via Apify", `Find candidates for: ${instruction}`, {
          tool_needed: "source_with_apify",
          expected_output: "Sourced leads with name, company, title, url, location.",
          success_criteria: "Apify returns results or a clear actor-not-configured message.",
          planner_source: "expansion",
        }),
      );
    }
    if (!has("aria")) {
      steps.push(
        mkStep(0, "aria", "Rank candidates", `Rank candidates against: ${instruction}`, {
          tool_needed: "extract_structured",
          expected_output: "Ranked list with fit score and rationale.",
          success_criteria: "Every candidate scored.",
          planner_source: "expansion",
        }),
      );
    }
    if (!has("penn")) {
      steps.push(
        mkStep(0, "penn", "Draft outreach", `Draft outreach to top candidates for: ${instruction}`, {
          tool_needed: "draft_outreach",
          requires_approval: true,
          expected_output: "Personalized drafts for top candidates.",
          success_criteria: "Drafts ready for approval; no auto-send.",
          planner_source: "expansion",
        }),
      );
    }
  }

  if (intent === "extraction") {
    const first = steps[0];
    if (!first || (first.agent_slug !== "hawk" && first.agent_slug !== "scout") || first.tool_needed !== "scrape_url") {
      steps.unshift(
        mkStep(0, "hawk", "Scrape source", `Scrape and extract from: ${instruction}`, {
          tool_needed: "scrape_url",
          expected_output: "Markdown of the target page.",
          success_criteria: "Non-empty extraction.",
          planner_source: "expansion",
        }),
      );
    }
  }

  if (intent === "intelligence") {
    const hiringShape = /(hiring|jobs?|roles?|companies?|recruit|engineers?|marketers?|developers?|leads?|founders?)/.test(t);
    const defaultTool = hiringShape ? "source_with_apify" : "search_web";
    const hawk = find("hawk");
    if (!hawk) {
      steps.unshift(
        mkStep(0, "hawk", hiringShape ? "Source hiring/company signals" : "Research signals", `Investigate: ${instruction}`, {
          tool_needed: defaultTool,
          expected_output: hiringShape
            ? "Companies/roles with source URLs from Apify."
            : "Cited signals from current sources (if broad search is configured).",
          success_criteria: hiringShape
            ? "Apify returns results or reports unavailable."
            : "At least 3 cited signals, or a clear unavailable note.",
          planner_source: "expansion",
        }),
      );
    } else if (hawk.tool_needed === "research_web") {
      // Preserve a stored provider choice. The retired Perplexity tool remains
      // unavailable; it must not silently become Parallel or paid Apify.
    } else if (!hawk.tool_needed) {
      hawk.tool_needed = defaultTool;
    }
    if (/(brief|report|summary|memo)/.test(t) && !has("scribe")) {
      steps.push(
        mkStep(0, "scribe", "Brief summary", `Summarize intel for: ${instruction}`, {
          tool_needed: "summarize_text",
          expected_output: "Short intel brief with recommended action.",
          success_criteria: "Grounded in findings above.",
          planner_source: "expansion",
        }),
      );
    }
  }


  if (intent === "outreach") {
    if (!has("penn")) {
      steps.unshift(
        mkStep(0, "penn", "Draft outreach", instruction, {
          tool_needed: "draft_outreach",
          requires_approval: true,
          expected_output: "Personalized drafts ready for approval.",
          success_criteria: "No auto-send.",
          planner_source: "expansion",
        }),
      );
    }
    const wantsSend = /\bsend\b/.test(t);
    const hasSend = steps.some((s) => s.tool_needed === "send_email");
    if (wantsSend && !hasSend) {
      steps.push(
        mkStep(0, "penn", "Send after approval", `Send approved outreach for: ${instruction}`, {
          tool_needed: "send_email",
          requires_approval: true,
          expected_output: "Provider delivery confirmation.",
          success_criteria: "Send only after approval.",
          planner_source: "expansion",
        }),
      );
    }
  }

  if (intent === "content") {
    if (!has("scribe")) {
      steps.unshift(
        mkStep(0, "scribe", "Draft content", instruction, {
          tool_needed: "summarize_text",
          expected_output: "Draft in requested format.",
          success_criteria: "Matches requested length and tone.",
          planner_source: "expansion",
        }),
      );
    }
    if (/(current|today|latest|now)/.test(t) && !has("hawk") && !has("scout")) {
      const broadTool = isToolConfigured("search_web").ready ? "search_web" : "search_web";
      steps.unshift(
        mkStep(0, "hawk", "Research facts", `Gather supporting facts for: ${instruction}`, {
          tool_needed: broadTool,
          expected_output: "Cited supporting facts (if broad search is configured).",
          success_criteria: "Facts have sources, or step reports unavailable.",
          planner_source: "expansion",
        }),
      );
    }
  }


  if (intent === "screening" && !has("aria")) {
    steps.unshift(
      mkStep(0, "aria", "Evaluate and rank", instruction, {
        tool_needed: "extract_structured",
        expected_output: "Structured ranking with scores.",
        success_criteria: "Per-criterion rationale included.",
        planner_source: "expansion",
      }),
    );
  }

  if (intent === "brief") {
    if (!has("scribe")) {
      steps.unshift(
        mkStep(0, "scribe", "Internal workspace brief",
          "Summarize today's workspace activity: pending approvals, active plans, recent task results.", {
          tool_needed: "summarize_text",
          expected_output: "Daily brief from workspace data.",
          success_criteria: "Only workspace data used.",
          planner_source: "expansion",
        }),
      );
    }
    const pulseTool = isToolConfigured("search_web").ready
      ? "search_web"
      // Retired; see above.
      : null;
    if (!has("hawk") && pulseTool) {
      steps.push(
        mkStep(0, "hawk", "Live market pulse", "Add 3-5 bullets of external intel pulse.", {
          tool_needed: pulseTool,
          expected_output: "External pulse with citations.",
          success_criteria: "Skipped gracefully if the tool reports unavailable.",
          planner_source: "expansion",
        }),
      );
    }
  }


  // Force send_email steps to be approval-gated.
  for (const s of steps) {
    if (s.tool_needed === "send_email") {
      s.requires_approval = true;
      s.needs_approval = true;
    }
  }

  // Renumber.
  steps.forEach((s, i) => (s.step_index = i));
  return steps;
}

// ---------- Tool annotation ----------

function annotateTools(steps: Step[]): string[] {
  const messages: string[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (!s.tool_needed) continue;
    const status = isToolConfigured(s.tool_needed);
    if (status.ready) {
      s.tool_status = "ready";
      continue;
    }
    s.tool_status = "connector_required";
    s.connector_required = status.env;
    const msg = TOOL_LIMITATION_MESSAGE[s.tool_needed]
      ?? `${s.tool_needed} unavailable (${status.env ?? "not configured"}).`;
    if (!seen.has(msg)) {
      seen.add(msg);
      messages.push(msg);
    }
  }
  return messages;
}


// ---------- JSON parsing helpers (kept for AI output) ----------

function stripFences(s: string): string {
  return s.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// ---------- Main handler ----------

async function handleOrchestrate(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "missing_service_role_key", message: "SUPABASE_SERVICE_ROLE_KEY is not configured" }, 500);
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    if ((body as { ping?: unknown })?.ping === true) return json({ ok: true });

    const b = body as Record<string, unknown>;
    const workspace_id = (b.workspace_id ?? b.workspaceId) as string | undefined;
    const user_instruction = (b.user_instruction ?? b.userInstruction) as string | undefined;
    const conversation_id = (b.conversation_id ?? b.conversationId ?? null) as string | null;
    const tool_input = (b.tool_input ?? null) as null | {
      intent?: string;
      tool_name?: string | null;
      source_type?: string | null;
      query?: string;
      role_keywords?: string[];
      location?: string | null;
      max_results?: number;
      needs_enrichment?: boolean;
      needs_outreach?: boolean;
      execution_mode?: "fast" | "deep" | "outreach" | "source_and_qualify_only";
      confidence?: number;
      lead_mission?: unknown;
      lead_referent_bindings?: unknown;
    };
    // THE MISSION, CARRIED NOT RE-DERIVED. pilot-chat interpreted the user's
    // words once; orchestrate's job is to put that object on the plan step so
    // run-agent executes it. The step `instruction` below is still a rewritten
    // job-shaped sentence for the legacy path, and that is exactly why the
    // mission must travel separately: on TEST task 8af17651 the rewrite was the
    // only thing that survived, and it had already lost the word "startups".
    //
    // AND DERIVED WHEN IT IS ABSENT, WHICH IS THE COMMON CASE.
    //
    // Only the workflow-confirmation card attached a mission. The lead-intake
    // path never did, so TEST plan c8243321-46cb-4b76-ae33-72570150e6ea reached
    // run-agent with an 18-field `tool_input` and no `lead_mission` — and every
    // containment guard downstream is conditioned on a mission existing. The
    // result was five paid people searches off a job board.
    //
    // `user_instruction` IS the user's verbatim sentence at this point, so a
    // mission can always be derived deterministically. An absent mission is now
    // impossible rather than merely discouraged, which is what lets run-agent
    // refuse to spend when one is missing.
    if (!user_instruction || !workspace_id) {
      return json({ error: "missing_parameter", details: "workspace_id and user_instruction are required" }, 400);
    }

    const suppliedMission = (b.lead_mission ?? tool_input?.lead_mission ?? null) as unknown;
    // ONE APPROVED CARD, ONE PLAN — see startIdempotency.ts. pilot-chat sends a
    // key only for a Start whose card it has verified; anything that is not a
    // well-formed Start key is ignored rather than stored.
    const startKey = isStartIdempotencyKey(b.idempotency_key) ? b.idempotency_key : null;
    // ── THE IDENTITY SIDECAR IS TRANSPORTED, NOT INTERPRETED ───────────────
    //
    // Which real company each referent resolved to, decided by
    // `resolveReferents` in pilot-chat. Orchestrate does not read it, validate
    // it or act on it — `readPersistedBindings` does that at the engine, where
    // it is used. Everything here does is make sure it reaches the plan step by
    // BOTH routes a step's `tool_input` can arrive on, because a sidecar that
    // survives only the fallback planner is one that disappears on exactly the
    // qualified-lead runs it exists for.
    const suppliedBindings = ((b as Record<string, unknown>).lead_referent_bindings
      ?? tool_input?.lead_referent_bindings ?? null) as unknown;
    const bindingsCarrier = Array.isArray(suppliedBindings) && suppliedBindings.length > 0
      ? { lead_referent_bindings: suppliedBindings }
      : null;

    // ── ORCHESTRATE TRANSPORTS A MISSION. IT DOES NOT WRITE ONE. ───────────
    //
    // This used to fall back to `parseLeadMissionDeterministic` whenever a
    // compiled mission failed to arrive. The intent was sound — guarantee a
    // mission always exists so run-agent can refuse to spend without one — but
    // the mechanism guaranteed the wrong thing: it manufactured a mission that
    // PASSES `isLeadMissionV1` while carrying no directives, no planner
    // runtime and no contract version, and handed it downstream as though the
    // compiler had produced it. Task 1d73e23f is that path: confidence 0.6,
    // `original_user_query` silently replaced by the classifier's rewritten
    // instruction, and a second planner quietly outvoting the first.
    //
    // Under the new architecture a missing mission is now a PLANNING FAILURE,
    // which is the honest description of it. The deterministic parser stays for
    // workspaces that have deliberately not adopted the compiler — there it is
    // the intended behaviour, not error recovery.
    const orchestrateIntelligence = getLeadIntelligenceCapabilities(workspace_id);

    // ── A CONTENT REQUEST HAS NO LEAD MISSION, AND NEEDS NONE ───────────────
    //
    // The gate below refuses any request that arrives without a compiled
    // `LeadMissionV1`. That is right for lead work — run-agent must never spend
    // on sourcing without one — but it was applied to EVERY request, and a
    // Scribe draft is not lead work: it reaches no sourcing provider, buys no
    // contacts and has no target population to compile.
    //
    // Live, on the first Pilot content canary: Pilot created the canonical
    // draft, called orchestrate, and got `mission_not_compiled` 422. The user's
    // post never got written because a lead safety check asked a content
    // request for a lead mission it could not have.
    //
    // NARROW ON PURPOSE. Only `content_creation`, which plans exactly one
    // Scribe step and no provider calls. `content_engagement_loop` also
    // searches LinkedIn, so it keeps the gate.
    const isPureContentRequest = tool_input?.intent === "content_creation";

    let lead_mission: unknown;
    if (isLeadMissionV1(suppliedMission)) {
      lead_mission = suppliedMission;
    } else if (isPureContentRequest) {
      // No mission, and no substitute invented for one. Nothing downstream may
      // read this as authority to source.
      lead_mission = null;
    } else if (orchestrateIntelligence.mode === "new_architecture") {
      console.error("[orchestrate][mission-not-compiled]", {
        workspace_id,
        intelligence_mode: orchestrateIntelligence.mode,
        had_body_mission: b.lead_mission != null,
        had_tool_input_mission: tool_input?.lead_mission != null,
      });
      return json({
        error: "mission_not_compiled",
        details:
          "this workspace runs the compiled-mission architecture and no valid " +
          "LeadMission reached orchestrate; planning failed upstream. No " +
          "deterministic mission was substituted and no provider work was " +
          "scheduled.",
        intelligence_mode: orchestrateIntelligence.mode,
      }, 422);
    } else {
      // Explicitly deterministic workspace: this is the designed behaviour.
      lead_mission = parseLeadMissionDeterministic(user_instruction ?? "", {
        requestedCount: typeof tool_input?.max_results === "number" ? tool_input.max_results : null,
      });
    }

    // Auth.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user?.id) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Membership.
    const { data: member } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .eq("workspace_id", workspace_id)
      .maybeSingle();
    if (!member) {
      return json({ error: "workspace_not_found", details: "User is not a member", workspace_id }, 404);
    }

    // ── THE SAME START, AGAIN ────────────────────────────────────────────
    //
    // After membership, so a key cannot probe another workspace's plans, and
    // BEFORE the spend check, the planner and the enqueue, so a repeated Start
    // costs nothing and starts nothing: it is answered with the plan the first
    // one created. Conversation 38e904cb bought a second paid mission because
    // this check did not exist.
    if (startKey) {
      const existing = await findStartedPlan(admin, workspace_id, startKey);
      if (existing) {
        console.log("[orchestrate][start-idempotency] repeated Start collapsed", {
          workspace_id, plan_id: existing.plan_id, idempotency_key: startKey,
        });
        return json(duplicateStartBody(existing, startKey));
      }
    }

    // ── LAYER 1: THE WORKSPACE USD CEILING ───────────────────────────────
    //
    // Placed AFTER the membership check, so it cannot be used to probe another
    // workspace's spend, and BEFORE the planner call and the `task_plans`
    // insert, so a refusal leaves no half-built plan behind.
    //
    // The `ping` health check returns far above this and is unaffected: it makes
    // no model call, and a liveness probe that failed on a spend ceiling would
    // read as an outage.
    {
      const spend = await authorizeModelSpend({
        db: admin as unknown as SpendDb,
        workspace_id,
        mode: resolveSpendEnforcement(),
        ...resolveCeiling(),
      });
      if (!spend.allowed || spend.reason !== "under_ceiling") {
        console.log("[orchestrate][model-spend]", describeSpend(spend));
      }
      if (!spend.allowed) {
        return json({
          error: MODEL_SPEND_REFUSED,
          reason: spend.reason,
          details: spendRefusalMessage(spend),
        }, 429);
      }
    }

    // ── LAYER 2: NO CREDITS, NO PAID MISSION ─────────────────────────────
    //
    // Credit enforcement fails closed and credits go only to approved beta
    // workspaces. A mission that buys provider data is refused HERE, before
    // the plan, the task and the queue row exist — not mid-run, where the
    // per-call reservation would stop it and the user would read a failure.
    // Model-only plans are not gated: chat and drafting stay free.
    if (startBuysProviderData(body as Record<string, unknown>)) {
      const creditMode = resolveCreditEnforcement();
      let balance: number | null = null;
      let readFailed = false;
      if (creditMode === "enforce") {
        const { data: balRow, error: balErr } = await admin
          .from("workspace_credit_balances")
          .select("balance_credits").eq("workspace_id", workspace_id).maybeSingle();
        readFailed = !!balErr;
        balance = typeof (balRow as { balance_credits?: unknown } | null)?.balance_credits === "number"
          ? (balRow as { balance_credits: number }).balance_credits : null;
      }
      const gate = creditStartGate({ mode: creditMode, balance, readFailed });
      if (!gate.allowed) {
        console.log("[orchestrate][credit-start-gate]", { workspace_id, ...gate });
        return json({ error: CREDITS_REQUIRED, reason: gate.reason, details: BETA_ACCESS_MESSAGE }, 402);
      }
    }

    // Best-effort company brain.
    const { data: brainRow } = await admin
      .from("company_brain").select("profile").eq("workspace_id", workspace_id).maybeSingle();
    const companyBrain = (brainRow?.profile ?? {}) as Record<string, unknown>;

    const intent = detectIntent(user_instruction);
    const executionMode = tool_input?.execution_mode ?? "fast";

    // ---------- Staged plan from tool_input (short-circuits AI planner) ----------

    let parsed: { plan_summary: string; steps: Step[] } | null = null;
    let plannerSource: "ai" | "fallback" | "staged" | "capability_graph" = "fallback";

    // ══ A COMPILED MISSION IS ITS OWN PLAN ═════════════════════════════════
    //
    // ── THE RUN THIS EXISTS TO END ────────────────────────────────────────
    //
    // Task bf13ff42, 2026-08-28 15:53. The user approved a workflow card built
    // from a compiled `LeadMissionV1` — 3 recruiting/staffing companies with a
    // hiring signal, six capability steps, ~7 credits — pressed Start, and the
    // mission arrived here intact. It was then handed to the AI planner, which
    // wrote its own four-step plan from the raw sentence:
    //
    //   Scout will source recruiting/staffing companies hiring sales roles,
    //   Aria will rank and screen companies against icp, Hawk will enrich top
    //   company with website intel, Penn will draft outreach.
    //
    // `planner_source: "ai"`, `tool_needed: "source_with_apify"` — none of it
    // from the mission, none of it from the capability graph. Those steps carry
    // no `metadata.tool_input`, so the mission was DROPPED at plan
    // persistence: only the deterministic fallback builder attaches it. The
    // task reached run-agent with an instruction string and nothing else, the
    // paid preflight refused it — `missing_mission: no LeadMissionV1 on this
    // task; paid execution is refused because nothing states what is being
    // bought` — and the row was written `failed`.
    //
    // Nothing ran. Nothing was charged. But the user was told four agents were
    // working, shown a plan for work that could never execute, and then shown a
    // failure — for a request that had been understood, compiled, assessed and
    // approved correctly at every prior step.
    //
    // ── SO THE PLANNER IS NOT CONSULTED ───────────────────────────────────
    //
    // `buildCapabilityGraph` is the SAME function Stage 1 previewed from and
    // the same one run-agent executes. Deriving the plan from it means the card
    // the user approved, the plan persisted here, and the graph the engine runs
    // are one object with one hash. There is no second reading of the sentence
    // to disagree with the first, and no model call on this path at all.
    //
    // ONE STEP, deliberately. The capability engine executes the whole graph
    // inside a single run-agent invocation — it owns ordering, resume, cost
    // accounting and the provider boundary. Splitting the graph into one task
    // per capability would create rows nothing drives, and a plan whose step
    // count disagreed with what actually runs is how the four-step narration
    // came to sit above a one-step execution card.
    const approvedMission = isLeadMissionV1(lead_mission) ? lead_mission : null;
    if (approvedMission) {
      // P0: a Lead V2 workspace never schedules a capability the engine
      // cannot execute. V1 workspaces keep today's graph (legacy).
      const graph: CapabilityPlan = buildCapabilityGraph(approvedMission, {
        executability: executabilityGateFor(workspace_id, (k) => Deno.env.get(k)),
        readiness: readinessPolicyFor(workspace_id, (k) => Deno.env.get(k)),
      });
      const missionStep = mkStep(
        0,
        "scout",
        "Execute the approved mission",
        // THE USER'S OWN WORDS, which the mission already carries. Not a
        // rewrite: `original_user_query` is what the compiler read.
        approvedMission.original_user_query || user_instruction,
        {
          tool_needed: "source_with_apify",
          expected_output: "Qualified results from the approved mission's capability graph.",
          success_criteria: "The capability plan completes, or reports the exact capability that could not.",
          planner_source: "capability_graph",
        },
      );
      (missionStep as Step & { metadata?: Record<string, unknown> }).metadata = {
        // THE MISSION TRAVELS ON THE STEP. This is the field
        // `readPersistedLeadMission` reads in run-agent, and its absence is
        // exactly what the preflight refused.
        tool_input: {
          ...(tool_input ?? {}),
          lead_mission: approvedMission,
          ...(bindingsCarrier ?? {}),
        },
      };
      parsed = {
        plan_summary: `${graph.steps.length} capabilities: ${
          graph.steps.map((x) => x.capability.replace(/_/g, " ")).join(" → ")}`,
        steps: [missionStep],
      };
      plannerSource = "capability_graph";
      console.log("[orchestrate][capability-graph-plan]", {
        workspace_id,
        entry_capability: graph.entry_capability,
        capabilities: graph.steps.map((x) => x.capability),
        allowed_providers: graph.allowed_providers,
        planner_consulted: false,
      });
    }

    // Phase 7 — Founder Content + Engagement Loop. Deterministic staged plan:
    // Scribe (founder post / ideas, Claude-preferred) → Scout (LinkedIn search)
    // → Aria (rank opportunities) → [Scribe comments, Claude-preferred] →
    // [Penn soft DMs, approval-gated]. No auto-post / auto-comment / auto-DM.
    if (tool_input && tool_input.intent === "content_engagement_loop") {
      const ti = tool_input as typeof tool_input & {
        signal_type?: string; competitor_related?: boolean;
        needs_comment_drafts?: boolean; needs_dm_drafts?: boolean;
      };
      const loopInput = extractContentLoopInput(user_instruction);
      // Carry classifier-derived flags onto the parsed input.
      loopInput.competitorRelated = !!ti.competitor_related || loopInput.competitorRelated;
      loopInput.needsCommentDrafts = !!ti.needs_comment_drafts;
      loopInput.needsDmDrafts = !!ti.needs_dm_drafts;
      loopInput.needsEngagementSearch = true;
      const loopPlan = buildContentLoopPlan(loopInput, companyBrain);
      const isCompetitor = (ti.signal_type === "competitor_engagement") || !!loopInput.competitorRelated;
      const cap = Math.max(1, Math.min(10, tool_input.max_results ?? loopPlan.search_budget.max_results_per_query));
      const topic = loopPlan.post_brief.topic || tool_input.query || user_instruction;
      const audience = loopPlan.post_brief.audience ?? "the company's ICP";
      const postSubtype = loopInput.contentFormat === "post_ideas" ? "post_ideas" : "founder_post";
      const engagementQ = loopPlan.engagement_queries.length ? loopPlan.engagement_queries.join(", ") : topic;

      const steps: Step[] = [];

      // 0) Scribe — founder post / ideas (Claude preferred via run-agent routing).
      const scribePost = mkStep(0, "scribe",
        postSubtype === "post_ideas" ? "Draft founder LinkedIn post ideas" : "Draft founder LinkedIn post",
        `Write ${postSubtype === "post_ideas" ? "a set of distinct founder LinkedIn post ideas" : "a founder LinkedIn post"} about: ${topic}. Audience: ${audience}. Tone: ${loopPlan.post_brief.tone}. Angle: ${loopPlan.post_brief.angle}. Ground it in real context — do NOT invent product details, metrics, or customer names. This is a draft for the founder to review and post manually; nothing is auto-posted.`,
        {
          tool_needed: null,
          expected_output: "On-brand founder content draft (no fabricated facts).",
          success_criteria: "Draft produced; grounded; nothing auto-posted.",
          planner_source: "fallback",
        });
      // ── THE LAST SHADOW DISPATCH ──────────────────────────────────────
      //
      // This `content_loop` carried no `content_item_id`, so the post Scribe
      // wrote here landed in `saved_outputs` and never became a draft the user
      // could open, edit, version, approve or illustrate. It is the same defect
      // Pilot had, in the one remaining place that still produces content
      // without going through the canonical row.
      //
      // The row is created FIRST, exactly as everywhere else, so a failed
      // generation leaves a retryable draft rather than nothing. A failure to
      // create it is not fatal to the loop — the engagement search is still
      // worth running — so the step degrades to the old behaviour rather than
      // taking the plan down.
      const loopContent = await createCanonicalContentItem(
        admin as unknown as ContentDb,
        {
          objective: "create",
          workspace_id,
          format: "linkedin_post",
          source_type: "idea",
          idea: topic,
        },
      );
      if (!loopContent.ok) {
        console.warn("[orchestrate][content-loop] canonical item not created", loopContent.error);
      }
      (scribePost as Step & { metadata?: Record<string, unknown> }).metadata = {
        tool_input: {
          ...tool_input,
          content_loop: {
            source: "content_engagement_loop",
            subtype: postSubtype,
            topic,
            audience: loopPlan.post_brief.audience ?? null,
            angle: loopPlan.post_brief.angle,
            engagement_queries: loopPlan.engagement_queries,
            competitor_related: isCompetitor,
            // The field that makes the result canonical. Absent when the row
            // could not be created, which keeps the old path as the fallback.
            content_item_id: loopContent.reference?.content_item_id ?? undefined,
          },
        },
      };
      steps.push(scribePost);

      // 1) Scout — find LinkedIn engagement opportunities for the post topic.
      const scoutToolInput = {
        ...tool_input,
        tool_name: "source_with_apify",
        selected_actor_key: "apify_linkedin_posts",
        source_type: "linkedin_engagement",
        query: engagementQ,
        keywords: loopPlan.engagement_queries,
        max_results: cap,
        signal_type: isCompetitor ? "competitor_engagement" : "linkedin_engagement",
      };
      const scoutStep = mkStep(1, "scout",
        isCompetitor ? "Find competitor engagement opportunities" : "Find LinkedIn engagement opportunities",
        `Find up to ${cap} LinkedIn posts / conversations to engage with on: ${engagementQ}. Use the LinkedIn posts actor only. Do not invent profiles or contact info; do not harvest commenter/reactor lists.`,
        {
          tool_needed: "source_with_apify",
          expected_output: "Normalized LinkedIn engagement items (post, author, topic, signal reason).",
          success_criteria: "Actor returns engagement items, or reports unavailable cleanly. No fabricated people.",
          planner_source: "fallback",
        });
      (scoutStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input: scoutToolInput };
      steps.push(scoutStep);

      // 2) Aria — rank engagement opportunities.
      steps.push(mkStep(2, "aria", "Rank engagement opportunities",
        `Rank the LinkedIn engagement opportunities for the post about: ${topic}. Score by ICP fit, relevance to the post, reply-worthiness, and urgency. Label hot | warm | maybe | ignore. Note where a thoughtful comment (or soft DM, if requested) is appropriate.`,
        {
          tool_needed: "extract_structured",
          expected_output: "Ranked engagement opportunities with priority label and rationale.",
          success_criteria: "Every opportunity scored; grounded only in the sourced items.",
          planner_source: "fallback",
        }));

      // 3) Scribe — thoughtful comments (Claude preferred), only if requested.
      if (loopInput.needsCommentDrafts) {
        const scribeComments = mkStep(steps.length, "scribe", "Draft thoughtful comments",
          // PER POST, AS DATA. Each entry becomes its own canonical
          // `linkedin_comment` draft (see `engagementCommentItems.ts`), so the
          // post it answers must travel with it rather than be inferred later.
          `Draft a short, human, non-pitchy LinkedIn comment for each top-ranked post related to: ${topic}. Add genuine value; ground each comment in the actual post text. No "great post!" filler, no link drops, no fake familiarity. These are drafts for manual review — nothing is auto-posted.\n\nReturn ONLY a JSON array, one object per post: [{"post_url": "<the post's URL exactly as given>", "author": "<post author name, or null>", "comment": "<the comment draft>"}].`,
          {
            tool_needed: "summarize_text",
            expected_output: "One thoughtful comment draft per top post, ready for manual review.",
            success_criteria: "Comments specific to each post; nothing auto-posted.",
            planner_source: "fallback",
          });
        (scribeComments as Step & { metadata?: Record<string, unknown> }).metadata = {
          tool_input: {
            ...tool_input,
            content_loop: { source: "content_engagement_loop", subtype: "comment_draft", topic, competitor_related: isCompetitor },
          },
        };
        steps.push(scribeComments);
      }

      // 4) Penn — soft DMs (Claude preferred), approval-gated, only if requested.
      if (loopInput.needsDmDrafts) {
        steps.push(mkStep(steps.length, "penn", "Draft soft follow-up DMs",
          `Draft a soft, no-pitch LinkedIn DM for each top-ranked person engaging on: ${topic}. Reference the specific post/context, ask one light question, no pitch in the first message. Approval required; never send automatically.`,
          {
            tool_needed: "draft_outreach",
            requires_approval: true,
            expected_output: "One soft DM per top person, awaiting approval.",
            success_criteria: "No auto-send; references real post context; no pitch in first message.",
            planner_source: "fallback",
          }));
      }

      steps.forEach((s, idx) => { s.step_index = idx; });
      const tail = loopInput.needsDmDrafts ? " → draft DMs" : loopInput.needsCommentDrafts ? " → draft comments" : "";
      parsed = {
        plan_summary: `${isCompetitor ? "Competitor content loop" : "Content loop"}: post → find engagement → rank${tail}: ${topic.slice(0, 70)}`,
        steps,
      };
      plannerSource = "staged";
    } else if (tool_input && tool_input.intent === "content_creation") {
      const scribeStep = mkStep(
        0,
        "scribe",
        "Write content",
        user_instruction,
        {
          tool_needed: null,
          expected_output: "On-brand content draft (post/report/summary as requested).",
          success_criteria: "Draft produced; no fabricated facts — ask for source context if missing.",
          planner_source: "fallback",
        },
      );
      (scribeStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input };
      parsed = { plan_summary: `Content: ${user_instruction.slice(0, 90)}`, steps: [scribeStep] };
      plannerSource = "staged";
    } else if (tool_input && tool_input.intent === "draft_outreach") {
      // Memory-driven outreach follow-up: Pilot already resolved the target
      // leads from conversation memory. Deterministic Penn-only plan — no
      // Scout/Aria/Apify/research_web/Firecrawl, no duplicate Penn steps.
      const built = buildDraftOutreachPlan({
        user_instruction,
        max_results: (tool_input as { max_results?: number | null }).max_results ?? null,
        lead_candidate_ids: (tool_input as { lead_candidate_ids?: string[] | null }).lead_candidate_ids ?? null,
      });
      // Enrich + draft: Hawk (Firecrawl on the remembered leads' websites) → Penn.
      // The Hawk step instruction carries the lead domains as URLs so run-agent
      // scrapes them; Penn then drafts from the enriched context. Approval-gated.
      const enrichFirst = !!(tool_input as { needs_enrichment?: boolean }).needs_enrichment;
      const steps: Step[] = [];
      if (enrichFirst) {
        const hawkStep = mkStep(0, "hawk", "Enrich leads (Firecrawl)",
          `Analyze the company websites for these remembered leads and extract personalization angles (positioning, recent moves, ICP fit). Skip leads without a website. ${user_instruction}`,
          { tool_needed: "scrape_url", expected_output: "Per-lead enrichment notes / personalization angles.", success_criteria: "Only real scraped content; skip missing sites; no fabrication.", planner_source: "fallback" });
        (hawkStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input: { ...tool_input, tool_name: "scrape_url", selected_actor_key: null, source_type: null } };
        steps.push(hawkStep);
      }
      const s0 = built.steps[0];
      const pennStep = mkStep(steps.length, "penn", s0.task_title, s0.task_description, {
        tool_needed: "draft_outreach",
        requires_approval: true,
        expected_output: s0.expected_output,
        success_criteria: s0.success_criteria,
        planner_source: "fallback",
      });
      (pennStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input };
      steps.push(pennStep);
      parsed = { plan_summary: enrichFirst ? `Enrich → draft outreach: ${built.plan_summary}`.slice(0, 140) : built.plan_summary, steps };
      plannerSource = "staged";
    } else if (tool_input && tool_input.source_type === "linkedin_comments") {
      // Phase 4.2 — extract commenters from a specific post → rank.
      const cap = Math.max(1, Math.min(50, tool_input.max_results ?? 20));
      const scoutStep = mkStep(0, "scout", "Extract post commenters",
        `Extract up to ${cap} commenters/engagers from the provided LinkedIn post URL(s). Use the post-comments actor only. Do not invent people or contact info; no reactions by default.`,
        {
          tool_needed: "source_with_apify",
          expected_output: "Normalized commenters (name, profile URL, comment text).",
          success_criteria: "Actor returns commenters or reports unavailable cleanly. No fabricated people.",
          planner_source: "fallback",
        });
      (scoutStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input };
      const ariaStep = mkStep(1, "aria", "Rank commenters",
        "Rank the commenters by ICP fit, role (founder/GTM/operator), and how warm/relevant their comment is. Label hot | warm | maybe | ignore.",
        { tool_needed: "extract_structured", expected_output: "Ranked commenters with rationale.", success_criteria: "Grounded only in the extracted commenters.", planner_source: "fallback" });
      parsed = { plan_summary: `Extract & rank post commenters`, steps: [scoutStep, ariaStep] };
      plannerSource = "staged";
    } else if (tool_input && (tool_input as { competitor_discovery?: boolean }).competitor_discovery &&
        ((tool_input as { discovery_mode?: string }).discovery_mode === "website" || (tool_input as { discovery_mode?: string }).discovery_mode === "description")) {
      // Phase 4 (dynamic) — competitor discovery: website → Hawk(Firecrawl) first,
      // description → Hawk(infer) first, then Scout(LinkedIn actor) → Aria → [..].
      const ti = tool_input as typeof tool_input & {
        discovery_mode?: "website" | "description"; business_website?: string; business_description?: string;
        needs_comment_drafts?: boolean; needs_dm_drafts?: boolean; signal_type?: string; competitors?: string[];
      };
      const dplan = buildCompetitorDiscoveryPlan(ti.discovery_mode!, {
        website_url: ti.business_website ?? null,
        description: ti.business_description ?? null,
        topic: tool_input.query || user_instruction,
        needs_comment_drafts: ti.needs_comment_drafts,
        needs_dm_drafts: ti.needs_dm_drafts,
        max: tool_input.max_results,
      });
      // The Scout step must run the LinkedIn actor → give it the apify tool_input.
      // The Hawk step (website mode) must only Firecrawl → give it a scrape-only tool_input.
      const knownCompetitors = Array.isArray(ti.competitors) ? ti.competitors : [];
      const scoutToolInput = { ...tool_input, tool_name: "source_with_apify", selected_actor_key: "apify_linkedin_posts", source_type: "linkedin_engagement", competitors: knownCompetitors };
      // competitor_discovery flag on the Hawk inputs makes run-agent skip the
      // optional Perplexity research_web call (inference is Gemini-only) and lets
      // the inference→search threading carry known competitors into Scout.
      const hawkScrapeToolInput = { tool_name: "scrape_url", selected_actor_key: null, source_type: null, query: ti.business_website ?? null, max_results: 1, competitor_discovery: true, discovery_mode: ti.discovery_mode, competitors: knownCompetitors };
      // Inference-only Hawk (description mode): explicit no-tool input so it does
      // NOT inherit the plan's apify tool_input and re-run the LinkedIn actor.
      const hawkInferToolInput = { tool_name: null, selected_actor_key: null, source_type: null, competitor_discovery: true, discovery_mode: ti.discovery_mode, competitors: knownCompetitors };
      const steps: Step[] = dplan.steps.map((s, idx) => {
        const st = mkStep(idx, s.agent_slug, s.task_title, s.task_description, {
          tool_needed: s.tool_needed,
          requires_approval: s.requires_approval ?? false,
          expected_output: "Grounded output for the discovery pipeline; no fabricated competitors/people.",
          success_criteria: "Grounded only in prior steps / actor results. No auto-post/DM/send.",
          planner_source: "fallback",
        });
        if (s.agent_slug === "scout") (st as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input: scoutToolInput };
        else if (s.agent_slug === "hawk") (st as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input: s.tool_needed === "scrape_url" ? hawkScrapeToolInput : hawkInferToolInput };
        return st;
      });
      parsed = { plan_summary: dplan.plan_summary, steps };
      plannerSource = "staged";
    } else if (tool_input && tool_input.source_type === "linkedin_engagement") {
      // Phase 3 — LinkedIn engagement signal engine. Deterministic staged plan:
      // Scout (apify_linkedin_posts) → Aria (rank) → [Scribe comments] → [Penn DMs].
      const ti = tool_input as typeof tool_input & {
        needs_comment_drafts?: boolean; needs_dm_drafts?: boolean; keywords?: string[];
        signal_type?: string; competitors?: string[];
      };
      const isCompetitor = ti.signal_type === "competitor_engagement";
      const cap = Math.max(1, Math.min(20, tool_input.max_results ?? 5));
      const topic = (ti.keywords && ti.keywords.length > 0) ? ti.keywords.join(", ") : (tool_input.query || user_instruction);
      const compNote = isCompetitor && ti.competitors && ti.competitors.length > 0
        ? ` (competitors: ${ti.competitors.join(", ")})` : "";
      const steps: Step[] = [];
      const scoutStep = mkStep(0, "scout",
        isCompetitor ? "Find competitor engagement signals" : "Find LinkedIn engagement signals",
        `Find up to ${cap} LinkedIn posts / people ${isCompetitor ? "engaging around competitors/adjacent tools" : "engaging"} on: ${topic}${compNote}. Use the LinkedIn posts actor only. Do not invent profiles or contact info.`,
        {
          tool_needed: "source_with_apify",
          expected_output: "Normalized LinkedIn engagement items (post, author, topic, signal reason).",
          success_criteria: "Actor returns engagement items, or reports unavailable cleanly. No fabricated people.",
          planner_source: "fallback",
        });
      (scoutStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input };
      steps.push(scoutStep);
      steps.push(mkStep(1, "aria", isCompetitor ? "Rank competitor signals" : "Rank engagement signals",
        isCompetitor
          ? `Rank these competitor-engagement signals for: ${topic}${compNote}. Score by ICP fit, founder/GTM/operator role, pain or complaint about the competitor, comparison/switching intent, competitor relevance, recency, and engagement quality. Label hot (explicit complaint/switching/looking for alternatives + high ICP fit) | warm (discussing the competitor/problem, decent ICP fit) | maybe (generic mention) | ignore (irrelevant/non-ICP). Note where a soft comment/DM is appropriate.`
          : `Rank the LinkedIn engagement signals for: ${topic}. Score by ICP fit, role fit (founder/GTM/operator), relevance to Agentory, pain/urgency, and whether engagement is warm enough to comment or DM. Label each hot | warm | maybe | ignore.`,
        {
          tool_needed: "extract_structured",
          expected_output: "Ranked engagement signals with priority label and rationale.",
          success_criteria: "Every signal scored; grounded only in the sourced items.",
          planner_source: "fallback",
        }));
      if (ti.needs_comment_drafts) {
        steps.push(mkStep(2, "scribe", "Draft LinkedIn comments",
          `Draft a short, human, non-pitchy LinkedIn comment for each top-ranked post about: ${topic}. Add genuine value to the post. No "great post!" filler, no fake familiarity, no link drops. Ground each comment in the actual post text.`,
          {
            tool_needed: "summarize_text",
            expected_output: "One thoughtful comment per top post, ready for manual review/posting.",
            success_criteria: "Comments are specific to each post; nothing auto-posted.",
            planner_source: "fallback",
          }));
      }
      if (ti.needs_dm_drafts) {
        steps.push(mkStep(steps.length, "penn", "Draft soft follow-up DMs",
          `Draft a soft, no-pitch LinkedIn DM for each top-ranked person engaging on: ${topic}. Reference the specific post/context, ask one light question, no pitch in the first message. Approval required; never send automatically.`,
          {
            tool_needed: "draft_outreach",
            requires_approval: true,
            expected_output: "One soft DM per top person, awaiting approval.",
            success_criteria: "No auto-send; references real post context; no pitch in first message.",
            planner_source: "fallback",
          }));
      }
      steps.forEach((s, idx) => { s.step_index = idx; });
      const modeLabel = ti.needs_dm_drafts ? "Source → rank → draft DMs"
        : ti.needs_comment_drafts ? "Source → rank → draft comments" : "Source → rank";
      parsed = { plan_summary: `${isCompetitor ? "Competitor engagement" : "LinkedIn engagement"} (${modeLabel}): ${topic}`, steps };
      plannerSource = "staged";
    } else if (tool_input && tool_input.tool_name === "source_with_apify") {
      const cap = Math.max(1, Math.min(200, tool_input.max_results ?? 5));
      const sourcingStep = mkStep(
        0,
        "scout",
        "Source signals via Apify",
        `Find ${cap} ${tool_input.source_type ?? "jobs"} matching: ${tool_input.query || user_instruction}${tool_input.location ? ` in ${tool_input.location}` : ""}${tool_input.role_keywords?.length ? ` (roles: ${tool_input.role_keywords.join(", ")})` : ""}`,
        {
          tool_needed: "source_with_apify",
          expected_output: "Normalized list of signals with company, role, url, location.",
          success_criteria: "Apify returns at least a few results, or reports unavailable cleanly.",
          planner_source: "fallback",
        },
      );
      (sourcingStep as Step & { metadata?: Record<string, unknown> }).metadata = {
        tool_input: lead_mission
          ? { ...tool_input, lead_mission, ...(bindingsCarrier ?? {}) }
          : bindingsCarrier ? { ...tool_input, ...bindingsCarrier } : tool_input,
      };

      const steps: Step[] = [sourcingStep];
      const rankStep = mkStep(1, "aria", "Rank signals", `Score and rank the sourced signals against: ${user_instruction}`, {
        tool_needed: "extract_structured",
        expected_output: "Ranked list with fit score and rationale.",
        success_criteria: "Every signal scored.",
        planner_source: "fallback",
      });
      steps.push(rankStep);

      if (executionMode === "deep" || executionMode === "outreach") {
        steps.push(mkStep(2, "hawk", "Enrich top companies", `Firecrawl the top companies for: ${user_instruction}`, {
          tool_needed: "scrape_url",
          expected_output: "Enrichment notes for top 3-5 companies.",
          success_criteria: "Only top-ranked companies enriched; cost-capped.",
          planner_source: "fallback",
        }));
      }

      // full_gtm_report: when the user asks for a report/summary/brief, add a
      // Scribe report step BEFORE Penn so it can be reviewed before approving
      // any send. Detected from the instruction (deterministic).
      const wantsReport = /\b(report|summary|brief|write[-\s]?up|recap|overview|digest)\b/i.test(user_instruction);
      const isFullGtm = wantsReport && (executionMode === "deep" || executionMode === "outreach");
      if (isFullGtm) {
        steps.push(mkStep(99, "scribe", "Write review report", `Write a short, reviewable report of the sourced and ranked results (and enrichment) for: ${user_instruction}. Ground it only in the prior steps' outputs; do not fabricate.`, {
          tool_needed: "summarize_text",
          expected_output: "Concise report the user can review before approving outreach.",
          success_criteria: "Grounded in prior step outputs; no fabricated companies/people.",
          planner_source: "fallback",
        }));
      }

      if (executionMode === "outreach") {
        steps.push(mkStep(99, "penn", "Draft outreach (top 5)", `Draft personalized outreach for top candidates from: ${user_instruction}`, {
          tool_needed: "draft_outreach",
          requires_approval: true,
          expected_output: "Up to 5 personalized drafts ready for review.",
          success_criteria: "No auto-send; capped at 5 unless user confirms more.",
          planner_source: "fallback",
        }));
      }

      // Re-index step_index to match array position (run-agent chains by array
      // position, so inserted steps must keep these aligned).
      steps.forEach((s, i) => { s.step_index = i; });

      const modeLabel = isFullGtm
        ? (executionMode === "outreach" ? "Source → rank → enrich → report → draft" : "Source → rank → enrich → report")
        : executionMode === "outreach" ? "Source → rank → enrich → draft" : executionMode === "deep" ? "Source → rank → enrich" : "Source → rank";
      parsed = {
        plan_summary: `${modeLabel}: ${tool_input.query || user_instruction}`,
        steps,
      };
      plannerSource = "staged";
    } else if (tool_input && tool_input.tool_name === "scrape_url") {
      const scrapeStep = mkStep(0, "hawk", "Scrape source", `Scrape and extract from: ${user_instruction}`, {
        tool_needed: "scrape_url",
        expected_output: "Markdown + summary of the target page.",
        success_criteria: "Non-empty extraction.",
        planner_source: "fallback",
      });
      (scrapeStep as Step & { metadata?: Record<string, unknown> }).metadata = { tool_input };
      const briefStep = mkStep(1, "scribe", "Summarize findings", `Summarize the extracted content for: ${user_instruction}`, {
        tool_needed: "summarize_text",
        expected_output: "Short brief grounded in scraped content.",
        success_criteria: "No fabrication.",
        planner_source: "fallback",
      });
      parsed = { plan_summary: `Extract and summarize: ${user_instruction}`, steps: [scrapeStep, briefStep] };
      plannerSource = "staged";
    }

    // ---------- AI planner (only if no staged plan) ----------

    let ai: any = null;
    if (!parsed) {

    const orchestratorPrompt = `You are the planner for ScreeningPilot, an AI workforce orchestrator.
Convert the user instruction into a multi-step plan with the right agents, tools, and approval gates.

AGENTS:
- scout  = sourcing, lead/candidate discovery, research collection
- aria   = screening, ranking, scoring, evaluation, fit analysis
- penn   = outreach, follow-up, personalized messages, email drafts (approval-gated sending)
- hawk   = market/competitive intelligence, signals, monitoring, scraping
- scribe = content, summaries, briefs, posts, reports

TOOLS (priority order matters):
- source_with_apify   (apify)        allowed: scout, hawk — PRIMARY for finding companies/leads/hiring signals/jobs/posts
- scrape_url          (firecrawl)    allowed: hawk, scout — PRIMARY for any specific URL/page extraction
- search_web          (parallel) allowed: hawk, scout — current web research with source URLs (respects deployment search settings)
- summarize_text      (gemini)       allowed: aria, scribe, hawk, scout
- extract_structured  (gemini)       allowed: aria, scribe, hawk, scout
- draft_outreach      (gemini)       allowed: penn
- send_email          (resend)       allowed: penn — ALWAYS requires_approval=true

WORKFLOW ARCHETYPES (use as defaults, deepen when useful):
A. Sourcing (hiring/companies/leads) -> scout(source_with_apify) -> aria(extract_structured) -> penn(draft_outreach, approval) ONLY if outreach was requested
B. Extraction from URL -> hawk(scrape_url) -> scribe(summarize_text)
C. Intelligence (hiring shape: companies/jobs/roles) -> hawk(source_with_apify) -> scribe(summarize_text)
C2. Intelligence (broad market/current events) -> hawk(search_web) -> scribe(summarize_text)
D. Outreach -> penn(draft_outreach, approval); add penn(send_email, approval) only if user said send
E. Content -> scribe(summarize_text); prepend hawk(search_web) only if user wants current facts
F. Screening -> aria(extract_structured)


COMPANY CONTEXT (may be empty):
${JSON.stringify(companyBrain)}

USER INSTRUCTION:
"${user_instruction}"

DETECTED INTENT: ${intent}

RULES:
- agent_slug must be one of: scout, aria, penn, hawk, scribe.
- Never claim live data was retrieved — only describe what the agent will do.
- Default to deeper plans (multi-step) for sourcing, extraction, intelligence, and outreach.
- send_email and any irreversible external action MUST set requires_approval=true.

Return ONLY valid JSON, no prose, no markdown:
{
  "plan_summary": "one sentence",
  "intent": "${intent}",
  "steps": [
    {
      "step_index": 0,
      "agent_slug": "scout",
      "task_title": "Source candidates",
      "task_description": "specific instruction",
      "tool_needed": "source_with_apify",
      "expected_output": "what this step produces",
      "success_criteria": "how we know it worked",
      "requires_approval": false
    }
  ]
}`;

    // Bounds and reports the planner call. `generateJson` forwards into
    // `generateText`, which emits telemetry ONLY through `onModelCall`.
    const modelCalls = new ModelCallCollector(resolveRunBudget());

    ai = await generateJson({
      taskType: "orchestration_plan",
      systemPrompt: getAgentorySystemPrompt({
        taskType: "planning",
        currentAgent: "pilot",
        companyBrain: companyBrain as Record<string, unknown> | null,
        actorRegistrySummary: summarizeRegistryForPrompt(),
      }),
      messages: [{ role: "user", content: orchestratorPrompt }],
      temperature: 0.3,
      maxTokens: 2048,
      functionName: "orchestrate",
      workspaceId: workspace_id,
      onModelCall: modelCalls.sink,
      budget: modelCalls,
    });

    // ── AND INTO THE LEDGER ────────────────────────────────────────────────
    //
    // `logProviderCall` immediately below is NOT accounting: it writes
    // `activity_feed`, which has no tokens and no cost, while the workspace
    // ceiling sums `lead_model_calls`. The planner call is a 2048-token
    // orchestration plan on every instruction and reported nothing.
    //
    // Drained here, before the plan is even parsed: a plan this call failed to
    // produce has still been billed.
    try {
      const rows = await modelCalls.drain(createLedgerWriter(admin as never), {
        workspace_id, task_id: null, plan_id: null,
        logical_call_key: `orchestrate:${workspace_id}:${Date.now()}:model`,
      });
      if (rows > 0) console.log("[orchestrate][model-ledger]", { workspace_id, rows });
    } catch (e) {
      console.warn("[orchestrate][model-ledger] drain failed:", e);
    }

    await logProviderCall(admin, {
      workspace_id,
      function_name: "orchestrate",
      task_type: "orchestration_plan",
      provider: ai.provider,
      model: ai.model,
      success: ai.ok,
      latency_ms: ai.latencyMs,
      error_code: ai.errorCode,
      prompt_version: AGENTORY_SYSTEM_PROMPT_VERSION,
    });

    if (ai.ok && ai.json) {
      const p = ai.json as { plan_summary?: string; steps?: any[] };
      if (p && Array.isArray(p.steps) && p.steps.length > 0) {
        const normalized: Step[] = p.steps
          .map((s: any, i: number): Step | null => {
            const slug = normalizeSlug(s?.agent_slug);
            if (!slug) return null;
            const desc =
              (typeof s.task_description === "string" && s.task_description.trim()) ||
              (typeof s.instruction === "string" && s.instruction.trim()) ||
              user_instruction;
            const title = (typeof s.task_title === "string" && s.task_title.trim()) || `${KNOWN_AGENTS[slug]} step`;
            const tool = (typeof s.tool_needed === "string" ? s.tool_needed : null) as ToolName;
            const approval = s.requires_approval === true || s.needs_approval === true || tool === "send_email";
            return {
              step_index: typeof s.step_index === "number" ? s.step_index : i,
              agent_slug: slug,
              agent_name: KNOWN_AGENTS[slug],
              task_title: title,
              task_description: desc,
              instruction: desc,
              capability: typeof s.capability === "string" ? s.capability : undefined,
              tool_needed: tool,
              expected_output: typeof s.expected_output === "string" ? s.expected_output : "",
              success_criteria: typeof s.success_criteria === "string" ? s.success_criteria : "",
              requires_approval: approval,
              needs_approval: approval,
              planner_source: "ai",
            };
          })
          .filter((s): s is Step => s !== null);
        if (normalized.length > 0) {
          parsed = { plan_summary: p.plan_summary || `Plan for: ${user_instruction}`, steps: normalized };
          plannerSource = "ai";
        }
      }
    } else {
      console.warn("[orchestrate] AI planner unavailable, falling back:", ai.error);
    }

    if (!parsed) parsed = fallbackPlan(user_instruction, intent);

    // Deterministic expansion (only when not using staged plan).
    parsed.steps = expandPlan(user_instruction, intent, parsed.steps);

    } // end AI planner branch

    // Safety: source_and_qualify_only strips every Penn / outreach / drafting /
    // publishing step from the plan (whatever added it — AI planner, fallback, or
    // staged), so the runtime cannot generate outreach. Applied to ALL plan paths.
    const modeStripped = filterPlanForMode(parsed!.steps as Step[], executionMode);
    parsed!.steps = modeStripped.steps;
    if (modeStripped.removed.length) {
      console.log("[orchestrate] source_and_qualify_only removed steps", modeStripped.removed);
    }

    // Tool availability annotation.
    const connectorsMissing = annotateTools(parsed!.steps);

    console.log("[orchestrate] plan ready", {
      source: plannerSource,
      intent,
      execution_mode: executionMode,
      steps: parsed!.steps.length,
      agents: parsed!.steps.map((s) => s.agent_slug),
      tools: parsed!.steps.map((s) => s.tool_needed),
      connectors_missing: connectorsMissing,
    });

    // ---- QUALIFIED-LEAD PLANNING, BEFORE PERSISTENCE ------------------------
    //
    // The plan the user sees used to be the generic "Scout sources signals, Aria
    // ranks signals" template, persisted here, with Claude called LATER inside
    // run-agent where it could only rewrite an internal keyword list. So the plan
    // on screen never described the actual mission and never reflected anything
    // Claude decided.
    //
    // Planning now happens BEFORE the insert, and what is persisted is what was
    // validated. TIGHTLY GATED: only a qualified-Lead route, only when the
    // existing Claude-first flag AND the workspace allow-list both pass. Every
    // other workflow reaches the unchanged insert below.
    //
    // ── AND NOT FOR A MISSION THAT WAS ALREADY APPROVED ───────────────────
    //
    // This is the Claude lead planner. It is a second planning model, and for
    // an approved mission there is nothing left to plan: the capability graph
    // above IS the plan, and it is the one the preview showed and the engine
    // executes. Running this would let a model re-decide the steps AFTER the
    // user pressed Start on a different set of them.
    const qlPlan = plannerSource === "capability_graph" ? null : await planQualifiedLeadBeforePersistence({
      // The Supabase client's generic type is deeper than the brain loader's
      // structural contract; the loader only ever reads one table.
      admin: admin as never, workspaceId: workspace_id, userInstruction: user_instruction ?? "",
      toolInput: (tool_input as Record<string, unknown> | null) ?? null,
      fallbackSteps: parsed!.steps as unknown as Array<Record<string, unknown>>,
      fallbackSummary: parsed!.plan_summary,
      // R2: the compiled Mission is the semantic authority for the strategy
      // adapter's constraints. Without this the adapter re-derived
      // no-broadening and the required signal terms from jobSearchSpec's regex
      // reading — a second answer to a question the compiler had already
      // settled from the raw sentence.
      leadMission: isLeadMissionV1(lead_mission) ? lead_mission : null,
    });

    // WHAT THE USER IS TOLD MUST BE WHAT WAS PLANNED.
    //
    // `qlPlan` is already authoritative for `task_plans` and for the run-agent
    // kickoff below. It was NOT authoritative for this function's response, which
    // pilot-chat announces the plan from — so a qualified-Lead mission persisted a
    // four-step plan and simultaneously told the user it had made the generic
    // two-step one. Persistence is untouched; only what we hand back changes.
    // With no qualified-Lead plan this IS `parsed`, so nothing else moves.
    const responsePlan = buildOrchestrateResponsePlan(qlPlan, parsed!);

    // ── WHICH PLANNER OWNS THIS LEAD TASK, STATED ONCE ─────────────────────
    //
    // `planQualifiedLeadBeforePersistence` above is the SAME Claude adapter
    // run-agent can invoke. Only one of them may own a task, and the mechanism
    // that guarantees it is the artifact threaded on the kickoff body below:
    // when `qualified_lead_plan` is present, run-agent's selector resolves to
    // `persisted_plan_artifact_v1` and invokes no adapter at all.
    //
    // That mechanism was implicit — a reader had to notice the artifact was
    // threaded, and cross-reference a selector 1,500 lines away in another
    // function, to know a second plan was impossible. Naming the owner here makes
    // it a recorded fact on the plan, and gives the orchestrate layer the same
    // one-row answer to "which planner planned this task?" that run-agent now has.
    const leadPlanningOwner: string | null = qlPlan
      ? "claude_lead_planner_v1@orchestrate"
      : isLeadMissionV1(lead_mission)
      ? "delegated_to_run_agent_selector"
      : null;
    if (leadPlanningOwner) {
      console.log("[orchestrate][planner-owner]", {
        workspace_id,
        planning_owner: leadPlanningOwner,
        artifact_threaded: qlPlan !== null,
        intelligence_mode: orchestrateIntelligence.mode,
      });
    }

    // Persist task_plan.
    const { data: taskPlan, error: planError } = await admin
      .from("task_plans")
      .insert({
        workspace_id,
        user_id: userId,
        created_by: userId,
        goal: user_instruction,
        user_instruction,
        plan_summary: qlPlan?.summary ?? parsed!.plan_summary,
        steps: qlPlan?.steps ?? parsed!.steps,
        status: "executing",
        // The database makes the collision: `task_plans_idempotency_uniq`.
        ...(startKey ? { idempotency_key: startKey } : {}),
      })
      .select("id")
      .single();

    // ── TWO STARTS THAT BOTH PASSED THE CHECK ABOVE ─────────────────────
    //
    // 23505 is the unique index doing its job: another request created this
    // Start's plan between the lookup and this insert. Answer with that plan,
    // and return before the enqueue below — the race must not become a second
    // mission any more than the repeat could.
    if (startKey && (planError as { code?: string } | null)?.code === "23505") {
      const raced = await findStartedPlan(admin, workspace_id, startKey);
      if (raced) {
        console.log("[orchestrate][start-idempotency] racing Start collapsed", {
          workspace_id, plan_id: raced.plan_id, idempotency_key: startKey,
        });
        return json(duplicateStartBody(raced, startKey));
      }
    }

    if (planError || !taskPlan) {
      console.error("[orchestrate] task_plan_insert_failed:", planError);
      return json({ error: "task_plan_insert_failed", details: planError?.message }, 500);
    }

    // Phase A routing — persona / company profile / signal / role family, and
    // account_first vs profile_first. Threaded to run-agent as `lead_routing`
    // (authoritative), and recorded on the plan for traceability. Pure / no
    // provider call.
    //
    // ── PROJECTED FROM THE MISSION, NOT RE-READ FROM THE SENTENCE ──────────
    //
    // This used to call `separateIntent(user_instruction)`, which ran its own
    // persona table, signal phrase list and role-family matcher over the user's
    // words — a second semantic reading of a sentence the Mission had already
    // interpreted, whose answer then travelled downstream as "authoritative"
    // routing. `separatedIntentFromMission` produces the same DTO from fields
    // the Mission decided and parses nothing.
    //
    // `lead_mission` is always a LeadMissionV1 here: either the compiled one
    // that arrived, or — for an explicitly deterministic workspace — the one
    // derived above. There is no branch in which this re-reads the sentence.
    const missionForRouting = isLeadMissionV1(lead_mission) ? lead_mission : null;
    const leadRouting = ((intent === "sourcing" || intent === "extraction") && missionForRouting)
      ? (() => {
          const si = separatedIntentFromMission(missionForRouting, {
            hardExclusions: (tool_input as { disqualifiers?: string[] } | null)?.disqualifiers ?? undefined,
          });
          return {
            source_strategy: si.source_strategy,
            decision_maker_strategy: si.decision_maker_strategy,
            requested_role_family: si.requested_role_family,
            requested_signal: si.requested_signal,
            target_personas: si.target_personas,
            relaxation_policy: si.relaxation_policy,
          };
        })()
      : null;

    await admin.from("activity_feed").insert({
      workspace_id,
      plan_id: taskPlan.id,
      event_type: "plan_created",
      title: "Plan created",
      body: responsePlan.plan_summary,
      metadata: {
        total_steps: responsePlan.steps.length,
        conversation_id,
        planner: plannerSource,
        // Null for every non-lead workflow, so unrelated plans are unchanged.
        ...(leadPlanningOwner ? { lead_planning_owner: leadPlanningOwner } : {}),
        provider: ai?.provider ?? "staged",
        model: ai?.model ?? "n/a",
        intent,
        execution_mode: executionMode,
        agents: responsePlan.steps.map((s) => s.agent_slug),
        tools_required: responsePlan.steps.map((s) => s.tool_needed).filter(Boolean),
        connectors_missing: connectorsMissing,
        tool_input: tool_input ?? null,
        lead_routing: leadRouting,
        source_and_qualify_only: isSourceAndQualifyOnly(executionMode),
        mode_removed_steps: modeStripped.removed,
      },
    });

    // Kick off first step (non-blocking).
    const firstStep = parsed!.steps[0];
    // DETERMINISTIC route from the user's own words — authoritative over the
    // planner/template, exactly as pilot-chat decides it.
    // THE MISSION DECIDES THE ROUTE. This used to be
    // `routeQualifiedLead(user_instruction)` — a phrase table re-reading the
    // sentence to decide whether the user had asked for people to contact, after
    // the Mission had already stated what they asked to RECEIVE. The two could
    // disagree on the same words, and the kickoff body then carried the phrase
    // table's answer as `workflow_kind` / `count_entity` / `quota_policy`.
    const qlRoute = missionForRouting
      ? qualifiedLeadRouteFromMission(missionForRouting)
      : routeQualifiedLead(user_instruction ?? "");
    const qualifiedLead = qlRoute.workflowKind === "qualified_lead_sourcing";
    // THE COUNT COMES FROM THE MISSION, NOT FROM A SECOND READING OF THE
    // SENTENCE. This used to be `extractRequestedLeadCount(user_instruction) ?? 5`
    // — a regex quota that could differ from the count the Mission recorded, on
    // the same words, with the run then executing to the regex's number.
    // `effectiveRequestedCount` is the ONE place a default is applied, and the
    // Mission keeps the honest answer about whether the user asked for a number.
    const qualifiedLeadCount = missionForRouting
      ? effectiveRequestedCount(missionForRouting)
      : DEFAULT_REQUESTED_COUNT;

    // ── THE RUN BUDGET: THE CALLER'S, OR THE FUNDING SCREEN'S DEFAULT ─────
    //
    // Nothing in the product sent `run_budget`, so the funding screen — which
    // exists only under one — never ran for a real user (architecture audit,
    // 2026-09-25). A screen-eligible Lead V2 mission now gets the default
    // ($0.14 and 2 candidates per lead, 1–2 leads), decided by the SAME graph,
    // readiness and pricing run-agent will execute under. Every other mission
    // gets none and runs exactly as before; a caller's own budget always wins.
    const callerRunBudget = parseRunBudget((body as Record<string, unknown>).run_budget);
    const screenDefault: DefaultScreenBudget | null = !callerRunBudget && missionForRouting
      ? (() => {
        const read = (k: string) => Deno.env.get(k);
        const readiness = readinessPolicyFor(workspace_id, read);
        const executability = executabilityGateFor(workspace_id, read);
        const criteria = deriveMissionCriteria(missionForRouting, readiness);
        return defaultScreenRunBudget({
          leadV2: executability === "enforce",
          entryCapability: buildCapabilityGraph(missionForRouting, { executability, readiness }).entry_capability,
          criteria,
          requestedCount: effectiveRequestedCount(missionForRouting),
          downstream_verifiers_usd: screenDownstreamVerifiersUsd(missionForRouting, criteria, read),
        });
      })()
      : null;
    const kickoffBudget = kickoffRunBudget(callerRunBudget, screenDefault);
    console.log("[orchestrate][run-budget]", {
      workspace_id, source: kickoffBudget.source, run_budget: kickoffBudget.budget,
      default_reason: screenDefault?.reason ?? null,
      screen: screenDefault?.plan
        ? { first_rows: screenDefault.plan.first_rows, topup_rows: screenDefault.plan.topup_rows,
            screen_max: screenDefault.plan.screen_max, admit: screenDefault.plan.admit,
            worst_case_usd: screenDefault.plan.worst_case_usd }
        : null,
    });

    // THE HANDOFF STAYS IN THE BACKGROUND, BUT IS NO LONGER SILENT.
    //
    // It cannot be awaited — run-agent runs the whole step, Actor calls
    // included, and holding this request open for that would turn a slow
    // success into a 504. What it CAN stop being is invisible. See
    // _shared/backgroundInvoke.ts: the call is registered with the Edge Runtime
    // so the isolate is not torn down before the request is sent, and a
    // rejected handoff is now observed instead of resolving quietly into a
    // `.catch` that HTTP errors never reach.
    const kickoffBody: Record<string, unknown> = {
        plan_id: taskPlan.id,
        step_index: 0,
        agent_slug: firstStep.agent_slug,
        workspace_id,
        user_id: userId,
        instruction: firstStep.instruction,
        input: user_instruction,
        needs_approval: firstStep.requires_approval === true,
        tool_needed: firstStep.tool_needed,
        // Per-step tool_input wins (lets step 0 use a different tool than the
        // plan default, e.g. discovery's Hawk-scrape step 0 before Scout-apify).
        tool_input: (firstStep as Step & { metadata?: { tool_input?: unknown } }).metadata?.tool_input ?? tool_input ?? null,
        execution_mode: qualifiedLead ? "company_first" : executionMode,
        lead_routing: leadRouting,
        // THE RUN'S OWN BUDGET, carried to whichever executor takes the step —
        // the edge function or, through the queue, the worker. Re-validated by
        // run-agent; tighten-only either way (runBudget.ts).
        // …or, when none was sent, the funding screen's default (see above).
        ...(kickoffBudget.budget ? { run_budget: kickoffBudget.budget } : {}),
        // QUALIFIED-LEAD ROUTE. run-agent's company-first branch needs (a) an
        // unpinned actor so it compiles the entity intent itself, and (b) the
        // FINAL-LEAD quota. Without these the request silently degrades to the
        // legacy account-signal path (the 2026-07-26 manual-run defect).
        ...(qualifiedLead
          ? {
              workflow_kind: "qualified_lead_sourcing",
              requested_lead_count: qualifiedLeadCount,
              quota_policy: "contact_only",
              count_entity: "contact_ready_lead",
            }
          : {}),
        // THE PLAN IS ALREADY MADE. Passing the validated artifact is what stops
        // run-agent planning the same mission a second time — one initial planner
        // request per run, and the strategy that executes is the one on screen.
        ...(qlPlan ? { qualified_lead_plan: qlPlan.artifact } : {}),
        // AT THE TOP LEVEL TOO. `readPersistedBindings` checks the body before
        // the step's `tool_input`, so the sidecar arrives whether or not the
        // branch that built this step happened to spread the original input.
        ...(bindingsCarrier ?? {}),
    };

    // ── LEADMISSION V2 ROUTE — THE SMALLEST POSSIBLE ──────────────────────────
    //
    // Two conditions, both required; V1 is what happens otherwise:
    //
    //   1. the workspace is named in LEAD_V2_WORKER_WORKSPACES, and
    //   2. this kickoff really is an approved LeadMission step
    //
    // Condition 2 uses `validateV2KickoffBody` — the SAME validator
    // `enqueue-lead-mission` applies — so orchestrate cannot hand the queue
    // something the enqueue would reject, and the two can never disagree about
    // what is eligible. A Content, monitoring, outreach or plain agent step fails
    // it and goes to run-agent exactly as before.
    //
    // ONLY THE DESTINATION CHANGES. The body is the same object either way, so
    // the worker replays byte-for-byte what the edge path would have sent.
    const v2Route = resolveLeadExecutionEngine(workspace_id, (k) => Deno.env.get(k)) === "v2_worker"
      && validateV2KickoffBody(kickoffBody).ok;
    if (v2Route) {
      console.log("[orchestrate][kickoff] routing to LeadMission V2 worker", {
        plan_id: taskPlan.id, workspace_id,
      });
    }

    invokeInBackground({
      // WHERE, asked rather than assumed — see functionEndpoints.ts. Each
      // destination moves to the Railway API independently of the other.
      url: functionUrl(v2Route ? "enqueue-lead-mission" : "run-agent", (k) => Deno.env.get(k)),
      token: SUPABASE_SERVICE_ROLE_KEY,
      log: (m, meta) => console.error("[orchestrate][kickoff]", m, meta),
      // enqueue takes the kickoff under `request`; run-agent takes it directly.
      body: v2Route ? { request: kickoffBody } : kickoffBody,
      // A PLAN MUST NEVER SIT IN `executing` WITH NOTHING RUNNING.
      //
      // Nothing else writes to `task_plans` until run-agent takes ownership, so
      // if the handoff does not land this is the ONLY chance to record it. Three
      // live runs stalled here and left a plan that the UI reported as
      // "preparing the workflow" indefinitely; a failed row is worse news and
      // far better behaviour, because it can be seen and retried.
      onFailure: async (failure) => {
        const reason = describeFailure(failure);
        await admin.from("task_plans")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", taskPlan.id);
        await admin.from("activity_feed").insert({
          workspace_id,
          plan_id: taskPlan.id,
          event_type: "plan_failed",
          title: "Workflow could not be started",
          body: reason,
          metadata: { stage: "run_agent_kickoff", failure },
        });
      },
    });

    return json({
      success: true,
      plan_id: taskPlan.id,
      task_plan_id: taskPlan.id,
      plan_summary: responsePlan.plan_summary,
      total_steps: responsePlan.steps.length,
      steps_count: responsePlan.steps.length,
      planner: plannerSource,
      intent,
      execution_mode: executionMode,
      agents: responsePlan.steps.map((s) => s.agent_slug),
      connectors_missing: connectorsMissing,
      plan: responsePlan,
    });
  } catch (err) {
    console.error("[orchestrate] unexpected:", err);
    return json({ error: "internal_error", details: String(err) }, 500);
  }
}

export { handleOrchestrate };

// ── THE SERVER STARTS UNLESS AN IN-PROCESS CALLER IS IMPORTING THIS MODULE ──
//
// The same guard, for the same reason, as run-agent and pilot-chat: the Railway
// API imports this handler and mounts it on a route, and a second `Deno.serve`
// in that process would fight the API's own listener for the port. An explicit
// opt-out that the edge deployment never sets cannot fail the way
// `import.meta.main` can if the runtime ever loads this file as a dependency.
if (!Deno.env.get("ORCHESTRATE_IMPORT_ONLY")) Deno.serve(withBuildStamp((req) => handleOrchestrate(req)));
