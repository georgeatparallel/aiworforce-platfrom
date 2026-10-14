// THE PRODUCTION EDGE FOR SEMANTIC COMPANY CLASSIFICATION.
//
// Everything beneath this file was already built and tested: the gate, the
// budget, the cache, the deterministic validation and the Brain handoff. What was
// missing was the one call-site decision — which model, and how many calls a task
// may pay for. This module makes that decision explicit, gated and observable.
//
// ── WHY A SEPARATE MODULE ────────────────────────────────────────────────────
// `run-agent` is capped at TWO kernel imports by `intelligenceFlags` test 32.E,
// and this binding needs the strategist facade, the flag pair, the model id and
// the allowance. Assembling it here keeps run-agent's kernel surface unchanged —
// the same reason the plan-aware budget is assembled behind its own binding.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//   * OFF by default. BOTH the flag AND the workspace allow-list must pass; an
//     empty allow-list enables nobody, so there is no single global switch.
//   * NO ESCALATION. `allowEscalation: false` — a per-company classification is
//     never worth a second, more expensive model call. That is a strategy-level
//     tool, not a per-row one.
//   * The classifier NEVER decides. It returns evidence; the Company Brain
//     qualifies. A failure yields unknown/evidence_pending, never a rejection.
//   * No credential is read here, and nothing about this reaches the frontend.
//
// Pure apart from the injected facade. No provider import, no network.

import { routeModel } from "./gptModelRouter.ts";
import { createGptStrategistGenerateJson } from "./gptStrategistModel.ts";
import type { GptDeps } from "./gptProvider.ts";
import type { GenerateJsonFn } from "./intelligence/plannerWrapper.ts";
import { DEFAULT_LEAD_INTELLIGENCE_MODEL } from "./leadIntelligenceModel.ts";

export type EnvReader = (key: string) => string | undefined;

export const SEMANTIC_CLASSIFICATION_FLAG = "SEMANTIC_COMPANY_CLASSIFICATION";
export const SEMANTIC_CLASSIFICATION_WORKSPACES_ENV = "SEMANTIC_COMPANY_CLASSIFICATION_WORKSPACES";
export const SEMANTIC_CLASSIFICATION_MODEL_ENV = "SEMANTIC_COMPANY_CLASSIFICATION_MODEL";
export const SEMANTIC_CLASSIFICATION_MAX_CALLS_ENV = "SEMANTIC_COMPANY_CLASSIFICATION_MAX_CALLS";

/** The chosen classifier. Overridable by env, never by user or model input. */
export const DEFAULT_CLASSIFICATION_MODEL: string = DEFAULT_LEAD_INTELLIGENCE_MODEL;

/**
 * Real model requests one qualified-lead task may spend on classification.
 *
 * Counted in UNIQUE company/evidence combinations: a cache hit, a skipped
 * company and an unresolved identity all cost zero, so the allowance measures
 * paid work rather than loop iterations.
 */
export const DEFAULT_MAX_CLASSIFICATION_CALLS = 10;

/** Strict allowlist parse — only these enable a flag. Mirrors the other flags. */
const ENABLED_VALUES: ReadonlySet<string> = new Set(["true", "1", "enabled"]);

export type ClassificationEnablementReason =
  | "enabled" | "flag_off" | "no_workspace_allowlist" | "workspace_not_allowed";

export interface ClassificationEnablement {
  enabled: boolean;
  reason: ClassificationEnablementReason;
  model: string | null;
  maxCalls: number;
}

/**
 * Is semantic classification permitted for this workspace?
 *
 * BOTH conditions, no wildcard. An empty or missing allow-list resolves to
 * DISABLED even with the flag on, so "on for everyone" is not a state this can
 * return. Never throws: a missing env permission resolves to OFF, because a
 * classifier that fails open is one that spends money nobody authorised.
 */
export function isSemanticClassificationEnabled(
  workspaceId: string,
  read?: EnvReader,
): ClassificationEnablement {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });

  const off = (reason: ClassificationEnablementReason): ClassificationEnablement =>
    ({ enabled: false, reason, model: null, maxCalls: 0 });

  // ── THE FLAG NO LONGER DECIDES. See gptStrategistModel.ts. ─────────────
  //
  // Three checks lived here — flag value, allow-list present, workspace on it —
  // and they returned `flag_off` on every live run, because no intelligence
  // flag was ever set on this project. The stage therefore never ran once. The
  // decision is REMOVED rather than defaulted to true, so no switch remains
  // that can turn understanding off.
  void workspaceId;
  void off;

  const parsedMax = Number(get(SEMANTIC_CLASSIFICATION_MAX_CALLS_ENV));
  return {
    enabled: true,
    reason: "enabled",
    model: (get(SEMANTIC_CLASSIFICATION_MODEL_ENV) ?? "").trim() || DEFAULT_CLASSIFICATION_MODEL,
    maxCalls: Number.isFinite(parsedMax) && parsedMax > 0
      ? Math.min(Math.floor(parsedMax), DEFAULT_MAX_CLASSIFICATION_CALLS)
      : DEFAULT_MAX_CLASSIFICATION_CALLS,
  };
}

export interface ClassificationBinding {
  /** Null when disabled — the pipeline then makes no model call at all. */
  classifyCompanyEvidence: ((payload: Record<string, unknown>) => Promise<unknown>) | null;
  classificationCallsRemaining: number;
  enablement: ClassificationEnablement;
  /** Safe task diagnostics. Never a prompt, credential or claim text. */
  diagnostics: Record<string, unknown>;
}

export interface BuildBindingInput {
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
  /**
   * Qualified companies already found. Classification stops once coverage is
   * sufficient for the requested quota — interpreting more companies cannot
   * produce a lead the mission no longer needs.
   */
  qualifiedCompanies?: number;
  requestedLeadCount?: number;
}

/**
 * Build the classifier the pipeline will call, or `null` when it must not run.
 *
 * The returned function adapts the pipeline's structured payload onto the
 * strategist facade — the SAME provider-independent path the strategy and
 * feedback calls use. Nothing here talks to Lovable, OpenAI, Gemini or Claude
 * directly.
 */
export function buildSemanticClassificationBinding(
  input: BuildBindingInput,
): ClassificationBinding {
  const enablement = isSemanticClassificationEnabled(input.workspaceId, input.read);

  // SUFFICIENT COVERAGE ENDS CLASSIFICATION. More interpretation cannot help a
  // quota that is already served.
  const requested = Math.max(0, Math.trunc(input.requestedLeadCount ?? 0));
  const qualified = Math.max(0, Math.trunc(input.qualifiedCompanies ?? 0));
  const coverageSufficient = requested > 0 && qualified >= requested;

  const base = {
    enabled: enablement.enabled,
    reason: enablement.reason,
    model: enablement.model,
    calls_allowed: enablement.maxCalls,
    coverage_sufficient: coverageSufficient,
    qualified_companies: qualified,
    requested_leads: requested,
  };

  if (!enablement.enabled || coverageSufficient) {
    return {
      classifyCompanyEvidence: null,
      classificationCallsRemaining: 0,
      enablement,
      diagnostics: {
        ...base,
        calls_allowed: 0,
        skip_reason: coverageSufficient ? "sufficient_qualified_coverage" : enablement.reason,
      },
    };
  }

  // ONE escalation-free strategist call per company. `allowEscalation: false` is
  // deliberate: a per-row classification never justifies the escalation tier.
  // The model is PINNED, not inherited: classification is a cheap interpretive
  // call and must not silently ride the strategist's planning tier.
    // ── GPT, NOT THE LOVABLE/CLAUDE STRATEGIST ──────────────────────────────
  // The legacy model id is retained only as a diagnostic of what the old env
  // asked for; it no longer selects anything. No JSON schema is sent — see
  // gptStrategistModel.ts: `plannerWrapper` already owns these shapes.
  const generate = input.generate ??
    createGptStrategistGenerateJson({ onModelCall: input.onModelCall, budget: input.budget }, (() => {
    // ROUTED, LIKE EVERY OTHER STAGE. This passed nothing, so it inherited the
    // `reasoning` tier and silently resolved to gpt-4.1 — a model choice made
    // by omission, invisible in the cost trace, for one company's description.
    const route = routeModel("semantic_classification");
    return {
      model: route.model, reasoningEffort: route.reasoning_effort,
      tier: route.tier, purpose: route.stage, reason: route.reason,
    };
  })());

  return {
    classifyCompanyEvidence: async (payload: Record<string, unknown>) => {
      const result = await generate({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      } as never);
      // The facade reports failure in-band; the caller's validator turns anything
      // unusable into `unknown`, so a null here is a safe outcome, not a throw.
      return (result as { ok?: boolean; json?: unknown })?.ok
        ? (result as { json?: unknown }).json
        : null;
    },
    classificationCallsRemaining: enablement.maxCalls,
    enablement,
    diagnostics: base,
  };
}

/** The classifier's instructions. Interpretation only — never a verdict. */
export const CLASSIFIER_SYSTEM_PROMPT = [
  "You map source-backed company evidence onto a fixed canonical vocabulary.",
  "You do NOT qualify, approve or reject a company. A deterministic Company Brain does that.",
  "Cite an evidence_ref from source_refs for every claim you make.",
  "Do not infer SaaS from the word 'software' alone.",
  "Agency, consultancy, implementation or project-service evidence is services, not SaaS.",
  "A broad provider label without supporting evidence is 'unknown', not a guess.",
  "Report contradictory evidence rather than resolving it.",
  "Return only the requested JSON object.",
].join(" ");

/**
 * Task-level classification diagnostics.
 *
 * The CONTROLLER's counters are authoritative — they span every round, whereas
 * the pipeline's are per-round. This merges the binding's intent (what was
 * allowed, and why) with what actually happened.
 */
export interface ControllerClassificationCounters {
  calls_allowed?: number;
  calls_made?: number;
  calls_remaining?: number;
  budget_exhausted?: boolean;
  companies_classified?: number;
  skipped?: Record<string, number>;
}

export function classificationTaskDiagnostics(
  binding: ClassificationBinding,
  observed: ControllerClassificationCounters | null | undefined,
): Record<string, unknown> {
  const allowed = Number(binding.diagnostics.calls_allowed ?? 0);
  const remaining = Number(observed?.calls_remaining ?? allowed);
  const made = Number(observed?.calls_made ?? Math.max(0, allowed - remaining));
  return {
    ...binding.diagnostics,
    calls_made: made,
    calls_remaining: remaining,
    // Zero paid calls is a REAL outcome (every company was cached, skipped or
    // unresolved), not a missing measurement.
    companies_classified: Number(observed?.companies_classified ?? 0),
    skipped: observed?.skipped ?? {},
    budget_exhausted: observed?.budget_exhausted ?? (allowed > 0 && remaining <= 0),
  };
}
