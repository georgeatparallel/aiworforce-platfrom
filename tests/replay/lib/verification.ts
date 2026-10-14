// LEAD V2 REPLAY LAB — REPLAY THE VERIFICATION PHASE FROM A CHECKPOINT.
//
// Wires the production verification phase exactly as run-agent does
// (`verifierSpecFor` → `ledgerBoundCall` + `ledgerAffordability`, the production
// spec compiler, the guarded invoker, `verifiableCandidatesFrom`,
// `missionHiringVerifier`, `applyVerifierFinding`, `markRouteUnaffordable`).
// The only substitution is the provider behind the guarded invoker.
//
// This file is glue, not logic: every decision it reports was made by a
// production function. If run-agent's wiring changes, the source-shape test in
// tests/replay/invariants/providerSpec.test.ts fails until this follows.

import { buildClaimPlan } from "../../../supabase/functions/_shared/claimPlan.ts";
import {
  ledgerBoundCall, type LedgerCallDeps, type PendingVerifierRun, type VerifierCall,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import type { VerificationStopGate } from "../../../supabase/functions/_shared/verificationStop.ts";
import { type Gate, missionHiringVerifier, phaseGate, verifiableCandidatesFrom } from "./prod.ts";
import {
  runClaimVerificationPhase, type VerificationPhaseReport,
} from "../../../supabase/functions/_shared/claimVerificationPhase.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { hashInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import {
  applyVerifierFinding, canonicalQualifiedKeys, type EngineCompany, markRouteUnaffordable, missionCandidatesFrom,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { requiredEvidenceDimensions } from "../../../supabase/functions/_shared/evidenceGraph.ts";
import { anchorForCapability } from "../../../supabase/functions/_shared/retrievalPlan.ts";
import { buildWorkbenchMissionView, type WorkbenchMissionView } from "../../../supabase/functions/_shared/workbenchMissionView.ts";
import { effectiveRequestedCount, type LeadMissionV1, missionHash } from "../../../supabase/functions/_shared/leadMission.ts";
import { guardedInvoker } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { deriveMissionCriteria, type MissionCriterion } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { readinessPolicyFor } from "../../../supabase/functions/_shared/routeReadiness.ts";
import type { SpendLedger } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { verifierSpecCompiler } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import type { ReplayFixture } from "./fixture.ts";
import { FixtureProvider, noNetwork } from "./provider.ts";
import { companiesAt, ledgerAt } from "./state.ts";

export interface TraceEvent { type: string; [k: string]: unknown }

export interface VerificationReplay {
  phase: VerificationPhaseReport;
  ledger: SpendLedger;
  /** The ledger before the phase ran — what the decision was made against. */
  ledgerBefore: SpendLedger;
  companies: EngineCompany[];
  criteria: MissionCriterion[];
  provider: FixtureProvider;
  trace: TraceEvent[];
  /** Every preflight the phase asked, with the call it compiled. */
  preflights: Array<{ call: VerifierCall; result: Gate | null }>;
  deps: LedgerCallDeps;
  mission: LeadMissionV1;
}

/** Production readiness with no probe and no experimental routes. */
export const replayReadiness = () => readinessPolicyFor("<workspace>", () => undefined);

export async function replayVerificationAt(
  fx: ReplayFixture, checkpoint: string,
  opts: {
    verifiers?: "hiring";
    /** The slice's stop (`verificationStopGate`), as run-agent passes it. Absent: never stops. */
    stop?: VerificationStopGate;
    /**
     * Resume from what an earlier replay left — its companies, ledger and the
     * pending runs it carried — instead of the checkpoint's: the next slice.
     */
    resume?: { companies: EngineCompany[]; ledger: SpendLedger; pending: PendingVerifierRun[] };
    /** Replace the fixture's provider responses (a `pending_once` variant). */
    responses?: ReplayFixture["provider_responses"];
  } = {},
): Promise<VerificationReplay> {
  noNetwork();
  const cp = fx.checkpoints[checkpoint];
  if (!cp) throw new Error(`fixture ${fx.fixture} has no checkpoint ${checkpoint}`);
  const readiness = replayReadiness();
  const mission = fx.mission as unknown as LeadMissionV1;
  const criteria = deriveMissionCriteria(mission, readiness);
  const companies = opts.resume ? structuredClone(opts.resume.companies) : companiesAt(fx, checkpoint);
  const run = { companies };
  const ledger = opts.resume ? structuredClone(opts.resume.ledger) : ledgerAt(fx, cp.at);
  const ledgerBefore = structuredClone(ledger);
  const provider = new FixtureProvider(opts.responses ?? fx.provider_responses);
  const trace: TraceEvent[] = [];
  const missionId = fx.provenance.task_id;

  // ── run-agent's `verifierDepsFor`, with the provider swapped ──────────────
  const deps: LedgerCallDeps = {
    ledger,
    spec: verifierSpecCompiler({
      scope: { workspace_id: "<workspace>", lineage_id: missionId },
      mission_hash: await missionHash(mission),
      policy: criteriaExecutionPolicy(mission),
      ceilings: () => ledger.ceilings,
      readiness,
      plan: null,
    }),
    actorIdFor: (actorKey) => hiringActorCard(actorKey)?.actor_id ?? null,
    invoke: guardedInvoker(null, (call) => provider.invoke(call), undefined, readiness),
    hash: (input, actorKey) => hashInput(input, actorKey),
    trace: (type, detail) => { trace.push({ type, ...detail }); },
  };
  const preflights: VerificationReplay["preflights"] = [];
  const byKey = (k: string) => companies.find((c) => c.key === k);

  const hiring = missionHiringVerifier(mission, criteria);
  if (opts.verifiers !== "hiring" || !hiring) throw new Error("only the open-role verifier replay is wired yet");

  const phase = await runClaimVerificationPhase({
    mission_id: missionId,
    claim_plan: buildClaimPlan(criteria, "general_company_discovery", readiness),
    requested_count: effectiveRequestedCount(mission),
    candidates: () => verifiableCandidatesFrom(run, criteria, missionId),
    qualified: () => canonicalQualifiedKeys(companies, {
      mission, plan: { entry_capability: "general_company_discovery" }, identity: { task_id: missionId },
    }).length,
    criteriaValue: (id) => criteria.find((c) => c.id === id)?.value ?? null,
    criteriaWindow: (id) => criteria.find((c) => c.id === id)?.time_window?.days ?? null,
    verifiers: [hiring],
    readiness,
    pending: structuredClone(opts.resume ? opts.resume.pending : cp.verifier_pending_runs),
    deps: { call: ledgerBoundCall(deps), now: () => cp.at, log: (event, meta) => trace.push({ type: `log:${event}`, ...(meta ?? {}) }) },
    apply: (f, v) => { const c = byKey(f.company_key); return c ? applyVerifierFinding(c, f, v) : false; },
    ...phaseGate(deps, (call, result) => { preflights.push({ call, result }); }),
    markUnaffordable: (key, v) => { const c = byKey(key); if (c) markRouteUnaffordable(c, v); },
    ...(opts.stop ? { stop: opts.stop } : {}),
    log: (event, meta) => trace.push({ type: `phase:${event}`, ...(meta ?? {}) }),
  });
  return { phase, ledger, ledgerBefore, companies, criteria, provider, trace, preflights, deps, mission };
}

/**
 * The canonical P5 view as run-agent builds it at the end of a slice (minus the
 * model reasoner, which only proposes labels). `evidence_gaps.with_executable_route`
 * is what continuation reads as `verificationRoutesRemain`.
 */
export function canonicalView(
  run: { companies: readonly EngineCompany[] }, mission: LeadMissionV1, missionId: string,
  entryCapability = "general_company_discovery",
): WorkbenchMissionView {
  const criteria = deriveMissionCriteria(mission);
  const candidates = missionCandidatesFrom(run, {
    missionId,
    required: requiredEvidenceDimensions(
      criteriaExecutionPolicy(mission), (mission.required_signals ?? []).map((sig) => String(sig.type))),
  });
  return buildWorkbenchMissionView({
    mission: { requested_count: effectiveRequestedCount(mission), execution_limit: null, anchor: anchorForCapability(entryCapability) ?? null },
    criteria, candidates, stage: "completing_evidence",
  });
}
