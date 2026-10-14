// LEAD V2 REPLAY LAB — A LINEAGE'S SLICES, END TO END, WITH THE ENGINE IN THE LOOP.
//
// `runGoldenMission` (lib/mission.ts) drives whole missions whose hard criteria
// carry no business-model claim. A hiring-led "software" mission needs Stage-2
// grounding to qualify anyone, so this driver runs the same per-slice sequence
// run-agent runs, minus the website verification phase:
//
//   1. engine          `runCapabilityPlan`, resumed from the previous slice's
//                      state + records, the replenishment debt carried exactly
//                      as run-agent reads it from the checkpoint
//   2. canonical view  `buildWorkbenchMissionView` (via `canonicalView`)
//   3. continuation    `claimProgressCount` → `foldSlice` →
//                      `decideAutoContinuation` → `settleV2Outcome`
//
// The lineage continues ONLY while the production decision says so; the slice
// cap here is a runaway guard for the broken behaviour, never the answer.

import {
  awaitedPendingRuns, claimProgressCount, decideAutoContinuation, foldSlice, type LineageProgress, readLineageProgress,
  resolveMaxContinuations, resolveMaxLineageCostUnits, settleV2Outcome,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { attemptedRoutes, verifyOpKey } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { type EngineCompany } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { wasInvestigated } from "../../../supabase/functions/_shared/leadInvestigationBudget.ts";
import { companyIsTheDeliverable, effectiveRequestedCount } from "../../../supabase/functions/_shared/leadMission.ts";
import { decisionSummary, type WorkbenchMissionView } from "../../../supabase/functions/_shared/workbenchMissionView.ts";
import { type EngineFixture, type EngineSlice, missionOf, replayEngineSlice } from "./engine.ts";
import { unfinishedFrontierCount } from "./prod.ts";
import { canonicalView } from "./verification.ts";

export type LineageFixture = EngineFixture & {
  engine: EngineFixture["engine"] & {
    model_responses: EngineFixture["engine"]["model_responses"] & {
      /** The discovery re-planner's answers, in the order it is asked. */
      replan_queries: Array<Record<string, unknown>>;
      /** Company key → the business model its own description proves (Stage-2 grounding). */
      proven_business_models: Record<string, string>;
      /**
       * Company keys run-agent's website verification phase (Phase C) read and
       * found no proof for. That phase is not re-run here; its answer is
       * recorded the way the production verifier records it — the route is
       * marked answered on the company — so the gap router sees what it saw.
       */
      website_reread_no_proof?: string[];
    };
  };
};

export interface LineageSlice {
  slice: number;
  employers: number;
  admittedInBand: number;
  qualified: string[];
  pending: number;
  decision: string;
  continue: boolean;
  barren: number;
  continuationsUsed: number;
  claimProgress: number;
  discovery: { exhausted: boolean; stop_reason: string; pages_taken: Record<string, number> } | null;
  jobSearches: Array<{ page: unknown; titles: string; adopted: boolean }>;
}

export interface LineageRun {
  slices: LineageSlice[];
  terminal: string | null;
  view: WorkbenchMissionView;
  last: EngineSlice;
}

/**
 * The Stage-2 grounder, recorded: a company whose own description the fixture
 * says proves its business model is grounded on that description; every other
 * company is left unproven (`review`), as production's grounder left Nebuly,
 * Simple Fractal and JP Carroll Roofing.
 */
export function recordedGrounder(proven: Record<string, string>) {
  return (members: Array<{ company_key: string; registry: { items: Array<Record<string, unknown>> } }>) => {
    const outcomes = members.map((m) => {
      const desc = m.registry.items.find((x) => x.evidence_type === "company_description");
      const value = proven[m.company_key];
      if (!desc || !value) {
        return { company_key: m.company_key, failure: null, detail: null, verification: {
          version: "grounded-claims-v1", classifier_result: { business_model: { value: "unknown", confidence: 0.3, claims: [] } },
          validated_claims: [], rejected_claims: [], grounding_score: 0, final_grounded_decision: "review",
          downgrade_reasons: ["the description does not say who buys the product"], unacknowledged_conflicts: [],
        } };
      }
      const text = String(desc.source_text ?? "");
      const claim = {
        claim: "what the company says about itself", claim_type: "business_model", evidence_ids: [String(desc.evidence_id)],
        evidence_excerpts: [{ evidence_id: String(desc.evidence_id), excerpt: text.slice(0, 120) }],
      };
      return { company_key: m.company_key, failure: null, detail: null, verification: {
        version: "grounded-claims-v1", classifier_result: { business_model: { value, confidence: 0.9, claims: [claim] } },
        validated_claims: [claim], rejected_claims: [], grounding_score: 1, final_grounded_decision: "pass",
        downgrade_reasons: [], unacknowledged_conflicts: [],
      } };
    });
    return Promise.resolve({ version: "replay", foreign_results: [], evaluated: members.length, failed: 0, outcomes });
  };
}

/** The re-planner, recorded: the next query it has not yet been asked. */
export function recordedReplanner(queries: Array<Record<string, unknown>>) {
  let next = 0;
  return () => {
    const q = queries[next++];
    return Promise.resolve(q ? [{ actor_key: "apify_linkedin_job_search", role: "primary", input: structuredClone(q), rationale: `replay re-plan ${next}` }] : []);
  };
}

/**
 * RUN-AGENT'S RULE: the next slice reopens discovery only when the last
 * decision asked for it AND discovery said it could still widen — read from
 * the previous slice's (checkpointed) engine state.
 */
export function replenishmentFrom(prevState: Record<string, unknown> | null | undefined, lastDecision: string | null): {
  replenish?: Record<string, number>; replenishExtra?: Record<string, unknown>;
} {
  const dss = prevState?.discovery_source_state as
    | { exhausted?: boolean; pages_taken?: Record<string, number>; page_fingerprints?: Record<string, string> }
    | undefined;
  const replenish = lastDecision === "replenishment_required" && dss && !dss.exhausted ? dss.pages_taken ?? {} : undefined;
  return replenish ? { replenish, ...(dss?.page_fingerprints ? { replenishExtra: { page_fingerprints: dss.page_fingerprints } } : {}) } : {};
}

/** PHASE C, RECORDED: the website re-read answered these companies' route. */
export function applyRecordedWebsiteReread(fx: LineageFixture, s: EngineSlice): void {
  for (const key of fx.engine.model_responses.website_reread_no_proof ?? []) {
    for (const holder of [...s.companies, ...(s.resume_records as Array<{ company_key?: string; key?: string; completed_operations?: string[] }>)]) {
      const k = (holder as { key?: string }).key ?? (holder as { company_key?: string }).company_key;
      if (k !== key) continue;
      const ops = (holder as { completed_operations?: string[] }).completed_operations ??= [];
      if (!ops.includes(verifyOpKey("firecrawl"))) ops.push(verifyOpKey("firecrawl"));
    }
  }
}

/** The end of one slice, as run-agent folds it: canonical view → `foldSlice` → `decideAutoContinuation`. */
export function foldAndDecide(fx: LineageFixture, s: EngineSlice, progressBefore: LineageProgress, taskId: string) {
  const mission = missionOf(fx);
  const requested = effectiveRequestedCount(mission);
  const view = canonicalView({ companies: s.companies }, mission, taskId, "job_discovery");
  const p5 = decisionSummary(view.counts);
  const progress = foldSlice(progressBefore, {
    qualifiedInPool: p5.qualified,
    uniqueCompaniesInvestigatedInPool: s.companies.filter((c: EngineCompany) => wasInvestigated(c.investigation_state)).length,
    authorisationsInPool: Number(s.state.investigation_selected ?? 0),
    costUnitsInLineage: Number(s.state.accumulated_cost_units ?? 0),
    brainDecidedInPool: p5.qualified + p5.pending + p5.ineligible,
    claimProgressInPool: claimProgressCount({
      leads: view.leads, attemptedRoutesPerCompany: s.companies.map((c: EngineCompany) => attemptedRoutes(c.completed_operations).length),
    }),
  });
  const ds = s.state.discovery_source_state as LineageSlice["discovery"];
  const decision = decideAutoContinuation({
    qualified: p5.qualified, verificationRoutesRemain: view.evidence_gaps.with_executable_route,
    candidateBudgetBlocked: view.evidence_gaps.budget_blocked ?? 0, requestedCount: requested,
    frontierRemaining: unfinishedFrontierCount(s.companies),
    continuationsUsed: progress.continuations_used, maxContinuations: resolveMaxContinuations(),
    costUnitsUsed: progress.cost_units_used, maxCostUnits: resolveMaxLineageCostUnits(),
    barrenSlices: progress.barren_slices, providerFailed: false,
    // run-agent's `awaitedPendingRuns(…).awaited` (D3).
    pendingRuns: awaitedPendingRuns(s.state.pending_runs as Array<{ polls?: number; started_at?: string }> | undefined, Date.now()).awaited,
    discoveryRoutesRemain: ds ? !ds.exhausted : false,
  } as never);
  const terminal = d_terminal(decision, p5.qualified, requested, mission);
  return { view, p5, progress, decision, ds, terminal };
}

function d_terminal(d: { continue: boolean; reason: unknown }, qualified: number, requested: number, mission: ReturnType<typeof missionOf>): string | null {
  if (d.continue) return null;
  return settleV2Outcome({
    continuing: false, stopReason: String(d.reason), legacyStatus: "partial",
    legacyQuota: { eligible_leads: qualified, requested_leads: requested },
    canonicalQualified: qualified, requestedCount: requested, companyIsDeliverable: companyIsTheDeliverable(mission),
  } as never).terminal;
}

export async function replayLineage(fx: LineageFixture, o: {
  maxSlices: number;
  taskId?: string;
  /** Observes each slice's engine output (the state and records run-agent checkpoints). */
  onSlice?: (slice: number, s: EngineSlice, outcome: LineageSlice) => void;
  /** Rewrites what the NEXT slice resumes from, the way a persisted checkpoint would. */
  carry?: (s: EngineSlice) => { state: Record<string, unknown>; records: unknown[] };
  /** Extra engine dependencies (e.g. `onProgress` / `onCheckpoint` observers). */
  deps?: Record<string, unknown>;
}): Promise<LineageRun> {
  const taskId = o.taskId ?? fx.provenance.task_id;
  const m = fx.engine.model_responses;
  const deps = {
    planDiscovery: recordedReplanner(m.replan_queries),
    evaluateBatch: recordedGrounder(m.proven_business_models),
    ...(o.deps ?? {}),
  };
  let progress: LineageProgress = readLineageProgress({});
  let lastDecision: string | null = null;
  let prev: EngineSlice | null = null;
  const slices: LineageSlice[] = [];
  let terminal: string | null = null;
  let view: WorkbenchMissionView | null = null;

  for (let i = 0; i < o.maxSlices; i++) {
    const callsBefore = 0; // each slice has its own fixture provider
    const s: EngineSlice = await replayEngineSlice(fx, {
      deps,
      ...(prev ? { resume: o.carry ? o.carry(prev) : { state: prev.state, records: prev.resume_records } } : {}),
      ...replenishmentFrom(prev?.state, lastDecision),
    });
    applyRecordedWebsiteReread(fx, s);
    const f = foldAndDecide(fx, s, progress, taskId);
    view = f.view;
    progress = f.progress;
    const { p5, ds, decision: d } = f;
    lastDecision = String(d.reason);
    const qualifiedNames = view.leads.filter((l) => l.label !== null).map((l) => String(l.company.name)).sort();
    slices.push({
      slice: i + 1, employers: s.companies.length,
      admittedInBand: s.companies.filter((c: EngineCompany) => c.prequalified?.eligible).length,
      qualified: qualifiedNames, pending: p5.pending, decision: lastDecision, continue: d.continue,
      barren: progress.barren_slices, continuationsUsed: progress.continuations_used, claimProgress: progress.claim_progress ?? 0,
      discovery: ds ? { exhausted: ds.exhausted, stop_reason: ds.stop_reason, pages_taken: { ...ds.pages_taken } } : null,
      jobSearches: s.provider.calls.slice(callsBefore).filter((c) => c.actor === "apify_linkedin_job_search" && !c.input.company)
        .map((c) => ({ page: c.input.page ?? 1, titles: String((c.input.jobTitles as string[])?.[0] ?? "").slice(0, 60), adopted: !!c.adopted })),
    });
    o.onSlice?.(i + 1, s, slices[slices.length - 1]);
    prev = s;
    if (!d.continue) {
      terminal = f.terminal;
      break;
    }
  }
  return { slices, terminal, view: view!, last: prev! };
}
