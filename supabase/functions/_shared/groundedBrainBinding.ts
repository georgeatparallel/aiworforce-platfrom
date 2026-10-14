// THE PRODUCTION EDGE FOR THE GROUNDED COMPANY BRAIN.
//
// `groundedClaims` and `leadEvidenceRegistry` are pure and were proven in
// isolation. This is the only place that decides whether the grounded
// classifier runs at all, for whom, and whether its verdict is allowed to
// CHANGE anything.
//
// ── THREE STATES, AND THE MIDDLE ONE IS THE POINT ───────────────────────────
//
//   DISABLED  nothing changes. The legacy classifier decides, exactly as today.
//
//   SHADOW    the grounded classifier runs, its claims are verified, and the
//             comparison is persisted — but the user-facing decision is still
//             the legacy one. This is how you find out what enforcing WOULD do
//             before it does it, on real evidence, at the cost of one extra
//             model call per company.
//
//   ENFORCE   the verified grounded verdict controls the Brain and the
//             Workbench.
//
// Going straight to enforce would change what qualifies on the same day the
// grounding code first meets real provider output. Shadow separates "does the
// verifier behave sanely on live evidence" from "does the product now qualify
// different companies", which are two different questions and two different
// rollbacks.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
//   * OFF by default. BOTH a flag AND a workspace allow-list must pass; an
//     empty allow-list enables nobody, so there is no global switch.
//   * NO BUDGET INCREASE. It reuses the classification allowance rather than
//     adding one — see `maxCalls` in the caller.
//   * A model failure returns null, which the engine reads as "not grounded"
//     and holds for REVIEW. It never becomes a rejection.
//   * No credential is read here, and no provider name is ever sent.
//
// Pure apart from the injected facade. No provider import, no network.

import { routeModel } from "./gptModelRouter.ts";
import { createGptStrategistGenerateJson } from "./gptStrategistModel.ts";
import type { GptDeps } from "./gptProvider.ts";
import type { GenerateJsonFn } from "./intelligence/plannerWrapper.ts";
import {
  buildGroundedClassifierPayload, parseGroundedResult, verifyGroundedResult,
  GROUNDED_CLASSIFIER_PROMPT,
  type GroundedVerification,
} from "./groundedClaims.ts";
import { DEFAULT_LEAD_INTELLIGENCE_MODEL } from "./leadIntelligenceModel.ts";
import type { EvidenceRegistry } from "./leadEvidenceRegistry.ts";

export type EnvReader = (key: string) => string | undefined;

export const GROUNDED_BRAIN_FLAG = "GROUNDED_COMPANY_BRAIN";
export const GROUNDED_BRAIN_WORKSPACES_ENV = "GROUNDED_COMPANY_BRAIN_WORKSPACES";
export const GROUNDED_BRAIN_MODE_ENV = "GROUNDED_COMPANY_BRAIN_MODE";
export const GROUNDED_BRAIN_MODEL_ENV = "GROUNDED_COMPANY_BRAIN_MODEL";
export const GROUNDED_BRAIN_THRESHOLD_ENV = "GROUNDED_COMPANY_BRAIN_THRESHOLD";

export const DEFAULT_GROUNDED_MODEL: string = DEFAULT_LEAD_INTELLIGENCE_MODEL;

const ENABLED_VALUES: ReadonlySet<string> = new Set(["true", "1", "enabled"]);

export type GroundingMode = "shadow" | "enforce";

export type GroundedEnablementReason =
  | "enabled" | "flag_off" | "no_workspace_allowlist" | "workspace_not_allowed";

export interface GroundedEnablement {
  enabled: boolean;
  reason: GroundedEnablementReason;
  /** `shadow` unless explicitly set to enforce. Defaulting to enforce would
   *  make a typo in the mode variable change what qualifies. */
  mode: GroundingMode;
  model: string | null;
  threshold: number;
}

export const DEFAULT_THRESHOLD = 0.6;

/**
 * May this workspace have its companies judged on grounded evidence?
 *
 * Never throws. A missing env permission resolves to OFF, and an unrecognised
 * mode resolves to SHADOW — the two failure directions that cannot silently
 * change a customer's results.
 */
export function isGroundedBrainEnabled(
  workspaceId: string, read?: EnvReader,
): GroundedEnablement {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  const off = (reason: GroundedEnablementReason): GroundedEnablement =>
    ({ enabled: false, reason, mode: "shadow", model: null, threshold: DEFAULT_THRESHOLD });

  // ── THE FLAG NO LONGER DECIDES. See gptStrategistModel.ts. ─────────────
  //
  // Three checks lived here — flag value, allow-list present, workspace on it —
  // and they returned `flag_off` on every live run, because no intelligence
  // flag was ever set on this project. The stage therefore never ran once. The
  // decision is REMOVED rather than defaulted to true, so no switch remains
  // that can turn understanding off.
  void workspaceId; void off;

  // ENFORCE MUST BE SPELLED EXACTLY. Anything else observes.
  const mode: GroundingMode =
    String(get(GROUNDED_BRAIN_MODE_ENV) ?? "").trim().toLowerCase() === "enforce"
      ? "enforce" : "shadow";

  const t = Number(get(GROUNDED_BRAIN_THRESHOLD_ENV));
  return {
    enabled: true,
    reason: "enabled",
    mode,
    model: (get(GROUNDED_BRAIN_MODEL_ENV) ?? "").trim() || DEFAULT_GROUNDED_MODEL,
    threshold: Number.isFinite(t) && t > 0 && t <= 1 ? t : DEFAULT_THRESHOLD,
  };
}

export interface GroundedBrainBinding {
  /** Null when disabled — no grounded model call is made at all. */
  groundCompany:
    | ((i: { registry: EvidenceRegistry; requiresCommercialSignal: boolean })
      => Promise<GroundedVerification | null>)
    | null;
  /** `enforce` only when explicitly configured. */
  mode: GroundingMode;
  enablement: GroundedEnablement;
  /** Safe task diagnostics. Never a prompt, credential or raw model output. */
  diagnostics: Record<string, unknown>;
}

export interface BuildGroundedBindingInput {
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
  originalUserQuery: string | null;
  missionDirectives?: Record<string, unknown> | null;
  /** Reuses the EXISTING classification allowance. Never adds to it. */
  callsRemaining?: number;
}

export function buildGroundedBrainBinding(
  input: BuildGroundedBindingInput,
): GroundedBrainBinding {
  const enablement = isGroundedBrainEnabled(input.workspaceId, input.read);
  const base = {
    enabled: enablement.enabled,
    reason: enablement.reason,
    mode: enablement.mode,
    model: enablement.model,
    threshold: enablement.threshold,
  };

  if (!enablement.enabled) {
    return { groundCompany: null, mode: "shadow", enablement, diagnostics: base };
  }

    // ── GPT, NOT THE LOVABLE/CLAUDE STRATEGIST ──────────────────────────────
  // The legacy model id is retained only as a diagnostic of what the old env
  // asked for; it no longer selects anything. No JSON schema is sent — see
  // gptStrategistModel.ts: `plannerWrapper` already owns these shapes.
  const generate = input.generate ??
    createGptStrategistGenerateJson({ onModelCall: input.onModelCall, budget: input.budget }, (() => {
    // ROUTED, LIKE EVERY OTHER STAGE. This passed nothing, so it inherited the
    // `reasoning` tier and silently resolved to gpt-4.1 — a model choice made
    // by omission, invisible in the cost trace, for grounded evidence reading.
    const route = routeModel("grounded_evidence_evaluation");
    return {
      model: route.model, reasoningEffort: route.reasoning_effort,
      tier: route.tier, purpose: route.stage, reason: route.reason,
    };
  })());

  // THE SAME BUDGET, NOT AN EXTRA ONE. When the shared allowance is spent the
  // binding stops calling and the company is held for review — a grounded run
  // must not cost more than an ungrounded one was permitted to.
  let remaining = Math.max(0, Math.trunc(input.callsRemaining ?? 0));

  return {
    mode: enablement.mode,
    enablement,
    diagnostics: base,
    groundCompany: async (i) => {
      if (remaining <= 0) return null;
      remaining--;
      try {
        const payload = buildGroundedClassifierPayload({
          registry: i.registry,
          originalUserQuery: input.originalUserQuery,
          missionDirectives: input.missionDirectives ?? null,
          requiresCommercialSignal: i.requiresCommercialSignal,
        });
        const res = await generate({
          systemPrompt: GROUNDED_CLASSIFIER_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(payload) }],
        } as never);
        const raw = (res as { ok?: boolean; json?: unknown })?.ok
          ? (res as { json?: unknown }).json
          : null;
        // A NULL ANSWER IS NOT A PASS. `parseGroundedResult` turns anything
        // unusable into `review` / `unknown`, and the verifier then refuses to
        // let an unsupported verdict stand — so a model failure degrades to
        // REVIEW rather than to a decision nobody can justify.
        if (raw === null) return null;
        const parsed = parseGroundedResult(raw);
        return verifyGroundedResult({
          registry: i.registry,
          result: parsed,
          requiresCommercialSignal: i.requiresCommercialSignal,
          groundingThreshold: enablement.threshold,
        });
      } catch {
        // A THROW MUST NOT COST A COMPANY. Null is read as "not grounded".
        return null;
      }
    },
  };
}

// ───────────────────────────────────────────────── the shadow comparison ──

export interface ShadowComparison {
  company_key: string;
  legacy_decision: string;
  grounded_decision: string;
  legacy_confidence: number;
  grounded_confidence: number;
  grounding_score: number;
  rejected_claim_count: number;
  validated_claim_count: number;
  disagreement: boolean;
  disagreement_reason: string | null;
  /** Would the user have seen something different under enforce? */
  user_facing_would_change: boolean;
}

/**
 * What enforcing WOULD have done, recorded without doing it.
 *
 * Bounded and structured: counts, verdicts and one short reason. No claim text,
 * no model prose, and nothing resembling chain-of-thought — this is a decision
 * record, not a transcript.
 */
export function buildShadowComparison(i: {
  companyKey: string;
  legacyOutcome: string;
  legacyConfidence: number;
  grounded: GroundedVerification | null;
}): ShadowComparison {
  const g = i.grounded;
  const groundedDecision = g ? g.final_grounded_decision : "unavailable";
  // The legacy outcome is QUALIFIED/REVIEW/REJECT; the grounded one is
  // pass/review/fail. Compare them on the same axis rather than by string.
  const legacyAxis = i.legacyOutcome === "QUALIFIED" ? "pass"
    : i.legacyOutcome === "REJECT" ? "fail" : "review";
  const disagreement = g !== null && legacyAxis !== groundedDecision;

  return {
    company_key: i.companyKey,
    legacy_decision: i.legacyOutcome,
    grounded_decision: groundedDecision,
    legacy_confidence: Number(i.legacyConfidence.toFixed(4)),
    grounded_confidence: g
      ? Number((g.classifier_result.confidence * g.grounding_score).toFixed(4)) : 0,
    grounding_score: g?.grounding_score ?? 0,
    rejected_claim_count: g?.rejected_claims.length ?? 0,
    validated_claim_count: g?.validated_claims.length ?? 0,
    disagreement,
    disagreement_reason: !g
      ? "grounded_classifier_unavailable"
      : disagreement
      ? (g.downgrade_reasons[0] ?? `${legacyAxis}_vs_${groundedDecision}`)
      : null,
    user_facing_would_change: disagreement,
  };
}
