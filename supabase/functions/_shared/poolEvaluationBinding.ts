// THE PRODUCTION EDGE FOR FULL-POOL EVALUATION AND RANKING.
//
// Two SEPARATE flags, because they are two separate risks.
//
//   FULL_POOL_GROUNDED_EVALUATION  changes how many companies are assessed and
//   how they are batched. It costs model calls and changes coverage. It does
//   not, by itself, change the order anything appears in.
//
//   GPT_POOL_RANKING               changes what the user sees FIRST. Its shadow
//   mode exists for the same reason the grounded Brain's did: you want to read
//   what a semantic ordering would have done before it starts deciding which
//   company somebody calls this afternoon.
//
// Coupling them into one switch would mean the first real batch run and the
// first reordered Workbench arrive together, with one rollback between them.
//
// SAFETY
//   * OFF by default; both a flag AND a workspace allow-list must pass.
//   * An empty allow-list enables nobody.
//   * `enforce` must be spelled exactly; anything else observes.
//   * Batch size and evaluation ceiling come from `resolveBatchLimits`, never
//     from the request body.
//   * A ranking failure returns null and the deterministic order ships.
//
// Pure apart from the injected facade. No provider import, no network.

import { routeModel } from "./gptModelRouter.ts";
import { createGptStrategistGenerateJson } from "./gptStrategistModel.ts";
import type { GptDeps } from "./gptProvider.ts";
import type { GenerateJsonFn } from "./intelligence/plannerWrapper.ts";
import {
  buildBatchPayload, evaluateBatchResponse, resolveBatchLimits,
  BATCH_EVALUATION_PROMPT, type BatchLimits, type BatchMember, type BatchResult,
} from "./groundedBatchEvaluation.ts";
import {
  buildPoolRankingPayload, validatePoolRanking, POOL_RANKING_PROMPT,
  type GroundedCandidateSummary, type ValidatedRanking,
} from "./poolRanking.ts";
import { DEFAULT_LEAD_INTELLIGENCE_MODEL } from "./leadIntelligenceModel.ts";

export type EnvReader = (key: string) => string | undefined;

export const FULL_POOL_FLAG = "FULL_POOL_GROUNDED_EVALUATION";
export const FULL_POOL_WORKSPACES_ENV = "FULL_POOL_GROUNDED_EVALUATION_WORKSPACES";
export const FULL_POOL_BATCH_SIZE_ENV = "FULL_POOL_GROUNDED_EVALUATION_BATCH_SIZE";
export const FULL_POOL_MAX_ENV = "FULL_POOL_GROUNDED_EVALUATION_MAX";

export const POOL_RANKING_FLAG = "GPT_POOL_RANKING";
export const POOL_RANKING_WORKSPACES_ENV = "GPT_POOL_RANKING_WORKSPACES";
export const POOL_RANKING_MODE_ENV = "GPT_POOL_RANKING_MODE";
export const POOL_RANKING_MODEL_ENV = "GPT_POOL_RANKING_MODEL";

export const DEFAULT_POOL_MODEL: string = DEFAULT_LEAD_INTELLIGENCE_MODEL;

const ENABLED: ReadonlySet<string> = new Set(["true", "1", "enabled"]);

export type RankingMode = "shadow" | "enforce";
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

export interface FullPoolEnablement {
  enabled: boolean;
  reason: EnablementReason;
  limits: BatchLimits;
}

export function isFullPoolEvaluationEnabled(
  workspaceId: string, read?: EnvReader,
): FullPoolEnablement {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  const reason = gate(workspaceId, FULL_POOL_FLAG, FULL_POOL_WORKSPACES_ENV, get);
  // LIMITS ARE RESOLVED FROM THE SERVER ENVIRONMENT ONLY, and clamped — a
  // misconfigured value can make evaluation smaller, never unbounded.
  const limits = resolveBatchLimits({
    batch_size: Number(get(FULL_POOL_BATCH_SIZE_ENV)),
    max_evaluated: Number(get(FULL_POOL_MAX_ENV)),
  });
  return { enabled: reason === "enabled", reason, limits };
}

export interface PoolRankingEnablement {
  enabled: boolean;
  reason: EnablementReason;
  mode: RankingMode;
  model: string | null;
}

export function isPoolRankingEnabled(
  workspaceId: string, read?: EnvReader,
): PoolRankingEnablement {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  const reason = gate(workspaceId, POOL_RANKING_FLAG, POOL_RANKING_WORKSPACES_ENV, get);
  const mode: RankingMode =
    String(get(POOL_RANKING_MODE_ENV) ?? "").trim().toLowerCase() === "enforce"
      ? "enforce" : "shadow";
  return {
    enabled: reason === "enabled",
    reason,
    mode,
    model: reason === "enabled"
      ? ((get(POOL_RANKING_MODEL_ENV) ?? "").trim() || DEFAULT_POOL_MODEL)
      : null,
  };
}

// ─────────────────────────────────────────────── model-operation budget ──

export interface ModelAccounting {
  evaluation_batches_attempted: number;
  companies_evaluated: number;
  ranking_calls_attempted: number;
  completed_calls: number;
  failed_calls: number;
  restored_calls: number;
}

export function newModelAccounting(): ModelAccounting {
  return {
    evaluation_batches_attempted: 0, companies_evaluated: 0,
    ranking_calls_attempted: 0, completed_calls: 0, failed_calls: 0,
    restored_calls: 0,
  };
}

export interface PoolBinding {
  /** Null when full-pool evaluation is off. */
  evaluateBatch: ((batch: readonly BatchMember[]) => Promise<BatchResult | null>) | null;
  /** Null when ranking is off. */
  rankPool:
    | ((i: {
      summaries: readonly GroundedCandidateSummary[];
      requestedCount: number;
      unevaluatedCount: number;
    }) => Promise<ValidatedRanking | null>)
    | null;
  rankingMode: RankingMode;
  limits: BatchLimits;
  accounting: ModelAccounting;
  diagnostics: Record<string, unknown>;
}

export function buildPoolBinding(input: {
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
  originalUserQuery: string | null;
  missionDirectives?: Record<string, unknown> | null;
  groundingThreshold?: number;
  allowReview?: boolean;
  allowWatch?: boolean;
}): PoolBinding {
  const pool = isFullPoolEvaluationEnabled(input.workspaceId, input.read);
  const rank = isPoolRankingEnabled(input.workspaceId, input.read);
  const accounting = newModelAccounting();

  const diagnostics = {
    full_pool: { enabled: pool.enabled, reason: pool.reason, limits: pool.limits },
    ranking: { enabled: rank.enabled, reason: rank.reason, mode: rank.mode, model: rank.model },
  };

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
    // by omission, invisible in the cost trace, for batch qualification.
    const route = routeModel("pool_evaluation");
    return {
      model: route.model, reasoningEffort: route.reasoning_effort,
      tier: route.tier, purpose: route.stage, reason: route.reason,
    };
  })());

  return {
    rankingMode: rank.mode,
    limits: pool.limits,
    accounting,
    diagnostics,
    evaluateBatch: pool.enabled
      ? async (batch) => {
        accounting.evaluation_batches_attempted++;
        try {
          const res = await generate({
            systemPrompt: BATCH_EVALUATION_PROMPT,
            messages: [{
              role: "user",
              content: JSON.stringify(buildBatchPayload({
                batch,
                originalUserQuery: input.originalUserQuery,
                missionDirectives: input.missionDirectives ?? null,
              })),
            }],
          } as never);
          const raw = (res as { ok?: boolean; json?: unknown })?.ok
            ? (res as { json?: unknown }).json : null;
          if (raw === null) { accounting.failed_calls++; return null; }
          const out = evaluateBatchResponse({
            batch, raw,
            ...(input.groundingThreshold != null
              ? { groundingThreshold: input.groundingThreshold } : {}),
          });
          accounting.completed_calls++;
          accounting.companies_evaluated += out.evaluated;
          return out;
        } catch {
          // A THROW COSTS ONE BATCH, NOT THE RUN. The companies in it are
          // recorded unevaluated and the next batch proceeds.
          accounting.failed_calls++;
          return null;
        }
      }
      : null,
    rankPool: rank.enabled
      ? async ({ summaries, requestedCount, unevaluatedCount }) => {
        accounting.ranking_calls_attempted++;
        try {
          const res = await generate({
            systemPrompt: POOL_RANKING_PROMPT,
            messages: [{
              role: "user",
              content: JSON.stringify(buildPoolRankingPayload({
                originalUserQuery: input.originalUserQuery,
                requestedCount, summaries, unevaluatedCount,
                allowReview: input.allowReview,
                allowWatch: input.allowWatch,
                missionDirectives: input.missionDirectives ?? null,
              })),
            }],
          } as never);
          const raw = (res as { ok?: boolean; json?: unknown })?.ok
            ? (res as { json?: unknown }).json : null;
          accounting.completed_calls++;
          // `validatePoolRanking` falls back internally on a null or unusable
          // answer, so this always returns a usable ordering.
          return validatePoolRanking({ raw, summaries, requestedCount });
        } catch {
          accounting.failed_calls++;
          return null;
        }
      }
      : null,
  };
}
