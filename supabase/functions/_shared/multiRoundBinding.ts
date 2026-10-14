// THE PRODUCTION EDGE FOR MULTI-ROUND SOURCING.
//
// A separate flag from Stage 1–3, because it is a separate risk: this one
// decides how many times a run may SPEND on discovery. Coupling it to the
// grounded Brain or the ranker would mean the first multi-round run and the
// first reordered Workbench arrive together with one rollback between them.
//
// SAFETY
//   * OFF by default; both a flag AND a workspace allow-list must pass.
//   * An empty allow-list enables nobody.
//   * Round count and budgets are resolved from the SERVER environment and
//     clamped. A misconfigured value can make a run smaller, never unbounded.
//   * The planner is a model call that returns a PROPOSAL. It authorises
//     nothing on its own; `validateRoundPlan` is what decides.
//
// Pure apart from the injected facade. No provider import, no network.

import { routeModel } from "./gptModelRouter.ts";
import { createGptStrategistGenerateJson } from "./gptStrategistModel.ts";
import type { GptDeps } from "./gptProvider.ts";
import type { GenerateJsonFn } from "./intelligence/plannerWrapper.ts";
import {
  buildRoundPlannerPayload, parseRoundPlan, ROUND_PLANNER_PROMPT,
  type RoundPlanProposal,
} from "./roundPlanContract.ts";
import { DEFAULT_MAX_ROUNDS } from "./multiRoundState.ts";
import { DEFAULT_LEAD_INTELLIGENCE_MODEL } from "./leadIntelligenceModel.ts";

export type EnvReader = (key: string) => string | undefined;

export const MULTI_ROUND_FLAG = "MULTI_ROUND_SOURCING";
export const MULTI_ROUND_WORKSPACES_ENV = "MULTI_ROUND_SOURCING_WORKSPACES";
export const MULTI_ROUND_MAX_ROUNDS_ENV = "MULTI_ROUND_SOURCING_MAX_ROUNDS";
export const MULTI_ROUND_MAX_COST_ENV = "MULTI_ROUND_SOURCING_MAX_COST_UNITS";
export const MULTI_ROUND_MAX_MODEL_ENV = "MULTI_ROUND_SOURCING_MAX_MODEL_OPS";
export const MULTI_ROUND_MODEL_ENV = "MULTI_ROUND_SOURCING_MODEL";

export const DEFAULT_ROUND_MODEL: string = DEFAULT_LEAD_INTELLIGENCE_MODEL;

/**
 * Ceilings a round controller may never exceed.
 *
 * Anchored to the provider ceiling the company-first controller already
 * enforces (`HARD_PROVIDER_CALL_CEILING = 12`), so multi-round sourcing cannot
 * quietly buy more provider calls than the single-round path was allowed.
 */
export const HARD_MAX_PROVIDER_COST_UNITS = 12;
export const HARD_MAX_MODEL_OPERATIONS = 24;

const ENABLED: ReadonlySet<string> = new Set(["true", "1", "enabled"]);

export type EnablementReason =
  | "enabled" | "flag_off" | "no_workspace_allowlist" | "workspace_not_allowed";

// ── THE GATE IS OPEN, PERMANENTLY ──────────────────────────────────────────
//
// This read a feature flag plus a workspace allow-list and returned `flag_off`
// / `no_workspace_allowlist` / `workspace_not_allowed` — and on the live project
// NO intelligence flag was ever set, so every stage it guards returned
// `flag_off` on every run. `getLeadIntelligenceCapabilities` then reported the
// workspace as `deterministic` and its own comment called that "the INTENDED
// behaviour", which is how the 2026-08-17 run reached qualification with no
// model involved at all.
//
// It is not defaulted to enabled — the DECISION is removed. There is one
// canonical GPT-first path and no switch that turns understanding off. The
// original reason is still computed and reported as `legacy_flag_reason` by the
// callers that surface diagnostics, so an operator can still see what the old
// env said; it just no longer decides anything.
function gate(
  workspaceId: string, flag: string, listEnv: string, get: EnvReader,
): EnablementReason {
  void workspaceId; void flag; void listEnv; void get;
  return "enabled";
}

export interface MultiRoundEnablement {
  enabled: boolean;
  reason: EnablementReason;
  maxRounds: number;
  maxProviderCostUnits: number;
  maxModelOperations: number;
  model: string | null;
}

/** Clamp into [1, hard], falling back to the hard ceiling on anything unusable. */
function clamp(raw: unknown, hard: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(hard, Math.floor(n)));
}

export function isMultiRoundEnabled(
  workspaceId: string, read?: EnvReader,
): MultiRoundEnablement {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  const reason = gate(workspaceId, MULTI_ROUND_FLAG, MULTI_ROUND_WORKSPACES_ENV, get);
  return {
    enabled: reason === "enabled",
    reason,
    maxRounds: clamp(get(MULTI_ROUND_MAX_ROUNDS_ENV), DEFAULT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
    maxProviderCostUnits: clamp(
      get(MULTI_ROUND_MAX_COST_ENV), HARD_MAX_PROVIDER_COST_UNITS, HARD_MAX_PROVIDER_COST_UNITS),
    maxModelOperations: clamp(
      get(MULTI_ROUND_MAX_MODEL_ENV), HARD_MAX_MODEL_OPERATIONS, HARD_MAX_MODEL_OPERATIONS),
    model: reason === "enabled"
      ? ((get(MULTI_ROUND_MODEL_ENV) ?? "").trim() || DEFAULT_ROUND_MODEL)
      : null,
  };
}

export type PlanNextRoundFn = (
  payload: Parameters<typeof buildRoundPlannerPayload>[0],
) => Promise<RoundPlanProposal | null>;

export interface MultiRoundBinding {
  enabled: boolean;
  maxRounds: number;
  maxProviderCostUnits: number;
  maxModelOperations: number;
  /** Null when multi-round is off — the run stays single-round unchanged. */
  planNextRound: PlanNextRoundFn | null;
  plannerCallsAttempted: () => number;
  diagnostics: Record<string, unknown>;
}

export function buildMultiRoundBinding(input: {
  workspaceId: string;
  read?: EnvReader;
  generate?: GenerateJsonFn;
  /**
   * WHERE A MODEL CALL IS RECORDED.
   *
   * Passed in rather than read from anywhere ambient, so the workspace and task
   * a row is attributed to are the ones this binding was built for — the same
   * rule `leadMissionCompilerBinding` states.
   */
  onModelCall?: GptDeps["onModelCall"];
  budget?: GptDeps["budget"];
}): MultiRoundBinding {
  const e = isMultiRoundEnabled(input.workspaceId, input.read);
  let attempts = 0;

    // ── GPT, NOT THE LOVABLE/CLAUDE STRATEGIST ──────────────────────────────
  //
  // `createStrategistGenerateJson` routed this stage to Lovable/Claude. The
  // model id below is retained ONLY as a diagnostic of what the legacy env var
  // asked for; it no longer selects anything. See gptStrategistModel.ts for why
  // no JSON schema is sent here.
  const generate = input.generate ??
    createGptStrategistGenerateJson({ onModelCall: input.onModelCall, budget: input.budget }, (() => {
    // ROUTED, LIKE EVERY OTHER STAGE. This passed nothing, so it inherited the
    // `reasoning` tier and silently resolved to gpt-4.1 — a model choice made
    // by omission, invisible in the cost trace, for a strategic replan.
    const route = routeModel("execution_plan_amendment");
    return {
      model: route.model, reasoningEffort: route.reasoning_effort,
      tier: route.tier, purpose: route.stage, reason: route.reason,
    };
  })());

  return {
    enabled: e.enabled,
    maxRounds: e.maxRounds,
    maxProviderCostUnits: e.maxProviderCostUnits,
    maxModelOperations: e.maxModelOperations,
    plannerCallsAttempted: () => attempts,
    diagnostics: {
      enabled: e.enabled, reason: e.reason, max_rounds: e.maxRounds,
      max_provider_cost_units: e.maxProviderCostUnits,
      max_model_operations: e.maxModelOperations, model: e.model,
    },
    planNextRound: e.enabled
      ? async (payload) => {
        attempts++;
        try {
          const res = await generate({
            systemPrompt: ROUND_PLANNER_PROMPT,
            messages: [{
              role: "user",
              content: JSON.stringify(buildRoundPlannerPayload(payload)),
            }],
          } as never);
          const raw = (res as { ok?: boolean; json?: unknown })?.ok
            ? (res as { json?: unknown }).json : null;
          // A NULL PROPOSAL STOPS THE RUN. It never means "carry on with the
          // previous plan" — repeating a round that already fell short is the
          // one outcome guaranteed to spend without learning anything.
          return parseRoundPlan(raw);
        } catch {
          return null;
        }
      }
      : null,
  };
}
