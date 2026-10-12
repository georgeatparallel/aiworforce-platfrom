// LEAD V2 P5 — ONE PROJECTION OWNS EVERY NUMBER.
//
// The Workbench read three independent count sources — `progress`, the
// portfolio and the evaluation rows — and they disagreed, so a run could show
// "10 discovered" beside "0 evaluated · 3 qualified" and no row explained the
// other seven. The plan's answer is one view: each discovered company lands in
// EXACTLY ONE bucket, and the buckets sum to `discovered` by construction.
//
//   discovered
//     ├── screened_out          the cheap gate ruled it out before paid work
//     ├── identity_unresolved   nothing could say which company it is
//     ├── investigating         still being worked; no eligibility yet
//     ├── ineligible            a hard criterion is disproven (a disposition)
//     ├── pending               a hard criterion is unknown — "needs verification"
//     └── exact_match · strong_opportunity · worth_considering · low_priority
//
// The label buckets hold only ELIGIBLE candidates, and the order above is the
// order the bucket is chosen in, so a company cannot be counted twice.
//
// `legacyCountsFrom` derives the old keys from this same view — the migration
// contract: the legacy surfaces keep working, but they stop being a second
// source of truth.
//
// Pure.

import type { ReadinessPolicy } from "./routeReadiness.ts";
import { canStillQualify, evidenceGapsFor, summarizeGaps, type EvidenceGap, type GapSummary } from "./evidenceGapRouter.ts";
import type { CompanyEvidenceGraph } from "./evidenceGraph.ts";
import type { MissionCriterion } from "./missionCriteria.ts";
import type { ResearchWaveSummary } from "./researchFeedback.ts";
import type { SpendLedger } from "./budgetPolicy.ts";
import {
  evaluateEligibility, type CheckProvenance, type CheckResult, type EligibilityResult,
} from "./candidateEligibility.ts";
import {
  applyReasoning, computeCeiling, deterministicReasons, type Label, type ReasonedLabel, type ReasonedSentence,
} from "./opportunityLabel.ts";

export const WORKBENCH_MISSION_VIEW_VERSION = "workbench-mission-view-v1" as const;

export type MissionStage =
  | "planning" | "retrieving" | "completing_evidence" | "reasoning" | "complete" | "stopped";

export type Bucket =
  | "screened_out" | "identity_unresolved" | "investigating" | "ineligible" | "pending" | Label;

export interface MissionCandidate {
  company_key: string;
  name: string | null;
  domain: string | null;
  linkedin_url: string | null;
  /** Route ids that found it (P4 `found_by`). */
  found_by: string[];
  /** The cheap gate's reason, when it ruled the candidate out before paid work. */
  screened_out: string | null;
  identity_resolved: boolean;
  /** False while the candidate is still waiting for its stages. */
  investigated: boolean;
  graph: CompanyEvidenceGraph;
  next_action?: string | null;
  /** Route actors a claim verifier has already answered through (`claimVerifier`). */
  attempted_routes?: readonly string[];
  /** Route actors this company's evidence budget can no longer pay for (`unaffordableRoutes`). */
  unaffordable_routes?: readonly string[];
  /**
   * Why no further PAID verification is bought for it, or null
   * (`missionTriage.paidVerificationBlockedBy`). Never a verdict: the bucket is
   * computed from evidence exactly as before.
   */
  paid_verification_blocked?: string | null;
}

export interface WorkbenchLead {
  company: { key: string; name: string | null; domain: string | null; linkedin_url: string | null };
  label: Label | null;
  bucket: Bucket;
  found_by: string[];
  hard_checks: Record<string, CheckResult>;
  /**
   * P5.2 — each hard check with the evidence it rests on: status, method,
   * confidence, actor and the grounding decision. What a pass or fail MEANS.
   */
  hard_check_details: Array<{
    criterion_id: string; dimension: string; result: CheckResult; reason: string;
    provenance: CheckProvenance | null;
  }>;
  why_surfaced: ReasonedSentence[];
  key_evidence: Array<{ dimension: string; value: unknown; status: string; sources: string[]; evidence_id: string | null }>;
  missing_evidence: string[];
  caveats: string[];
  evidence_coverage: number;
  signal_strength: number;
  next_action: string | null;
  /**
   * PENDING leads only: each unknown hard check, and the route that could close
   * it — or why nothing can (`evidenceGapRouter`). Empty for every other bucket.
   */
  evidence_gaps: EvidenceGap[];
  /**
   * Pending leads only (null otherwise): `verifying` while every unknown hard
   * claim still has an executable route; `unverifiable` when nothing more will
   * be bought for it in this run. Still pending — never a rejection — but no
   * longer "being checked" (Query B a9a6791a showed four such companies as
   * "still being checked" after the lineage ended).
   */
  pending_state: "verifying" | "unverifiable" | null;
}

export interface WorkbenchCounts {
  discovered: number;
  screened_out: number;
  investigating: number;
  identity_unresolved: number;
  pending: number;
  exact_match: number;
  strong_opportunity: number;
  worth_considering: number;
  low_priority: number;
  ineligible: number;
}

export interface WorkbenchMissionView {
  version: typeof WORKBENCH_MISSION_VIEW_VERSION;
  mission: {
    requested_count: number;
    execution_limit: number | null;
    criteria: Array<{
      id: string; label: string; kind: MissionCriterion["kind"]; source: string; window: string | null; status: string;
      /** Stated, not parsed from `id`, so a reader never has to know the id format. */
      dimension: MissionCriterion["dimension"];
    }>;
    unsupported: string[];
  };
  stage: MissionStage;
  /** Pending leads nothing more will be bought for (`pending_state: "unverifiable"`). A subset of `counts.pending`. */
  pending_unverifiable: number;
  counts: WorkbenchCounts;
  leads: WorkbenchLead[];
  /** The canonical evidence gaps across pending leads — what continuation reads. */
  evidence_gaps: GapSummary;
  routes: Array<{
    route_id: string; anchor: string; spend_usd: number; raw: number; unique: number;
    duplicates: number; hard_eligible: number; useful: number; stop_reason: string | null;
  }>;
  cost: {
    provider_settled_usd: number; provider_pending_usd: number; model_usd: number;
    unknown_cost_calls: number; credits: number;
    /** provider settled + provider pending + model. */
    total_usd: number;
  };
}

/**
 * THE MISSION'S COST, READ FROM THE LEDGERS THAT RECORD IT.
 *
 * It was read from the last research wave's snapshot, taken at the END OF A
 * WAVE — before any receipt had settled and before the claim verifiers ran, so
 * canary abc316e8 showed `provider_settled_usd: 0` beside $0.0278 of settled
 * calls. And the model figure was taken before the reasoner's own call.
 *
 *   provider settled   Σ `settled_usd` of reservations a RECEIPT settled
 *   provider pending   Σ provisional (else estimate) of reservations bought and
 *                      not yet settled — spent, bill not yet final
 *   model              the model ledger's own total, passed in
 *
 * One reservation per idempotency key, so an adopted or idempotently skipped
 * call is never counted twice; refused, released and adopted reservations
 * committed nothing. Nothing is priced from the actor catalogue after the fact.
 */
export function missionCostFromLedgers(i: {
  spend_ledger: SpendLedger | null | undefined;
  model_usd: number;
  model_unpriced_calls?: number;
  credits?: number;
}): WorkbenchMissionView["cost"] {
  const rs = i.spend_ledger?.reservations ?? [];
  const settled = round4(rs.filter((r) => r.status === "settled")
    .reduce((n, r) => n + (r.settled_usd ?? 0), 0));
  const pending = round4(rs.filter((r) => r.status === "reserved" || r.status === "executed")
    .reduce((n, r) => n + (r.provisional_usd ?? r.estimate_usd ?? 0), 0));
  // Model rows are priced to the millionth (token prices); rounding them to
  // the provider ledger's 4 places would show a figure the model ledger does
  // not hold.
  const model = round6(i.model_usd);
  return {
    provider_settled_usd: settled,
    provider_pending_usd: pending,
    model_usd: model,
    unknown_cost_calls: i.model_unpriced_calls ?? 0,
    credits: i.credits ?? 0,
    total_usd: round6(settled + pending + model),
  };
}

export interface ViewInput {
  mission: { requested_count: number; execution_limit: number | null; anchor: string | null };
  criteria: readonly MissionCriterion[];
  unsupported?: readonly string[];
  candidates: readonly MissionCandidate[];
  stage: MissionStage;
  waves?: readonly ResearchWaveSummary[];
  cost?: Partial<WorkbenchMissionView["cost"]>;
  /** A reasoner's proposals by company key. Absent ⇒ code's own reasons. */
  reasoning?: Record<string, { label?: unknown; why_surfaced?: unknown } | undefined>;
  /** The mission's readiness policy, so a gap shown as routable is one the run may take. */
  readiness?: ReadinessPolicy;
}

/** Which bucket a candidate belongs to. First match wins, so exactly one. */
export function bucketOf(
  c: MissionCandidate, eligibility: EligibilityResult, label: Label | null,
): Bucket {
  if (c.screened_out) return "screened_out";
  if (!c.identity_resolved) return "identity_unresolved";
  if (eligibility.eligibility === "ineligible") return "ineligible";
  if (!c.investigated) return "investigating";
  if (eligibility.eligibility === "pending") return "pending";
  return label ?? "low_priority";
}

function keyEvidence(graph: CompanyEvidenceGraph): WorkbenchLead["key_evidence"] {
  return graph.claims
    .filter((c) => c.current)
    .slice(0, 8)
    .map((c) => ({
      dimension: c.dimension, value: c.current!.value, status: c.current!.status,
      sources: c.sources, evidence_id: c.current!.evidence_id,
    }));
}

function caveatsFor(graph: CompanyEvidenceGraph, r: ReasonedLabel, e: EligibilityResult): string[] {
  const out: string[] = [];
  for (const dim of graph.conflicts) out.push(`sources disagree about ${dim.replace(/_/g, " ")}`);
  for (const claim of graph.claims) {
    if (!claim.current && claim.stale.length > 0) out.push(`the only ${claim.dimension.replace(/_/g, " ")} evidence has expired`);
  }
  if (r.dropped_a_level) out.push("the reasoner's explanation cited no real evidence, so the label was lowered");
  if (r.capped_from) out.push(`the reasoner proposed ${r.capped_from.replace(/_/g, " ")}; the evidence supports no more than this`);
  if (e.eligibility === "pending") out.push("a required fact is still unproven — this is not a match yet");
  return [...new Set(out)].slice(0, 6);
}

// ── ONE DECISION TRUTH (P5 hardening) ───────────────────────────────────────
//
// Canaries d7012ba5 and c0aa06be kept buying discovery pages after this view
// already held the answer: continuation read the legacy Brain-verdict counter
// (0 of 1), the view said 2 strong opportunities. Every consumer of "how many
// are qualified / pending / ineligible" — the engine's in-slice yield gate,
// run-agent's continuation / replenishment / completion decision, the UI —
// reads THIS count, derived from canonical company state.
//
// Deterministic and reasoner-free: the reasoner may lower a label but never
// moves a candidate between qualified, pending and ineligible, so the counts
// the decision needs do not wait on a model.

/** One candidate's canonical decision: its bucket, its hard checks, and the label ceiling. */
export interface CandidateDecision {
  company_key: string;
  bucket: Bucket;
  /** Set only for surfaced leads (a label bucket). */
  label: Label | null;
  hard_checks: Record<string, CheckResult>;
}

export const LABEL_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>([
  "exact_match", "strong_opportunity", "worth_considering", "low_priority",
]);

export function candidateDecision(i: {
  criteria: readonly MissionCriterion[]; candidate: MissionCandidate; anchor: string | null;
}): CandidateDecision {
  const eligibility = evaluateEligibility(i.criteria, i.candidate.graph);
  const ceiling = computeCeiling({ criteria: i.criteria, graph: i.candidate.graph, eligibility, anchor: i.anchor });
  const bucket = bucketOf(i.candidate, eligibility, ceiling.ceiling);
  return {
    company_key: i.candidate.company_key, bucket,
    label: LABEL_BUCKETS.has(bucket) ? bucket as Label : null,
    hard_checks: eligibility.hard_checks,
  };
}

/** Bucket counts over canonical candidates. `buildWorkbenchMissionView` produces the same numbers. */
export function decisionCounts(i: {
  criteria: readonly MissionCriterion[]; candidates: readonly MissionCandidate[]; anchor: string | null;
}): WorkbenchCounts {
  const counts: WorkbenchCounts = {
    discovered: i.candidates.length, screened_out: 0, investigating: 0, identity_unresolved: 0,
    pending: 0, exact_match: 0, strong_opportunity: 0, worth_considering: 0, low_priority: 0, ineligible: 0,
  };
  for (const candidate of i.candidates) {
    counts[candidateDecision({ criteria: i.criteria, candidate, anchor: i.anchor }).bucket] += 1;
  }
  return counts;
}

/** The numbers a completion / continuation decision reads. */
export interface DecisionSummary {
  discovered: number;
  /** Surfaced leads: every eligible candidate, whatever its label. */
  qualified: number;
  pending: number;
  ineligible: number;
  screened_out: number;
  /** Still owed investigation or identity — work, not a decision. */
  undecided: number;
}

export function decisionSummary(c: WorkbenchCounts): DecisionSummary {
  return {
    discovered: c.discovered,
    qualified: c.exact_match + c.strong_opportunity + c.worth_considering + c.low_priority,
    pending: c.pending,
    ineligible: c.ineligible,
    screened_out: c.screened_out,
    undecided: c.investigating + c.identity_unresolved,
  };
}

export function buildWorkbenchMissionView(i: ViewInput): WorkbenchMissionView {
  const counts: WorkbenchCounts = {
    discovered: i.candidates.length, screened_out: 0, investigating: 0, identity_unresolved: 0,
    pending: 0, exact_match: 0, strong_opportunity: 0, worth_considering: 0, low_priority: 0, ineligible: 0,
  };
  const leads: WorkbenchLead[] = [];
  const blockedKeys = new Set(i.candidates.filter((c) => c.paid_verification_blocked).map((c) => c.company_key));

  for (const c of i.candidates) {
    const eligibility = evaluateEligibility(i.criteria, c.graph);
    const ceiling = computeCeiling({ criteria: i.criteria, graph: c.graph, eligibility, anchor: i.mission.anchor });
    const proposal = i.reasoning?.[c.company_key];
    const reasoned = applyReasoning(ceiling, proposal ?? null);
    const why = reasoned.why_surfaced.length > 0 || proposal
      ? reasoned.why_surfaced
      : deterministicReasons(ceiling, c.graph);
    const bucket = bucketOf(c, eligibility, reasoned.label);
    counts[bucket] += 1;
    const hardChecks = eligibility.checks.filter((x) => x.kind === "hard");
    const gaps = bucket === "pending"
      ? evidenceGapsFor(hardChecks, c.graph, undefined, new Set(c.attempted_routes ?? []), i.readiness,
        new Set(c.unaffordable_routes ?? []))
      : [];

    leads.push({
      company: { key: c.company_key, name: c.name, domain: c.domain, linkedin_url: c.linkedin_url },
      // A bucket that is not a label is not a lead label either — `pending` and
      // `ineligible` are dispositions, and the UI must not render them as matches.
      label: bucket === "exact_match" || bucket === "strong_opportunity" ||
        bucket === "worth_considering" || bucket === "low_priority" ? reasoned.label : null,
      bucket,
      found_by: c.found_by,
      hard_checks: eligibility.hard_checks,
      hard_check_details: hardChecks.map((x) => ({
        criterion_id: x.criterion_id, dimension: x.dimension, result: x.result, reason: x.reason,
        provenance: x.provenance,
      })),
      why_surfaced: why,
      key_evidence: keyEvidence(c.graph),
      missing_evidence: reasoned.missing_evidence,
      caveats: bucket === "pending" && c.paid_verification_blocked
        ? [...caveatsFor(c.graph, reasoned, eligibility),
          "Not verified further: triage judged it unlikely to fit this mission and its LinkedIn industry is media or publishing, so no more provider spend was made on it."]
        : caveatsFor(c.graph, reasoned, eligibility),
      evidence_coverage: ceiling.evidence_coverage,
      signal_strength: ceiling.signal_strength,
      next_action: c.next_action ?? null,
      evidence_gaps: gaps,
      pending_state: bucket === "pending"
        ? (!c.paid_verification_blocked && canStillQualify(gaps) ? "verifying" : "unverifiable")
        : null,
    });
  }

  // Ranking: label first, then coverage, then signal strength — deterministic,
  // and separate from the label itself.
  const order: Bucket[] = ["exact_match", "strong_opportunity", "worth_considering", "low_priority", "pending", "investigating", "identity_unresolved", "ineligible", "screened_out"];
  leads.sort((a, b) =>
    order.indexOf(a.bucket) - order.indexOf(b.bucket) ||
    b.evidence_coverage - a.evidence_coverage ||
    b.signal_strength - a.signal_strength ||
    a.company.key.localeCompare(b.company.key));

  const lastWave = i.waves?.[i.waves.length - 1];
  const routes = (lastWave?.routes ?? []).map((r) => ({
    route_id: r.route_id ?? `${r.capability}:${r.actor_key}`,
    anchor: r.capability,
    spend_usd: r.cost_settled_usd,
    raw: r.rows,
    unique: r.new_companies,
    duplicates: r.merged_into_existing,
    hard_eligible: r.hard_pass,
    // Useful = a candidate this route found that reached a surfaced label.
    useful: leads.filter((l) => l.label !== null && l.found_by.includes(r.route_id ?? "")).length,
    stop_reason: r.status === "stopped" ? "route_stopped" : null,
  }));

  return {
    version: WORKBENCH_MISSION_VIEW_VERSION,
    mission: {
      requested_count: i.mission.requested_count,
      execution_limit: i.mission.execution_limit,
      criteria: i.criteria.filter((c) => c.status === "ok").map((c) => ({
        id: c.id, label: c.label, kind: c.kind, source: c.source, dimension: c.dimension,
        window: c.time_window ? `last ${c.time_window.days} days` : null,
        status: c.status,
      })),
      unsupported: [...(i.unsupported ?? [])],
    },
    stage: i.stage,
    counts,
    // A SUBSET OF `counts.pending`, never a bucket: the buckets still sum to
    // `discovered`. See `WorkbenchLead.pending_state`.
    pending_unverifiable: leads.filter((l) => l.pending_state === "unverifiable").length,
    leads,
    // A pending lead whose paid verification triage withheld is not a route a
    // verification slice could take — the verifiers would refuse to buy for it.
    evidence_gaps: summarizeGaps(leads.filter((l) => l.bucket === "pending").map((l) => ({
      gaps: l.evidence_gaps,
      paid_verification_blocked: blockedKeys.has(l.company.key),
    }))),
    routes,
    cost: (() => {
      // A caller holding the ledgers passes `missionCostFromLedgers`; the wave
      // snapshot is only the fallback for a caller that has none.
      const settled = i.cost?.provider_settled_usd ?? lastWave?.cost.settled_usd ?? 0;
      const pending = i.cost?.provider_pending_usd ??
        round4(Math.max(0, (lastWave?.cost.committed_usd ?? 0) - (lastWave?.cost.settled_usd ?? 0)));
      const model = i.cost?.model_usd ?? 0;
      return {
        provider_settled_usd: settled,
        provider_pending_usd: pending,
        model_usd: model,
        unknown_cost_calls: i.cost?.unknown_cost_calls ?? 0,
        credits: i.cost?.credits ?? 0,
        total_usd: round6(settled + pending + model),
      };
    })(),
  };
}

/** Every bucket except `discovered`, which they sum to. */
export function countsAreExclusive(c: WorkbenchCounts): boolean {
  const parts = c.screened_out + c.identity_unresolved + c.investigating + c.pending +
    c.exact_match + c.strong_opportunity + c.worth_considering + c.low_priority + c.ineligible;
  return parts === c.discovered;
}

/**
 * The legacy keys, DERIVED from the view rather than counted again.
 *
 * `qualified` is the surfaced labels; `unknown_pending_evidence` is `pending`,
 * which the old projection conflated with rejection; `rejected` is only what a
 * hard criterion actually disproved.
 */
export function legacyCountsFrom(v: WorkbenchMissionView): {
  discovered: number; evaluated: number; qualified: number; rejected: number;
  unknown_pending_evidence: number; screened_out: number;
} {
  const c = v.counts;
  const qualified = c.exact_match + c.strong_opportunity + c.worth_considering + c.low_priority;
  return {
    discovered: c.discovered,
    evaluated: qualified + c.pending + c.ineligible,
    qualified,
    rejected: c.ineligible,
    unknown_pending_evidence: c.pending,
    screened_out: c.screened_out,
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
