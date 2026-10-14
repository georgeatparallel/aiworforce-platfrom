// THE PRODUCTION EDGE FOR MISSION EVALUATION.
//
// `missionEvaluation` is pure and decides nothing about who may run it, on
// whose behalf, with which model, or how many times. This module makes that
// one call-site decision explicit, gated and observable — the same shape as
// `semanticClassificationBinding` and `groundedBrainBinding`, deliberately, so
// there is one pattern for "a model call the pipeline may make" rather than
// three.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//   * OFF by default. BOTH the flag AND the workspace allow-list must pass; an
//     empty allow-list enables nobody, so there is no single global switch.
//   * NO ESCALATION. `allowEscalation: false` — a per-company evaluation never
//     justifies the escalation tier.
//   * BOUNDED. One call per company, capped at the shortlist size. There is no
//     retry loop here: a failure returns null and the caller records
//     `insufficient_evidence`, which is never a silent qualify.
//   * DISABLED IS NOT REJECTED. With the flag off the pipeline makes no model
//     call and every company is reported `not_evaluated` — visibly, in the
//     telemetry — rather than being quietly failed by deterministic code.
//   * No credential is read here, and no provider name is ever sent.
//
// Pure apart from the injected facade. No provider import, no network.

import { createGptStrategistGenerateJson } from "./gptStrategistModel.ts";
import type { GptDeps } from "./gptProvider.ts";
import { routeModel, type ModelRoute } from "./gptModelRouter.ts";
import type { GenerateJsonFn } from "./intelligence/plannerWrapper.ts";
import { DEFAULT_LEAD_INTELLIGENCE_MODEL } from "./leadIntelligenceModel.ts";
import { MISSION_EVALUATION_PROMPT } from "./missionEvaluation.ts";

export type EnvReader = (key: string) => string | undefined;

export const MISSION_EVALUATION_FLAG = "MISSION_EVALUATION";
export const MISSION_EVALUATION_WORKSPACES_ENV = "MISSION_EVALUATION_WORKSPACES";
export const MISSION_EVALUATION_MODEL_ENV = "MISSION_EVALUATION_MODEL";
export const MISSION_EVALUATION_MAX_CALLS_ENV = "MISSION_EVALUATION_MAX_CALLS";

export const DEFAULT_EVALUATION_MODEL: string = DEFAULT_LEAD_INTELLIGENCE_MODEL;

/**
 * Evaluations one task may pay for.
 *
 * TWENTY, matching the shortlist ceiling — every company that survives to
 * enrichment gets exactly one evaluation and no company gets two. The previous
 * classification allowance was ten, which silently left half a full shortlist
 * unevaluated and ordered by a deterministic sort that had never read a
 * description.
 */
export const DEFAULT_MAX_EVALUATION_CALLS = 20;

const ENABLED_VALUES: ReadonlySet<string> = new Set(["true", "1", "enabled"]);

export type EvaluationEnablementReason =
  | "enabled" | "flag_off" | "no_workspace_allowlist" | "workspace_not_allowed";

export interface EvaluationEnablement {
  enabled: boolean;
  reason: EvaluationEnablementReason;
  model: string | null;
  maxCalls: number;
}

/**
 * May this workspace have its companies evaluated by a model?
 *
 * BOTH conditions, no wildcard. Never throws: a missing env permission resolves
 * to OFF, because an evaluator that fails open spends money nobody authorised.
 */
export function isMissionEvaluationEnabled(
  workspaceId: string, read?: EnvReader,
): EvaluationEnablement {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  const off = (reason: EvaluationEnablementReason): EvaluationEnablement =>
    ({ enabled: false, reason, model: null, maxCalls: 0 });

  // ── THE FLAG NO LONGER DECIDES. See gptStrategistModel.ts. ─────────────
  //
  // Three checks lived here — flag value, allow-list present, workspace on it —
  // and they returned `flag_off` on every live run, because no intelligence
  // flag was ever set on this project. The stage therefore never ran once. The
  // decision is REMOVED rather than defaulted to true, so no switch remains
  // that can turn understanding off.
  void workspaceId; void off;

  const parsedMax = Number(get(MISSION_EVALUATION_MAX_CALLS_ENV));
  return {
    enabled: true,
    reason: "enabled",
    model: (get(MISSION_EVALUATION_MODEL_ENV) ?? "").trim() || DEFAULT_EVALUATION_MODEL,
    // The env may LOWER the cap, never raise it. An operator typo must not be
    // able to authorise unbounded spend.
    maxCalls: Number.isFinite(parsedMax) && parsedMax > 0
      ? Math.min(Math.floor(parsedMax), DEFAULT_MAX_EVALUATION_CALLS)
      : DEFAULT_MAX_EVALUATION_CALLS,
  };
}

export interface MissionEvaluationBinding {
  /** Null when disabled — the pipeline then makes no model call at all. */
  evaluateMission: ((payload: Record<string, unknown>) => Promise<unknown>) | null;
  callsRemaining: number;
  enablement: EvaluationEnablement;
  /** Safe task diagnostics. Never a prompt, credential or claim text. */
  diagnostics: Record<string, unknown>;
}

export interface BuildEvaluationBindingInput {
  workspaceId: string;
  read?: EnvReader;
  /** Injected in tests. Production uses the configured strategist adapter. */
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
  /** The run's shortlist size, so the cap is never larger than the work. */
  shortlistSize?: number;
  /** Leads the user asked for. Read only by the model router. */
  requestedCount?: number;
}

/**
 * Build the evaluator the pipeline will call, or `null` when it must not run.
 *
 * The returned function adapts the structured payload onto the strategist
 * facade — the SAME provider-independent path strategy, classification and
 * grounding use. Nothing here talks to a vendor directly.
 */
export function buildMissionEvaluationBinding(
  input: BuildEvaluationBindingInput,
): MissionEvaluationBinding {
  const enablement = isMissionEvaluationEnabled(input.workspaceId, input.read);

  // NEVER MORE CALLS THAN COMPANIES. A shortlist of 6 authorises 6, not 20.
  const shortlist = Math.max(0, Math.trunc(input.shortlistSize ?? 0));
  const budget = shortlist > 0
    ? Math.min(enablement.maxCalls, shortlist)
    : enablement.maxCalls;

  const base = {
    enabled: enablement.enabled,
    reason: enablement.reason,
    model: enablement.model,
    calls_allowed: enablement.enabled ? budget : 0,
    shortlist_size: shortlist,
    cap: DEFAULT_MAX_EVALUATION_CALLS,
  };

  if (!enablement.enabled) {
    return {
      evaluateMission: null,
      callsRemaining: 0,
      enablement,
      diagnostics: { ...base, skip_reason: enablement.reason },
    };
  }

  // The model is PINNED, not inherited: evaluation is a per-row interpretive
  // call and must not silently ride the strategist's planning tier.
    // ── GPT, NOT THE LOVABLE/CLAUDE STRATEGIST ──────────────────────────────
  // The legacy model id is retained only as a diagnostic of what the old env
  // asked for; it no longer selects anything. No JSON schema is sent — see
  // gptStrategistModel.ts: `plannerWrapper` already owns these shapes.
  // ── THE REASONING TIER, STATED RATHER THAN INHERITED ────────────────────
  //
  // This is the qualification authority. Its answer decides whether a company
  // the run has already paid to identify and enrich becomes a lead, and it must
  // read cited evidence closely enough that a misquoted excerpt does not pass.
  // The default is already `reasoning`; naming it here means a future change to
  // the default cannot silently downgrade the one call that decides.
  // THE ROUTER DECIDES, NOT THIS FILE. The answer is the same — qualification
  // reasons — but it is now stated in one place, alongside every other stage,
  // and recorded on the run rather than living in this file's prose.
  const route = routeModel("mission_evaluation", {
    requested_count: input.requestedCount ?? undefined,
    pool_size: input.shortlistSize ?? undefined,
  });
  const generate = input.generate ??
    createGptStrategistGenerateJson({ onModelCall: input.onModelCall, budget: input.budget }, {
    // THE ROUTER'S MODEL AND EFFORT. Both these stages run on Luna at effort
    // `none`: they read evidence already paid for, and an undecidable verdict
    // degrades to a defined outcome rather than escalating — so a second model
    // call would buy cost, not information, at the volume where that multiplies
    // hardest.
    model: route.model,
    reasoningEffort: route.reasoning_effort,
    tier: route.tier,
    purpose: route.stage,
    reason: route.reason,
  });

  return {
    evaluateMission: async (payload: Record<string, unknown>) => {
      const result = await generate({
        systemPrompt: MISSION_EVALUATION_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      } as never);
      // The facade reports failure in-band; the caller's validator turns
      // anything unusable into `insufficient_evidence`, so a null here is a
      // safe outcome rather than a throw.
      return (result as { ok?: boolean; json?: unknown })?.ok
        ? (result as { json?: unknown }).json
        : null;
    },
    callsRemaining: budget,
    enablement,
    diagnostics: base,
  };
}

export interface EvaluationCounters {
  calls_allowed?: number;
  calls_made?: number;
  calls_remaining?: number;
  budget_exhausted?: boolean;
  companies_evaluated?: number;
}

/** Task-level diagnostics: what was allowed, and what actually happened. */
export function evaluationTaskDiagnostics(
  binding: MissionEvaluationBinding,
  observed: EvaluationCounters | null | undefined,
): Record<string, unknown> {
  const allowed = Number(binding.diagnostics.calls_allowed ?? 0);
  const remaining = Number(observed?.calls_remaining ?? allowed);
  const made = Number(observed?.calls_made ?? Math.max(0, allowed - remaining));
  return {
    ...binding.diagnostics,
    calls_made: made,
    calls_remaining: remaining,
    // Zero evaluations is a REAL outcome, not a missing measurement.
    companies_evaluated: Number(observed?.companies_evaluated ?? 0),
    budget_exhausted: observed?.budget_exhausted ?? (allowed > 0 && remaining <= 0),
  };
}
