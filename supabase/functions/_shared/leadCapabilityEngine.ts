// THE CAPABILITY EXECUTION ENGINE — the graph drives, nothing else does.
//
// Phase 1 made the capability graph AUTHORITATIVE about what may run. It still
// let `executeCompanyFirstRoute` decide the actual order, which left two things
// that could disagree about the same run. This module removes the second one:
// the graph's own steps are now the state machine, and every provider call
// happens because a capability asked for it.
//
// WHAT IT REUSES AND WHY.
//
// Nothing here re-implements a provider normalizer, an Actor input compiler, an
// identity resolver or the Company Brain gate. Those are correct, tested, and
// the source of the evidence discipline this engine depends on. The engine
import { sizeBandLabel } from "./companySize.ts";
import { YC_MEMO23_MAX_SIZES } from "./hiringActorCatalog.ts";
import { normalizeCompanyLinkedInUrl } from "./structuredCompanyEnrichment.ts";
import {
  completionIsProvisional, repairPrematureCompletions,
} from "./capabilityCompletion.ts";
import {
  hiringSearchTitles, HIRING_SEARCH_TITLE_LIMIT,
} from "./hiringSearchVocabulary.ts";
// COMPOSES them one capability at a time, which is what buys genuine resume
// granularity: a run that stopped after enrichment resumes at hiring
// verification rather than re-paying for discovery.
//
// THREE RULES THE ENGINE ENFORCES THAT A LINEAR EXECUTOR CANNOT.
//
//   * A capability runs only when its inputs exist. Founder discovery cannot
//     run on companies that never passed the Brain, because "qualified company"
//     is an input it declares and the engine checks.
//   * A capability advances only when its evidence requirements are met.
//     Enrichment that returned nothing does not count as enrichment, so
//     qualification still sees "unenriched" rather than an empty record that
//     looks like a proven negative.
//   * Provider exhaustion is a STATE, not a licence. When memo23 and solidcode
//     are both spent, the mission reports exhausted. It does not discover that
//     a job board is technically reachable.
//
// PROVIDER ACCESS IS THROUGH `guardedInvoker` ONLY. A `CapabilityContainmentError`
// is deliberately NOT caught into a fallback: it means the engine tried to reach
// outside its own graph, which is a bug in the engine, not a provider failure.
//
// No network, provider, model or database access of its own — everything is
// injected, which is what lets the end-to-end proof exercise the REAL engine
// with zero paid runs.

import {
  compileHarvestCompanyDetailsInput, compileHarvestCompanyEmployeesInput,
  compileHarvestCompanySearchInput,
  compileHarvestJobDiscoveryInput, compileHarvestJobSearchInput, compileHarvestProfileSearchInput,
  JOB_DISCOVERY_LIMITS,
  compileDatahyenaFundingInput, compileMemo23YcInput, fanOutSolidcodeTeamSizes,
  type CompiledActorCall, type CompileResult,
} from "./hiringActorInputs.ts";
import { icpDiscoveryConstraints } from "./icpDiscoveryConstraints.ts";
import { actorAnsweredHiring } from "./actorEvidenceCapability.ts";
import {
  acceptLinkedInMatch, linkedInSearchQueryFor, linkedInSlugToken,
  LINKEDIN_RESOLUTION_CONCURRENCY,
  prequalificationKey, prequalifyYcCompanies,
  type MatchOutcomeCode, type PrequalificationResult, type PrequalifiedCompany,
  type YcCompanyInput,
} from "./leadCommercialPrequalification.ts";
import {
  normalizeSuppliedCompanies, SUPPLIED_COMPANY_PROVENANCE,
} from "./suppliedCompanyIdentity.ts";
import {
  compileGoogleNewsInput,
} from "./hiringActorInputs.ts";
import type { NormalizedNewsArticle } from "./hiringActorNormalizers.ts";
import { normalizeNewsArticle } from "./hiringActorNormalizers.ts";
import {
  prequalifyDiscoveredCompanies, mergePrequalification,
  genericPrequalificationKey, admittedCandidateCount, isAdmitted, isPlaceholderEmployerName,
} from "./leadGenericPrequalification.ts";
import {
  assessSignals, verdictsClaimingUninvestigatedSignals,
  type RequiredSignal as QualRequiredSignal, type SignalAssessment,
} from "./signalQualification.ts";
import {
  buildLeadVerdict, qualificationDecision, type LeadVerdict,
} from "./leadQualificationVerdict.ts";
import {
  resolveMissionOutput, outputContractViolations, type MissionOutput,
} from "./missionOutputContract.ts";
import { priceFor } from "./creditPricing.ts";
import {
  buildQualificationContext, resolveEmployeeBounds, qualificationContextSummary,
  resolveBrainAuthority,
  type QualificationContext,
} from "./missionQualificationContext.ts";
import {
  buildMissionEvaluationInput, notEvaluated, reevaluationContextFrom,
  type MissionReevaluationContextV1,
  type MissionEvaluation, type MissionEvaluationInput,
  type ParsedMissionEvaluation, type DecisionSource,
} from "./missionEvaluation.ts";
import {
  asEnrichmentOutcome, enrichmentIsEvidence, enrichmentIsTerminal, enrichmentWasAnswered,
  summariseEnrichmentOutcomes, type EnrichmentOutcome,
} from "./leadEnrichmentState.ts";
import {
  buildMissionFunnel, type FunnelCompany, type MissionFunnel,
} from "./leadMissionFunnel.ts";
import {
  BATCH_EVALUATION_OP, DURABLE_START_MS, DeadlineBudgetExceeded, QUALIFICATION_OP,
  QUALIFICATION_PREGROUNDED_OP, deadlineOperationFor, withDeadlineBudget,
  type ExecutionDeadline,
} from "./leadExecutionFinalizer.ts";
import {
  TIER_A_TITLES, TIER_B_TITLES, assessHiring, needsPaidJobVerification,
  reachesCompanyBrain, type HiringAssessment, type SupportingSignal,
} from "./commercialSignalPolicy.ts";
import {
  applyMissionPrecedence, decideCompanyBrain,
  type BrainDecision,
} from "./companyBrainSemanticFit.ts";
import type { PortfolioCandidate } from "./opportunityPortfolio.ts";
import {
  boundedId, buildEvidenceRegistry, emptyEvidenceRegistry, MAX_STABLE_ID_LENGTH, type EvidenceRegistry,
} from "./leadEvidenceRegistry.ts";
import { buildCompanyEvidence } from "./leadCompanyEvidence.ts";
import type { GroundedVerification } from "./groundedClaims.ts";
import {
  buildEligiblePool, type EligiblePool,
} from "./leadEligiblePool.ts";
import {
  planBatches, resolveBatchLimits,
  type BatchLimits, type BatchMember, type BatchResult,
} from "./groundedBatchEvaluation.ts";
import {
  applyPortfolioPolicy, buildCandidateSummary, validatePoolRanking,
  deterministicRanking, buildRankingShadowComparison,
  type GroundedCandidateSummary, type PortfolioDelivery, type ValidatedRanking,
  type RankingShadowComparison,
} from "./poolRanking.ts";
import { poolFingerprintOf } from "./poolCheckpoint.ts";
import {
  bindingsMatchCheckpoint, bindingFingerprint,
  type ResolvedReferentBinding,
} from "./referentBinding.ts";
import {
  CHECKPOINT_RESERVE_MS, QUALIFICATION_RESERVE_MS, inputFingerprint, inputFingerprintV2,
  MAX_SNAPSHOT_JOBS,
  providerOperationKey,
  shouldCheckpoint, shouldSkipProviderCall, shouldStartWork,
  type CompanyResumeRecord,
  capabilityStillOwed, CAPABILITY_STAGE, nextStageFor,
} from "./leadResumeState.ts";
import {
  buildMissionTriageInput, paidVerificationBlockedBy, parseMissionTriageStrict, summariseTriage, TRIAGE_BATCH_SIZE,
  triageBatches, uncertainVerdict,
  type MissionTriageInput, type TriageCompanyInput, type TriageVerdict,
} from "./missionTriage.ts";
import {
  asInvestigationState, buildSmartShortlist, canStartHiringBatch,
  identityStopThreshold,
  resolveMaxPasses,
  isFrontier, resolveGptBudget, resolveInvestigationBudget, resolveTimeCapacity,
  resolveTriageConcurrency, resolveUntriagedPolicy, selectInvestigationSlice,
  shouldTakeAnotherSlice,
  wasInvestigated,
  type GptBudget, type InvestigationBudget, type InvestigationState,
  type TimeCapacity,
} from "./leadInvestigationBudget.ts";
import {
  dedupeJobs, dedupePeople, normalizeHarvestPerson,
  nonCompanyPageReason,
  normalizeLinkedInCompanyCandidate, normalizeLinkedInCompanyEnriched,
  normalizeLinkedInJob, jobEmployerIdentityConflict, normalizeMemo23Company, normalizeMemo23OpenJobs,
  firstHireLanguage, jobEmployerAgencyReason, jobEmployerToCompany, jobIsOpen,
  normalizeSolidcodeCompany,
  type NormalizedHiringCompany, type NormalizedHiringJob, type NormalizedHiringPerson,
  normalizeDatahyenaFundingRound, fundingRoundToCompany,
  type NormalizedFundingRound,
} from "./hiringActorNormalizers.ts";
import {
  advance, evaluateCompanyFit, newCompanyRecord, projectFunnel,
  type CompanyFitResult, type CompanyRecordState, type FunnelCounts,
} from "./companyFirstStages.ts";
import { missionTargetsIntermediaries } from "./companyAggregatorEvidence.ts";
import { mergeDiscoveryActorInput } from "./discoveryInputMerge.ts";
import { authorityForEvidence, authorityRecord, statusForAuthority } from "./evidenceAuthority.ts";
import {
  identityIsActionable, resolveIdentityAgainstLookups, type IdentityResolution,
} from "./companyIdentityResolution.ts";
import {
  buildSnapshotRow, isSameDayDuplicate, type HeadcountSnapshotRow,
} from "./headcountSnapshotStore.ts";
import { DEFAULT_ROLE_PACKS, filterJobsForPack, type RolePack } from "./hiringRolePackFilter.ts";
import {
  COMPANY_EMPLOYEES_SCRAPER_MODES, PROFILE_SEARCH_SCRAPER_MODES,
} from "./hiringActorCatalog.ts";
import {
  CAPABILITY_REGISTRY, CapabilityContainmentError, firstInFunctionRequested, isProviderAllowedForCapability, onCapabilityExhausted,
  type CapabilityId, type CapabilityPlan,
} from "./leadCapabilityGraph.ts";
import { normalizeLocationName } from "./harvestApiPeople.ts";
import { guardedInvoker } from "./leadMissionRuntime.ts";
import { CREDIT_REFUSED_ERROR } from "./creditAuthorization.ts";
import {
  assertPeopleProviderAllowed, PaidExecutionBlockedError,
} from "./leadPaidExecutionPreflight.ts";
import {
  companyIsTheDeliverable, effectiveRequestedCount, isHiringSignal, missionHash,
  type LeadMissionV1,
} from "./leadMission.ts";
// WHICH ACTORS DISCOVER THE POOL. Replaces the frozen provider pair and the
// hardcoded YC literal that answered every mission with the same request.
import {
  type DiscoveryActorSelection, type DiscoveryStrategy,
  buildDiscoveryPlannerPayload, blockedDiscoveryStrategy, DiscoveryStrategyBlockedError,
  discoveryStrategyDiagnostics, shouldRunSelection, strategyActorKeys,
  validateDiscoveryStrategy, acceptedInputFields,
} from "./leadDiscoveryStrategy.ts";
import type { DiscoveryResultsSummary } from "./agentoryBriefing.ts";
import {
  buildExecutionPlannerPayload, validateExecutionPlan, capabilityIsPlanned,
  plannedActorsFor, ExecutionPlanBlockedError, type ExecutionPlan,
} from "./leadExecutionPlan.ts";
// REQUIRED SIGNALS → ACTORS. Joins what the mission asked for to what can
// actually supply it, so an unserved requirement is stated rather than dropped.
import {
  coverMissionSignals, coverageDiagnostics, signalsUnservedByStrategy,
} from "./signalActorCoverage.ts";
import { hiringActorCard } from "./hiringActorCatalog.ts";
import { businessModelDecision } from "./groundedClaims.ts";
import { valueWithStatedAudience } from "./businessModelMatch.ts";
// ── P2: the execution spine ──────────────────────────────────────────────────
import {
  CANDIDATE_OBSERVATION_VERSION, compactObservation, entityHintFromCompany, observationFromCompany,
  type CandidateObservation, type EvidenceItem, type EvidenceDimension,
  type ObservationContext,
} from "./candidateObservation.ts";
import {
  absorbIdentifiers, appendFoundBy, foundByFrom, identifiersFromHint, resolveEntity,
  type EntityIdentifiers, type FoundBy, type IdentityConflict,
} from "./entityResolution.ts";
import {
  buildCompanyEvidenceGraph, evidenceFromRegistry, projectEvidenceGraph, requiredEvidenceDimensions,
  type EvidenceGraphProjection,
} from "./evidenceGraph.ts";
import {
  summarizeResearchWave, validateRouteControl, type ResearchWaveSummary, type RouteCallStat,
} from "./researchFeedback.ts";
import { ACTOR_READINESS, readinessOf } from "./actorIntelligence.ts";
import { PRODUCTION_READINESS, routeActorReady, type ReadinessPolicy } from "./routeReadiness.ts";
import { markProviderUnavailable, unavailableProvider, type UnavailableProvider } from "./providerAvailability.ts";
import {
  attemptedRoutes, unaffordableOpKey, unaffordableRoutes, verifyOpKey, type ClaimVerifier, type PendingVerifierRun, type VerificationTarget,
  type VerifierFinding,
} from "./claimVerifier.ts";
import { atomusInput, FUNDING_STAGE_VERIFIER_KEY } from "./fundingStageVerifier.ts";
import { bucketOf, candidateDecision, decisionCounts, decisionSummary, type CandidateDecision, type MissionCandidate } from "./workbenchMissionView.ts";
import { evaluateEligibility } from "./candidateEligibility.ts";
import { canStillQualify, evidenceGapsFor } from "./evidenceGapRouter.ts";
import { deriveMissionCriteria } from "./missionCriteria.ts";
import { fundingRecordEvidenceItem, fundingRecordFromDiscoveredRound } from "./fundingCorroboration.ts";
import {
  decideFundingStage, fundingStageEvidenceItem, normalizeRoundType, requiredStagesOf, stageRank,
  type FundingRecordFact, type FundingStageDecision,
} from "./fundingStageClaim.ts";
import {
  amendRetrievalPlan, anchorForCapability, buildRetrievalPlan, planEntryForCall, purposeForCapability, continuationAmendmentRefusal,
  type AmendmentTrigger, type RetrievalPlan,
} from "./retrievalPlan.ts";
import { compileProviderCallSpec, specSummary, type ProviderCallSpec } from "./providerCallSpec.ts";
import { criteriaExecutionPolicy } from "./criteriaExecutionPolicy.ts";
import {
  applySpendFloor, attachProviderRun, derivedFloorUsd, estimateCallUsd, markExecuted, newSpendLedger, release, reserve,
  resolveCeilings, type Ceilings, type SpendFloor, type SpendLedger,
} from "./budgetPolicy.ts";
import { capCeilings, type MissionSpendCap } from "./missionSpendCap.ts";
import { appendTrace, newMissionTrace, type MissionTrace } from "./missionTrace.ts";
import { ACTOR_INPUT_CONTRACTS as P2_ACTOR_CONTRACTS } from "./actorInputContracts.ts";
import { hashInput as p2HashInput } from "./hiringActorInputs.ts";
import { toRepoKey } from "./actorIdentity.ts";
import { tightenCeilings, type RunBudget } from "./runBudget.ts";
import {
  nextUnreadPage, screenAdmissionOrder, type FundingScreenPlan, type ScreenVerdict,
} from "./fundingPoolScreen.ts";

/**
 * The PAID stages a new investigation slice must re-run.
 *
 * Discovery is deliberately absent: the pool is discovered once and the
 * frontier is a cursor over it, so another pass costs no discovery. Persistence
 * is absent because it runs once at the end over everything that qualified.
 */
const INVESTIGATION_CAPABILITIES: readonly CapabilityId[] = [
  "company_identity_resolution", "company_enrichment",
  "hiring_verification", "company_brain_qualification",
];

export const CAPABILITY_EXECUTION_STATE_VERSION = "capability-execution-state-v1" as const;

/**
 * Discovery-time size bounds for memo23.
 *
 * BROAD ON PURPOSE. The Actor's size filters are fixed enums, and the mission's
 * real bound (10-150) is not expressible in them. Discovery casts wide and the
 * exact range is enforced from ENRICHED headcount, because the Actor's own
 * `teamSize` is advisory and was up to 23x wrong in the live benchmark.
 * Both values appear in the published schema and in the in-repo pinned enums.
 */
/**
 * Discovery passes per capability: plan, run, look, choose again.
 *
 * TWO, not more. The second pass is what lets a run notice its pool cannot
 * answer the mission; a third mostly buys another planning call to reach the
 * same conclusion. Callers that want the old strictly-one-shot behaviour pass 1.
 */
export const DEFAULT_DISCOVERY_PASSES = 2;

/**
 * THE SPEND CEILING THAT REPLACES THE ROW COUNT AS A STOP.
 *
 * Discovery now finishes on ADMITTED candidates, which is the right question
 * and an unbounded one: a source with a five-percent admission rate would page
 * forever chasing a target it cannot reach. So the raw pool keeps a ceiling —
 * `maxCandidates * MAX_RAW_ROWS_PER_ADMITTED` — and reaching it ends discovery
 * whatever the admitted count says.
 *
 * Four, because run 7e71d8bc admitted 34 of 50 (68%) on a source and a mission
 * we now have measured evidence for; a factor of four tolerates an admission
 * rate down to 25% before it binds, which is well beneath anything observed,
 * and caps the worst case at four times the spend the old code allowed rather
 * than an open-ended one.
 */
export const MAX_RAW_ROWS_PER_ADMITTED = 4;

/**
 * THE ADMISSION RATE BELOW WHICH ANOTHER PAGE IS NOT WORTH BUYING.
 *
 * Pagination is the cheapest replenishment there is, but "cheap" is not
 * "free", and a source admitting one row in ten is not a source that will do
 * better on page two — it is a source whose index does not hold what the
 * mission asked for. Below this floor the right move is a different question,
 * which is what the re-plan immediately after it is for.
 *
 * A fifth, set beneath every admission rate observed in production (run
 * 7e71d8bc: 0.68) so that it bounds genuinely unproductive sources without
 * second-guessing ordinary ones.
 */
export const MIN_PAGINATION_YIELD = 0.2;

/**
 * ADMITTED CANDIDATES TO HOLD PER QUALIFIED LEAD STILL OWED.
 *
 * ── WHY THIS IS NOT `maxCandidates` ────────────────────────────────────────
 *
 * `maxCandidates` is `requestedLeadCount * 10`, and that ten has always meant
 * RAW ROWS: buy ten rows per lead and hope one survives triage, hiring and the
 * Brain. Reading the same number as an ADMITTED target — companies that already
 * passed the mission's hard constraints — silently raises the bar by the whole
 * width of the funnel, and would have bought page two of a source that had just
 * returned 34 usable companies for a five-lead request.
 *
 * Four admitted companies per owed lead. The downstream funnel is triage →
 * enrichment → hiring verification → Brain, and run 7e71d8bc is the only
 * measured evidence for its width: 34 admitted became 22 shortlisted. A factor
 * of four holds roughly twice that attrition in reserve without pre-buying a
 * pool the run may never look at.
 *
 * Being too small is now the cheap direction to be wrong in, which is the whole
 * reason this number can be modest: an insufficient pool empties the frontier,
 * and `replenishment_required` reopens discovery to widen it. Before that
 * existed, an under-sized pool ended the request.
 */
export const ADMITTED_PER_OWED_LEAD = 4;

/**
 * Never let the target fall so low that one bad triage round empties the pool.
 * A single-lead request still wants a handful of candidates to choose between.
 */
export const MINIMUM_ADMITTED_TARGET = 8;

/**
 * Stages a planned chain may legitimately DESELECT.
 *
 * Deliberately short. These are the stages whose necessity depends on what an
 * earlier Actor returned — a discovery source carrying embedded open roles makes
 * a paid hiring check redundant — which is a judgement only something that has
 * seen the chain can make.
 *
 * Everything else is structural. Identity resolution, enrichment, qualification
 * and persistence are what turn rows into leads, and a chain that omits one is
 * not expressing a preference; it is proposing a run that cannot finish. The
 * graph keeps those.
 */
const OPTIONAL_BY_CHAIN: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "hiring_verification",
  "expansion_signal_verification",
]);

export const MEMO23_DEFAULT_MIN_SIZE = "10+";
export const MEMO23_DEFAULT_MAX_SIZE = "500";

// ------------------------------------------------------------------ state ----

export interface ProviderAttempt {
  capability: CapabilityId;
  provider: string;
  attempt: number;
  outcome:
    | "ok" | "empty" | "error" | "pending" | "skipped_idempotent" | "compile_failed"
    /** P2: the ProviderCallSpec's ceilings refused the call before it started. */
    | "refused_budget"
    /** P2: the retrieval plan refused this route (e.g. an unfiltered sweep). */
    | "refused_policy"
    | "skipped_not_configured"
    /** The execution deadline closed before this call could safely start. */
    | "skipped_deadline"
    /**
     * Credit authorisation refused the call. Nothing was started, so this is
     * not a failure and costs nothing — it is the spend equivalent of
     * `skipped_deadline`, and the run checkpoints for the same reason.
     */
    | "skipped_credit_refused"
    /**
     * A previous invocation already bought this exact answer, or already gave up
     * on this company. Costs nothing and is not a failure.
     */
    | "skipped_resume_reuse"
    /**
     * A run left pending by an EARLIER invocation finished, and this attempt
     * read its dataset. Costs nothing — the run was charged when it started —
     * and it is the only record that a pending run ever ended. See
     * `pending_runs`.
     */
    | "run_adopted"
    /**
     * This lineage already bought this discovery question (same queries,
     * batches, regions, role and industries). The top of the same result set
     * would come back again; see `memo23QueryFamily`. Costs nothing.
     */
    | "skipped_repeat_query"
    /**
     * The call SUCCEEDED and some rows it returned were not usable candidates.
     * Not a failure and not a skip — it is the difference between the row count
     * the provider reports and the row count that entered the pool, which is
     * otherwise invisible. See `nonCompanyPageReason`.
     */
    | "rows_dropped";
  rows: number;
  cost_units: number;
  reason: string | null;
  /**
   * A stable digest of the input this attempt actually sent.
   *
   * The unit of "already tried". Without it the only available key is the actor,
   * and keying on the actor blocks the single most useful recovery there is:
   * the same actor, asked a better question. See `withoutRepeats`.
   */
  input_fingerprint?: string;
}

/**
 * Turn what the providers DID into something the planner can act on.
 *
 * ── THE GENERAL RULE THIS IMPLEMENTS ────────────────────────────────────────
 *
 * The engine classifies every attempt — `ok`, `empty`, `error`, `compile_failed`
 * — and used to tell the planner about exactly one of them. So a re-plan was
 * made blind to the two failures that most needed explaining:
 *
 *   empty  the actor worked and the QUESTION was wrong — too narrow a filter,
 *          an over-specific enum. Recoverable, usually by the same actor.
 *   error  the actor REJECTED the input. Our catalog and the live schema
 *          disagree, and no retry of the same input will ever succeed.
 *
 * Both are now stated in the planner's own feedback channel, in the same shape
 * as a validator refusal, because to the planner they are the same kind of fact:
 * "this did not work, here is why, choose again."
 *
 * PURE. Reads attempts, returns sentences.
 */
export function discoveryAttemptFeedback(
  attempts: readonly ProviderAttempt[],
): Array<{ code: string; message: string; actor_key?: string }> {
  const out: Array<{ code: string; message: string; actor_key?: string }> = [];
  const seen = new Set<string>();
  for (const a of attempts) {
    const key = `${a.provider}|${a.outcome}`;
    if (seen.has(key)) continue;

    if (a.outcome === "empty") {
      seen.add(key);
      out.push({
        code: "actor_returned_no_rows", actor_key: a.provider,
        message:
          `${a.provider} ran successfully and returned ZERO rows for the input it ` +
          `was given. The actor works; the question was too narrow. Widen or drop ` +
          `the most restrictive filters — an over-specific enum value is the usual ` +
          `cause — and ask it again, or choose a different source. Do not repeat ` +
          `the identical input: it will return zero again.`,
      });
    } else if (a.outcome === "error") {
      seen.add(key);
      out.push({
        code: "actor_rejected_input", actor_key: a.provider,
        message:
          `${a.provider} REJECTED the input: ${a.reason ?? "unknown provider error"}. ` +
          `This is a contract failure rather than an empty result — the fields or ` +
          `values sent are not what the live actor accepts, so no retry of the ` +
          `same input can succeed. Send only fields you are confident of, or use ` +
          `a different actor.`,
      });
    } else if (a.outcome === "skipped_not_configured") {
      seen.add(key);
      out.push({
        code: "actor_not_configured", actor_key: a.provider,
        message:
          `${a.provider} could not run: ${a.reason ?? "it is not configured in this " +
          "environment"}. Treat it as unavailable for this run.`,
      });
    }
  }
  return out;
}

/**
 * What the Workbench may show WHILE the run is still going.
 *
 * Every field is a count of something already proven. There is deliberately no
 * "qualified" number before the Brain has run: a mid-run row that looks
 * qualified is the fail-open the whole persistence-authority change was for.
 */
export interface EngineProgress {
  stage:
    | "accounts_found" | "prequalified" | "identity_resolved"
    | "companies_enriched" | "hiring_verified" | "qualified" | "decision_makers_verified";
  accounts_found: number;
  evaluated: number;
  eligible_opportunities: number;
  exclusion_reasons: Record<string, number>;
  identity_resolved: number;
  identity_unresolved: number;
  companies_enriched: number;
  hiring_verified: number;
  /** Only ever set by `company_brain_qualification`. Zero until then. */
  qualified_companies: number;
  decision_makers_verified: number;
  /** Every job in every discovered company's `openJobs`, not just commercial ones. */
  open_jobs_evaluated: number;
  shortlisted: number;
  /**
   * Is work ACTIVELY happening right now?
   *
   * Published as `true` from inside the run. It is NOT a synonym for "some
   * capability is still pending": a partial run legitimately ends holding
   * pending capabilities, and reading those as activity is what would leave a
   * finished workflow saying "Sourcing in progress" forever. The caller
   * corrects this once when the invocation ends — see {@link finalizedProgress}.
   */
  in_progress: boolean;
  /** A billed Actor run is still in flight; the workflow is resumable, not dead. */
  awaiting_external_run: boolean;
}

/** One company's free prequalification verdict, as persisted. */
export interface PrequalificationRecord {
  company_key: string;
  name: string;
  canonical_domain: string | null;
  team_size: number | null;
  size_status: PrequalifiedCompany["size_status"];
  best_tier: PrequalifiedCompany["best_tier"];
  score: number;
  strongest_signal: string | null;
  /** Every commercial job, not just the strongest. */
  commercial_jobs: string[];
  /** The vocabulary's OPINION. Ranking only — it excludes nobody. */
  eligible: boolean;
  exclusion: PrequalifiedCompany["exclusion"];
  // `shortlisted` DELETED. Prequalification does not decide the shortlist, so
  // recording its guess here produced a second, contradictory answer to "was
  // this company investigated?" — one that `applyMissionIntelligence` had
  // already overwritten on the working set. `state.shortlist_decision` is the
  // single record.
  reasons: string[];
}

/** A route controller's proposal and code's decision, as persisted. */
export interface RouteControlRecord {
  wave: number;
  plan_version: number | null;
  proposal: Record<string, unknown> | null;
  accepted: boolean;
  action: string;
  reason: string | null;
  detail: string | null;
  new_plan_version: number | null;
}

export interface CapabilityExecutionState {
  version: typeof CAPABILITY_EXECUTION_STATE_VERSION;
  // ── P2: THE EXECUTION SPINE, CARRIED WITH THE STATE (so continuations keep it) ──
  /** Every RetrievalPlan version, oldest first. The last is current. */
  retrieval_plans?: RetrievalPlan[];
  /** Estimate → reserve → execute → settle, against absolute ceilings. */
  spend_ledger?: SpendLedger;
  /** Append-only mission trace. */
  mission_trace?: MissionTrace;
  /** Compact form of every compiled ProviderCallSpec (the ledger row holds the full spec). */
  provider_call_specs?: Array<ReturnType<typeof specSummary>>;
  /**
   * Discovery rows this MISSION has bought, across every wave and slice.
   *
   * `run_budget.max_candidates` is "the most candidates discovery may buy",
   * and it was enforced per call: each call's `maxItems` was clamped to it,
   * so a second wave bought the allowance again (canary 6e4a93b9: a 2-candidate
   * budget bought 2 + 2 rows over two pages). This is the running total the
   * clamp is taken against.
   */
  discovery_rows_bought?: number;
  // ── P4: THE RESEARCH FABRIC'S FEEDBACK, CARRIED WITH THE STATE ──
  /** One summary per discovery wave, oldest first (researchFeedback). */
  research_waves?: ResearchWaveSummary[];
  /**
   * P5 — providers the tool layer deterministically refused for THIS mission
   * (opt-in actor not enabled, not configured). Carried with the state so a
   * continuation does not ask again. See providerAvailability.ts.
   */
  unavailable_providers?: UnavailableProvider[];
  /**
   * Claim-verifier provider runs still executing when a slice ended — adopted
   * by run id on the next slice, never bought twice (`claimVerifier`).
   */
  verifier_pending_runs?: PendingVerifierRun[];
  /** Every route-control proposal and what code decided about it. */
  route_controls?: RouteControlRecord[];
  /** Binds this state to the mission it was produced for. */
  mission_hash: string;
  /**
   * WHICH REAL ENTITIES THIS STATE WAS PRODUCED AGAINST.
   *
   * `mission_hash` covers `company_profile`, which carries company NAMES — so
   * two different real companies that share a name produce the SAME mission
   * hash, and `stateMatchesMission` would accept a checkpoint written for one
   * while executing against the other. A referent binding is exactly the thing
   * that changes which entity is acted on, so it needs its own identity.
   *
   * Deliberately a SECOND fingerprint rather than a change to `missionHash`:
   * altering what that hash covers would invalidate every persisted checkpoint
   * in the system at once. Null when the run has no bindings, which is every
   * run written before they existed — and `bindingsMatchCheckpoint` treats
   * null-against-null as compatible, so nothing already checkpointed is
   * stranded.
   */
  binding_fingerprint?: string | null;
  entry_capability: CapabilityId;
  completed_capabilities: CapabilityId[];
  current_capability: CapabilityId | null;
  pending_capabilities: CapabilityId[];
  provider_attempts: ProviderAttempt[];
  accumulated_cost_units: number;
  /** Deduplicated company identities seen, in discovery order. */
  company_keys: string[];
  qualified_company_keys: string[];
  /** Passed every gate except one that lacked evidence. NOT rejections. */
  unknown_company_keys: string[];
  contact_identities: string[];
  /**
   * WHAT THIS RUN RETURNS, versus what was asked for.
   *
   * Null until qualification runs. Non-null it always states the requested
   * entity, the returned entity, and — when they differ — the unlock that would
   * close the gap. A person mission returning accounts is a legitimate outcome;
   * returning them silently is not.
   */
  mission_output: MissionOutput | null;
  terminal_reason: string | null;
  fallback_reason: string | null;
  /**
   * WHICH ACTORS DISCOVERY CHOSE, AND WHY — field names, never the payload.
   *
   * The one record that answers "was this pool built for THIS request?" after
   * the fact. Absent on runs from before the selection stage existed, and on
   * continuations, which skip discovery entirely.
   */
  discovery_strategy?: Record<string, unknown>;
  /**
   * WHETHER DISCOVERY COULD STILL WIDEN THIS POOL.
   *
   * ── WHY A LATER SLICE HAS TO BE TOLD THIS ──────────────────────────────
   *
   * `decideAutoContinuation` used to read an exhausted frontier as the end of
   * the request. It can now ask instead whether anything remains that would
   * widen the pool — but it runs in `run-agent`, one layer above the engine,
   * and cannot see which actors ran, which pages were taken, or whether the
   * raw ceiling bound. Only discovery knows that, so discovery says it.
   *
   * Absent means "this slice did not run discovery" — a continuation that
   * restored a pool and only investigated it — and the caller reads absence as
   * "unknown", which keeps the previous terminal behaviour rather than
   * inventing a route that may not exist.
   */
  discovery_source_state?: {
    /** Actor keys this lineage has already asked, in order. */
    sources_attempted: string[];
    /** Pages taken per actor key, so a resume does not re-take page 1. */
    pages_taken: Record<string, number>;
    /** LIFETIME admitted candidates at the moment discovery stopped. */
    admitted: number;
    /**
     * Admitted candidates that could still enter or continue the investigation
     * frontier — the number discovery actually decides on. Lower than
     * `admitted` on any slice that has already spent part of its pool.
     */
    available_admitted: number;
    /** Raw rows held when discovery stopped. */
    raw_rows: number;
    /** The pool target admission was measured against. */
    pool_target: number;
    /**
     * TRUE when nothing further could widen this pool: every proposed actor
     * ran, the planner declined to propose more, or the raw-row ceiling bound.
     * This is the field that makes `frontier_exhausted` truthful again.
     */
    exhausted: boolean;
    /** Why discovery stopped, for the audit trail. */
    stop_reason:
      | "admitted_target_met"
      | "raw_row_ceiling"
      | "no_further_actor_proposed"
      | "pass_limit"
      | "schema_failure"
      | "run_pending"
      /** P2: a replan's amendment was refused (trigger, reserve or validation). */
      | "amendment_refused"
      /** `run_budget.max_candidates` is spent: nothing further may be bought, or planned. */
      | "candidate_budget_spent"
      /** The funding screen admitted all it may: nothing discovered later could be investigated. */
      | "screen_admissions_spent"
      /** The funding screen has read its pool: its one priced Atomus read is spent. */
      | "screen_complete";
  };
  /**
   * Stage removals the chain PROPOSED and containment refused.
   *
   * `validateExecutionPlan` polices what a plan contains, never what it omits,
   * and `chainSkips` only honours `OPTIONAL_BY_CHAIN` — so an amendment that
   * dropped identity resolution was inert AND unrecorded. The stage ran, which
   * was correct, and nothing said the model had asked otherwise.
   *
   * Recording it keeps the architecture's own claim honest: GPT proposed X,
   * code refused X because Y — rather than a plan that silently did not mean
   * what it said.
   */
  amendment_refusals?: Array<{
    capability: CapabilityId;
    reason: "structural_requirement";
    detail: string;
  }>;
  /**
   * The cross-capability chain the model planned, and what it left out.
   *
   * Persisted because "why did this run buy a hiring search?" and "why did it
   * NOT?" are the same question asked twice, and neither was answerable from a
   * task row. The reasoning is the model's own, recorded and never acted on.
   */
  execution_plan?: Record<string, unknown> | null;
  /**
   * WHY IDENTITY RESOLUTION ACCEPTED OR REFUSED WHAT THE ACTOR RETURNED.
   *
   * The identity stage's miss rate was unmeasurable. `acceptLinkedInMatch`
   * computes exactly which of its four paths decided, and the engine read
   * `.accepted` and discarded the rest — so a run could report "9 unresolved"
   * and nothing at all about why. Run 958c86bc's 28 Actor calls ALL succeeded
   * and ALL returned rows, so every one of those misses happened here.
   *
   * Diagnostics only. Nothing reads this to make a decision.
   */
  identity_match_diagnostics?: {
    version: "identity-match-diagnostics-v1";
    /** Companies whose candidates were judged at all. */
    companies_judged: number;
    companies_accepted: number;
    companies_rejected: number;
    /** Per-candidate outcome counts, keyed by `MatchOutcomeCode`. */
    by_code: Record<string, number>;
    /**
     * A BOUNDED SAMPLE of refusals, with what the refusal turned on.
     *
     * The two rejection codes need opposite fixes — `no_name_or_domain_match`
     * means the exact-equality NAME gate refused before corroboration was
     * consulted, `name_matched_nothing_corroborated` means corroboration itself
     * is too strict. Telling them apart needs the names and slugs side by side,
     * which is what this carries.
     */
    rejected_samples: Array<{
      company_key: string;
      company_name: string;
      company_domain: string | null;
      code: MatchOutcomeCode;
      candidate_name: string | null;
      candidate_slug: string;
      candidate_domain: string | null;
      /** Where the provider ranked this candidate, 0-based. */
      rank: number;
    }>;
    /**
     * WHERE THE ACCEPTED COMPANY WAS FOUND, one bucket per rank.
     *
     * The only measurement that can settle `maxItems`. Winners clustering at
     * ranks 0-2 mean twelve of fifteen rows are bought and never read; winners
     * appearing at 11 and 13 mean five was the miss and fifteen is earning it.
     * A match verdict cannot answer either question.
     */
    accepted_rank_histogram: Record<string, number>;
    /**
     * WHAT HAPPENED BEFORE THE MATCHER EVER SAW ANYTHING.
     *
     * `unresolved` was one word for four different facts, and the run reported
     * only the word. These separate them:
     *
     *   candidates_returned  the provider answered with rows; any miss after
     *                        this is the MATCHER's decision, and
     *                        `by_code` says which rule made it.
     *   no_candidates        the provider answered with nothing. Either this
     *                        company has no LinkedIn page, or the name index
     *                        cannot surface it at any depth — retrieval, never
     *                        matching.
     *   provider_error       the call itself faulted. Says nothing about the
     *                        company at all.
     *   not_attempted        the clock or the credit gate stopped it. Not a
     *                        finding; the company is still on the frontier.
     */
    retrieval_outcomes: Record<string, number>;
    /**
     * Which retrieval depth produced these outcomes.
     *
     * Short and full are a 2x price difference and the provider returns
     * different results for identical queries, so no single run can compare
     * them. Stamping the mode on the outcomes is what makes the comparison
     * possible ACROSS runs, from data rather than from argument.
     */
    retrieval_modes: Record<string, number>;
  };
  /**
   * WHICH REQUIRED SIGNALS THIS RUN COULD ANSWER, and why any could not.
   *
   * The record that separates "no more candidates" from "no source could ever
   * have answered this" — the two endings a shortfall can have, which look
   * identical in a count alone.
   */
  signal_coverage?: Record<string, unknown>;
  /**
   * Paid Actor runs that were still RUNNING when the poll window closed.
   *
   * These are BILLED runs that exist. Discarding them is what abandoned TEST run
   * rWikfnKgnp5DazDYr (dataset KmurtcXfCOhGcBmH4) — started, charged, never read.
   * A resume adopts the run id instead of starting a second Actor.
   */
  /**
   * RUNS THIS LINEAGE ALREADY FINISHED, rebuilt from the ledger each slice by
   * `recoverCompletedRuns`. A call with the same provider and input re-reads
   * that run instead of buying it again (run 4250f181 bought one twice).
   */
  completed_runs?: Array<{
    provider: string; run_id: string; dataset_id: string | null; input_fingerprint: string;
  }>;
  /** memo23 discovery questions this lineage has already bought — see `memo23QueryFamily`. */
  discovery_query_families?: string[];
  pending_runs: Array<{
    /**
     * NULL when the entry was rebuilt from `lead_execution_calls` by
     * `recoverPendingRuns` — the ledger stores the actor key, and the
     * actor→capability mapping is ambiguous. Adoption reads null as "any".
     */
    capability: CapabilityId | null; provider: string; run_id: string;
    dataset_id: string | null; actor_build_id: string | null; started_at: string;
    /**
     * The input that STARTED this run.
     *
     * Adoption used to match on capability+provider alone, so any later call to
     * the same stage inherited whatever run was pending — regardless of whether
     * it was asking the same question. Run ede69c8c made that unmissable: a
     * batch of ten companies timed out and went pending, and the following
     * batch of ONE adopted its run id. That company was never asked about, and
     * the other run's answer would have been read as its own.
     *
     * Optional because a run pending from before this field existed has none;
     * such an entry is not adopted, which costs one re-POST and cannot
     * attribute one question's answer to another.
     */
    input_fingerprint?: string;
    /**
     * The companies this run was asked about, in the order it was asked.
     *
     * ── A FINGERPRINT CANNOT BE RE-DERIVED, A BATCH CAN BE RE-FORMED ────────
     *
     * Adoption matches on `input_fingerprint`, which covers the WHOLE batch.
     * Batch composition changes between slices: a continuation that resolves
     * one more identity puts a different company first, the group is different,
     * the hash is different, and a finished paid run is left unread while its
     * question is bought again.
     *
     * `hiringOperationKey` already solved the same problem the other way round
     * and says so: it is "deliberately fingerprinted on the SINGLE-company
     * input rather than the batch it happened to travel in", because "a key
     * derived from it would differ every time". Adoption never got the same
     * treatment.
     *
     * Task 40800420 → 084fb495: `4LfrXM2viPf7imV8O` was pending for
     * [pursuit-sales-solutions]; the continuation batched
     * [pursuit, hirefeedd, talentoma] and started a second run. Earlier,
     * `1CPaI8ikFskPx4Fam` held 101 rows for [storm4, pursuit, careerxperts] and
     * was passed over for a batch beginning [hirefeedd, …].
     *
     * Recorded here so the next slice can re-form the batch EXACTLY as asked —
     * same companies, same order — which makes the fingerprint match by
     * construction rather than by luck.
     *
     * Optional: an entry from before this field existed has none and simply is
     * not re-formed, which is the behaviour that already exists.
     */
    company_keys?: string[];
  }>;
  /**
   * The FREE decision about who was worth paying to identify.
   *
   * Persisted in full — including the exclusions — because "why was this
   * company not pursued?" is the question the previous run could not answer
   * without reading 16 zero-row Actor datasets by hand.
   */
  prequalification: {
    version: string;
    total_rows: number;
    unique_companies: number;
    artifacts_excluded: number;
    eligible_companies: number;
    employee_size_excluded: number;
    technical_only_companies: number;
    /**
     * HOW MANY COMPANIES THE GENERIC PASS COULD READ.
     *
     * The free pre-pass used to run only on a YC pool. It now also scores every
     * company from every other discovery actor, off the normalized row and that
     * normalizer's own `field_trust` map. This counts the second half.
     *
     * Zero on a pure-YC run is correct and expected. Zero on a run whose
     * discovery was a LinkedIn or funding search means a new actor is reaching
     * the paid stages ungated — which is the condition this field exists to
     * make visible rather than leave to be inferred from a cost line.
     */
    generic_scored: number;
    generic_version: string;
    /** Of those, how many carried an EXACT, trusted headcount — the one gate. */
    generic_with_trusted_size: number;
    /** …and how many carried a description, the ICP gate's primary input. */
    generic_with_description: number;
    /**
     * FACTS about the pool, carried beside the verdict.
     *
     * Without them an audit sees "0 eligible" and cannot tell an empty pool
     * from one full of companies hiring the wrong role — the ambiguity that
     * made a healthy pool read as an ICP failure on run 1af9b9ea.
     */
    companies_with_open_roles: number;
    companies_with_commercial_roles: number;
    companies_with_technical_roles: number;
    /** Which way the mission read those facts. */
    technical_roles_satisfy_signal: boolean;
    any_open_role_satisfies_signal: boolean;
    /** EVERY job seen across every company, commercial or not. */
    open_jobs_evaluated: number;
    // `shortlist_keys` DELETED. Prequalification no longer decides the
    // shortlist; `state.shortlist_decision` is the single record of who was
    // investigated and why. Reporting both let the run name one set of
    // companies and pay for another.
    companies: PrequalificationRecord[];
  } | null;
  /**
   * STAGE 2 counts — how many companies GPT read, and what it said.
   *
   * Null when Mission Intelligence did not run, which is a different fact from
   * "it ran and found nothing relevant". Both must be answerable from the task
   * row alone.
   */
  triage: Record<string, number> | null;
  /**
   * STAGE 3 — the budget that was authorised and how the shortlist was chosen.
   *
   * `budget.source` is the field that says WHY the number was what it was:
   * `default`, an operator's `environment` override, the Stage 2 ceiling, or
   * simply the size of the pool.
   */
  shortlist_decision: {
    /**
     * THE PER-PASS SPEND ALLOWANCE — what one investigation slice may buy.
     *
     * Not the number handed to `buildSmartShortlist`. That call is deliberately
     * given the whole pool so it ranks without excluding anyone, and recording
     * ITS budget here reported the pool size as though it were the spend.
     */
    budget: InvestigationBudget;
    /**
     * POOL COMPOSITION from the ranking pass: how many were hard-excluded, how
     * many each triage verdict, how many ranked. `counts.selected` is a
     * property of THAT call and equals `ranked` — it is not the spend. Read
     * `investigation_selected` for what was actually authorised.
     */
    counts: Record<string, number>;
    ranking: string[];
    /** How untriaged candidates were treated. See `UntriagedPolicy`. */
    untriaged_policy: string;
    /** What the wall clock allowed. Null when the run had no deadline. */
    time_capacity: TimeCapacity | null;
    /** The CHEAP budget, sized independently of the paid one. */
    gpt_budget: GptBudget;
  } | null;
  /**
   * THE FULL RANKED POOL, persisted so a continuation can resume the frontier.
   *
   * The ranking is decided once by GPT triage. Every later pass and every later
   * invocation is a cursor over THIS list, which is why the shortlist can be
   * re-entrant without ever re-triaging or re-deciding.
   */
  investigation_ranking: string[];
  /**
   * COMPANIES AUTHORISED FOR PAID INVESTIGATION by this invocation, summed
   * over every pass. This — not the ranking's `counts.selected` — is what
   * "how many did the run shortlist?" means, and it lives on the state rather
   * than inside `shortlist_decision` because a continuation skips discovery
   * and so has no shortlist decision of its own, yet still buys slices.
   */
  investigation_selected: number;
  /**
   * THE FUNDING SCREEN's verdict per screened company (`fundingPoolScreen.ts`),
   * kept so a continuation that re-ranks the frontier still admits passes
   * first. Absent when no screen ran.
   */
  funding_screen?: {
    verdicts: Record<string, ScreenVerdict>;
    /**
     * The screen's admissions (`plan.admit`) are all spent. From here nothing
     * this mission discovers can be admitted, so nothing more is discovered or
     * screened — canary 1a0c3234 reopened discovery after its two admissions,
     * bought page 3 and started a second Atomus read on companies it could
     * never admit.
     */
    admissions_spent?: boolean;
    /**
     * The screen has READ the pool (its one Atomus call was made). The plan
     * prices exactly one read, so discovery is over for the mission whether or
     * not every admission was used — canary 207dbdb6 admitted 1 of 2 (three
     * funding FAILs), reopened discovery for the free slot and bought page 5,
     * which only a second, unpriced Atomus read could have screened.
     */
    screened?: boolean;
  };
  /** One entry per slice taken. "Why only ten?" is answerable from this. */
  investigation_slices: Array<{
    pass: number;
    selected: number;
    /**
     * Companies this pass inherited already `in_flight` from a previous
     * invocation. They spend the same allowance, so `selected` is reduced by
     * this much — recorded so a small slice is explainable.
     */
    carried: number;
    remaining: number;
    investigated: number;
    excluded: number;
    reason: string;
  }>;
  /**
   * The wall-clock capacity that bounded paid investigation.
   *
   * Surfaced at the top level too, because "the clock, not the config" is the
   * commonest reason a run investigates fewer companies than it authorised and
   * it should not require digging into the shortlist decision to find out.
   */
  investigation_capacity: TimeCapacity | null;
  /** The last published progress snapshot. Never contains a premature pass. */
  progress: EngineProgress | null;
}

export function newExecutionState(
  plan: CapabilityPlan, missionHashValue: string,
  bindingFingerprintValue: string | null = null,
): CapabilityExecutionState {
  return {
    version: CAPABILITY_EXECUTION_STATE_VERSION,
    mission_hash: missionHashValue,
    binding_fingerprint: bindingFingerprintValue,
    entry_capability: plan.entry_capability,
    completed_capabilities: [],
    current_capability: null,
    pending_capabilities: plan.steps.map((s) => s.capability),
    provider_attempts: [],
    mission_output: null,
    accumulated_cost_units: 0,
    company_keys: [],
    qualified_company_keys: [],
    unknown_company_keys: [],
    contact_identities: [],
    terminal_reason: null,
    fallback_reason: null,
    pending_runs: [],
    prequalification: null,
    triage: null,
    shortlist_decision: null,
    investigation_ranking: [],
    investigation_selected: 0,
    investigation_slices: [],
    investigation_capacity: null,
    progress: null,
  };
}

/**
 * Is this state safe to resume against this mission?
 *
 * A state whose `mission_hash` disagrees belongs to a DIFFERENT question, and
 * continuing from it would silently answer the old one. Resuming from scratch
 * costs money; resuming from the wrong mission costs correctness.
 */
export function stateMatchesMission(
  state: CapabilityExecutionState | null | undefined, missionHashValue: string,
  /**
   * The bindings this invocation resolved. Omitted, only the mission is
   * compared — which is the behaviour every caller had before bindings
   * existed, and is why no existing checkpoint is stranded.
   */
  bindingFingerprintValue: string | null = null,
): boolean {
  if (!state || state.version !== CAPABILITY_EXECUTION_STATE_VERSION) return false;
  if (state.mission_hash !== missionHashValue) return false;
  // ── A CHECKPOINT FOR COMPANY A MUST NEVER RESUME AGAINST COMPANY B ───────
  //
  // The mission hash cannot see this: it covers company NAMES, and two real
  // companies can share one. `bindingsMatchCheckpoint` treats absent-on-both
  // as compatible, so this is inert for every run that has no bindings.
  return bindingsMatchCheckpoint(state.binding_fingerprint, bindingFingerprintValue);
}

/**
 * The execution plan a previous slice already paid for, if it is safe to reuse.
 *
 * Returns the RAW steps, not a plan: the caller re-runs `validateExecutionPlan`
 * over them, so a restored chain crosses exactly the same containment boundary
 * a fresh one does. Reuse is about not re-buying the model's DECISION; it is
 * never about trusting a stored one.
 *
 * Null — meaning "plan again" — whenever anything is less than certain:
 *
 *   * the mission hash disagrees, so this state answers a different question;
 *   * the stored plan was blocked, or has no steps;
 *   * any step is missing its `input`, which is how a checkpoint written before
 *     inputs were persisted looks. Half a decision is not one to resume from,
 *     and silently reusing it would run every Actor with no filters at all.
 */
/**
 * How many candidates one identity search asks for.
 *
 * WAS FIVE, AND FIVE WAS THE MISS. Run a5332734 is the first with per-candidate
 * match telemetry, and it says the same thing five times: the rejected
 * companies were rejected CORRECTLY, because the right LinkedIn page was not in
 * the results at all.
 *
 *   Autonomous Technologies Group  →  Autonomous Solutions, Inc. (asirobots.com)
 *   HUD (hud.ai)                   →  HUD (willhudsondesign.com) — a portfolio
 *   Trata (trytrata.com)           →  Trata Soluções Acústicas (Brazil)
 *   Dex (joindex.com)              →  DEX, no website at all
 *   Elayne (elayne.com)            →  Ethereal Elayne Freight Broker LLC
 *
 * Every impostor is larger and older than a five-person YC startup, and
 * `searchQuery` is a NAME index ranked by prominence. A short common name —
 * "HUD", "Dex", "Trata", "Elayne" — puts the startup below the establishment,
 * and five results never reach it.
 *
 * THIS IS AN EXPERIMENT WITH A READ-OUT, NOT A FIX. It is not known that these
 * pages rank 6th-15th; some may not exist on LinkedIn at all. What is known is
 * that a miss already costs the whole ~8.4s call, while an extra result costs
 * $0.002-0.004 — so the asymmetry is worth the try, and
 * `identity_match_diagnostics` measures the answer directly. If misses convert
 * to `domain_exact` accepts it worked; if rejected companies still show no
 * name-matching candidate at all, these pages are not reachable by name and the
 * answer is a different resolution strategy.
 */
/**
 * The latency key for ONE company's identity search.
 *
 * Named once and read everywhere, because `observeCall` and `estimateFor` are
 * only discussing the same work if they agree on the key. The Actor behind it
 * also runs discovery, at fifty companies a call — see `STAGE_SCOPED_PROVIDERS`
 * for what sharing one number between the two cost.
 */
export const IDENTITY_SEARCH_OP = deadlineOperationFor(
  "company_identity_resolution", "apify_linkedin_company_search");

export const IDENTITY_SEARCH_MAX_ITEMS = 15;

/**
 * Which retrieval depth the identity search buys: `full`.
 *
 * ── `short` CANNOT PRODUCE AN IDENTITY ─────────────────────────────────────
 *
 * This was `short`, on the belief that every field the stage reads is returned
 * in both modes. Production disproved it. Lead V2 run 4250f181 bought 13 short
 * searches; all 108 rows carried `_meta, followers, id, industry, linkedinUrl,
 * location, logo, name, summary, universalName` — no `website`, no
 * `description`. `resolveIdentityAgainstLookups` verifies only on a website
 * domain, so a correct name hit could reach `ambiguous` at best: 13 attempted,
 * 0 resolved, and nothing downstream (enrichment, hiring verification,
 * evaluation) ever ran. The actor benchmark's field matrix lists `website` as a
 * direct `full` output (experiments/hiring-actor-benchmark-2026-08-01).
 *
 * The execution plan asked for `full` as well; the merge policy lets execution
 * own `scraperMode`, and execution now agrees with it.
 *
 * `full` also returns the declared size band, the LinkedIn member count and
 * `industries`, none of which a search row PROVES: the band is plausible here,
 * the member count is never a size, and size and industry are settled by
 * `company_enrichment`. The extra $0.002 a row buys the one field
 * identity cannot be proved without.
 */
export const SEARCH_SCRAPER_MODE: "short" | "full" = "full";

/**
 * The QUESTION a memo23 discovery call asks, independent of how it is phrased.
 *
 * Queries, batches, regions, role, industries and the hiring flag decide which
 * companies come back; memo23 has no page cursor, so asking the same question
 * again returns the top of the same result set. Size bounds are deliberately
 * NOT part of the key: loosening a minimum re-reads the same leaders (run
 * 4250f181: `minEmployeeSize` 5+ → 1+ returned the identical ten companies).
 * Absent `batch` / `industries` are memo23's own defaults, so they are spelled
 * out — the same question must not look new because a default went unstated.
 */
export function memo23QueryFamily(input: Record<string, unknown>): string {
  const list = (v: unknown, dflt: string[] = []) => {
    const a = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
    const out = a.map((x) => String(x).trim().toLowerCase()).filter(Boolean).sort();
    return out.length ? out : dflt.map((d) => d.toLowerCase());
  };
  return JSON.stringify({
    q: list(input.queries),
    b: list(input.batch, ["All Batches"]),
    r: list(input.regions),
    i: list(input.industries, ["All industries"]),
    role: String(input.role ?? "").trim().toLowerCase(),
    hiring: input.isHiring === true,
    mode: String(input.mode ?? "companies"),
  });
}

/**
 * The `locations` filter for an identity search, or nothing.
 *
 * ONLY WHEN THE MISSION MADE GEOGRAPHY HARD. A soft or absent geography is a
 * ranking preference, and turning it into a provider filter would silently
 * narrow a search the user never narrowed — the same authority inversion the
 * prequalification size bound was fixed for.
 *
 * Normalised through `normalizeLocationName`, which maps the abbreviations a
 * model emits — "US", "USA", "America" — to "United States", the exact value in
 * this actor's own verified example. Anything outside that small table passes
 * through VERBATIM, which is deliberate: the table covers abbreviations, not
 * places, and dropping every location it does not list would discard "Germany"
 * and "San Francisco" along with the typos. A location the actor does not
 * recognise costs this one search its results; a location silently dropped
 * costs the mission its geography on every search.
 */
/**
 * Measured cost of one company in a job search carrying the 20-title vocabulary.
 *
 * NOT an assumption. Task 783fa163 ran this Actor twice on the same titles:
 *
 *     companies  queries  duration  per query  per company  run
 *             1       20     72.0s      3.60s        72.0s  Ot2Jpwe8ezMvbe6Eu
 *            10      200    796.4s      3.98s        79.6s  Zs5bYFGlnua1hJWYg
 *
 * The Actor fans out one LinkedIn query per company×title pair — its rows carry
 * `query.company` and `query.search`, which is how this is knowable — so the
 * duration is linear in that product at ~4s a query. Fitted slope: 80.5s.
 */
export const HIRING_MS_PER_COMPANY = 80_000;

/**
 * How long a batch may keep the lineage waiting.
 *
 * ── WHY A WAIT BUDGET AND NOT A SLICE BUDGET ────────────────────────────────
 *
 * This constant was 10, on the recorded belief that "a call carrying ten
 * companies costs the same ~48s as one carrying a single company". The table
 * above is that belief measured, and it is false: cost is linear, so ten
 * companies is ~800s. Nothing about that fits a 125s slice — not ten, not
 * three, not one.
 *
 * So the batch cannot be sized against the slice. What it CAN be sized against
 * is the wait: the run is persisted on start and adopted by a later slice for
 * free, but every slice spent polling is one drawn from
 * `DEFAULT_MAX_CONTINUATIONS`, which is 10. At the old batch size that is
 * ~6.4 slices of pure waiting — a mission spending two thirds of its
 * continuation budget watching one call, which is what run 783fa163 did before
 * `no_progress` cut it off at 796s with the results unread.
 *
 * 250s is ~2 slices of waiting. It is the largest batch that leaves the lineage
 * enough continuations to do anything with the answer.
 */
export const HIRING_BATCH_WAIT_BUDGET_MS = 250_000;

/**
 * Companies per paid hiring search.
 *
 * Derived, not chosen: the wait budget divided by the measured per-company
 * cost, floored at 1 because a batch of none asks nothing, and capped at 10
 * because `compileHarvestJobSearchInput` validates `company[]` at the Actor's
 * own verified maximum of 10.
 *
 * Evidence handling is UNAFFECTED at any size. Rows are routed by
 * `company_linkedin_url` and a row naming a company outside the batch is
 * dropped, so a smaller batch changes how many HTTP calls carry the twenty
 * titles and nothing else. The 20-title vocabulary, the evidence standard and
 * the per-company operation key are all unchanged.
 */
export const HIRING_VERIFICATION_BATCH_SIZE = Math.max(
  1,
  Math.min(10, Math.floor(HIRING_BATCH_WAIT_BUDGET_MS / HIRING_MS_PER_COMPANY)),
);

/**
 * Job rows requested per company in a batch.
 *
 * Held at the per-company figure the single-company call used, multiplied by
 * the batch size, so a batch asks for exactly what the individual calls it
 * replaces would have asked for. Raising it would change the evidence
 * standard, which this work deliberately does not.
 */
export const HIRING_JOBS_PER_BATCH_COMPANY = 10;

/**
 * THE DEFAULT ROLE VOCABULARY — for a mission that named no roles.
 *
 * ── IT USED TO DELETE A WHOLE TIER ────────────────────────────────────────
 *
 * This was `[...TIER_A_TITLES, ...TIER_B_TITLES].slice(0, 20)`, under a comment
 * promising "same titles, same order, same evidence standard". TIER_A holds 21
 * entries, so the slice kept twenty of TIER_A and NONE of TIER_B — every title
 * the returned data was actually full of (`account executive`, `sdr`, `bdr`,
 * `sales development representative`, `sales director`) was silently dropped by
 * an off-by-one nobody re-checked when TIER_A grew.
 *
 * `hiringSearchTitles` interleaves the tiers instead, so the cap can shorten a
 * list but can never erase one.
 *
 * ── AND IT IS NO LONGER WHAT A REAL RUN SENDS ─────────────────────────────
 *
 * A run derives its titles from the MISSION, once, and hands the same list to
 * both the provider call and the operation key that decides whether to make it.
 * This constant is the fallback for a mission that named no roles, and is kept
 * exported because tests and older callers read it.
 */
export const HIRING_JOB_TITLES: string[] = hiringSearchTitles(null);

export function identitySearchLocations(mission: LeadMissionV1): string[] {
  if (!missionGeographyIsHard(mission)) return [];
  const seen = new Set<string>();
  for (const raw of mission.company_profile?.locations ?? []) {
    const norm = normalizeLocationName(raw);
    if (norm) seen.add(norm);
  }
  // The compiler validates a maximum of 20; keep this side of it by construction.
  return [...seen].slice(0, 20);
}

/**
 * Did the Mission make geography HARD?
 *
 * TWO CARRIERS, ONE ANSWER. The legacy boolean `geography_is_hard`, and the
 * compiled Mission's own `hard_constraints["company_profile.locations"]`. Lead
 * V2 run 4250f181 carried only the second — "stated explicitly in the user's
 * query" — and this function read only the first, so a US-only mission sent
 * every identity search worldwide and got back Hamburg, Portland and Casablanca.
 */
export function missionGeographyIsHard(mission: LeadMissionV1 | null | undefined): boolean {
  if (!mission) return false;
  if (mission.geography_is_hard === true) return true;
  const hc = (mission.hard_constraints ?? {}) as Record<string, unknown>;
  const loc = hc["company_profile.locations"];
  return !!loc && typeof loc === "object" &&
    (mission.company_profile?.locations ?? []).length > 0;
}

/**
 * The exact LinkedIn company-search input for one identity lookup.
 *
 * ONE PLACE, so the live call, the dry run and the tests describe the same
 * search: the company's NAME (never its domain — that belongs in match
 * verification), `full` rows so a website can confirm the domain, and the
 * Mission's hard geography as a provider filter.
 */
export function buildIdentitySearchInput(
  company: { company?: { company_name?: string | null }; prequalified?: PrequalifiedCompany | null },
  mission: LeadMissionV1,
) {
  const locations = identitySearchLocations(mission);
  return compileHarvestCompanySearchInput({
    searchQuery: company.prequalified
      ? linkedInSearchQueryFor(company.prequalified)
      : (company.company?.company_name ?? ""),
    scraperMode: SEARCH_SCRAPER_MODE,
    maxItems: IDENTITY_SEARCH_MAX_ITEMS,
    ...(locations.length ? { locations } : {}),
  });
}

/** What the provider did, before any matching rule was consulted. */
export type RetrievalOutcome =
  | "candidates_returned" | "no_candidates" | "provider_error" | "not_attempted";

/**
 * Record what retrieval did for one company.
 *
 * SEPARATE FROM `recordMatchDecisions` on purpose. That function answers "which
 * rule refused this candidate", and it can only run when there are candidates —
 * so the two cases where there are none were absent from every diagnostic this
 * system has produced. A company LinkedIn has no page for and a company the
 * matcher rejected both left the stage as `unresolved`, and the difference is
 * exactly the one that decides whether to change the QUERY or the RULES.
 *
 * Counts only. The per-company detail lives in `rejected_samples`, which is
 * bounded; this is the denominator that makes those samples readable.
 */
export function recordRetrievalOutcome(
  state: CapabilityExecutionState,
  company: { key: string },
  outcome: RetrievalOutcome,
): void {
  void company;
  const d = state.identity_match_diagnostics ?? {
    version: "identity-match-diagnostics-v1" as const,
    companies_judged: 0, companies_accepted: 0, companies_rejected: 0,
    by_code: {}, rejected_samples: [],
    accepted_rank_histogram: {}, retrieval_modes: {}, retrieval_outcomes: {},
  };
  d.retrieval_outcomes ??= {};
  d.retrieval_outcomes[outcome] = (d.retrieval_outcomes[outcome] ?? 0) + 1;
  state.identity_match_diagnostics = d;
}

/** How many refusals to keep verbatim. Enough to see a pattern, bounded. */
export const MAX_MATCH_REJECTION_SAMPLES = 25;

/**
 * Record what identity matching decided, and what it decided it on.
 *
 * PURELY OBSERVATIONAL. Called after the filter has already run; it cannot
 * change which candidates survive, and it is safe on a run with no diagnostics
 * consumer at all.
 *
 * A company counts ONCE — as accepted if any candidate was accepted — because
 * the question being measured is "did this company get an identity", not "how
 * many of five search hits were wrong", which is always most of them.
 */
export function recordMatchDecisions(
  state: CapabilityExecutionState,
  company: { key: string; company: { company_name?: string | null; canonical_domain?: string | null } },
  decisions: ReadonlyArray<{
    code: MatchOutcomeCode;
    accepted: boolean;
    candidate_name: string | null;
    candidate_slug: string;
    candidate_domain: string | null;
    /** The provider's own ordering, 0-based. */
    rank?: number;
    /** `short` or `full` — the depth this search was bought at. */
    retrieval_mode?: string;
  }>,
  opts: {
    /**
     * THE RESOLVER'S VERDICT, when the caller has it. The company counts as
     * accepted only if its identity became actionable — never because one
     * candidate passed a matcher the resolver then overruled.
     */
    authoritativeVerified?: boolean;
  } = {},
): void {
  if (decisions.length === 0) return;
  const d = state.identity_match_diagnostics ?? {
    version: "identity-match-diagnostics-v1" as const,
    companies_judged: 0, companies_accepted: 0, companies_rejected: 0,
    by_code: {}, rejected_samples: [],
    accepted_rank_histogram: {}, retrieval_modes: {}, retrieval_outcomes: {},
  };
  // Older checkpoints predate these three; absent is empty, never a crash.
  d.accepted_rank_histogram ??= {};
  d.retrieval_modes ??= {};
  d.retrieval_outcomes ??= {};

  for (const dec of decisions) {
    d.by_code[dec.code] = (d.by_code[dec.code] ?? 0) + 1;
    if (dec.retrieval_mode) {
      d.retrieval_modes[dec.retrieval_mode] = (d.retrieval_modes[dec.retrieval_mode] ?? 0) + 1;
    }
  }

  // THE FIRST ACCEPTED CANDIDATE'S RANK, not every accepted one: the question
  // is how deep the search had to go to find the company, and a second
  // acceptance further down does not change that answer.
  const winner = decisions.find((x) => x.accepted);
  if (winner && typeof winner.rank === "number") {
    const bucket = String(winner.rank);
    d.accepted_rank_histogram[bucket] = (d.accepted_rank_histogram[bucket] ?? 0) + 1;
  }

  const accepted = opts.authoritativeVerified ?? decisions.some((x) => x.accepted);
  d.companies_judged++;
  if (accepted) d.companies_accepted++;
  else d.companies_rejected++;

  // THE CLOSEST REFUSAL, not the first. A name that matched and failed only on
  // corroboration says something different from a name that never matched, and
  // when both are present the former is the informative one.
  if (!accepted && d.rejected_samples.length < MAX_MATCH_REJECTION_SAMPLES) {
    const closest = decisions.find((x) => x.code === "name_matched_nothing_corroborated")
      ?? decisions[0];
    d.rejected_samples.push({
      company_key: company.key,
      company_name: company.company.company_name ?? company.key,
      company_domain: company.company.canonical_domain ?? null,
      code: closest.code,
      candidate_name: closest.candidate_name,
      candidate_slug: closest.candidate_slug,
      candidate_domain: closest.candidate_domain,
      rank: typeof closest.rank === "number" ? closest.rank : -1,
    });
  }

  state.identity_match_diagnostics = d;
}

export function reusableStoredPlan(
  state: CapabilityExecutionState, missionHashValue: string,
): unknown[] | null {
  if (state.mission_hash !== missionHashValue) return null;
  const stored = state.execution_plan as
    { source?: unknown; steps?: unknown } | null | undefined;
  if (!stored || stored.source === "blocked") return null;
  const steps = Array.isArray(stored.steps) ? stored.steps : null;
  if (!steps || steps.length === 0) return null;
  const everyStepComplete = steps.every((raw) => {
    const step = raw as Record<string, unknown> | null;
    return !!step && typeof step === "object" &&
      typeof step.capability === "string" &&
      !!step.input && typeof step.input === "object" && !Array.isArray(step.input);
  });
  return everyStepComplete ? steps : null;
}

// -------------------------------------------------------------- working set ----

/**
 * HOW THIS COMPANY'S VERDICT WAS ACTUALLY REACHED.
 *
 * PHASE 0 INSTRUMENTATION, AND IT MEASURES THE THING THE AUDIT COULD NOT.
 *
 * `capability_outcomes` reported `company_brain_qualification: {status:"complete",
 * rows:0, reason:"no company passed the Company Brain"}` for a run in which the
 * Brain's eligible set was EMPTY. "Nobody passed" and "nobody was offered" are
 * different facts and the artifact could not tell them apart, so a scheduling
 * gap read as twenty rejections.
 *
 * These five values are mutually exclusive and total: every company carries
 * exactly one, and `not_reached` is the honest answer for a company the gate
 * never saw. Nothing here CHANGES a decision — it records which code made it.
 *
 *   not_reached        never entered the Brain's eligible set
 *   fabricated_pass    `company_fit_pass` — verdict from a hardcoded assessment
 *   fabricated_reject  `company_fit_reject` — verdict from a hardcoded assessment
 *   model_evaluated    a classifier response was parsed and used
 *   model_unavailable  the pending branch was reached with no usable classifier
 */
export type EvaluationPath =
  | "not_reached"
  /**
   * DECIDED BY AN EARLIER GENERATION AND CARRIED, not evaluated again.
   *
   * Distinct from `model_evaluated` on purpose: this run made no model call for
   * this company, and a telemetry that said otherwise would inflate every
   * continuation's evaluation count with work it did not do.
   */
  | "restored_decision"
  | "fabricated_pass"
  | "fabricated_reject"
  | "model_evaluated"
  | "model_unavailable";

export interface EngineCompany {
  key: string;
  /**
   * The key the FREE prequalification used for this row.
   *
   * Kept alongside `key` rather than derived from it: `key` prefers a LinkedIn
   * URL and falls back to the YC source id, so for a domainless row the two
   * genuinely differ. Carrying both is what lets a shortlist and its companies
   * stay the same set.
   */
  prequal_key: string | null;
  prequalified: PrequalifiedCompany | null;
  /**
   * ICP fit and signal/intent fit, judged separately and banded — never averaged.
   *
   * Null until qualification runs. The band is ordinal and deliberately not a
   * score: a perfect ICP match with no signal and a loud signal from outside
   * the ICP are different ACTIONS, and one number cannot say which.
   */
  lead_verdict: LeadVerdict | null;
  /** One verdict per required signal, including the ones nobody investigated. */
  signal_assessments: SignalAssessment[];
  shortlisted: boolean;
  /**
   * The GPT triage verdict — Stage 2, free, discovery-data only.
   *
   * Null when Mission Intelligence did not run. NOT a qualification: it answers
   * "worth paying to investigate?" and its vocabulary
   * (relevant/uncertain/irrelevant) is deliberately disjoint from the
   * evaluator's, so the two can never be read as the same answer.
   */
  triage: TriageVerdict | null;
  /**
   * Why this company did not make the shortlist.
   *
   * `triage_irrelevant`, `prequalification_ineligible` and `budget_exhausted`
   * are different facts. The last one especially: that company was never judged
   * at all, and rendering it as "not qualified" is the lie this field exists to
   * prevent.
   */
  shortlist_exclusion: string | null;
  /**
   * WHERE THIS COMPANY SITS IN THE INVESTIGATION FRONTIER.
   *
   * `shortlisted` is now DERIVED from this — see `wasInvestigated`. The boolean
   * could only say in-or-out, and "out" was indistinguishable between "GPT said
   * irrelevant" and "the budget stopped at ten". The first is a decision and
   * closes the company; the second is a queue position and must survive to the
   * next pass. Conflating them is what stranded 90 of 100 companies while the
   * checkpoint reported them pending forever.
   */
  investigation_state: InvestigationState;
  /** Position in the persisted triage ranking. Lower is investigated first. */
  investigation_rank: number;
  company: NormalizedHiringCompany;
  identity: IdentityResolution | null;
  /**
   * WHY THIS COMPANY HAS NO ANSWER FOR A STAGE — when the reason is the run,
   * not the company.
   *
   * Set by `callProvider` when a call for this company was skipped by the
   * checkpoint reserve (`deferred`) or failed outright (`provider_error`).
   * Both return an empty result, and an empty result is indistinguishable from
   * a genuine "nothing matched" unless something records the difference. This
   * is that record.
   *
   * `capability` scopes it, so an enrichment failure can never be misread as an
   * identity outcome. Null means every call this company made was answered.
   */
  /**
   * Why a stage stopped short on this company.
   *
   * `deferred`               investigation was budgeted, then abandoned
   * `qualification_deferred` fully investigated; only a Brain call is owed
   * `provider_error`         the provider failed
   *
   * The first two shared one string until task 3417c428. `sliceFrontier` reads
   * `deferred` as "still owed investigation" and so counted four
   * fully-investigated companies as unfinished investigation — which is true of
   * neither, and made the two states indistinguishable to every consumer.
   */
  stage_block:
    | { capability: CapabilityId; reason: "deferred" | "qualification_deferred" | "provider_error" }
    | null;
  /**
   * WHY THE BRAIN GATE DID NOT ADMIT THIS COMPANY.
   *
   * Set where eligibility is decided, read only by the funnel. Deliberately NOT
   * `stage_block`: the workbench projection returns "deferred — the run stopped
   * before this company could be finished; resuming will continue it" for ANY
   * stage_block, and a company the gate refused on the evidence is not waiting
   * on a resume. One definition, one reader, no other consumer to mislead.
   */
  brain_gate: "refuted" | "not_established" | null;
  /**
   * THE INPUTS THIS COMPANY WAS JUDGED WITH.
   *
   * Kept so a LATER evaluation — P4 re-reading web evidence after the engine has
   * returned — can be re-judged by the SAME rule rather than a second one. The
   * gates, the policy, the hiring verdict and the grounding are computed inside
   * the qualification loop from state a caller cannot reconstruct; without this,
   * anything outside the engine wanting to honour a new verdict would have to
   * reimplement `decideCompanyBrain`'s inputs, and two implementations of "is
   * this company qualified" is precisely what this codebase keeps paying for.
   */
  brain_inputs: BrainJudgementInputs | null;
  enriched: NormalizedHiringCompany | null;
  /**
   * WHAT HAPPENED WHEN ENRICHMENT WAS ATTEMPTED — explicitly, not inferred.
   *
   * `enriched === null` conflates four outcomes: the provider answered and had
   * nothing, the call failed, the call was never started, and the company never
   * reached the stage. Only the first is about the company; the rest are about
   * the run. Qualification already holds an unenriched company rather than
   * rejecting it, and this is the field that lets every OTHER consumer — the
   * checkpoint, the Workbench — tell those four apart instead of rendering all
   * of them as the same absence.
   */
  enrichment_outcome: EnrichmentOutcome;
  yc_open_jobs: NormalizedHiringJob[];
  hiring_jobs: NormalizedHiringJob[];
  /**
   * DATED PUBLIC EVIDENCE FOR A NON-HIRING SIGNAL, by signal event name.
   *
   * A map rather than a field per signal: `expansion` and `product_launch`
   * arrive the same way, from the same provider, and a third signal must not
   * need a fourth field before it can be carried. The key is the mission's own
   * signal event, so nothing has to translate between vocabularies to find it.
   */
  signal_evidence: Record<string, NormalizedNewsArticle[]>;
  /**
   * LEAD V2 P3 — "first hire in the function", when the mission asked. From the
   * posting's own words, or from a team check on a shortlisted company. Titles
   * only; no person is kept.
   */
  first_in_function?: FirstInFunctionEvidence | null;
  fit: CompanyFitResult | null;
  /** The canonical hiring decision, with its evidence and reason. */
  hiring_assessment: HiringAssessment | null;
  /**
   * The explicit Company Brain outcome. Exactly one of QUALIFIED / REVIEW /
   * REJECT for every company that reached the gate — never a silent absence.
   */
  brain: BrainDecision | null;
  /** The classifier's raw-safe parse: status, repaired fields, assessment. */
  // `semantic_parse` DELETED with the second evaluator that populated it.
  /** Stable keys of provider operations already completed for this company. */
  completed_operations: string[];
  /** The canonical evidence registry, built at qualification time. */
  evidence_registry: EvidenceRegistry | null;
  /** What survived verification against that registry. Null when not grounded. */
  grounded: GroundedVerification | null;
  /** Set when the Brain returned UNKNOWN and evidence resolution was attempted. */
  classification: { verdict: "pass" | "fail" | "unknown"; reason: string; source: string } | null;
  /** WHICH CODE DECIDED. Observability only — never read by a decision. */
  evaluation_path: EvaluationPath;
  /**
   * WHY this company ended where it did, in the vocabulary the Workbench needs.
   *
   * `not_evaluated` and `not_qualified` are different answers and the UI must
   * never render the first as the second.
   */
  decision_source: DecisionSource;
  /** The evaluator's structured answer. Null until qualification runs. */
  mission_evaluation: MissionEvaluation | null;
  /**
   * THE QUALIFICATION DECISION, held explicitly.
   *
   * Deliberately NOT read back off `record.stage`. `advance` only moves forward
   * through COMPANY_STAGE_ORDER, in which `company_fit_*` precedes
   * `hiring_verified` — and this graph verifies hiring BEFORE it qualifies, so
   * the fit stages are backward moves that `advance` correctly refuses. Reading
   * the verdict off the stage therefore lost every UNKNOWN silently, which is
   * the precise failure mode this whole module exists to prevent.
   */
  verdict: "pass" | "reject" | "unknown" | null;
  founders: NormalizedHiringPerson[];
  verified_founders: NormalizedHiringPerson[];
  contact_identities: string[];
  record: CompanyRecordState;
  /**
   * P4 — EVERY ROUTE THAT FOUND THIS COMPANY, first sighting first.
   *
   * `company.source_provenance` is one string and the first writer won it, so
   * a company the job route and a profile route both returned kept one source.
   * Optional so a pre-P4 checkpoint restores; `addCompany` always sets it.
   */
  found_by?: FoundBy[];
  /** P4 — each route's statement about this company, never merged into each other. */
  observations?: CandidateObservation[];
  /** P4 — strong identifiers that disagreed and so blocked a merge. */
  identity_conflicts?: IdentityConflict[];
}

/**
 * What triage is allowed to see: discovery-time data, and nothing else.
 *
 * NO IDENTITY, NO ENRICHMENT — not because they are unavailable (triage runs
 * before both) but because the contract must stay true if that ever changes. A
 * stage that decides where to spend must judge on what is free; letting it read
 * paid evidence would make the decision circular.
 *
 * ROLE TITLES GO OUT VERBATIM. Passing the prequalifier's classified subset
 * would hand the model the same keyword filter this stage exists to replace.
 */
function toTriageInput(c: EngineCompany): TriageCompanyInput {
  const p = c.prequalified;
  return {
    company_key: c.key,
    name: p?.name ?? c.company.company_name ?? null,
    domain: c.company.canonical_domain ?? null,
    description: p?.one_liner ?? c.company.description ?? null,
    industries: c.company.provider_industry ? [c.company.provider_industry] : [],
    // TWO SIZE FACTS, NAMED FOR WHAT THEY ARE (companySize.ts). A YC team size
    // is advisory text; the LinkedIn band is the declared size.
    declared_size_band: c.company.company_size_band ? sizeBandLabel(c.company.company_size_band)
      : p?.team_size != null ? `yc_self_reported:${p.team_size}` : null,
    linkedin_associated_members: c.company.linkedin_associated_member_count ?? null,
    location: p?.locations ?? c.company.geography ?? null,
    open_roles: (c.yc_open_jobs ?? []).map((j) => j.title).filter(Boolean) as string[],
  };
}

/**
 * P3 — the titles that make someone part of the mission's FUNCTION, for the
 * first-hire team check. The role vocabulary plus its function word, so an
 * existing "Head of Marketing" counts against "first growth marketer".
 */
export function functionTitlesFor(vocab: { required_titles: readonly string[] } | null | undefined): string[] {
  const base = [...new Set((vocab?.required_titles ?? []).map((t) => String(t).trim()).filter(Boolean))];
  const joined = base.join(" ").toLowerCase();
  const family: string[] = [];
  if (/market|growth|demand gen|brand|content/.test(joined)) family.push("marketing", "growth");
  if (/sales|account exec|\bae\b|sdr|bdr|business development/.test(joined)) family.push("sales", "business development");
  if (/engineer|developer/.test(joined)) family.push("engineer");
  if (/design/.test(joined)) family.push("designer");
  if (/product manager|\bpm\b/.test(joined)) family.push("product manager");
  return [...new Set([...family, ...base])].slice(0, 10);
}

/** Current employees AT this company whose title is in the function. Titles only. */
export function teamFunctionMembers(
  rows: readonly Record<string, unknown>[], companyUrl: string,
  vocab: { required_titles: readonly string[] } | null | undefined,
): string[] {
  const words = functionTitlesFor(vocab).map((t) => t.toLowerCase());
  const target = normalizeCompanyLinkedInUrl(companyUrl);
  const out: string[] = [];
  for (const r of rows) {
    const positions = Array.isArray(r.currentPositions) ? r.currentPositions as Record<string, unknown>[] : [];
    const here = positions.find((p) => p && p.current !== false &&
      normalizeCompanyLinkedInUrl(p.companyLinkedinUrl) === target);
    const title = String(here?.title ?? "").toLowerCase();
    if (!title) continue;
    if (words.some((w) => title.includes(w))) out.push(String(here!.title));
  }
  return out;
}

/**
 * A provider refusal that happens before any run exists: the tool layer
 * declined the actor, or it is not configured or authorised. Nothing was bought.
 */
export function refusedBeforeAnyRun(e: unknown): boolean {
  return /apify_actor_disabled_by_default|actor_not_configured|not configured|apify_unauthorized|unauthorized_actor/i
    .test(String((e as Error)?.message ?? e));
}

/**
 * P3 — a company whose DECLARED size band starts above this is too large for a
 * first hire in the function to be plausible, so its team check is not bought.
 * Read from the band's floor, never the LinkedIn member count (companySize.ts).
 */
export const TEAM_CHECK_MAX_HEADCOUNT = 200;

/** P3 — this company was found through its own open posting. */
function jobSourced(c: EngineCompany): boolean {
  return c.company.source_provenance === "harvestapi/linkedin-job-search";
}

function companyKey(c: NormalizedHiringCompany): string {
  return (c.linkedin_company_url ?? c.canonical_domain ?? c.external_source_id)
    .toLowerCase().replace(/\/$/, "");
}

// --------------------------------------------------------------------- deps ----

export interface FirstInFunctionEvidence {
  status: "supported" | "contradicted" | "unverified";
  source: "job_posting" | "team_composition" | "none";
  /** The posting's own words, when that is the source. */
  quote?: string | null;
  job_url?: string | null;
  /** Current staff whose title is in the function (team check). Titles only. */
  function_members?: number;
  function_titles?: string[];
  reason: string;
}

export type ActorInvoker = (call: CompiledActorCall<unknown>) => Promise<Record<string, unknown>[]>;

/** A provider call that started a real, billable run that has not finished. */
export interface PendingRun {
  run_id: string;
  dataset_id: string | null;
  actor_build_id?: string | null;
  cost_units?: number;
}

export interface CapabilityEngineDeps {
  /** The ONLY provider entry point. Wrapped in `guardedInvoker` by the engine. */
  invoke: ActorInvoker;
  /**
   * Report a started-but-unfinished run. Returning a value makes the attempt
   * PENDING rather than an error, so the capability is neither completed nor
   * failed and no fallback is allowed to spend against it.
   */
  readPendingRun?: (e: unknown) => PendingRun | null;
  /**
   * A run started by an EARLIER invocation has just been re-read successfully.
   *
   * The engine cannot settle the ledger itself — it has no database — and the
   * resumed call cannot write its own row, because `logical_call_key` is unique
   * and the adopted call computes the same key, so the insert collides and is
   * dropped. This is the seam that lets the owner mark the original row
   * finished, so a completed run stops advertising itself as recoverable work
   * to `recoverPendingRuns`.
   *
   * Optional: a caller that does not supply it simply leaves the row as it was,
   * which is exactly the behaviour before this existed. Never throws into the
   * run — the caller is expected to swallow its own failures.
   */
  onRunAdopted?: (info: {
    run_id: string;
    dataset_id: string | null;
    provider: string;
    capability: CapabilityId;
    rows: number;
  }) => Promise<void> | void;
  verifyEmployer: (
    person: NormalizedHiringPerson, companyLinkedInUrl: string,
  ) => { verified: boolean; outcome: string };
  /**
   * DOES THIS COMPANY SATISFY THE MISSION? — THE deciding call, and the only one.
   *
   * The pre-Phase-4 semantic classifier used to sit
   * beside this as a second semantic authority. It has been DELETED: the
   * inversion had already stripped its verdict, leaving a paid model call per
   * company that populated telemetry and decided nothing.
   *
   * This is consulted for EVERY company that reaches qualification, and its
   * answer outranks the deterministic fit. Deterministic code keeps the facts
   * it can actually falsify — identity, aggregator, excluded industry — and
   * hands everything else to the evaluator as evidence.
   *
   * Absent, or returning null, the company is held as INSUFFICIENT EVIDENCE and
   * reported as never evaluated. It is never converted into a rejection for
   * want of a model.
   */
  /**
   * STAGE 2 — GPT MISSION INTELLIGENCE, batched and free-tier.
   *
   * Absent, no triage runs and the deterministic prequalification verdict
   * stands, exactly as before. Present, its verdicts decide who is worth paying
   * for — but never whether anyone QUALIFIES, which is the evaluator's alone.
   *
   * A null return, a throw or an unparseable response all degrade the affected
   * batch to `uncertain`. Nothing a failure here does may exclude a company.
   */
  /**
   * STAGE 3/4 — WHICH DISCOVERY ACTORS RUN, AND WHAT EACH IS ASKED.
   *
   * REQUIRED. Absent, the run BLOCKS. There is no longer a floor beneath this
   * stage: the old one ran memo23 with `industries: ["B2B"]`, which answered
   * every mission with the same question and is deleted. A deployment that does
   * not wire this cannot discover, which is the honest outcome — the previous
   * behaviour was to discover the wrong thing confidently.
   *
   * The return is a PROPOSAL. `validateDiscoveryStrategy` decides what of it is
   * allowed against the closed actor catalog; a throw, a null or an unusable
   * shape all fall back rather than failing the capability, because a selector
   * being unavailable is not a reason to stop discovering.
   */
  planDiscovery?: (i: {
    payload: Record<string, unknown>;
    mission_hash: string;
    /**
     * WHY THE PREVIOUS PROPOSAL WAS REJECTED — present only on a repair round.
     *
     * The validator is a guardrail, not the strategist. Blocking a plan and
     * discovering nothing teaches the model nothing and leaves the user with
     * zero leads; handing back the specific violations lets it choose an actor
     * that can actually serve the request.
     */
    validation_feedback?: Array<{ code: string; message: string; actor_key?: string }>;
    /** What the previous pass produced, on a re-plan. See `resultsSection`. */
    results?: DiscoveryResultsSummary | null;
  }) => Promise<unknown>;
  /**
   * PLAN THE WHOLE JOB, ACROSS CAPABILITIES.
   *
   * `planDiscovery` chooses Actors for ONE stage. This chooses the chain:
   * discover → verify → enrich, which Actor serves each, and — the part nothing
   * could express before — which stages are unnecessary because an earlier
   * Actor's output already carries the evidence they exist to fetch.
   *
   * ── ABSENT IS THE GRAPH'S ORDER, AND THAT IS NOT A SILENT WRONG ANSWER ────
   *
   * Unlike `planDiscovery`, whose absence BLOCKS the run, an absent chain
   * planner leaves the capability sequence exactly as `buildCapabilityGraph`
   * built it. The distinction is deliberate and is the one this architecture
   * has been drawing all along: a deterministic ACTOR or QUERY choice is a
   * confident answer to a question nobody asked, whereas a deterministic
   * capability ORDER is inspectable, was authorised by the mission, and is the
   * sequence this system ran correctly for months. Production wires the planner
   * unconditionally; the seam exists so a test can pin one stage at a time.
   */
  planExecution?: (i: {
    payload: Record<string, unknown>;
    mission_hash: string;
    validation_feedback?: Array<{ code: string; message: string; actor_key?: string }>;
    results?: DiscoveryResultsSummary | null;
  }) => Promise<unknown>;
  /**
   * P4 — THE ROUTE CONTROLLER (GPT in production). Sees one wave's summary and
   * PROPOSES continue / stop a route / stop discovery / add a route / change a
   * query / deepen. `validateRouteControl` decides; nothing it returns is
   * executed unvalidated. Absent, discovery runs its routes as planned.
   */
  controlRoutes?: (i: {
    summary: ResearchWaveSummary;
    mission: LeadMissionV1;
    plan: RetrievalPlan;
    capability: CapabilityId;
    ready_actors: string[];
  }) => Promise<unknown>;
  triageCompanies?: (i: {
    input: MissionTriageInput;
    company_keys: string[];
  }) => Promise<unknown>;
  /** Batches this task may pay for. Defaults to "as many as the pool needs". */
  triageBatchesAllowed?: number;
  triageBatchSize?: number;
  evaluateMission?: (i: {
    input: MissionEvaluationInput;
    registry: EvidenceRegistry;
    company_key: string;
  }) => Promise<ParsedMissionEvaluation | null>;
  /**
   * THE GROUNDED SECOND OPINION, built from this company's own evidence.
   *
   * The engine assembles the canonical registry — it is the only layer holding
   * the discovery row, the enriched row and the job evidence together — and
   * hands it over already built, so nothing above has to reconstruct it and no
   * model-written text can enter it.
   *
   * Null when the flag is off. A null RETURN means "not grounded", which holds
   * the company for review; it never becomes a rejection.
   */
  groundCompany?: (i: {
    registry: EvidenceRegistry;
    requiresCommercialSignal: boolean;
    company_key: string;
  }) => Promise<GroundedVerification | null>;
  /**
   * `shadow` observes and records; `enforce` lets the verified verdict decide.
   *
   * Defaulting to `shadow` is deliberate: a missing or misspelled mode must not
   * be able to change what qualifies.
   */
  groundingMode?: "shadow" | "enforce";
  /**
   * STAGE 2 — evaluate a whole batch of companies in one call.
   *
   * Present only when full-pool evaluation is enabled for this workspace. Its
   * presence is what switches the engine from "judge each company as it
   * arrives" to "collect the set, gate it for free, then evaluate in bounded
   * batches". Absent, every line of the previous path runs unchanged.
   */
  evaluateBatch?: (batch: readonly BatchMember[]) => Promise<BatchResult | null>;
  /** Server-resolved and clamped. Never supplied by a client. */
  batchLimits?: BatchLimits;
  /** Grounded results a previous invocation already paid for, by company key. */
  restoredGroundedResults?: Map<string, GroundedVerification>;
  /**
   * The eligible-set fingerprint those restored results were computed over.
   *
   * Compared against this run's own set at ranking time. Absent or null means
   * UNKNOWN composition, which is reported as such — never as "unchanged".
   */
  restoredPoolFingerprint?: string | null;
  /** Called after each completed batch so the caller can checkpoint. */
  onBatchComplete?: (i: {
    evaluated: Array<{ company_key: string; verification: GroundedVerification }>;
    next_offset: number;
    /** This run's eligible set, so the checkpoint records what it evaluated. */
    pool_fingerprint: string;
  }) => void | Promise<void>;
  /** STAGE 2 — compare the evaluated pool. Null/absent ⇒ deterministic order. */
  rankPool?: (i: {
    summaries: readonly GroundedCandidateSummary[];
    requestedCount: number;
    unevaluatedCount: number;
  }) => Promise<ValidatedRanking | null>;
  /**
   * `shadow` computes the ranking and records what it WOULD have changed;
   * `enforce` lets it decide the order the user sees.
   *
   * Defaults to `shadow` for the same reason `groundingMode` does: a missing or
   * misspelled mode must never be able to reorder what somebody calls today.
   * Note that this gates the RANKING'S AUTHORITY, not whether it runs — a
   * shadow mode that computes nothing observes nothing.
   */
  rankingMode?: "shadow" | "enforce";
  callCompleted?: (key: string) => boolean;
  onCallComplete?: (key: string) => void;
  /**
   * The wall-clock budget, checked BEFORE every provider call.
   *
   * Absent means unbounded, which is only correct in tests. In production the
   * engine that does not hold one is the engine that gets killed holding a paid
   * run it never read — TEST task c8a6e53d, 16 Actor starts, plan Running
   * forever.
   */
  deadline?: ExecutionDeadline;
  /** Wall clock kept back for writing a checkpoint. Defaults to 18s. */
  checkpointReserveMs?: number;
  /**
   * Publish a stage snapshot as soon as it is true.
   *
   * The Workbench updates from these. They are counts of proven work, never
   * rows, and never carry a qualified verdict before the Brain has produced one.
   */
  onProgress?: (p: EngineProgress) => void | Promise<void>;
  /** The state after each capability, so a caller can persist it as it grows. */
  /**
   * The state changed, at a stage boundary.
   *
   * AWAITED, like `onProgress` beside it and for the same reason: the owner
   * uses this to write a DURABLE checkpoint, and a fire-and-forget write in an
   * edge function is a write that may never land. It used to be called and
   * dropped, which was fine while its only consumer kept state in memory.
   */
  onStateChange?: (s: CapabilityExecutionState) => void | Promise<void>;
  /**
   * A durable checkpoint may be taken now.
   *
   * Separate from `onStateChange`, which hands over the raw state for in-memory
   * observation. This hands over a `CheckpointSnapshot` — state AND working set,
   * derived together — because those are the only terms in which a checkpoint
   * can be correct. AWAITED: an edge isolate can be torn down before an
   * unawaited write settles.
   */
  /**
   * Persist a checkpoint, and SAY WHAT HAPPENED.
   *
   * The outcome is optional so existing callers keep working, but without it the
   * engine can only log what it OFFERED. On lineage e5d4fc14 that was the gap:
   * `checkpoint_published` recorded 87 enriched companies twice, the next slice
   * restored 83, and nothing distinguished "the write was skipped" from "the
   * write landed and was later overwritten or read stale".
   */
  onCheckpoint?: (
    snapshot: CheckpointSnapshot,
  ) =>
    | void
    | CheckpointWriteOutcome
    | Promise<void>
    | Promise<CheckpointWriteOutcome | void>;
  log?: (msg: string, meta?: unknown) => void;
}

export interface CapabilityEngineOpts {
  mission: LeadMissionV1;
  plan: CapabilityPlan;
  /**
   * P2 — `enforce`: every provider call is compiled into a ProviderCallSpec
   * from the current RetrievalPlan and sent exactly; ceilings reserve before
   * the call; amendments are versioned; qualification rejects on hard criteria
   * only. Absent/`off`: today's behaviour, unchanged (V1, Signals monitoring).
   */
  specMode?: "enforce" | "off";
  /**
   * Who may run (`routeReadiness.ts`), read under `specMode: "enforce"` by the
   * discovery selector, RetrievalPlan validation, the route controller and the
   * spec compiler — one decision. Default: production (READY only).
   */
  readiness?: ReadinessPolicy;
  /** Idempotency scope when no resume scope exists. */
  specScope?: { workspace_id: string; lineage_id: string };
  ceilings?: Partial<Ceilings>;
  canary?: boolean;
  /**
   * The run's own budget (`runBudget.ts`). TIGHTEN-ONLY: it lowers the provider
   * ceilings the spend ledger enforces before every paid call, and can never
   * raise one. Absent for an ordinary mission.
   */
  runBudget?: RunBudget | null;
  /**
   * An operator's hard mission cap (`missionSpendCap.ts`). TIGHTEN-ONLY, and
   * re-applied to the ledger on EVERY slice — a restored ledger keeps the
   * ceilings it was created with, so without this a lineage started before the
   * cap was lowered would never see it. Absent: nothing changes.
   */
  missionCap?: MissionSpendCap | null;
  /**
   * What the database says this lineage already committed, read this slice
   * (`readLineageSpendFloor`). Only meaningful with `missionCap`.
   */
  spendFloor?: SpendFloor | null;
  /** Resume state. Ignored unless its mission_hash matches. */
  state?: CapabilityExecutionState | null;
  brain?: {
    employee_min?: number | null;
    employee_max?: number | null;
    positive_industries?: string[];
    excluded_industries?: string[];
    required_geography?: string | null;
    /**
     * The Brain's compiled `hard_constraints`, verbatim.
     *
     * Supplied so `resolveEmployeeBounds` can tell a workspace RULE from a
     * workspace preference. Absent, the employee bound stays advisory and
     * behaviour is exactly as it was before this field existed — which is what
     * every missionless and every legacy caller gets.
     */
    hard_constraints?: readonly string[] | null;
    /**
     * RICHER ICP, for the evaluator only.
     *
     * Optional so every existing caller and test is unaffected. These never
     * reach a deterministic gate — `resolveBrainAuthority` files them as
     * preferences, and preferences may only move the score.
     */
    business_models?: string[];
    buyer_roles?: string[];
    target_signals?: string[];
    disqualifier_keywords?: string[];
  };
  /**
   * The workspace's own plain-English qualification rules.
   *
   * `company_brain.profile.icp.qualification_rules` — `reject_if`,
   * `manual_review_if`, `required_evidence`. Written by the user, read by
   * nothing in the qualification path until now. Handed to the evaluator as
   * context, never compiled into a gate.
   */
  brainQualificationRules?: {
    reject_if?: string[];
    manual_review_if?: string[];
    required_evidence?: string[];
  } | null;
  /**
   * Env reader for the investigation budget. Injected so budget behaviour is
   * testable without a process environment, and so a run can be given an
   * explicit budget rather than inheriting the deployment's.
   */
  readEnv?: (key: string) => string | undefined;
  /**
   * WHICH REAL COMPANIES THIS RUN'S REFERENTS RESOLVED TO.
   *
   * The sidecar, arriving at the engine. It does two things and no others:
   * `known_company_resolution` seeds a bound company's identity instead of
   * paying to rediscover it, and `bindingFingerprint` becomes the second half
   * of the resume check so a checkpoint written for one company cannot resume
   * against another that shares its name.
   *
   * It NEVER widens the run. A binding matching no company the mission named
   * adds nothing — the mission stays the only authority on scope.
   *
   * Omitted, every behaviour below is exactly what it was before bindings
   * existed, which is what keeps existing checkpoints resumable.
   */
  bindings?: readonly ResolvedReferentBinding[];
  maxCandidates?: number;
  /**
   * THE FUNDING SCREEN (`fundingPoolScreen.ts`), when run-agent priced one.
   *
   * `maxCandidates` is then the SCREENED POOL (short-mode search rows), and
   * `plan.admit` the companies that go on to identity, details and the claim
   * verifiers. `screen` is the funding verifier with its fallback off, through
   * the same verifier spine (spec → reservation → guard → ledger) as the
   * verification phase. Absent, discovery is exactly what it was.
   */
  fundingScreen?: {
    plan: FundingScreenPlan;
    screen: (targets: VerificationTarget[], state: CapabilityExecutionState) => Promise<VerifierFinding[]>;
    /** LinkedIn company URLs this workspace funding-checked within `plan.recently_checked_days`. */
    recentlyChecked?: ReadonlySet<string>;
    /**
     * This workspace's earlier company-search DISCOVERY inputs (same window), so
     * the screen's first page starts past every page a same-shaped search read.
     */
    priorSearches?: readonly Record<string, unknown>[];
  };
  /**
   * Qualified leads still owed, for sizing the ADMITTED target.
   *
   * Absent means "the whole request is still owed", which is correct for a
   * first slice and conservative for any other.
   */
  remainingLeads?: number;
  /**
   * AN EXPLICIT DEBT: the previous slice ended asking for a wider pool.
   *
   * ── THE ONE EXCEPTION TO "A COMPLETED CAPABILITY IS NEVER RE-PAID FOR" ──
   *
   * Discovery is deliberately absent from `CAPABILITY_STAGE`, so once it has
   * completed every later slice skips it. That is the right default and it is
   * why `replenishment_required` did nothing on its own: the continuation ran,
   * discovery was skipped, the frontier was still empty, and the lineage burned
   * barren slices until `no_progress` stopped it.
   *
   * This is the narrowest possible opening. It is set ONLY by `run-agent`, ONLY
   * when the previous slice's own recorded decision was
   * `replenishment_required` — which itself already required quota unmet, an
   * exhausted frontier, discovery routes remaining, and every ceiling intact —
   * and it reopens ONLY discovery. No other completed capability becomes
   * runnable, and nothing here relaxes spend identity: a page already bought
   * hashes to the same `logical_call_key` and is adopted, not re-purchased.
   */
  discoveryReplenishment?: {
    /** The parent slice's `auto_continuation.decision`, carried verbatim. */
    reason: string;
    /** Pages already taken per actor, restored from the checkpoint. */
    pages_taken: Record<string, number>;
    /** Actors this lineage has already asked. */
    sources_attempted: string[];
  } | null;
  rolePacks?: readonly RolePack[];
  postedLimit?: "1h" | "24h" | "week" | "month";
  ycRegions?: string[];
  ycIndustries?: string[];
  ycMinSize?: string;
  ycMaxSize?: string;
  solidcodeTeamSizes?: string[];
  /**
   * The most discovery actors one pass may run. Every one is a paid call, and
   * every candidate it adds costs a further paid enrichment before it can
   * qualify — so this is a spend ceiling, not a quality knob. Unset, the
   * strategy module's own default applies.
   */
  maxDiscoveryActors?: number;
  /**
   * How many times discovery may look at what it got and choose again.
   *
   * 1 is the old behaviour exactly: plan once, run it, live with the pool. 2 —
   * the default — lets the model see a factual summary of the pass and change
   * the MECHANISM once, which is the difference between a run that notices its
   * pool carries none of the required evidence and one that reports that fact
   * at the very end beside `qualified: 0`.
   *
   * A pass costs one planning call and only spends on an Actor if the model
   * proposes one it has not already run.
   */
  maxDiscoveryPasses?: number;
  foundersPerCompany?: number;
  /**
   * The scope that makes a provider call identifiable across invocations, plus
   * whatever a PREVIOUS invocation of this same mission already paid for.
   *
   * SUPPLIED ON EVERY RUN, not only on a continuation. The scope is what gives a
   * call a stable operation key; the key is what a later run reads. A first run
   * therefore carries the scope with an EMPTY `records` — it skips nothing, and
   * it writes the ledger the next run consults. Omitting the scope until records
   * exist would mean no run ever wrote one.
   *
   * `lineage_root_task_id` must be the SAME value for every invocation in a
   * chain; see `lineageRootTaskId`. A per-task value here would silently turn
   * every operation key into a new question and re-buy the lot.
   *
   * Omitted entirely, the engine behaves exactly as it did before this option
   * existed.
   */
  resume?: {
    workspace_id: string;
    lineage_root_task_id: string;
    records: readonly CompanyResumeRecord[];
  };
  /**
   * Who this run belongs to, for observations worth keeping beyond it.
   *
   * ── WHY THIS IS SEPARATE FROM `resume` ──────────────────────────────────
   *
   * The workspace id already reaches the engine on `resume`, and reusing it
   * would tie headcount collection to resumed runs — so a company's FIRST
   * enrichment, the one that starts its series, would be the one reading never
   * kept. An arbitrary rule producing exactly the wrong result.
   *
   * Optional, and its absence is not an error: a caller that does not supply it
   * simply contributes nothing to the series, and `buildSnapshotRow` refuses
   * the rows rather than inventing a workspace for them.
   */
  identity?: {
    workspace_id: string;
    task_id?: string | null;
  };
}

export interface CapabilityRunResult {
  state: CapabilityExecutionState;
  companies: EngineCompany[];
  /**
   * What a SECOND look needs, and nothing else.
   *
   * P4 re-evaluation runs in `run-agent`, outside the capability walk, so that
   * a model call cannot disturb qualification priority, deadline budgeting or
   * continuation. This is the whole of what crosses that boundary: three
   * already-decided, already-serializable values — no working set, no registry
   * object, no deadline.
   *
   * Null when nothing was evaluated, because there is then no compiled mission
   * that this run actually used and inventing one would be reconstruction.
   */
  reevaluation_context: MissionReevaluationContextV1;
  /**
   * The SAME registry builder the first pass used, with pages folded in.
   *
   * P4 lives in `run-agent` and used to assemble its own. One builder, called
   * from both places, is the only thing that keeps a second look from being
   * shown a narrower company than the verdict it is revising. Returns null for
   * a company this run does not hold.
   */
  rebuild_registry: (
    company_key: string,
    web_pages: readonly {
      source_url: string; page_intent: string; source_text: string;
      fetched_at: string | null;
    }[],
  ) => EvidenceRegistry | null;
  funnel: FunnelCounts;
  /** Per-company stage state, so a resume continues where each one stopped. */
  resume_records: CompanyResumeRecord[];
  /**
   * Dated headcount readings this run observed, ready to insert.
   *
   * Empty on any run that enriched nothing. Growth becomes answerable only once
   * two of these exist for one company on different days, which is why the
   * capability stays unsupported until the series has depth — a fact about the
   * data rather than about the providers.
   */
  headcount_snapshots: HeadcountSnapshotRow[];
  /** STAGE 2 output. Null when full-pool evaluation was not enabled. */
  pool: {
    eligible: EligiblePool["metrics"];
    excluded: EligiblePool["excluded"];
    summaries: GroundedCandidateSummary[];
    /** What ordered the delivery. Deterministic whenever the mode is shadow. */
    ranking: ValidatedRanking;
    ranking_mode: "shadow" | "enforce";
    /** What enforcing would have changed. Null under enforce — it did it. */
    ranking_shadow: RankingShadowComparison | null;
    /** Of the eligible set, computed after discovery. */
    fingerprint: string;
    /** True/false against a restored pool; null when there was none to compare. */
    composition_changed: boolean | null;
    delivery: PortfolioDelivery;
    restored: number;
    unevaluated: number;
  } | null;
  /** Per-capability outcome, in execution order. Persisted for audit. */
  capability_outcomes: Array<{
    capability: CapabilityId;
    status: "complete" | "skipped_resumed" | "skipped_no_input" | "exhausted" | "incomplete";
    rows: number;
    providers_used: string[];
    evidence_satisfied: boolean;
    reason: string | null;
  }>;
}

// ------------------------------------------------------------------ engine ----

/**
 * Execute a mission's capability plan.
 *
 * The loop is the contract: steps in plan order, each one checked for inputs
 * before it runs and for evidence after it does. There is no path through this
 * function that reaches a provider the plan did not authorise, and no path that
 * substitutes one capability for another when the first comes up empty.
 */
export async function runCapabilityPlan(
  deps: CapabilityEngineDeps, opts: CapabilityEngineOpts,
): Promise<CapabilityRunResult> {
  const log = deps.log ?? (() => {});
  const hash = await missionHash(opts.mission);
  /**
   * Dated headcount readings observed during this run.
   *
   * BUILT, NOT WRITTEN. The engine has no database dependency, so the rows are
   * returned and the caller persists them — the same separation that keeps
   * every other engine output testable without Postgres.
   *
   * Only LinkedIn associated-member counts from the company record reach this
   * list (a series of members, not staff); `buildSnapshotRow` refuses the rest.
   */
  const headcountSnapshots: HeadcountSnapshotRow[] = [];


  // ── THE SECOND FINGERPRINT, COMPUTED ONCE ────────────────────────────────
  //
  // `missionHash` covers company NAMES and cannot tell two real companies that
  // share one apart. This can. Null when the run has no bindings — which is
  // every run written before they existed and every run that names its own
  // companies — and `bindingsMatchCheckpoint` treats null-on-both-sides as
  // compatible, so nothing already persisted is stranded.
  const bindingPrint = await bindingFingerprint(opts.bindings ?? []);

  const state: CapabilityExecutionState =
    stateMatchesMission(opts.state, hash, bindingPrint)
      ? { ...opts.state!, provider_attempts: [...opts.state!.provider_attempts] }
      : newExecutionState(opts.plan, hash, bindingPrint);

  // ── REPAIR A CHECKPOINT AN OLDER BUILD POISONED ──────────────────────────
  //
  // The rule in `finish` stops this state being created. This undoes the ones
  // already written: checkpoints exist in production now carrying `persistence`
  // as completed with nothing saved and hiring still pending, and without this
  // they would resume, qualify companies, and skip the write forever.
  //
  // Only capabilities with no provider attempt behind them are reopened, so the
  // repair can never cause a second purchase. See `repairPrematureCompletions`.
  {
    const repaired = repairPrematureCompletions(
      state, opts.plan.steps.map((s) => s.capability), state.provider_attempts);
    if (repaired.reopened.length > 0) {
      state.completed_capabilities = repaired.state.completed_capabilities;
      state.pending_capabilities = repaired.state.pending_capabilities;
      log("capability_completion_repaired", {
        reopened: repaired.reopened,
        completed_now: [...state.completed_capabilities],
        pending_now: [...state.pending_capabilities],
      });
    }
  }

  // ── WHOSE QUESTION THIS RUN ANSWERS, DECIDED ONCE ────────────────────────
  //
  // Built here and threaded down, so every stage qualifies against the SAME
  // Mission-derived rules. Before this existed, prequalification answered to a
  // hard-coded commercial role list and the workspace Brain's employee bounds,
  // and a Mission asking for companies hiring software engineers qualified none
  // of a hundred (TEST run cf6cce3d): its own required signal was classified
  // `technical`, and `technical` could not produce a qualifying tier.
  const qualificationCtx = buildQualificationContext(opts.mission,
    { criteriaAuthority: opts.specMode === "enforce" });
  log("qualification_context", qualificationContextSummary(qualificationCtx));

  // ── WHAT A SECOND LOOK NEEDS, BUILT ONCE FOR THE WHOLE RUN ──────────────
  //
  // This was assigned lazily inside the per-company evaluation loop, at the
  // point the first evaluator input was built. That made it a by-product of
  // evaluating somebody NEW — and on a resumed slice every verdict is restored,
  // so the loop body never runs.
  //
  // Lineage b1348724 is what that cost: seven generations after the fix
  // deployed, `decided_by_model: 0` on every slice, five evidence debts raised
  // each time, and P4 skipped on all of them because `run-agent` found a null
  // context. The re-evaluation had candidates, cached pages and a working
  // write-back, and never ran.
  //
  // The mission and the Brain authority are properties of the RUN, not of any
  // company, and both are already settled here. `buildMissionEvaluationInput`
  // is still the one assembler — it is called with a placeholder registry whose
  // only contribution, `company`, the re-evaluation replaces anyway.
  const reevaluationContext: MissionReevaluationContextV1 =
    reevaluationContextFrom(buildMissionEvaluationInput({
      ctx: qualificationCtx,
      authority: resolveBrainAuthority(qualificationCtx, opts.brain),
      registry: emptyEvidenceRegistry(""),
      qualification_rules: opts.brainQualificationRules ?? null,
    }));

  /**
   * The hiring verdict that costs NOTHING, for one company.
   *
   * EXTRACTED SO IT CAN RUN WITHOUT THE PAID CAPABILITY.
   *
   * This logic used to live inside the `hiring_verification` block, which is the
   * step `buildCapabilityGraph` schedules only when the Mission asks for
   * EXTERNAL verification. For a Mission that does not — and the graph says so
   * itself, appending "hiring evidence taken from embedded sources, not
   * purchased" — the embedded evidence was then read by nobody. `hiring_jobs`
   * stayed `[]`, `hiring_assessment` stayed `null`, and the Company Brain's
   * eligibility filter admitted no one, so a hundred companies produced zero
   * evaluations and the run reported it as zero qualifications.
   *
   * The comment described this function. It just did not exist outside the
   * branch. Free assessment is now unconditional; the PAID escalation stays
   * exactly where it was, behind the scheduled capability.
   */
  const freeHiringAssessment = (c: EngineCompany): HiringAssessment => {
    // Supporting signals the free evidence already proves.
    const supporting: SupportingSignal[] = [];
    if ((c.prequalified?.tier_a ?? 0) + (c.prequalified?.tier_b ?? 0) >= 2) {
      supporting.push("multiple_commercial_openings");
    }
    return assessHiring(
      c.yc_open_jobs.map((j) => ({ title: j.title, url: j.job_url, location: j.location })),
      supporting,
      // THE MISSION'S OWN VOCABULARY, the same list prequalification scored on.
      // P3: postings found BY a LinkedIn job search are that search's answer.
      { source: jobSourced(c) ? "external_job_search" : "yc_open_jobs", vocab: qualificationCtx.role_vocabulary },
    );
  };

  /**
   * The openings that earned the verdict, as normalized rows.
   *
   * ── THE POOL IS AN ARGUMENT BECAUSE THERE IS MORE THAN ONE ──────────────
   *
   * This read `c.yc_open_jobs` unconditionally, and the verdict does not always
   * come from there. When the paid external search UPGRADES a company to
   * `hiring_verified`, the rows that earned that upgrade were dropped on the
   * floor: `hiring_jobs` stayed empty, so the evidence registry got no
   * `job_posting` items, so the evaluator had nothing to cite for hiring and
   * answered `insufficient_evidence` about a company with twelve open
   * commercial roles (live run 2026-08-24, Vercel).
   *
   * It is worst for a company the mission NAMED, which carries no embedded
   * openings at all — the external search is the only source it can ever have.
   */
  const hiringJobsFor = (
    c: EngineCompany, a: HiringAssessment,
    pool: readonly NormalizedHiringJob[] = c.yc_open_jobs,
  ): NormalizedHiringJob[] =>
    dedupeJobs(pool.filter((j) =>
      a.commercial_jobs.some((cj) => cj.title === j.title)));

  const outcomes: CapabilityRunResult["capability_outcomes"] = [];
  const companies: EngineCompany[] = [];
  /**
   * The funding round that discovered each company, by pool key.
   *
   * Declared out here because it is WRITTEN in the discovery branch and READ at
   * qualification, which is exactly the span `fundingRounds` did not cover —
   * that array was pushed to and never read, so every round this engine paid
   * for was discarded before anything could cite it.
   */
  const roundByCompanyKey = new Map<string, NormalizedFundingRound>();
  /**
   * One company's canonical registry. Shared by EVERY evaluation path.
   *
   * ── WHY IT LIVES OUT HERE ──────────────────────────────────────────────
   *
   * It used to live inside the qualification stage, and P4 — which runs in
   * `run-agent`, outside the walk — had to rebuild a registry of its own. That
   * copy diverged on nine fields at once, silenced by an `as never`: it passed
   * `identity` where the builder declares `identity_state` and `jobs` where it
   * declares `commercial_jobs`, so the second pass was shown a company with no
   * commercial job evidence, no strongest signal, no funding round, no news
   * evidence, no provider failures — and `identity_state: "not_attempted"` for
   * a company whose identity was a verified match.
   *
   * A re-evaluation that sees LESS than the evaluation it revises is not a
   * second look, and no comment can keep two copies of this in step. So there
   * is one builder, and the second look calls it with the pages folded in.
   */
  const registryFor = (
    c: EngineCompany,
    webPages: readonly {
      source_url: string; page_intent: string; source_text: string;
      fetched_at: string | null;
    }[] = [],
  ) => buildEvidenceRegistry({
    evidence: buildCompanyEvidence({
      company_key: c.key,
      source_capability: opts.plan.entry_capability,
      source_query: opts.mission.original_user_query,
      company: c.company,
      enriched: c.enriched,
      identity_state: c.identity
        ? (identityIsActionable(c.identity) ? "resolved"
          : c.identity.status === "mismatch" ? "mismatch"
          : c.identity.status === "ambiguous" ? "ambiguous" : "unresolved")
        : "not_attempted",
      linkedin_company_url: c.identity?.linkedin_company_url ??
        c.company.linkedin_company_url ?? null,
      commercial_jobs: c.hiring_jobs.map((j) => ({
        title: j.title ?? "", url: j.job_url, location: j.location,
        posted_date: j.posted_date, tier: c.hiring_assessment?.tier ?? null,
      })),
      strongest_signal: c.hiring_assessment?.strongest?.title ?? null,
    }),
    // EMBEDDED **AND** EXTERNALLY VERIFIED openings, both as job evidence.
    jobs: dedupeJobs([...c.yc_open_jobs, ...c.hiring_jobs]),
    // THE ROUND THAT DISCOVERED THIS COMPANY, when one did.
    funding_round: roundByCompanyKey.get(c.key) ?? null,
    // DATED PUBLIC STATEMENTS, kept apart by the signal they prove. An
    // article proving a launch is not evidence of an expansion, and one
    // bucket would let a verdict cite the wrong one.
    expansion_evidence: c.signal_evidence["expansion"] ?? [],
    launch_evidence: c.signal_evidence["product_launch"] ?? [],
    yc_description: c.company.description ?? null,
    // A FAILED PROVIDER IS RECORDED AS A FAILURE. Reading it as "nothing
    // found" would let an outage look like a company that is not hiring —
    // the one inference this whole stage exists to forbid.
    provider_failures: state.provider_attempts
      .filter((a) => a.outcome === "error" &&
        (a.capability === "hiring_verification" ||
          a.capability === "company_enrichment"))
      .map((a) => ({
        provider: a.provider, capability: a.capability,
        reason: a.reason ?? "provider call failed",
      })),
    // The discovery row's DECLARED BAND when the company record declares a
    // different one — never a member count, which is not a size.
    employee_count_alternatives:
      c.enriched?.company_size_band && c.company.company_size_band &&
        sizeBandLabel(c.enriched.company_size_band) !== sizeBandLabel(c.company.company_size_band)
        ? [{ source: "discovery_declared_band", value: sizeBandLabel(c.company.company_size_band) }]
        : [],
    // The pages P2 bought, when a second look is asking about them. Empty on
    // the first pass, which runs before any page has been fetched.
    web_pages: webPages,
  });
  // STAGE 2 state, captured inside the qualification capability and read after
  // the plan finishes — ranking compares the whole pool, so it cannot run until
  // every company that is going to be evaluated has been.
  let poolState: {
    pool: EligiblePool; restored: number; evaluatedKeys: string[];
    /** Of the eligible set — computable only here, after discovery. */
    fingerprint: string;
  } | null = null;
  const maxCandidates = opts.maxCandidates ?? 50;

  // THE GUARDED BOUNDARY. Every provider call in this file goes through it, and
  // it asks BOTH canonical questions: is this provider in this step's graph,
  // and does the readiness authority say the route may run. The policy is the
  // same object every planning layer used, so a route cannot be blocked at
  // plan time and executable at call time.
  const guardPolicy: ReadinessPolicy = opts.readiness ?? PRODUCTION_READINESS;
  const invoke = guardedInvoker(opts.plan, deps.invoke, (actorKey, error) => {
    log("capability_containment_violation", {
      actorKey, kind: error.kind, capability: error.capability, reason: error.message.slice(0, 200),
    });
  }, guardPolicy);

  // ── WHAT A PREVIOUS INVOCATION ALREADY PAID FOR ────────────────────────────
  const resumeScope = opts.resume ?? null;

  // ── P2: THE EXECUTION SPINE ─────────────────────────────────────────────────
  const specOn = opts.specMode === "enforce";
  const routePolicy: ReadinessPolicy = guardPolicy;
  /**
   * The funding rung the mission asks for, when it asks for one — what a discovered round is judged against.
   * Several acceptable rungs travel joined by "|" ("series_a|series_b", RC02) and are decided as one set.
   */
  const requiredRoundStage: string | null = (() => {
    const c = deriveMissionCriteria(opts.mission, guardPolicy).find((x) => x.dimension === "company_stage" &&
      typeof x.value === "string" && requiredStagesOf(x.value).length > 0 &&
      requiredStagesOf(x.value).every((s) => stageRank(normalizeRoundType(s)) !== null));
    return c ? String(c.value) : null;
  })();
  const criteriaPolicy = specOn ? criteriaExecutionPolicy(opts.mission) : null;
  const p2MissionHash = specOn ? await missionHash(opts.mission) : "";
  const p2Scope = {
    workspace_id: resumeScope?.workspace_id ?? opts.specScope?.workspace_id ?? "unscoped",
    lineage_id: resumeScope?.lineage_root_task_id ?? opts.specScope?.lineage_id ?? p2MissionHash.slice(0, 24),
  };
  const currentPlan = (): RetrievalPlan | null =>
    state.retrieval_plans?.[state.retrieval_plans.length - 1] ?? null;
  /** A slice resumed onto an existing plan version (a worker continuation). */
  const resumedOntoPlan = specOn && (state.retrieval_plans?.length ?? 0) > 0;
  if (specOn) {
    state.spend_ledger ??= newSpendLedger(
      tightenCeilings(resolveCeilings(opts.ceilings ?? null, opts.canary === true), opts.runBudget ?? null));
    // ── THE OPERATOR'S HARD CAP, EVERY SLICE ─────────────────────────────────
    // Tighten-only, so re-applying it to a restored ledger can only lower its
    // ceilings. The floor is re-read every slice and replaces the last one.
    if (opts.missionCap) {
      state.spend_ledger.ceilings = capCeilings(state.spend_ledger.ceilings, opts.missionCap);
      applySpendFloor(state.spend_ledger, opts.spendFloor ?? null);
      log("mission_cap_applied", {
        mission_provider_usd: state.spend_ledger.ceilings.mission_provider_usd,
        mission_credits: state.spend_ledger.ceilings.mission_credits ?? null,
        floor_usd: state.spend_ledger.floor?.committed_usd ?? null,
        floor_calls: state.spend_ledger.floor?.paid_calls ?? null,
        floor_source: state.spend_ledger.floor?.source ?? null,
        invalid_env: opts.missionCap.invalid,
      });
    } else if (state.spend_ledger.floor) {
      // A floor carried in from a capped slice means nothing without the cap.
      state.spend_ledger.floor = null;
    }
    state.mission_trace ??= newMissionTrace();
    state.provider_call_specs ??= [];
    state.retrieval_plans ??= [];
    if (currentPlan()) {
      // A WORKER CONTINUATION EXECUTES THE CURRENT VERSION. See `p2AcceptAmendment`.
      appendTrace(state.mission_trace, "continuation_resumed", {
        reservations: state.spend_ledger.reservations.length,
      }, { plan_version: currentPlan()!.version });
    }
  }
  /**
   * THE DISCOVERY ROWS THIS MISSION MAY BUY: the SCREENED POOL under the
   * funding screen (`plan.pool_rows`, priced before discovery), otherwise the
   * run's `max_candidates`. Under the screen `max_candidates` caps the companies
   * ADMITTED past the pool instead (`takeInvestigationSlice`). One reader, so
   * the call cap, the spent check and the replenishment log cannot disagree —
   * canary 8ac3d99e's call cap read `max_candidates` alone and bought 2 rows.
   */
  const discoveryRowAllowance = (): number | null =>
    opts.fundingScreen?.plan.pool_rows ?? opts.runBudget?.max_candidates ?? null;
  /**
   * THE MISSION'S CANDIDATE ALLOWANCE IS SPENT: no further discovery purchase
   * can happen (`run_budget.max_candidates`, counted in `discovery_rows_bought`),
   * so neither may a model call that exists only to plan one — a re-plan, a
   * route-control proposal, a replenishment slice. Canary 87ecf153 spent
   * $0.0019 of model on a second slice whose only discovery call was then
   * refused.
   */
  const candidateBudgetSpent = (): boolean => {
    // UNDER THE FUNDING SCREEN, SPENT ADMISSIONS SPEND THE BUDGET TOO: rows left
    // in the allowance could only find companies no slot remains for.
    if (opts.fundingScreen &&
      (state.funding_screen?.admissions_spent === true || state.funding_screen?.screened === true)) return true;
    const limit = discoveryRowAllowance();
    return limit !== null && (state.discovery_rows_bought ?? 0) >= limit;
  };
  /** Adaptive reserve left: the reserve minus spend by calls from amended versions. */
  const adaptiveReserveRemaining = (): number => {
    const l = state.spend_ledger;
    if (!l) return 0;
    const amended = new Set((state.provider_call_specs ?? [])
      .filter((sp) => (sp.plan_version ?? 1) > 1).map((sp) => sp.provider_call_id));
    const spent = l.reservations
      .filter((r) => amended.has(r.provider_call_id) &&
        (r.status === "reserved" || r.status === "executed" || r.status === "settled"))
      .reduce((n, r) => n + (r.settled_usd ?? r.provisional_usd ?? r.estimate_usd), 0);
    return Math.max(0, l.ceilings.adaptive_reserve_usd - spent);
  };
  const priorRecords = new Map<string, CompanyResumeRecord>(
    (resumeScope?.records ?? []).map((r) => [r.company_key, r]));

  /**
   * Re-attach what an earlier invocation already proved about this company.
   *
   * Narrow, but no longer blind to what was already bought. The record carries
   * STAGES, the resolved LinkedIn URL, and a per-company SNAPSHOT; this restores
   * from all three. Restoring the URL is what stops the identity re-buy: that
   * stage declines to pay for a company it can name, so a restored company never
   * reaches the search actor at all.
   *
   * Hiring and founder payloads are still deliberately left to run again rather
   * than be skipped into an empty result the Brain would read as a proven
   * negative — and hiring has its own operation-key guard besides, carried by
   * `completed_operations` above. Enrichment is the exception, and the reason is
   * below.
   *
   * Idempotent — it is applied before every capability and must stay safe to
   * repeat.
   */
  /** Companies whose frontier position has already been restored. */
  const frontierRestored = new Set<string>();
  const restoreFromResume = (c: EngineCompany): void => {
    const prior = priorRecords.get(c.key);
    if (!prior) return;
    for (const op of prior.completed_operations) {
      if (!c.completed_operations.includes(op)) c.completed_operations.push(op);
    }
    // ── THE FRONTIER SURVIVES REDISCOVERY TOO ──────────────────────────────
    //
    // A continuation does not always skip discovery: a fresh invocation that
    // carries only the resume RECORDS re-runs it, rebuilding the working set
    // from the provider. Without this, those rebuilt companies arrive with a
    // default `pending_investigation` and the ranking below hands the SAME
    // first slice out again — a continuation that replays instead of advancing.
    // ONCE PER COMPANY, and only the first time it is seen. `restoreFromResume`
    // runs before EVERY capability, so re-applying the snapshot would overwrite
    // live progress: a company selected into this pass's slice would be reset
    // to the state run 1 left it in, and the frontier would never advance.
    if (prior.snapshot && !frontierRestored.has(c.key)) {
      frontierRestored.add(c.key);
      const snap = prior.snapshot as unknown as {
        investigation_state?: unknown; investigation_rank?: unknown; shortlist_exclusion?: unknown;
        identity?: unknown; enriched?: unknown;
      };
      c.investigation_state = asInvestigationState(snap.investigation_state);
      if (typeof snap.shortlist_exclusion === "string") c.shortlist_exclusion = snap.shortlist_exclusion;
      if (typeof snap.investigation_rank === "number") {
        c.investigation_rank = snap.investigation_rank;
      }
      c.shortlisted = wasInvestigated(c.investigation_state);
      // WHAT IDENTITY RESOLUTION ACTUALLY PRODUCED. Restored only when this
      // slice has not resolved one itself, so live progress always wins — the
      // same rule the frontier fields above follow.
      if (!c.identity && snap.identity && typeof snap.identity === "object") {
        c.identity = snap.identity as unknown as typeof c.identity;
      }
      // ── AND WHAT ENRICHMENT ALREADY COST ─────────────────────────────────
      //
      // THE RUNS THIS EXISTS FOR. Every duplicate paid Apify call in the four
      // days to 2026-09-04 was `apify_linkedin_company_details`, and the count
      // tracks how many times a lineage re-ran discovery:
      //
      //     b1348724   5 searches   7+4+4+3+2 duplicate runs
      //     2f3d9c5c   4 searches   5+5+3+2   duplicate runs
      //     8cfdfd10   3 searches   2         duplicate runs
      //     610951da   1 search     none
      //
      // `company_enrichment` selects on `!c.enriched`, which holds within a
      // slice. Across slices there are TWO restore paths, and they disagreed:
      // `restoreWorkingSet` — taken when discovery is SKIPPED — assigns
      // `c.enriched` from the snapshot, while this one, taken when discovery
      // RE-RUNS and rebuilds the working set from the provider, did not. So a
      // rediscovered company arrived enriched-looking-unenriched and the same
      // batch of ten was bought again, once per continuation, for the life of
      // the lineage.
      //
      // The internal ledger deduplicated on `logical_call_key` and escalated
      // `attempt_number` instead, so no credit was double-charged and the
      // accounting looked clean. Apify billed every run.
      //
      // ONLY A REAL PAYLOAD IS RESTORED. `asObjectOrNull` yields null for a
      // company that was never enriched, and null is exactly what re-runs the
      // stage — so this cannot skip a company into an empty result. Live
      // progress still wins, the same rule identity follows above.
      if (!c.enriched && snap.enriched && typeof snap.enriched === "object") {
        c.enriched = snap.enriched as unknown as typeof c.enriched;
        // The same narrowing `restoreWorkingSet` applies: surviving evidence IS
        // the success, so the outcome is not left saying the stage never ran.
        c.enrichment_outcome = "success";
      }
    }
    if (prior.identity === "resolved" && prior.linkedin_company_url &&
        !c.company.linkedin_company_url) {
      c.company = { ...c.company, linkedin_company_url: prior.linkedin_company_url };
      log("identity_restored_from_resume", {
        company_key: c.key, linkedin_company_url: prior.linkedin_company_url,
      });
    }
  };

  /**
   * STAGE 2 + STAGE 3 — GPT triage, then a budget-driven shortlist.
   *
   * Both run free of any provider. Triage is a cheap batched model call and the
   * shortlist is pure arithmetic; between them they decide where every paid
   * stage downstream spends its money.
   *
   * SAFE WHEN OFF. With no `triageCompanies` dependency no model call is made,
   * every company keeps its deterministic verdict, and the shortlist is rebuilt
   * from `eligible` + the same budget — which defaults to the ten the old
   * ceiling allowed. Nothing about a run changes until triage is switched on.
   */
  /**
   * The discovery strategy for this run, model-proposed where possible.
   *
   * NEVER THROWS; RETURNS A `blocked` STRATEGY INSTEAD. A selector that is
   * absent, slow, broken or wrong IS a reason to stop discovering. It used to
   * be a reason to discover the way the system did before selectors existed,
   * and that floor is what made a model outage indistinguishable from a
   * deliberate YC search. The caller — not this function — turns `blocked` into
   * the raised error, so the strategy is recorded before the run stops.
   */
  /**
   * Ceilings and advisories every discovery proposal is validated against.
   *
   * Hoisted out of `resolveDiscoveryStrategy` because the CHAIN's own discovery
   * steps are validated too, and validating them against a different set of
   * limits than a single-stage proposal would make "how many rows may this
   * actor return" depend on which planner named it.
   */
  const discoveryLimits = {
    maxItemsPerActor: maxCandidates,
    ...(opts.maxDiscoveryActors != null ? { maxActors: opts.maxDiscoveryActors } : {}),
    // WHAT THE ROUTER KNOWS, HANDED TO THE PLANNER RATHER THAN ACTED ON.
    // These were routing branches; as advisories they inform the actor choice
    // instead of silently replacing the capability it was made for.
    ...(opts.plan.routing_advisories?.length
      ? { routingAdvisories: opts.plan.routing_advisories }
      : {}),
  };

  const resolveDiscoveryStrategy = async (
    /**
     * What the previous pass produced, on a re-plan.
     *
     * Absent on the first pass — there is nothing to report yet. Present, it is
     * what lets the model judge its own strategy rather than re-propose it: a
     * pool that carried none of the evidence the mission required is a reason
     * to change the MECHANISM, and without this the model cannot see that it
     * happened.
     */
    results?: DiscoveryResultsSummary | null,
    /**
     * What the provider attempts of THIS capability actually produced.
     *
     * Replaces an `alreadyRun: string[]` list of actor keys. The list was the
     * wrong unit: it blocked "the same actor asked a better question", which is
     * the correct response to a zero-row result and was therefore unreachable.
     */
    attemptsSoFar: readonly ProviderAttempt[] = [],
    /**
     * Questions already asked this capability, as `actor|fingerprint(input)`.
     *
     * Built from the SELECTIONS, not from the provider attempts. The attempt
     * records the COMPILED input — defaults filled in, cost ceilings applied —
     * and a proposal carries the raw one, so fingerprinting the two and
     * comparing them never matches. Like is compared with like here.
     */
    askedAlready: ReadonlySet<string> = new Set(),
  ): Promise<DiscoveryStrategy> => {
    const limits = discoveryLimits;
    // ── NO SELECTOR IS A BLOCK, NOT A DEFAULT ───────────────────────────────
    //
    // This returned the YC literal. Combined with `planDiscovery` being gated on
    // a credential, that meant a missing key produced a confident search for
    // B2B YC companies whatever the user had asked for.
    if (!deps.planDiscovery) {
      return blockedDiscoveryStrategy(
        "no_discovery_selector",
        "no actor selector was supplied, so no actors were chosen for this request",
      );
    }
    try {
      const payload = buildDiscoveryPlannerPayload(opts.mission, limits);
      const hash = await missionHash(opts.mission);
      /** The model may answer with the list itself or wrap it in `actors`. */
      const actorsOf = (proposed: unknown) =>
        Array.isArray(proposed)
          ? proposed
          : (proposed as { actors?: unknown } | null)?.actors;
      /**
       * THE SAME QUESTION MAY NOT BE BOUGHT TWICE. A BETTER ONE MAY.
       *
       * ── WHAT THIS REPLACED, AND WHY IT WAS WRONG ────────────────────────
       *
       * This dropped any proposal naming an actor that had already run, keyed on
       * the ACTOR. The intent was a spend guard — do not re-buy a pool the run
       * already has — and the unit was wrong.
       *
       * Production run 53c99b8a (2026-08-19): the planner asked memo23 for
       * `industries: ["Engineering, Product and Design"]` and got ZERO rows. The
       * obvious next move — ask memo23 again without that filter — was
       * structurally impossible, because "memo23" was on the already-run list.
       * The capability exhausted and the run returned nothing.
       *
       * An actor that returned nothing sold nothing. What must not repeat is the
       * QUESTION, so the key is the actor plus a fingerprint of its input.
       *
       * ── APPLIED AFTER VALIDATION, DELIBERATELY ──────────────────────────
       *
       * `validateDiscoveryStrategy` normalises what it keeps: it drops
       * unsupported filters and clamps counts to published limits. Fingerprinting
       * a RAW proposal and comparing it to a VALIDATED selection therefore never
       * matches, and the guard silently passes everything. Both sides are
       * fingerprinted after validation, where they are the same shape.
       */
      const dropRepeats = (strategy: DiscoveryStrategy): DiscoveryStrategy => {
        if (askedAlready.size === 0) return strategy;
        const kept = strategy.selections.filter((sel) =>
          !askedAlready.has(`${sel.actor_key}|${inputFingerprint(sel.input ?? {})}`));
        if (kept.length === strategy.selections.length) return strategy;
        log("discovery_replan_dropped_identical_questions", {
          proposed: strategy.selections.length, kept: kept.length,
        });
        return { ...strategy, selections: kept };
      };

      // ── EVERY FAILED ATTEMPT BECOMES SOMETHING THE PLANNER CAN ACT ON ────
      //
      // The engine already classified every attempt — `ok`, `empty`, `error`,
      // `compile_failed` — and told the planner about exactly one of them. A
      // provider that REJECTED the input and a provider that returned nothing
      // were both recorded and then discarded, so the planner re-planned blind.
      //
      // On run 53c99b8a solidcode was rejected by Apify three times with
      // `apify_input_schema_error` and the planner was never told; memo23
      // returned zero rows and the planner was never told that either.
      const providerFeedback = discoveryAttemptFeedback(attemptsSoFar);
      const first = dropRepeats(validateDiscoveryStrategy(
        actorsOf(await deps.planDiscovery({
          payload, mission_hash: hash, ...(results ? { results } : {}),
          ...(providerFeedback.length ? { validation_feedback: providerFeedback } : {}),
        })),
        opts.mission, limits));

      // ── THE VALIDATOR IS A GUARDRAIL, NOT THE STRATEGIST ──────────────────
      //
      // A rejected plan used to end the run's discovery outright: `selections`
      // empty, nothing discovered, zero qualified leads — and the only record
      // of why was a violation code nobody had acted on. `not_for` enforcement
      // made that reachable in one move, because an actor that name-matches is
      // now correctly refused for a concept mission, and refusing was the whole
      // response.
      //
      // A rejection now becomes FEEDBACK first and a block second. The model is
      // told which actor was refused and why, and chooses again against the
      // same closed catalog.
      //
      // EXACTLY ONE REPAIR ROUND. A second failure means the model cannot serve
      // this request with the actors that exist, and saying so is the honest
      // answer. One round is also one extra cheap planning call, so this cannot
      // become unbounded spend.
      if (first.source !== "blocked" && first.selections.length > 0) return first;

      // ── A RE-PLAN IS NOT REPAIRED, IT IS SIMPLY DECLINED ──────────────────
      //
      // The repair round exists to teach a model whose plan was REFUSED. On a
      // re-plan there is nothing to teach: the run already has a working pool
      // and is asking whether anything would improve it, so "no" is a complete
      // answer. Repairing here also produced a spurious second call whenever the
      // model proposed an actor that had already run and the repeat guard
      // emptied the list — a refusal that was never made.
      if (results) {
        log("discovery_replan_no_further_actor", {
          proposed_but_unusable: first.violations.map((v) => v.code),
        });
        return first;
      }

      const blocking = first.violations.filter((v) => v.severity === "block");
      log("discovery_strategy_repair_attempt", {
        violations: blocking.map((v) => v.code),
        actors: blocking.map((v) => v.actor_key ?? null),
      });

      const repaired = dropRepeats(validateDiscoveryStrategy(
        actorsOf(await deps.planDiscovery({
          payload, mission_hash: hash, ...(results ? { results } : {}),
          validation_feedback: blocking.map((v) => ({
            code: v.code, message: v.message, actor_key: v.actor_key,
          })),
        })),
        opts.mission, limits));

      if (repaired.source !== "blocked" && repaired.selections.length > 0) {
        log("discovery_strategy_repaired", {
          first_violations: blocking.map((v) => v.code),
          actors: repaired.selections.map((sel) => sel.actor_key),
        });
        return { ...repaired, repaired_after: blocking.map((v) => v.code) };
      }

      log("discovery_strategy_repair_failed", {
        first: blocking.map((v) => v.code),
        second: repaired.violations.filter((v) => v.severity === "block").map((v) => v.code),
      });
      return repaired;
    } catch (e) {
      log("discovery_strategy_planner_failed", { error: String(e) });
      // A THROWN SELECTOR IS A BLOCKED RUN. Falling back here is what made a
      // model outage indistinguishable from a model that chose YC on purpose.
      return blockedDiscoveryStrategy(
        "discovery_selector_failed",
        `the actor selector failed: ${String(e).slice(0, 300)}`,
      );
    }
  };

  /**
   * True once triage + budget + ranking have been applied to this working set.
   * See `ensureMissionIntelligence`: the stage is demanded by the paid stages
   * rather than volunteered by one discovery branch, and this makes asking
   * twice free.
   */
  let missionIntelligenceApplied = false;

  /**
   * THE FUNDING SCREEN: one Atomus read over the ranked pool, before admission.
   *
   * Runs once the pool is ranked and before the first slice is taken, so the
   * slice admits funding PASSES first and never a FAIL. Idempotent: a company
   * already carrying the Atomus mark is not screened again, so a resumed slice
   * or a re-applied triage buys nothing. See `fundingPoolScreen.ts`.
   */
  const applyFundingScreen = async (companies: EngineCompany[]): Promise<void> => {
    const fs = opts.fundingScreen;
    if (!fs) return;
    // NO SLOT LEFT, OR THE ONE READ ALREADY MADE: NO SCREEN. A company found
    // after the admissions were spent can never be investigated, and one found
    // after the screen read its pool would need a second, unpriced Atomus read.
    if (state.funding_screen?.admissions_spent === true || state.funding_screen?.screened === true) {
      let closed = 0;
      for (const c of companies) {
        if (c.investigation_state !== "pending_investigation") continue;
        c.investigation_state = "excluded_permanently";
        c.shortlist_exclusion = "screen_not_admitted";
        c.shortlisted = false;
        closed++;
      }
      if (closed > 0) log("funding_screen_skipped_admissions_spent", { closed });
      return;
    }
    const ATOMUS = "apify_funding_atomus";
    const screenedOp = verifyOpKey(ATOMUS);
    const pageOf = (c: EngineCompany) =>
      atomusInput(c.identity?.linkedin_company_url ?? c.company.linkedin_company_url ?? null);
    const open = (c: EngineCompany) => c.investigation_state === "pending_investigation" &&
      !c.completed_operations.includes(screenedOp);
    // CHECKED BY THIS WORKSPACE RECENTLY: the answer is already known and would
    // be bought again. Closed for this run, never screened, never admitted.
    const recent = new Set([...(fs.recentlyChecked ?? [])].map((u) => atomusInput(u)).filter((u): u is string => !!u));
    const recentlyChecked: string[] = [];
    for (const c of companies) {
      const page = pageOf(c);
      if (!open(c) || !page || !recent.has(page)) continue;
      c.investigation_state = "excluded_permanently";
      c.shortlist_exclusion = "recently_funding_checked";
      c.shortlisted = false;
      recentlyChecked.push(c.key);
    }
    const openPool = companies.filter((c) => open(c) && pageOf(c))
      .sort((a, b) => a.investigation_rank - b.investigation_rank);
    const pool = openPool.slice(0, fs.plan.screen_max);
    // BEYOND ONE ATOMUS READ, CLOSED. A company the screen did not read would be
    // admitted unscreened and bought a second Atomus call by the verifier.
    for (const c of openPool.slice(fs.plan.screen_max)) {
      c.investigation_state = "excluded_permanently";
      c.shortlist_exclusion = "screen_pool_overflow";
      c.shortlisted = false;
    }
    // Verdicts from an earlier invocation's screen, so their order survives a re-rank.
    const verdicts = new Map<string, ScreenVerdict>(Object.entries(state.funding_screen?.verdicts ?? {}));
    if (pool.length > 0) {
      const targets: VerificationTarget[] = missionCandidatesFrom({ companies: pool },
        { missionId: opts.identity?.task_id ?? null }).map((m) => ({
        company_key: m.company_key, name: m.name, domain: m.domain, linkedin_url: m.linkedin_url, graph: m.graph,
        criterion: { criterion_id: fs.plan.criterion_id, dimension: "funding",
          // The screen judges the claim's own kind of round (Wave 3): a grant is not venture funding.
          value: fs.plan.funding_kind ? { funding_kind: fs.plan.funding_kind } : null, window_days: fs.plan.window_days },
      }));
      const findings = await fs.screen(targets, state);
      // THE ONE PRICED READ IS SPENT: discovery is over for this mission. Recorded
      // on the state the checkpoint carries, so the next slice's continuation
      // reads "no discovery routes remain".
      state.funding_screen = { ...state.funding_screen, verdicts: state.funding_screen?.verdicts ?? {}, screened: true };
      if (state.discovery_source_state) {
        state.discovery_source_state = { ...state.discovery_source_state, exhausted: true, stop_reason: "screen_complete" };
      }
      for (const f of findings) {
        const c = pool.find((x) => x.key === f.company_key);
        if (!c) continue;
        applyVerifierFinding(c, f, { key: FUNDING_STAGE_VERIFIER_KEY, route_actor: ATOMUS });
        const v = f.detail?.verdict_after;
        verdicts.set(c.key, v === "pass" || v === "fail" ? v : "pending");
      }
      // Screened but unanswered (no row, or the read was refused): still open.
      for (const c of pool) if (!verdicts.has(c.key)) verdicts.set(c.key, "pending");
    }
    // A FAIL is a hard claim disproved from Atomus's complete history: closed.
    for (const c of pool) {
      if (verdicts.get(c.key) !== "fail") continue;
      c.investigation_state = "excluded_permanently";
      c.shortlist_exclusion = "funding_screen_fail";
      c.shortlisted = false;
    }
    state.funding_screen = { ...state.funding_screen, verdicts: Object.fromEntries(verdicts) };
    // PASSES FIRST, then the still-open, each in the free ranking's own order —
    // every screened company still on the frontier, this invocation's or not.
    const screened = companies.filter((c) => c.investigation_state === "pending_investigation" && verdicts.has(c.key));
    const ordered = screenAdmissionOrder(screened.map((c) => ({
      key: c.key, rank: c.investigation_rank, verdict: verdicts.get(c.key) ?? "pending",
    })));
    const front = new Set(ordered.map((o) => o.key));
    const rest = companies.filter((c) => !front.has(c.key))
      .sort((a, b) => a.investigation_rank - b.investigation_rank);
    ordered.forEach((o, i) => { companies.find((c) => c.key === o.key)!.investigation_rank = i; });
    rest.forEach((c, i) => { if (c.investigation_rank !== Number.MAX_SAFE_INTEGER) c.investigation_rank = ordered.length + i; });
    state.investigation_ranking = [...ordered.map((o) => o.key),
      ...state.investigation_ranking.filter((k) => !front.has(k))];
    const count = (v: ScreenVerdict) => pool.filter((c) => (verdicts.get(c.key) ?? "pending") === v).length;
    if (pool.length === 0 && ordered.length === 0) return;
    log("funding_screen", {
      pool: pool.length, pool_rows: fs.plan.pool_rows, admit: fs.plan.admit,
      pass: count("pass"), fail: count("fail"), pending: count("pending"),
      recently_checked: recentlyChecked.length, admission_order: ordered.map((o) => o.key),
    });
  };

  const applyMissionIntelligence = async (companies: EngineCompany[]): Promise<void> => {
    const verdicts = new Map<string, TriageVerdict>();

    // ── A VERDICT ALREADY REACHED IS NOT RE-BOUGHT ──────────────────────────
    //
    // `ensureMissionIntelligence` guards on `missionIntelligenceApplied`, which
    // is a local of THIS invocation — so on a continuation it is false and this
    // stage ran again over the whole restored pool. It was idempotent within an
    // invocation and not at all across the checkpoint.
    //
    // TEST run b7a9e112 triaged its 100 companies SEVEN times: once legitimately
    // and six times over verdicts the checkpoint had just handed back intact
    // (`working_set_restored_from_checkpoint restored: 100, snapshots_missing:
    // 0`). 24 redundant model calls, costing 19 to 63 seconds of ~107-second
    // slices. Identity resolution inherited what was left — 11 to 17 seconds —
    // and attempted 6 of its 23 targets, which is why 74 companies were never
    // touched and the run spent 123 cost units to reach 9 of 10.
    //
    // AND THE VERDICTS WERE NOT EVEN STABLE. Successive passes returned
    // relevant 74, 74, 76, 76, 74, 76 — so `investigation_rank`, the cursor the
    // frontier slice reads, shifted underneath itself between invocations.
    //
    // Restored verdicts are seeded here and their companies are not batched.
    // Everything downstream — the summary, the ranking, the slice — still sees
    // the whole pool, because the map is the whole pool.
    const untriaged = companies.filter((c) => !c.triage);
    for (const c of companies) if (c.triage) verdicts.set(c.key, c.triage);
    if (untriaged.length < companies.length) {
      log("triage_reused_from_checkpoint", {
        reused: companies.length - untriaged.length,
        to_triage: untriaged.length,
      });
    }

    if (deps.triageCompanies && untriaged.length > 0) {
      const batches = triageBatches(untriaged, deps.triageBatchSize ?? TRIAGE_BATCH_SIZE);
      const allowed = deps.triageBatchesAllowed ?? batches.length;
      let made = 0;

      // ── THE BATCHES RUN SIDE BY SIDE ───────────────────────────────────────
      //
      // WHY THIS IS THE IDENTITY STAGE'S PROBLEM. Triage is free, read-only and
      // parallel by nature — every batch is an independent model call over a
      // DISJOINT set of companies, and the verdicts land in a map keyed by
      // company, so nothing about the result depends on the order.
      //
      // Run one after another they cost wall clock that the PAID stages then do
      // not have. On task 83843770 four batches of 25 took 33.6s of a 125s
      // budget — more than identity resolution got — and identity managed 5 of
      // its 10 companies before the reserve stopped it. Five companies were
      // deferred to pay for a stage that was waiting on network round-trips it
      // could have overlapped.
      //
      // Lane count is shared with the paid stages deliberately: it is the same
      // question (how many concurrent provider calls is this runtime willing to
      // have outstanding) and one knob is easier to reason about than two.
      const budgeted = batches.slice(0, Math.max(0, allowed));
      const overflow = batches.slice(Math.max(0, allowed));

      // OUT OF BATCHES IS NOT A JUDGEMENT. The rest stay uncertain and remain
      // fully eligible for the shortlist.
      for (const batch of overflow) {
        for (const c of batch) {
          verdicts.set(c.key, uncertainVerdict(c.key, "triage_budget_exhausted"));
        }
      }

      await runBounded(budgeted, resolveTriageConcurrency(opts.readEnv), async (batch) => {
        // THE DEADLINE APPLIES TO FREE WORK TOO. A model call still costs wall
        // clock, and spending it here is what leaves none for the paid stages.
        // Checked per batch as each lane picks one up, so a run that goes long
        // stops starting new calls rather than being decided up front.
        if (deps.deadline?.expired("mission_triage") === true) {
          for (const c of batch) {
            verdicts.set(c.key, uncertainVerdict(c.key, "triage_deadline_deferred"));
          }
          return;
        }
        made++;
        const startedAt = Date.now();
        let parsed;
        try {
          const raw = await deps.triageCompanies!({
            input: buildMissionTriageInput({
              ctx: qualificationCtx,
              companies: batch.map(toTriageInput),
            }),
            company_keys: batch.map((c) => c.key),
          });
          parsed = parseMissionTriageStrict(raw, batch.map((c) => c.key));
        } catch (e) {
          // A THROWN TRIAGE CALL EXCLUDES NOBODY.
          log("triage_batch_error", { error: String(e), size: batch.length });
          parsed = parseMissionTriageStrict(null, batch.map((c) => c.key));
        }
        // OBSERVED PER CALL, NOT PER WAVE. `observeCall` feeds the latency
        // estimate the capacity maths uses; handing it a wall-clock span that
        // covered several overlapping calls would inflate it.
        deps.deadline?.observeCall(Date.now() - startedAt, "mission_triage");
        // Disjoint batches, so these writes never contend for the same key.
        for (const [k, v] of parsed.verdicts) verdicts.set(k, v);
        log("triage_batch_complete", {
          size: batch.length, parse_status: parsed.parse_status,
          unknown_keys: parsed.raw_shape.unknown_keys.length,
          missing_keys: parsed.raw_shape.missing_keys.length,
        });
      });

      state.triage = {
        ...summariseTriage(verdicts.values()),
        batches_made: made,
        batches_available: batches.length,
      };
    }

    // `?? c.triage` and not `?? null`: a company the fresh pass did not cover
    // keeps the verdict it arrived with. Overwriting it with null is how a
    // restored pool would have been silently un-triaged had the batch budget
    // run out mid-continuation.
    for (const c of companies) c.triage = verdicts.get(c.key) ?? c.triage ?? null;

    // ── STAGE 3: THE BUDGET DECIDES THE SHORTLIST ──────────────────────────
    //
    // TWO CONSTRAINTS, RECONCILED HERE. The count budget says how many
    // companies this run may pay for; the wall clock says how many it can
    // actually carry from identity through persistence before the invocation
    // ends. The smaller binds, and the decision records which one did.
    //
    // `stage2Ceiling` is gone — see `leadInvestigationBudget`. A GPT batch-read
    // limit authorised 100 paid Actor starts on run ea2d02f2 and the run
    // finished none of them.
    const countBudget = resolveInvestigationBudget({
      requestedCount: effectiveRequestedCount(opts.mission),
      poolSize: companies.length,
      read: opts.readEnv,
    });
    // OBSERVATIONAL ONLY at this point. Recorded so the shortlist decision can
    // be read against the clock it was made under; the ENFORCEMENT happens in
    // the identity stage, which recomputes it from that invocation's own
    // remaining time. See `downstreamReserveMs`.
    const capacity = deps.deadline
      ? resolveTimeCapacity({
        remainingMs: deps.deadline.remainingMs(),
        reserveMs: deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS,
        concurrency: LINKEDIN_RESOLUTION_CONCURRENCY,
        enrichmentBatchSize: COMPANY_DETAILS_BATCH_SIZE,
        read: opts.readEnv,
        observedIdentityMs: deps.deadline.estimateFor(IDENTITY_SEARCH_OP),
        // THE DOMINANT COST, AND THE GATE'S OWN NUMBER FOR THE ONE AFTER IT.
        hiringMsPerCompany: HIRING_MS_PER_COMPANY,
        hiringBatchSize: HIRING_VERIFICATION_BATCH_SIZE,
        qualificationMs: deps.deadline.estimateFor(QUALIFICATION_OP),
      })
      : null;
    // THE CLOCK DOES NOT SHRINK THE SHORTLIST — see `downstreamReserveMs`.
    // Doing so would strand companies permanently, because the shortlist is
    // computed once per lineage and a resume skips completed capabilities.
    // `capacity` is carried for observability and ENFORCED inside the identity
    // stage, where a stop is deferral rather than deletion.
    const budget = countBudget;
    // THE CHEAP STAGES ARE SIZED SEPARATELY, and never from this number.
    const gptBudget = resolveGptBudget({
      poolSize: companies.length,
      investigationBudget: budget.budget,
      read: opts.readEnv,
    });
    // ── WHOSE RULE IS ABOUT TO REJECT PEOPLE ────────────────────────────
    //
    // `resolveEmployeeBounds` already answers this — `mission`, `brain_hard`,
    // `brain_advisory` or `none` — and the answer never reached the label. Task
    // 5c461aa3 rejected eighteen companies as `mission_constraint:employee_size`
    // when the mission declared NO employee range at all: the 1–150 bound came
    // from the Company Brain's effective policy. Every one of those rejections
    // told the user they had asked for something they never asked for.
    const shortlistBoundSource = resolveEmployeeBounds(qualificationCtx, {
      employee_min: opts.brain?.employee_min ?? null,
      employee_max: opts.brain?.employee_max ?? null,
      hard_constraints: opts.brain?.hard_constraints ?? null,
    }).source;

    const decision = buildSmartShortlist(
      companies.map((c) => ({
        company_key: c.key,
        eligible: c.prequalified?.eligible ?? true,
        // A VERIFIED, ENFORCEABLE SIZE CONSTRAINT — whoever set it.
        //
        // `prequalified.exclusion` carries three values. `employee_size` fires
        // only when an enforceable range is set and the size is known to be
        // outside it. `technical_only` and `insufficient_commercial` come from
        // the role vocabulary and are judgements, so they rank (via `eligible`)
        // and no longer remove anyone from the pool.
        hard_exclusion: c.prequalified?.exclusion === "employee_size"
          ? "employee_size"
          : null,
        hard_exclusion_source: shortlistBoundSource,
        relevance: c.triage?.relevance ?? null,
        confidence: c.triage?.confidence ?? null,
        signal_strength: c.triage?.signal_strength ?? null,
        score: c.prequalified?.score ?? null,
        name: c.prequalified?.name ?? c.company.company_name ?? c.key,
      })),
      // RANK THE WHOLE POOL. This call now decides ORDER and PERMANENT
      // EXCLUSION only — the per-pass slice is taken separately. Passing the
      // spend budget here would mark everything past position ten
      // `budget_exhausted`, and this function reads that as a decision, which
      // is exactly how 90 companies were closed for the life of a lineage.
      { ...budget, budget: companies.length },
      // THE UNTRIAGED SPEND POLICY, read from the same env the budget uses.
      { untriaged: resolveUntriagedPolicy(opts.readEnv) },
    );

    // ── THE RANKING IS THE DURABLE ARTEFACT, NOT THE SELECTION ─────────────
    //
    // `buildSmartShortlist` decides ORDER and permanent EXCLUSION. It no longer
    // decides who is investigated — that is a per-pass slice, taken below and
    // again on every later pass and every continuation.
    const chosen = new Set(decision.selected);
    const rankOf = new Map(decision.ranking.map((k, i) => [k, i]));
    for (const c of companies) {
      c.investigation_rank = rankOf.get(c.key) ?? Number.MAX_SAFE_INTEGER;
      const why = decision.excluded.find((e) => e.company_key === c.key);
      // ONLY A DECISION CLOSES A COMPANY. `budget_exhausted` is a queue
      // position and must never reach this branch — the ranking call above is
      // given the whole pool precisely so it cannot — but the guard is stated
      // here too, because the cost of getting it wrong is silent and permanent.
      const permanent = why != null && why.reason !== "budget_exhausted" &&
        why.reason !== "not_selected";
      if (permanent) {
        // CLOSED BY A DECISION: a mission-stated constraint is verifiably
        // violated. (Triage never lands here: it ranks.) These never re-enter
        // the frontier.
        c.investigation_state = "excluded_permanently";
        c.shortlist_exclusion = why!.reason;
      } else if (c.investigation_state === "excluded_permanently") {
        // ALREADY CLOSED BY A DECISION this ranking did not make — a funding
        // screen FAIL, a recently-checked company, an earlier invocation's
        // mission constraint. "These never re-enter the frontier" held only for
        // this call's own exclusions: canary 16699a45's screen closed Stealth
        // Startup (funding 975 days old, complete history), the resumed slice
        // re-ranked it back to `pending_investigation`, and continuation ran two
        // empty slices chasing a company nothing could be bought for. The state
        // and its reason stand.
      } else if (wasInvestigated(c.investigation_state)) {
        // ALREADY PAID FOR, by an earlier pass or an earlier invocation. The
        // ranking may reorder the frontier; it may never return a company that
        // has been investigated to it, or the continuation re-buys the slice it
        // just finished.
        c.shortlist_exclusion = null;
      } else {
        // RANKED AND WAITING. `chosen` is only the first slice; everything else
        // stays on the frontier rather than being marked "not selected", which
        // is what froze 90 companies for the life of a lineage.
        c.investigation_state = "pending_investigation";
        c.shortlist_exclusion = null;
      }
      c.shortlisted = wasInvestigated(c.investigation_state);
    }
    state.investigation_ranking = decision.ranking.slice();
    state.shortlist_decision = {
      // THE SPEND BUDGET, NOT THE RANKING BUDGET. `decision.budget` carries the
      // pool-sized number this call was given so it would rank rather than
      // exclude; recording it here made the state claim the run had authorised
      // one paid investigation per discovered company.
      budget, counts: decision.counts,
      untriaged_policy: decision.untriaged_policy,
      ranking: decision.ranking.slice(0, 50),
      // BOTH BUDGETS, RECORDED SEPARATELY. "Why did this run only investigate
      // six companies?" must be answerable from the task row, and the answer is
      // one of: the count budget, the pool, or the clock.
      time_capacity: capacity,
      gpt_budget: gptBudget,
    };
    state.investigation_capacity = capacity;
    log("triage_and_ranking_complete", {
      budget: budget.budget, budget_source: budget.source,
      count_budget: countBudget.budget,
      requested: budget.requested_count, pool: budget.pool_size,
      ...decision.counts,
      triage_enabled: deps.triageCompanies != null,
      untriaged_policy: decision.untriaged_policy,
      // ── WHY THE CLOCK ALLOWED WHAT IT ALLOWED ────────────────────────────
      time_capacity: capacity?.capacity ?? null,
      per_company_ms: capacity?.per_company_ms ?? null,
      usable_ms: capacity?.usable_ms ?? null,
      gpt_read_budget: gptBudget.read_budget,
      gpt_evaluation_budget: gptBudget.evaluation_budget,
      frontier: companies.filter((c) => isFrontier(c.investigation_state)).length,
      excluded_permanently: companies.filter(
        (c) => c.investigation_state === "excluded_permanently").length,
      first_slice_preview: [...chosen].length,
    });
    // THE FUNDING SCREEN reorders the ranking just decided, before any slice.
    await applyFundingScreen(companies);
    missionIntelligenceApplied = true;
  };

  /**
   * TAKE THE NEXT SLICE OF THE FRONTIER — every pass, every invocation.
   *
   * This is the step whose absence stranded 90 companies. Selection used to
   * live inside `applyMissionIntelligence`, which runs inside the discovery
   * capability, which a continuation SKIPS — so the shortlist was computed once
   * per lineage and no later pass could widen it.
   *
   * It runs here instead: cheap, deterministic, a cursor over a ranking that
   * was decided once. It re-derives nothing and cannot disagree with itself
   * between passes.
   *
   * Returns how many companies were newly selected.
   */
  const takeInvestigationSlice = (
    companies: EngineCompany[], pass: number,
  ): number => {
    // The per-pass allowance. Sized on the pool that is still open, so a slice
    // never authorises more than the frontier holds.
    const budget = resolveInvestigationBudget({
      requestedCount: effectiveRequestedCount(opts.mission),
      poolSize: companies.filter((c) => isFrontier(c.investigation_state)).length,
      read: opts.readEnv,
    });
    // ── WORK ALREADY OWED SPENDS THE SAME ALLOWANCE ────────────────────────
    //
    // A continuation restores companies a previous invocation selected but
    // never got to buy — the deadline stopped the identity stage mid-slice.
    // They are already authorised, they still owe a paid search, and THIS pass
    // will make it. So they are part of THIS pass's spend.
    //
    // Selecting a full fresh slice on top of them let one pass authorise budget
    // PLUS carried work: a run resuming eight deferred candidates on a budget
    // of ten made eighteen paid searches.
    //
    // Measured by what is still OWED, not by `in_flight`. A slice that was
    // closed at the end of an invocation leaves its unbought companies
    // `investigated` — the state says the pass is over, not that the money was
    // spent — so keying on `in_flight` alone missed exactly the companies a
    // continuation is about to pay for.
    //
    // Only the remainder is available. Zero is a valid answer: a continuation
    // that inherits a full slice takes none, finishes what it owes, and lets
    // the yield loop decide whether to open the frontier further.
    const carried = companies.filter((c) =>
      wasInvestigated(c.investigation_state) && c.identity === null &&
      !c.company.linkedin_company_url
    ).length;
    // UNDER THE FUNDING SCREEN the run admits `plan.admit` companies to paid
    // investigation over its whole life — the run's `max_candidates` — however
    // wide the screened pool. Counted from the companies, so a continuation
    // cannot admit a second pair.
    const admitLeft = opts.fundingScreen
      ? Math.max(0, opts.fundingScreen.plan.admit -
        companies.filter((c) => wasInvestigated(c.investigation_state)).length)
      : Number.MAX_SAFE_INTEGER;
    const allowance = Math.min(Math.max(0, budget.budget - carried), admitLeft);
    const slice = selectInvestigationSlice(
      companies.map((c) => ({
        company_key: c.key,
        state: c.investigation_state,
        rank: c.investigation_rank,
      })),
      allowance,
    );
    const picked = new Set(slice.selected);
    for (const c of companies) {
      if (!picked.has(c.key)) continue;
      c.investigation_state = "in_flight";
      // `shortlisted` is the derived view every downstream stage already reads.
      c.shortlisted = true;
      c.shortlist_exclusion = null;
    }
    // ── THE SCREEN'S ADMISSIONS ARE SPENT: THE REST OF THE POOL IS CLOSED ──
    //
    // Under the funding screen the run admits `plan.admit` companies for its
    // whole life. Once they are admitted, a company still waiting can never be
    // investigated this mission — it is not a frontier, it is a decision the
    // run's budget already made. Left pending, continuation counted it as work
    // and re-dispatched slices that could buy nothing (canary 16699a45).
    let notAdmitted = 0;
    if (opts.fundingScreen &&
      companies.filter((c) => wasInvestigated(c.investigation_state)).length >= opts.fundingScreen.plan.admit) {
      for (const c of companies) {
        if (c.investigation_state !== "pending_investigation") continue;
        c.investigation_state = "excluded_permanently";
        c.shortlist_exclusion = "screen_not_admitted";
        c.shortlisted = false;
        notAdmitted++;
      }
      // …AND DISCOVERY IS OVER FOR THIS MISSION. Recorded on the state the
      // checkpoint carries, so the next slice's continuation reads "no discovery
      // routes remain" instead of the pre-admission record that said rows were
      // left (canary 1a0c3234: `replenishment_required` on 4 of 6 rows bought).
      if (state.funding_screen?.admissions_spent !== true) {
        state.funding_screen = { ...state.funding_screen, verdicts: state.funding_screen?.verdicts ?? {}, admissions_spent: true };
        if (state.discovery_source_state) {
          state.discovery_source_state = {
            ...state.discovery_source_state, exhausted: true, stop_reason: "screen_admissions_spent",
          };
        }
        log("funding_screen_admissions_spent", {
          admitted: opts.fundingScreen.plan.admit, closed_not_admitted: notAdmitted,
          discovery_exhausted: state.discovery_source_state?.exhausted ?? null,
        });
      }
    }
    // THE RUNNING TOTAL OF AUTHORISED SPEND. Every downstream report of "how
    // many did we shortlist" reads this rather than the ranking's own count.
    // Carried work counts: this invocation buys those searches too.
    state.investigation_selected += slice.selected.length + carried;
    state.investigation_slices.push({
      pass,
      selected: slice.selected.length,
      carried,
      remaining: slice.remaining,
      investigated: slice.investigated,
      excluded: slice.excluded,
      reason: slice.reason,
    });
    log("investigation_slice_taken", {
      pass, selected: slice.selected.length, frontier_remaining: slice.remaining,
      already_investigated: slice.investigated,
      excluded_permanently: slice.excluded, reason: slice.reason,
      budget: budget.budget, budget_source: budget.source,
      // "Why did this pass only take two?" — because it inherited eight.
      carried_in_flight: carried, allowance,
      ...(notAdmitted > 0 ? { closed_not_admitted: notAdmitted } : {}),
    });
    return slice.selected.length;
  };

  /** Everything selected on an earlier pass has had its money spent. */
  const closeInvestigatedSlice = (companies: EngineCompany[]): void => {
    for (const c of companies) {
      if (c.investigation_state === "in_flight") c.investigation_state = "investigated";
    }
  };

  /**
   * WHY THE LAST PROVIDER CALL RETURNED NOTHING — for BATCHED stages.
   *
   * `callProvider` records the reason on the company when it is given one, but
   * enrichment calls the provider once for a BATCH of LinkedIn URLs and has no
   * single company to attribute it to. Without this, a deferred or failed batch
   * was indistinguishable from a batch the provider genuinely answered with zero
   * rows — so "we ran out of time" was recorded as "this company has no
   * LinkedIn record", which is evidence, and wrong.
   *
   * Reset at the start of every call, read immediately after.
   */
  let lastCallBlock: "deferred" | "provider_error" | null = null;
  /** P4 — the plan route and provider call behind the rows `callProvider` just returned. */
  let lastCallRef: { route_id: string | null; plan_version: number | null; provider_call_id: string | null } = {
    route_id: null, plan_version: null, provider_call_id: null,
  };

  /**
   * NOTHING ENTERS A PAID STAGE UNTRIAGED AND UNBUDGETED.
   *
   * `applyMissionIntelligence` was called from exactly one place: inside the
   * `startup_company_discovery` branch, beside the YC prequalification it grew
   * up next to. Every other route into discovery — `general_company_discovery`,
   * `known_company_resolution` — reached identity resolution having run no
   * triage, taken no slice and consulted no budget.
   *
   * On run 130adf73 (2026-08-18) that is exactly what happened. GPT chose
   * `general_company_discovery` for "AI startups in the United States", and that
   * branch had none of the intelligence wired into it: 100 companies went to
   * paid identity resolution against a budget of 10, the wall clock afforded 7,
   * 93 were deferred, and qualification saw six companies out of a hundred.
   *
   * So the stage is no longer OFFERED by a discovery branch. It is REQUIRED by
   * the first paid stage — the one place that can state the invariant for every
   * route at once. Idempotent, so a branch that already ran it pays nothing to
   * ask again, and a discovery capability added later inherits the guarantee
   * without anyone remembering to wire it.
   */
  const ensureMissionIntelligence = async (companies: EngineCompany[]): Promise<void> => {
    if (missionIntelligenceApplied || companies.length === 0) return;
    log("mission_intelligence_deferred_apply", {
      reason: "a paid stage was reached before triage ran; applying now",
      companies: companies.length,
    });
    await applyMissionIntelligence(companies);
    takeInvestigationSlice(companies, 1);
  };

  /** One provider call: idempotency, cost, attempt record, never off-graph. */
  const callProvider = async (
    capability: CapabilityId, provider: string, compiled: CompileResult<unknown>,
    company?: EngineCompany,
    /**
     * The companies a BATCHED call asks about, in the order it asks.
     *
     * Recorded on the pending entry so a later slice can re-form the identical
     * batch and adopt the run instead of buying its question again. See
     * `pending_runs[].company_keys`. Ignored for single-company calls, which
     * already carry `company`.
     */
    group?: readonly string[],
  ): Promise<Record<string, unknown>[]> => {
    // CLEARED PER CALL. A stale block from an earlier batch would mark a
    // perfectly answered one as deferred.
    lastCallBlock = null;
    lastCallRef = { route_id: null, plan_version: currentPlan()?.version ?? null, provider_call_id: null };
    const spec = CAPABILITY_REGISTRY[capability];
    // COUNTED AT RECORD TIME, not before the await. The resolution stage runs two
    // calls concurrently; computing the number up front gave both of them
    // "attempt 1" and made the ledger unreadable.
    // FINGERPRINTED FROM THE COMPILED INPUT, when there is one. A compile
    // failure has no input to fingerprint and needs none: it never reached a
    // provider, so there is no question to avoid repeating.
    let attemptFingerprint = compiled.ok ? inputFingerprint(compiled.input) : undefined;
    // ── A RUN WE ARE ONLY RE-READING WAS ALREADY PAID FOR ───────────────────
    //
    // Set when this call adopts a run some earlier invocation started. Adoption
    // is `GET /actor-runs/{id}` on a run that was charged when it was POSTed,
    // so it must add NOTHING to the lineage's cost.
    //
    // It did. Run fafd9912's resumed slice adopted `ub2qunSMAKTNf5AKv` and
    // recorded two attempts for the one call — `run_adopted` at `cost_units: 0`
    // and, from `record` below, `ok` at `cost_units: 1`. Credits were unaffected
    // (`authorizeProviderCall` is keyed by `logical_call_key`, so no second
    // reservation was ever made) but `accumulated_cost_units` counted a free
    // read as spend, and that number is the lineage ceiling
    // `decideAutoContinuation` stops on. The error was in the safe direction —
    // it stops a run early, never spends more — which is exactly why it could
    // sit there unnoticed.
    //
    // A `let` rather than a read of `inFlight`: `record` is called for
    // `compile_failed` before `inFlight` is in scope, and closing over a `const`
    // declared later would put that path in the temporal dead zone.
    let adoptedRunId: string | null = null;

    const record = (outcome: ProviderAttempt["outcome"], rows: number, reason: string | null) => {
      const attempt = state.provider_attempts
        .filter((a) => a.capability === capability && a.provider === provider).length + 1;
      // An outcome that returned data is chargeable ONLY if this call is what
      // bought it.
      const chargeable = (outcome === "ok" || outcome === "empty") && !adoptedRunId;
      state.provider_attempts.push({
        capability, provider, attempt, outcome, rows,
        cost_units: chargeable ? spec.cost_units : 0,
        reason,
        ...(attemptFingerprint ? { input_fingerprint: attemptFingerprint } : {}),
      });
      if (chargeable) {
        state.accumulated_cost_units += spec.cost_units;
      }
    };

    if (!compiled.ok) {
      record("compile_failed", 0, compiled.errors.join("; "));
      return [];
    }
    let call = compiled;

    // ── P2: THE SPEC IS COMPILED HERE, AND THE SPEC IS WHAT IS SENT ──────────
    let callSpec: ProviderCallSpec | null = null;
    const p2Card = specOn ? hiringActorCard(provider) : null;
    if (specOn && criteriaPolicy) {
      const plan = currentPlan();
      const engineInput = call.input as Record<string, unknown>;
      const entry = plan ? planEntryForCall(plan, capability, provider, engineInput) : null;
      const route = entry?.kind === "route" ? entry.route : null;
      const purpose = purposeForCapability(capability);
      const countField = (p2Card?.input_limits && "maxResults" in p2Card.input_limits) ? "maxResults" : "maxItems";
      const engineCount = typeof engineInput[countField] === "number" ? engineInput[countField] as number : null;
      // ── THE RUN'S CANDIDATE ALLOWANCE IS FOR THE MISSION, NOT PER CALL ────
      // The screened pool under the funding screen — `discoveryRowAllowance`.
      const candidateCap = purpose === "discovery" ? discoveryRowAllowance() : null;
      const candidatesLeft = candidateCap === null ? null : Math.max(0, candidateCap - (state.discovery_rows_bought ?? 0));
      if (candidatesLeft === 0) {
        appendTrace(state.mission_trace!, "call_refused_budget", {
          actor: provider, capability, purpose, ceiling: "max_candidates",
          limit: candidateCap, bought: state.discovery_rows_bought ?? 0,
        }, { plan_version: plan?.version ?? null, provider_call_id: null, idempotency_key: null });
        record("refused_budget", 0, `run budget: ${candidateCap} discovery candidate(s) already bought`);
        log("discovery_candidate_budget_reached", { capability, provider, limit: candidateCap, bought: state.discovery_rows_bought ?? 0 });
        return [];
      }
      const discoveryBound = candidatesLeft === null
        ? opts.maxCandidates
        : Math.min(candidatesLeft, opts.maxCandidates ?? candidatesLeft);
      callSpec = compileProviderCallSpec({
        actorKey: provider, capability, purpose,
        proposed: entry ? (entry.kind === "route" ? entry.route.proposed_input : entry.stage.proposed_input) : null,
        engine: engineInput, policy: criteriaPolicy,
        plan: {
          plan_id: plan?.plan_id ?? null, version: plan?.version ?? null, route_id: route?.route_id ?? null,
          route_anchor: route?.anchor ?? (purpose === "discovery" ? anchorForCapability(capability) : null),
          route_refused: route?.refused ?? null,
        },
        candidate_keys: company ? [company.key] : [...(group ?? [])],
        scope: p2Scope, mission_hash: p2MissionHash, ceilings: state.spend_ledger!.ceilings,
        cost_model: p2Card?.cost_model ?? null,
        contract_fields: P2_ACTOR_CONTRACTS[provider]?.fields ?? null,
        card_enums: p2Card?.verified_enums, card_limits: p2Card?.input_limits,
        count_bounds: purpose === "discovery"
          ? [
            ...(typeof discoveryBound === "number"
              ? [{
                value: discoveryBound, changed_by: "budget_policy" as const,
                reason: candidatesLeft !== null && discoveryBound === candidatesLeft && candidatesLeft < (opts.maxCandidates ?? Infinity)
                  ? "candidates left in the run budget" : "discovery pool size for the requested count",
              }]
              : []),
            // THE FUNDING SCREEN'S PAGE SIZE: the first page asks for
            // `first_rows`, leaving the rest of the allowance for the top-up. The
            // planner's own count must not spend the top-up on page one.
            ...(opts.fundingScreen && engineCount && engineCount > 0
              ? [{ value: engineCount, changed_by: "budget_policy" as const, reason: "funding screen page size" }]
              : []),
          ]
          : (engineCount && engineCount > 0 && purpose !== "identity"
            ? [{ value: engineCount, changed_by: "budget_policy" as const, reason: "engine batch sizing for this stage" }]
            : []),
        size_ceiling: memo23MaxSizeCeiling,
        readiness: routePolicy,
      });
      state.provider_call_specs!.push(specSummary(callSpec));
      lastCallRef = { route_id: callSpec.route_id, plan_version: callSpec.plan_version, provider_call_id: callSpec.provider_call_id };
      if (state.provider_call_specs!.length > 300) state.provider_call_specs!.shift();
      const refs = { plan_version: callSpec.plan_version, provider_call_id: callSpec.provider_call_id, idempotency_key: callSpec.idempotency_key };
      appendTrace(state.mission_trace!, callSpec.status === "intended" ? "spec_compiled" : "spec_refused", {
        actor: provider, capability, purpose, route_id: callSpec.route_id,
        changes: specSummary(callSpec).changes, engine_rewrites_rejected: callSpec.engine_rewrites_rejected,
        estimate_usd: callSpec.cost.estimate_usd, ceiling_usd: callSpec.cost.ceiling_usd, refusal: callSpec.refusal,
      }, refs);
      if (callSpec.status !== "intended") {
        record(callSpec.status === "refused_budget" ? "refused_budget" : "refused_policy", 0,
          callSpec.refusal ? `${callSpec.refusal.code}: ${callSpec.refusal.detail}` : null);
        log("provider_call_spec_refused", { capability, provider, refusal: callSpec.refusal });
        return [];
      }
      call = {
        ...call,
        input: callSpec.serialized_input as never,
        inputHash: p2HashInput(callSpec.serialized_input, provider),
        batchIdentity: `${provider}:spec:${callSpec.idempotency_key.slice(0, 24)}`,
        providerCallSpec: callSpec,
        // The run that executes the spec, so its receipt can settle the reservation.
        onProviderRun: (run: { run_id: string }) =>
          attachProviderRun(state.spend_ledger!, callSpec!.idempotency_key, run.run_id),
      } as typeof call;
      attemptFingerprint = inputFingerprint(call.input);
    }

    // ── THE RESUME GUARD ─────────────────────────────────────────────────────
    //
    // Checked FIRST, ahead of every other gate, because the cheapest call is the
    // one that is never made. `shouldSkipProviderCall` has been persisted and
    // tested since the checkpoint landed and no call site consulted it, so a
    // continuation re-bought identity resolution for companies it had already
    // resolved — the precise waste the checkpoint was written to end.
    //
    // ONLY where the skip is LOSSLESS. `company` is passed by call sites whose
    // result the resume state can restore or whose outcome is already terminal;
    // for everything else this is inert and the call proceeds as before. A skip
    // that returned an empty result the caller then read as evidence would trade
    // money for correctness, which is a worse bargain than the one it replaces.
    // ── V2 KEY TO WRITE, LEGACY KEY TO RECOGNISE ──────────────────────────
    //
    // The fingerprint moved to SHA-256 over `{actorKey, input}`. Every
    // checkpoint written before that carries the djb2 key, so the skip check is
    // given both: a search this lineage already paid for must still match, or
    // the change to the hash would buy every one of them again.
    const opKeyFor = (fingerprint: string) => providerOperationKey({
      workspace_id: resumeScope!.workspace_id,
      lineage_root_task_id: resumeScope!.lineage_root_task_id,
      company_key: company!.key,
      capability, provider,
      input_fingerprint: fingerprint,
    });
    const operationKey = resumeScope && company
      ? opKeyFor(inputFingerprintV2(provider, call.input))
      : null;
    const legacyOperationKeys = resumeScope && company
      ? [opKeyFor(inputFingerprint(call.input))]
      : [];
    if (operationKey && company) {
      const verdict = shouldSkipProviderCall(
        priorRecords.get(company.key), operationKey, legacyOperationKeys);
      if (verdict.skip) {
        record("skipped_resume_reuse", 0, verdict.reason);
        log("provider_skipped_resume_reuse", {
          capability, provider, company_key: company.key, reason: verdict.reason,
        });
        return [];
      }
    }

    if (deps.callCompleted?.(call.batchIdentity)) {
      record("skipped_idempotent", 0, call.batchIdentity);
      return [];
    }
    // THE DEADLINE IS CHECKED BEFORE THE CALL, NEVER AFTER.
    //
    // `expired()` means "there is no longer room for another call plus writing
    // state" — not "time is up". Starting a call that cannot finish is exactly
    // how the previous run died holding a billed Actor run it never read.
    // THE RESERVE, checked BEFORE the deadline itself.
    //
    // `expired()` means "no room for another call". The reserve is stricter: it
    // stops starting paid work while there is still time to WRITE A CHECKPOINT,
    // so a resume knows exactly which company owes which stage. The previous run
    // learned it was out of time by being killed.
    if (deps.deadline &&
        shouldCheckpoint({
          elapsedMs: () => deps.deadline!.elapsedMs(),
          remainingMs: () => deps.deadline!.remainingMs(),
        }, deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS)) {
      record("skipped_deadline", 0,
        `checkpoint reserve reached after ${deps.deadline.elapsedMs()}ms ` +
        `(${deps.deadline.remainingMs()}ms left); call not started`);
      // THIS COMPANY WAS DEFERRED, NOT ANSWERED. Without this the caller reads
      // an empty result and resolves it into "nothing matched" — turning a
      // clock decision into a permanent fact about the company.
      if (company) company.stage_block = { capability, reason: "deferred" };
      lastCallBlock = "deferred";
      state.terminal_reason = "execution_deadline_checkpoint";
      log("provider_skipped_checkpoint_reserve", {
        capability, provider, remaining_ms: deps.deadline.remainingMs(),
      });
      return [];
    }
    // RESUME BEFORE START. If a run for this capability+provider is already in
    // flight from an earlier invocation, adopt its id: the caller reads that run
    // and its dataset instead of issuing a second, separately-billed start.
    // ADOPT ONLY THE RUN THAT ASKED THIS QUESTION. Matching capability and
    // provider alone let a batch of one inherit a batch of ten's run id.
    const thisFingerprint = compiled.ok ? inputFingerprint(call.input) : null;
    // A NULL CAPABILITY MEANS "DO NOT KNOW", NOT "DOES NOT MATCH".
    //
    // Entries rebuilt by `recoverPendingRuns` carry `capability: null`: the
    // ledger records the ACTOR key, and the actor→capability mapping is
    // ambiguous (`apify_linkedin_company_search` serves both discovery and
    // identity resolution in the same run). Abstaining is honest; guessing
    // would attach a paid run to the wrong stage.
    //
    // Nothing is weakened by admitting them. The `input_fingerprint` is still
    // REQUIRED and still exact, and it is a strictly stronger key than the
    // capability — the same input to the same provider is the same purchase
    // whichever stage asked for it. The batch-of-one-inheriting-a-batch-of-ten
    // failure was caused by dropping the fingerprint, not the capability.
    const inFlight = (opts.state?.pending_runs ?? []).find(
      (r) => (r.capability === capability || r.capability === null) &&
        r.provider === provider &&
        !!r.input_fingerprint && r.input_fingerprint === thisFingerprint);
    // ── A RUN THIS LINEAGE ALREADY FINISHED IS RE-READ, NOT RE-BOUGHT ──────
    //
    // Same provider, same input: the answer is in a dataset already paid for.
    // Reading it is a GET; asking again is a second Actor start. Run 4250f181
    // bought memo23 input 7dfd89de twice, one slice apart.
    const completedMatch = !inFlight && thisFingerprint
      ? (opts.state?.completed_runs ?? []).find((r) =>
        r.provider === provider && r.input_fingerprint === thisFingerprint)
      : undefined;
    // `capabilityId` is what lets `guardedInvoker` enforce per-capability
    // containment rather than the plan-wide union.
    // FROM HERE ON THIS CALL IS A RE-READ, NOT A PURCHASE. Recorded before
    // `invoke` so every outcome of an adopted call — ok, empty, error — is
    // uncharged, rather than only the one that happens to succeed.
    if (inFlight) adoptedRunId = inFlight.run_id;
    else if (completedMatch) adoptedRunId = completedMatch.run_id;
    // ── P2: IDEMPOTENCY, THEN RESERVE — BEFORE ANY NETWORK CALL ─────────────
    if (callSpec) {
      const ledger = state.spend_ledger!;
      const refs = { plan_version: callSpec.plan_version, provider_call_id: callSpec.provider_call_id, idempotency_key: callSpec.idempotency_key };
      const already = ledger.reservations.some((r) => r.idempotency_key === callSpec!.idempotency_key &&
        (r.status === "executed" || r.status === "settled"));
      if (already && !inFlight && !completedMatch) {
        record("skipped_idempotent", 0, `spec ${callSpec.provider_call_id} already executed in this lineage`);
        appendTrace(state.mission_trace!, "call_idempotent_skip", { actor: provider, capability }, refs);
        return [];
      }
      if (inFlight || completedMatch) {
        appendTrace(state.mission_trace!, "call_adopted", {
          actor: provider, capability, run_id: (inFlight ?? completedMatch)!.run_id,
        }, refs);
      } else {
        const d = reserve(ledger, {
          idempotency_key: callSpec.idempotency_key, provider_call_id: callSpec.provider_call_id,
          purpose: callSpec.purpose, route_id: callSpec.route_id,
          route_anchor: callSpec.route_id ? (currentPlan()?.routes.find((r) => r.route_id === callSpec!.route_id)?.anchor ?? null) : null,
          candidate_keys: callSpec.candidate_keys, estimate_usd: callSpec.cost.estimate_usd,
        });
        if (!d.ok) {
          record("refused_budget", 0,
            `${d.ceiling} ceiling $${d.limit_usd} would be exceeded ($${d.would_commit_usd} committed)`);
          appendTrace(state.mission_trace!, "call_refused_budget", {
            actor: provider, capability, ceiling: d.ceiling, limit_usd: d.limit_usd, would_commit_usd: d.would_commit_usd,
          }, refs);
          log("provider_call_refused_budget", { capability, provider, ceiling: d.ceiling, limit_usd: d.limit_usd });
          return [];
        }
        appendTrace(state.mission_trace!, "call_reserved", { actor: provider, estimate_usd: callSpec.cost.estimate_usd }, refs);
      }
    }
    const outbound = {
      ...call,
      capabilityId: capability,
      ...(inFlight
        ? { resumeRunId: inFlight.run_id }
        : completedMatch ? { resumeRunId: completedMatch.run_id } : {}),
    } as typeof call;
    const startedAt = Date.now();
    try {
      const rows = await invoke(outbound);
      // ── A RUN THAT RESOLVED IS NO LONGER PENDING ─────────────────────────
      //
      // `pending_runs` was push-only. Nothing ever removed an entry, and
      // `state` is spread wholesale from the checkpoint on every continuation,
      // so the first pending run a lineage ever started stayed "pending" for
      // the rest of that lineage's life — after it had succeeded, been adopted
      // and been read. `awaiting_external_run` and the finalizer's
      // `pending_external_run` verdict both key off this list, so both would
      // keep asserting a wait that had already ended.
      //
      // It also has to be true for the continuation gate to be SAFE: that gate
      // now refuses to call a run barren while a paid call is in flight, and a
      // list that never empties would turn that into "continue until the
      // ceiling", every time. Reaching here means `invoke` returned rows rather
      // than throwing pending, so this run is done.
      if (inFlight) {
        const at = state.pending_runs.findIndex((r) => r.run_id === inFlight.run_id);
        if (at >= 0) state.pending_runs.splice(at, 1);
        // WHAT THE AUDIT HAD TO GO TO THE APIFY CONSOLE FOR. The persisted
        // state of run 783fa163 recorded that Zs5bYFGlnua1hJWYg was pending and
        // never that it finished, so its 1,394 rows were invisible to every
        // artefact this system writes. Adoption is free — a `GET` on a run
        // already charged for — hence `cost_units: 0`.
        state.provider_attempts.push({
          capability, provider,
          attempt: state.provider_attempts
            .filter((a) => a.capability === capability && a.provider === provider).length + 1,
          outcome: "run_adopted", rows: rows.length, cost_units: 0,
          reason: `adopted run ${inFlight.run_id} started at ${inFlight.started_at}` +
            `; ${rows.length} row(s) read without a second charge`,
          ...(attemptFingerprint ? { input_fingerprint: attemptFingerprint } : {}),
        });
        log("provider_run_adopted", {
          capability, provider, run_id: inFlight.run_id, rows: rows.length,
        });
        // ── AND THE LEDGER ROW STOPS SAYING "started" ────────────────────
        //
        // The row that recorded the POST keeps `status: "started"` for ever:
        // adoption cannot insert its own row, because `logical_call_key` is
        // unique and the resumed call computes the SAME key — the insert
        // collides and `withExecutionAudit` logs and drops it by design.
        //
        // So the run stayed permanently "recoverable". `recoverPendingRuns`
        // would resurrect `ub2qunSMAKTNf5AKv` on every future resume of run
        // fafd9912, and `resume-stalled-leads` would keep reading it as
        // outstanding paid work. Harmless in effect — the companies are in
        // `completed_operations`, so nothing is re-bought, and adoption is
        // free — but it is a fact about the world that the ledger had wrong.
        //
        // Best-effort, like every other ledger write: a failure here is logged
        // and dropped, because bookkeeping must never fail a run it is only
        // describing.
        await deps.onRunAdopted?.({
          run_id: inFlight.run_id,
          dataset_id: inFlight.dataset_id ?? null,
          provider, capability, rows: rows.length,
        });
      } else if (completedMatch) {
        state.provider_attempts.push({
          capability, provider,
          attempt: state.provider_attempts
            .filter((a) => a.capability === capability && a.provider === provider).length + 1,
          outcome: "run_adopted", rows: rows.length, cost_units: 0,
          reason: `re-read completed run ${completedMatch.run_id}; ${rows.length} row(s) without a second charge`,
          ...(attemptFingerprint ? { input_fingerprint: attemptFingerprint } : {}),
        });
        log("provider_completed_run_reused", {
          capability, provider, run_id: completedMatch.run_id, rows: rows.length,
        });
      }
      // THE ESTIMATE LEARNS FROM REALITY. memo23 took 24s on task c8a6e53d; a
      // deadline still assuming 12s would have authorised one more call it could
      // not finish.
      //
      // SCOPED TO THE PROVIDER, so what discovery costs is not charged against
      // what an identity search costs. One monotonic maximum across every
      // provider is what stranded nine candidates behind a 51s memo23 start.
      deps.deadline?.observeCall(
        Date.now() - startedAt, deadlineOperationFor(capability, provider));
      deps.onCallComplete?.(call.batchIdentity);
      record(rows.length > 0 ? "ok" : "empty", rows.length, null);
      // THE LEDGER OF WHAT WAS BOUGHT, written only after the answer arrived.
      //
      // An errored or still-pending call records nothing, so a retry is never
      // mistaken for completed work. An EMPTY result does record: the question
      // was asked and paid for, and asking it again buys the same silence.
      if (operationKey && company && !company.completed_operations.includes(operationKey)) {
        company.completed_operations.push(operationKey);
      }
      // Rows THIS call bought: an adopted or already-completed run was paid for
      // by the call that started it, and is not counted twice.
      if (callSpec && callSpec.purpose === "discovery" && !inFlight && !completedMatch && !adoptedRunId) {
        state.discovery_rows_bought = (state.discovery_rows_bought ?? 0) + rows.length;
      }
      if (callSpec && !inFlight && !completedMatch && p2Card) {
        const floor = derivedFloorUsd(provider, p2Card.cost_model, callSpec.serialized_input as Record<string, unknown>, rows.length);
        markExecuted(state.spend_ledger!, callSpec.idempotency_key, floor);
        appendTrace(state.mission_trace!, "call_executed", { actor: provider, rows: rows.length, provisional_usd: floor },
          { plan_version: callSpec.plan_version, provider_call_id: callSpec.provider_call_id, idempotency_key: callSpec.idempotency_key });
      }
      return rows;
    } catch (e) {
      deps.deadline?.observeCall(
        Date.now() - startedAt, deadlineOperationFor(capability, provider));
      if (callSpec && !inFlight && !completedMatch) {
        const refs = { plan_version: callSpec.plan_version, provider_call_id: callSpec.provider_call_id, idempotency_key: callSpec.idempotency_key };
        const failedRunId = ((e as { toolResult?: { run_id?: unknown } }).toolResult ?? {}).run_id;
        if (e instanceof CapabilityContainmentError || e instanceof PaidExecutionBlockedError ||
            (typeof failedRunId !== "string" && refusedBeforeAnyRun(e))) {
          // Refused before the network — or by the tool layer before any run
          // existed (P3 canary 03f4c9c6: an opt-in-only actor) — nothing was bought.
          release(state.spend_ledger!, callSpec.idempotency_key);
          if (refusedBeforeAnyRun(e)) {
            state.unavailable_providers = markProviderUnavailable(state.unavailable_providers, {
              provider, capability, reason: String((e as Error)?.message ?? e).slice(0, 160),
              refused_at: new Date().toISOString(),
              readiness_at_refusal: readinessOf(provider, capability).readiness,
            });
          }
          appendTrace(state.mission_trace!, "call_released", { actor: provider, error: String(e).slice(0, 200) }, refs);
        } else {
          // The run may have started: the start fee is the floor until a receipt settles it.
          const floor = p2Card?.cost_model.start_usd ?? 0;
          markExecuted(state.spend_ledger!, callSpec.idempotency_key, floor);
          const failedRun = ((e as { toolResult?: { run_id?: unknown } }).toolResult ?? {}).run_id;
          if (typeof failedRun === "string") attachProviderRun(state.spend_ledger!, callSpec.idempotency_key, failedRun);
          appendTrace(state.mission_trace!, "call_failed", { actor: provider, error: String(e).slice(0, 200), provisional_usd: floor }, refs);
        }
      }
      // A CONTAINMENT error is an engine bug, not a provider failure. Letting it
      // become "try the next provider" is exactly how a guard turns into a
      // suggestion, so it propagates.
      if (e instanceof CapabilityContainmentError) throw e;
      if (e instanceof PaidExecutionBlockedError) throw e;

      // A RUN THAT STARTED IS NOT A FAILURE. It is billed and it exists, so it
      // is recorded as PENDING with its real cost and its identifiers, and the
      // capability neither completes nor falls back.
      const pending = deps.readPendingRun?.(e) ?? null;
      if (pending?.run_id) {
        state.provider_attempts.push({
          capability, provider,
          attempt: state.provider_attempts
            .filter((a) => a.capability === capability && a.provider === provider).length + 1,
          outcome: "pending", rows: 0,
          cost_units: pending.cost_units ?? spec.cost_units,
          reason: `run ${pending.run_id} still running; dataset ${pending.dataset_id ?? "pending"}`,
        });
        state.accumulated_cost_units += pending.cost_units ?? spec.cost_units;
        if (!state.pending_runs.some((r) => r.run_id === pending.run_id)) {
          state.pending_runs.push({
            capability, provider, run_id: pending.run_id,
            dataset_id: pending.dataset_id ?? null,
            actor_build_id: pending.actor_build_id ?? null,
            started_at: new Date().toISOString(),
            // What this run was asked. Only a call asking the same thing may
            // adopt it.
            ...(attemptFingerprint ? { input_fingerprint: attemptFingerprint } : {}),
            // WHO it was asked about, so the batch can be re-formed exactly.
            ...(group && group.length > 0 ? { company_keys: [...group] } : {}),
          });
        }
        // NOBODY WAS ANSWERED. The deadline and credit paths both set this,
        // with the reason spelled out there: without it the caller reads an
        // empty result and resolves it into "nothing matched", turning a
        // CLOCK decision into a permanent fact about a company. A pending run
        // is the same situation — the provider has not spoken yet — and this
        // branch was the one place that did not say so.
        //
        // Run 8f59170d: the batched hiring search went pending, its group was
        // marked `asked`, and Sortly resolved to `hiring: "not_verified"`. That
        // is not a resumable stage, so the continuation skipped hiring
        // entirely, never adopted the run, and investigated nobody.
        if (company) company.stage_block = { capability, reason: "deferred" };
        lastCallBlock = "deferred";
        log("provider_pending", { capability, provider, run_id: pending.run_id });
        return [];
      }
      // ── REFUSED FOR CREDIT IS NOT A PROVIDER FAULT ────────────────────
      //
      // Nothing was started and nothing was learned about this company, so
      // recording `provider_error` would attach a verdict to a company the run
      // never looked at. It takes the DEADLINE path's shape instead — block the
      // company as deferred, set a checkpoint reason, return empty — because
      // "we may not spend right now" and "we are out of time" are the same
      // situation from the frontier's point of view: resumable, no verdict, no
      // money spent. Reusing that shape is also why there is no second way to
      // pause a run.
      if (String(e).includes(CREDIT_REFUSED_ERROR)) {
        record("skipped_credit_refused", 0,
          "credit authorisation refused; the call was not started");
        if (company) company.stage_block = { capability, reason: "deferred" };
        lastCallBlock = "deferred";
        state.terminal_reason = "credit_exhausted_checkpoint";
        log("provider_refused_no_credit", { capability, provider });
        return [];
      }
      record("error", 0, String(e));
      // A FAILED CALL IS NOT A NEGATIVE ANSWER. Same reasoning as the deadline
      // skip above: the caller must not read the empty array as evidence.
      if (company) company.stage_block = { capability, reason: "provider_error" };
      lastCallBlock = "provider_error";
      log("provider_error", { capability, provider, error: String(e) });
      return [];
    }
  };

  /** P4 — who is speaking for the rows the last `callProvider` returned. */
  const observedBy = (capability: CapabilityId, provider: string): ObservationContext => ({
    capability, actor_key: provider, provider: "apify",
    route_id: lastCallRef.route_id, plan_version: lastCallRef.plan_version,
    provider_call_id: lastCallRef.provider_call_id,
    mission_id: resumeScope?.lineage_root_task_id ?? opts.identity?.task_id ?? null,
    observed_at: new Date().toISOString(),
  });

  /**
   * Publish what is TRUE right now.
   *
   * `qualified_companies` reads the explicit verdict and nothing else, so a
   * mid-run snapshot cannot report a company as qualified before the Company
   * Brain has said so. `in_progress` stays true until the plan is out of pending
   * capabilities, which is what tells the Workbench these rows are not yet
   * actionable.
   */
  const publish = async (stage: EngineProgress["stage"]) => {
    const exclusion_reasons: Record<string, number> = {};
    for (const c of state.prequalification?.companies ?? []) {
      if (!c.exclusion) continue;
      exclusion_reasons[c.exclusion] = (exclusion_reasons[c.exclusion] ?? 0) + 1;
    }
    const progress: EngineProgress = {
      stage,
      accounts_found: companies.length,
      evaluated: state.prequalification?.unique_companies ?? 0,
      eligible_opportunities: state.prequalification?.eligible_companies ?? 0,
      exclusion_reasons,
      identity_resolved: companies.filter((c) => c.identity && identityIsActionable(c.identity)).length,
      identity_unresolved: companies.filter((c) => c.identity && !identityIsActionable(c.identity)).length,
      companies_enriched: companies.filter((c) => c.enriched !== null).length,
      hiring_verified: companies.filter((c) => c.hiring_jobs.length > 0).length,
      // THE ONLY SOURCE OF A QUALIFIED COUNT IS THE BRAIN'S VERDICT.
      qualified_companies: specOn
        ? canonicalDecisionSummary(companies, opts).qualified
        : companies.filter((c) => c.verdict === "pass").length,
      decision_makers_verified: companies.reduce((n, c) => n + c.verified_founders.length, 0),
      open_jobs_evaluated: state.prequalification?.open_jobs_evaluated ?? 0,
      shortlisted: companies.filter((c) => c.shortlisted).length,
      // TRUE BECAUSE THIS IS BEING PUBLISHED FROM INSIDE THE RUN. The caller
      // corrects it when the invocation ends.
      in_progress: true,
      awaiting_external_run: state.pending_runs.length > 0,
    };
    state.progress = progress;
    // AWAITED. A fire-and-forget write in an edge function is a write that may
    // never land — the process can be torn down before the promise settles,
    // which is the same class of loss the terminal guard exists to stop.
    await deps.onProgress?.(progress);
    await deps.onStateChange?.(state);
    // ── AND A CHECKPOINT THE NEXT SLICE COULD ACTUALLY USE ─────────────────
    //
    // Run 83d544a5: the first slice POSTed a job search, was killed mid-poll
    // before any terminal write, and left a task with no checkpoint at all —
    // `claim_sourcing_continuation` correctly refuses to manufacture a
    // resumable run out of one with no state, so 44 paid job rows were
    // stranded. Run 8f59170d then showed the other half: a checkpoint written
    // from `state` alone claims completed capabilities it holds no data for.
    //
    // `checkpointSnapshot` takes both halves together and says whether the
    // result is coherent. AWAITED, because the write it drives must land.
    // ── WHAT THE CHECKPOINT ACTUALLY CARRIES, AT THE MOMENT IT IS WRITTEN ──
    //
    // OBSERVABILITY ONLY. Nothing here changes what is published.
    //
    // On lineage 4ef85feb the enrichment gate re-bought the same ten companies
    // three times. Identity resolution grew 40 -> 46 -> 51 while enrichment
    // selected 12 -> 18 -> 23, so the "already enriched" baseline sat frozen at
    // exactly 28 across three slices and then jumped to 51 at the end. Every
    // component tests correct in isolation — `restoreWorkingSet` restores the
    // payload from a real record, `toResumeRecord` round-trips it, no checkpoint
    // was refused as incoherent, no write errored, and no two `run-agent` slices
    // ran concurrently. The effect is visible and the mechanism is not.
    //
    // The gap is that nothing records what the checkpoint HELD at write time.
    // `companies_enriched` goes to `onProgress`, which logs nothing, and the
    // checkpoint is overwritten in place so the history is gone. These two
    // counts are the whole question:
    //
    //   in_memory  — companies the engine believes it has enriched
    //   in_records — companies whose resume record actually carries the payload
    //
    // They should be equal. If they diverge, the loss is in `toResumeRecord`.
    // If they agree here and the next slice restores fewer, the loss is in the
    // write or the read, and the next run says which.
    const snap = checkpointSnapshot(state, companies);
    log("checkpoint_published", {
      stage,
      companies: companies.length,
      enriched_in_memory: companies.filter((c) => c.enriched !== null).length,
      enriched_in_records: snap.resume_records.filter((r) => {
        const e = (r.snapshot as { enriched?: unknown } | null | undefined)?.enriched;
        return e !== null && e !== undefined;
      }).length,
      identity_actionable: companies.filter(
        (c) => c.identity && identityIsActionable(c.identity)).length,
      coherent: snap.coherent,
    });
    const outcome = await deps.onCheckpoint?.(snap);
    // ── AND WHAT HAPPENED TO IT ──────────────────────────────────────────
    //
    // `checkpoint_published` above records what was OFFERED. This records the
    // fate. Together they separate the three cases lineage e5d4fc14 could not:
    //
    //   offered but skipped  — written:false with a reason
    //   written successfully — written:true with the resulting version
    //   written then lost    — written:true here, yet the next restore holds less
    if (outcome && typeof outcome === "object") {
      log("checkpoint_write", {
        stage,
        written: outcome.written,
        reason: outcome.reason ?? null,
        checkpoint_version: outcome.checkpoint_version ?? null,
        enriched_in_records: snap.resume_records.filter((r) => {
          const e = (r.snapshot as { enriched?: unknown } | null | undefined)?.enriched;
          return e !== null && e !== undefined;
        }).length,
      });
    }
  };

  const finish = (
    capability: CapabilityId,
    status: CapabilityRunResult["capability_outcomes"][number]["status"],
    rows: number, providers: string[], evidence: boolean, reason: string | null,
  ) => {
    outcomes.push({
      capability, status, rows, providers_used: providers,
      evidence_satisfied: evidence, reason,
    });
    // COMPLETED MEANS THE CAPABILITY DID ITS JOB — nothing weaker.
    //
    // A capability whose provider returned zero usable records, whose required
    // evidence is missing, or whose input failed validation is NOT complete. It
    // stays pending, so a resume retries it and the downstream people gate keeps
    // refusing. Marking it complete on a zero result is what let task
    // e8abeb8f-…-cfcbc6a416d4 treat a schema-rejected memo23 call as "no
    // candidates" and walk on to a job board.
    //
    // ── AND NOTHING CLOSES ON NOTHING WHILE ITS INPUTS ARE STILL COMING ────
    //
    // The clause above asks whether the capability succeeded. It cannot ask
    // whether success was possible YET. On task 5c461aa3 `persistence` — the
    // last node — closed having saved nothing while identity resolution,
    // hiring verification and qualification were all still pending, and the
    // engine skips a completed capability forever after. Six companies with
    // real sales openings could never have been written down.
    //
    // `completionIsProvisional` reads the answer off the plan: a node that
    // produced zero rows stays pending while anything ordered before it is
    // unfinished. A node that produced something keeps its completion — see
    // the module header for why reopening paid work would be worse.
    const provisional = completionIsProvisional({
      capability, rows,
      planOrder: opts.plan.steps.map((s) => s.capability),
      pendingCapabilities: state.pending_capabilities,
    });
    if (provisional) {
      log("capability_completion_provisional", {
        capability, rows, still_pending: [...state.pending_capabilities],
      });
    }
    const genuinelyComplete = !provisional &&
      ((status === "complete" && evidence === true) || status === "skipped_resumed");
    if (genuinelyComplete && !state.completed_capabilities.includes(capability)) {
      state.completed_capabilities.push(capability);
    }
    if (genuinelyComplete) {
      state.pending_capabilities = state.pending_capabilities.filter((c) => c !== capability);
    }
    state.current_capability = null;
  };

  /** Investigation passes taken. One per slice; bounded by the yield gate. */
  let investigationPass = 1;

  // ── THE CHAIN, PLANNED ONCE, BEFORE ANYTHING IS SPENT ────────────────────
  //
  // `buildCapabilityGraph` decided the stage list from mission fields BEFORE any
  // Actor had been chosen — so the decision "does this run need a paid hiring
  // check?" was made by code that could not know what the discovery Actor would
  // return. A source carrying embedded `openJobs` makes that step redundant; one
  // that does not makes it essential, and nothing could express the difference.
  //
  // The chain does not widen what is reachable. `validateExecutionPlan` refuses
  // any capability the mission did not authorise and any Actor the capability
  // does not declare, so this decides how to move through the graph, never what
  // the graph contains.
  let executionPlan: ExecutionPlan | null = null;
  if (deps.planExecution) {
    try {
      const payload = buildExecutionPlannerPayload(opts.mission, opts.plan, { brain: opts.brain, readiness: guardPolicy });
      const hash = await missionHash(opts.mission);
      const stepsOf = (proposed: unknown) =>
        Array.isArray(proposed)
          ? proposed
          : (proposed as { steps?: unknown } | null)?.steps;

      // ── A CONTINUATION DOES NOT RE-BUY THE PLAN ────────────────────────
      //
      // Every slice used to ask the model to plan the whole chain again, from
      // scratch, at ~16k tokens a call. Run 9105aa67's continuation did that
      // and was rejected for exceeding 30,000 tokens per minute — so the run
      // died not because anything was wrong with it, but because it paid twice
      // for a decision it had already made and written down.
      //
      // The stored plan is re-VALIDATED, never merely trusted. Containment is
      // not a property of where a plan came from; a restored plan is checked
      // against this mission's authorised capabilities and each capability's
      // own actors exactly as a fresh one is. That check is pure and free.
      //
      // Reuse requires the mission hash to match — a state from a different
      // question is a different plan — and every step to carry its `input`,
      // because a checkpoint written before inputs were persisted holds only
      // half the decision, and half a decision is not one to resume from.
      const stored = reusableStoredPlan(state, hash);
      if (stored) {
        const restored = validateExecutionPlan(stored, opts.mission, opts.plan);
        // CLEANLY, OR NOT AT ALL. Not `source !== "blocked"`: a violation that
        // DROPS one step leaves the plan validated and shorter, and reusing
        // that would silently run a different chain from the one the
        // checkpoint recorded. Any violation at all means the stored plan no
        // longer means what it said, and the model should plan against what is
        // true now.
        if (restored.violations.length === 0) {
          executionPlan = restored;
          log("execution_plan_reused_from_checkpoint", {
            steps: restored.steps.map((s) => `${s.capability}:${s.actor_key ?? "-"}`),
            source: restored.source,
          });
        } else {
          // The mission or the graph moved under the stored plan. Say so, then
          // plan again — this is not a case for running a refused chain.
          log("execution_plan_checkpoint_rejected", {
            violations: restored.violations.map((v) => v.code),
          });
        }
      }

      // The refused proposal's OWN reasoning is kept for the repair log: an
      // empty first plan logged only as `no_valid_step` said nothing about why
      // the model declined, and three canaries paid a repair before anyone
      // could see it was answering a contradiction in its own payload.
      let firstReasoning: string | null = null;
      const first = executionPlan ?? validateExecutionPlan(
        stepsOf(await (async () => {
          const proposed = await deps.planExecution!({ payload, mission_hash: hash });
          const r = (proposed as { reasoning?: unknown } | null)?.reasoning;
          firstReasoning = typeof r === "string" ? r.slice(0, 1200) : null;
          return proposed;
        })()),
        opts.mission, opts.plan);

      // ONE REPAIR ROUND, for the same reason discovery gets one: a refusal the
      // model is TOLD about is a plan it can fix, and a refusal it never hears
      // is just a dead run.
      if (first.source !== "blocked") {
        executionPlan = first;
      } else {
        const blocking = first.violations.filter((v) => v.severity === "block");
        // THE MESSAGE, NOT ONLY THE CODE. `no_valid_step` on its own says a
        // plan was refused and nothing about why; the message now carries the
        // proposed steps and the reasons each was dropped, and a log that
        // prints only codes throws that away again.
        log("execution_plan_repair_attempt", {
          violations: blocking.map((v) => ({ code: v.code, actor_key: v.actor_key, message: v.message })),
          first_reasoning: firstReasoning,
        });
        const repaired = validateExecutionPlan(
          stepsOf(await deps.planExecution({
            payload, mission_hash: hash,
            validation_feedback: blocking.map((v) => ({
              code: v.code, message: v.message, actor_key: v.actor_key,
            })),
          })),
          opts.mission, opts.plan);
        if (repaired.source === "blocked") {
          // ── A WIRED PLANNER THAT CANNOT PLAN STOPS THE RUN ──────────────
          //
          // This set `executionPlan = null` and carried on into the graph's own
          // order. That is the exact shape of the defect this whole architecture
          // was rebuilt to remove: a model that was SUPPOSED to decide, did not,
          // and the run proceeded anyway on a decision nobody made — which from
          // the outside is indistinguishable from a plan the model chose.
          //
          // An ABSENT planner is a different fact and still falls through to the
          // graph (see the note on `planExecution`). A planner that is present,
          // was asked twice, and produced nothing usable is a failure, and the
          // honest answer to a failure is to say so before spending.
          state.terminal_reason = "execution_plan_blocked";
          state.fallback_reason = repaired.violations[0]?.code ?? "execution_plan_blocked";
          log("execution_plan_blocked", {
            first: blocking.map((v) => ({ code: v.code, actor_key: v.actor_key, message: v.message })),
            second: repaired.violations.filter((v) => v.severity === "block")
              .map((v) => ({ code: v.code, actor_key: v.actor_key, message: v.message })),
            // What the planner was ALLOWED to use. An empty plan against a
            // non-empty authorisation is the model judging every actor unfit,
            // which is a mission problem, not a planner problem.
            authorised_capabilities: opts.plan.steps.map((st) => st.capability),
          });
          throw new ExecutionPlanBlockedError(repaired.violations);
        }
        executionPlan = repaired;
        log("execution_plan_repaired", {
          first: blocking.map((v) => v.code),
        });
      }
    } catch (e) {
      // The refusal above is deliberate and must not be swallowed by the guard
      // that catches provider trouble.
      if (e instanceof ExecutionPlanBlockedError) throw e;
      // A THROWN PLANNER — a timeout, a transport error — is the same fact as a
      // planner that answered unusably: it was asked and did not decide.
      state.terminal_reason = "execution_plan_blocked";
      state.fallback_reason = "execution_planner_failed";
      log("execution_planner_failed", { error: String(e) });
      throw new ExecutionPlanBlockedError([{
        code: "execution_planner_failed",
        message: `the execution planner failed: ${String(e).slice(0, 300)}`,
        severity: "block",
      }]);
    }
  }
  state.execution_plan = executionPlan
    ? {
      version: executionPlan.version,
      source: executionPlan.source,
      reasoning: executionPlan.reasoning,
      steps: executionPlan.steps.map((s) => ({
        step: s.step, capability: s.capability, actor_key: s.actor_key,
        purpose: s.purpose, depends_on: s.depends_on,
        // ── THE INPUT TRAVELS WITH THE STEP ──────────────────────────────
        //
        // Dropped until now, which made the persisted plan a description of a
        // decision rather than the decision itself: a continuation could read
        // back which Actor to run but not what to ask it. That is why every
        // slice re-bought the plan from the model, and re-buying it is what
        // put run 9105aa67 over its token-per-minute limit. Already validated
        // against the Actor's own `supported_filters`, so nothing unchecked is
        // being stored.
        input: s.input,
      })),
      violations: executionPlan.violations.map((v) => v.code),
    }
    : null;
  if (executionPlan) {
    log("execution_plan_resolved", {
      steps: executionPlan.steps.map((s) => `${s.capability}:${s.actor_key ?? "-"}`),
      source: executionPlan.source,
    });
  }

  // ── P2: RETRIEVAL PLAN v1, BUILT ONCE PER LINEAGE ───────────────────────────
  if (specOn && criteriaPolicy && !currentPlan()) {
    const plan = buildRetrievalPlan({
      mission: opts.mission, mission_hash: p2MissionHash, graph: opts.plan,
      execution_plan: executionPlan, policy: criteriaPolicy, ceilings: state.spend_ledger!.ceilings,
      readiness: routePolicy,
    });
    state.retrieval_plans!.push(plan);
    appendTrace(state.mission_trace!, "retrieval_plan_created", {
      content_hash: plan.content_hash, anchor: plan.anchors.primary,
      routes: plan.routes.map((r) => ({ route_id: r.route_id, refused: r.refused, terms: r.query_families[0]?.terms ?? [] })),
      stages: plan.stages.map((st) => st.stage_id),
    }, { plan_version: plan.version });
    log("retrieval_plan_created", { version: plan.version, routes: plan.routes.length, stages: plan.stages.length });
  }
  /**
   * P2 — the only way a plan changes. Returns true when the change may apply
   * (accepted, or identical in content); false when it was refused.
   */
  const p2AcceptAmendment = (
    amendedPlan: ExecutionPlan | null, trigger: AmendmentTrigger,
    newRoutes: Array<{ capability: string; provider: string; input: Record<string, unknown> }> = [],
    ctx: {
      /** Admitted candidates still waiting for a stage. */
      availableAdmitted: number;
      /**
       * Discovery already ran: the amendment may change stages, never the
       * discovery routes. Canary 2bd8b267/6000f9a9 — a post-discovery amendment
       * rewrote the memo23 input, so every later slice bought discovery again.
       */
      keepRoutes?: boolean;
    },
  ): boolean => {
    if (!specOn || !criteriaPolicy) return true;
    const current = currentPlan();
    if (!current) return true;
    // A CONTINUATION HOLDS ITS PLAN while the pool it bought is unspent. The
    // same canary amended v4 → v7 across four slices, each buying discovery
    // and none reaching a verdict: "insufficient" was read before the pool was
    // worked. Broadening a resumed run needs the pool exhausted first.
    const held = continuationAmendmentRefusal({
      resumed_onto_plan: resumedOntoPlan, trigger, available_admitted: ctx.availableAdmitted, plan_version: current.version,
    });
    if (held) {
      appendTrace(state.mission_trace!, "amendment_refused", {
        reason: held.reason, trigger, available_admitted: ctx.availableAdmitted, detail: held.detail,
      }, { plan_version: current.version });
      log("retrieval_plan_amendment_refused", { reason: "continuation_holds_plan", trigger, available: ctx.availableAdmitted });
      return false;
    }
    if (ctx.keepRoutes && amendedPlan) {
      const routeInput = new Map(current.routes
        .filter((r) => r.proposed_input && r.query_families[0]?.purpose !== "adjacent")
        .map((r) => [`${r.capability}|${r.provider}`, r.proposed_input!]));
      amendedPlan = {
        ...amendedPlan,
        steps: amendedPlan.steps.map((st) => {
          const held = routeInput.get(`${st.capability}|${st.actor_key}`);
          return held ? { ...st, input: held } : st;
        }),
      } as ExecutionPlan;
    }
    const priorAdjacent = current.routes
      .filter((r) => r.query_families[0]?.purpose === "adjacent" && r.proposed_input)
      .map((r) => ({ capability: r.capability, provider: r.provider, input: r.proposed_input!, purpose: "adjacent" as const }));
    const decision = amendRetrievalPlan(current, {
      build: {
        mission: opts.mission, mission_hash: p2MissionHash, graph: opts.plan,
        execution_plan: amendedPlan, policy: criteriaPolicy, ceilings: current.ceilings,
        extra_routes: [...priorAdjacent, ...newRoutes.map((r) => ({ ...r, purpose: "adjacent" as const }))],
        readiness: routePolicy,
      },
      trigger, component: "retrieval_controller",
      rationale: amendedPlan?.reasoning ?? "discovery replan",
      reserve_remaining_usd: adaptiveReserveRemaining(),
    });
    if (!decision.accepted) {
      if (decision.reason === "no_change") return true;
      appendTrace(state.mission_trace!, "amendment_refused", {
        reason: decision.reason, detail: decision.detail, trigger,
        changes: decision.changes.slice(0, 20),
      }, { plan_version: current.version });
      log("retrieval_plan_amendment_refused", { reason: decision.reason, trigger, detail: decision.detail });
      return false;
    }
    state.retrieval_plans!.push(decision.plan);
    appendTrace(state.mission_trace!, "retrieval_plan_amended", {
      trigger, content_hash: decision.plan.content_hash, changes: decision.changes.slice(0, 20),
    }, { plan_version: decision.plan.version });
    log("retrieval_plan_amended", { version: decision.plan.version, trigger, changes: decision.changes.length });
    return true;
  };

  /**
   * Did the CHAIN deselect this capability?
   *
   * Only ever consulted for stages the graph marks optional. A chain that omits
   * `hiring_verification` because its discovery Actor already returns open roles
   * is making the decision this planner exists to make; a chain that omits
   * identity resolution is not offering an opinion the engine should take, and
   * `OPTIONAL_BY_CHAIN` is what keeps that distinction explicit.
   */
  const chainSkips = (cap: CapabilityId): boolean =>
    !!executionPlan && OPTIONAL_BY_CHAIN.has(cap) &&
    !capabilityIsPlanned(executionPlan, cap);

  // ── A SLICE THAT ALREADY OWES BRAIN DECISIONS PAYS THAT DEBT FIRST ───────
  //
  // ── THE RUN THIS EXISTS FOR ──────────────────────────────────────────────
  //
  // Task 3417c428, slice at 11:06:56. Four companies — investigated, enriched,
  // hiring-verified, each carrying its assessment, jobs and evaluation — needed
  // one Brain call apiece. The slice spent 145 of its 147 seconds elsewhere:
  //
  //     +  0.0s  capability_reopened  company_enrichment   (4 outstanding)
  //     + 11.4s  company_enrichment_complete
  //     + 11.8s  capability_reopened  hiring_verification
  //     + 11.9s  job search          + 42.3s  job search   + 63.0s  job search
  //     +145.5s  hiring_verification_complete
  //     +145.9s  qualification_deadline_stop { not_reached: 4, remaining_ms: 0 }
  //
  // `capabilityStillOwed` reopened enrichment and hiring for OTHER companies,
  // correctly — but the chain is walked in order, so four companies that needed
  // no provider work at all sat behind three job searches. The next slice did
  // the same, and the one after that, until `MAX_BARREN_SLICES` stopped a run
  // whose best candidates were one model call from a verdict.
  //
  // ── WHY REORDERING AND NOT A SCHEDULER ───────────────────────────────────
  //
  // The debt is already expressible: `capabilityStillOwed` is the same
  // predicate that reopened the other two stages, and it reads the same durable
  // records. Nothing new is detected here and no state is added — only the
  // order in which an already-owed stage is visited.
  //
  // DISCOVERY STAYS FIRST. It is where `restoreWorkingSet` runs, so moving
  // qualification ahead of it would hand the Brain an empty pool. Qualification
  // moves to just after it, ahead of the stages that buy providers.
  //
  // FRESH MISSIONS ARE UNTOUCHED: with no resume records there is no debt, the
  // predicate is false, and the plan is walked exactly as written.
  const qualificationDebt = QUALIFICATION_PRIORITY_CAPABILITIES.some((c) =>
    capabilityStillOwed(c, opts.resume?.records ?? []));
  const orderedSteps = qualificationDebt
    ? [
      // Everything up to and including the stage that restores the pool.
      ...opts.plan.steps.filter((s) => WORKING_SET_CAPABILITIES.has(s.capability)),
      // Then the debt.
      ...opts.plan.steps.filter((s) =>
        QUALIFICATION_PRIORITY_CAPABILITIES.includes(s.capability)),
      // Then the rest, in the plan's own order.
      ...opts.plan.steps.filter((s) =>
        !WORKING_SET_CAPABILITIES.has(s.capability) &&
        !QUALIFICATION_PRIORITY_CAPABILITIES.includes(s.capability)),
    ]
    : opts.plan.steps;
  if (qualificationDebt) {
    log("qualification_debt_prioritised", {
      owed: (opts.resume?.records ?? []).filter((r) =>
        nextStageFor(r) === "brain").length,
      order: orderedSteps.map((s) => s.capability),
    });
  }

  for (let stepIndex = 0; stepIndex < orderedSteps.length; stepIndex++) {
    const step = orderedSteps[stepIndex];
    const cap = step.capability;

    // ── A COMPLETED CAPABILITY IS NOT NECESSARILY A FINISHED ONE ─────────
    //
    // `completed_capabilities` records that a stage RAN and reached its own end.
    // It does not record that every company reached a terminal state. Lineage
    // 862e81be, generation 21: every capability reported
    // `skipped_resumed / "completed in an earlier run"` with `pending: []`,
    // while ELEVEN of twenty-one resolved companies sat at
    // `hiring: evidence_unavailable` — the state Phase 3 created so they would
    // be asked again. `nextStageFor` routed all eleven to "hiring" and the stage
    // was skipped before it could look, so the run declared itself finished at
    // 4 of 5 leads with its only remaining candidates unexamined.
    //
    // Re-entering cannot re-buy: `shouldSkipProviderCall` is per company and per
    // operation key, so a search already paid for is refused at the call. This
    // stage-level skip was a coarser guard on top of a finer one that already
    // works, and being coarser is exactly how it stranded them.
    //
    // Discovery is deliberately not in `CAPABILITY_STAGE`, so it stays skipped:
    // it has no per-company frontier and re-running it re-pays for the Actor.
    const owedByCompanies = state.completed_capabilities.includes(cap) &&
      capabilityStillOwed(cap, companies.map(toResumeRecord));
    if (owedByCompanies) {
      log("capability_reopened_for_outstanding_companies", {
        capability: cap,
        outstanding: companies.map(toResumeRecord)
          .filter((r) => nextStageFor(r) === CAPABILITY_STAGE[cap]).length,
        note: "completed_capabilities said done; the working set disagrees",
      });
    }

    // ── THE ONE CAPABILITY A REPLENISHMENT DEBT MAY REOPEN ─────────────────
    //
    // Narrow on every axis, deliberately: only discovery, only when `run-agent`
    // saw the previous slice record `replenishment_required`, and only while
    // the pool it is being asked to widen is actually spent. Every other
    // completed capability stays skipped exactly as before.
    //
    // The frontier condition is enforced UPSTREAM, in
    // `decideAutoContinuation`: `replenishment_required` is only ever emitted
    // for `frontierRemaining <= 0`, so a debt cannot exist while candidates
    // remain to investigate. It is not re-checked here on purpose — deciding
    // the same thing in two places is how the two come to disagree.
    const replenishmentWanted =
      opts.discoveryReplenishment?.reason === "replenishment_required" &&
      DISCOVERY_REPLENISHABLE.has(cap) &&
      state.completed_capabilities.includes(cap);
    const replenishmentDebt = replenishmentWanted && !candidateBudgetSpent();
    if (replenishmentWanted && !replenishmentDebt) {
      log("discovery_not_reopened_candidate_budget_spent", {
        capability: cap, limit: discoveryRowAllowance(), bought: state.discovery_rows_bought ?? 0,
        note: "no further discovery purchase is possible this mission, so no slice plans one",
      });
    }
    if (replenishmentDebt) {
      log("discovery_reopened_for_replenishment", {
        capability: cap,
        sources_attempted: opts.discoveryReplenishment?.sources_attempted ?? [],
        pages_taken: opts.discoveryReplenishment?.pages_taken ?? {},
        note: "the previous slice exhausted its pool with quota unmet and " +
          "discovery routes remaining",
      });
      // ── THE POOL COMES BACK FIRST. REPLENISHMENT ADDS; IT NEVER REPLACES ──
      //
      // Reopening discovery skips the `skipped_resumed` branch below, and that
      // branch is the ONLY place the working set is restored from the
      // checkpoint. Without this the reopened discovery would run against an
      // empty `companies`, the new rows would make it non-empty, and every
      // later restore is guarded on `companies.length === 0` — so the entire
      // prior pool, with its triage verdicts, enrichment, hiring evidence and
      // Brain decisions, would be silently dropped and re-bought.
      //
      // So the restore happens here, before the reopen, exactly as it does in
      // the skip. Discovery then merges into a pool that already holds
      // everything the lineage knows, and `addCompany` deduplicates the overlap
      // the same way it does across actors.
      //
      // No investigation slice is taken here. The frontier is empty — that is
      // what `replenishment_required` means — and this slice's work is to widen
      // the pool, not to advance a cursor that has nothing left to advance
      // over.
      if (companies.length === 0 && resumeScope) {
        const restored = restoreWorkingSet(resumeScope.records);
        for (const c of restored) companies.push(c);
        log("working_set_restored_for_replenishment", {
          capability: cap,
          restored: restored.length,
          records: resumeScope.records.length,
          frontier: restored.filter(
            (c) => isFrontier(c.investigation_state)).length,
        });
      }
      // BACK ON THE LIST, so the normal path below runs it. Removed from
      // `completed_capabilities` because it is genuinely no longer complete:
      // the pool it produced has been spent and the mission still needs more.
      state.completed_capabilities =
        state.completed_capabilities.filter((c) => c !== cap);
      if (!state.pending_capabilities.includes(cap)) {
        state.pending_capabilities = [cap, ...state.pending_capabilities];
      }
    }

    // RESUME. A capability already completed is not re-paid for.
    if (state.completed_capabilities.includes(cap) && !owedByCompanies) {
      outcomes.push({
        capability: cap, status: "skipped_resumed", rows: 0, providers_used: [],
        evidence_satisfied: true, reason: "completed in an earlier run",
      });
      state.pending_capabilities = state.pending_capabilities.filter((c) => c !== cap);

      // ── SKIPPING DISCOVERY MUST NOT MEAN LOSING THE CANDIDATES ───────────
      //
      // Discovery is the only step that fills `companies`. Skipping it as
      // already-complete — the correct call, since re-running it re-pays for
      // the Actor — used to leave the working set EMPTY, so every downstream
      // stage looped over nothing and a continuation resumed exactly zero
      // candidates. The deferred identity candidates that the truncation fix
      // deliberately keeps alive could never actually be picked up.
      //
      // The checkpoint carries a snapshot per company for precisely this.
      if (WORKING_SET_CAPABILITIES.has(cap) && companies.length === 0 && resumeScope) {
        const restored = restoreWorkingSet(resumeScope.records);
        for (const c of restored) companies.push(c);
        // ── A CONTINUATION TAKES A FRESH SLICE ──────────────────────────
        //
        // THE FIX FOR THE FROZEN POOL. Selection used to live inside discovery,
        // which is what we just skipped — so a continuation restored the same
        // ten companies and did nothing for the other ninety, forever, while
        // the checkpoint kept reporting them pending.
        //
        // The ranking is restored with the working set, so this is the same
        // cheap cursor the first pass used. Nothing is re-triaged and nothing
        // is re-decided; the frontier simply advances.
        if (restored.some((c) => isFrontier(c.investigation_state))) {
          takeInvestigationSlice(companies, 1);
        }
        log("working_set_restored_from_checkpoint", {
          capability: cap,
          restored: restored.length,
          records: resumeScope.records.length,
          shortlisted: restored.filter((c) => c.shortlisted).length,
          frontier: restored.filter(
            (c) => isFrontier(c.investigation_state)).length,
          // Zero restored from a non-empty ledger means the checkpoint predates
          // the snapshot field — worth seeing, and not an error.
          snapshots_missing: resumeScope.records.filter((r) => !r.snapshot).length,
        });
      }
      continue;
    }
    state.current_capability = cap;
    // Applied before every capability, not once after discovery: companies are
    // added by more than one provider, and a restore that ran too early would
    // miss the ones added last.
    if (resumeScope) for (const c of companies) restoreFromResume(c);

    // ── DISCOVERY ────────────────────────────────────────────────────────────
    //
    // ONE DISCOVERY STAGE, SHARED BY EVERY DISCOVERY CAPABILITY.
    //
    // This branch read `cap === "startup_company_discovery"`, and it was the
    // only place `resolveDiscoveryStrategy()` was called. That single condition
    // was the whole of the 2026-08-18 failure: `general_company_discovery` had
    // its own branch 300 lines below with a HARDCODED provider and a
    // deterministic query compiler, so a mission routed there never reached the
    // planner, the closed catalog, `not_for`, the repair round or the briefing.
    // Every guarantee this architecture spent five commits building was
    // attached to a capability the router had just steered away from.
    //
    // The capability now decides WHAT KIND of discovery this is — which the
    // graph is the right authority for — and this stage decides HOW, the same
    // way, for all of them. A discovery capability added later inherits the
    // planner, the validator and the refusal path without anyone remembering to
    // wire them, which is the same reasoning that made `ensureMissionIntelligence`
    // a demand of the paid stages rather than an offer from one branch.
    if (ENGINE_DRIVEN_DISCOVERY.has(cap)) {
      const used: string[] = [];
      const tried: string[] = [];
      /** Raw provider rows, kept for the FREE prequalification pass below. */
      const rawYcRows: YcCompanyInput[] = [];
      /**
       * Funding evidence collected during discovery, one entry per proven round.
       *
       * Only rows that passed `is_evidence` reach this list, so its length is a
       * count of PROVEN funding events and never of candidates that merely came
       * from a funding search.
       */
      const fundingRounds: NormalizedFundingRound[] = [];
      /** Set the moment any provider's input fails validation. */
      let schemaFailure = false;
      /** Set when a provider started a real run that has not finished. */
      let runPending = false;
      const pendingFor = (provider: string) =>
        state.provider_attempts.some(
          (a) => a.capability === cap && a.provider === provider && a.outcome === "pending");
      const compileFailedFor = (provider: string) =>
        state.provider_attempts.some(
          (a) => a.capability === cap && a.provider === provider && a.outcome === "compile_failed");
      // ── WHICH ACTORS, AND WHAT EACH IS ASKED ────────────────────────────────
      //
      // Was `step.providers`: a frozen pair, memo23 then solidcode, with the
      // input written as a literal right here — `industries: ["B2B"]`,
      // `batch: ["All Batches"]`. Every mission this workflow ever ran asked
      // that same question, so "AI startups hiring software engineers" and
      // "manufacturers adopting automation" both fetched the same YC page and
      // left qualification to discard the mismatch. A gate cannot qualify a
      // company the pool never contained.
      //
      // Now the request itself decides. `planDiscovery` proposes actors and
      // inputs; `validateDiscoveryStrategy` keeps only what the closed catalog
      // permits.
      //
      // AND THERE IS NO LONGER ANYWHERE ELSE TO LAND. With no selector, a
      // selector that throws, or a proposal that survives no validation, the
      // strategy comes back `blocked` and this run stops. The old code reached
      // the literal above in all three cases, which is why a model outage, a
      // missing credential and a genuinely-chosen YC search were
      // indistinguishable from the outside.
      // ── THE CHAIN'S OWN DISCOVERY STEPS, WHEN IT PLANNED ANY ─────────────
      //
      // A planned chain has ALREADY chosen the Actors for this capability, with
      // the whole job in view — including which later stages its choice makes
      // unnecessary. Asking `planDiscovery` again would be a second, narrower
      // opinion about the same decision, and two authorities on one question is
      // the duplication this architecture keeps deleting. Worse, the narrower
      // one cannot see the chain, so it could pick a source that silently
      // invalidates a step the chain planned around.
      //
      // The chain's steps go through `validateDiscoveryStrategy` exactly as a
      // single-stage proposal would: same catalog, same `not_for`, same cohort
      // rule, same limits. Nothing is trusted because it arrived by a longer
      // route.
      const plannedHere = plannedActorsFor(executionPlan, cap);
      const strategy = plannedHere.length > 0
        ? validateDiscoveryStrategy(
          plannedHere.map((s, i) => ({
            actor_key: s.actor_key,
            // The chain's ORDER is its role: the step it planned first is the
            // one that must run.
            role: i === 0 ? "primary" : "breadth",
            input: s.input,
            rationale: s.purpose,
          })),
          opts.mission, discoveryLimits)
        : await resolveDiscoveryStrategy();
      if (plannedHere.length > 0) {
        log("discovery_actors_from_execution_plan", {
          actors: plannedHere.map((s) => s.actor_key),
          source: strategy.source,
          violations: strategy.violations.map((v) => v.code),
        });
      }
      const strategyKeys = [...strategyActorKeys(strategy)];
      state.discovery_strategy = discoveryStrategyDiagnostics(strategy);
      log("discovery_strategy_resolved", state.discovery_strategy);

      if (strategy.source === "blocked") {
        // Recorded BEFORE throwing, so the refusal is inspectable on the task
        // row rather than only in a log line — the Commit 1 lesson.
        state.fallback_reason = strategy.violations[0]?.code ?? "discovery_blocked";
        throw new DiscoveryStrategyBlockedError(strategy.violations);
      }

      // ── WHICH REQUIRED SIGNALS THIS RUN CAN ACTUALLY ANSWER ─────────────────
      //
      // The mission records what evidence the request needs; the scenario matrix
      // knows which Actors produce it. Nothing joined them, so a mission asking
      // for companies that are hiring AND raised recently would discover
      // companies, qualify them on hiring, and report success having never asked
      // a funding source anything. The requirement sat in the persisted result,
      // visible and silently unserved.
      //
      // Recorded, not enforced. A signal with no source is not a reason to
      // refuse the whole mission — most of such a request is still answerable,
      // and refusing it would be worse than answering the part that works and
      // saying which part did not. This is what makes the run's ending honest:
      // "no more candidates" and "no source could ever have answered this" are
      // different results, and the user is owed the difference.
      const coverage = coverMissionSignals(opts.mission);
      state.signal_coverage = coverageDiagnostics(coverage);
      // ── MULTI-SIGNAL EXECUTION ──────────────────────────────────────────────
      //
      // A signal whose source this capability can call, and which the strategy
      // does NOT already serve, is added to the run — so a request needing two
      // kinds of evidence actually asks for both.
      //
      // ORDER MATTERS HERE, and getting it wrong is expensive. The first version
      // added every runnable Actor a signal named. But a hiring scenario names
      // the discovery sources too — discovery is how you find the company the
      // role belongs to — so it re-added company search on top of a strategy
      // that had deliberately declined it, overrode the strategy's own cost
      // decision, and broke the guarantee that a resumed run costs strictly less
      // than the first. A signal already served needs nothing added.
      //
      // Bounded by the same containment rule as everything else: the Actor must
      // be declared by THIS capability or it is not added. One the registry
      // describes but no capability declares stays in `described_only` and is
      // reported, never quietly called.
      let unserved = signalsUnservedByStrategy(coverage, strategyKeys);
      if (unserved.length > 0) {
        const declaredHere = new Set(step.providers as readonly string[]);
        const wanted = dedupeKeys(
          unserved.flatMap((sig) => sig.actors.map((a) => toRepoKey(a)))
            .filter((k): k is string => k !== null));
        for (const key of wanted) {
          if (strategyKeys.includes(key)) continue;
          if (!declaredHere.has(key)) continue;
          const card = hiringActorCard(key);
          if (!card) continue;
          strategy.selections.push({
            actor_key: key,
            // BREADTH, NOT PRIMARY. A signal source earns its call from the pool
            // the primary produced; making it primary would let a job source
            // open a mission with no companies to ask about.
            role: "breadth",
            input: {},
            rationale: "required by a mission signal the strategy left unserved",
            dropped_filters: [],
            requires_enrichment: card.requires_enrichment_before_qualification,
          });
          strategyKeys.push(key);
          log("signal_actor_added_to_run", { actor_key: key });
        }
        // Recomputed against what the run will now actually do.
        unserved = signalsUnservedByStrategy(coverage, strategyKeys);
      }
      if (unserved.length > 0) {
        log("signals_not_served_by_discovery", {
          signals: unserved.map((s) => s.signal),
          // A later stage may still prove these during enrichment, which is why
          // this is a log line and not a refusal.
          needed_actors: unserved.flatMap((s) => s.actors),
        });
      }
      if (coverage.described_only.length > 0) {
        // KNOWN BUT NOT CALLABLE. The registry describes these; no capability
        // declares them. Recorded so a run that needed funding evidence and
        // never asked for it cannot look like a run that asked and found none.
        log("signal_actors_not_declared_by_capability", {
          store_ids: coverage.described_only,
        });
      }
      if (!coverage.fully_covered) {
        log("signal_coverage_shortfall", { statement: coverage.shortfall_statement });
      }

      // ── WHAT "ENOUGH" MEANS, AND WHY IT IS NO LONGER A ROW COUNT ─────────
      //
      // Discovery used to finish when `companies.length` reached
      // `maxCandidates`. That number says how much a provider RETURNED, never
      // how much of it this mission can use, and the two came apart badly on
      // run 7e71d8bc: fifty LinkedIn rows, sixteen outside the mission's own
      // 20–200 employee range, discovery declared complete, zero qualified.
      //
      // Worse, it made the roles inert. `shouldRunSelection` gives `breadth` a
      // pool that is not yet big enough and `fallback` an empty one — but it
      // was handed the row count, so a pool of fifty unusable rows read as full
      // and no second source could ever earn its call.
      //
      // `admittedCandidateCount` is the SAME free pass the engine already runs
      // later, not a new gate. Bounds come from the mission and only the
      // mission: `size_enforceable` is false when the user expressed no range,
      // so a missionless run keeps its old behaviour of never rejecting on
      // size. Geography is not consulted — presence semantics are unchanged.
      const missionEmployeeRange = opts.mission?.company_profile?.employee_range;
      const admissionBounds = {
        min: missionEmployeeRange?.min ?? null,
        max: missionEmployeeRange?.max ?? null,
      };
      const admissionEnforceable =
        admissionBounds.min != null || admissionBounds.max != null;
      /**
       * How many rows in the pool this mission could actually continue with.
       *
       * Recomputed rather than accumulated. The pool is bounded by
       * `maxCandidates` and the pass is pure arithmetic over fields already in
       * memory, so recomputing is cheap; accumulating would mean keeping a
       * second running total in step with a list that is appended to from five
       * different provider branches, which is precisely the kind of bookkeeping
       * that drifts.
       */
      const admittedNow = (): number =>
        admittedCandidateCount(
          companies.map((c) => c.company),
          admissionBounds,
          { size_enforceable: admissionEnforceable },
        );

      // ── ADMITTED IS A LIFETIME COUNT. DISCOVERY NEEDS AN AVAILABLE ONE ───
      //
      // ── THE RUN THIS EXISTS FOR ──────────────────────────────────────────
      //
      // Task 74de044e, 2026-09-01. Its frontier emptied with 0 of 5 qualified,
      // `replenishment_required` fired correctly, discovery reopened — and then
      // bought nothing, six times over. The restored pool held 34 lifetime
      // admitted companies against a target of 20, so the very first guard in
      // `executeSelections` broke before a single call. Twenty-one of those 34
      // had already been investigated and settled; they could not satisfy any
      // further downstream work, and counting them said the pool was full when
      // nothing in it was left to do.
      //
      // So the target is measured against candidates that can still DO
      // something, and `admittedNow` is kept for the record.
      //
      // ── WHY THESE TWO PREDICATES AND NOT A NEW COMPANY STATE ─────────────
      //
      // Both already exist and both are already authoritative:
      //
      //   `excluded_permanently` — "closed by a decision": a deterministic
      //   mission constraint (a GPT `irrelevant` no longer closes anyone — it
      //   ranks; see `buildSmartShortlist`). `isUnfinishedFrontier` refuses to re-queue
      //   one for exactly this reason: it was a DECISION, not a deferral.
      //
      //   `nextStageFor` — the stage machine every resumed slice already routes
      //   on. It returns null when identity is terminal, enrichment failed, or
      //   the Brain has decided, which is the same question asked here: does
      //   this company still owe a stage?
      //
      // Nothing new is invented, and a company is available only if BOTH agree.
      const availableAdmittedNow = (skip?: (c: EngineCompany) => boolean): number => {
        const scored = prequalifyDiscoveredCompanies(
          companies.map((c) => c.company),
          admissionBounds,
          { size_enforceable: admissionEnforceable },
        );
        const admittedKeys = new Set(
          scored.companies.filter((p) => isAdmitted(p, { size_enforceable: admissionEnforceable }))
            .map((p) => p.company_key),
        );
        // ── LEAD V2: "STILL OWES A STAGE" IS NOT "CAN STILL QUALIFY" ─────────
        //
        // Production canary 98ce374b (2026-10-03). Ten companies investigated;
        // the canonical view held one ineligible and nine PENDING, each with a
        // hard claim no route could close (funding answered by both providers
        // with nothing decisive, or first-party pages already read). The
        // verifier phase rightly bought nothing more for them, and the
        // continuation rightly asked for `replenishment_required`. But every
        // one still read `hiring: evidence_unavailable` — the job stage defers
        // a HARD hiring claim to the post-eligibility verifier — so
        // `nextStageFor` said each still owed a stage, this count said 10 of 8,
        // the page-2 search was proposed and never bought, and two barren
        // slices ended the lineage `no_progress` → `search_exhausted` with
        // discovery open and $1.75 of budget unspent.
        //
        // Under Lead V2 the canonical decision is the authority, so it decides
        // here too: a company counts only while it is undecided (not yet
        // investigated / identity open) or PENDING with every unknown hard
        // claim still routable — `canStillQualify`, the ONE viability rule the
        // verifier phase and `with_executable_route` already read.
        const workable = specOn ? canonicallyWorkableKeys(companies, opts) : null;
        let n = 0;
        for (const c of companies) {
          // The prequalifier's own key, never a lookalike — the invariant
          // `prequalifyDiscoveredCompanies` throws on rather than tolerate.
          if (!admittedKeys.has(genericPrequalificationKey(c.company))) continue;
          if (c.investigation_state === "excluded_permanently") continue;
          if (nextStageFor(toResumeRecord(c)) === null) continue;
          if (workable && !workable.has(c.key)) continue;
          if (skip?.(c)) continue;
          n++;
        }
        return n;
      };
      // ── UNDER THE FUNDING SCREEN, "ENOUGH" MEANS ENOUGH FRESH ────────────
      //
      // A company this workspace funding-checked recently is admitted by the
      // free pass but will be closed by the screen before any spend, so it is
      // not a candidate this run can use. Counting it made a page of repeats
      // look full (canary 16699a45: 2 of 5 rows were recently checked).
      // Placeholders and duplicates are already outside `availableAdmittedNow`.
      const screenRecent = new Set([...(opts.fundingScreen?.recentlyChecked ?? [])]
        .map((u) => atomusInput(u)).filter((u): u is string => !!u));
      const freshAvailableNow = (): number => availableAdmittedNow((c) => {
        const page = atomusInput(c.identity?.linkedin_company_url ?? c.company.linkedin_company_url ?? null);
        return !!page && screenRecent.has(page);
      });

      // ── HOW MANY ADMITTED CANDIDATES THIS SLICE ACTUALLY NEEDS ───────────
      //
      // Deterministic, and deliberately NOT `maxCandidates`. See
      // `ADMITTED_PER_OWED_LEAD` for why the raw-row allowance is the wrong
      // scale for this question.
      //
      // Clamped above by `maxCandidates` so the admitted target can never ask
      // for more usable companies than the run is allowed to hold rows for,
      // which would be a target no amount of paging could reach.
      const owedLeads = Math.max(
        1,
        opts.remainingLeads ?? effectiveRequestedCount(opts.mission),
      );
      /** Does the pool hold enough to stop discovering? The one rule both loops read. */
      const enoughCandidates = (): boolean => opts.fundingScreen
        ? freshAvailableNow() >= opts.fundingScreen.plan.fresh_target
        : availableAdmittedNow() >= admittedTarget;
      const admittedTarget = Math.min(
        maxCandidates,
        Math.max(MINIMUM_ADMITTED_TARGET, owedLeads * ADMITTED_PER_OWED_LEAD),
      );

      // ── PAGES ALREADY BOUGHT, ACROSS EVERY SLICE OF THIS LINEAGE ────────
      //
      // Seeded from the checkpoint, not from this invocation. `askedQuestions`
      // is in-memory and dies with the slice, so a reopened discovery that
      // trusted it would ask for page two again — adopted rather than
      // re-bought, so no money is lost, but the slice would spend its whole
      // budget re-reading rows the pool already holds and end no wider than it
      // started. That is the failure this restore exists to prevent.
      const pagesTaken: Record<string, number> = {
        ...(opts.discoveryReplenishment?.pages_taken ?? {}),
      };

      /**
       * DID THIS ACTOR ACTUALLY REACH THE PROVIDER ON THIS PAGE?
       *
       * ── WHY A PAGE CURSOR MAY NOT MOVE ON INTENT ────────────────────────
       *
       * Task 74de044e recorded `pages_taken: 7` for an actor that was called
       * exactly ONCE. The cursor was advanced where the page was CHOSEN, and
       * `executeSelections` then broke on its first guard without buying
       * anything — so the number described what the engine had considered
       * asking, not what it had asked. A checkpoint carrying that number tells
       * the next slice to resume at page 8 of an index it has read one page of.
       *
       * `pages_taken: N` must mean provider operations exist through page N.
       * These are the outcomes that make that true: a call that ran, a call
       * that ran and returned nothing, and a call whose answer was already
       * bought and adopted. Everything else — refused on credit, refused on
       * deadline, compile failure, still pending — leaves the cursor alone,
       * because none of them produced an operation for that page.
       */
      const PAGE_COMMITTING_OUTCOMES: ReadonlySet<string> = new Set([
        "ok", "empty", "rows_dropped",
        "skipped_idempotent", "skipped_resume_reuse", "run_adopted",
      ]);
      const attemptCountFor = (actorKey: string): number =>
        state.provider_attempts.filter((a) =>
          a.capability === cap && a.provider === actorKey &&
          PAGE_COMMITTING_OUTCOMES.has(String(a.outcome))).length;

      // ── ONE PASS OVER A SET OF SELECTIONS ────────────────────────────────
      //
      // Extracted from the loop it used to BE so that a second pass can reuse
      // it. Discovery was strictly one-shot: the planner chose, the engine ran
      // the choice, and whatever came back was the pool the rest of the run had
      // to live with. On 25f3ff57 that pool was 100 rows with zero hiring
      // evidence for a mission whose required evidence WAS hiring, and nothing
      // between discovery and the final count could say so.
      //
      // Nothing inside has changed. It is the same dispatch, the same guards and
      // the same break conditions; only its shape is different.
      // ── P4: EVERY WAVE IS SUMMARIZED; A ROUTE CHANGES ONLY BY AMENDMENT ────
      //
      // After a batch of selections runs, the wave is summarized per route —
      // rows, companies introduced vs re-found, identity coverage, the
      // deterministic hard gate, evidence gaps, settled cost, budget left —
      // and the route controller may propose a change. Code validates it
      // (`validateRouteControl`): a stop only reduces spend and leaves every
      // other route alone; an add/change/deepen needs a supported trigger, a
      // READY actor, budget room, and never happens on a worker continuation.
      let discoveryStoppedByControl = false;
      let routeControlCalls = 0;
      const MAX_ROUTE_CONTROL_CALLS = 2;
      const routeStoppedFor = (provider: string): boolean => {
        const routes = (currentPlan()?.routes ?? []).filter((r) => r.capability === cap && r.provider === provider);
        return routes.length > 0 && routes.every((r) => /^route_stopped/.test(r.refused ?? ""));
      };
      const requiredDims = requiredEvidenceDimensions(criteriaPolicy ?? null,
        (opts.mission.required_signals ?? []).map((sig) => String(sig.type)));
      const researchWave = async (): Promise<void> => {
        const plan = currentPlan();
        const scored = prequalifyDiscoveredCompanies(companies.map((c) => c.company), admissionBounds,
          { size_enforceable: admissionEnforceable });
        const verdictByKey = new Map(scored.companies.map((p) => [p.company_key, p.eligible]));
        const byProvider = new Map<string, RouteCallStat>();
        for (const a of state.provider_attempts) {
          if (a.capability !== cap) continue;
          const spec = [...(state.provider_call_specs ?? [])].reverse()
            .find((sp) => sp.capability === cap && sp.actor === a.provider);
          const st = byProvider.get(a.provider) ?? {
            route_id: spec?.route_id ?? null, capability: cap, actor_key: a.provider, calls: 0, rows: 0, exhausted: false,
          };
          if (a.outcome === "ok" || a.outcome === "empty") {
            st.calls++; st.rows += a.rows;
            st.exhausted = a.outcome === "empty" || a.rows === 0;
          }
          byProvider.set(a.provider, st);
        }
        const summary = summarizeResearchWave({
          wave: (state.research_waves?.length ?? 0) + 1, plan,
          companies: companies.filter((c) => (c.found_by ?? []).length > 0).map((c) => {
            const ids = entityIdentifiersOf(c);
            const known = new Set((c.observations ?? []).flatMap((o) => o.evidence)
              .filter((e) => e.status !== "unknown").map((e) => e.dimension));
            const v = verdictByKey.get(genericPrequalificationKey(c.company));
            return {
              key: c.key, found_by: c.found_by ?? [], has_linkedin_url: !!ids.linkedin_company_url,
              has_domain: ids.domains.length > 0, hard_pass: v === undefined ? null : v,
              gaps: requiredDims.filter((d) => !known.has(d)),
            };
          }),
          calls: [...byProvider.values()], ledger: state.spend_ledger ?? null,
          admitted: { available: availableAdmittedNow(), target: admittedTarget },
          adaptive_reserve_remaining_usd: adaptiveReserveRemaining(),
        });
        state.research_waves = [...(state.research_waves ?? []), summary].slice(-20);
        log("research_wave_summarized", {
          wave: summary.wave, routes: summary.routes.map((r) => `${r.actor_key}:${r.rows}/${r.new_companies}+${r.merged_into_existing}`),
          unique: summary.unique_companies, multi_source: summary.multi_source_companies,
          low_yield: summary.low_yield_routes, exhausted: summary.exhausted_routes,
        });
        if (state.mission_trace) {
          appendTrace(state.mission_trace, "research_wave_summarized", {
            wave: summary.wave, routes: summary.routes, unique_companies: summary.unique_companies,
            multi_source_companies: summary.multi_source_companies, identity: summary.identity,
            hard_constraints: summary.hard_constraints, admitted: summary.admitted, cost: summary.cost,
          }, { plan_version: plan?.version ?? null });
        }
        const undecided = summary.low_yield_routes.length > 0 || summary.exhausted_routes.length > 0 ||
          summary.admitted.available < summary.admitted.target;
        if (!deps.controlRoutes || !plan || !criteriaPolicy || !undecided || discoveryStoppedByControl ||
            routeControlCalls >= MAX_ROUTE_CONTROL_CALLS) return;
        // Every route-control action but `stop` buys more discovery, and a stop
        // saves nothing once the allowance is spent: no proposal can be acted on.
        if (candidateBudgetSpent()) {
          log("route_control_skipped_candidate_budget_spent", { wave: summary.wave });
          return;
        }
        routeControlCalls++;
        let proposal: unknown = null;
        try {
          proposal = await deps.controlRoutes({
            summary, mission: opts.mission, plan, capability: cap,
            ready_actors: ACTOR_READINESS.filter((r) => r.capability === cap && routePolicy.decide(r.actor, cap).executable).map((r) => r.actor),
          });
        } catch (e) {
          log("route_control_failed", { error: String(e).slice(0, 200) });
          return;
        }
        if (!proposal) return;
        const decision = validateRouteControl(proposal, {
          summary, plan, continuation: resumedOntoPlan,
          routeReady: (actor, capability) => capability === cap
            ? routeActorReady(actor, capability, routePolicy)
            : { ready: false, reason: `this discovery stage is ${cap}; ${capability} routes are added by their own stage` },
          estimateUsd: (actor, input) => {
            const card = hiringActorCard(actor);
            return card?.cost_model ? estimateCallUsd(actor, card.cost_model, input) : Number.POSITIVE_INFINITY;
          },
        });
        const recordControl = (accepted: boolean, reason: string | null, detail: string | null, newVersion: number | null) => {
          const rec: RouteControlRecord = {
            wave: summary.wave, plan_version: plan.version,
            proposal: proposal && typeof proposal === "object" ? JSON.parse(JSON.stringify(proposal)) : null,
            accepted, action: decision.action, reason, detail, new_plan_version: newVersion,
          };
          state.route_controls = [...(state.route_controls ?? []), rec].slice(-20);
          if (state.mission_trace) {
            appendTrace(state.mission_trace, "route_control_decided", rec as unknown as Record<string, unknown>,
              { plan_version: newVersion ?? plan.version });
          }
          log("route_control_decided", { action: rec.action, accepted, reason, new_plan_version: newVersion });
        };
        if (!decision.accepted) { recordControl(false, decision.reason, decision.detail, null); return; }
        if (decision.action === "continue") { recordControl(true, null, null, null); return; }
        if ("plan" in decision) {
          state.retrieval_plans!.push(decision.plan);
          if (state.mission_trace) {
            appendTrace(state.mission_trace, "retrieval_plan_amended", {
              trigger: decision.plan.amendment?.trigger, content_hash: decision.plan.content_hash,
              changes: decision.plan.amendment?.changes ?? [],
            }, { plan_version: decision.plan.version });
          }
          if (decision.action === "stop_discovery") discoveryStoppedByControl = true;
          recordControl(true, null, `stopped ${decision.stopped.join(", ")}`, decision.plan.version);
          return;
        }
        if (!("route" in decision)) return;
        const amended = p2AcceptAmendment(executionPlan, decision.trigger, [{
          capability: cap, provider: decision.route.actor_key, input: decision.route.input,
        }], { availableAdmitted: availableAdmittedNow() });
        const after = currentPlan();
        if (!amended || !after || after.version === plan.version) {
          recordControl(false, "amendment_refused", "the retrieval plan refused the route amendment", null);
          return;
        }
        recordControl(true, null, `${decision.action} ${decision.route.actor_key}`, after.version);
        await executeSelections([{
          actor_key: decision.route.actor_key, role: "breadth", input: decision.route.input,
          rationale: `route control (${decision.trigger}): ${decision.action}`, dropped_filters: [],
          requires_enrichment: hiringActorCard(decision.route.actor_key)?.requires_enrichment_before_qualification ?? false,
        }]);
      };

      const executeSelections = async (
        sels: readonly DiscoveryActorSelection[],
      ): Promise<void> => {
        for (const sel of sels) {
          const provider = sel.actor_key;
          if (schemaFailure) break;
          if (discoveryStoppedByControl) break;
          // ── CONTAINMENT IS CHECKED BEFORE THE CALL, NOT BY THROWING ──────
          //
          // A discovery REPLAN proposes actors from the closed catalog, which
          // is wider than this mission's capability graph: canary 849d6782 had
          // the replan propose memo23 for a job_discovery mission, and the only
          // thing that noticed was `guardedInvoker` — which throws, and an
          // unhandled CapabilityContainmentError ends the whole mission. The
          // graph is the boundary, so it is consulted here and the selection is
          // refused, exactly like any other policy refusal.
          if (!isProviderAllowedForCapability(opts.plan, provider, cap)) {
            tried.push(provider);
            state.provider_attempts.push({
              capability: cap, provider,
              attempt: state.provider_attempts.filter((a) => a.capability === cap && a.provider === provider).length + 1,
              outcome: "refused_policy", rows: 0, cost_units: 0,
              reason: `${provider} is outside this mission's capability graph for ${cap}`,
            });
            log("discovery_actor_outside_graph", { provider, capability: cap });
            continue;
          }
          // P4: a route stopped by an amendment stays stopped; its siblings run.
          if (routeStoppedFor(provider)) {
            tried.push(provider);
            log("discovery_route_stopped_skip", { provider });
            continue;
          }
          // A FALLBACK MUST NOT SPEND WHILE THE PRIMARY IS STILL RUNNING. The
          // primary may yet return everything the mission needs, and paying a
          // second source to answer a question already in flight is the waste this
          // whole gate exists to stop.
          if (runPending) break;
          // ADMITTED, NOT RETURNED. A pool of `maxCandidates` unusable rows is
          // not a finished pool, and this is the line that used to say it was.
          // The raw length still bounds spend below.
          if (enoughCandidates()) break;
          // AND A HARD CEILING ON WHAT MAY BE BOUGHT. Admission decides whether
          // the pool is good enough; this decides how much of it we will pay to
          // hold at all, so a source with a very low admission rate cannot page
          // forever. Without it the two counters disagree and the loop is
          // unbounded on the only axis that costs money.
          if (companies.length >= maxCandidates * MAX_RAW_ROWS_PER_ADMITTED) break;
          // ROLE DECIDES WHETHER THIS ONE EARNS ITS CALL. `fallback` runs only on
          // an empty pool — the old solidcode special-case, now the contract for
          // every actor that carries the role — and `breadth` stops widening a
          // pool that is already big enough to satisfy the request.
          //
          // Both now read the ADMITTED count, which is what makes either role
          // reachable: `breadth` widens a pool that returned rows but few usable
          // ones, and `fallback` fires when nothing usable came back at all.
          if (!shouldRunSelection(sel, availableAdmittedNow(), admittedTarget)) {
            tried.push(provider);
            continue;
          }
          tried.push(provider);
          used.push(provider);

          if (provider === "apify_yc_companies_memo23") {
            // ── THE INPUT IS THE MODEL'S, NOT A LITERAL WITH AN OVERRIDE ──────
            //
            // This block used to open with the answer already written:
            //
            //     queries: [], industries: opts.ycIndustries ?? ["B2B"],
            //     regions: ["United States of America"], isHiring: true,
            //     minEmployeeSize: "10+", maxEmployeeSize: "500",
            //
            // and `...sel.input` layered the model's choices ON TOP. That reads
            // like a safe default and is not: a model that says nothing about
            // industry silently searches B2B, and a model that is never asked —
            // which was every run before Commit 2 — searches B2B always. On
            // 2026-08-17 that is precisely what happened to "AI startups".
            //
            // Only `maxItems` remains as a pre-set, because it is a COST ceiling
            // rather than a search term: it bounds what the run may spend and is
            // clamped again by the validator against the actor's published limit.
            // Everything describing WHAT to look for now comes from `sel.input`.
            // ── A SIZE CEILING THE STRATEGY MAY NOT LIFT ─────────────────────
            //
            // Run 4250f181's third attempt widened `maxEmployeeSize` to "1000+"
            // for a seed-stage mission whose Company Brain capped size at 150,
            // and bought ten rows led by YC's largest graduates. The ceiling is
            // the smallest enum at or above the resolved bound, so no company
            // inside the bound is ever filtered out — only the drift past it.
            const sizeBound = resolveEmployeeBounds(qualificationCtx, {
              employee_min: opts.brain?.employee_min ?? null,
              employee_max: opts.brain?.employee_max ?? null,
            });
            const chosenMax = (sel.input as Record<string, unknown> | undefined)?.maxEmployeeSize;
            const maxEmployeeSize = clampMemo23MaxSize(chosenMax, memo23MaxSizeCeiling(sizeBound.max));
            if (maxEmployeeSize !== (chosenMax ?? null)) {
              log("discovery_size_clamped", {
                provider, chosen: chosenMax ?? null, clamped_to: maxEmployeeSize,
                bound: sizeBound.max, bound_source: sizeBound.source,
              });
            }
            const compiled = compileMemo23YcInput({
              maxItems: maxCandidates,
              // THE STRATEGY'S CHOICES, over the defaults above. Only fields this
              // Actor's schema accepts survive validation, so nothing here can be
              // a key memo23 does not have.
              ...sel.input,
              ...(maxEmployeeSize ? { maxEmployeeSize } : {}),
              // AND THESE ARE NOT THE STRATEGY'S TO CHOOSE.
              //
              // `scrapeOpenJobs` feeds the free prequalification pass, the hiring
              // signal and the job evidence three stages downstream; a selector
              // that turned it off to save time would silently remove the input
              // those stages are built on. `mode` anchors the row shape the
              // normalizer expects. `enrichEmails` is refused by the compiler and
              // forbidden by this architecture outright.
              mode: "companies" as const,
              scrapeOpenJobs: true,
              scrapeFounderDetails: false,
              enrichEmails: false,
            });
            // ── THE SAME QUESTION IS NOT ASKED TWICE IN ONE LINEAGE ──────────
            //
            // memo23 has no page cursor: the same queries, batches, regions,
            // role and industries return the top of the same result set, however
            // the size bounds are phrased. Run 4250f181's final slice asked
            // ["B2B SaaS","business software"] again — attempt 1's question with
            // a looser minimum size — and got attempt 1's ten companies back.
            // A NEW question (different queries, batches or industries) still
            // runs: that is adaptive sourcing, and it is untouched.
            const family = compiled.ok
              ? memo23QueryFamily((compiled as unknown as { input: Record<string, unknown> }).input)
              : null;
            if (family && (state.discovery_query_families ?? []).includes(family)) {
              state.provider_attempts.push({
                capability: cap, provider,
                attempt: state.provider_attempts
                  .filter((x) => x.capability === cap && x.provider === provider).length + 1,
                outcome: "skipped_repeat_query", rows: 0, cost_units: 0,
                reason: "this lineage already bought this discovery question; its rows are in the pool",
              });
              log("discovery_repeat_query_skipped", { provider, family });
              continue;
            }
            const familyRows = await callProvider(cap, provider, compiled);
            const lastAttempt = state.provider_attempts[state.provider_attempts.length - 1];
            if (family && lastAttempt?.provider === provider &&
                PAGE_COMMITTING_OUTCOMES.has(String(lastAttempt.outcome))) {
              state.discovery_query_families = [...(state.discovery_query_families ?? []), family];
            }
            for (const r of familyRows) {
              const c = normalizeMemo23Company(r);
              rawYcRows.push(r as YcCompanyInput);
              // The prequalification key is derived by the PREQUALIFICATION module
              // from the same raw row, so the shortlist and the working set cannot
              // drift apart.
              addCompany(companies, c, normalizeMemo23OpenJobs(r),
                prequalificationKey(r as YcCompanyInput), undefined, observedBy(cap, provider));
            }
          } else if (provider === "apify_yc_companies_solidcode") {
            // NOT CONFIGURED IS NOT INVALID INPUT.
            //
            // Reporting a missing fallback configuration as `compile_failed` made
            // the whole capability read `provider_input_validation_failed` on TEST
            // task 80501967-…-1b7db0ad46e7 — even though memo23's input was
            // perfectly valid and its run had started. A fallback nobody
            // configured is skipped, and says so.
            const bands = (sel.input.teamSize as string[] | undefined)
              ?? opts.solidcodeTeamSizes ?? [];
            if (bands.length === 0) {
              state.provider_attempts.push({
                capability: cap, provider, attempt: 1, outcome: "skipped_not_configured",
                rows: 0, cost_units: 0,
                reason: "no team-size bands configured; a bandless call duplicates memo23 at 2x price",
              });
              continue;
            }
            // The fan-out supplies `teamSize` once per band, so it must not also
            // appear on the base input the bands are spread over.
            const { teamSize: _bandsAreFannedOut, ...solidcodeBase } = sel.input;
            for (const compiled of fanOutSolidcodeTeamSizes(
              {
                regions: ["United States of America"], industries: ["B2B"],
                maxResults: maxCandidates,
                ...solidcodeBase,
                isHiring: true, includeJobs: true, includeFounders: false,
              },
              bands,
            )) {
              for (const r of await callProvider(cap, provider, compiled)) {
                addCompany(companies, normalizeSolidcodeCompany(r), [], null, undefined, observedBy(cap, provider));
              }
            }
          } else if (provider === "apify_linkedin_company_search") {
            // BREADTH BEYOND Y COMBINATOR — the reason this stage was rebuilt.
            //
            // This Actor matches company NAMES, not concepts, and reports a
            // concept query as a successful empty run, so the cost is real and
            // the failure silent. `compileHarvestCompanySearchInput` refuses the
            // unusable shapes; a selection with no query at all never reaches it.
            const query = typeof sel.input.searchQuery === "string"
              ? sel.input.searchQuery
              : null;

            // ── A NAME, OR STRUCTURED FILTERS. NEVER NEITHER. ───────────────
            //
            // This required a `searchQuery` and skipped otherwise, on the
            // recorded belief that "a query-less company search returns nothing
            // at full price". That belief was wrong, and it cost two live runs:
            // a concept mission had no usable non-YC source and died as
            // `no_valid_step` (tasks eeb02852, 58ada236).
            //
            // Run RidX3qBPdnjToMcqM settled it — `industryIds:["104"] +
            // locations:["United States"] + companySize:["11-50"]`, no
            // `searchQuery`, returned 5/5 genuine US staffing agencies out of
            // ~10,952 matches. Structured filters ARE a search.
            //
            // The ICP supplies them, the strategy may refine them, and
            // `searchQuery` stays a NAME index guarded by
            // `invalidCompanyNameQueryReason` — this branch never writes a
            // concept phrase into it.
            //
            // The one thing that must not happen is an UNFILTERED search: no
            // name and no filters returns arbitrary companies, and junk that
            // reaches qualification looks like work. That is skipped, loudly.
            // `opts.brain` carries employee_min/max ONLY when the Brain is
            // enforced, so an advisory policy still cannot narrow a search.
            const icp = icpDiscoveryConstraints(opts.mission, opts.brain);
            const structured = {
              ...(icp.industryIds.length ? { industryIds: icp.industryIds } : {}),
              ...(icp.locations.length ? { locations: icp.locations } : {}),
              ...(icp.companySize.length ? { companySize: icp.companySize } : {}),
            };
            // A search must SELECT a population, not merely refine one. A name
            // does that; so does an industry. Geography and headcount do not —
            // "companies sized 10-500 in the United States" is an unfiltered
            // search wearing two filters, and it returns the same arbitrary
            // rows. So the concept, or a name, or nothing.
            const selSelectsPopulation =
              Array.isArray((sel.input as Record<string, unknown>).industryIds) &&
              ((sel.input as Record<string, string[]>).industryIds ?? []).length > 0;
            if (!query && !icp.expresses_concept && !selSelectsPopulation) {
              state.provider_attempts.push({
                capability: cap, provider, attempt: 1, outcome: "skipped_not_configured",
                rows: 0, cost_units: 0,
                reason:
                  "no company name and no structured constraint could be derived " +
                  `from this ICP (unmapped: ${icp.unmapped_verticals.join(", ") || "none"}) ` +
                  "— an unfiltered company search returns arbitrary companies",
              });
              continue;
            }
            // ── EXPLICIT OWNERSHIP, NOT SPREAD ORDER ────────────────────
            //
            // This was a spread, and spread REPLACES: a strategy naming
            // `industryIds` discarded the mission's industries rather than
            // refining them, which is the opposite of what the comment beside it
            // claimed. `maxItems` was set twice and the later one silently won.
            // `mergeDiscoveryActorInput` states one rule per field instead.
            const merged = mergeDiscoveryActorInput({
              missionConstraints: structured,
              strategyInput: { ...sel.input, ...(query ? { searchQuery: query } : {}) },
              executionConstraints: {
                maxItems: maxCandidates,
                // `full` is required: `short` returns no declared size band at all
                // (run 4250f181, 108 of 108 rows), so size could not even rank.
                // EXCEPT UNDER THE FUNDING SCREEN: there the pool is ranked by
                // funding, not size — the provider still applies the declared-size
                // filter — and only ADMITTED companies get the company record that
                // settles size. Half the row price is what buys the wider pool.
                scraperMode: opts.fundingScreen ? opts.fundingScreen.plan.scraper_mode : "full",
              },
            });
            if (merged.strategy_overruled.length > 0) {
              log("discovery_input_merge_overruled", {
                capability: cap, provider,
                overruled: merged.strategy_overruled,
                provenance: merged.provenance.filter(
                  (p) => merged.strategy_overruled.includes(p.field)),
              });
            }
            // ── THE SCREEN'S FIRST PAGE: THE NEXT ONE THIS WORKSPACE HAS NOT READ ──
            //
            // Every canary read page 1 of the same filters and got the same head.
            // The first screened call starts past every page a same-shaped search
            // in this workspace already read, and asks for `first_rows`; a later
            // page (the top-up) is the pass loop's ordinary pagination from there.
            if (opts.fundingScreen && pagesTaken[provider] === undefined) {
              const page = nextUnreadPage(opts.fundingScreen.priorSearches ?? [], merged.input as Record<string, unknown>);
              (merged.input as Record<string, unknown>).startPage = page;
              (merged.input as Record<string, unknown>).maxItems = opts.fundingScreen.plan.first_rows;
              pagesTaken[provider] = page;
              log("funding_screen_first_page", {
                provider, page, rows: opts.fundingScreen.plan.first_rows,
                prior_searches: opts.fundingScreen.priorSearches?.length ?? 0,
              });
            }
            const compiled = compileHarvestCompanySearchInput(
              merged.input as never);
            const droppedPages = new Map<string, number>();
            for (const r of await callProvider(cap, provider, compiled)) {
              // A SHOWCASE PAGE IS NOT A COMPANY. Dropped HERE, at the pool
              // boundary, because everything downstream treats a pool row as
              // something worth paying to resolve — and a showcase row has no
              // `/company/` URL, so it goes to the paid NAME search and asks
              // for "LinkedIn Guide to Creating". See `nonCompanyPageReason`.
              const notACompany = nonCompanyPageReason(r);
              if (notACompany) {
                droppedPages.set(notACompany, (droppedPages.get(notACompany) ?? 0) + 1);
                continue;
              }
              // DEDUPED BY `addCompany` against everything the earlier actors
              // returned — it keys on LinkedIn URL then domain, so a company YC
              // and LinkedIn both surface is one row, identified and enriched
              // once. This is the diagram's "deduplication is global across all
              // actors", and it needed no new machinery.
              addCompany(companies, normalizeLinkedInCompanyCandidate(r), [], null, undefined, observedBy(cap, provider));
            }
            // RECORDED, not silent. A pool that shrank between the provider's
            // row count and ours must say why, or the next audit re-derives it
            // from the Apify console like this one had to.
            if (droppedPages.size > 0) {
              state.provider_attempts.push({
                capability: cap, provider, attempt: 1, outcome: "rows_dropped",
                rows: [...droppedPages.values()].reduce((a, b) => a + b, 0),
                cost_units: 0,
                reason: [...droppedPages.entries()]
                  .map(([why, n]) => `${n} ${why}`).join(", ") +
                  " — not companies, excluded before any paid identity call",
              });
            }
          } else if (provider === "apify_linkedin_job_search") {
            // ── P3: JOB-FIRST DISCOVERY ─────────────────────────────────────
            //
            // The planner's question verbatim (the spec compiler owns bounds);
            // the engine adds only a row bound when none was proposed. Each
            // open, non-agency posting brings its employer WITH a LinkedIn
            // company record, so identity is never searched for these.
            const compiled = compileHarvestJobDiscoveryInput({
              maxItems: Math.min(maxCandidates, JOB_DISCOVERY_LIMITS.maxItems),
              ...sel.input,
            } as never);
            const dropped = new Map<string, number>();
            const seenJobs = new Set<string>();
            let jobsKept = 0;
            const jobRows = await callProvider(cap, provider, compiled);
            for (const r of jobRows) {
              if (!jobIsOpen(r)) {
                dropped.set("posting_closed", (dropped.get("posting_closed") ?? 0) + 1);
                continue;
              }
              const agency = jobEmployerAgencyReason(r);
              if (agency) {
                dropped.set(`staffing_agency(${agency})`, (dropped.get(`staffing_agency(${agency})`) ?? 0) + 1);
                continue;
              }
              const employer = jobEmployerToCompany(r);
              if (!employer) {
                dropped.set("no_employer_linkedin_url", (dropped.get("no_employer_linkedin_url") ?? 0) + 1);
                continue;
              }
              const identityConflict = jobEmployerIdentityConflict(r);
              if (identityConflict) {
                dropped.set(identityConflict, (dropped.get(identityConflict) ?? 0) + 1);
                // Preserve the candidate for a later company-scoped check, but
                // do not attach this contradictory posting as hiring proof.
                addCompany(companies, { ...employer, hiring_status: null }, [], null,
                  undefined, observedBy(cap, provider));
                continue;
              }
              const job = normalizeLinkedInJob(r);
              const jobKey = job.job_id ?? job.job_url ?? `${employer.linkedin_company_url}|${job.title}`;
              if (seenJobs.has(jobKey)) continue;
              seenJobs.add(jobKey);
              jobsKept++;
              // P4: the union absorbs a second posting from the same employer (its
              // job joins the company's list) exactly as it absorbs another route.
              const holder = addCompany(companies, employer, [job], null, undefined, observedBy(cap, provider))!;
              const said = firstHireLanguage(r);
              if (said && holder.first_in_function?.status !== "supported") {
                holder.first_in_function = {
                  status: "supported", source: "job_posting", quote: said.quote,
                  job_url: job.job_url, reason: `the posting's ${said.field} says so`,
                };
              }
            }
            if (jobRows.length > 0) state.provider_attempts.push({
              capability: cap, provider,
              attempt: state.provider_attempts.filter((x) => x.capability === cap && x.provider === provider).length + 1,
              outcome: "rows_dropped",
              rows: [...dropped.values()].reduce((a, b) => a + b, 0),
              cost_units: 0,
              reason: `kept ${jobsKept} open posting(s) with the employer's LinkedIn page` +
                (dropped.size ? `; dropped ${[...dropped.entries()].map(([why, k]) => `${k} ${why}`).join(", ")}` : "") +
                " — identity taken from the posting, no Company Search",
            });
            log("job_discovery_rows", { kept: jobsKept, dropped: Object.fromEntries(dropped), employers: companies.length });
          } else if (provider === "apify_funding_rounds_datahyena") {
            // ── DISCOVERY BY FUNDING EVENT ──────────────────────────────────
            //
            // The row this Actor returns is a ROUND, not a company: it names the
            // company and carries the evidence — stage, amount, announced date,
            // investors, source articles — in one record. So the company enters
            // the pool exactly like any other discovered candidate, and the
            // round travels with it as the funding evidence.
            //
            // EVERY SEARCH TERM COMES FROM THE STRATEGY. `maxItems` is the only
            // pre-set, and only because it is a COST ceiling — this Actor bills
            // per record at the highest price in the catalog (see its card), so
            // the ceiling is clamped harder than elsewhere.
            const compiled = compileDatahyenaFundingInput({
              maxItems: Math.min(maxCandidates, 200),
              ...sel.input,
            });
            for (const r of await callProvider(cap, provider, compiled)) {
              const round = normalizeDatahyenaFundingRound(r);
              // A ROW THAT IS NOT EVIDENCE IS NOT A CANDIDATE.
              //
              // `is_evidence` is false when the row has no company name or no
              // announced date. Admitting such a row would put a company into a
              // FUNDING mission's pool carrying no provable funding event, and
              // the qualification stage would then have to decide between
              // inventing the signal and dropping a candidate discovery had
              // already paid for. Refusing it here keeps that choice from
              // arising.
              if (!round.is_evidence) continue;
              const fundedCompany = fundingRoundToCompany(round);
              const fundedCtx = observedBy(cap, provider);
              const fundedHolder = addCompany(companies, fundedCompany, [], null, undefined, fundedCtx);
              fundingRounds.push(round);
              // THE ROUND IS FUNDING EVIDENCE, NOT JUST A WAY IN. Recorded on
              // the company as a FundingRecordFact (never a complete history),
              // so the funding-stage claim reads what was already bought — a
              // dated later round contradicts the asked stage now; the asked
              // stage itself stays PENDING until completeness is proven.
              if (fundedHolder) recordDiscoveredFunding(fundedHolder, round, fundedCtx, requiredRoundStage);
              // KEYED THE WAY THE POOL KEYS IT. `fundingRounds` was pushed to
              // and never read, so the round — stage, amount, announced date,
              // investors, articles — was collected, paid for and discarded,
              // and a funding mission proved nothing. The key is derived from
              // the same company object `addCompany` used, so the two cannot
              // disagree about which company this round belongs to.
              roundByCompanyKey.set(fundedHolder?.key ?? companyKey(fundedCompany), round);
            }
          }
          // A REJECTED INPUT ENDS THE CAPABILITY IMMEDIATELY.
          //
          // Continuing to the next approved provider would still be spending on
          // the back of a call we never validly made, and the whole point of
          // catching this locally is that nothing downstream gets to reinterpret
          // it as "the source came back empty".
          if (compileFailedFor(provider)) { schemaFailure = true; break; }
          if (pendingFor(provider)) { runPending = true; break; }
        }
        if (sels.length > 0 && !runPending && !schemaFailure) await researchWave();
      };

      // ── A REOPENED DISCOVERY RESUMES; IT DOES NOT RESTART ────────────────
      //
      // Without this the first pass of a replenishment slice re-asks page one of
      // every actor. Spend identity makes that harmless to the bill — the input
      // hashes to the `logical_call_key` already settled, so the completed run
      // is adopted — and useless to the mission: the slice re-reads rows the
      // restored pool already contains and ends exactly as wide as it began,
      // which is the barren-slice loop this whole fix exists to remove.
      //
      // So the debt is paid where it was left. Each actor that supports paging
      // and has pages left advances to its next unread one; an actor that
      // supports neither is left alone, and the re-plan below is what finds it
      // a different question to ask.
      /**
       * Pages this pass PROPOSED, held until the provider confirms them.
       * `actor -> { page, attemptsBefore }`.
       */
      const proposedPages = new Map<string, { page: number; before: number }>();
      if (opts.discoveryReplenishment) {
        for (const sel of strategy.selections) {
          const card = hiringActorCard(sel.actor_key);
          // P3: the LinkedIn job search pages with `page`, bounded by the card,
          // so a job-first continuation widens the pool instead of idling
          // (canary 03f4c9c6: four barren slices).
          const pageField = card && acceptedInputFields(card).includes("startPage") ? "startPage"
            : card && cap === "job_discovery" && acceptedInputFields(card).includes("page") ? "page" : null;
          if (!card || !pageField) continue;
          const limit = Number(card.input_limits?.[pageField === "page" ? "pages_discovery" : "takePages"] ?? 0);
          const taken = pagesTaken[sel.actor_key] ??
            (pageField === "page" && attemptCountFor(sel.actor_key) > 0 ? 1 : 0);
          if (taken <= 0 || limit <= taken) continue;
          // THE INPUT CARRIES THE NEXT PAGE; THE CURSOR DOES NOT MOVE YET.
          sel.input = { ...sel.input, [pageField]: taken + 1 };
          proposedPages.set(sel.actor_key, {
            page: taken + 1, before: attemptCountFor(sel.actor_key),
          });
          log("discovery_replenishment_page_proposed", {
            actor: sel.actor_key, page: taken + 1, page_limit: limit,
          });
        }
        state.discovery_strategy = discoveryStrategyDiagnostics(strategy);
      }

      await executeSelections(strategy.selections);

      // COMMIT, now that the provider layer has answered. A page the run only
      // considered leaves no attempt behind and moves nothing.
      for (const [actorKey, proposal] of proposedPages) {
        if (attemptCountFor(actorKey) > proposal.before) {
          pagesTaken[actorKey] = proposal.page;
          log("discovery_replenishment_page_committed", {
            actor: actorKey, page: proposal.page,
          });
        } else {
          log("discovery_replenishment_page_not_taken", {
            actor: actorKey, page: proposal.page,
            note: "no provider operation was executed or adopted for this page",
          });
        }
      }

      // ── EXECUTE → INSPECT → REPLAN ────────────────────────────────────────
      //
      // The stage that was missing. Discovery used to be one-shot: the planner
      // chose once, the engine ran the choice, and whatever came back was the
      // pool every later stage had to work with. No later stage can repair an
      // earlier one — that is the first property in the Agentory briefing — so a
      // pool that could never answer the mission was simply the run's answer.
      //
      // Run 25f3ff57 is the case. 100 rows came back carrying no hiring state at
      // all, for a mission whose `required_evidence` was `embedded_hiring_evidence`.
      // The engine had that fact the moment discovery finished, and reported it
      // 90 seconds later as `open_jobs_evaluated: 0` next to `qualified: 0`.
      //
      // Now the engine STATES what it got — counts only, never a verdict — and
      // the model decides whether its strategy is working. Three properties keep
      // this from becoming unbounded:
      //
      //   * it only runs when the pass fell short of what the mission needs;
      //   * an actor already run cannot be proposed again, so a re-plan must
      //     change the mechanism rather than repeat it at the same price;
      //   * `maxDiscoveryPasses` bounds it, and one extra planning call is cheap
      //     next to the paid Actor it may avoid.
      //
      // A re-plan that proposes nothing usable is not an error: the first pass's
      // pool stands and the run continues with what it has.
      /**
       * Every question this capability has already put to a provider.
       *
       * `actor|fingerprint(proposed input)`. A re-plan may name the same actor
       * again — that is the correct move after a zero-row result — but not with
       * the identical input, which would buy the identical nothing.
       */
      const askedQuestions = new Set<string>(
        strategy.selections.map((sel) =>
          `${sel.actor_key}|${inputFingerprint(sel.input ?? {})}`),
      );
      const passLimit = Math.max(1, opts.maxDiscoveryPasses ?? DEFAULT_DISCOVERY_PASSES);
      // WHY DISCOVERY STOPPED, recorded as it happens rather than reconstructed
      // afterwards. A stop reason inferred from the final counts cannot tell
      // "the planner had nothing more to offer" from "the ceiling bound", and
      // those two mean opposite things to the next slice.
      let discoveryStop: NonNullable<
        CapabilityExecutionState["discovery_source_state"]>["stop_reason"] = "pass_limit";
      // ── EVERY ACTOR THE STRATEGY ALREADY CONSIDERED, NOT ONLY THOSE THAT RAN ──
      //
      // Briefly changed to `[...used]` on the reasoning that an actor which never
      // ran "sold nothing" and should stay proposable. That is true about COST
      // and wrong about ROLE: an actor the strategy deliberately declined —
      // `fallback`, held back precisely because the primary was producing — would
      // be re-proposed by the next pass and spend anyway, which is the guarantee
      // `shouldRunSelection` exists to make.
      //
      // A pass is one decision about a set of actors. The re-plan is for a
      // DIFFERENT set; if the right answer is one this pass already weighed, the
      // answer is not to buy it behind the strategy's back.
      const actorsRun = [...strategyKeys];
      // PAGE ONE IS ALREADY TAKEN. Seeded from the actors this pass ran so the
      // first pagination asks for page two, not page one again — which would be
      // the identical question and would be adopted rather than run.
      //
      // `??` and not `=`: an inherited count from an earlier slice is the
      // authority. Overwriting it with 1 is exactly how a resumed replenishment
      // would re-ask for page two.
      for (const k of actorsRun) pagesTaken[k] = pagesTaken[k] ?? 1;
      for (let pass = 2; pass <= passLimit; pass++) {
        if (candidateBudgetSpent()) {
          discoveryStop = "candidate_budget_spent";
          break;
        }
        if (schemaFailure || runPending) {
          discoveryStop = schemaFailure ? "schema_failure" : "run_pending";
          break;
        }
        if (enoughCandidates()) {
          discoveryStop = "admitted_target_met";
          break;
        }
        if (companies.length >= maxCandidates * MAX_RAW_ROWS_PER_ADMITTED) {
          discoveryStop = "raw_row_ceiling";
          break;
        }
        const summary = summariseDiscoveryPool(
          actorsRun[actorsRun.length - 1] ?? "(none)", companies, opts.mission);
        // ENOUGH IS ENOUGH. A pool that met the target and carries no stated
        // problem is not re-planned — the cheapest planning call is the one that
        // does not happen.
        //
        // Measured on admitted rows for the same reason as the pass above: a
        // re-plan is exactly what a pool of unusable rows needs, and the row
        // count was the thing hiding that it needed one.
        const shortfall = !enoughCandidates() ||
          summary.observed_problems.length > 0;
        if (!shortfall) { discoveryStop = "admitted_target_met"; break; }

        // ── THE NEXT PAGE BEFORE THE NEXT PROVIDER ───────────────────────
        //
        // A source that is admitting candidates has more of them; its next page
        // is the same question asked further down the same index, at the same
        // unit price, with no new integration and no new failure mode. Buying a
        // DIFFERENT provider first pays a premium to re-derive what this one is
        // already producing.
        //
        // Only for a source that is actually producing: `yield` is admitted
        // over raw for the whole pool, and beneath the floor the honest reading
        // is that this index does not hold what the mission wants, so another
        // page buys more of the same miss. Run 7e71d8bc's own numbers — 34
        // admitted of 50 raw, 68% — sit far above the floor, which is what
        // makes pagination the right first move for exactly that run.
        const lastActor = actorsRun[actorsRun.length - 1];
        const lastCard = lastActor ? hiringActorCard(lastActor) : null;
        const pageLimit = Number(lastCard?.input_limits?.takePages ?? 0);
        const pagesSoFar = pagesTaken[lastActor ?? ""] ?? 1;
        const rawYield = companies.length > 0
          ? admittedNow() / companies.length
          : 0;
        // UNDER THE FUNDING SCREEN the next page is the TOP-UP: it runs exactly
        // when the first page was mostly stale (recently checked, placeholders,
        // duplicates), which is when the yield floor would refuse it. Bounded by
        // the screen's row allowance through `candidateBudgetSpent` and the spec.
        if (
          lastCard &&
          acceptedInputFields(lastCard).includes("startPage") &&
          pageLimit > pagesSoFar &&
          (opts.fundingScreen ? opts.fundingScreen.plan.topup_rows > 0 : rawYield >= MIN_PAGINATION_YIELD)
        ) {
          const nextPage = pagesSoFar + 1;
          // THE SAME SELECTION, ONE PAGE ON. Rebuilt from the selection that ran
          // rather than composed here, so every filter the strategy chose is
          // carried forward unchanged and only the page moves. A different
          // `startPage` is a different `input_hash`, so this is a distinct
          // billable operation and a replay of page 1 is still adopted rather
          // than re-bought.
          const prior = strategy.selections.find((x) => x.actor_key === lastActor);
          if (prior) {
            const paged: DiscoveryActorSelection = {
              ...prior,
              role: "breadth",
              input: { ...prior.input, startPage: nextPage },
              rationale:
                `page ${nextPage} of ${lastActor} — ${admittedNow()} of ` +
                `${companies.length} rows admitted so far, so the source is ` +
                `still producing candidates this mission can use`,
            };
            const question =
              `${paged.actor_key}|${inputFingerprint(paged.input ?? {})}`;
            if (!askedQuestions.has(question)) {
              log("discovery_pagination_running", {
                pass, actor: lastActor, page: nextPage,
                admitted: admittedNow(), raw: companies.length,
                yield: Number(rawYield.toFixed(3)),
              });
              const before = attemptCountFor(lastActor);
              await executeSelections([paged]);
              askedQuestions.add(question);
              // SAME RULE AS THE REPLENISHMENT PATH. `executeSelections` can
              // decline this call on any of its guards — a credit refusal, the
              // deadline, the raw ceiling — and a page nobody bought must not
              // move the cursor the next slice resumes from.
              if (attemptCountFor(lastActor) > before) {
                pagesTaken[lastActor] = nextPage;
              } else {
                log("discovery_pagination_page_not_taken", {
                  actor: lastActor, page: nextPage,
                  note: "no provider operation was executed or adopted",
                });
              }
              strategy.selections.push(paged);
              state.discovery_strategy = discoveryStrategyDiagnostics(strategy);
              // PAGINATION IS A PASS. Re-measure the pool before deciding anything
              // else, so a page that filled the target does not also buy a
              // re-plan on the strength of a stale count.
              continue;
            }
          }
        }

        log("discovery_replan_considering", {
          pass, pool: companies.length, admitted: admittedNow(),
          available_admitted: availableAdmittedNow(),
          admitted_target: admittedTarget, raw_ceiling: maxCandidates,
          problems: summary.observed_problems,
        });
        // THE ATTEMPTS THEMSELVES, so the planner is told what each actor did
        // and can ask a better question rather than only a different actor.
        const next = await resolveDiscoveryStrategy(
          summary,
          state.provider_attempts.filter((a) => a.capability === cap),
          askedQuestions,
        );
        if (next.source === "blocked" || next.selections.length === 0) {
          // NOT A FAILURE. The model looked at what came back and had nothing
          // better to offer, which is a legitimate answer and leaves the run
          // exactly as the first pass left it.
          log("discovery_replan_declined", {
            pass, reason: next.violations[0]?.code ?? "no_further_actor_proposed",
          });
          discoveryStop = "no_further_actor_proposed";
          break;
        }
        // P2: A REPLAN IS A PLAN AMENDMENT — named trigger, validation, reserve.
        if (!p2AcceptAmendment(executionPlan, "insufficient_candidates",
          next.selections.map((sel) => ({
            capability: cap, provider: sel.actor_key, input: (sel.input ?? {}) as Record<string, unknown>,
          })), { availableAdmitted: availableAdmittedNow() })) {
          log("discovery_replan_refused_by_plan", { pass });
          discoveryStop = "amendment_refused";
          break;
        }
        log("discovery_replan_running", {
          pass, actors: next.selections.map((s) => s.actor_key),
        });
        await executeSelections(next.selections);
        for (const sel of next.selections) {
          askedQuestions.add(`${sel.actor_key}|${inputFingerprint(sel.input ?? {})}`);
          actorsRun.push(sel.actor_key);
          if (!strategyKeys.includes(sel.actor_key)) strategyKeys.push(sel.actor_key);
          strategy.selections.push(sel);
        }
        state.discovery_strategy = discoveryStrategyDiagnostics(strategy);
      }
      // ── WHAT THE NEXT SLICE NEEDS TO KNOW ABOUT THIS POOL ────────────────
      //
      // Written unconditionally at the end of discovery, including when it
      // stopped early, because "discovery ran and could not widen further" and
      // "discovery never ran" are different facts and only the second may be
      // read as unknown.
      //
      // `exhausted` is the field `decideAutoContinuation` turns into a terminal
      // decision, so it is deliberately conservative: only a stop that PROVES
      // nothing more was available counts. `admitted_target_met` does not —
      // the pool was good enough this time, and a later slice that has spent it
      // may legitimately ask for more.
      {
        const admittedAtStop = admittedNow();
        // Whatever stopped the passes, a spent allowance is the binding fact:
        // no later slice may buy, so none should be scheduled to plan.
        if (candidateBudgetSpent() && discoveryStop !== "raw_row_ceiling" && discoveryStop !== "no_further_actor_proposed") {
          discoveryStop = "candidate_budget_spent";
        }
        state.discovery_source_state = {
          sources_attempted: [...actorsRun],
          pages_taken: { ...pagesTaken },
          // LIFETIME admitted, kept for the record and the funnel. The number
          // discovery DECIDES on is `available_admitted` beside it — see
          // `availableAdmittedNow`.
          admitted: admittedAtStop,
          available_admitted: availableAdmittedNow(),
          raw_rows: companies.length,
          pool_target: admittedTarget,
          exhausted: discoveryStop === "no_further_actor_proposed" ||
            discoveryStop === "raw_row_ceiling" || discoveryStop === "candidate_budget_spent",
          stop_reason: discoveryStop,
        };
        log("discovery_source_state", state.discovery_source_state);
      }
      // `state.company_keys` is DERIVED once, at the return. See the note there.

      if (companies.length === 0 && runPending) {
        // PENDING, NOT EXHAUSTED. The capability stays incomplete and unspent-on;
        // a later resume adopts the same run id rather than starting another.
        state.terminal_reason = "provider_run_pending";
        state.fallback_reason = null;
        finish(cap, "incomplete", 0, used, false,
          `provider_run_pending: ${state.pending_runs.map((r) => `${r.provider}:${r.run_id}`).join(", ")}`);
        break;
      }
      if (companies.length === 0) {
        // AN INVALID INPUT IS NOT AN EMPTY RESULT.
        //
        // On TEST task e8abeb8f-…-cfcbc6a416d4 the memo23 call was rejected by
        // Apify and the run carried on as though the source had simply returned
        // nothing — which is how a schema failure became a LinkedIn Jobs sweep
        // and five people searches. A source that was never validly asked has
        // not answered, and the mission stops here.
        const invalid = state.provider_attempts.filter(
          (a) => a.capability === cap && a.outcome === "compile_failed");
        if (invalid.length > 0) {
          state.terminal_reason = "provider_input_validation_failed";
          state.fallback_reason = null;
          finish(cap, "incomplete", 0, used, false,
            `provider_input_validation_failed: ${invalid.map((a) => `${a.provider}: ${a.reason}`).join(" | ")}`);
          break;
        }
        // EXHAUSTION IS MEASURED AGAINST THE STRATEGY, NOT THE PERMISSION LIST.
        //
        // `CAPABILITY_REGISTRY` says which actors this capability MAY use; the
        // strategy says which it WILL, for this mission. A provider the
        // strategy declined is not a fallback sitting unused — and counting it
        // as one made a failed run report `apify_linkedin_company_search has
        // not been tried` about an actor the plan never contained, turning a
        // genuinely exhausted capability into one that looked recoverable.
        //
        // Escalating to an unselected provider here would also be exactly the
        // thing these guards exist to stop: spending on an actor outside the
        // plan because the plan came back empty.
        const declined = step.providers.filter((p) => !strategyKeys.includes(p));
        const ex = onCapabilityExhausted(opts.plan, cap, [...tried, ...declined]);
        state.terminal_reason = ex.reason;
        state.fallback_reason = ex.status === "exhausted" ? "approved_providers_exhausted" : null;
        finish(cap, "exhausted", 0, used, false, ex.reason);
        // EXHAUSTED ENDS THE RUN. It does not fall through to a capability that
        // happens to be later in the plan.
        break;
      }
      // ── FREE COMMERCIAL PREQUALIFICATION ────────────────────────────────────
      //
      // Between discovery and the first paid identity call, and costing nothing.
      // memo23 already returned every company's FULL openJobs array, team size
      // and website; this decides who is worth paying to identify BEFORE anyone
      // is paid for. Task c8a6e53d skipped this step and bought 16 identity
      // lookups for companies that were only hiring engineers, or had 350 staff
      // against a 10-150 mission.
      // ── IT RUNS FOR EVERY POOL NOW, NOT ONLY A YC ONE ────────────────────
      //
      // This was `if (rawYcRows.length > 0)`, and the comment beneath it
      // conceded the cost: a pool assembled by the LinkedIn company search, the
      // funding source or the news source "loses the FREE pre-pass, which is
      // exactly what a source that returns no embedded jobs cannot support."
      //
      // The premise was too strong. A source with no embedded jobs still
      // returns a declared size band, a description, a domain and a LinkedIn URL.
      // A company DECLARING 501-1000 on a 10-150 mission was
      // being carried through identity resolution and enrichment — two paid
      // calls, ~26s — to reach a conclusion its discovery row already stated.
      //
      // TWO PASSES, ONE VERDICT SHAPE. The YC pass keeps the row shape it reads
      // and the role-tier scoring only it can do. The generic pass reads the
      // NORMALIZED company plus that normalizer's own `field_trust` map, so it
      // gates only on fields the source is declared trustworthy for and needs no
      // knowledge of which actor produced the row. `mergePrequalification` folds
      // them into the single result the run reports, because the funnel reads
      // its counts and a mixed pool described by half of itself is the same
      // class of error as the old shortlist telemetry.
      applyPrequalification(state, companies, rawYcRows, {
        min: opts.brain?.employee_min ?? null,
        max: opts.brain?.employee_max ?? null,
        // WHETHER THE WORKSPACE MEANT A RULE OR A PREFERENCE. Without it the
        // free pre-pass computed `above_max` for 27 of 29 companies on run
        // fafd9912, wrote the reason on every one, and excluded none.
        hard_constraints: opts.brain?.hard_constraints ?? null,
      }, qualificationCtx, opts.mission?.required_signals ?? null);
      // The working set may have shrunk — artifacts are gone.
      // `state.company_keys` is DERIVED once, at the return. See the note there.
      log("prequalification_complete", {
        unique: state.prequalification?.unique_companies,
        eligible: state.prequalification?.eligible_companies,
        size_excluded: state.prequalification?.employee_size_excluded,
        technical_only: state.prequalification?.technical_only_companies,
        yc_rows: rawYcRows.length,
        generic_scored: state.prequalification?.generic_scored ?? 0,
      });

      // ── STAGE 2: GPT MISSION INTELLIGENCE, THEN THE SMART SHORTLIST ────────
      //
      // Runs AFTER the deterministic pass and OVERRIDES its shortlist. The free
      // pass keeps doing what it is good at — deduping, artifact removal,
      // scoring — and stops being the thing that decides which companies are
      // semantically worth money. That decision was a substring match, and it
      // excluded ML Engineer, Founding Engineer and Member of Technical Staff
      // from a Mission asking for software engineers.
      // THE PRIOR FRONTIER, ONTO THE COMPANIES DISCOVERY JUST REBUILT.
      //
      // The loop-level restore runs before each capability, and on the discovery
      // pass `companies` is still empty — so a continuation that RE-RUNS
      // discovery (rather than skipping it) rebuilt every company at the
      // default `pending_investigation` and handed out the same first slice
      // again. Applied here, after the working set exists and before it is
      // ranked.
      if (resumeScope) for (const c of companies) restoreFromResume(c);

      // ── THE PAID ROWS ARE DURABLE BEFORE ANYTHING ELSE IS ATTEMPTED ──────
      //
      // Everything below this line — triage, ranking, the plan amendment — is
      // model work. It is fast on a good day and it is not bounded by anything
      // the platform respects, so a slice can die inside it holding companies
      // that were already paid for.
      //
      // Lineage 610951da, verbatim from its own logs:
      //
      //     08:36:43  discovery returned          (one Apify call, one credit)
      //     08:37:00  mission-triage batch 2, 25 companies
      //     08:38:40  isolate killed
      //     ...       no checkpoint, ever
      //
      // `publish("accounts_found")` sits at the END of this capability, after
      // the amendment, so it was never reached. The task kept
      // `checkpoint_version: 0` and no `company_first_state`, and
      // `eligibleForAutoResume` answered `no_checkpoint` on every sweeper tick
      // for two hours until the row aged out. The mission could not resume and
      // its spend was stranded.
      //
      // Marking discovery COMPLETE here is truthful: the capability's job is to
      // fetch companies from a provider, and it has. Triage and ranking are
      // post-processing that happen to live in the same block.
      //
      // SAFE BECAUSE THE POOL CANNOT REACH A PAID STAGE UNTRIAGED.
      // `ensureMissionIntelligence` already states that invariant for every
      // route and is idempotent, so a slice resumed from this checkpoint
      // re-applies triage before spending. The one risk this ordering creates
      // is the one the codebase already closed.
      finish(cap, "complete", companies.length, used, true, null);
      await publish(state.prequalification ? "prequalified" : "accounts_found");

      await applyMissionIntelligence(companies);
      // THE FIRST SLICE. Ranking and selection are now separate acts: the
      // ranking is decided once, here; the slice is taken here and again on
      // every later pass and every continuation.
      takeInvestigationSlice(companies, 1);

      // ── WHAT DO I STILL NEED? ────────────────────────────────────────────
      //
      // The chain was planned BEFORE any Actor ran, from what the catalog said
      // each one returns. Now the pool exists and the answer is a fact rather
      // than a prediction — so the remaining steps are worth reconsidering
      // against it.
      //
      // The concrete case: a chain that skipped paid hiring verification because
      // its discovery Actor "carries openJobs" is right only if the rows
      // actually came back carrying them. If they did not, the step it dropped
      // is the one the mission needs, and finding that out at the END of the run
      // is exactly the 25f3ff57 failure in a different costume.
      //
      // BOUNDED AND BACKWARD-SAFE. One extra planning call; it can only change
      // stages that have NOT run yet, because `chainSkips` is consulted as the
      // loop reaches each capability; and an unusable answer leaves the original
      // chain standing.
      // ── IS THERE ANYTHING THIS CALL COULD CHANGE? ────────────────────────
      //
      // The amendment costs a reasoning-model call — ~6s on run 1af9b9ea — and
      // its effective surface is narrower than it looks. `executionPlan` has two
      // consumers: `chainSkips`, which reads ONLY `OPTIONAL_BY_CHAIN`, and
      // `plannedActorsFor`, which supplies discovery actors. This runs AFTER
      // discovery, and a graph never holds more than one discovery capability,
      // so the second consumer is already spent. Chain-skipping an optional
      // stage is the only lever left.
      //
      // The predicate is deliberately the GRAPH, not the current plan. Asking
      // "is an optional stage still selected?" would skip the call precisely
      // when the initial chain had dropped one — removing GPT's chance to put
      // it BACK after seeing the pool, which is the case this amendment exists
      // for. If the mission's graph contains no optional stage at all, no answer
      // the model gives can alter this run, and the call is pure cost.
      const amendableSurface = opts.plan.steps
        .map((s) => s.capability)
        .filter((c) => OPTIONAL_BY_CHAIN.has(c) && !state.completed_capabilities.includes(c));

      if (deps.planExecution && executionPlan && amendableSurface.length === 0) {
        log("execution_plan_amendment_skipped", {
          reason: "no_amendable_surface",
          detail:
            "no OPTIONAL_BY_CHAIN capability remains in this mission's graph, so " +
            "no amendment could change what still runs",
          optional_by_chain: [...OPTIONAL_BY_CHAIN],
        });
      } else if (deps.planExecution && executionPlan) {
        try {
          const summary = summariseDiscoveryPool(
            used[used.length - 1] ?? strategyKeys[0] ?? "(none)", companies, opts.mission);
          const amended = validateExecutionPlan(
            ((p: unknown) => Array.isArray(p) ? p : (p as { steps?: unknown } | null)?.steps)(
              await deps.planExecution({
                payload: buildExecutionPlannerPayload(opts.mission, opts.plan, { brain: opts.brain, readiness: guardPolicy }),
                mission_hash: await missionHash(opts.mission),
                results: summary,
              })),
            opts.mission, opts.plan);
          if (amended.source !== "blocked" && p2AcceptAmendment(amended,
            availableAdmittedNow() < admittedTarget ? "insufficient_candidates" : "evidence_unavailable",
            [], { availableAdmitted: availableAdmittedNow(), keepRoutes: true })) {
            const before = executionPlan.steps.map((s) => s.capability);
            const after = amended.steps.map((s) => s.capability);

            // ── A REMOVAL CODE REFUSES IS SAID OUT LOUD ─────────────────────
            //
            // `validateExecutionPlan` checks what a plan CONTAINS — containment,
            // the people guard, declared actors. It says nothing about what a
            // plan OMITS. So an amendment dropping identity resolution was
            // accepted into the plan object, ignored by `chainSkips` (which
            // reads only OPTIONAL_BY_CHAIN), executed anyway, and recorded
            // nowhere.
            //
            // That is the df00b2cd mystery: correct behaviour, invisible
            // reasoning. The stage still runs — that part was always right —
            // but the refusal is now a fact on the record rather than something
            // a reader has to reconstruct from two files.
            const refusedRemovals = before
              .filter((c) => !after.includes(c) && !OPTIONAL_BY_CHAIN.has(c));
            if (refusedRemovals.length > 0) {
              state.amendment_refusals = [
                ...(state.amendment_refusals ?? []),
                ...refusedRemovals.map((capability) => ({
                  capability,
                  reason: "structural_requirement" as const,
                  detail:
                    `the plan proposed dropping ${capability}, which is not ` +
                    `chain-optional; it runs regardless and the proposal is ` +
                    `recorded rather than applied`,
                })),
              ];
              log("amendment_stage_removal_refused", {
                capabilities: refusedRemovals,
                reason: "structural_requirement",
              });
            }

            executionPlan = amended;

            // ── ONLY CLAIM AN AMENDMENT WHEN ONE HAPPENED ───────────────────
            //
            // Run 1af9b9ea recorded `amended_after_discovery: true` with an
            // identical before and after, so the trace reported a decision that
            // changed nothing. A no-op is worth knowing about — it is the
            // signal that this call is not earning its latency — but it is not
            // an amendment.
            const changed = before.join(">") !== after.join(">");
            state.execution_plan = {
              ...(state.execution_plan ?? {}),
              amended_after_discovery: changed,
              ...(changed ? { amended_reasoning: amended.reasoning } : {
                amendment_considered_no_change: true,
              }),
              // The input travels here too — see the note on the first
              // projection. An amended plan that dropped it would be reused as
              // a chain of Actors nobody had told what to ask for.
              steps: amended.steps.map((s) => ({
                step: s.step, capability: s.capability, actor_key: s.actor_key,
                purpose: s.purpose, depends_on: s.depends_on, input: s.input,
              })),
            };
            log(
              changed
                ? "execution_plan_amended_after_discovery"
                : "execution_plan_amendment_no_change",
              { observed: summary.observed_problems, before, after },
            );
          }
        } catch (e) {
          // The original chain stands. A failed amendment is not a failed run.
          log("execution_plan_amend_failed", { error: String(e) });
        }
      }

      // ALREADY FINISHED AND PUBLISHED, above, before the model work began.
      // Publishing again is cheap and keeps the checkpoint current with
      // whatever triage and the amendment decided — but the capability is NOT
      // finished twice, which would double-count the pool.
      await publish(state.prequalification ? "prequalified" : "accounts_found");
      continue;
    }

    // ── THE SECOND DISCOVERY BRANCH IS GONE, NOT MOVED ───────────────────────
    //
    // `general_company_discovery` had its own implementation here: a hardcoded
    //
    //     const provider = "apify_linkedin_company_search";
    //
    // and `compileCompanySearchConcepts(mission)`, which authored the paid
    // Actor's input from two mission fields — `verticals` and `business_models`
    // — and dropped `stages`, `required_signals`, `required_signal_terms`,
    // `employee_range` and every hard constraint on the way past.
    //
    // On run 25f3ff57 (2026-08-18) that compiled "Find 10 qualified AI startups
    // in the United States that are currently hiring software engineers" into
    // two calls: `searchQuery: "AI"` and `searchQuery: "startup"`. The actor's
    // own card says `not_for: ["semantic/concept search"]`; nothing on this path
    // consulted it, because `not_for` is enforced in `validateDiscoveryStrategy`
    // and this branch never called it. 100 rows came back — 50 accelerators,
    // newsletters and one podcast — and 0 qualified.
    //
    // Both capabilities now share the stage above, so there is no second place
    // for a provider to be chosen or an input to be written. That is the point:
    // this was not a bug in the query compiler, it was a bug in there BEING a
    // second query compiler.
    // `funding_signal_discovery` LEFT THIS LIST when it gained a provider that
    // can keep its claim. It is driven through the shared discovery stage like
    // any other discovery capability — see `ENGINE_DRIVEN_DISCOVERY`.
    // P3: job rows are deduplicated by job id and employers by LinkedIn company
    // WHILE job discovery normalizes them; this stage reports that work.
    if (cap === "job_deduplication") {
      const jobs = companies.reduce((n, c) => n + (jobSourced(c) ? c.yc_open_jobs.length : 0), 0);
      if (jobs > 0) finish(cap, "complete", jobs, [], true, null);
      else finish(cap, "skipped_no_input", 0, [], false, "no open posting reached deduplication");
      continue;
    }
    if (cap === "expansion_signal_discovery") {
      // Declared in the graph and reachable, but not yet driven by this engine.
      // Recorded honestly rather than silently treated as done.
      finish(cap, "skipped_no_input", 0, [], false,
        "capability is not yet engine-driven; the mission reports a partial result");
      continue;
    }

    // ── DATED PUBLIC EVIDENCE FOR A NON-HIRING SIGNAL ────────────────────────
    //
    // ONE STAGE, TWO CAPABILITIES, for the same reason discovery has one stage:
    // `expansion_signal_verification` and `product_launch_verification` ask the
    // same provider the same shape of question about the same company, and
    // giving them a branch each is how `general_company_discovery` acquired a
    // hardcoded provider and skipped the planner.
    //
    // ── WHAT THIS ESTABLISHES, AND WHAT IT REFUSES TO ────────────────────────
    //
    // A DATED, SOURCED PUBLIC STATEMENT. `normalizeNewsArticle` marks an item
    // `is_evidence` only with a followable URL and a publication date, and an
    // item without both never reaches the registry — so "we found something"
    // can never stand in for "something happened, on a date, and here is where
    // it was said".
    //
    // It does NOT read the article. Whether the story means what the mission
    // needs is the evaluator's judgement, made from the cited item; this stage
    // establishes that the statement exists and when it was made.
    if (ENGINE_DRIVEN_SIGNAL_VERIFICATION.has(cap)) {
      const event = cap === "expansion_signal_verification" ? "expansion" : "product_launch";
      const provider = "apify_google_news";
      await ensureMissionIntelligence(companies);

      // ONLY THE SLICE, AND ONLY A RESOLVED COMPANY. Asking the news for a
      // company we could not identify would attribute a story to a name.
      const targets = companies.filter((c) =>
        c.shortlisted && c.identity && identityIsActionable(c.identity));
      const sig = (opts.mission.required_signals ?? [])
        .find((x) => String(x.type ?? "") === event);
      const days = Number((sig as { timeframe_days?: number } | undefined)?.timeframe_days ?? 0);
      // The Actor's own vocabulary, never a raw day count.
      const timeframe = days > 0 && days <= 1 ? "1d" : days > 0 && days <= 7 ? "7d"
        : days > 0 && days <= 30 ? "30d" : "1y";

      let found = 0;
      let asked = 0;
      /** Targets with no name to search for — see the note in the loop. */
      let unnamed = 0;
      for (const c of targets) {
        if (deps.deadline?.expired()) break;
        // ── NO NAME, NO SEARCH — AND THE SKIP IS RECORDED ──────────────────
        //
        // A news search needs something to search FOR. A company supplied by
        // LinkedIn URL carries no name of its own — deriving one from the slug
        // would be a guess — so its name comes from enrichment, and when
        // enrichment fails there is nothing to ask about.
        //
        // Live run 2026-08-24: enrichment returned 403, every target was
        // skipped, and the stage reported `asked: 0` with no reason. A count
        // that says "we asked nobody" and does not say why is the silence this
        // phase keeps removing.
        const name = (c.enriched?.company_name ?? c.company.company_name ?? "").trim();
        if (!name) {
          unnamed++;
          c.record.missing_evidence.push(`${event}_search_needs_company_name`);
          continue;
        }

        const compiled = compileGoogleNewsInput({
          // THE COMPANY AND THE CLAIM, TOGETHER. A search for the terms alone
          // returns the industry's news; a search for the name alone returns
          // everything about the company. Neither is evidence of this signal.
          keywords: SIGNAL_NEWS_TERMS[event].map((t) => `"${name}" ${t}`),
          maxArticles: NEWS_ARTICLES_PER_COMPANY,
          timeframe,
          extractDescriptions: true,
        });
        asked++;
        const rows = await callProvider(cap, provider, compiled, c);
        // ── THE ACTOR'S WINDOW IS COARSER THAN THE MISSION'S ────────────────
        //
        // Its vocabulary is 1h/1d/7d/30d/1y/all, so a 90-day request is sent as
        // "1y" — the narrowest bucket that certainly contains it. Sending "30d"
        // instead would silently shrink what the mission asked for.
        //
        // The consequence is that results can be OLDER than the window, and a
        // story from last spring is not evidence of an expansion this quarter.
        // So the window is enforced HERE, on the article's own publication
        // date, which is the only place it can be enforced exactly.
        const cutoff = days > 0 ? Date.now() - days * 86_400_000 : null;
        const articles = rows.map(normalizeNewsArticle)
          .filter((a) => a.is_evidence)
          .filter((a) => {
            if (cutoff === null) return true;
            const t = Date.parse(a.published_at ?? "");
            return Number.isFinite(t) && t >= cutoff;
          });
        if (articles.length > 0) {
          c.signal_evidence[event] = [...(c.signal_evidence[event] ?? []), ...articles];
          found++;
        }
      }

      log(`${event}_verification_complete`, {
        targets: targets.length, asked, with_evidence: found,
        skipped_unnamed: unnamed,
      });
      // EVIDENCE FOR SOMEBODY IS WHAT COMPLETES THIS. Asking every company and
      // finding nothing is an answered question, so the capability completed —
      // but with no evidence, which is what `assessSignals` reads.
      finish(cap, asked > 0 ? "complete" : "skipped_no_input", found, [provider],
        found > 0,
        found > 0
          ? null
          : unnamed > 0
          ? `${unnamed} target(s) had no company name to search for — enrichment ` +
            `supplies it, and a name cannot be guessed from a LinkedIn slug`
          : "no dated public statement was found");
      continue;
    }

    // ── THE COMPANIES THE MISSION NAMED ──────────────────────────────────────
    //
    // WHAT THIS REPLACED, AND WHY IT WAS WRONG.
    //
    // This capability sat in the skip list above. Every route into the company
    // pool ran through a discovery provider, so `known_companies` was read by
    // the mission compiler, the intent model and the playbook selector — and by
    // nothing that executes. A mission naming its own companies discovered
    // nothing and reported a partial result, whichever caller sent it.
    //
    // It cost Signals the most: every `tracked_company` and `competitor`
    // monitoring subject compiles to `known_companies`, so the two subject
    // kinds that make Signals *Signals* could not run at all.
    //
    // ── WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
    //
    // It puts the named companies into the ORDINARY pool and stops. It buys
    // nothing — this is the one capability that completes without a provider
    // call, because the mission already supplied its input — and it decides no
    // identity. Everything after it is the path an actor-discovered company
    // takes: prequalification scores it, the investigation slice selects it,
    // `company_identity_resolution` searches for it, and
    // `resolveIdentityAgainstLookups` applies the same rule to it as to
    // everyone else — A NAME ALONE NEVER RESOLVES.
    //
    // That last point is the whole design. A supplied bare name reaches
    // `ambiguous`, not `verified_match`, and an ambiguous identity is not
    // actionable, so nothing downstream enriches or verifies a company we
    // cannot prove we found. Supplying a domain or a LinkedIn URL is what
    // carries a company through — because those identify one, and a name
    // does not.
    if (cap === "known_company_resolution") {
      // ── A BOUND COMPANY IS NOT RESOLVED AGAIN ──────────────────────────
      //
      // The mission carries the safe semantic label — "Linear" — and without
      // the sidecar this stage could only put that NAME in the pool, leaving
      // `company_identity_resolution` to buy a LinkedIn search establishing an
      // identity the resolver already established deterministically, from a
      // result this system itself produced and the user pointed at.
      //
      // With the binding the row enters carrying its domain and canonical
      // LinkedIn URL, so the paid stage's own guard
      // (`!c.company.linkedin_company_url`) skips the call and
      // `resolveIdentityAgainstLookups` returns `verified_match` from the
      // supplied URL. One less provider call, and — more importantly — no
      // second chance for a name search to come back ambiguous about a company
      // that was never ambiguous.
      const supplied = normalizeSuppliedCompanies(
        opts.mission.company_profile?.known_companies ?? [],
        opts.bindings ?? [],
      );
      const before = companies.length;
      for (const s of supplied.companies) addCompany(companies, s.company, []);
      const added = companies.length - before;

      log("known_companies_seeded", {
        requested: (opts.mission.company_profile?.known_companies ?? []).length,
        usable: supplied.companies.length,
        added,
        rejected: supplied.rejected,
        // HOW MANY ARRIVED ALREADY IDENTIFIED. The difference between this and
        // `usable` is the number of paid identity lookups this run still owes.
        seeded_from_binding: supplied.seeded,
        // WHAT EACH ONE CAN ACHIEVE, stated before anything is spent. A pool of
        // bare names is a run that will end ambiguous, and that is worth
        // knowing from the log rather than from the empty result.
        by_kind: supplied.companies.reduce((acc: Record<string, number>, c) => {
          acc[c.kind] = (acc[c.kind] ?? 0) + 1;
          return acc;
        }, {}),
      });

      if (added === 0) {
        // NO COMPANIES IS NOT A COMPLETED CAPABILITY. The mission named none, or
        // named nothing usable; either way the pool is empty and saying
        // otherwise would let the downstream evidence gates read as satisfied.
        finish(cap, "skipped_no_input", 0, [], false,
          supplied.rejected.length > 0
            ? `no usable company in the supplied list (rejected: ${supplied.rejected.length})`
            : "the mission supplied no companies");
        continue;
      }
      // NO PROVIDER, SO NO PROVIDER IS NAMED. The evidence this capability owes
      // is "the named companies are in the pool", and they are.
      finish(cap, "complete", added, [], true, null);
      await publish("accounts_found");
      continue;
    }

    // ── IDENTITY ─────────────────────────────────────────────────────────────
    //
    // WHAT THIS REPLACED, AND WHY IT WAS WRONG.
    //
    // The previous route ran, for EVERY discovered company:
    //
    //     harvestapi/linkedin-company  with  { searches: [companyName] }
    //
    // `harvestapi/linkedin-company` is an ENRICHMENT actor. It resolves LinkedIn
    // company URLs into company records; it is not a name-search index. On TEST
    // task c8a6e53d that produced 16 sequential Actor starts, every one of them
    // returning zero rows, until the edge function hit its wall clock.
    //
    // The correct route is: search with the SEARCH actor, for the SHORTLIST
    // only, at most two at a time.
    if (cap === "company_identity_resolution") {
      const provider = "apify_linkedin_company_search";
      // TRIAGE AND BUDGET FIRST, whatever route produced this pool.
      await ensureMissionIntelligence(companies);
      // ONLY THE SLICE. A company nobody decided was worth identifying is never
      // paid for.
      //
      // This used to read `state.prequalification ? shortlisted : companies.slice()`,
      // and `state.prequalification` is set only by the YC branch — so every
      // other discovery route fell through to "everything is a target". That is
      // how a budget of 10 authorised 100 paid lookups. The fallback is gone:
      // `shortlisted` is the derived view of the investigation slice, and
      // `ensureMissionIntelligence` guarantees it has been computed.
      const targets = companies.filter((c) => c.shortlisted);
      // ── WHAT THIS SLICE INHERITED, AS OPPOSED TO WHAT IT WILL PRODUCE ────
      //
      // Captured before a single call is made, so `resolvedSoFar` below can mean
      // "resolved BY THIS SLICE" rather than "resolved ever". See the reserve's
      // comment at the threshold for why the difference decides whether a
      // continuation can do anything at all.
      const inheritedIdentityKeys = new Set(
        targets.filter((c) => c.identity && identityIsActionable(c.identity))
          .map((c) => c.key));
      let resolved = 0;
      let unresolved = 0;

      // COMPUTED HERE, FROM THE CLOCK AS IT IS NOW. Not read off the shortlist
      // decision: a continuation skips discovery entirely, so the capacity
      // recorded there belongs to a previous invocation with a different
      // window. What bounds this stage is the time THIS invocation has left.
      const timeCapacity = deps.deadline
        ? resolveTimeCapacity({
          remainingMs: deps.deadline.remainingMs(),
          reserveMs: deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS,
          concurrency: LINKEDIN_RESOLUTION_CONCURRENCY,
          enrichmentBatchSize: COMPANY_DETAILS_BATCH_SIZE,
          read: opts.readEnv,
          observedIdentityMs: deps.deadline.estimateFor(IDENTITY_SEARCH_OP),
          // THE DOMINANT COST, AND THE GATE'S OWN NUMBER FOR THE ONE AFTER IT.
          hiringMsPerCompany: HIRING_MS_PER_COMPANY,
          hiringBatchSize: HIRING_VERIFICATION_BATCH_SIZE,
          qualificationMs: deps.deadline.estimateFor(QUALIFICATION_OP),
        })
        : null;
      if (timeCapacity) state.investigation_capacity = timeCapacity;

      /** Resolve one company. Never more than `CONCURRENCY` of these in flight. */
      const resolveOne = async (c: EngineCompany): Promise<void> => {
        let lookups: Array<{ name: string | null; linkedinUrl: string | null; website: string | null }> = [];
        // Recorded AFTER the resolver has spoken, so the diagnostics can only
        // ever report the verdict the run acted on.
        let matchRecord: Parameters<typeof recordMatchDecisions>[2] | null = null;
        // ALREADY IDENTIFIED IS NOT WORTH PAYING FOR. memo23 has no LinkedIn
        // field, but a resumed run or another provider may have supplied one.
        if (!c.company.linkedin_company_url && c.company.company_name) {
          // Name, `full` rows, hard geography — see `buildIdentitySearchInput`.
          const compiled = buildIdentitySearchInput(c, opts.mission);
          // SCOPED TO THE COMPANY, so the resume guard can refuse it. Lossless:
          // a company this run already resolved carries its URL back in through
          // `restoreFromResume` and never reaches this branch, and a company a
          // previous run gave up on re-derives the same unresolved identity from
          // zero lookups — the outcome it already had, for nothing.
          const found = await callProvider(cap, provider, compiled, c);
          // ── NO CALL, NO VERDICT ──────────────────────────────────────────
          //
          // The reserve fired before this call, or the call failed. Either way
          // `found` is empty for a reason that has nothing to do with the
          // company. Falling through would hand zero lookups to
          // `resolveIdentityAgainstLookups`, which would return `unresolved` —
          // a TERMINAL state that stops the company being retried, ever. The
          // company keeps `identity === null` and is counted as unfinished
          // work below.
          if (c.stage_block?.capability === cap) {
            // NEVER ATTEMPTED, OR ATTEMPTED AND FAULTED. Both were invisible:
            // the company simply left the stage `unresolved`, which is the same
            // word used for "the provider answered and nothing matched". Three
            // very different facts under one label is why five audits could not
            // say whether a miss was retrieval, matching or the clock.
            recordRetrievalOutcome(state, c,
              c.stage_block.reason === "provider_error" ? "provider_error" : "not_attempted");
            return;
          }
          // A SEARCH THAT RETURNED NOTHING IS NOT A MATCH FAILURE. This is the
          // "genuinely missing identity" case, and `recordMatchDecisions` never
          // saw it — it is only called when candidates came back, so a company
          // LinkedIn has no page for looked exactly like one the matcher
          // refused.
          recordRetrievalOutcome(state, c,
            found.length === 0 ? "no_candidates" : "candidates_returned");
          lookups = found.map((f) => ({
            name: (f.name as string) ?? null,
            linkedinUrl: (f.linkedinUrl as string) ?? null,
            website: (f.website as string) ?? null,
          }));
          // A BARE NAME MATCH IS NOT AN IDENTITY. "Apollo", "Magic", "Hub" and
          // "Streak" are real YC companies and also ordinary words; accepting one
          // on name alone attaches a founder from the wrong company, which is
          // worse than returning nothing.
          if (c.prequalified) {
            const before = lookups.length;
            // ── THE VERDICT AND THE REASON FOR IT ────────────────────────
            //
            // This read `.accepted` and dropped `strength`, `reason` and now
            // `code` on the floor. TEST run 958c86bc rejected 9 of the 20
            // companies that reached a verdict — 45% — and no persisted record
            // said which of the four acceptance paths nearly fired or what
            // stopped it. The actor was never the problem: all 28 calls
            // succeeded and every one returned rows.
            //
            // Recorded, not acted on. Nothing about the decision changes here.
            const decisions = lookups.map((l, i) => ({
              candidate: acceptLinkedInMatch(c.prequalified!, {
                name: l.name, website: l.website, linkedinUrl: l.linkedinUrl,
                description: (found[i]?.description as string) ?? null,
                location: (found[i]?.location as string) ?? null,
              }),
              lookup: l,
            }));
            lookups = decisions.filter((d) => d.candidate.accepted).map((d) => d.lookup);
            if (before > 0) {
              matchRecord = decisions.map((d, rank) => ({
                code: d.candidate.code,
                accepted: d.candidate.accepted,
                candidate_name: d.lookup.name,
                candidate_slug: linkedInSlugToken(d.lookup.linkedinUrl),
                candidate_domain: d.lookup.website,
                // WHERE THE PROVIDER PUT IT. The question `maxItems` turns on:
                // a winner at rank 11 says 15 was the right ask and 5 was not;
                // winners never past rank 3 say we are paying for twelve rows
                // nobody reads. Neither is answerable from a match verdict.
                rank,
                // AND UNDER WHICH RETRIEVAL. Short and full are a 2x price
                // difference, and comparing their match rates across runs is
                // the only honest way to decide between them — the provider
                // returns different results for identical queries, so a single
                // run cannot settle it either way.
                retrieval_mode: SEARCH_SCRAPER_MODE,
              }));
            }
            if (before > 0 && lookups.length === 0) {
              c.record.missing_evidence.push("linkedin_match_rejected_weak");
            }
          }
        }
        c.identity = resolveIdentityAgainstLookups({
          company_key: c.key,
          name: c.company.company_name ?? null,
          website: c.company.canonical_domain ? `https://${c.company.canonical_domain}` : null,
          canonical_domain: c.company.canonical_domain ?? null,
          linkedin_company_url: c.company.linkedin_company_url ?? null,
        }, lookups);
        if (matchRecord) {
          recordMatchDecisions(state, c, matchRecord,
            { authoritativeVerified: identityIsActionable(c.identity) });
        }
        if (identityIsActionable(c.identity)) resolved++;
        else {
          unresolved++;
          // UNRESOLVED IS A HOLDING STATE, NOT A REJECTION — and NOT a retry
          // loop. It stays `identity_pending`, never reaches founder discovery,
          // and is reported as such rather than being asked again at a price.
          c.record = advance(c.record, "identity_pending", c.identity.status);
          c.record.missing_evidence.push(...c.identity.evidence);
        }
      };

      // ── IDENTITY MAY NOT SPEND THE WINDOW THE LATER STAGES NEED ───────────
      //
      // SCOPED TO THIS STAGE'S USE OF THIS PROVIDER. An unscoped `expired()`
      // compares the time left against the slowest call ANY stage has made — so
      // a 51s discovery start made a 9s identity search look unaffordable and
      // ended the stage with a third of the budget unspent. Scoping to the
      // provider fixed that for every Actor but the one this stage shares with
      // discovery; `IDENTITY_SEARCH_OP` finishes it.
      //
      // AND SCOPED TO THE WHOLE PIPELINE. A per-call estimate alone asks only
      // "is there room for one more search?", which on run ea2d02f2 was true
      // 12 times in a row until 114 of 125 seconds were gone — leaving 10.8s
      // against an 18s checkpoint reserve, so enrichment never ran, the five
      // resolved companies reached the evaluator with no enrichment evidence,
      // and the run qualified nobody. Every search was individually
      // affordable; the sequence was not.
      //
      // `identityStopThreshold` asks the second question: is there still room
      // to FINISH what we already hold? The reserve grows with each resolved
      // identity, so the stage stops on its own and the companies it never
      // reached are deferred — resumably, by the accounting directly below.
      const stopThreshold = () => {
        if (!timeCapacity) return 0;
        return identityStopThreshold({
          // ── THE RESERVE IS FOR THIS SLICE'S OWN WORK ────────────────────
          //
          // `downstreamReserveMs` is right to grow with held work: the stage
          // must stop while it can still afford to enrich and qualify what IT
          // resolved. The question was always which work that is.
          //
          // It was handed every actionable identity, which on a continuation
          // means the whole accumulated backlog — companies a previous
          // generation resolved and this one was never going to finish. That
          // assumes the entire backlog must clear inside one slice, and for a
          // pool larger than a slice it never can, so the reserve ratchets up
          // with cumulative progress until it exceeds any window:
          //
          //   gen 12   backlog 7   threshold 126,000 ms   usable 105,597 ms
          //   gen 16   backlog 6   threshold 114,000 ms   usable 105,000 ms
          //
          // Both stopped before their first call — `targets: 21, attempted: 0`
          // — while fourteen companies had never had a paid lookup, and each
          // spent a credit re-qualifying companies it already held. The further
          // lineage 862e81be got, the less it could do.
          //
          // A resolved-but-unenriched company is NOT stranded: the checkpoint
          // carries it and the next generation picks it up. That is what a
          // checkpoint is for, and the downstream stages have their own
          // deadline gates. So the backlog is explicitly the next slice's
          // problem, and this reserve covers only what this slice creates.
          //
          // IDENTICAL ON A FRESH RUN, where everything resolved IS new — so the
          // self-limiting property that run ea2d02f2 was missing is untouched:
          // ten fresh identities still reserve 162,000 ms and still stop the
          // stage. The two contracts differ only on a continuation.
          resolvedSoFar: targets.filter((c) =>
            c.identity && identityIsActionable(c.identity) &&
            !inheritedIdentityKeys.has(c.key)).length,
          capacity: timeCapacity,
          checkpointReserveMs: deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS,
          perCallEstimateMs: deps.deadline?.estimateFor(IDENTITY_SEARCH_OP) ?? 0,
        });
      };
      const bounded = await runBounded(targets, LINKEDIN_RESOLUTION_CONCURRENCY, resolveOne,
        () => {
          if (!deps.deadline) return false;
          // ── SCOPED TO THIS STAGE'S USE OF THE ACTOR, NOT THE ACTOR ────────
          //
          // `expired(provider)` was the previous fix and it stopped one level
          // short: discovery runs the SAME Actor over a whole pool, so its
          // twenty-second call was still the number a one-company lookup was
          // measured against. On task 43355471 that ended this stage after two
          // of ten companies with sixty seconds still on the clock.
          if (deps.deadline.expired(IDENTITY_SEARCH_OP)) return true;
          return deps.deadline.remainingMs() <= stopThreshold();
        });

      // ── WHAT DID NOT HAPPEN, RECORDED AS EXPLICITLY AS WHAT DID ────────────
      //
      // `runBounded` has always returned `{processed, skipped}` and the caller
      // has always thrown the second half away. Nine of twenty candidates on a
      // real run were selected, budgeted, and then never attempted — and the
      // capability still reported `complete`, so a resume skipped the whole
      // stage and those nine were lost permanently.
      //
      // Membership is derived from the COMPANIES, not from the count: a company
      // with no identity and no terminal answer is unfinished, whichever lane
      // did or did not claim it.
      const providerFailed = targets.filter(
        (c) => c.identity === null && c.stage_block?.reason === "provider_error");
      const deferredTargets = targets.filter(
        (c) => c.identity === null && c.stage_block?.reason !== "provider_error");
      for (const c of deferredTargets) {
        // MARKED EVEN WHEN NO LANE EVER CLAIMED IT. A company `runBounded` never
        // reached has no `stage_block` from `callProvider`, because no call was
        // made for it at all — it would otherwise persist as `not_started`,
        // which is indistinguishable from a company nobody has scheduled yet.
        // Setting it here is what makes "budgeted and abandoned" a state the
        // checkpoint can carry.
        c.stage_block ??= { capability: cap, reason: "deferred" };
        // A HOLDING STATE THAT NAMES ITS CAUSE. Not "unresolved" — nothing was
        // asked — and not silence, which is what made these companies vanish.
        c.record = advance(c.record, "identity_pending", "identity_resolution_deferred");
        c.record.missing_evidence.push("identity_resolution_deferred");
      }
      for (const c of providerFailed) {
        c.record = advance(c.record, "identity_pending", "identity_provider_error");
        c.record.missing_evidence.push("identity_provider_error");
      }

      // Companies that were never shortlisted are explicitly not evaluated. They
      // must not look like failed lookups, and they must never be actionable.
      for (const c of companies) {
        if (targets.includes(c) || c.identity) continue;
        c.record = advance(c.record, "identity_pending", "not_shortlisted_for_paid_resolution");
        c.record.missing_evidence.push(
          c.prequalified?.exclusion
            ? `excluded_before_paid_resolution:${c.prequalified.exclusion}`
            : "excluded_before_paid_resolution",
        );
      }

      // ── PARTIAL EXECUTION IS NOT COMPLETE EXECUTION ───────────────────────
      //
      // THE INVARIANT THIS STAGE BROKE. `complete` used to be unconditional,
      // with `evidence_satisfied = resolved > 0` — so ONE successful lookup out
      // of twenty marked the capability done. `finish` then moved it to
      // `completed_capabilities`, and the resume guard skips anything listed
      // there. Eleven attempted, nine never touched, and the run reported the
      // stage finished.
      //
      // A capability is complete only when every target reached a TERMINAL
      // state: resolved, or answered-and-unmatched. Deferred and provider-error
      // candidates are neither, so the capability stays `incomplete` — which
      // keeps it in `pending_capabilities`, makes the run `partial` and
      // resumable, and lets a continuation finish exactly the candidates that
      // were left. Companies already resolved are protected from being re-paid
      // for by `shouldSkipProviderCall`, not by pretending the stage was done.
      const unfinished = deferredTargets.length + providerFailed.length;
      const truncated = unfinished > 0;
      finish(cap, truncated ? "incomplete" : "complete", resolved, [provider],
        truncated ? false : resolved > 0,
        truncated
          ? `${resolved} resolved, ${deferredTargets.length} deferred, ` +
            `${providerFailed.length} provider error; ${unfinished} of ` +
            `${targets.length} target(s) never reached a terminal state`
          : resolved === 0 ? "no company reached an actionable identity" : null);
      log("identity_resolution_complete", {
        targets: targets.length, resolved, unresolved,
        // THE COUNTS THAT WERE PREVIOUSLY DISCARDED.
        deferred: deferredTargets.length,
        provider_errors: providerFailed.length,
        attempted: bounded.processed,
        unattempted: bounded.skipped,
        truncated,
        deferred_company_keys: deferredTargets.map((c) => c.key),
        concurrency: LINKEDIN_RESOLUTION_CONCURRENCY,
      });
      // WHY, not just how many. Every Actor call on run 958c86bc succeeded and
      // returned rows, so an `unresolved` count on its own describes nothing.
      if (state.identity_match_diagnostics) {
        log("identity_match_outcomes", {
          judged: state.identity_match_diagnostics.companies_judged,
          accepted: state.identity_match_diagnostics.companies_accepted,
          rejected: state.identity_match_diagnostics.companies_rejected,
          by_code: state.identity_match_diagnostics.by_code,
          // The two that decide `maxItems` and the retrieval depth.
          accepted_ranks: state.identity_match_diagnostics.accepted_rank_histogram,
          retrieval_modes: state.identity_match_diagnostics.retrieval_modes,
          // Retrieval vs matching vs fault vs clock — four facts that were one
          // word.
          retrieval: state.identity_match_diagnostics.retrieval_outcomes,
        });
      }
      await publish("identity_resolved");
      continue;
    }

    // ── ENRICHMENT (MANDATORY, BEFORE QUALIFICATION) ─────────────────────────
    // ONE CALL FOR ALL RESOLVED COMPANIES, NOT ONE CALL EACH.
    //
    // `harvestapi/linkedin-company` takes `companies[]` — a LIST of LinkedIn
    // company URLs. The per-company loop this replaced paid a full Actor start
    // for every single company and spent the wall clock the run needed to finish.
    if (cap === "company_enrichment") {
      let enriched = 0;
      // ── ALREADY ENRICHED IS NOT ACTIONABLE ────────────────────────────────
      //
      // ── THE RUN THIS EXISTS FOR ───────────────────────────────────────────
      //
      // Task ecb9afe9, 2026-09-01. Four batches of ten companies were bought
      // 8, 7, 5 and 4 times — 51 real Apify runs where 31 were owed, about
      // $0.80 of external spend on one mission. Every duplicate was
      // `apify_linkedin_company_details` and none was the job search, because
      // hiring has its own operation-key guard and this stage has none:
      //
      //   `shouldSkipProviderCall` needs an `operationKey`, which needs a
      //   `company` — and the enrichment call is BATCHED, so it passes none.
      //   `completed_operations` is written under the same condition, so the
      //   purchase is never recorded either. `deps.callCompleted` would have
      //   caught it and is supplied only by tests.
      //
      // With all three inert, the only thing deciding whether to re-buy was
      // this filter, and it asked about identity alone. Every slice therefore
      // re-batched every resolved company, however thoroughly it had already
      // been enriched. The internal ledger deduplicated on `idempotency_key`
      // so no credit was double-charged; Apify billed every run.
      //
      // The cost is O(slices x batches), which is why this stayed invisible
      // while continuations did no real work and appeared the moment they did.
      //
      // `enriched` is carried on the checkpoint snapshot and restored by BOTH
      // resume paths, so this holds across slices and not merely within one.
      // It was one path for a while — `restoreWorkingSet`, taken when discovery
      // is skipped — and `restoreFromResume`, taken when discovery re-runs, did
      // not assign it. That gap re-bought this batch once per continuation for
      // the life of any lineage that rediscovered; see the note there.
      const actionable = companies.filter((c) =>
        c.identity && identityIsActionable(c.identity) && !c.enriched);
      // DEDUPED. Two YC rows can resolve to one LinkedIn company; enriching it
      // twice pays twice for the same record.
      const byUrl = new Map<string, EngineCompany[]>();
      for (const c of actionable) {
        const url = c.identity?.linkedin_company_url ?? c.company.linkedin_company_url;
        if (!url) continue;
        const list = byUrl.get(url) ?? [];
        list.push(c);
        byUrl.set(url, list);
      }
      const urls = [...byUrl.keys()];

      if (urls.length > 0) {
        // BOUNDED BATCHES, not an unbounded single request. One batch is the
        // normal case for a shortlist of five; the bound exists so a larger
        // mission degrades into a few calls rather than one request the Actor
        // rejects.
        for (const batch of chunk(urls, COMPANY_DETAILS_BATCH_SIZE)) {
          const compiled = compileHarvestCompanyDetailsInput({ companies: batch });
          const rows = await callProvider(cap, "apify_linkedin_company_details", compiled);
          const enrichedBy = observedBy(cap, "apify_linkedin_company_details");
          // ── WHY THIS BATCH PRODUCED NOTHING ─────────────────────────────────
          //
          // Read IMMEDIATELY after the call and scoped to THIS batch's
          // companies. `callProvider` clears `lastCallBlock` on entry, so it
          // describes this call and no other; the enrichment call is batched and
          // passes no `company`, so without this the block it recorded would be
          // attributed to nobody and every company in a deferred batch would
          // fall through to `empty` — a run fact rendered as a company fact.
          const blocked = lastCallBlock;
          if (blocked) {
            for (const url of batch) {
              for (const c of byUrl.get(url) ?? []) {
                if (c.enriched) continue;
                c.enrichment_outcome = blocked;
                // SCOPED TO THIS CAPABILITY, so an enrichment failure can never
                // be read back as an identity outcome. Identity is already
                // resolved for every company here, so there is no earlier block
                // worth preserving.
                c.stage_block = { capability: cap, reason: blocked };
              }
            }
            // A DEFERRED BATCH ENDS THE STAGE. The reserve exists so there is
            // time to write a checkpoint; spending it on the next batch is
            // precisely what it forbids.
            if (blocked === "deferred") break;
            continue;
          }
          // MAPPED BACK BY URL. A batched response arrives in the Actor's order,
          // not ours, so pairing by index would attach one company's evidence to
          // another — a silent, unfalsifiable corruption.
          //
          // ── A REDIRECTED PAGE IS STILL THE PAGE WE ASKED FOR ────────────────
          //
          // Canary 1, production 2026-09-30 (task 9982ca62): the mission gave
          // /company/wordware; LinkedIn now redirects it to the rebranded
          // /company/saunabywordware, and the Actor returned THAT url. Matching
          // on the returned url alone attached the record to nobody, the company
          // stayed `empty`, qualification never reached it, and no claim
          // verifier ran. The Actor echoes the url it was asked for as
          // `originalQuery.search` — exact provenance, not a guess — so a row
          // whose own url matches nothing is attached by what it was asked for,
          // and only ever to a url in THIS batch.
          const batchByCanonical = new Map<string, string>();
          for (const u of batch) batchByCanonical.set(normalizeCompanyLinkedInUrl(u) ?? u, u);
          for (const row of rows) {
            const normalized = normalizeLinkedInCompanyEnriched(row);
            const url = normalized.linkedin_company_url;
            let matches = url ? byUrl.get(url) ?? batchKeyMatches(byUrl, batchByCanonical, url) : [];
            if (matches.length === 0) {
              const asked = requestedCompanyUrlOf(row);
              const key = asked ? batchByCanonical.get(asked) : undefined;
              if (key) {
                matches = byUrl.get(key) ?? [];
                if (matches.length > 0 && url && url !== asked) {
                  log("company_enrichment_redirect_adopted", { requested: asked, returned: url });
                }
              }
            }
            // ── THE MEMBER-COUNT READING, KEPT ──────────────────────────
            //
            // This actor returns `employeeCount` — LinkedIn associated members,
            // not staff (companySize.ts) — and until now the run discarded it.
            // Growth is a delta between two dated readings, so discarding the
            // first is precisely why `headcount_change` has never been
            // answerable for any company.
            //
            // The row is BUILT here and written by the caller: the engine takes
            // no database dependency, and `buildSnapshotRow` refuses anything
            // that is not a member count read from the company record.
            {
              const snap = buildSnapshotRow({
                workspace_id: opts.identity?.workspace_id ??
                  opts.resume?.workspace_id ?? "",
                linkedin_company_url: normalized.linkedin_company_url,
                canonical_domain: normalized.canonical_domain,
                company_name: normalized.company_name,
                linkedin_associated_member_count: normalized.linkedin_associated_member_count,
                source: "apify_linkedin_company_details",
                task_id: opts.identity?.task_id ?? null,
              });
              if (snap.row && !isSameDayDuplicate(snap.row, headcountSnapshots)) {
                headcountSnapshots.push(snap.row);
              }
            }
            for (const c of matches) {
              c.enriched = normalized;
              c.enrichment_outcome = "success";
              // P4: enrichment is one more source's statement about the company,
              // kept beside discovery's — never folded into it.
              recordObservation(c, compactObservation(observationFromCompany(normalized, enrichedBy)));
              // THE BLOCK IS CLEARED BY AN ANSWER. A company whose earlier batch
              // errored and whose retry succeeded is not blocked.
              if (c.stage_block?.capability === cap) c.stage_block = null;
              c.record = advance(c.record, "enrichment_complete", "provider_evidence_collected");
              enriched++;
            }
          }
          // ANSWERED, AND NOT IN THE ANSWER. The one outcome here that is
          // genuinely about the company: the provider was asked and has no
          // record of it. Still not a rejection — it is an absence of evidence,
          // and qualification holds on it rather than deciding.
          for (const url of batch) {
            for (const c of byUrl.get(url) ?? []) {
              if (c.enriched || c.enrichment_outcome !== "not_attempted") continue;
              c.enrichment_outcome = "empty";
            }
          }
        }
      }
      for (const c of actionable) {
        if (c.enriched) continue;
        c.record = advance(c.record, "enrichment_pending",
          `enrichment_${c.enrichment_outcome}`);
      }
      const enrichmentOutcomes = summariseEnrichmentOutcomes(
        actionable.map((c) => c.enrichment_outcome));
      // ── PARTIAL EXECUTION IS NOT COMPLETE EXECUTION ───────────────────────
      //
      // The same invariant identity resolution already holds. A company whose
      // enrichment was DEFERRED or ERRORED never reached a terminal state, so
      // the capability is incomplete: it stays pending, the run stays resumable,
      // and a continuation buys exactly the evidence that is still missing.
      // Marking it complete would move it to `completed_capabilities`, where the
      // resume guard skips it — stranding those companies permanently on an
      // outcome that was never about them.
      const unenriched = actionable.filter(
        (c) => !enrichmentIsTerminal(c.enrichment_outcome)).length;
      const truncated = unenriched > 0;
      // EVIDENCE GATE. Enrichment that produced nothing is not enrichment, and
      // qualification must see that rather than an empty record it could read as
      // a proven negative.
      finish(cap, truncated ? "incomplete" : "complete", enriched,
        ["apify_linkedin_company_details"], truncated ? false : enriched > 0,
        truncated
          ? `${enriched} enriched, ${enrichmentOutcomes.deferred} deferred, ` +
            `${enrichmentOutcomes.provider_error} provider error; ${unenriched} of ` +
            `${actionable.length} company(ies) never reached a terminal state`
          : enriched === 0
            ? "no company was enriched; qualification will hold them as unknown"
            : null);
      log("company_enrichment_complete", {
        resolved_urls: urls.length,
        actor_starts: Math.ceil(urls.length / COMPANY_DETAILS_BATCH_SIZE),
        enriched,
        // THE COUNTS THAT WERE PREVIOUSLY COLLAPSED INTO ONE `null`.
        outcomes: enrichmentOutcomes,
        truncated,
        deferred_company_keys: actionable
          .filter((c) => c.enrichment_outcome === "deferred").map((c) => c.key),
      });
      await publish("companies_enriched");
      continue;
    }

    // ── HIRING VERIFICATION ──────────────────────────────────────────────────
    // ── HIRING VERIFICATION — FREE EVIDENCE FIRST ────────────────────────────
    //
    // THIS IS THE GATE THAT SENT ZERO COMPANIES TO THE COMPANY BRAIN.
    //
    // It used to filter the YC `openJobs` it already held through
    // `DEFAULT_ROLE_PACKS`, whose Sales-Ops pack lists only four literal titles
    // ("Sales Operations Manager", …). "Head of Sales", "GTM Engineer" and
    // "Founding Account Executive" — the very roles prequalification had just
    // scored Tier A — matched none of them. So the free evidence was discarded,
    // a paid LinkedIn job search was bought per company, those results were
    // filtered through the same narrow packs (3 searches, 12 rows, 0 kept), and
    // the deadline closed at 109s with four companies never reached.
    //
    // The canonical policy is now the only vocabulary, and paid verification is
    // a fallback for the lone-Tier-B case alone.
    if (cap === "hiring_verification") {
      // ── THE CHAIN MAY SAY THIS STEP IS ALREADY ANSWERED ──────────────────
      //
      // The one decision that genuinely needed to be made ACROSS capabilities.
      // Whether a paid job search is worth buying depends entirely on what the
      // discovery Actor returned: memo23 carries every company's full `openJobs`
      // array, so for a hiring mission served by it this stage re-buys evidence
      // already in hand — and `buildCapabilityGraph` scheduled it from mission
      // fields, before any Actor had been chosen, so it could not know.
      //
      // A chain that omits it has said "an earlier step proves this". A chain
      // that includes it has said the opposite. Either way the reasoning is
      // recorded, and the free assessment below still runs on every route.
      // P3: "first in the function" is not a hiring re-purchase. When the
      // mission asked for it and the graph granted the team lookup, the stage
      // runs anyway (canary 2a215d44: the chain omitted it and the first-hire
      // check never happened). Paid job re-searches stay suppressed for
      // job-sourced employers, so the chain's cost decision still holds.
      const firstHireCheckOwed = firstInFunctionRequested(opts.mission) &&
        !!opts.plan.steps.find((st) => st.capability === cap)?.providers.includes("apify_linkedin_company_employees");
      if (chainSkips(cap) && !firstHireCheckOwed) {
        finish(cap, "skipped_no_input", 0, [], false,
          "the planned chain proves hiring from evidence an earlier step already " +
          "returned; a paid verification would re-buy it");
        log("hiring_verification_skipped_by_chain", {
          reasoning: executionPlan?.reasoning?.slice(0, 300) ?? null,
        });
        continue;
      }
      const targets = companies.filter((c) => c.identity && identityIsActionable(c.identity));
      let verified = 0, review = 0, watch = 0, notVerified = 0, paidCalls = 0;
      // Companies this pass could not find out about. Counted separately from
      // `notVerified` because they are not a verdict — they are the frontier.
      let unavailable = 0;

      // ── ONE QUESTION, ASKED FOR TEN COMPANIES AT A TIME ─────────────────
      //
      // This asked the provider once PER COMPANY. The Actor accepts
      // `company[]` up to 10 (`compileHarvestJobSearchInput` validates it), and
      // a single call takes ~48s whether it carries one company or ten — so a
      // slice that could afford one paid search answered one company and left
      // the rest unassessed. Run 07e973f1: eleven companies enriched, ONE
      // hiring call, "the eligible set was empty (29 companies carried no
      // hiring assessment)", nothing qualified.
      //
      // The semantics are unchanged. Every company is judged by
      // `freeHiringAssessment` first, exactly as before, and the paid rows only
      // ever UPGRADE a verdict. What changes is how many HTTP calls carry the
      // same twenty titles.
      //
      // EVIDENCE IS PARTITIONED BY COMPANY, NEVER SHARED. Each returned job row
      // names its own `company_linkedin_url`, so rows are routed back to the
      // company they belong to and a company that got no rows gets none. One
      // company's opening can never earn another company's verdict.
      const BATCH = HIRING_VERIFICATION_BATCH_SIZE;

      // ── THE TITLES THIS MISSION IS ACTUALLY LOOKING FOR ─────────────────
      //
      // Derived ONCE, from the same vocabulary the assessment scores against,
      // and read by both the provider call and the operation key that decides
      // whether to make it. Those two must never disagree: a key fingerprinted
      // over a different list than the call uses would skip work that was
      // never done.
      const searchTitles = hiringSearchTitles(qualificationCtx.role_vocabulary);
      log("hiring_search_vocabulary", {
        source: qualificationCtx.role_vocabulary.source,
        titles: searchTitles.length,
        leading: searchTitles.slice(0, 6),
      });

      /** The paid rows that belong to each company, keyed by company key. */
      const batchedJobs = new Map<string, NormalizedHiringJob[]>();
      /** Companies the provider was actually asked about on this pass. */
      const asked = new Set<string>();

      /**
       * The operation key for asking the jobs question about ONE company.
       *
       * Deliberately fingerprinted on the SINGLE-company input rather than the
       * batch it happened to travel in. Batch composition changes between
       * slices — ten remaining, then one — and a key derived from it would
       * differ every time, so a continuation would re-POST companies already
       * answered. Keying per company makes a partially completed batch resume
       * exactly: the answered companies are skipped, the rest are re-batched.
       */
      const hiringOperationKey = (c: EngineCompany, url: string): string | null =>
        resumeScope
          ? providerOperationKey({
            workspace_id: resumeScope.workspace_id,
            lineage_root_task_id: resumeScope.lineage_root_task_id,
            company_key: c.key,
            capability: cap, provider: "apify_linkedin_job_search",
            input_fingerprint: inputFingerprint({
              company: [url], jobTitles: searchTitles,
              ...(opts.postedLimit ? { postedLimit: opts.postedLimit } : {}),
            }),
          })
          : null;

      // ── A BLOCK BELONGS TO THE SLICE THAT RECORDED IT ────────────────────
      //
      // `stage_block` says "this slice ran out of time / credit / patience for
      // this company". It travels in the resume snapshot, so a NEW slice
      // restores the previous one's block — and the deferral guards below would
      // then skip the company for ever, which is the opposite of what a
      // deferral means. Cleared here, at the start of the stage that is about
      // to re-attempt it: this slice has its own clock and will record its own
      // block if it runs out again.
      for (const c of targets) {
        if (c.stage_block?.capability === cap) c.stage_block = null;
      }

      // WHO STILL NEEDS ASKING. Evaluated before any batching so the skip
      // reasons are per company and unchanged: a company whose verdict is
      // already settled by free evidence is not paid for, and one a previous
      // slice already asked about is not asked again.
      // P3: a company found by the job search was already answered by it.
      const toCheck = targets.filter((t) => !jobSourced(t));
      const needsPaid: Array<{ c: EngineCompany; url: string; opKey: string | null }> = [];
      // ── UNDER THE SPEC SPINE, THIS STAGE BUYS NOTHING ──────────────────────
      //
      // It bought a job search for EVERY identity-resolved company, before
      // country, size band, business model or funding were grounded — a company
      // already disproven on country still paid for one (pre-canary compile,
      // 2026-09-24). Under Lead V2 a paid hiring check is the open-role CLAIM
      // VERIFIER's (`hiringClaimVerifier.ts`): bought only for a still-viable
      // candidate whose HARD hiring claim is open, after the cheaper claims are
      // settled, ordered by its real estimate. Free evidence a company already
      // carries is still assessed below; only the purchase moved. Legacy
      // (non-spec) runs are unchanged.
      const claimVerifierOwnsPaidHiring = specOn;
      if (claimVerifierOwnsPaidHiring) {
        log("hiring_purchase_deferred_to_claim_verifier", {
          companies: toCheck.length,
          reason: "paid hiring is bought per viable candidate by the open-role claim verifier",
        });
      }
      for (const c of claimVerifierOwnsPaidHiring ? [] : toCheck) {
        // Named `assessment` deliberately: the paid-search gate below is the
        // same expression the per-company loop used, and
        // `commercialPolicyAndPortfolio` pins it by name as the guarantee that
        // a paid search stays gated on the lone-Tier-B case.
        const assessment = freeHiringAssessment(c);
        const jobEvidenceNeverCollected =
          c.yc_open_jobs.length === 0 &&
          !actorAnsweredHiring(String(c.company.source_provenance ?? ""));
        if (!(needsPaidJobVerification(assessment) || jobEvidenceNeverCollected)) continue;
        const url = c.identity?.linkedin_company_url ?? c.company.linkedin_company_url;
        if (!url) continue;
        const opKey = hiringOperationKey(c, url);
        if (opKey) {
          const verdict = shouldSkipProviderCall(priorRecords.get(c.key), opKey);
          if (verdict.skip) {
            log("hiring_paid_skipped_resume_reuse",
              { company_key: c.key, reason: verdict.reason });
            continue;
          }
          if (c.completed_operations.includes(opKey)) continue;
        }
        needsPaid.push({ c, url, opKey });
      }

      /** Companies whose verdict has been written on this pass. */
      const assessed = new Set<string>();

      /**
       * Decide ONE company, from whatever evidence it now holds.
       *
       * Extracted so it can run the moment a batch is answered rather than only
       * after every batch. See the checkpoint below the batch loop.
       */
      const assessOne = (c: EngineCompany): void => {
        if (assessed.has(c.key)) return;
        // ── A COMPANY WHOSE PAID CHECK IS STILL IN FLIGHT HAS NO VERDICT ──
        //
        // Its batch went pending, so the provider has not answered. Writing
        // ANY `hiring_assessment` here — even the free one — makes
        // `toResumeRecord` report a hiring stage other than `not_started`, and
        // only `not_started` is resumable. Run 8f59170d resolved Sortly to
        // `not_verified` this way: the continuation then skipped hiring
        // altogether, never adopted the pending run, and investigated nobody.
        //
        // Leaving the assessment unset is what keeps the company on the
        // frontier with the run still adoptable.
        if (c.stage_block?.capability === cap && c.stage_block.reason === "deferred") {
          return;
        }
        let assessment = freeHiringAssessment(c);
        /** Rows the paid search returned, kept so the verdict can cite them. */
        let externalJobs: NormalizedHiringJob[] = [];
        let verdictFromExternal = false;

        // THIS COMPANY'S ROWS, AND ONLY THIS COMPANY'S.
        const mine = batchedJobs.get(c.key) ?? [];
        if (mine.length > 0) {
          externalJobs = mine;
          const external = assessHiring(
            externalJobs.map((j) => ({
              title: j.title ?? "", url: j.job_url, location: j.location })),
            [...assessment.supporting_signals, "another_active_gtm_opening"],
            // SAME VOCABULARY AS THE FREE PASS. An external check that judged
            // on a different role list could contradict evidence the free pass
            // already accepted, which is the divergence
            // `commercialSignalPolicy` exists to prevent.
            { source: "external_job_search", vocab: qualificationCtx.role_vocabulary });
          // The external pass only ever UPGRADES; it cannot demote evidence the
          // free pass already accepted.
          if (external.verdict === "hiring_verified") {
            assessment = external;
            verdictFromExternal = true;
          }
        }

        // ── EVIDENCE IS MONOTONIC ─────────────────────────────────────
        //
        // A company already verified WITH CITATIONS may not be talked out of it
        // by a pass that inspected nothing. This is the shape of the 2026-08-29
        // loss reduced to one company: Blue Signal Search held a
        // `hiring_verified` assessment citing 13 job rows, a later pass ran the
        // free assessor over a working set that no longer carried them, and the
        // result — "No open roles at all", `evidence_source: "none"` — replaced
        // it.
        //
        // Narrow on purpose. Only a verdict backed by cited rows is protected,
        // and only from an assessment that cites nothing; a pass that DID
        // inspect evidence may still change the answer, because that is a real
        // second opinion rather than an absence.
        const priorWasCited = c.hiring_assessment?.verdict === "hiring_verified" &&
          (c.hiring_assessment?.evidence_source ?? "none") !== "none" &&
          c.hiring_jobs.length > 0;
        if (priorWasCited && assessment.evidence_source === "none") {
          log("hiring_verdict_downgrade_refused", {
            company_key: c.key,
            kept: c.hiring_assessment?.verdict,
            cited_rows: c.hiring_jobs.length,
          });
          assessed.add(c.key);
          return;
        }

        c.hiring_assessment = assessment;
        // The pool that actually earned the verdict — see `hiringJobsFor`.
        c.hiring_jobs = verdictFromExternal
          ? hiringJobsFor(c, assessment, externalJobs)
          : hiringJobsFor(c, assessment);

        if (assessment.verdict === "hiring_verified") {
          c.record = advance(c.record, "hiring_verified",
            assessment.evidence_source === "yc_open_jobs"
              ? "yc_open_jobs_sufficient" : "job_evidence_present");
          verified++;
        } else if (assessment.verdict === "hiring_verification_needed") {
          review++;
          c.record.stage_reason = `hiring_verification_needed:${assessment.reason}`;
        } else if (assessment.verdict === "watch") {
          watch++;
          c.record.stage_reason = `hiring_watch:${assessment.reason}`;
        } else if (hiringEvidenceWasInspected(c) || asked.has(c.key)) {
          notVerified++;
          // A COMPANY THE PROVIDER ANSWERED ABOUT IS INVESTIGATED, EVEN AT ZERO.
          // "We asked and there are no matching roles" is a finding; leaving it
          // indistinguishable from "nobody looked" is what emptied the eligible
          // set on run 07e973f1.
          c.record = advance(c.record, "hiring_not_verified",
            asked.has(c.key) ? "job_search_returned_no_matching_role" : "no_matching_open_role");
          c.record.stage_reason = assessment.reason;
        } else {
          // ── NOBODY LOOKED, SO NOBODY MAY CONCLUDE ────────────────────
          //
          // The distinction this branch exists for was already present one line
          // above, in the REASON — `job_search_returned_no_matching_role` when
          // asked, `no_matching_open_role` when not — and both advanced the
          // record to the same terminal stage anyway. The reason was honest and
          // the state was not.
          //
          // `hiring_not_verified` is in `TERMINAL_STAGES`, so writing it here
          // ended companies whose evidence had been bought and never read: 83
          // rows for Blue Signal Search, 90 for Pursuit and Coda Search. The
          // record is left where it is, which keeps the company on the frontier
          // for the slice that comes back for those datasets.
          unavailable++;
          c.record.stage_reason =
            `hiring_evidence_unavailable:${assessment.reason}`;
        }
              assessed.add(c.key);
      };

      // ── A RUN ALREADY IN FLIGHT DECIDES ITS OWN BATCH ────────────────────
      //
      // Adoption matches on the fingerprint of the WHOLE compiled input, so a
      // pending run is only adopted by a call that asks about the same
      // companies in the same order. Batch composition is not stable across
      // slices — resolve one more identity and every group shifts — so a
      // finished, paid run gets passed over and its question is bought again.
      //
      // Task 40800420 → 084fb495: `4LfrXM2viPf7imV8O` was pending for
      // [pursuit-sales-solutions] and the continuation batched
      // [pursuit, hirefeedd, talentoma]. `1CPaI8ikFskPx4Fam` held 101 rows for
      // [storm4, pursuit, careerxperts] and was passed over for a batch
      // starting [hirefeedd, …].
      //
      // So the in-flight batches are re-formed FIRST, exactly as recorded, and
      // everything else is batched around them. `hiringOperationKey` already
      // reasons this way from the other side — it is keyed per company
      // precisely because "batch composition changes between slices".
      const inFlightGroups: Array<typeof needsPaid> = [];
      const claimed = new Set<string>();
      for (const r of opts.state?.pending_runs ?? []) {
        if (r.provider !== "apify_linkedin_job_search") continue;
        const keys = r.company_keys ?? [];
        if (keys.length === 0) continue;
        // EVERY company must still be waiting, or this is a different question.
        // MATCHED LOOSELY ON PURPOSE. An entry written by the engine holds
        // `c.key`; one rebuilt by `recoverPendingRuns` holds the URL the Actor
        // was sent. They are the same company and usually the same string, but
        // case and a trailing slash are not worth losing a paid run over.
        const sameCompany = (a: string, b: string) =>
          a === b || normalizeCompanyLinkedInUrl(a) === normalizeCompanyLinkedInUrl(b);
        const reformed = keys.map((k) => needsPaid.find(
          (n) => sameCompany(n.c.key, k) && !claimed.has(n.c.key)));
        if (reformed.some((x) => !x)) continue;
        const group = reformed as typeof needsPaid;
        for (const g of group) claimed.add(g.c.key);
        inFlightGroups.push(group);
        log("hiring_batch_reformed_for_adoption",
          { run_id: r.run_id, companies: keys.length });
      }
      const batches: Array<typeof needsPaid> = [...inFlightGroups];
      const rest = needsPaid.filter((n) => !claimed.has(n.c.key));
      for (let i = 0; i < rest.length; i += BATCH) batches.push(rest.slice(i, i + BATCH));

      for (let i = 0; i < batches.length; i++) {
        // THE CLOCK IS CHECKED PER BATCH, not per company. A batch costs one
        // call, so one batch's worth of budget is what has to be available.
        //
        // AND THE QUESTION IS "CAN WE START IT", NOT "CAN WE FINISH IT". At
        // ~80s per company this call is longer than a slice at ANY batch size
        // (see `HIRING_MS_PER_COMPANY`), so `expired("apify_linkedin_job_search")`
        // asks something that can never be true late in a slice and would defer
        // hiring verification for ever. The run id is persisted before the poll,
        // so a slice killed while waiting loses nothing and the next one adopts
        // the run for free — which makes starting safe and finishing optional.
        // ── AND WHAT THIS BATCH WILL OWE AFTERWARDS ──────────────────────
        //
        // `expiredForDurableStart` asks only whether the CALL can be recorded.
        // It cannot see that this slice already holds verified companies with
        // nobody to qualify them. Hiring is greedy until it produces something,
        // then it yields — see `canStartHiringBatch`.
        const awaitingQualification = companies.filter((c) =>
          c.hiring_assessment !== null && reachesCompanyBrain(c.hiring_assessment) &&
          c.brain === null).length;
        // ── THE TWO-CALL PRICE, AND IT IS THE RIGHT ONE HERE ────────────────
        //
        // Admission prices each company on its OWN operation, because a company
        // the Stage-2 batch already grounded needs one evaluator call rather
        // than two. That distinction cannot be made at this point in the slice:
        // `groundedByKey` is built INSIDE the qualification capability, which
        // has not run yet, so no company awaiting the Brain is pre-grounded and
        // every one of them will be admitted under `QUALIFICATION_OP`.
        //
        // This is planning, not admission — how much clock to leave behind for
        // N companies — and quoting the two-call price is both accurate here and
        // the safe direction if grounding later makes one of them cheaper.
        const qualificationDebtMs =
          awaitingQualification * (deps.deadline?.estimateFor(QUALIFICATION_OP) ?? 0);
        const batchGate = canStartHiringBatch({
          remainingMs: deps.deadline?.remainingMs() ?? Number.MAX_SAFE_INTEGER,
          qualificationDebtMs,
          reserveMs: deps.checkpointReserveMs ?? QUALIFICATION_RESERVE_MS,
          durableStartMs: DURABLE_START_MS,
        });
        if (deps.deadline?.expiredForDurableStart() || !batchGate.start) {
          log("hiring_batch_deferred_for_deadline", {
            remaining: batches.slice(i).reduce((n, b) => n + b.length, 0),
            reason: batchGate.start ? "no_durable_start" : batchGate.reason,
            awaiting_qualification: awaitingQualification,
            required_ms: batchGate.required_ms,
            remaining_ms: batchGate.remaining_ms,
          });
          break;
        }
        const group = batches[i];
        const compiled = compileHarvestJobSearchInput({
          company: group.map((g) => g.url),
          jobTitles: searchTitles,
          maxItems: HIRING_JOBS_PER_BATCH_COMPANY * group.length,
          ...(opts.postedLimit ? { postedLimit: opts.postedLimit } : {}),
        });
        const rows = await callProvider(cap, "apify_linkedin_job_search", compiled,
          undefined, group.map((g) => g.c.key));
        paidCalls++;

        // ROUTED BACK BY IDENTITY. `normalizeLinkedInJob` carries the row's own
        // `company_linkedin_url`, so a row can only ever reach the company it
        // names. A row naming a company outside this batch is dropped rather
        // than attributed to whoever happens to be nearby.
        const byUrl = new Map<string, EngineCompany>();
        for (const g of group) {
          const k = normalizeCompanyLinkedInUrl(g.url);
          if (k) byUrl.set(k, g.c);
        }
        for (const raw of rows) {
          if (jobEmployerIdentityConflict(raw)) continue;
          const j = normalizeLinkedInJob(raw);
          const owner = j.company_linkedin_url ? byUrl.get(j.company_linkedin_url) : undefined;
          if (!owner) continue;
          const list = batchedJobs.get(owner.key) ?? [];
          list.push(j);
          batchedJobs.set(owner.key, list);
        }

        // ── A BATCH STILL IN FLIGHT ANSWERED NOBODY ──────────────────────
        //
        // `lastCallBlock === "deferred"` means the call did not complete: the
        // run was started and is pending, or the clock or credit stopped it.
        // Marking the group `asked` here would record "we asked and there are
        // none" for companies the provider has not answered — and, worse, push
        // the operation key into `completed_operations`, so the resume that
        // adopts the run would skip them as already bought.
        //
        // They are DEFERRED: no verdict, still on the frontier, and the run id
        // is already durable for the slice that comes back for it.
        if (lastCallBlock === "deferred") {
          for (const g of group) {
            g.c.stage_block = { capability: cap, reason: "deferred" };
          }
          log("hiring_batch_pending_group_deferred", { companies: group.length });
          continue;
        }

        // ASKED IS RECORDED FOR EVERY COMPANY IN THE BATCH, including the ones
        // that came back with nothing. A company the provider answered "no
        // openings" about has been investigated; leaving it unmarked is the
        // no-one-asked/nothing-there collapse in its other direction, and it
        // would make the next slice pay to ask again.
        for (const g of group) {
          asked.add(g.c.key);
          if (g.opKey && !g.c.completed_operations.includes(g.opKey)) {
            g.c.completed_operations.push(g.opKey);
          }
        }

        // ── AN ANSWER IS NOT OWNED UNTIL IT IS WRITTEN DOWN ──────────────
        //
        // The verdicts and the purchase ledger used to be produced AFTER every
        // batch, and published once at the end of the stage. A slice killed
        // between the two lost both.
        //
        // Task 40800420, live: the checkpoint was written at 10:32:38, the job
        // search for [storm4, intelletec-ltd, odiin] SUCCEEDED at 10:33:14 for
        // $0.018, and the isolate died while the next batch was in flight. The
        // continuation sixty-six seconds later found `completed_operations`
        // empty for all three — because nothing had written them — and bought
        // the identical batch again for $0.021. The rows of the first purchase
        // were never read by anything.
        //
        // `expiredForDurableStart` already applies this rule to the POST: the
        // run id is persisted before the poll, so a slice killed while waiting
        // loses nothing. It had no counterpart for the RESPONSE. This is it —
        // decide the companies this batch answered, then checkpoint, so both
        // the verdict and the operation key survive the next kill.
        for (const g of group) assessOne(g.c);
        await publish("hiring_verified");
      }

      for (const c of targets) {
        assessOne(c);
      }
      // EVIDENCE IS SATISFIED WHEN A DECISION WAS REACHED, not only when a
      // company passed. A run that correctly finds three watch-list companies
      // has done its job.
      const decided = verified + review + watch;
      // ── P3: FIRST IN THE FUNCTION ──────────────────────────────────────────
      //
      // Only when the mission asked, only when the graph granted the team
      // provider for this mission, only for SHORTLISTED companies (enriched,
      // hiring verified or needing review), and only where the posting does not
      // already say so. Titles are read; no person is kept.
      const teamChecks = { attempted: 0, checked: 0, supported: 0, contradicted: 0, unverified: 0, from_posting: 0 };
      const teamStep = opts.plan.steps.find((st) => st.capability === cap);
      if (firstInFunctionRequested(opts.mission) &&
          teamStep?.providers.includes("apify_linkedin_company_employees")) {
        const titles = functionTitlesFor(qualificationCtx.role_vocabulary);
        const maxChecks = Math.max(1, Math.min(3, (opts.remainingLeads ?? effectiveRequestedCount(opts.mission)) * 2));
        // TWO KEYS, NEVER ONE. The spend rule reads the DECLARED band's floor
        // only; the sort adds LinkedIn associated members as a tiebreak inside
        // a band, and a member count alone never decides anything here.
        const bandFloor = (c: EngineCompany) => (c.enriched?.company_size_band ?? c.company.company_size_band)?.min ?? null;
        const headcount = (c: EngineCompany) => {
          const floor = bandFloor(c);
          const m = c.enriched?.linkedin_associated_member_count ?? c.company.linkedin_associated_member_count ?? null;
          return floor !== null ? floor * 1e6 + (m ?? 0) : m;
        };
        // Smallest first: "first in the function" is only a live question at a
        // small team, so the bounded checks go where the answer can be yes.
        const shortlisted = companies.filter((c) => c.enriched && c.hiring_assessment &&
          (c.hiring_assessment.verdict === "hiring_verified" || c.hiring_assessment.verdict === "hiring_verification_needed"))
          .sort((a, b) => (headcount(a) ?? Number.MAX_SAFE_INTEGER) - (headcount(b) ?? Number.MAX_SAFE_INTEGER));
        // REFUSED ONCE PER MISSION. A refusal recorded by an earlier slice
        // stands until the provider's readiness changes or an operator asks
        // for a retry — asking again learns nothing (canaries c584fd77,
        // d7012ba5, c0aa06be refused once per slice).
        const knownUnavailable = unavailableProvider(
          state.unavailable_providers, "apify_linkedin_company_employees",
          readinessOf("apify_linkedin_company_employees", cap).readiness, opts.readEnv);
        let teamLookupUnavailable: string | null = knownUnavailable
          ? `the team lookup provider is unavailable for this mission (${knownUnavailable.reason})`
          : null;
        if (knownUnavailable) {
          log("provider_unavailable_not_retried", {
            provider: knownUnavailable.provider, capability: cap, refused_at: knownUnavailable.refused_at,
          });
        }
        for (const c of shortlisted) {
          if (teamLookupUnavailable) {
            // THE GAP STAYS A GAP: first-hire proof is unavailable, never assumed.
            c.first_in_function ??= { status: "unverified", source: "none",
              reason: `first-hire proof unavailable — team check not run: ${teamLookupUnavailable}` };
            continue;
          }
          if (c.first_in_function?.status === "supported" && c.first_in_function.source === "job_posting") {
            teamChecks.from_posting++;
            continue;
          }
          if (c.first_in_function?.source === "team_composition") continue;
          // A SPEND rule, not a criterion: the company stays in the pool and is
          // ranked as usual; only the paid check is not bought where a first
          // hire in the function is implausible.
          const floor = bandFloor(c);
          if (floor !== null && floor > TEAM_CHECK_MAX_HEADCOUNT) {
            c.first_in_function ??= { status: "unverified", source: "none",
              reason: `team check not bought: a declared size of ${floor}+ employees makes a first hire in the function implausible` };
            continue;
          }
          if (teamChecks.attempted >= maxChecks) break;
          const url = c.identity?.linkedin_company_url ?? c.company.linkedin_company_url;
          if (!url || titles.length === 0) continue;
          const compiled = compileHarvestCompanyEmployeesInput({
            companies: [url], jobTitles: titles, maxItems: 3, maxItemsPerCompany: 3,
            profileScraperMode: COMPANY_EMPLOYEES_SCRAPER_MODES[0],
          });
          const priorBlock = c.stage_block;
          const rows = await callProvider(cap, "apify_linkedin_company_employees", compiled, c);
          teamChecks.attempted++;
          if (c.stage_block !== priorBlock && c.stage_block?.capability === cap) {
            // EVIDENCE, NEVER A GATE. A failed team lookup must not hold the
            // company back from qualification (canary 03f4c9c6: four companies
            // stuck "verifying", the Brain never asked).
            const last = state.provider_attempts[state.provider_attempts.length - 1];
            const why = String(last?.reason ?? c.stage_block.reason).slice(0, 160);
            c.stage_block = priorBlock;
            c.first_in_function = { status: "unverified", source: "none", reason: `team check failed: ${why}` };
            if (refusedBeforeAnyRun(why)) {
              teamLookupUnavailable = `the team lookup provider is unavailable (${why})`;
              state.unavailable_providers = markProviderUnavailable(state.unavailable_providers, {
                provider: "apify_linkedin_company_employees", capability: cap, reason: why,
                refused_at: new Date().toISOString(),
                readiness_at_refusal: readinessOf("apify_linkedin_company_employees", cap).readiness,
              });
            }
            continue;
          }
          teamChecks.checked++;
          const members = teamFunctionMembers(rows, url, qualificationCtx.role_vocabulary);
          // ZERO RESULTS ARE NOT PROOF (the plan, §9.2). An employee search
          // that finds nobody in the function says the ACTOR found nobody — its
          // coverage of a company's staff is not established — not that the
          // company has nobody. Only a posting's own "first / founding" words
          // (job_posting) prove first-in-function; a verified existing member
          // contradicts it; absence stays unverified.
          c.first_in_function = members.length === 0
            ? { status: "unverified", source: "team_composition", function_members: 0, function_titles: [],
              reason: "the team check found no one in this function — absence in a search is not proof of a first hire" }
            : { status: "contradicted", source: "team_composition", function_members: members.length,
              function_titles: members.slice(0, 5),
              reason: `${members.length} current employee(s) already hold the function` };
          if (c.first_in_function.status === "contradicted") teamChecks.contradicted++;
          else teamChecks.unverified++;
        }
        log("first_in_function_checked", teamChecks);
      }
      finish(cap, "complete", verified,
        [...(paidCalls > 0 ? ["apify_linkedin_job_search"] : []),
          ...(teamChecks.checked > 0 ? ["apify_linkedin_company_employees"] : [])],
        decided > 0,
        decided === 0 ? "no company had a relevant commercial role" : null);
      log("hiring_verification_complete", {
        targets: targets.length, verified, review, watch, notVerified,
        // NOT A VERDICT — the frontier. Distinguishing this from `notVerified`
        // in the log is how "we found nothing" stops looking like "there is
        // nothing", which is the confusion this whole phase removes.
        evidence_unavailable: unavailable,
        paid_job_searches: paidCalls,
      });
      await publish("hiring_verified");
      continue;
    }

    // ── COMPANY BRAIN QUALIFICATION ──────────────────────────────────────────
    if (cap === "company_brain_qualification") {
      let passed = 0, unknown = 0, restoredDecisions = 0;
      // Did this plan actually buy enrichment? A plan that never included the
      // step cannot be held to its absence.
      const enrichmentPlanned = opts.plan.steps.some(
        (s) => s.capability === "company_enrichment");
      // EVERY COMPANY WITH A DECISION REACHES THE BRAIN.
      //
      // This used to require `stage === "hiring_verified"`, so a lone Tier B or a
      // Tier C watch item was silently NOT_EVALUATED — no pass, no reject, no
      // unknown. That is how seven enriched companies produced a Brain summary of
      // "0 passed, 0 held as unknown": the eligible set was empty.
      //
      // ── AND WHY THAT FIX WAS NOT ENOUGH ──────────────────────────────────
      //
      // All three conditions read fields that ONLY `hiring_verification` wrote.
      // When the Mission did not ask for paid verification the capability was
      // never scheduled, so all three were false for every company and the
      // eligible set was empty again — this time for a hundred companies
      // (TEST run d787cfc7). The filter was not wrong; it was reading state
      // nobody had been asked to produce.
      //
      // The free assessment now runs HERE for any company that reached
      // enrichment without one, so the filter reads state that always exists.
      // An assessment is not a pass: `reachesCompanyBrain` still decides, and
      // `hiring_not_verified` still stays out.
      // AN UNRESOLVED IDENTITY IS STILL NOT EVALUATED.
      //
      // The guard is `identityIsActionable`, the SAME one the paid capability
      // uses for its targets. Widening it here to "has any open job" would
      // assess companies whose identity was never proven — and a company we
      // cannot identify is one whose founder could be attached to the wrong
      // employer. Unresolved stays `identity_pending` with a null verdict:
      // not a pass, not a rejection, and honestly reported as neither.
      //
      // ── PHASE 3 MEASURED THIS AND LEFT IT ALONE ─────────────────────────
      //
      // The relaxation was built and measured: 7 of 20 companies assessed
      // before, 20 after, `reachesCompanyBrain` 7 → 17. It was reverted, for
      // two reasons the measurement itself produced.
      //
      // It BUYS NOTHING IN TIME. Identity and enrichment still run in the same
      // place at the same cost — 15.4s and 10.6s on run 1af9b9ea. Widening this
      // gate changes who is assessed AFTERWARDS; the 26s the audit was chasing
      // is untouched. A real saving needs the pipeline REORDERED so identity
      // runs only for companies qualification kept, which is a different and
      // much larger change.
      //
      // And what it adds is weak. Every one of the thirteen additions was
      // `tier: none` with no settled size — REVIEW-shaped candidates
      // arriving at the stage that is already the wall-clock bottleneck, where
      // they can only displace stronger ones or fill a requested_count with
      // leads nobody would want.
      //
      // `evaluationPathTelemetry` test 3 states the invariant this would break:
      // "A company we could not identify must not be judged. It is the one case
      // where 'we did not evaluate this' is the correct, final answer."
      for (const c of companies) {
        // ── EXCEPT A COMPANY WHOSE PAID CHECK IS STILL IN FLIGHT ──────────
        //
        // This backfill exists for companies nobody ever needed to pay for. A
        // company whose batch went PENDING is a different case: the provider
        // is mid-answer, and writing the free assessment here republishes the
        // very verdict the deferral above withheld — which is how run 8f59170d
        // still resolved Sortly to `not_verified` after the batch was deferred,
        // leaving hiring unresumable and the paid run unadoptable.
        // NAMED LITERALLY, not via `cap`: this backfill runs in a LATER stage,
        // where `cap` is that stage's capability and would never match the
        // hiring block recorded earlier.
        if (c.stage_block?.capability === "hiring_verification" &&
            c.stage_block.reason === "deferred") {
          continue;
        }
        if (c.hiring_assessment === null && c.identity && identityIsActionable(c.identity)) {
          const free = freeHiringAssessment(c);
          c.hiring_assessment = free;
          c.hiring_jobs = hiringJobsFor(c, free);
        }
      }
      // ── ELIGIBILITY WAS ENTIRELY HIRING-SHAPED ───────────────────────────
      //
      // Every clause here asks about openings, which was right when hiring was
      // the only signal the engine could establish. It silently excluded every
      // other signal class: a company discovered BY a funding round — with a
      // dated, sourced Series A — has no job evidence, so it never reached
      // qualification, never got an evidence registry, and its round could
      // never be cited. A funding mission paid for discovery, identity and
      // enrichment and qualified nobody, for a reason no diagnostic named.
      //
      // SCOPED TO THE SIGNAL THAT FOUND THE COMPANY. The extra clause admits a
      // company only when THIS run discovered it by a funding round, so a
      // hiring mission — which has no rounds — filters exactly as it did
      // before. Test 6 in `fundingCoverage.test.ts` pins that.
      const eligible = companies.filter((c) =>
        c.record.stage === "hiring_verified" || c.hiring_jobs.length > 0 ||
        (c.hiring_assessment ? reachesCompanyBrain(c.hiring_assessment) : false) ||
        roundByCompanyKey.has(c.key) ||
        // ── OR ANY OTHER SIGNAL THE MISSION ASKED FOR ──────────────────────
        //
        // The funding clause above was the first crack in a hiring-shaped
        // gate; this is the general form. A company with a dated public
        // statement that it expanded, or launched, carries evidence for the
        // signal the mission required — and a filter that only asks about
        // openings cannot see it.
        Object.values(c.signal_evidence).some((a) => a.length > 0));

      // ── AND WHY EVERYONE ELSE IS NOT ────────────────────────────────────
      //
      // THE ALARM THAT RANG ON EVERY RUN. `company_brain` reported a non-zero
      // `unaccounted` on essentially every mission for weeks — 47 of 62 on
      // 8cfdfd10, 110 of 139 on b1348724 — and `unaccounted` is this file's one
      // counter that means "a stage dropped companies and cannot say where they
      // went". A counter that is never zero cannot raise an alarm.
      //
      // Nothing was actually lost. The funnel's `entered` for this stage is
      // every identity-resolved company, but only companies that pass the gate
      // above are ever handed to the Brain, and the gate's decision was recorded
      // nowhere. `qualification_deferred` covers the ones the CLOCK stopped;
      // there was no marker for the ones the gate never admitted.
      //
      // TWO OUTCOMES, NOT ONE, because the architecture's own rule distinguishes
      // them: an empty provider result is an absence of evidence, not a proven
      // negative. A refuted company is a fact — `excluded`. A company whose
      // signal was never established is an absence — `withheld`, still owed a
      // check, and `nextStageFor` will route it back.
      //
      // Set here, where eligibility is actually decided, so the funnel READS the
      // gate rather than re-deriving it. Two definitions of "eligible for the
      // Brain" is how they drift apart.
      //
      // `stage_block` is per-slice — it is not on the checkpoint snapshot — and
      // this is the last stage of a slice, so nothing downstream reads it but
      // the funnel. A company already carrying a more specific block keeps it.
      const eligibleKeys = new Set(eligible.map((c) => c.key));
      for (const c of companies) {
        if (eligibleKeys.has(c.key) || c.brain !== null) continue;
        // `hiring_not_verified` is the vocabulary's "no relevant commercial
        // signal at all" — a conclusion reached FROM evidence, so a fact. No
        // assessment at all is an absence, and absence is not a negative.
        c.brain_gate = c.hiring_assessment?.verdict === "hiring_not_verified"
          ? "refuted"
          : "not_established";
      }

      // ══ STAGE 2 — COLLECT, THEN EVALUATE ═══════════════════════════════════
      //
      // The per-company path below evaluates while capabilities are still
      // running: each company is judged the moment it arrives, so nothing ever
      // holds the whole set and no model can compare two of them. It also
      // stopped after roughly ten calls, which meant a run that discovered forty
      // companies judged a quarter of them and reported the rest in an order
      // that had never read a description.
      //
      // When Stage 2 is enabled the set is COLLECTED first: free gates remove
      // only companies a verified fact contradicts, and the survivors are
      // evaluated in bounded batches. `groundedByKey` is what the loop below
      // then reads instead of calling the per-company grounder — the decision
      // logic itself is untouched, which is why the old path stays exactly as
      // it was when the flag is off.
      const groundedByKey = new Map<string, GroundedVerification>();
      let stage2Pool: EligiblePool | null = null;
      let stage2Restored = 0;
      if (deps.evaluateBatch && eligible.length > 0) {
        const registries = new Map(eligible.map((c) => [c.key, registryFor(c)]));
        for (const c of eligible) c.evidence_registry = registries.get(c.key)!;

        stage2Pool = buildEligiblePool(
          eligible.map((c) => ({
            company_key: c.key,
            company_name: (c.enriched ?? c.company).company_name ?? null,
            registry: registries.get(c.key)!,
          })),
          {
            mission: opts.mission,
            employee_min: opts.brain?.employee_min ?? null,
            employee_max: opts.brain?.employee_max ?? null,
          },
        );
        log("stage2_eligible_pool", stage2Pool.metrics);

        // THE COMPOSITION FINGERPRINT, AT THE ONLY POINT IT CAN BE TAKEN.
        // The restore-time check upstream compares mission hashes, because
        // discovery had not run when it read the checkpoint. This is the set
        // that was actually discovered, and it is what the ranking is compared
        // against below.
        const poolFingerprint = poolFingerprintOf(
          stage2Pool.eligible.map((p) => p.company_key));

        // RESTORED WORK IS NOT RE-BOUGHT. A continuation supplies the grounded
        // results its earlier invocation already paid for; those companies are
        // removed from the batch plan rather than skipped with an empty result.
        const restored = deps.restoredGroundedResults ?? new Map();
        const toEvaluate = stage2Pool.eligible.filter((p) => {
          const prior = restored.get(p.company_key);
          if (prior) {
            groundedByKey.set(p.company_key, prior);
            stage2Restored++;
            return false;
          }
          return true;
        });

        const requiresSignal =
          opts.mission.required_signals.some(isHiringSignal);
        const limits = deps.batchLimits ?? resolveBatchLimits({});
        const { batches, beyond_cap } = planBatches(toEvaluate, limits);
        const batchReserveMs = deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS;
        let batchClockExpired = false;
        for (const batch of batches) {
          // THE DEADLINE IS CHECKED BETWEEN BATCHES, never mid-batch — and a
          // batch is admitted only when there is room for what a batch COSTS,
          // not merely room to checkpoint. The weaker test admitted a batch
          // with a second to spare and then had no say over the call itself;
          // see the qualification loop below, where that pattern cost a whole
          // run. The companies in the batches after a stop are recorded
          // UNEVALUATED, which is a different and honest thing from reviewed.
          const batchStartedAt = deps.deadline?.elapsedMs() ?? 0;
          if (deps.deadline && !shouldStartWork({
            elapsedMs: () => deps.deadline!.elapsedMs(),
            remainingMs: () => deps.deadline!.remainingMs(),
          }, deps.deadline.estimateFor(BATCH_EVALUATION_OP), batchReserveMs)) {
            state.terminal_reason = "execution_deadline_checkpoint";
            log("stage2_batch_deadline_stop", {
              evaluated: groundedByKey.size,
              remaining_ms: deps.deadline.remainingMs(),
              per_batch_estimate_ms: deps.deadline.estimateFor(BATCH_EVALUATION_OP),
            });
            break;
          }
          const members = batch.map((p) => ({
            company_key: p.company_key, company_name: p.company_name,
            registry: p.registry, requiresCommercialSignal: requiresSignal,
          }));
          // A BATCH IS ONE MODEL CALL, and one model call must not be able to
          // outlive the reserve. On overrun the batch contributes nothing and
          // the loop stops: its companies fall through to the per-company path
          // or to a continuation, and none of them is decided on silence.
          const result = deps.deadline
            ? await withDeadlineBudget(
              () => deps.evaluateBatch!(members),
              deps.deadline.remainingMs() - batchReserveMs,
              "stage2_batch_evaluation",
            ).catch((e) => {
              if (e instanceof DeadlineBudgetExceeded) {
                batchClockExpired = true;
                return null;
              }
              throw e;
            })
            : await deps.evaluateBatch(members);
          deps.deadline?.observeCall(
            deps.deadline.elapsedMs() - batchStartedAt, BATCH_EVALUATION_OP);
          if (batchClockExpired) {
            state.terminal_reason = "execution_deadline_checkpoint";
            log("stage2_batch_call_deadline_stop", {
              evaluated: groundedByKey.size,
              remaining_ms: deps.deadline?.remainingMs() ?? 0,
            });
            break;
          }
          if (!result) continue;
          for (const o of result.outcomes) {
            if (o.verification) groundedByKey.set(o.company_key, o.verification);
          }
          await deps.onBatchComplete?.({
            evaluated: [...groundedByKey.entries()].map(([k, v]) => ({
              company_key: k, verification: v,
            })),
            next_offset: groundedByKey.size,
            pool_fingerprint: poolFingerprint,
          });
        }
        poolState = {
          pool: stage2Pool, restored: stage2Restored,
          evaluatedKeys: [...groundedByKey.keys()],
          fingerprint: poolFingerprint,
        };
        log("stage2_batch_evaluation_complete", {
          eligible: stage2Pool.eligible.length,
          evaluated: groundedByKey.size,
          restored: stage2Restored,
          beyond_cap,
        });
      }

      // Resolved once for the whole eligible set — the Mission's bounds when it
      // stated any, the Brain's as advisory-only when it did not.
      const fitBounds = resolveEmployeeBounds(qualificationCtx, {
        employee_min: opts.brain?.employee_min ?? null,
        employee_max: opts.brain?.employee_max ?? null,
      });

      // ── IS THE EXCLUDED CATEGORY THE REQUESTED ONE? ───────────────────────
      //
      // Resolved once for the whole eligible set, like the bounds above, and for
      // the same reason: it is a property of the MISSION, not of a company, and
      // computing it per company would invite two answers in one run.
      const targetsIntermediaries = missionTargetsIntermediaries({
        mission_verticals: opts.mission.company_profile?.verticals ?? [],
      });
      if (targetsIntermediaries.targets) {
        // Worth a line of its own: it suspends a hard gate, and an operator
        // reading a run that returned staffing firms must be able to see that
        // this was the mission's doing rather than a regression.
        log("aggregator_gate_suspended_for_mission", {
          matched_terms: targetsIntermediaries.matched,
          mission_verticals: opts.mission.company_profile?.verticals ?? [],
          still_rejecting: "postings attributed to another employer",
        });
      }

      // ── THE QUALIFICATION LOOP IS DEADLINE-BOUND TOO ───────────────────────
      //
      // It was not, and that is what hung task 6e218eeb for an hour. This loop
      // makes up to TWO model calls per company — the per-company grounder and
      // the Mission evaluator, roughly 7s and 5s — and it ran the whole eligible
      // set unconditionally. The batch stage above checks `shouldCheckpoint`
      // between batches; this one checked nothing.
      //
      // It only became reachable in anger once the per-company grounder started
      // working. Before that it returned a well-formed empty result almost
      // instantly, so twelve seconds a company was six companies' worth of
      // nothing. With the batch evaluator returning no rows and six companies
      // enriched, the loop spent ~72s past an already ~75s run and the platform
      // killed the isolate at ~150s — mid-company, before any checkpoint was
      // written. `tasks.result` stayed null, the row stayed `running`, and no
      // continuation was ever scheduled.
      //
      // A company this loop does not reach is NOT REACHED: no verdict, no
      // rejection, still on the frontier and still resumable. That is the same
      // rule the batch stage follows, and the reason stopping here is safe.
      // ── AND CHECKING THE CLOCK WAS NOT ENOUGH EITHER ───────────────────────
      //
      // The guard above was already here when task 1e67725f died, and it did
      // not save it. It asked `shouldCheckpoint` — "is there still room to
      // write a checkpoint?" — which passed at 91s of a 125s budget, admitted a
      // company, and then had no further say. The two model calls below took 55
      // seconds and the isolate was killed at 146s: no checkpoint, no
      // continuation, `tasks.result` null, the row `running` forever and the
      // execution card spinning until someone gave up on it.
      //
      // ADMITTING WORK AND BOUNDING WORK ARE DIFFERENT THINGS, and this loop
      // now does both:
      //
      //   1. ADMISSION asks `shouldStartWork` — room for the reserve AND for
      //      what a company is estimated to cost. The estimate lives on the
      //      deadline under `QUALIFICATION_OP` and is fed real durations below,
      //      so after one company the loop is reasoning about this workspace's
      //      actual latency instead of a constant.
      //
      //   2. THE CEILING caps the calls themselves at whatever is left after
      //      the reserve, so a call that runs three times its estimate cannot
      //      spend the margin that admission set aside. The estimate bounds the
      //      typical company; the ceiling bounds the pathological one; neither
      //      alone is sufficient and 1e67725f is the proof.
      //
      // A company stopped by either is NOT REACHED — no verdict, no rejection,
      // still resumable — which is the same rule the guard already followed and
      // the reason stopping here was always safe.
      // ITS OWN RESERVE, NOT THE PROVIDER ONE. See `QUALIFICATION_RESERVE_MS`:
      // the calls below are already clock-bounded and a stopped company is
      // resumable, so the 18s sized for the slowest Actor was refusing
      // admission with 22 seconds on the clock and leaving enriched companies
      // without a verdict. An injected reserve still wins, so every test that
      // pins the clock is unaffected.
      const qualificationReserveMs = deps.checkpointReserveMs ?? QUALIFICATION_RESERVE_MS;
      /** Wall clock a single company's model calls may consume, right now. */
      const qualificationCallBudgetMs = (): number =>
        deps.deadline ? deps.deadline.remainingMs() - qualificationReserveMs : 0;

      // ── WHAT THIS COMPANY WILL ACTUALLY COST ────────────────────────────────
      //
      // A company the Stage-2 batch already grounded needs ONE model call: its
      // verification is read out of `groundedByKey` and the grounder is never
      // invoked. Pricing it as two is how run df00b2cd threw away three
      // verifications it had just spent 13 seconds buying.
      const isPreGrounded = (c: EngineCompany) => groundedByKey.has(c.key);
      const opFor = (c: EngineCompany) =>
        isPreGrounded(c) ? QUALIFICATION_PREGROUNDED_OP : QUALIFICATION_OP;

      // ── FINISH WHAT IS ALREADY PAID FOR, FIRST ──────────────────────────────
      //
      // A stable partition, not a sort: pre-grounded companies keep their
      // relative order and so do the rest. Under a clock that may stop the loop
      // at any point, the order companies are attempted in decides which ones
      // get verdicts — and the right ones to spend the last seconds on are those
      // whose expensive half is already bought and would otherwise be discarded.
      // ── AND STRENGTH ORDERS WHAT IS NOT YET PAID FOR ────────────────────
      //
      // The gate split above roughly doubles what reaches this loop, and the
      // measurement showed the additions are uniformly WEAK: tier A stayed at
      // 5 while `tier: none` went 2 → 15, and companies with no verified
      // headcount went 3 → 16. Handing a time-starved stage thirteen more
      // REVIEW-shaped candidates in arrival order would let them displace the
      // strong ones — turning a widened funnel into fewer good verdicts, which
      // is the opposite of the point.
      //
      // So the second partition sorts the not-yet-paid-for remainder by what
      // makes a verdict worth having: a real commercial tier first, then
      // enriched companies (proven size band and geography), then the rest.
      // Stable within each band, so nothing is reordered arbitrarily.
      const strength = (c: EngineCompany): number => {
        const tier = c.hiring_assessment?.tier ?? null;
        if (tier === "A") return 0;
        if (tier === "B") return 1;
        if (tier === "C") return 2;
        return c.enriched ? 3 : 4;
      };
      const eligibleOrdered = deps.deadline
        ? [
          // Finish what is already paid for, exactly as before.
          ...eligible.filter(isPreGrounded),
          // Then spend the remaining clock strongest-first.
          ...eligible.filter((c) => !isPreGrounded(c))
            .map((c, i) => ({ c, i }))
            .sort((a, b) => strength(a.c) - strength(b.c) || a.i - b.i)
            .map((x) => x.c),
        ]
        : eligible;
      let qualificationStopped = false;
      /** Set to the call's label the moment one overruns the ceiling. */
      let qualificationClockExpired: string | null = null;
      /**
       * One qualification model call, under the ceiling.
       *
       * Returns null on overrun, which every caller below already handles as
       * "the model did not answer" — an absent grounder degrades to REVIEW and
       * an absent evaluator holds as insufficient evidence. Neither rejects
       * anybody, so the failure mode of running out of clock is a company that
       * stays resumable rather than one that is quietly marked unqualified.
       *
       * Offline callers (no deadline) are unbounded, exactly as before.
       */
      const clockBound = async <T>(
        label: string, work: () => Promise<T>,
      ): Promise<T | null> => {
        if (!deps.deadline) return await work();
        try {
          return await withDeadlineBudget(work, qualificationCallBudgetMs(), label);
        } catch (e) {
          if (e instanceof DeadlineBudgetExceeded) {
            qualificationClockExpired = label;
            return null;
          }
          throw e;
        }
      };
      // CAPTURED BEFORE THE LOOP RUNS. Anything already carrying a decision at
      // this point was decided by an earlier generation or an earlier pass —
      // `decideCompanyBrain` is called nowhere else — so the set cannot include
      // a verdict this loop is about to make.
      // ── A HALF-RESTORED DECISION IS NOT A DECISION ───────────────────────
      //
      // A REVIEW or REJECT outcome is only meaningful with the evaluation it
      // cites: `buildLeadVerdict` reads `mission_evaluation.icp_fit`, and
      // without it every such company reports "ICP fit could not be
      // established" for ever. Before `mission_evaluation` was checkpointed,
      // that pair came back split — outcome yes, reasoning no — and this set
      // then short-circuited the evaluator, so the company could never be
      // re-judged either. Thirty-eight evaluated companies on lineage 57b937ab,
      // none of which could ever qualify.
      //
      // A QUALIFIED outcome is exempt: it is already the terminal answer, the
      // verdict below reads it directly, and re-running the evaluator on a
      // company this lineage has already passed would be a model call bought to
      // change nothing.
      //
      // So an incomplete non-qualified decision is treated as NOT decided, and
      // the evaluator runs again. That costs one call on a checkpoint written
      // before this field existed, and nothing at all on one written after.
      const restoredBrainKeys = new Set(
        eligibleOrdered
          .filter((c) =>
            c.brain !== null &&
            (c.brain.outcome === "QUALIFIED" || c.mission_evaluation !== null))
          .map((c) => c.key));
      for (let qIndex = 0; qIndex < eligibleOrdered.length; qIndex++) {
        const c = eligibleOrdered[qIndex];

        // ── A DECISION THIS LINEAGE ALREADY MADE IS NOT REMADE ─────────────
        //
        // Restoring `c.brain` is only half the fix: this loop evaluated every
        // eligible company unconditionally, so a continuation re-decided
        // companies it had already qualified — a model call each, and worse, the
        // downstream reserve charged the identity stage for qualifying them
        // again. Lineage 862e81be held that reserve at seven companies' worth
        // (114,000 ms) against a 105,597 ms window, so identity attempted
        // nothing at all across two generations while fourteen companies had
        // never had a paid lookup.
        //
        // ONLY A RESTORED DECISION SKIPS. `c.brain` is null for anything this
        // slice has not decided, and `decideCompanyBrain` still owns every
        // fresh verdict. A re-run that would legitimately change its mind — new
        // hiring evidence, a changed policy — arrives with `c.brain` null
        // because the checkpoint that carried the old decision is the same one
        // that carried the old evidence.
        if (c.brain !== null && restoredBrainKeys.has(c.key)) {
          c.evaluation_path = "restored_decision";
          c.decision_source = "restored_decision";
          if (c.brain.outcome === "QUALIFIED") {
            c.verdict = "pass";
            c.record = advance(c.record, "qualified_company", "restored_qualification");
            passed++;
          } else if (c.brain.outcome === "REJECT") {
            c.verdict = "reject";
            c.record = advance(c.record, "company_fit_reject", c.brain.reason);
          } else {
            c.verdict = "unknown";
            unknown++;
          }
          restoredDecisions++;
          continue;
        }

        const qualificationOp = opFor(c);
        if (deps.deadline && !shouldStartWork({
          elapsedMs: () => deps.deadline!.elapsedMs(),
          remainingMs: () => deps.deadline!.remainingMs(),
        }, deps.deadline.estimateFor(qualificationOp), qualificationReserveMs)) {
          qualificationStopped = true;
          state.terminal_reason = "execution_deadline_checkpoint";
          log("qualification_deadline_stop", {
            evaluated: qIndex,
            not_reached: eligibleOrdered.length - qIndex,
            remaining_ms: deps.deadline.remainingMs(),
            per_company_estimate_ms: deps.deadline.estimateFor(qualificationOp),
            // WHICH price refused it, so a stop is readable without guessing
            // whether the company still owed a grounding call.
            priced_as: qualificationOp,
            pre_grounded_remaining: eligibleOrdered.slice(qIndex).filter(isPreGrounded).length,
          });
          // ── SAY IT ON THE COMPANIES, NOT ONLY IN THE LOG ───────────────────
          //
          // The count above is an aggregate; the funnel accounts per company.
          // Without a marker, everything past `qIndex` is simply a company with
          // `brain === null` — indistinguishable from one that was never
          // eligible — so `leadMissionFunnel` could attribute none of them and
          // reported `UNACCOUNTED=31`, which is its alarm for a SILENT LOSS.
          //
          // Nothing was lost: `toResumeRecord` maps an absent brain to
          // `not_started`, `nextStageFor` routes that back here, and a later
          // slice picks them up — the investigated count climbing 43→52 across
          // slices of task 633ad466 is that working. But the funnel said
          // otherwise, and a false alarm on the one counter that means "we lost
          // companies" costs whoever reads it next the same hours it cost here.
          //
          // `deferred` is the same word `enrichment` and `identity` already use
          // for the same clock decision, and the funnel maps it to `withheld` —
          // "the run stopped; resumable, and never a fact about the company".
          for (const pending of eligibleOrdered.slice(qIndex)) {
            if (pending.brain !== null) continue;
            // ── ITS OWN REASON, NOT "deferred" ─────────────────────────
            //
            // `deferred` means investigation was budgeted and abandoned, and
            // `sliceFrontier` reads it that way — `isUnfinishedFrontier` treats
            // it as a company still owed INVESTIGATION. Qualification deferral
            // is a different state: the company is fully investigated and owes
            // only a Brain call.
            //
            // Sharing one string made `sliceFrontier` unable to tell them
            // apart. Splitting it keeps the funnel's accounting exact without
            // teaching one consumer a second meaning.
            pending.stage_block = {
              capability: "company_brain_qualification",
              reason: "qualification_deferred",
            };
          }
          break;
        }
        // Measured across the whole company, not per call, because the estimate
        // it feeds is what admission spends — and admission admits a COMPANY.
        //
        // ON THE DEADLINE'S OWN CLOCK, not `Date.now()`. The deadline is
        // constructed with an injectable `now`, and a duration measured against
        // a different clock than the one admission consults is not a
        // measurement of anything — it silently reads zero wherever time is
        // simulated, which is every offline test and every fake-clock proof.
        const qualificationStartedAt = deps.deadline?.elapsedMs() ?? 0;
        const src = c.enriched ?? c.company;
        c.fit = evaluateCompanyFit({
          mission_targets_intermediaries: targetsIntermediaries.targets,
          company_key: c.key,
          company_name: src.company_name ?? null,
          identity_status: c.identity?.status ?? "unresolved",
          enrichment_complete: c.enriched !== null,
          company_size_band: src.company_size_band ?? null,
          employee_range_advisory: src.employee_range_advisory ?? null,
          // MISSION-RESOLVED BOUNDS. The Mission's range when it stated one;
          // otherwise null, because the workspace Brain's bounds are advisory
          // on an axis the user never mentioned and must not reject there.
          employee_min: fitBounds.enforceable ? fitBounds.min : null,
          employee_max: fitBounds.enforceable ? fitBounds.max : null,
          industry_ids: src.industry_ids ?? [],
          positive_industries: opts.brain?.positive_industries ?? [],
          excluded_industries: opts.brain?.excluded_industries ?? [],
          geography: src.geography ?? null,
          required_geography: opts.brain?.required_geography ?? null,
          description: src.description ?? null,
          provider_industry: src.provider_industry ?? null,
          canonical_domain: src.canonical_domain ?? null,
          postings: c.hiring_jobs.map((j) => ({ job_id: j.job_id, title: j.title, description: j.description })),
        });

        // MISSION PRECEDENCE, computed once per company: the user's words, then
        // the mission, then only the workspace categories that actually relate to
        // it. "Recruiting Agencies" must not broaden a SaaS mission.
        const appliedPolicy = applyMissionPrecedence({
          original_user_query: opts.mission.original_user_query,
          mission_verticals: opts.mission.company_profile?.verticals ?? [],
          mission_geography: opts.brain?.required_geography ?? null,
          workspace_industries: opts.brain?.positive_industries ?? [],
        });
        const gateInput = {
          // MAPPED AT THE BOUNDARY. `IdentityResolution.status` is
          // verified_match | ambiguous | mismatch | unresolved; the Brain only
          // needs to know "proven", "proven wrong" or "not proven". `ambiguous`
          // is NOT a mismatch — it is an unproven identity, which is REVIEW.
          identity_status: (c.identity && identityIsActionable(c.identity)
            ? "verified_match"
            : c.identity?.status === "mismatch"
            ? "rejected_mismatch"
            : "unresolved") as "verified_match" | "unresolved" | "rejected_mismatch",
          active: true,
          geography: src.geography ?? null,
          required_geography: opts.brain?.required_geography ?? null,
          company_size_band: src.company_size_band ?? null,
          // THE MISSION'S CEILING, OR NONE AT ALL.
          //
          // This used to fall back to `?? 200` when the Mission set no bound,
          // reasoning that a generous default beat the workspace's narrower
          // preference. Both are preferences. With `CEILING_TOLERANCE` at 1.0
          // that default rejected every verified count above 400 — including
          // companies the Mission evaluator had explicitly passed, on a
          // constraint the user never expressed. A null ceiling is no gate.
          employee_ceiling: fitBounds.enforceable ? fitBounds.max : null,
          commercial_tier: c.hiring_assessment?.tier ?? null,
          // THE MISSION NAMED ITS ROLES, so "no commercial signal" is not a fact
          // this gate may reject on — see `failedHardGates`.
          mission_owns_hiring_role: qualificationCtx.mission_owns.hiring_role,
          semantic: null,
        };
        const hiringVerified = c.hiring_assessment?.verdict === "hiring_verified";

        // ── THE CANONICAL EVIDENCE REGISTRY, FOR EVERY COMPANY ──────────────
        //
        // BUILT FOR EVERY COMPANY that reaches qualification, before any branch
        // decides anything — because it is what the evaluator reasons over.
        //
        // It was built here for a different reason originally: there were three
        // qualification branches, and the deterministic-pass one wrote out a
        // semantic assessment in code — a hardcoded business model, and
        // supporting evidence that merely said the deterministic gates had
        // passed — which was the route most companies qualified through.
        // Grounding only the classifier branch would have left the commonest
        // route to QUALIFIED ungoverned. The inversion deleted that branch —
        // there is one evaluator call now — so the registry is no longer a way
        // to police a fabrication; it is the evaluator's input.
        //
        // The literals themselves are deliberately not repeated here: test 6b
        // in evaluationPathTelemetry greps this file for them, and cannot tell
        // a comment from live code.
        //
        // This is the only layer holding the discovery row, the enriched row
        // and the job evidence for one company at once, so it is the only place
        // the registry can be assembled without something upstream rebuilding
        // it from a projection. Nothing model-written enters it.
        const registry = registryFor(c);
        c.evidence_registry = registry;

        // ── GROUNDING: DOES THE MODEL'S STORY SURVIVE ITS OWN EVIDENCE? ─────
        const requiresCommercialSignal =
          opts.mission.required_signals.some(isHiringSignal);
        // STAGE 2 FIRST. When the pool phase above evaluated this company, its
        // verified result is used; the per-company grounder is the path for the
        // non-Stage-2 case and is not called twice for the same company.
        const grounded = groundedByKey.get(c.key)
          ?? (deps.groundCompany
            ? await clockBound("company_grounding", () => deps.groundCompany!({
              registry, requiresCommercialSignal, company_key: c.key,
            }))
            : null);
        // WHAT A COMPANY ACTUALLY COSTS, fed back so the next admission decision
        // is made against this workspace's latency rather than a constant.
        // `observeCall` keeps a maximum, so measuring cumulative elapsed twice
        // per company is monotonic — the later reading simply subsumes the
        // earlier one.
        deps.deadline?.observeCall(
          deps.deadline.elapsedMs() - qualificationStartedAt, qualificationOp);
        if (qualificationClockExpired) {
          qualificationStopped = true;
          state.terminal_reason = "execution_deadline_checkpoint";
          log("qualification_call_deadline_stop", {
            call: qualificationClockExpired,
            evaluated: qIndex,
            not_reached: eligibleOrdered.length - qIndex,
            remaining_ms: deps.deadline?.remainingMs() ?? 0,
          });
          break;
        }
        c.grounded = grounded ?? null;
        // P5.2 — THE VERIFIED SELF-DESCRIPTION OUTLIVES THE SLICE. `grounded`
        // is not in the checkpoint snapshot, so a restored company would lose
        // the only thing that can prove its business model. Recorded as an
        // observation, which the snapshot does carry, keyed on the same
        // evidence id so the graph never counts it twice.
        // LEAD V2 ONLY: a V1 / legacy mission's checkpoint gains no P5 evidence.
        if (specOn) {
          const bmItem = groundedBusinessModelItem(c, opts.identity?.task_id ?? null, new Date().toISOString());
          if (bmItem) {
            recordObservation(c, {
              version: CANDIDATE_OBSERVATION_VERSION,
              observation_id: observationIdFor("obs_grd_", bmItem.evidence_id),
              capability: "company_brain_qualification", actor_key: "grounded_evidence_evaluation",
              provider: "engine", route_id: null, plan_version: currentPlan()?.version ?? null,
              provider_call_id: null, source_record_id: null, source_url: null,
              observed_at: bmItem.observed_at,
              entity_hint: entityHintFromCompany(c.company),
              evidence: [bmItem],
            });
          }
        }

        // ── ENFORCE ONLY, AND ENFORCE MEANS ENFORCE ─────────────────────────
        //
        // In shadow the verification is computed, stored and compared, and the
        // legacy decision is what the user sees — so "would enforcing change
        // this run?" gets an answer before enforcing does.
        //
        // IN ENFORCE, AN ABSENT GROUNDER IS ITSELF A REVIEW.
        //
        // This previously passed `null` when the grounder returned nothing,
        // which let the legacy classifier's verdict stand — so an outage
        // quietly restored exactly the ungrounded QUALIFIED that enforcing
        // exists to prevent, and did it at the moment there was least evidence
        // that the company deserved it. Enforce now degrades to REVIEW rather
        // than to the old behaviour: a human is asked, nobody is rejected, and
        // no company is qualified on a claim nothing checked.
        // ── THE VERIFIER'S FINDINGS, INCLUDING HOW MUCH IT ACTUALLY CHECKED ──
        //
        // The claim COUNTS travel, not just the verdict. Without them the Brain
        // cannot tell a verifier that refuted something from one that examined
        // nothing, and on run ea2d02f2 it could not: the grounder returned zero
        // validated, zero rejected, zero downgrade reasons and a `review`
        // verdict for every company, and every Mission pass was vetoed by that
        // silence. See `groundingRefutes`.
        const groundingForBrain = deps.groundingMode !== "enforce"
          ? null
          : grounded
          ? {
            final_grounded_decision: grounded.final_grounded_decision,
            grounding_score: grounded.grounding_score,
            validated_claim_types: [
              ...new Set(grounded.validated_claims.map((x) => x.claim_type)),
            ],
            downgrade_reasons: grounded.downgrade_reasons,
            validated_claims: grounded.validated_claims.length,
            rejected_claims: grounded.rejected_claims.length,
            unacknowledged_conflicts: grounded.unacknowledged_conflicts.length,
          }
          : {
            // UNAVAILABLE IS NOT REFUTED. The verifier did not run, so it found
            // nothing — `groundingRefutes` reads this as no finding and leaves
            // the Mission verdict standing. The reason is still recorded so an
            // outage is visible rather than inferred from a pile of holds.
            final_grounded_decision: "review" as const,
            grounding_score: 0,
            validated_claim_types: [] as string[],
            downgrade_reasons: [] as string[],
            validated_claims: 0,
            rejected_claims: 0,
            unacknowledged_conflicts: 0,
          };

        // CAPTURED AT THE MOMENT OF JUDGEMENT, before any branch decides. See
        // `brain_inputs`: this is what lets a P4 re-evaluation be re-judged by
        // this same rule instead of a second one.
        c.brain_inputs = {
          gates: gateInput,
          policy: appliedPolicy,
          hiring_verified: hiringVerified,
          grounding: groundingForBrain,
          enrichment_planned: enrichmentPlanned,
        };

        // ── A FALSIFIABLE FACT STILL REJECTS, AND ONLY A FALSIFIABLE FACT ───
        //
        // Four checkable facts, and nothing else:
        //
        //   identity_mismatch          the evidence describes a DIFFERENT company
        //   staffing_or_aggregator     the "company" is a job board
        //   excluded_industry          tier 2 — who this workspace can never sell to
        //   company_size_band_*        tier 1 — and ONLY ever a MISSION-stated
        //                              bound, because `fitBounds.enforceable`
        //                              passes null for an advisory Brain range,
        //                              so these can physically not fire for a
        //                              workspace preference
        //
        // None is a judgement and none improves by asking a model: a declared
        // band of 201-500 against a stated maximum of 150 is arithmetic. (The
        // LinkedIn associated-member count is never one of these facts.)
        //
        // `geography_mismatch` is deliberately NOT here. Its gate is
        // `geography.includes(required_geography)`, and "San Francisco, CA, USA"
        // does not contain "united states" — the check rejects the very
        // companies it is meant to keep. Geography travels to the evaluator
        // inside `brain.hard_constraints`, where a model that knows San
        // Francisco is in the United States can apply it properly. Everything
        // else the old gate rejected on — industry wording, business model, an
        // absent commercial tier — is evidence now, not a wall.
        const FALSIFIABLE_REJECTIONS: readonly string[] = [
          "identity_mismatch", "staffing_or_aggregator", "excluded_industry",
          "company_size_band_above_max", "company_size_band_below_min",
        ];
        const falsifiable = c.fit.stage === "company_fit_reject" &&
          FALSIFIABLE_REJECTIONS.includes(c.fit.reason);
        if (falsifiable) {
          c.evaluation_path = "fabricated_reject";
          c.decision_source = "hard_constraint_rejection";
          c.mission_evaluation = notEvaluated(
            `rejected on a verified fact before evaluation: ${c.fit.reason}`);
          c.brain = decideCompanyBrain({
            gates: gateInput,
            semantic: {
              business_model: "unknown", company_fit: "fail", confidence: 0.9,
              agentory_use_case: "none", supporting_evidence: [],
              conflicting_evidence: c.fit.failed_gates, unknown_fields: [],
              reason: `verified hard fact: ${c.fit.reason}`,
            },
            policy: appliedPolicy, hiring_verified: hiringVerified,
            grounding: groundingForBrain,
          });
          c.verdict = "reject";
          c.record = advance(c.record, "company_fit_reject", c.fit.reason);
          c.record.failed_gates = c.fit.failed_gates;
          continue;
        }

        // ── THE EVALUATOR DECIDES ───────────────────────────────────────────
        //
        // ONE CALL SITE. There used to be three, and two of them fabricated the
        // model's answer in code:
        //
        //   company_fit_pass   → {company_fit:"pass", confidence:0.8,
        //                         supporting_evidence:["deterministic gates passed"]}
        //   company_fit_reject → {company_fit:"fail", confidence:0.9}
        //
        // Those literals were then reported through
        // `semantic_classification_observability` as though a classifier had
        // produced them, so the telemetry said the model had run on paths where
        // it was never called. The evaluator was an exception handler for cases
        // deterministic code could not settle; it is now the thing that settles
        // them.
        //
        // `evaluateCompanyFit` still runs — above — but as an EVIDENCE
        // SUMMARISER. Its `missing_evidence` tells the evaluator what nobody
        // could establish; its verdict no longer decides.
        const evaluationInput = buildMissionEvaluationInput({
          ctx: qualificationCtx,
          authority: resolveBrainAuthority(qualificationCtx, opts.brain),
          registry,
          qualification_rules: opts.brainQualificationRules ?? null,
        });
        const evaluation = deps.evaluateMission
          ? await clockBound("mission_evaluation", () => deps.evaluateMission!({
            input: evaluationInput,
            registry,
            company_key: c.key,
          }))
          : null;
        deps.deadline?.observeCall(
          deps.deadline.elapsedMs() - qualificationStartedAt, qualificationOp);
        // STOPPING BEATS HOLDING. Falling through would record this company as
        // insufficient_evidence — accurate, but it spends the reserve deciding
        // how to describe a company nobody evaluated. Breaking leaves it NOT
        // REACHED and gets the checkpoint written, which is what a continuation
        // needs in order to pick it up.
        if (qualificationClockExpired) {
          qualificationStopped = true;
          state.terminal_reason = "execution_deadline_checkpoint";
          log("qualification_call_deadline_stop", {
            call: qualificationClockExpired,
            evaluated: qIndex,
            not_reached: eligibleOrdered.length - qIndex,
            remaining_ms: deps.deadline?.remainingMs() ?? 0,
          });
          break;
        }

        if (evaluation) {
          c.evaluation_path = "model_evaluated";
          c.decision_source = "gpt_evaluation";
          c.mission_evaluation = evaluation.evaluation;
          const e = evaluation.evaluation;
          c.brain = decideCompanyBrain({
            gates: gateInput,
            semantic: {
              // The evaluator's Mission verdict, which `decideCompanyBrain`
              // ranks above `company_fit`.
              mission_fit: e.mission_fit,
              icp_fit: e.icp_fit,
              match_score: e.match_score,
              // Kept for the existing telemetry contract. Derived from the
              // Mission verdict rather than asked for separately, so the two
              // cannot disagree.
              business_model: "unknown",
              company_fit: e.mission_fit,
              confidence: e.confidence,
              agentory_use_case: e.icp_fit === "strong"
                ? "strong" : e.icp_fit === "plausible" ? "plausible" : "weak",
              supporting_evidence: e.matched_requirements.map(
                (m) => `${m.requirement}: ${m.excerpt}`),
              conflicting_evidence: e.failed_requirements.map(
                (f) => `${f.requirement}: ${f.why}`),
              unknown_fields: [...new Set([...e.unknown_fields, ...c.fit.missing_evidence])],
              reason: e.reasoning,
            },
            policy: appliedPolicy, hiring_verified: hiringVerified,
            grounding: groundingForBrain,
          });
          c.classification = {
            verdict: e.mission_fit === "pass" ? "pass"
              : e.mission_fit === "fail" ? "fail" : "unknown",
            reason: e.reasoning,
            source: "mission_evaluation",
          };
          // ── ENRICHED EVIDENCE IS A PRECONDITION OF QUALIFYING ─────────────
          //
          // A FALSIFIABLE FACT, so deterministic code owns it rather than the
          // model. When the plan bought enrichment and the provider returned
          // nothing, the only company facts available are discovery-time
          // fields — YC's self-reported headcount, its own one-liner — and
          // qualifying on those is what the enrichment step exists to prevent.
          //
          // This is a HOLD, not a rejection. The provider failing says nothing
          // about the company, so the company becomes insufficient_evidence and
          // stays resolvable on a later run. Inferring "not a fit" from a failed
          // call is the one inference this architecture forbids outright.
          if (c.brain.outcome === "QUALIFIED" && enrichmentPlanned &&
              !enrichmentIsEvidence(c.enrichment_outcome)) {
            c.decision_source = "insufficient_evidence";
            c.verdict = "unknown";
            // WHICH of the four non-evidence outcomes, not merely that there was
            // none. A continuation treats `deferred` and `provider_error` as
            // still-owed work; `empty` is answered and will not improve on a
            // retry. The hold is identical, the reason is not.
            c.record.stage_reason = `enrichment_evidence_missing:${c.enrichment_outcome}`;
            c.record.missing_evidence.push(`company_enrichment:${c.enrichment_outcome}`);
            unknown++;
            continue;
          }
          if (c.brain.outcome === "QUALIFIED") {
            c.verdict = "pass";
            c.record = advance(c.record, "qualified_company", "mission_evaluation_pass");
            passed++;
          } else if (c.brain.outcome === "REJECT") {
            c.verdict = "reject";
            c.record = advance(c.record, "company_fit_reject", c.brain.reason);
            c.record.failed_gates = c.fit.failed_gates;
          } else {
            c.verdict = "unknown";
            c.record.stage_reason = `mission_evaluation_review:${c.brain.reason}`;
            c.record.missing_evidence.push(...c.fit.missing_evidence);
            unknown++;
          }
          continue;
        }

        // ── NO EVALUATOR: HELD, NEVER REJECTED ──────────────────────────────
        //
        // The flag is off, the workspace is not allow-listed, the budget is
        // spent, or the model failed. None of those is a fact about the
        // company. It is recorded as INSUFFICIENT EVIDENCE and reported as
        // never evaluated, which is the distinction the whole architecture
        // exists to preserve.
        // ── THE SECOND EVALUATOR IS DELETED ─────────────────────────────────
        //
        // This branch used to call the pre-Phase-4
        // semantic classifier on every company the Mission evaluator did not
        // reach. It was the ARCHITECTURE'S SECOND SEMANTIC AUTHORITY, and for a
        // long time the one that actually decided in production, because
        // `MISSION_EVALUATION` is off by default and this path is precisely the
        // one taken when it is.
        //
        // The authority inversion already stripped its verdict: `c.verdict`
        // became `unknown` regardless of what it said. What remained was a paid
        // model call per company whose only surviving purpose was to populate
        // `semantic_parse` and feed a `decideCompanyBrain` call whose result no
        // longer changed anything — an entire duplicate evaluator kept alive to
        // fill in telemetry fields.
        //
        // Now the absence is simply recorded. One semantic authority, one call
        // site, and a run with no evaluator makes no model call here at all —
        // it qualifies nobody and says so through `evaluation_paths` and
        // `mission_evaluation_observability`. Silence reported as silence.
        c.decision_source = "insufficient_evidence";
        c.mission_evaluation = notEvaluated("no evaluator was available for this run");
        c.evaluation_path = "model_unavailable";
        // The Brain still runs, with no semantic assessment, so the deterministic
        // gate record exists for a reviewer. It cannot QUALIFY without one — see
        // `decideCompanyBrain`, where an absent assessment is REVIEW.
        c.brain = decideCompanyBrain({
          gates: gateInput, semantic: null, policy: appliedPolicy,
          hiring_verified: hiringVerified, grounding: groundingForBrain,
        });
        c.classification = {
          verdict: "unknown",
          reason: "the mission evaluator did not run for this company",
          source: "unresolved",
        };
        // HELD, NOT REJECTED. The stage stays where the pipeline actually got
        // to; the verdict is what says nothing could decide.
        c.verdict = "unknown";
        c.record.stage_reason = `mission_evaluator_unavailable:${c.fit.reason}`;
        c.record.missing_evidence.push(...c.fit.missing_evidence, "mission_evaluation");
        unknown++;
      }
      // ── THE GENERAL SIGNAL AXIS, AND THE VETO ────────────────────────────
      //
      // `hiring_fit` was the only signal verdict the evaluator produced, and its
      // prompt line is hiring-shaped. Funding, posts, expansion, product launch
      // and technology were folded into the generic requirement list, so a
      // two-signal mission produced one signal answer and the model chose which
      // one it was about.
      //
      // `assessSignals` gives every required signal its own verdict, and it is
      // computed from `completed_capabilities` — what actually RAN — so a signal
      // nobody investigated can never be reported satisfied. That guarantee is
      // structural rather than a line in a prompt, and CODE VETOES THE MODEL: a
      // claimed `verified` on an uninvestigated signal is downgraded here.
      const requiredForQual: QualRequiredSignal[] = (opts.mission?.required_signals ?? [])
        .map((sig) => ({
          event: String(sig.type ?? ""),
          subject: String((sig as { subject?: string }).subject ?? "company"),
          timeframe_days: (sig as { timeframe_days?: number }).timeframe_days ?? null,
        }));

      for (const c of companies) {
        const modelVerdicts: Record<string, { verdict: string; evidence_ids: string[] }> = {};
        // The evaluator's hiring axis maps onto the hiring signal and nothing
        // else. Deliberately narrow: attributing it to funding or posts would be
        // the same collapse this replaces, in the other direction.
        const hf = c.mission_evaluation?.hiring_fit;
        if (hf) {
          modelVerdicts["hiring/company"] = {
            verdict: hf === "verified" ? "verified" : hf === "plausible" ? "plausible" : "absent",
            evidence_ids: (c.mission_evaluation?.matched_requirements ?? [])
              .map((m) => m.evidence_id).filter(Boolean),
          };
        }
        /**
         * The newest source date among a set of registry items.
         *
         * `observed_at` on a registry item is the SOURCE's date — the round's
         * announced date, the article's publication date, the posting's posted
         * date — because that is what each builder puts there. Newest, because
         * a signal's recency is the most recent thing that proves it.
         */
        const newestSourceDate = (ids: readonly string[]): string | null => {
          const items = (c.evidence_registry?.items ?? [])
            .filter((it) => ids.includes(it.evidence_id));
          const dates = items
            .map((it) => it.observed_at)
            .filter((d): d is string => !!d && Number.isFinite(Date.parse(d)))
            .sort((a, b) => Date.parse(b) - Date.parse(a));
          return dates[0] ?? null;
        };

        // ── WHAT CODE PROVED, WITH CODE'S OWN CITATIONS ──────────────────
        //
        // `hiring_verification` reads real postings and `assessHiring` decides
        // on them. That verdict had no way into the signal assessment: the only
        // positive channel was the model's claim. Live run 2026-08-24 is the
        // cost — twelve verified openings reported as `not_investigated`
        // because the evaluator had answered a different question.
        //
        // The citations are the registry's own `job_posting` items, so this
        // asserts nothing the run cannot point at. Absent a registry or absent
        // openings there is no proven verdict, and the previous answer stands.
        const provenVerdicts: Record<string, {
          verdict: string; evidence_ids: string[]; occurred_at?: string | null;
        }> = {};
        if (c.hiring_assessment?.verdict === "hiring_verified") {
          const jobEvidence = (c.evidence_registry?.items ?? [])
            .filter((it) => it.evidence_type === "job_posting" || it.evidence_type === "yc_job")
            .map((it) => it.evidence_id);
          if (jobEvidence.length > 0) {
            provenVerdicts["hiring/company"] = {
              verdict: "verified", evidence_ids: jobEvidence,
              occurred_at: newestSourceDate(jobEvidence),
            };
          }
        }

        // ── AND WHAT THE FUNDING ROUND PROVED ─────────────────────────────
        //
        // Same rule as hiring, same citation discipline: the round is evidence
        // established by code — a dated, sourced record from a carded provider
        // — so it may assert its own verdict, and only by pointing at the
        // registry item that holds it.
        //
        // `funding_signal_discovery` ran and returned this company BECAUSE of
        // the round, so a company in the pool with a `funding_signal` item is a
        // company whose funding is established. Without the item there is no
        // verdict: an undated round is not evidence, and the registry refuses
        // to record one.
        if (state.completed_capabilities.includes("funding_signal_discovery")) {
          const fundingEvidence = (c.evidence_registry?.items ?? [])
            .filter((it) => it.evidence_type === "funding_signal")
            .map((it) => it.evidence_id);
          if (fundingEvidence.length > 0) {
            provenVerdicts["funding/company"] = {
              verdict: "verified", evidence_ids: fundingEvidence,
              occurred_at: newestSourceDate(fundingEvidence),
            };
          }
        }

        // ── AND WHAT THE PUBLIC RECORD PROVED ─────────────────────────────
        //
        // Same rule again, and the third time it is worth stating as a rule:
        // code may assert a signal it established, and only by citing the
        // registry item that holds it. The verdict is `plausible`, not
        // `verified` — a publisher reported the claim, which is source-backed
        // and is not a verification we performed. `verified` would say we
        // confirmed it, and we read a headline.
        for (const [event, type] of [
          ["expansion", "expansion_signal"] as const,
          ["product_launch", "launch_signal"] as const,
        ]) {
          if (!state.completed_capabilities.some((x) => x.startsWith(event === "expansion" ? "expansion_signal_verification" : "product_launch_verification"))) {
            continue;
          }
          const ids = (c.evidence_registry?.items ?? [])
            .filter((it) => it.evidence_type === type)
            .map((it) => it.evidence_id);
          if (ids.length > 0) {
            provenVerdicts[`${event}/company`] = {
              verdict: "plausible", evidence_ids: ids,
              occurred_at: newestSourceDate(ids),
            };
          }
        }

        const signals = assessSignals({
          required: requiredForQual,
          provenVerdicts,
          completed: state.completed_capabilities.map(String),
          // A PROVIDER THAT ERRORED IS NOT A PROVIDER THAT FOUND NOTHING.
          // `empty` is deliberately absent: an actor that ran and returned no
          // rows ANSWERED the question, and treating that as a failure would
          // turn "we checked and there is nothing" back into "we do not know".
          failed: state.provider_attempts
            .filter((a) => a.outcome === "error" || a.outcome === "compile_failed")
            .map((a) => String(a.capability)),
          modelVerdicts,
        });

        // A POSITIVE VERDICT ON SOMETHING NOBODY RAN IS A BUG, NOT A FINDING.
        // Recorded rather than thrown: the run continues, the claim does not.
        const bogus = verdictsClaimingUninvestigatedSignals(signals);
        if (bogus.length > 0) {
          log("signal_claim_rejected", { company: c.key, violations: bogus });
        }

        c.lead_verdict = buildLeadVerdict({
          icp_fit: c.mission_evaluation?.icp_fit ?? null,
          // JUDGEABLE, NOT MERELY PRESENT. `icp_fit` has no "could not tell"
          // value — `weak` covers both a poor match and no evidence — so the
          // evaluator having run at all is what makes it judgeable.
          icp_judgeable: c.evaluation_path !== "model_unavailable" &&
            c.decision_source !== "not_evaluated",
          icp_dimensions_met: (c.mission_evaluation?.matched_requirements ?? [])
            .map((m) => m.requirement),
          icp_dimensions_unknown: c.mission_evaluation?.unknown_fields ?? [],
          icp_evidence_ids: (c.mission_evaluation?.matched_requirements ?? [])
            .map((m) => m.evidence_id).filter(Boolean),
          signals,
        });
        c.signal_assessments = signals;
      }

      // ONE DECISION TRUTH. On Lead V2 the qualified set IS the canonical P5
      // eligibility (a surfaced label) — what persistence writes as leads, what
      // the progress counters, the Signals feed and the continuation read. The
      // Brain verdict stays recorded on each company; it no longer decides.
      state.qualified_company_keys = specOn
        ? canonicalQualifiedKeys(companies, opts)
        : companies.filter((c) => c.verdict === "pass").map((c) => c.key);
      state.unknown_company_keys = companies.filter((c) => c.verdict === "unknown").map((c) => c.key);

      // ── WHAT THIS RUN ACTUALLY RETURNS ───────────────────────────────────
      //
      // A person-entity mission that returns companies must SAY so. Person work
      // is unlock-gated and never scheduled, which is correct; handing back
      // accounts with no statement that a substitution happened is not.
      state.mission_output = resolveMissionOutput({
        requested_entity:
          opts.mission?.target_entity === "person" ? "person"
          : opts.mission?.target_entity === "job" ? "job" : "company",
        companies: companies.map((c) => ({
          company_key: c.key,
          company_name: c.company.company_name,
          qualified: c.verdict === "pass",
        })),
        // People exist only once an unlock has run. Nothing here buys them.
        people: [],
        people_unlock: {
          capability: "find_decision_makers",
          credits: priceFor("find_decision_makers"),
        },
      });
      const outputViolations = outputContractViolations(state.mission_output);
      if (outputViolations.length > 0) {
        log("mission_output_contract_violation", { violations: outputViolations });
      }

      // "NOBODY PASSED" AND "NOBODY WAS OFFERED" ARE DIFFERENT FACTS.
      //
      // This reason string previously said the former in both cases. A run whose
      // eligible set was EMPTY reported `no company passed the Company Brain`,
      // which reads as twenty rejections and is how a scheduling gap was
      // mistaken for an ICP that was too strict. The distinction costs one
      // branch and is the whole point of the instrumentation.
      // A STAGE THAT STOPPED ON THE CLOCK IS NOT COMPLETE.
      //
      // Reporting `complete` would move the capability onto
      // `completed_capabilities`, and a continuation skips those — so the
      // companies the loop never reached would be skipped for the life of the
      // lineage, exactly as the deferred identity candidates once were.
      const reason = qualificationStopped
        ? `the checkpoint reserve was reached during qualification; ` +
          `${passed} passed and ${unknown} held so far, the rest were not reached`
        : passed > 0
        ? null
        : eligible.length === 0
        ? emptyEligibleSetReason(companies)
        : `no company passed the Company Brain; ${unknown} held as unknown pending evidence`;
      finish(
        cap,
        qualificationStopped ? "incomplete" : "complete",
        passed, [], passed > 0 && !qualificationStopped, reason,
      );

      // ── THE YIELD GATE: 2 OF 10 IS NOT A FINISHED RUN ────────────────────
      //
      // The pipeline used to stop here regardless of outcome. A run that
      // qualified 2 of a requested 10, with 39 eligible companies never
      // touched, reported itself complete — because the shortlist had been
      // spent, not because the goal was met or the pool exhausted.
      //
      // Everything selected so far is now closed as `investigated`, the next
      // slice is taken from the frontier, and the paid stages are re-opened for
      // it. The four guards live in `shouldTakeAnotherSlice`; the binding one is
      // the clock, which is measured fresh here rather than assumed.
      // ONE DECISION TRUTH. On Lead V2 "qualified" is the canonical P5 count —
      // the same projection the Workbench and the continuation decision read —
      // never the legacy Brain verdict, which disagreed with it (canary
      // d7012ba5: verdicts 0, Workbench 2) and kept authorising paid passes.
      const qualifiedSoFar = specOn
        ? canonicalDecisionSummary(companies, opts).qualified
        : companies.filter((c) => c.verdict === "pass").length;
      const frontierLeft = companies.filter(
        (c) => isFrontier(c.investigation_state)).length;
      const sliceCapacity = deps.deadline
        ? resolveTimeCapacity({
          remainingMs: deps.deadline.remainingMs(),
          reserveMs: deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS,
          concurrency: LINKEDIN_RESOLUTION_CONCURRENCY,
          enrichmentBatchSize: COMPANY_DETAILS_BATCH_SIZE,
          read: opts.readEnv,
          observedIdentityMs: deps.deadline.estimateFor(IDENTITY_SEARCH_OP),
          // THE DOMINANT COST, AND THE GATE'S OWN NUMBER FOR THE ONE AFTER IT.
          hiringMsPerCompany: HIRING_MS_PER_COMPANY,
          hiringBatchSize: HIRING_VERIFICATION_BATCH_SIZE,
          qualificationMs: deps.deadline.estimateFor(QUALIFICATION_OP),
        }).capacity
        // No deadline (offline callers) ⇒ the clock cannot bind.
        : Number.MAX_SAFE_INTEGER;
      // ── WHAT THIS RUN HAS ALREADY BOUGHT AND NOT YET FINISHED ───────────
      //
      // Both counts are read from the working set, not tracked separately —
      // they are questions about the companies in hand, and a second source of
      // truth for "is this company ready to judge" is the last thing this
      // scheduler needs.
      //
      // READY: identity actionable, enrichment settled with evidence, and no
      // verdict yet. Exactly the companies `qualification_deadline_stop` leaves
      // behind when it is cut, and the ones the gate must finish before it
      // authorises another paid batch.
      const qualificationReady = companies.filter((c) =>
        c.verdict === null &&
        c.identity !== null && identityIsActionable(c.identity) &&
        enrichmentIsEvidence(c.enrichment_outcome)
      ).length;
      // DEBT: judged, undecided, and short of a requirement a page could
      // settle. `unknown` is the verdict the evaluator gives when it cannot
      // close one — P4 exists for precisely these.
      const evidenceDebtPending = companies.filter((c) =>
        c.verdict === "unknown" &&
        (c.mission_evaluation?.unknown_fields?.length ?? 0) > 0
      ).length;

      const yieldGate = shouldTakeAnotherSlice({
        qualified: qualifiedSoFar,
        requestedCount: effectiveRequestedCount(opts.mission),
        frontierRemaining: frontierLeft,
        passesTaken: investigationPass,
        timeCapacity: sliceCapacity,
        maxPasses: resolveMaxPasses(opts.readEnv),
        qualificationReady,
        evidenceDebt: evidenceDebtPending,
      });
      log("investigation_yield_gate", {
        pass: investigationPass, qualified: qualifiedSoFar,
        requested: effectiveRequestedCount(opts.mission),
        frontier_remaining: frontierLeft, time_capacity: sliceCapacity,
        take_another_slice: yieldGate.take, reason: yieldGate.reason,
        // The two counts the gate now consults, so a refusal is readable
        // without re-deriving it from the working set.
        qualification_ready: qualificationReady,
        evidence_debt_pending: evidenceDebtPending,
      });

      if (yieldGate.take) {
        closeInvestigatedSlice(companies);
        const taken = takeInvestigationSlice(companies, investigationPass + 1);
        if (taken > 0) {
          investigationPass++;
          // RE-OPEN THE PAID STAGES FOR THE NEW SLICE. They are complete for the
          // companies already carried; `shouldSkipProviderCall` is what stops
          // those being re-bought, not the completed list.
          for (const reopen of INVESTIGATION_CAPABILITIES) {
            state.completed_capabilities = state.completed_capabilities.filter(
              (x) => x !== reopen);
            if (!state.pending_capabilities.includes(reopen)) {
              state.pending_capabilities.push(reopen);
            }
          }
          const rewindTo = opts.plan.steps.findIndex(
            (x) => x.capability === "company_identity_resolution");
          if (rewindTo >= 0) {
            log("investigation_next_pass", {
              pass: investigationPass, selected: taken, rewind_to: rewindTo,
            });
            stepIndex = rewindTo - 1;   // the loop's ++ lands on identity
            continue;
          }
        }
      }
      // ── THE FRONTIER IS UNFINISHED WORK, AND THE LEDGER MUST SAY SO ────────
      //
      // Whatever is still on the frontier stays there, ranked and recoverable.
      // But "recoverable" was only ever half true: this invocation marked all
      // five capabilities COMPLETE and left `pending_capabilities` empty, while
      // 88 companies sat waiting. A continuation reads `completed_capabilities`
      // and skips what it finds there, so it would have skipped every stage and
      // done nothing — and because nothing was pending, the run reported
      // `round_limit_reached` rather than `continuation_required`, so the UI
      // never offered Continue either.
      //
      // That is why, across 202 sourcing tasks, seventeen asked for a
      // continuation and not one ever ran. The frontier, the checkpoint and the
      // resume guard were all correct and were never given anything to do.
      //
      // A run that stopped because it ran out of CLOCK has not finished
      // investigating. The paid stages are left PENDING so the next invocation
      // has real work, exactly as the multi-pass path above re-opens them.
      // Stopping because the quota was met, the frontier is empty, or the pass
      // ceiling was hit IS finished — those leave the ledger complete.
      // KEYED ON THE OUTCOME, NOT ON THE GATE'S REASON.
      //
      // Enumerating stop reasons missed a case the probe found: the gate can
      // say TAKE and the slice still come back empty, because carried in-flight
      // work has already consumed the allowance (`reason: "no_capacity"`). The
      // run wants to continue and cannot — which is a continuation if anything
      // is. Reached here at all, this invocation is making no further progress.
      //
      // So the question is simply: is there work left, and was it wanted?
      // Quota met ⇒ finished. Frontier empty ⇒ finished, and any shortfall is
      // real. Anything else is unfinished work that a continuation can advance.
      const carryFrontier = frontierLeft > 0 &&
        qualifiedSoFar < effectiveRequestedCount(opts.mission);
      if (carryFrontier) {
        for (const reopen of INVESTIGATION_CAPABILITIES) {
          state.completed_capabilities = state.completed_capabilities.filter(
            (x) => x !== reopen);
          if (!state.pending_capabilities.includes(reopen)) {
            state.pending_capabilities.push(reopen);
          }
        }
        // The terminal reason the checkpoint reads to decide whether a
        // continuation is required at all.
        state.terminal_reason = "execution_deadline_checkpoint";
        log("investigation_frontier_carried", {
          frontier_remaining: frontierLeft,
          qualified: qualifiedSoFar,
          requested: effectiveRequestedCount(opts.mission),
          reopened: [...INVESTIGATION_CAPABILITIES],
        });
      }
      closeInvestigatedSlice(companies);

      log("company_brain_qualification_complete", {
        ...summariseEvaluationPaths(companies),
        // The per-company array is already in the run result; the log carries
        // the aggregate only.
        companies: undefined,
        eligible: eligible.length,
        passed, unknown,
        // Carried rather than re-decided. Reported because a continuation whose
        // evaluation count is lower than its qualified count is otherwise
        // unreadable — and because it is the number that frees the identity
        // stage's reserve.
        restored_decisions: restoredDecisions,
      });
      await publish("qualified");
      continue;
    }

    // ── FOUNDER DISCOVERY ────────────────────────────────────────────────────
    if (cap === "founder_discovery") {
      const qualified = companies.filter((c) => c.verdict === "pass");
      if (qualified.length === 0) {
        finish(cap, "skipped_no_input", 0, [], false,
          "no qualified company — founder discovery has no input");
        continue;
      }
      // THE PEOPLE GATE. Company discovery, identity, enrichment, hiring
      // verification and a Brain PASS must ALL be behind us. Task
      // e8abeb8f-…-cfcbc6a416d4 bought five people against zero qualified
      // companies, off job-board rows, and nothing refused.
      assertPeopleProviderAllowed("apify_linkedin_company_employees", {
        completed_capabilities: state.completed_capabilities,
        qualified_company_keys: state.qualified_company_keys,
      });
      const used: string[] = [];
      const roles = opts.mission.decision_makers.roles;
      const perCompany = opts.foundersPerCompany ?? 3;
      let found = 0;
      for (const c of qualified) {
        const url = c.identity?.linkedin_company_url ?? c.company.linkedin_company_url;
        if (!url) continue;
        used.push("apify_linkedin_company_employees");
        const compiled = compileHarvestCompanyEmployeesInput({
          companies: [url], jobTitles: roles, maxItems: perCompany,
          // Cheapest verified mode. Email-enrichment modes are forbidden by the
          // compiler, so this can never silently become a paid email lookup.
          profileScraperMode: COMPANY_EMPLOYEES_SCRAPER_MODES[0],
        });
        let rows = await callProvider(cap, "apify_linkedin_company_employees", compiled);
        if (rows.length === 0) {
          // FALLBACK WITHIN THE CAPABILITY. Approved provider, same question.
          const ex = onCapabilityExhausted(opts.plan, cap, ["apify_linkedin_company_employees"]);
          if (ex.status === "provider_fallback_available" && ex.next_provider === "apify_people_search") {
            used.push("apify_people_search");
            const fb = compileHarvestProfileSearchInput({
              currentCompanies: [url], currentJobTitles: roles, maxItems: perCompany,
              profileScraperMode: PROFILE_SEARCH_SCRAPER_MODES[0],
            });
            rows = await callProvider(cap, "apify_people_search", fb);
          }
        }
        c.founders = dedupePeople(rows.map((r) => normalizeHarvestPerson(r, "capability_engine")));
        if (c.founders.length > 0) {
          c.record = advance(c.record, "founder_pending", "candidates_returned");
          found += c.founders.length;
        }
      }
      finish(cap, "complete", found, [...new Set(used)], found > 0,
        found === 0 ? "no decision-maker candidates were returned" : null);
      continue;
    }

    // ── EMPLOYER VERIFICATION ────────────────────────────────────────────────
    if (cap === "employer_verification") {
      let verified = 0;
      for (const c of companies) {
        if (c.founders.length === 0) continue;
        const url = c.identity?.linkedin_company_url ?? c.company.linkedin_company_url ?? "";
        c.verified_founders = c.founders.filter((p) => deps.verifyEmployer(p, url).verified);
        if (c.verified_founders.length > 0) {
          c.record = advance(c.record, "founder_verified", "current_employer_verified");
          verified += c.verified_founders.length;
        } else {
          c.record = advance(c.record, "founder_mismatch", "no_current_employer_match");
        }
      }
      finish(cap, "complete", verified, [], verified > 0,
        verified === 0 ? "no decision-maker was verified at their company" : null);
      await publish("decision_makers_verified");
      continue;
    }

    // ── CONTACT ENRICHMENT ───────────────────────────────────────────────────
    if (cap === "contact_enrichment") {
      let contactReady = 0;
      for (const c of companies) {
        for (const p of c.verified_founders) {
          const identity = p.linkedin_url ?? p.source_profile_id ?? null;
          if (!identity) continue;
          c.contact_identities.push(identity);
          contactReady++;
        }
        if (c.contact_identities.length > 0) {
          c.record = advance(c.record, "contact_pending", "contact_method_present");
        }
      }
      state.contact_identities = [...new Set(companies.flatMap((c) => c.contact_identities))];
      finish(cap, "complete", contactReady, [], contactReady > 0,
        contactReady === 0 ? "no verified decision-maker had a contact method" : null);
      continue;
    }

    // ── PERSISTENCE ──────────────────────────────────────────────────────────
    //
    // ── ROWS MEANS WHAT THIS RUN HAS TO WRITE ─────────────────────────────
    //
    // It reported `contact_identities.length` for every mission. On a
    // `qualified_companies` mission that number is structurally zero — the run
    // produces COMPANIES, and no contact is ever resolved — so persistence
    // reported nothing done even on a run that had six companies to save.
    //
    // The count now follows what the mission asked for, which is also what the
    // completion rule reads: a persistence step with real rows closes, and one
    // with none stays open while anything upstream is still pending.
    // ONE PREDICATE, shared with the writer. This was an inline literal here
    // while `buildCompanyRowPersistencePlan` had no idea missions existed —
    // which is exactly how the count and the rows came to disagree.
    const persistable = companyIsTheDeliverable(opts.mission)
      ? state.qualified_company_keys.length
      : state.contact_identities.length;
    if (cap === "persistence") {
      finish(cap, "complete", persistable, [], true, null);
      continue;
    }

    finish(cap, "skipped_no_input", 0, [], false, `unhandled capability: ${cap}`);
  }

  if (state.pending_capabilities.length === 0 && state.terminal_reason === null) {
    state.terminal_reason = "capability_plan_complete";
  }

  // ══ STAGE 2 — COMPARE THE POOL, THEN LET POLICY DECIDE WHAT SHIPS ═════════
  //
  // AFTER the plan, deliberately. Ranking is the one operation that needs every
  // company at once, so running it inside a capability would mean comparing a
  // set that was still being assembled.
  let pool: CapabilityRunResult["pool"] = null;
  if (poolState) {
    const evaluated = new Set(poolState.evaluatedKeys);
    const summaries: GroundedCandidateSummary[] = companies
      .filter((c) => evaluated.has(c.key))
      .map((c) => buildCandidateSummary({
        company_key: c.key,
        company_name: (c.enriched ?? c.company).company_name ?? null,
        brain_outcome: c.brain?.outcome ?? "REVIEW",
        tier: (c.hiring_assessment?.tier ?? null) as "A" | "B" | "C" | null,
        grounded: c.grounded,
      }));
    // An eligible company with no grounded result was never evaluated — the
    // deadline stopped the run, or its batch failed. Counted, never guessed at.
    const unevaluated = Math.max(0, poolState.pool.eligible.length - summaries.length);

    // ── DID THE POOL ITSELF CHANGE UNDER THIS MISSION? ───────────────────
    //
    // The restore check upstream can only compare mission hashes, so a
    // continuation that discovers a DIFFERENT set under the SAME mission
    // restores the verdicts of the companies still present, re-evaluates the
    // rest, and would otherwise present the resulting order as continuous with
    // the previous one. It is not: the pool being compared is not the pool the
    // earlier ranking described. Unknown is reported as unknown.
    const compositionChanged = deps.restoredPoolFingerprint
      ? deps.restoredPoolFingerprint !== poolState.fingerprint
      : null;
    if (compositionChanged) {
      log("stage2_pool_composition_changed", {
        restored_fingerprint: deps.restoredPoolFingerprint,
        current_fingerprint: poolState.fingerprint,
        note: "same mission, different discovered set; ranking recomputed for this pool",
      });
    }

    // SHADOW RUNS THE RANKER TOO. Its authority is what the mode governs, not
    // whether it executes — the earlier version only passed `rankPool` under
    // enforce, so shadow computed nothing and enforce would have been switched
    // on with no evidence about what it does.
    const rankingMode = deps.rankingMode ?? "shadow";
    let ranking: ValidatedRanking | null = null;
    if (deps.rankPool && summaries.length > 0) {
      // RANKING NEEDS TIME IT MAY NOT HAVE. When the reserve is already reached
      // the deterministic order ships and says so, rather than the run dying
      // holding an unordered pool.
      const outOfTime = deps.deadline
        ? shouldCheckpoint({
          elapsedMs: () => deps.deadline!.elapsedMs(),
          remainingMs: () => deps.deadline!.remainingMs(),
        }, deps.checkpointReserveMs ?? CHECKPOINT_RESERVE_MS)
        : false;
      if (!outOfTime) {
        try {
          ranking = await deps.rankPool({
            summaries, requestedCount: effectiveRequestedCount(opts.mission),
            unevaluatedCount: unevaluated,
          });
        } catch (e) {
          // A RANKING OUTAGE IS AN ORDERING PROBLEM, NOT A RUN-ENDING ONE. The
          // pool is fully evaluated by this point; losing the comparison costs
          // a better order, and throwing would cost the whole run.
          log("stage2_ranking_failed", { error: String(e) });
          ranking = null;
        }
      } else {
        log("stage2_ranking_skipped_deadline", { evaluated: summaries.length });
      }
    }
    // `validatePoolRanking` with a null answer IS the deterministic fallback,
    // so there is one ordering function and no second code path to drift.
    //
    // ENFORCE lets the comparison decide the order. SHADOW ships the
    // deterministic order and records the difference instead — and says so, so
    // a reader can tell "the ranker is being observed" from "the ranker failed",
    // which the generic fallback reason cannot express.
    const shadowing = rankingMode !== "enforce";
    const validated = shadowing
      ? deterministicRanking(summaries, ranking
        ? "ranking computed in shadow mode; deterministic order shipped"
        : "shadow mode; no ranking was produced to compare")
      : ranking ?? validatePoolRanking({
        raw: null, summaries, requestedCount: effectiveRequestedCount(opts.mission),
      });
    // Computed in shadow only. Under enforce the ranking IS the order, so a
    // comparison against a hypothetical deterministic one would describe
    // nothing that happened.
    const rankingShadow = shadowing
      ? buildRankingShadowComparison({
        proposed: ranking, deterministic: validated, summaries,
        requestedCount: effectiveRequestedCount(opts.mission),
      })
      : null;
    if (rankingShadow) {
      log("stage2_ranking_shadow", {
        computed: rankingShadow.computed,
        proposed_source: rankingShadow.proposed_source,
        moved: rankingShadow.moved_count,
        would_enter: rankingShadow.would_enter_delivery.length,
        would_leave: rankingShadow.would_leave_delivery.length,
      });
    }
    pool = {
      eligible: poolState.pool.metrics,
      excluded: poolState.pool.excluded,
      summaries,
      ranking: validated,
      ranking_mode: rankingMode,
      ranking_shadow: rankingShadow,
      fingerprint: poolState.fingerprint,
      composition_changed: compositionChanged,
      delivery: applyPortfolioPolicy({
        ranking: validated, summaries,
        requestedCount: effectiveRequestedCount(opts.mission),
        eligibleCount: poolState.pool.eligible.length,
        unevaluatedCount: unevaluated,
      }),
      restored: poolState.restored,
      unevaluated,
    };
    log("stage2_pool_complete", {
      evaluated: summaries.length, unevaluated,
      ranking_source: validated.ranking_source,
      ranking_mode: rankingMode,
      composition_changed: compositionChanged,
      delivered: pool.delivery.metrics.delivered,
      shortfall: pool.delivery.metrics.shortfall,
    });
  }

  // ══ ONE SOURCE OF TRUTH FOR "WHICH COMPANIES THIS RUN HOLDS" ═════════════
  //
  // `companies` — the working set — is the only authority. `state.company_keys`
  // is a PROJECTION of it and is derived here, immediately before the state and
  // the resume records leave this function together.
  //
  // ── THE DIVERGENCE THIS ENDS ────────────────────────────────────────────
  //
  // `company_keys` used to be assigned in three places, all inside the
  // discovery path. A continuation SKIPS discovery, so on task 528c2266 the
  // field kept the 100 keys it was restored with while the working set restored
  // EMPTY — and nothing reconciled the two. The run then persisted both halves
  // faithfully, from two different writers:
  //
  //   lead_resume_checkpoint.companies   ← derived from `companies`   → 0
  //   capability_execution_state.company_keys ← carried on `state`    → 100
  //
  // A row claiming a hundred companies and holding none is not a state any
  // slice can act on, and the next continuation read it as "everything has been
  // investigated": qualified 1 → 0, and the 83-company frontier was destroyed.
  //
  // Deriving it makes the two physically incapable of disagreeing, whatever
  // path the run took to get here.
  state.company_keys = companies.map((c) => c.key);

  return {
    state,
    companies,
    pool,
    resume_records: companies.map(toResumeRecord),
    headcount_snapshots: headcountSnapshots,
    funnel: projectFunnel(companies.map((c) => c.record)),
    capability_outcomes: outcomes,
    reevaluation_context: reevaluationContext,
    rebuild_registry: (key, webPages) => {
      const c = companies.find((x) => x.key === key);
      return c ? registryFor(c, webPages) : null;
    },
  };
}

/**
 * Where did this company individually get to?
 *
 * The audited run recorded progress per CAPABILITY only, so a resume could not
 * tell that SnapMagic's identity and enrichment were already paid for. This is
 * the per-company record a continuation reads.
 */
/**
 * THE WHOLE TRUTH A CONTINUATION NEEDS, TAKEN MID-RUN.
 *
 * ── WHY THIS EXISTS AND WHY IT LIVES HERE ─────────────────────────────────
 *
 * A checkpoint written from `state` alone is a lie waiting to be read. The
 * working set — `companies` — is the only authority; `state.company_keys` is a
 * PROJECTION of it, derived at the return so the two are physically incapable
 * of disagreeing. That rule was learned from task 528c2266, where a row
 * claiming a hundred companies and holding none destroyed an 83-company
 * frontier.
 *
 * Run 8f59170d broke it again from the other side. A mid-run writer persisted
 * `capability_execution_state` WITHOUT the working set, so the resumed slice
 * restored:
 *
 *     completed_capabilities: [discovery, identity, enrichment, persistence]
 *     company_keys:           0
 *
 * Discovery was skipped as complete, there was nobody to investigate, and the
 * lineage burned all ten continuations on four-second barren slices.
 *
 * So the snapshot is taken HERE, by the engine, from both halves at once —
 * exactly as the return path does it. A caller cannot assemble one incorrectly
 * because a caller is never given the parts.
 */
/** What actually happened to a checkpoint the engine offered. */
export interface CheckpointWriteOutcome {
  written: boolean;
  /** Why not, when `written` is false. The silent skip is the thing to catch. */
  reason?: string;
  /** The row's `checkpoint_version` AFTER the write. */
  checkpoint_version?: number | null;
}

export interface CheckpointSnapshot {
  state: CapabilityExecutionState;
  resume_records: CompanyResumeRecord[];
  /** False when the state describes work whose output is missing. */
  coherent: boolean;
  /** Why it is not coherent. Null when it is. */
  incoherence: string | null;
}

/**
 * Capabilities whose completion MUST be visible as companies in the working
 * set. If one of these is marked complete and the set is empty, the state is
 * describing work whose product does not exist.
 *
 * Qualification and persistence are deliberately absent: both may legitimately
 * complete having produced nothing — a pool where nobody qualifies is a real
 * answer, and persistence writes only what qualified.
 */
const CAPABILITIES_THAT_MUST_YIELD_COMPANIES: readonly CapabilityId[] = [
  "general_company_discovery",
  "startup_company_discovery",
];

/**
 * Take a checkpoint that can be trusted, or say why it cannot.
 *
 * NEVER CLAIM A CAPABILITY IS COMPLETE WHEN ITS DATA IS MISSING. That is the
 * whole invariant, and it is checked rather than assumed — a checkpoint that
 * fails it is reported incoherent and the caller must not persist it. Refusing
 * to write costs one unrecoverable slice; writing costs the lineage its entire
 * continuation budget and its frontier.
 */
export function checkpointSnapshot(
  state: CapabilityExecutionState,
  companies: readonly EngineCompany[],
): CheckpointSnapshot {
  // DERIVED, NOT CARRIED — the same line the return path runs, for the same
  // reason. A snapshot that copied `state.company_keys` verbatim would
  // faithfully preserve whatever divergence already existed.
  const projected: CapabilityExecutionState = {
    ...state,
    company_keys: companies.map((c) => c.key),
  };
  const claimsCompanies = projected.completed_capabilities
    .filter((c) => CAPABILITIES_THAT_MUST_YIELD_COMPANIES.includes(c));
  if (companies.length === 0 && claimsCompanies.length > 0) {
    return {
      state: projected,
      resume_records: [],
      coherent: false,
      incoherence:
        `${claimsCompanies.join(", ")} marked complete with an empty working set` +
        " — a resume would skip discovery and have nobody to investigate",
    };
  }
  const records = companies.map(toResumeRecord);
  const rule = checkpointCoherence(projected.completed_capabilities, records);
  if (!rule.coherent) {
    return { state: projected, resume_records: records, ...rule };
  }
  return {
    state: projected,
    resume_records: records,
    coherent: true,
    incoherence: null,
  };
}

/**
 * Why nobody reached the Company Brain — counted, not assumed.
 *
 * ── THE NUMBER IN THIS SENTENCE WAS NEVER MEASURED ─────────────────────────
 *
 * It read `${companies.length} companies carried no hiring assessment`, which
 * is the size of the WHOLE POOL, printed whether or not a single company
 * carried one. Run 07e973f1 reported "29 companies carried no hiring
 * assessment" with eleven enriched; task 9da530ae reported "50 companies
 * carried no hiring assessment" while ELEVEN carried one — all eleven
 * `hiring_not_verified`, which is a real finding and the opposite of an
 * absence.
 *
 * The distinction is the one the comment at the call site already insists on —
 * "nobody passed" and "nobody was offered" are different facts — applied one
 * level deeper. A pool nobody looked at and a pool that was looked at and found
 * not to be hiring are different facts too, and this sentence is the only place
 * a run says which one happened. It said the wrong one for both, and reading it
 * as evidence sent two separate investigations down the wrong path.
 */
export function emptyEligibleSetReason(
  companies: readonly EngineCompany[],
): string {
  const assessed = companies.filter((c) => c.hiring_assessment !== null).length;
  const unassessed = companies.length - assessed;
  const co = (n: number) => `${n} compan${n === 1 ? "y" : "ies"}`;
  const tail = " — nothing was evaluated, nothing was rejected";
  if (assessed === 0) {
    return `no company reached the Company Brain: none of the ${co(companies.length)} ` +
      `carried a hiring assessment` + tail;
  }
  return `no company reached the Company Brain: ${co(assessed)} ` +
    `${assessed === 1 ? "was" : "were"} assessed and none showed a qualifying opening` +
    (unassessed > 0
      ? `, and ${co(unassessed)} ${unassessed === 1 ? "was" : "were"} never assessed`
      : "") + tail;
}

/**
 * THE INVARIANT, AS A FUNCTION.
 *
 *   A capability may be marked completed only if every piece of state the
 *   capabilities after it require is durably in this checkpoint.
 *
 * `checkpointSnapshot` checked ONE instance of it — discovery must have
 * produced companies — and that is how the next instance shipped.
 * `hiring_verification` completed with four externally verified companies whose
 * assessments were not in the snapshot, and the resume that read that
 * checkpoint reported "the eligible set was empty (50 companies carried no
 * hiring assessment)". The stage label survived; the verdict it labelled did
 * not.
 *
 * A TABLE, so a capability added later is a row here rather than an incident.
 * Exported so the rule can be tested against a record that lies, which is the
 * only shape that can prove it bites — through `toResumeRecord` alone it is
 * unreachable, and an unreachable guard is a comment.
 *
 * Capabilities absent from the table require nothing: qualification and
 * persistence may both legitimately complete having produced nothing.
 */
export function checkpointCoherence(
  completed: readonly string[],
  records: readonly CompanyResumeRecord[],
): { coherent: boolean; incoherence: string | null } {
  const rules: Array<{
    capability: CapabilityId;
    claims: (r: CompanyResumeRecord) => boolean;
    present: (r: CompanyResumeRecord) => boolean;
    what: string;
  }> = [
    {
      capability: "company_identity_resolution",
      claims: (r) => r.identity === "resolved",
      present: (r) => !!r.snapshot?.identity,
      what: "the resolved identity object",
    },
    {
      capability: "hiring_verification",
      claims: (r) => r.hiring === "verified_externally" ||
        r.hiring === "verified_from_existing_evidence",
      present: (r) => !!r.snapshot?.hiring_assessment,
      what: "the hiring assessment it verified",
    },
  ];
  for (const rule of rules) {
    if (!completed.includes(rule.capability)) continue;
    const lost = records.filter((r) => rule.claims(r) && !rule.present(r));
    if (lost.length > 0) {
      return {
        coherent: false,
        incoherence:
          `${rule.capability} marked complete, but ${lost.length} company(ies) ` +
          `claim a result whose ${rule.what} is not in the checkpoint` +
          ` — a resume would read them as never having been done`,
      };
    }
  }
  return { coherent: true, incoherence: null };
}

/**
 * Did anybody actually find out about this company's hiring?
 *
 * Two ways to have found out, and both are durable across a restore:
 *
 *   * the assessment cites a source — `yc_open_jobs` or `external_job_search`,
 *     meaning rows were inspected for this company; or
 *   * a hiring operation is recorded in `completed_operations`, meaning a paid
 *     call SETTLED with this company in its batch. It may have returned nothing
 *     naming this company, and that is still an answer.
 *
 * Neither holds when a call was killed mid-poll, timed out, was never made, or
 * when a restore lost the rows it produced — and those are the cases that must
 * stay on the frontier rather than becoming a verdict.
 *
 * `completed_operations` is written immediately after a batch completes and
 * before any verdict is assessed, and it travels in the checkpoint, so this is
 * answerable in a later generation that holds none of the original rows.
 */
export function hiringEvidenceWasInspected(c: {
  hiring_assessment?: { evidence_source?: string | null } | null;
  completed_operations?: readonly string[];
}): boolean {
  const source = c.hiring_assessment?.evidence_source ?? "none";
  if (source !== "none") return true;
  return (c.completed_operations ?? []).some((op) => op.includes("hiring_verification"));
}

export function toResumeRecord(c: EngineCompany): CompanyResumeRecord {
  const url = c.identity?.linkedin_company_url ?? c.company.linkedin_company_url ?? null;
  return {
    company_key: c.key,
    company_name: c.prequalified?.name ?? c.company.company_name ?? c.key,
    // ── THE STATE THAT SURVIVES THE PROCESS ────────────────────────────────
    //
    // This record IS the durable form of a deferred candidate: the checkpoint
    // writes it to `tasks.result`, so nine candidates the deadline never
    // reached come back as nine rows saying `identity: "deferred"` rather than
    // as an absence. `nextStageFor` reads `deferred` and `provider_error` as
    // "still owes identity", and `shouldSkipProviderCall` refuses to treat
    // either as done — so a continuation resumes precisely them.
    //
    // Checked BEFORE the resolution states, because a blocked company has no
    // resolution to report; checked against `capability` so an enrichment
    // failure cannot be recorded as an identity outcome.
    identity: c.identity === null && c.stage_block?.capability === "company_identity_resolution"
      ? (c.stage_block.reason === "provider_error" ? "provider_error" : "deferred")
      : c.identity === null ? "not_started"
      : identityIsActionable(c.identity) ? "resolved"
      : c.identity.status === "mismatch" ? "mismatch" : "unresolved",
    // THE SAME DISTINCTION IDENTITY ALREADY MAKES, now that enrichment records
    // it. `deferred` and `provider_error` are resumable — `nextStageFor` reads
    // them as "still owes enrichment" — while `empty` was answered and asking
    // again buys the same silence. Collapsing all three into `not_started`
    // (what this did) made a continuation re-buy the answered ones and made a
    // deferred one indistinguishable from a company that was never reached.
    enrichment: c.enriched !== null ? "completed"
      : c.enrichment_outcome === "deferred" ? "deferred"
      : c.enrichment_outcome === "provider_error" ? "provider_error"
      : c.enrichment_outcome === "empty" ? "empty"
      : c.identity && identityIsActionable(c.identity) ? "not_started" : "not_required",
    // ── THE ONE LINE THAT MADE THE LOSS TERMINAL ──────────────────────────
    //
    // The final branch was `: "not_verified"`, which collapsed two different
    // facts into one finished state: "a settled call covered this company and
    // found nothing matching" and "we never found out". `nextStageFor` treats
    // `not_verified` as final, so both became companies nothing would revisit.
    //
    // The discriminator is NOT "did the assessment see rows" — a company can be
    // legitimately negative with zero rows of its own, when the batch it was in
    // completed and named somebody else. It is WHETHER A SETTLED PROVIDER CALL
    // COVERED THIS COMPANY, which `completed_operations` records durably and
    // which therefore survives a restore.
    hiring: !c.hiring_assessment ? "not_started"
      : c.hiring_assessment.verdict === "hiring_verified"
        ? (c.hiring_assessment.evidence_source === "external_job_search"
          ? "verified_externally" : "verified_from_existing_evidence")
      : c.hiring_assessment.verdict === "hiring_verification_needed" ? "verification_needed"
      : c.hiring_assessment.verdict === "watch" ? "verification_needed"
      : hiringEvidenceWasInspected(c) ? "not_verified"
      : "evidence_unavailable",
    brain: !c.brain ? "not_started"
      : c.brain.outcome === "QUALIFIED" ? "qualified"
      : c.brain.outcome === "REVIEW" ? "review" : "rejected",
    founder: c.verdict !== "pass" ? "not_eligible"
      : c.verified_founders.length > 0 ? "completed"
      : c.founders.length > 0 ? "unresolved" : "not_started",
    linkedin_company_url: url,
    completed_operations: c.completed_operations,
    // ── THE DURABLE WORKING SET ────────────────────────────────────────────
    //
    // Written for EVERY company, not only the shortlisted ones, so a resume
    // restores the whole pool with its triage verdicts intact — an excluded
    // company must come back excluded rather than come back unknown, or the
    // Workbench would lose the reason it was never pursued.
    snapshot: {
      company: c.company as unknown as Record<string, unknown>,
      yc_open_jobs: c.yc_open_jobs.slice(0, MAX_SNAPSHOT_JOBS) as unknown as Record<
        string, unknown>[],
      ...(c.first_in_function
        ? { first_in_function: c.first_in_function as unknown as Record<string, unknown> }
        : {}),
      prequalified: (c.prequalified ?? null) as unknown as Record<string, unknown> | null,
      prequal_key: c.prequal_key,
      shortlisted: c.shortlisted,
      enriched: (c.enriched ?? null) as unknown as Record<string, unknown> | null,
      // CARRIED, NOT RECOMPUTED. A restored company with no `enriched` row is
      // otherwise indistinguishable from one that was never attempted, so a
      // continuation would report a provider error or a deadline deferral as
      // `not_attempted` — losing precisely the fact the outcome exists to keep.
      enrichment_outcome: c.enrichment_outcome,
      // P4 — THE UNION SURVIVES THE PROCESS. A continuation that forgot which
      // routes found a company would report one source for a merged company.
      found_by: (c.found_by ?? []) as unknown as Record<string, unknown>[],
      observations: (c.observations ?? []) as unknown as Record<string, unknown>[],
      identity_conflicts: (c.identity_conflicts ?? []) as unknown as Record<string, unknown>[],
      // THE FRONTIER SURVIVES THE PROCESS. Without these three a continuation
      // cannot tell a company that is waiting from one that was closed, and the
      // pool is frozen at whatever the first invocation selected.
      investigation_state: c.investigation_state,
      investigation_rank: c.investigation_rank,
      // WHY a closed company was closed — a continuation otherwise restores the
      // state with no reason, and the Workbench cannot say what closed it.
      shortlist_exclusion: c.shortlist_exclusion,
      triage: (c.triage ?? null) as unknown as Record<string, unknown> | null,
      // ── THE RESOLVED IDENTITY ITSELF ────────────────────────────────────
      //
      // `identity: "resolved"` and `linkedin_company_url` on the record say
      // that identity WAS resolved; they are not the resolution. Every paid
      // stage after identity selects on the OBJECT — `hiring_verification`
      // filters `c.identity && identityIsActionable(c.identity)` — so a
      // restored company without it is invisible to them.
      //
      // That is how a resumed slice reported "no company had a relevant
      // commercial role" with `targets: 0` while holding a fully enriched
      // company and a paid hiring run waiting to be adopted: identity
      // resolution was `skipped_resumed: completed in an earlier run`, so
      // nothing rebuilt the object it had produced.
      identity: (c.identity ?? null) as unknown as Record<string, unknown> | null,
      // ── AND THE HIRING VERDICT, FOR EXACTLY THE SAME REASON ─────────────
      //
      // `hiring: "verified_externally"` on the record above is a LABEL. The
      // Company Brain's eligibility filter reads the OBJECT — a company with
      // `hiring_assessment === null` "carried no hiring assessment" however
      // emphatic the label is.
      //
      // Task 02ea3aed: four companies verified from 148 paid job rows, resumed,
      // and the Brain reported "the eligible set was empty (50 companies
      // carried no hiring assessment)". `hiring_verification` was already
      // `completed`, so nothing recomputed them — and nothing could, because
      // their `completed_operations` forbids re-buying the search. A verdict
      // the run paid for, destroyed by the resume built to preserve it.
      //
      // `hiring_jobs` travels with it: the verdict cites those rows, and a
      // citation whose evidence is gone is not a citation.
      hiring_assessment: (c.hiring_assessment ?? null) as unknown as
        Record<string, unknown> | null,
      // GUARDED, like `yc_open_jobs` is not — because a caller can hand this a
      // partially-built company (a restored record, a fixture) and a checkpoint
      // writer must never be the thing that throws.
      hiring_jobs: (Array.isArray(c.hiring_jobs) ? c.hiring_jobs : [])
        .slice(0, MAX_SNAPSHOT_JOBS) as unknown as Record<string, unknown>[],
      // ── AND THE BRAIN'S OWN DECISION, THE THIRD IN THIS SERIES ──────────
      //
      // `brain: "qualified"` on the record is a LABEL. `c.brain` is the
      // DECISION, and `decideCompanyBrain` is the only thing that ever set it —
      // so every continuation started with none and re-decided companies it had
      // already qualified, paying the identity reserve for all of them.
      brain: (c.brain ?? null) as unknown as Record<string, unknown> | null,
      // ── AND THE EVALUATION THE BRAIN'S DECISION CITES. THE FOURTH ────────
      //
      // The other three in this series were labels without their objects. This
      // one is worse: the object was never written at all, while the `brain`
      // beside it was — and the pair is what made the loss PERMANENT rather
      // than merely wasteful.
      //
      // `buildLeadVerdict` reads `mission_evaluation.icp_fit`. Without it
      // `icpVerdictFrom` returns `insufficient_evidence`, and
      // `qualificationDecision` turns that into "ICP fit could not be
      // established" — for a company the evaluator had already judged. And
      // because `brain` DID survive, the restored-decision branch above
      // short-circuits before the evaluator can run again, so the company is
      // never re-judged either.
      //
      // Task 57b937ab: DiligenceVault (67 employees, "clearly offers a B2B
      // software platform") and FastSpring (188, "SaaS payments platform,
      // Belfast office") both came back `held_for_evidence` with
      // `mission_decision: null` and `mission_failed_requirements: []`. Nothing
      // failed. The record of their evaluation had simply stopped existing.
      // Thirty-eight companies were evaluated across that lineage and none
      // could ever qualify.
      mission_evaluation: (c.mission_evaluation ?? null) as unknown as
        Record<string, unknown> | null,
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Rebuild the working set from a checkpoint — the missing half of resume.
 *
 * Discovery is the only step that populates `companies`, and a continuation
 * skips it as already-complete. Without this, every downstream stage on a
 * resumed run iterates an empty array and nothing is ever finished: deferred
 * identity candidates stay deferred forever, and the capability that stayed
 * `incomplete` to protect them can never reach a truthful completion.
 *
 * Restores identity and enrichment that were already PAID FOR, so a resumed run
 * continues from the evidence it owns rather than buying it again. Records
 * without a snapshot — checkpoints written before the field existed — are
 * skipped, which degrades to the previous behaviour instead of throwing.
 */
export interface BrainJudgementInputs {
  gates: Parameters<typeof decideCompanyBrain>[0]["gates"];
  policy: Parameters<typeof decideCompanyBrain>[0]["policy"];
  hiring_verified: boolean;
  grounding: Parameters<typeof decideCompanyBrain>[0]["grounding"];
  enrichment_planned: boolean;
}

/**
 * Re-judge a company against a NEW mission evaluation, by the engine's own rule.
 *
 * ── THE RUN THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * Lineage e5d4fc14, 2026-09-05. P4 read Metaview's pricing page, resolved the
 * one open requirement and wrote `decision: "qualified"`, `mission_fit: "pass"`,
 * five verified receipts, zero unknown fields, match score 95. The run reported
 * ZERO qualified companies and delivered nothing.
 *
 * The write-back set `mission_evaluation` and stopped there. `c.verdict` is
 * derived from `c.brain.outcome`, `state.qualified_company_keys` is derived from
 * `c.verdict`, and `qualifiedIn()` — quota logic, delivery, the final result and
 * persistence — reads that array. None of them were touched, so a company the
 * system had proved was a match could not be counted or returned.
 *
 * ── WHY THIS LIVES HERE ────────────────────────────────────────────────────
 *
 * `decideCompanyBrain` needs the gates, the applied policy, the hiring verdict
 * and the grounding — all computed inside the qualification loop from state no
 * caller can reconstruct. Re-deriving them outside the engine would be a SECOND
 * answer to "is this company qualified", and the two would drift. So the engine
 * keeps what it judged with (`brain_inputs`) and exposes this one reconciliation
 * point; `run-agent` calls it rather than assigning fields itself.
 *
 * Idempotent: applying the same evaluation twice reaches the same verdict and
 * the key arrays are rebuilt from scratch, so a company is counted once.
 */
export function reapplyMissionEvaluation(
  run: { companies: EngineCompany[]; state: CapabilityExecutionState },
  updates: ReadonlyArray<{ company_key: string; evaluation: MissionEvaluation }>,
  /**
   * Lead V2: re-derive the qualified set from the canonical P5 decision, as the
   * engine did — never overwrite it with the legacy verdict set.
   */
  canonical?: Parameters<typeof canonicalDecisions>[1],
): { reapplied: number; qualified_added: string[] } {
  const before = new Set(run.state.qualified_company_keys);
  let reapplied = 0;

  for (const u of updates) {
    const c = run.companies.find((x) => x.key === u.company_key);
    if (!c) continue;
    c.mission_evaluation = u.evaluation;
    reapplied++;

    // Without the captured inputs this company was never judged by the Brain in
    // this run; leaving the verdict alone is the honest outcome — better an
    // uncounted company than one counted by a rule we had to invent.
    const bi = c.brain_inputs;
    if (!bi) continue;

    const e = u.evaluation;
    c.brain = decideCompanyBrain({
      gates: bi.gates,
      semantic: {
        mission_fit: e.mission_fit,
        icp_fit: e.icp_fit,
        match_score: e.match_score,
        business_model: "unknown",
        company_fit: e.mission_fit,
        confidence: e.confidence,
        agentory_use_case: e.icp_fit === "strong"
          ? "strong"
          : e.icp_fit === "plausible"
          ? "plausible"
          : "weak",
        supporting_evidence: e.matched_requirements.map(
          (m) => `${m.requirement}: ${m.excerpt}`),
        conflicting_evidence: e.failed_requirements.map(
          (f) => `${f.requirement}: ${f.why}`),
        // `fit` is null for a company that never reached the deterministic gate;
        // the evaluator's own unknowns still stand on their own.
        unknown_fields: [...new Set([
          ...e.unknown_fields, ...(c.fit?.missing_evidence ?? []),
        ])],
        reason: e.reasoning,
      },
      policy: bi.policy,
      hiring_verified: bi.hiring_verified,
      grounding: bi.grounding,
    } as Parameters<typeof decideCompanyBrain>[0]);

    c.classification = {
      verdict: e.mission_fit === "pass" ? "pass"
        : e.mission_fit === "fail" ? "fail" : "unknown",
      reason: e.reasoning,
      source: "mission_evaluation",
    };

    // THE SAME PRECONDITION THE FIRST PASS APPLIES. Enrichment was planned and
    // produced no evidence => a HOLD, never a pass, however the model reads the
    // web page. Re-judging without this would let P4 qualify a company the first
    // pass deliberately held.
    if (c.brain.outcome === "QUALIFIED" && bi.enrichment_planned &&
        !enrichmentIsEvidence(c.enrichment_outcome)) {
      c.decision_source = "insufficient_evidence";
      c.verdict = "unknown";
      continue;
    }
    c.decision_source = "gpt_evaluation";
    c.verdict = c.brain.outcome === "QUALIFIED"
      ? "pass"
      : c.brain.outcome === "REJECT"
      ? "reject"
      : "unknown";
  }

  // ── THE AUTHORITATIVE COUNT, REBUILT FROM THE SAME EXPRESSION ────────────
  //
  // Identical to the qualification loop's own line. Rebuilt wholesale rather
  // than appended to, so re-applying the same verdict cannot count a company
  // twice.
  run.state.qualified_company_keys = canonical
    ? canonicalQualifiedKeys(run.companies, canonical)
    : run.companies.filter((c) => c.verdict === "pass").map((c) => c.key);
  run.state.unknown_company_keys = run.companies
    .filter((c) => c.verdict === "unknown").map((c) => c.key);

  return {
    reapplied,
    qualified_added: run.state.qualified_company_keys.filter((k) => !before.has(k)),
  };
}

export function restoreWorkingSet(
  records: readonly CompanyResumeRecord[],
): EngineCompany[] {
  const out: EngineCompany[] = [];
  for (const r of records) {
    const s = r.snapshot;
    if (!s || !s.company) continue;
    addCompany(
      out,
      s.company as unknown as NormalizedHiringCompany,
      (s.yc_open_jobs ?? []) as unknown as NormalizedHiringJob[],
      s.prequal_key ?? null,
      // KEYED AS RECORDED. See `addCompany` — a restored company whose identity
      // resolved carries a LinkedIn url, and recomputing would rename it.
      r.company_key,
    );
    const c = out.find((x) => x.key === r.company_key);
    if (!c) continue;
    if (s.first_in_function) c.first_in_function = s.first_in_function as unknown as FirstInFunctionEvidence;
    c.found_by = Array.isArray(s.found_by) ? s.found_by as unknown as FoundBy[] : [];
    c.observations = Array.isArray(s.observations) ? s.observations as unknown as CandidateObservation[] : [];
    c.identity_conflicts = Array.isArray(s.identity_conflicts) ? s.identity_conflicts as unknown as IdentityConflict[] : [];
    c.prequalified = (s.prequalified ?? null) as unknown as EngineCompany["prequalified"];
    c.shortlisted = s.shortlisted === true;
    c.enriched = (s.enriched ?? null) as unknown as NormalizedHiringCompany | null;
    // NARROWED, because a checkpoint is untrusted input. A record written
    // before this field existed has no outcome and degrades to `not_attempted`
    // — except where the evidence itself survived, which IS a success.
    c.enrichment_outcome = c.enriched !== null
      ? "success"
      : asEnrichmentOutcome(s.enrichment_outcome);
    // NARROWED, and an absent value returns the company to the FRONTIER rather
    // than closing it — the safe direction for a pre-frontier checkpoint.
    c.investigation_state = asInvestigationState(s.investigation_state);
    c.shortlist_exclusion = typeof s.shortlist_exclusion === "string" ? s.shortlist_exclusion : null;
    c.investigation_rank = typeof s.investigation_rank === "number"
      ? s.investigation_rank
      : Number.MAX_SAFE_INTEGER;
    c.triage = (s.triage ?? null) as unknown as TriageVerdict | null;
    // ── THE EVIDENCE, NOT JUST THE COMPANY ────────────────────────────────
    //
    // `toResumeRecord` has written `snapshot.identity` since the fix whose
    // comment says why: "Every paid stage after identity selects on the OBJECT
    // — `hiring_verification` filters `c.identity && identityIsActionable(...)`
    // — so a restored company without it is invisible to them."
    //
    // Nothing read it back. Half a fix: the object was persisted on every
    // checkpoint and dropped on every restore, so the failure that comment
    // describes kept happening. Task 02ea3aed, live: 50 companies restored, 21
    // shortlisted, and `company_identity_resolution` reported "0 resolved, 10
    // deferred" while eleven resolved identities sat in the checkpoint it had
    // just read. `hiring_verification` then found `targets: 0`, and the Brain
    // reported the eligible set empty.
    //
    // NARROWED THE SAME WAY AS EVERY OTHER FIELD HERE: a checkpoint is
    // untrusted input, and an absent value degrades to the pre-restore
    // behaviour rather than throwing.
    c.identity = (s.identity ?? null) as unknown as EngineCompany["identity"];
    c.hiring_assessment = (s.hiring_assessment ?? null) as unknown as
      EngineCompany["hiring_assessment"];
    c.hiring_jobs = Array.isArray(s.hiring_jobs)
      ? (s.hiring_jobs as unknown as NormalizedHiringJob[]) : [];
    c.brain = (s.brain ?? null) as unknown as EngineCompany["brain"];
    // THE REASONING BEHIND THAT DECISION. Restored beside it, because a brain
    // outcome without the evaluation it cites is what `buildLeadVerdict` reads
    // as "ICP fit could not be established".
    c.mission_evaluation = (s.mission_evaluation ?? null) as unknown as
      EngineCompany["mission_evaluation"];
    // A company already carried to a terminal outcome must not re-enter the
    // frontier; `shortlisted` stays the derived view of that.
    c.shortlisted = wasInvestigated(c.investigation_state);
    // THE LEDGER OF WHAT WAS BOUGHT. `shouldSkipProviderCall` reads this, and it
    // is the only thing standing between a resume and paying twice.
    for (const op of r.completed_operations) {
      if (!c.completed_operations.includes(op)) c.completed_operations.push(op);
    }
  }
  return out;
}

/**
 * Capabilities that BUILD the working set.
 *
 * Skipping any of them on a resume is what leaves `companies` empty, so these
 * are exactly the steps that must trigger a restore.
 */
/**
 * THE CAPABILITIES A REPLENISHMENT DEBT MAY REOPEN — discovery, and only
 * discovery.
 *
 * Its own set rather than a reuse of `WORKING_SET_CAPABILITIES`, which also
 * contains `known_company_resolution`: resolving a named list is not something
 * a wider pool is ever the answer to, and re-running it would re-ask a question
 * whose answer has not changed.
 */
const DISCOVERY_REPLENISHABLE: ReadonlySet<string> = new Set([
  "startup_company_discovery", "general_company_discovery",
  // P3: a spent job-first pool widens by the job search's next `page`
  // (canary 03f4c9c6 idled four slices without this).
  "job_discovery",
]);

/**
 * The stages whose outstanding work is paid before any provider stage reopens.
 *
 * Qualification only: it is the one stage that can finish a company using
 * evidence already bought, so a slice that owes it is a slice that can produce
 * a verdict without spending. Every other stage's debt implies a purchase, and
 * those keep the plan's own order.
 */
const QUALIFICATION_PRIORITY_CAPABILITIES: readonly CapabilityId[] = [
  "company_brain_qualification",
];

const WORKING_SET_CAPABILITIES: ReadonlySet<string> = new Set([
  "startup_company_discovery", "general_company_discovery", "known_company_resolution",
  // P5.2: the P3 job-first route fills the working set too. Without it a
  // job-first continuation that did NOT reopen discovery (a slice stopped
  // mid-qualification) skipped `job_discovery` as done and restored nobody —
  // only the replenishment path, which has its own set, ever brought the pool
  // back.
  "job_discovery",
]);

/**
 * Discovery capabilities this engine actually drives, through ONE shared stage.
 *
 * Membership here means: the planner chooses this capability's actors, the
 * validator refuses what it may not run, and a refusal ends the run honestly.
 * A discovery capability NOT listed is declared in the graph and reported as
 * `skipped_no_input` — visible, never silently treated as done.
 *
 * `funding_signal_discovery` and `expansion_signal_discovery` are deliberately
 * absent: they are declared but undriven, and adding them here would claim a
 * normalizer and a signal contract that do not exist yet. That is a separate
 * piece of work, not a set membership.
 */
export const ENGINE_DRIVEN_DISCOVERY: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "startup_company_discovery",
  "general_company_discovery",
  // Joined when `apify_funding_rounds_datahyena` was carded: it has a verified
  // input schema, a bounded compiler, a normalizer and a cost model, which are
  // the four things membership here has always required.
  "funding_signal_discovery",
  // P3: LinkedIn job search, discovery compiler, employer identity from the row.
  "job_discovery",
]);

/**
 * Project the engine's working set into portfolio candidates.
 *
 * The portfolio module has existed and been tested since the previous change and
 * nothing consumed it, so a request for 100 still ran the old quota path. This
 * is the adapter that makes it real: one candidate per company, carrying the
 * explicit Brain outcome, the canonical identity state and the commercial tier.
 */
export function toPortfolioCandidates(
  companies: readonly EngineCompany[],
): PortfolioCandidate[] {
  return companies
    .filter((c) => c.prequalified !== null)
    .map((c) => {
      const pq = c.prequalified!;
      const identity: PortfolioCandidate["identity_status"] =
        c.identity && identityIsActionable(c.identity) ? "verified_match"
        : c.identity?.status === "mismatch" ? "rejected_mismatch"
        : "unresolved";
      const brain: PortfolioCandidate["brain"] =
        c.brain?.outcome === "QUALIFIED" ? "qualified"
        : c.brain?.outcome === "REVIEW" ? "review"
        : c.brain?.outcome === "REJECT" ? "reject"
        : null;
      return {
        company_key: c.key,
        company_name: pq.name,
        domain: pq.canonical_domain,
        tier: c.hiring_assessment?.tier ?? pq.best_tier,
        brain,
        identity_status: identity,
        active: true,
        // Geography and B2B relevance are decided by the Brain's own gates; the
        // floor only re-checks what it can see here.
        geography_ok: true,
        b2b_use_case: c.brain ? c.brain.outcome !== "REJECT" : true,
        // ── "FACTUAL SIGNAL" IS NOT "COMMERCIAL SIGNAL" ──────────────────
        //
        // These two disjuncts both ask whether a COMMERCIAL role was found, so
        // a company with three open engineering roles read as having no
        // factual signal at all and `floorFailure` deleted it. That is the
        // same authority inversion the `no_tier` rung below already carries a
        // paragraph about, surviving one layer further out.
        //
        // `pq.eligible` is the mission's own verdict on this company's
        // openings — see `roleEvidence` in `leadCommercialPrequalification`.
        // Adding it, rather than replacing the two above, keeps a company with
        // a real commercial tier but an out-of-range headcount reporting
        // exactly what it reported before.
        has_factual_signal: (c.hiring_assessment?.commercial_jobs.length ?? 0) > 0 ||
          pq.best_tier !== null || pq.eligible,
        source_evidence: !!pq.yc_url || !!pq.canonical_domain,
        source_url: pq.yc_url ?? (pq.canonical_domain ? `https://${pq.canonical_domain}` : null),
        contact_ready: c.contact_identities.length > 0,
        round: c.hiring_assessment?.strongest?.round ?? null,
        score: pq.score,
      };
    });
}

/**
 * The progress snapshot to persist once the invocation has ENDED.
 *
 * TEST task 41342269 finished with seven capabilities still pending — a
 * legitimate partial result — and its last published snapshot said
 * `in_progress: true`. Anything reading that field would have shown "Sourcing in
 * progress" forever on a workflow that had already stopped.
 *
 * PENDING CAPABILITIES ARE NOT ACTIVITY. The only thing that still counts as
 * "waiting" after the invocation returns is a BILLED Actor run that has not been
 * read, because that one really does have work happening elsewhere.
 */
export function finalizedProgress(
  state: CapabilityExecutionState,
): EngineProgress | null {
  // ── A RUN THAT ENDED BEFORE ANY STAGE PUBLISHED STILL HAPPENED ───────────
  //
  // `publish()` runs at the END of a completed capability. When discovery
  // EXHAUSTS every approved provider — every Actor errored, or the entry
  // capability is one the engine does not drive — the loop breaks before the
  // first publish, so `state.progress` was never set. This function returned
  // null, run-agent then wrote no `workbench_progress`, and the frontend's
  // `readWorkbenchProgress` returned null: the Workbench rendered NOTHING.
  //
  // Nothing is the one answer that is never true. The run was attempted, and a
  // measured zero is a result — `progressLines` shows "Accounts found: 0" and
  // leaves every later counter correctly UNREACHED, so this states what
  // happened without implying any stage ran. The terminal reason itself travels
  // separately, on the route result.
  //
  // This is deliberately NOT a success: `qualified_companies` is 0, no
  // evaluation row is invented, and nothing becomes actionable.
  if (!state.progress) {
    if (state.completed_capabilities.length === 0 && !state.terminal_reason) return null;
    return {
      stage: "accounts_found",
      accounts_found: 0,
      evaluated: 0,
      eligible_opportunities: 0,
      exclusion_reasons: {},
      identity_resolved: 0,
      identity_unresolved: 0,
      companies_enriched: 0,
      hiring_verified: 0,
      qualified_companies: 0,
      decision_makers_verified: 0,
      open_jobs_evaluated: 0,
      shortlisted: 0,
      in_progress: false,
      awaiting_external_run: state.pending_runs.length > 0,
    };
  }
  return {
    ...state.progress,
    in_progress: false,
    awaiting_external_run: state.pending_runs.length > 0,
  };
}

/**
 * How many LinkedIn company URLs go into one company-details request.
 *
 * The Actor accepts a list; this is the batch bound, not a per-company loop.
 */
export const COMPANY_DETAILS_BATCH_SIZE = 10;

// `resolveTriageConcurrency` lives in `leadInvestigationBudget.ts` with the
// other capacity resolvers. THE ENGINE READS NO ENVIRONMENT OF ITS OWN — it
// takes `opts.readEnv` and passes it down, which is what keeps it runnable in a
// test without a process environment. Test 20 of `cappedIdentityResolution`
// enforces this by scanning this file for the runtime env accessor, so even
// naming it here would fail the guard.

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The company-details row's own url, matched against this batch in canonical form. */
function batchKeyMatches(
  byUrl: Map<string, EngineCompany[]>,
  batchByCanonical: Map<string, string>,
  url: string,
): EngineCompany[] {
  const key = batchByCanonical.get(normalizeCompanyLinkedInUrl(url) ?? url);
  return key ? byUrl.get(key) ?? [] : [];
}

/**
 * The LinkedIn company url a company-details row was ASKED for, canonical.
 * harvestapi/linkedin-company echoes it as `originalQuery.search`; a bare
 * string is accepted for older runs. Anything else is null — never inferred.
 */
export function requestedCompanyUrlOf(row: Record<string, unknown>): string | null {
  const q = row.originalQuery;
  const asked = typeof q === "string"
    ? q
    : q && typeof q === "object" ? (q as Record<string, unknown>).search : null;
  return typeof asked === "string" ? normalizeCompanyLinkedInUrl(asked) : null;
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * `stop` is checked before each item is CLAIMED, so a closed deadline ends the
 * stage without abandoning work already in flight. Deliberately not
 * `Promise.all` over everything: a shortlist of five resolved all at once is
 * five simultaneous paid Actor starts, which is precisely the burst this
 * mission's budget cannot absorb.
 */
export async function runBounded<T>(
  items: readonly T[], limit: number,
  worker: (item: T) => Promise<void>,
  stop: () => boolean = () => false,
): Promise<{ processed: number; skipped: number }> {
  let next = 0;
  let processed = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: width }, async () => {
    for (;;) {
      if (stop()) return;
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
      processed++;
    }
  });
  await Promise.all(lanes);
  return { processed, skipped: items.length - processed };
}

/**
 * SCORE the discovered rows — no provider, no cost, and NO SHORTLIST.
 *
 * ── WHAT WAS DELETED FROM HERE, AND WHY ─────────────────────────────────────
 *
 * This used to also DECIDE the shortlist, via
 * `shortlistForLinkedInResolution(result, requestedLeadCount, ceiling)` — which
 * is `min(ceiling, max(5, requestedLeadCount * 2))`, the exact coupling between
 * "how many leads to return" and "how many companies to pay for" that the
 * investigation budget exists to break.
 *
 * It was also DEAD. `applyMissionIntelligence` runs immediately afterwards and
 * overwrites `c.shortlisted` for every company unconditionally, so this
 * computed a spend decision, wrote it onto the working set, and had it
 * discarded microseconds later. Two shortlist mechanisms, one of them
 * load-bearing, the other still shaping `state.prequalification.shortlist_keys`
 * — which is what the run then REPORTED as the shortlist. The telemetry named a
 * set of companies that had not been the ones investigated.
 *
 * Prequalification now does only what it is good at: dedupe, drop scraper
 * artifacts, and score. Who gets paid for is decided once, downstream, by
 * `buildSmartShortlist` against the investigation budget.
 */
export function applyPrequalification(
  state: CapabilityExecutionState,
  companies: EngineCompany[],
  rawRows: readonly YcCompanyInput[],
  size: {
    min: number | null; max: number | null;
    /** The Brain's own `hard_constraints`. See `resolveEmployeeBounds`. */
    hard_constraints?: readonly string[] | null;
  },
  /**
   * The Mission's qualification context. Omitted on a missionless run, where
   * the workspace Brain keeps its previous authority and behaviour is unchanged.
   */
  qualification?: QualificationContext | null,
  /**
   * The mission's own required signals.
   *
   * Passed so the free pre-pass can tell whether a TECHNICAL opening is the
   * evidence this mission asked for. Omitted keeps the previous behaviour, in
   * which only a commercial role tier counted.
   */
  requiredSignals?: ReadonlyArray<{ type?: string; role_families?: string[] }> | null,
): PrequalificationResult {
  // THE MISSION DECIDES WHAT COUNTS AS A QUALIFYING ROLE, AND WHETHER SIZE MAY
  // REJECT. Both used to be answered by the workspace Brain and a hard-coded
  // commercial role list, which is how a "hiring software engineers" Mission
  // qualified zero of a hundred companies (TEST run cf6cce3d).
  const bounds = qualification
    ? resolveEmployeeBounds(qualification, {
      employee_min: size.min, employee_max: size.max,
      hard_constraints: size.hard_constraints ?? null,
    })
    // MISSIONLESS RUNS ARE UNCHANGED: legacy semantics already enforced the
    // workspace bound, and there is no Mission here to outrank it.
    : { min: size.min, max: size.max, enforceable: true, source: "brain_advisory" as const };

  // THE TWO FACTS THE POLICY BELOW IS BUILT FROM, read once.
  //
  // `isHiringSignal` canonicalises the type rather than comparing it: GPT
  // wrote `{ type: "currently hiring" }` on run 486928e8, and a literal
  // `=== "hiring"` said that mission required no hiring at all.
  const hiringSignals = (requiredSignals ?? []).filter((sig) =>
    isHiringSignal({ type: String(sig?.type ?? "") }));
  const missionRequiresHiring = hiringSignals.length > 0;
  const hiringRoleFamilies = hiringSignals
    .flatMap((sig) => sig?.role_families ?? []).map((f) => String(f).trim())
    .filter((f) => f.length > 0);

  const result = prequalifyYcCompanies(
    rawRows,
    { min: bounds.min, max: bounds.max },
    {
      vocabulary: qualification?.role_vocabulary ?? null,
      size_enforceable: bounds.enforceable,
      // ── WHAT DOES THIS MISSION ACCEPT AS HIRING EVIDENCE? ───────────────
      //
      // Derived from the mission's compiled `required_signals`, never from the
      // sentence. Both answers below come from the SAME two facts — does the
      // mission require hiring, and did it name any role family — so they are
      // computed once, above, rather than twice from two different readings.
      //
      // NAMED an engineering family → a technical opening is what the user
      // asked to see, and calling that company `technical_only` states the
      // opposite of the truth.
      //
      // NAMED NO family at all → the user constrained the COMPANY, not the
      // vacancy: "AI startups in the US currently hiring". Any opening is the
      // evidence. This is the case TEST run 486928e8 got wrong; the clause
      // below only tested for a named engineering family, so an unqualified
      // hiring mission fell through to the commercial-roles rule and excluded
      // all 100 companies it had just discovered.
      //
      // A mission asking for SALES hiring is unaffected by both: it names a
      // commercial family, so neither flag is set and an engineering opening
      // still proves nothing about GTM expansion.
      technical_roles_satisfy_signal: hiringRoleFamilies.some((f) =>
        /engineer|technical|developer|software|data|infra|platform|ml|ai/i.test(f)),
      any_open_role_satisfies_signal:
        missionRequiresHiring && hiringRoleFamilies.length === 0,
    },
  );
  const byKey = new Map(result.companies.map((c) => [c.company_key, c]));

  // SCORE ONLY. `shortlisted` stays false until `buildSmartShortlist` decides
  // it against the investigation budget — see this function's header for the
  // duplicate that used to set it here and be discarded.
  for (const c of companies) {
    c.prequalified = c.prequal_key ? byKey.get(c.prequal_key) ?? null : null;
  }

  // ── THE GENERIC PASS: EVERY COMPANY THE YC PASS COULD NOT READ ───────────
  //
  // A company reaches here unscored for exactly one reason — the YC pass reads
  // memo23's raw row shape and this company came from somewhere else. That is a
  // statement about the READER, not about the company, and it used to mean the
  // whole pool from every other actor went to identity resolution and
  // enrichment unranked and ungated.
  //
  // The generic pass reads the normalized company and its normalizer's own
  // `field_trust` map. There is no actor key in it and there must not be: a new
  // discovery actor is triaged the day its normalizer declares field trust,
  // with no change to this function.
  //
  // ── `prequal_key === null` IS LOAD-BEARING, NOT A TIDINESS CHECK ─────────
  //
  // `prequalified === null` alone is the wrong test, because it is ALSO true of
  // a company the YC pass REFUSED — a scraper artifact, a row with no name and
  // no website. Those keep their `prequal_key` and are deleted by the splice
  // loop below precisely because they carry no verdict.
  //
  // Such a row is not resurrected by being rescored: the generic pass carries
  // the same `ARTIFACT_DOMAINS` list and the same no-name rule, so it refuses
  // the row a second time and the splice still removes it. What it does instead
  // is COUNT IT TWICE. Measured on a three-row pool containing the YC directory
  // page and one empty row: `total_rows` 3 → 5, `artifacts_excluded` 2 → 4.
  // Those two numbers feed the funnel and are what an audit reads to decide
  // whether a pool was bad or a policy was, so inflating them turns a clean run
  // into an apparently dirty one.
  //
  // The engine already states the distinction this relies on: "a company
  // prequalification never saw is a company it has not rejected." A null key is
  // "never saw". A null verdict with a key is "rejected", and a rejection does
  // not need a second opinion.
  const unscored = companies.filter((c) =>
    c.prequalified === null && c.prequal_key === null);
  const generic = prequalifyDiscoveredCompanies(
    unscored.map((c) => c.company),
    { min: bounds.min, max: bounds.max },
    {
      // THE SAME AUTHORITY QUESTION THE YC PASS ASKS. A workspace Brain's
      // advisory range orders the pool; only a range the MISSION expressed may
      // remove anyone from it.
      size_enforceable: bounds.enforceable,
      mission_requires_hiring: missionRequiresHiring,
    },
  );

  // ARTIFACTS LEAVE THE WORKING SET, exactly as they do on the YC side.
  // A directory or platform page is not a prospect no matter which actor found
  // it, and one reached persistence as a qualified lead on an earlier run.
  const artifactKeys = new Set(generic.excluded.map((e) =>
    e.domain ?? `name:${e.name.trim().toLowerCase()}`));

  const genericByKey = new Map(generic.companies.map((c) => [c.company_key, c]));
  let genericScored = 0;
  for (let i = companies.length - 1; i >= 0; i--) {
    const c = companies[i];
    if (c.prequalified !== null) continue;
    const domain = c.company.canonical_domain;
    if (domain && artifactKeys.has(domain)) { companies.splice(i, 1); continue; }
    // A PLACEHOLDER EMPLOYER PAGE leaves too, website or not. Prequalification
    // excludes it by NAME, and the domain match above only removes what has a
    // domain: canary 16699a45's "Stealth Startup" had none, stayed in the pool,
    // and the funding screen paid Atomus to read it.
    if (isPlaceholderEmployerName(c.company.company_name)) { companies.splice(i, 1); continue; }
    // THE MODULE THAT SCORED IT OWNS THE KEY. Deriving it here would be a
    // second implementation of the same rule, and the two would disagree the
    // first time either changed.
    const scored = genericByKey.get(genericPrequalificationKey(c.company));
    if (scored) { c.prequalified = scored; genericScored++; }
    // NOT FOUND IS NOT REMOVED. The YC side splices an unscored row because
    // there it means the row was refused. Here it can only mean the two key
    // derivations disagreed, and deleting a company over a key mismatch is how
    // a run silently loses everything one actor paid to find.
  }

  // SCRAPER ARTIFACTS LEAVE THE WORKING SET ENTIRELY.
  //
  // The five empty rows memo23 returns all normalize to the same fallback key
  // (`yc_memo23:unknown`), so the engine's own dedupe collapsed them into ONE
  // company that prequalification had already refused to score. It could never
  // be paid for — but it counted as an account found and would have reached
  // persistence, which is how Y Combinator's own page once became a qualified
  // lead. A row with no name and no website is not a prospect.
  //
  // BUT UNSCORED IS NOT THE SAME AS REFUSED.
  //
  // `prequalifyYcCompanies` reads the raw memo23 rows and nothing else, so a
  // company discovered by any OTHER actor has no `prequal_key` and can never
  // gain a `prequalified` verdict. While memo23 was the only source those two
  // states were indistinguishable and this loop was right. With a second
  // discovery actor they are opposites: a LinkedIn candidate is unscored
  // because this pass does not know how to score it, not because it is junk —
  // and splicing it here silently deleted every row the breadth source paid to
  // find, leaving a run that widened its search and then investigated exactly
  // the same YC companies as before.
  //
  // A company prequalification never saw is a company it has not rejected.
  for (let i = companies.length - 1; i >= 0; i--) {
    const c = companies[i];
    if (c.prequal_key === null) continue;
    if (c.prequalified === null) companies.splice(i, 1);
  }

  // ── ONE RESULT DESCRIBES THE WHOLE POOL ─────────────────────────────────
  //
  // The funnel reads `eligible_companies` and `employee_size_excluded` off
  // `state.prequalification`. Reporting the YC half of a mixed pool while the
  // run acted on both halves is the same class of error as the old shortlist
  // telemetry, which named a set of companies that had not been investigated.
  //
  // Tier counts are NOT folded in: a generic company has no role tiers, and
  // adding it to `companies_with_commercial_roles` would assert a fact nobody
  // established.
  const merged = mergePrequalification(result, generic);

  state.prequalification = {
    version: merged.version,
    total_rows: merged.total_rows,
    unique_companies: merged.unique_companies,
    artifacts_excluded: merged.excluded.length,
    eligible_companies: merged.eligible_companies,
    employee_size_excluded: merged.employee_size_excluded,
    technical_only_companies: merged.technical_only_companies,
    // ── WHAT THE FREE PASS ACTUALLY REACHED ───────────────────────────────
    //
    // Split out because "the pre-pass ran" and "the pre-pass could read this
    // company" are different facts, and the second is the one that says whether
    // a new discovery actor is being triaged or silently waved through.
    generic_scored: genericScored,
    generic_version: generic.version,
    generic_with_trusted_size: generic.companies_with_trusted_size,
    generic_with_description: generic.companies_with_description,
    // ── THE FACTS TRAVEL WITH THE VERDICT ────────────────────────────────
    //
    // Without these, an audit can see "0 eligible" but not whether the pool was
    // empty of hiring companies or merely empty of the ROLE this mission
    // wanted. That ambiguity is what made a healthy pool read as an ICP
    // failure on run 1af9b9ea.
    companies_with_open_roles: merged.companies_with_open_roles,
    companies_with_commercial_roles: merged.companies_with_commercial_roles,
    companies_with_technical_roles: merged.companies_with_technical_roles,
    technical_roles_satisfy_signal: merged.technical_roles_satisfy_signal,
    any_open_role_satisfies_signal: merged.any_open_role_satisfies_signal,
    open_jobs_evaluated: merged.companies.reduce((n, c) => n + c.jobs.length, 0),
    companies: merged.companies.map((c) => ({
      company_key: c.company_key,
      name: c.name,
      canonical_domain: c.canonical_domain,
      team_size: c.team_size,
      size_status: c.size_status,
      best_tier: c.best_tier,
      score: c.score,
      strongest_signal: c.strongest_signal,
      // EVERY commercial job, not `openJobs[0]` — which for a YC startup is
      // almost always an engineer, and is what the old display showed.
      commercial_jobs: c.jobs.filter((j) => j.tier === "A" || j.tier === "B" || j.tier === "C")
        .map((j) => j.title),
      eligible: c.eligible,
      exclusion: c.exclusion,
      reasons: c.reasons,
    })),
  };
  // THE MERGED RESULT, not the YC one. A caller that read the return value and
  // the state would otherwise see two different pools.
  return merged;
}

/** Union of jobs kept by ANY approved pack. `filterJobsForPack` takes one pack. */
function keptForPacks(
  jobs: readonly NormalizedHiringJob[], packs: readonly RolePack[],
): NormalizedHiringJob[] {
  const out: NormalizedHiringJob[] = [];
  for (const pack of packs) {
    for (const j of filterJobsForPack(jobs, pack).kept) out.push(j);
  }
  return out;
}

/** Concepts a general company search may be run for, already bounded. */
/**
 * What the last discovery pass actually produced — FACTS, not a verdict.
 *
 * ── THE LINE THIS FUNCTION IS CAREFUL ABOUT ─────────────────────────────────
 *
 * It would be easy to make this the place that decides a pool is bad: match
 * names against /newsletter|community|magazine/, score relevance, and hand the
 * planner a conclusion. That is precisely the deterministic intelligence this
 * architecture keeps removing — it would be a second opinion about mission fit,
 * competing with the evaluator that already exists, encoded as a regex.
 *
 * So everything here is countable and checkable:
 *   * how many rows came back;
 *   * how many carry an identity anything downstream could resolve;
 *   * how many carry the evidence the MISSION said it required;
 *   * and problems stated as observations ("0 of 100 carry hiring evidence"),
 *     never as judgements ("this pool is mostly newsletters").
 *
 * GPT reads the facts and decides whether its strategy is working. That is the
 * division of labour: the engine can count, the model can judge.
 */
export function summariseDiscoveryPool(
  actorKey: string, companies: readonly EngineCompany[], mission: LeadMissionV1,
): DiscoveryResultsSummary {
  const identified = companies.filter((c) =>
    !!c.company.canonical_domain || !!c.company.linkedin_company_url);
  const needsHiring = (mission.directives?.required_evidence ?? [])
    .some((e) => /hiring/i.test(String(e))) ||
    (mission.required_signals ?? []).some((s) => /hiring/i.test(String(s.type)));
  const withHiring = companies.filter((c) => c.yc_open_jobs.length > 0);

  const observed_problems: string[] = [];
  if (companies.length === 0) {
    observed_problems.push("the actor returned no rows at all");
  }
  const unidentified = companies.length - identified.length;
  if (unidentified > 0) {
    observed_problems.push(
      `${unidentified} of ${companies.length} rows carry neither a domain nor a ` +
      `LinkedIn URL, so nothing downstream can resolve or enrich them`);
  }
  if (needsHiring && withHiring.length === 0 && companies.length > 0) {
    // THE OBSERVATION THAT WAS MISSING ON 25f3ff57. The mission required
    // embedded hiring evidence and the pool carried none; the run reported
    // `open_jobs_evaluated: 0` at the very end and nothing acted on it.
    observed_problems.push(
      `the mission requires hiring evidence and NONE of the ${companies.length} ` +
      `rows carry an open role — this actor does not return hiring state, so no ` +
      `amount of enrichment will produce it`);
  } else if (needsHiring && withHiring.length < companies.length) {
    observed_problems.push(
      `${companies.length - withHiring.length} of ${companies.length} rows carry ` +
      `no open role, and the mission requires hiring evidence`);
  }

  return {
    actor_key: actorKey,
    candidates_returned: companies.length,
    likely_companies: identified.length,
    irrelevant: unidentified,
    observed_problems,
  };
}
// ── THE DETERMINISTIC QUERY COMPILER IS DELETED ────────────────────────────
//
// `compileCompanySearchConcepts` lived here, with `CompanySearchConcepts`,
// `MAX_COMPANY_SEARCH_QUERIES` and `MAX_COMPANY_SEARCH_ROWS`. It authored a
// paid Actor's `searchQuery` from two mission fields — `verticals` and
// `business_models` — and dropped `stages`, `required_signals`,
// `required_signal_terms`, `employee_range` and every hard constraint on the
// way past. On run 25f3ff57 it compiled "10 qualified AI startups in the US
// currently hiring software engineers" into `searchQuery: "AI"` and
// `searchQuery: "startup"`.
//
// It lost its last production caller when both discovery capabilities moved
// onto the shared planner-driven stage. Kept as dead code it would be exactly
// what this architecture keeps deleting: deterministic intelligence sitting
// one import away from becoming a fallback again.
//
// GPT writes actor inputs now. `compileHarvestCompanySearchInput` and the
// catalog's `supported_filters` / `verified_enums` bound what it may say, and
// `known_defects` — including `company_search_query_is_name_match` — is what
// tells it not to put a concept in a name index.

function packTitles(packs: readonly RolePack[]): string[] {
  return [...new Set(packs.flatMap((p) => p.titles))].slice(0, 20);
}

/** First-seen order, no duplicates. */
function dedupeKeys(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

export function addCompany(
  set: EngineCompany[], c: NormalizedHiringCompany, ycJobs: NormalizedHiringJob[],
  prequalKey: string | null = null,
  /**
   * THE KEY THIS COMPANY ALREADY HAD, when restoring one rather than
   * discovering it.
   *
   * `companyKey` prefers `linkedin_company_url` over the domain, and identity
   * resolution WRITES that url back onto `company`. So recomputing the key for
   * a restored company would produce `li:…` where the original run recorded
   * `acme.com`, and every ledger entry keyed on the old value — completed
   * operations included — would stop matching. The recorded key is authoritative.
   */
  explicitKey?: string,
  /**
   * P4 — WHICH ROUTE SAID THIS. With it, the row joins the candidate union:
   * a company already in the pool under ANY shared identifier (external id,
   * LinkedIn URL, verified domain, website, guarded name+country) absorbs the
   * row — its identifiers, jobs and observation — instead of entering twice.
   * Without it (restores, supplied companies) the exact-key rule is unchanged.
   */
  observed?: ObservationContext,
): EngineCompany | null {
  const key = explicitKey ?? companyKey(c);
  const exact = set.find((x) => x.key === key);
  const observation = observed ? compactObservation(observationFromCompany(c, observed, ycJobs)) : null;
  if (observation && explicitKey === undefined) {
    const resolved = resolveEntity(set.map(entityIdentifiersOf), observation.entity_hint);
    // The same engine key is the same company even when no identifier survived
    // normalization (a keyless external id); that is how the pool deduped before.
    const match = resolved.kind === "new" && exact
      ? { kind: "match" as const, entity_key: exact.key, method: "external_id" as const, conflicts: resolved.conflicts }
      : resolved;
    if (match.kind === "match") {
      const holder = set.find((x) => x.key === match.entity_key)!;
      absorbObservation(holder, c, ycJobs, prequalKey, observation, match.method);
      if (match.conflicts.length) holder.identity_conflicts = [...(holder.identity_conflicts ?? []), ...match.conflicts];
      return holder;
    }
    if (match.conflicts.length) {
      for (const k of new Set(match.conflicts.map((x) => x.existing))) {
        const other = set.find((x) => x.company.linkedin_company_url === k);
        if (other) other.identity_conflicts = [...(other.identity_conflicts ?? []), ...match.conflicts];
      }
    }
  } else if (exact) {
    return exact;
  }
  const entry: EngineCompany = {
    key, prequal_key: prequalKey, prequalified: null, shortlisted: false,
    lead_verdict: null, signal_assessments: [],
    triage: null, shortlist_exclusion: null,
    // PENDING, NOT EXCLUDED. A company enters the frontier and leaves it only
    // by being investigated or by a decision that closes it.
    investigation_state: "pending_investigation", investigation_rank: Number.MAX_SAFE_INTEGER,
    company: c, identity: null, stage_block: null, brain_gate: null,
    brain_inputs: null, enriched: null,
    // NOT_ATTEMPTED IS THE HONEST DEFAULT, exactly as with `evaluation_path`.
    // A company leaves it only when the stage actually tries.
    enrichment_outcome: "not_attempted",
    yc_open_jobs: ycJobs, hiring_jobs: [], signal_evidence: {},
    fit: null, hiring_assessment: null,
    brain: null, completed_operations: [],
    evidence_registry: null, grounded: null,
    classification: null, verdict: null,
    // NOT_REACHED IS THE HONEST DEFAULT. A company only leaves this state when
    // some branch actually decides it.
    evaluation_path: "not_reached",
    decision_source: "not_evaluated",
    mission_evaluation: null,
    founders: [], verified_founders: [], contact_identities: [],
    record: newCompanyRecord(key),
    found_by: observation ? [foundByFrom(observation, "first_seen")] : [],
    observations: observation ? [withCompanyKey(observation, key)] : [],
    identity_conflicts: [],
  };
  set.push(entry);
  return entry;
}

/** At most this many route observations are kept per company in a checkpoint. */
const MAX_OBSERVATIONS_PER_COMPANY = 6;

function withCompanyKey(o: CandidateObservation, key: string): CandidateObservation {
  return { ...o, evidence: o.evidence.map((e) => ({ ...e, company_key: key })) };
}

// ── P4: THE CANONICAL COMPANY + EVIDENCE MODEL A WORKBENCH READS ────────────

export const RESEARCH_FABRIC_VERSION = "research-fabric-v1" as const;

export interface ResearchFabricCompany {
  company_key: string;
  company_name: string | null;
  identifiers: EntityIdentifiers;
  /** A LinkedIn URL is known, so no paid Company Search is needed. */
  identity_known: boolean;
  found_by: FoundBy[];
  /** Distinct discovery routes that returned this company. */
  discovery_sources: number;
  /** Distinct actors that contributed any evidence. */
  evidence_sources: string[];
  identity_conflicts: IdentityConflict[];
  evidence: EvidenceGraphProjection;
  shortlisted: boolean;
  verdict: EngineCompany["verdict"];
}

export interface ResearchFabricProjection {
  version: typeof RESEARCH_FABRIC_VERSION;
  union: { unique_companies: number; multi_source_companies: number; observations: number; merged_sightings: number };
  companies: ResearchFabricCompany[];
  waves: ResearchWaveSummary[];
  route_controls: RouteControlRecord[];
}

/**
 * The business model, when the company's own words established it.
 *
 * The registry holds the description, the YC record and any fetched page as
 * HARD FACTS; `groundedClaims` then checks every excerpt against that text and
 * drops what it cannot find. What survives is the company's own statement,
 * quoted and verified — admitted at `model_extraction`, which `compareEvidence`
 * ranks below any provider field that disagrees.
 *
 * ── THE BUSINESS MODEL'S OWN DECISION DECIDES (P5.2) ────────────────────────
 *
 * `businessModelDecision` judges the business-model CLAIM on its own evidence;
 * the grounder's whole-company verdict (`final_grounded_decision`) is recorded
 * beside it and never used as proof. Canary c584fd77 showed why: a request
 * with unprovable targets makes that verdict `review` for nearly everyone.
 *
 *   accepted  the reading is PROVEN and may pass — or, through the controlled
 *             vocabulary, fail — a hard rule (verified "consumer" rules out B2B)
 *   review    the reading is PLAUSIBLE — shown, ranked, never proof, so the
 *             hard rule stays pending
 *
 * Both decisions travel on the item (`assessment`) into eligibility.
 *
 * Null when no business-model claim survived, or when the grounder itself said
 * the model is unknown — the honest answer for a company whose description does
 * not say what it sells.
 */
export function groundedBusinessModelItem(
  c: EngineCompany, missionId: string | null, at: string,
): EvidenceItem | null {
  const g = c.grounded;
  const bm = g?.classifier_result?.business_model;
  const claims = (g?.validated_claims ?? []).filter((x) => x.claim_type === "business_model");
  if (!g || !bm || bm.value === "unknown" || claims.length === 0) return null;
  const decision = g.final_grounded_decision;
  const bmDecision = businessModelDecision(g);
  const accepted = bmDecision.decision === "accepted";
  const excerpt = claims.flatMap((x) => x.evidence_excerpts).map((x) => x.excerpt).find(Boolean) ?? null;
  // The page the quote was read from, when the cited evidence has one — so a
  // hard check can link to its source instead of saying "grounded evaluation".
  const cited = new Set(claims.flatMap((x) => x.evidence_ids));
  const url = (c.evidence_registry?.items ?? []).find((it) => cited.has(it.evidence_id) && !!it.source_url)?.source_url ?? null;
  // The weight is the authority layer's: an ACCEPTED website statement proves
  // (or, by contradiction, disproves) a business-model rule; a `review` does not.
  const authority = authorityForEvidence({
    claim: "business_model", source: "grounded_evidence_evaluation", field: "grounded_statement",
    observed_at: at, quality: { grounding: accepted ? "accepted" : "review" },
  });
  return {
    evidence_id: `grd_${c.key}_business_model`, company_key: c.key, dimension: "business_model",
    // The audience the verified quotes state rides on the value, when the code
    // names none (`ai_saas` sold to teams is B2B). See `valueWithStatedAudience`.
    value: valueWithStatedAudience(bm.value.replace(/_/g, " "), bmDecision.facets_stated),
    status: statusForAuthority(authority.authority),
    authority: authorityRecord(authority),
    source: {
      provider: "engine", actor: "grounded_evidence_evaluation", provider_call_id: null,
      url, excerpt: excerpt ? excerpt.slice(0, 280) : null,
    },
    method: "model_extraction", observed_at: at, valid_until: null,
    // NEVER `high`: a verified reading of a self-description is weaker than a
    // provider field, and the graph must rank it that way.
    confidence: accepted ? "medium" : "low",
    derived_from: [...new Set(claims.flatMap((x) => x.evidence_ids))],
    mission_id: missionId, origin: "web",
    assessment: {
      decision, grounding_score: Number(g.grounding_score ?? 0), validated_claims: claims.length,
      business_model_decision: bmDecision.decision, business_model_reasons: bmDecision.reasons,
      business_model_facets: bmDecision.facets_stated,
      business_model_quotes: bmDecision.quotes,
    },
  };
}

/**
 * A grounded item persisted BEFORE P5.2 carried no `assessment`, and a `review`
 * grounding was stored as `proven` at `low` confidence. Read back, it would
 * prove a hard rule this code now says it cannot — so it is read as what it
 * was: plausible.
 */
function normaliseGroundedItem(e: EvidenceItem): EvidenceItem {
  if (e.source?.actor !== "grounded_evidence_evaluation" || e.assessment) return e;
  return e.status === "proven" && e.confidence === "low" ? { ...e, status: "plausible" } : e;
}

/** Every evidence item for one company: route observations, the registry, derived verdict facts. */
export function companyEvidenceItems(c: EngineCompany, missionId: string | null = null) {
  const items = [
    ...(c.observations ?? []).flatMap((o) => o.evidence.map((e) => normaliseGroundedItem({ ...e, company_key: c.key }))),
    ...evidenceFromRegistry(c.evidence_registry, missionId),
  ];
  const at = c.observations?.[0]?.observed_at ?? new Date(0).toISOString();
  const derived = (dimension: EvidenceDimension, value: unknown, status: "proven" | "disproven" | "unknown",
    from: string[], confidence: "high" | "medium" | "low") => items.push({
    evidence_id: `drv_${c.key}_${dimension}`, company_key: c.key, dimension, value, status,
    source: { provider: "engine", actor: "deterministic_verdict", provider_call_id: null, url: from[0] ?? null, excerpt: null },
    method: "deterministic_derivation", observed_at: at, valid_until: null, confidence,
    derived_from: from, mission_id: missionId, origin: "lead_mission",
  });
  // ── P5.2: WHAT THE COMPANY SAYS ABOUT ITSELF, ONCE IT HAS BEEN CHECKED ──
  //
  // Canary d1eff17a surfaced nothing: `industry` arrived only as a LinkedIn
  // label, which is `plausible`, so the hard industry criterion could never be
  // met and all 36 candidates sat in `pending`.
  //
  // The registry already holds the company's own words as a HARD FACT (its
  // description, its YC record, a fetched page). `groundedClaims` then checks
  // every excerpt against that text and drops what it cannot find. A business
  // model that survives THAT is not a model's opinion — it is the company's own
  // statement, quoted and verified — so an ACCEPTED grounding is admitted as
  // proof, at medium confidence, ranked below any provider field that
  // disagrees. A `review` grounding is plausible only (see the builder).
  const groundedItem = groundedBusinessModelItem(c, missionId, at);
  if (groundedItem) items.push(groundedItem);
  // ── A RESOLVED IDENTITY IS EVIDENCE ────────────────────────────────────
  //
  // Identity reached the graph only through a provider OBSERVATION, so a
  // company resolved by the identity stage — a supplied LinkedIn page is a
  // `verified_match` with no lookup at all — had no identity item whenever its
  // enrichment row came back empty. `known_companies`, which is answered from
  // identity, then stayed `unknown` forever and the company sat in `pending`
  // with every claim it needed already proven (canary 9dd9c230: funding_stage
  // PASS, known_companies unknown). Only added when no observation spoke for
  // identity, so a provider's own identity row always takes precedence.
  if (c.identity && identityIsActionable(c.identity) && !items.some((e) => e.dimension === "identity")) {
    items.push({
      evidence_id: `idr_${c.key}`, company_key: c.key, dimension: "identity",
      value: {
        linkedin_company_url: c.identity.linkedin_company_url,
        domain: c.company.canonical_domain ?? null,
        name: c.enriched?.company_name ?? c.company.company_name ?? null,
      },
      status: "proven",
      source: {
        provider: "engine", actor: "identity_resolution", provider_call_id: null,
        url: c.identity.linkedin_company_url, excerpt: (c.identity.evidence ?? []).join("; ") || null,
      },
      method: "deterministic_derivation", observed_at: at, valid_until: null, confidence: "high",
      derived_from: [c.identity.linkedin_company_url].filter((u): u is string => !!u),
      mission_id: missionId, origin: "lead_mission",
    });
  }
  if (c.hiring_assessment?.verdict === "hiring_verified") {
    derived("hiring", true, "proven", c.hiring_jobs.map((j) => j.job_url ?? "").filter(Boolean).slice(0, 5), "high");
  }
  const f = c.first_in_function;
  if (f) {
    derived("team_composition", { first_in_function: f.status, source: f.source, quote: f.quote ?? null },
      f.status === "supported" ? "proven" : f.status === "contradicted" ? "disproven" : "unknown",
      [f.job_url ?? ""].filter(Boolean), f.source === "job_posting" ? "high" : "medium");
  }
  return items;
}

/**
 * P5 — the candidates the Workbench view counts, from a finished run.
 *
 * One row per company, carrying its evidence graph and the three facts the
 * bucket rule needs: was it screened out before paid work, is its identity
 * resolved, and did its investigation actually happen. Built here because this
 * is where the evidence items, the prequalification verdict and the identity
 * all exist at once.
 */
export function missionCandidatesFrom(
  run: { companies: readonly EngineCompany[] },
  opts: { required?: readonly EvidenceDimension[]; missionId?: string | null; now?: Date } = {},
): MissionCandidate[] {
  return run.companies.map((c) => {
    const ids = entityIdentifiersOf(c);
    const graph = buildCompanyEvidenceGraph(c.key, companyEvidenceItems(c, opts.missionId ?? null), {
      now: opts.now, required: opts.required,
    });
    return {
      company_key: c.key,
      name: c.enriched?.company_name ?? c.company.company_name,
      domain: ids.domains[0] ?? null,
      linkedin_url: ids.linkedin_company_url ?? c.identity?.linkedin_company_url ?? null,
      found_by: [...new Set((c.found_by ?? []).map((f) => f.route_id ?? `${f.capability}:${f.actor_key}`))],
      // THE CHEAP GATE'S OWN WORDS. `prequalified.eligible === false` is the
      // free pass that ran before any paid call; a shortlist exclusion is the
      // later, still-unpaid decision. Either one means no money was spent.
      screened_out: c.prequalified && c.prequalified.eligible === false
        ? (c.prequalified.exclusion ?? "prequalification")
        : c.shortlist_exclusion,
      identity_resolved: !!(c.identity && identityIsActionable(c.identity)) || !!ids.linkedin_company_url,
      investigated: c.investigation_state === "investigated" || c.verdict !== null ||
        c.brain !== null || c.hiring_assessment !== null,
      graph,
      next_action: null,
      attempted_routes: attemptedRoutesOf(c),
      unaffordable_routes: unaffordableRoutes(c.completed_operations),
      // A confident triage `irrelevant` AND a declared media/publishing industry
      // withhold further PAID verification — never a verdict
      // (`missionTriage.paidVerificationBlockedBy`).
      paid_verification_blocked: paidVerificationBlockedBy(c.triage, (c.enriched ?? c.company).provider_industry),
    };
  });
}

/**
 * ENRICHMENT THAT ANSWERED IS A TRIED ROUTE.
 *
 * `attemptedRoutes` reads only the claim verifiers' `verify:` marks, so the
 * company-details route that answers country and size was never "tried" —
 * even after it had been asked and had answered. Canary 1 (production
 * 2026-09-30, task 9982ca62): the details record came back `empty`, the size
 * gap stayed "cheap, not yet tried", `verificationTargets` held the funding
 * verifier back waiting for it, while the continuation gate counted the same
 * company as verifiable — three barren slices to `search_exhausted`. An
 * answered enrichment (`success` or `empty`) has been tried; `provider_error`
 * and `deferred` have not, and stay retryable.
 */
function attemptedRoutesOf(c: EngineCompany): string[] {
  const routes = attemptedRoutes(c.completed_operations);
  if (enrichmentWasAnswered(asEnrichmentOutcome(c.enrichment_outcome)) &&
      !routes.includes(ENRICHMENT_ROUTE_ACTOR)) {
    routes.push(ENRICHMENT_ROUTE_ACTOR);
  }
  return routes;
}
const ENRICHMENT_ROUTE_ACTOR = "apify_linkedin_company_details";

/**
 * Every company's canonical P5 decision, keyed by company key. The qualified
 * set on Lead V2 is exactly the keys whose decision carries a label.
 */
export function canonicalDecisions(
  companies: readonly EngineCompany[],
  opts: {
    mission: LeadMissionV1;
    plan: { entry_capability: string | null | undefined };
    identity?: { task_id?: string | null } | null;
    /** The run's policy, so eligibility reads the same criteria the card showed. */
    readiness?: ReadinessPolicy;
  },
): Map<string, CandidateDecision> {
  const criteria = deriveMissionCriteria(opts.mission, opts.readiness ?? PRODUCTION_READINESS);
  const anchor = anchorForCapability(String(opts.plan.entry_capability ?? "")) ?? null;
  const out = new Map<string, CandidateDecision>();
  for (const candidate of missionCandidatesFrom({ companies }, { missionId: opts.identity?.task_id ?? null })) {
    out.set(candidate.company_key, candidateDecision({ criteria, candidate, anchor }));
  }
  return out;
}

/**
 * Companies the canonical P5 view still holds WORK for, on Lead V2.
 *
 * Undecided companies (`investigating`, `identity_unresolved`) are work. A
 * PENDING company is work only while `canStillQualify` holds for its evidence
 * gaps — the same rule `verificationTargets` buys by and
 * `summarizeGaps.with_executable_route` counts. Decided companies (a label,
 * `ineligible`, `screened_out`) are not: nothing bought for them can change
 * the outcome. Discovery's "enough candidates" reads this, so a pool of
 * companies that can never qualify does not stop the search from widening.
 */
export function canonicallyWorkableKeys(
  companies: readonly EngineCompany[], opts: Parameters<typeof canonicalDecisions>[1],
): Set<string> {
  const readiness = opts.readiness ?? PRODUCTION_READINESS;
  const criteria = deriveMissionCriteria(opts.mission, readiness);
  const out = new Set<string>();
  for (const c of missionCandidatesFrom({ companies }, { missionId: opts.identity?.task_id ?? null })) {
    const eligibility = evaluateEligibility(criteria, c.graph);
    const bucket = bucketOf(c, eligibility, null);
    if (bucket === "investigating" || bucket === "identity_unresolved") {
      out.add(c.company_key);
      continue;
    }
    if (bucket !== "pending") continue;
    // Nothing more will be bought for it (`verificationTargets` skips it), so
    // it is not work that should stop discovery from widening.
    if (c.paid_verification_blocked) continue;
    const gaps = evidenceGapsFor(
      eligibility.checks.filter((x) => x.kind === "hard"), c.graph, undefined,
      new Set(c.attempted_routes ?? []), readiness, new Set(c.unaffordable_routes ?? []));
    if (canStillQualify(gaps)) out.add(c.company_key);
  }
  return out;
}

/** The canonical qualified set, in working-set order. */
export function canonicalQualifiedKeys(
  companies: readonly EngineCompany[], opts: Parameters<typeof canonicalDecisions>[1],
): string[] {
  const d = canonicalDecisions(companies, opts);
  return companies.filter((c) => d.get(c.key)?.label).map((c) => c.key);
}

/**
 * The canonical P5 decision counts for a working set — the SAME projection
 * `buildWorkbenchMissionView` renders, derived fresh from the mission (never a
 * stored criteria array). Used by the in-slice yield gate on Lead V2.
 */
export function canonicalDecisionSummary(
  companies: readonly EngineCompany[],
  opts: {
    mission: LeadMissionV1;
    plan: { entry_capability: string | null | undefined };
    identity?: { task_id?: string | null } | null;
    readiness?: ReadinessPolicy;
  },
) {
  const criteria = deriveMissionCriteria(opts.mission, opts.readiness ?? PRODUCTION_READINESS);
  const candidates = missionCandidatesFrom({ companies }, { missionId: opts.identity?.task_id ?? null });
  return decisionSummary(decisionCounts({
    criteria, candidates, anchor: anchorForCapability(String(opts.plan.entry_capability ?? "")) ?? null,
  }));
}

export function projectResearchFabric(
  run: { companies: readonly EngineCompany[]; state: Pick<CapabilityExecutionState, "research_waves" | "route_controls"> },
  opts: { required?: readonly EvidenceDimension[]; missionId?: string | null; now?: Date; limit?: number } = {},
): ResearchFabricProjection {
  const ranked = [...run.companies].sort((a, b) =>
    Number(b.verdict === "pass") - Number(a.verdict === "pass") ||
    Number(b.shortlisted) - Number(a.shortlisted) ||
    (b.found_by?.length ?? 0) - (a.found_by?.length ?? 0));
  const companies = ranked.slice(0, opts.limit ?? 60).map((c): ResearchFabricCompany => {
    const graph = buildCompanyEvidenceGraph(c.key, companyEvidenceItems(c, opts.missionId ?? null), {
      now: opts.now, required: opts.required,
    });
    const ids = entityIdentifiersOf(c);
    const found = c.found_by ?? [];
    return {
      company_key: c.key,
      company_name: c.enriched?.company_name ?? c.company.company_name,
      identifiers: ids,
      identity_known: !!(ids.linkedin_company_url ?? c.identity?.linkedin_company_url),
      found_by: found,
      discovery_sources: new Set(found.map((x) => `${x.capability}|${x.actor_key}|${x.route_id ?? ""}`)).size,
      evidence_sources: [...new Set(graph.claims.flatMap((x) => x.sources))],
      identity_conflicts: c.identity_conflicts ?? [],
      evidence: projectEvidenceGraph(graph),
      shortlisted: c.shortlisted,
      verdict: c.verdict,
    };
  });
  const all = run.companies;
  return {
    version: RESEARCH_FABRIC_VERSION,
    union: {
      unique_companies: all.length,
      multi_source_companies: all.filter((c) =>
        new Set((c.found_by ?? []).map((x) => `${x.capability}|${x.actor_key}|${x.route_id ?? ""}`)).size > 1).length,
      observations: all.reduce((n, c) => n + (c.observations?.length ?? 0), 0),
      merged_sightings: all.reduce((n, c) => n + Math.max(0, (c.found_by?.length ?? 0) - 1), 0),
    },
    companies,
    waves: run.state.research_waves ?? [],
    route_controls: run.state.route_controls ?? [],
  };
}

/** Adds a non-discovery observation (enrichment, verification). Not a `found_by` entry. */
/**
 * The observation that carries one evidence item: `prefix + evidence_id`,
 * bounded without collisions (`boundedId`). Cutting it to 64 characters, as
 * before canary 11, dropped the tail of a long evidence id — the part that
 * tells two funding records apart.
 */
function observationIdFor(prefix: string, evidenceId: string): string {
  return boundedId(`${prefix}${evidenceId}`);
}

/**
 * The id a checkpoint written BEFORE `observationIdFor` stored for the same
 * observation (the raw id cut to 64), when that differs from today's. Matched
 * so a mission resumed across the change REPLACES its old observation rather
 * than standing a fresh one beside it — where the stale copy, listed first,
 * would win. Null for an id that was never cut.
 *
 * Exact for every item whose OWN evidence id did not change (a funding stage,
 * a hiring answer, a grounded business model — the ones re-answered under one
 * id). A funding RECORD's id did change, so its pre-change observation is not
 * matched and the new one stands beside it: harmless, as a record is a fixed
 * fact and both copies read the same rounds.
 */
function legacyObservationId(o: CandidateObservation): string | null {
  const m = /^(obs_(?:vfy|fdr|grd)_)/.exec(o.observation_id);
  if (!m || o.observation_id.length < MAX_STABLE_ID_LENGTH || !o.evidence[0]) return null;
  // The item the id was built from is the observation's first.
  const raw = `${m[1]}${o.evidence[0].evidence_id}`;
  const legacy = raw.slice(0, MAX_STABLE_ID_LENGTH);
  return legacy === o.observation_id ? null : legacy;
}

function recordObservation(c: EngineCompany, o: CandidateObservation): void {
  const obs = c.observations ?? [];
  // REPLACED, NOT SKIPPED. An observation id is stable per source, so a second
  // recording is a RE-reading of the same source — re-grounding a claim on
  // pages the first reading never saw (Phase C). `companyEvidenceItems` lists
  // observation items before the live ones and the graph keeps the first of an
  // evidence id, so leaving the old copy in place would let the stale reading
  // win over the fresh one.
  const legacy = legacyObservationId(o);
  const at = obs.findIndex((x) => x.observation_id === o.observation_id || (legacy !== null && x.observation_id === legacy));
  if (at >= 0) obs[at] = withCompanyKey(o, c.key);
  else if (obs.length < MAX_OBSERVATIONS_PER_COMPANY + 2) obs.push(withCompanyKey(o, c.key));
  c.observations = obs;
}

/**
 * P5 PHASE C — A RE-READING OF THE COMPANY'S OWN PAGES REPLACES THE OLD ONE.
 *
 * The verification route bought `/product`, `/pricing`, `/customers`; the
 * registry was rebuilt with them and the grounder read them again. This is
 * where that answer becomes the canonical claim: `c.grounded` is replaced, the
 * business-model item is recomputed under its STABLE evidence id, and the
 * observation carrying it is replaced rather than appended — so the evidence
 * graph holds exactly one business-model claim, the newest one, and a
 * checkpoint restores that instead of the reading it superseded.
 *
 * Claim-level only (the plan §11): the item's status comes from
 * `businessModelDecision`, never from the whole-company verdict.
 */
/**
 * A claim verifier's answer for one company (`claimVerifier`).
 *
 * The item is recorded as an observation under a STABLE id, so a later, better
 * answer replaces it rather than standing beside it. `answered` marks the
 * company with the verifier's route, whatever the verdict — a PENDING funding
 * stage writes no item, and without the mark the gap router would send the same
 * company to the same verifier on every slice.
 */
export function applyVerifierFinding(
  c: EngineCompany, f: VerifierFinding, verifier: Pick<ClaimVerifier, "key" | "route_actor">,
): boolean {
  let recorded = false;
  if (f.item) {
    recordObservation(c, {
      version: CANDIDATE_OBSERVATION_VERSION,
      observation_id: observationIdFor("obs_vfy_", f.item.evidence_id),
      capability: "claim_verification", actor_key: f.item.source.actor,
      provider: f.item.source.provider, route_id: null, plan_version: null,
      provider_call_id: f.item.source.provider_call_id, source_record_id: null, source_url: f.item.source.url,
      observed_at: f.item.observed_at,
      entity_hint: entityHintFromCompany(c.company),
      evidence: [f.item, ...(f.supporting ?? [])],
    });
    recorded = true;
  }
  if (f.answered) {
    for (const actor of [verifier.route_actor, ...(f.attempted_actors ?? [])]) {
      const op = verifyOpKey(actor);
      if (!c.completed_operations.includes(op)) c.completed_operations.push(op);
    }
  }
  return recorded;
}

/**
 * This company's evidence budget can no longer pay for a verifier's route
 * (`claimVerificationPhase`). Marked on the company like an answered route, so
 * the gap router, `canonicallyWorkableKeys` and continuation all stop counting
 * the route as one a slice could take.
 */
export function markRouteUnaffordable(c: EngineCompany, verifier: Pick<ClaimVerifier, "route_actor">): void {
  const op = unaffordableOpKey(verifier.route_actor);
  if (!c.completed_operations.includes(op)) c.completed_operations.push(op);
}

/**
 * A funding-discovery round, recorded where the funding-stage claim reads it.
 *
 * Always: the round as a `funding` item carrying its FundingRecordFact. Only
 * when the round already CONTRADICTS the asked stage (a dated later round):
 * the `company_stage` item that says so, under the same stable id and
 * observation the funding-stage verifier writes — so a later verifier answer
 * replaces it rather than standing beside it. A round AT the asked stage writes
 * no stage item: one event is not a history, so the claim stays PENDING.
 */
export function recordDiscoveredFunding(
  c: EngineCompany, round: NormalizedFundingRound, ctx: ObservationContext, requiredStage: string | null,
): { record: FundingRecordFact; stage: FundingStageDecision | null } {
  const record = fundingRecordFromDiscoveredRound(round, {
    actor: ctx.actor_key, provider_call_id: ctx.provider_call_id, observed_at: ctx.observed_at,
  });
  const item = fundingRecordEvidenceItem({ company_key: c.key, record, mission_id: ctx.mission_id, observed_at: ctx.observed_at });
  recordObservation(c, {
    version: CANDIDATE_OBSERVATION_VERSION,
    observation_id: observationIdFor("obs_fdr_", item.evidence_id),
    capability: ctx.capability, actor_key: ctx.actor_key, provider: ctx.provider,
    route_id: ctx.route_id, plan_version: ctx.plan_version, provider_call_id: ctx.provider_call_id,
    source_record_id: null, source_url: record.source_url, observed_at: ctx.observed_at,
    entity_hint: entityHintFromCompany(c.company), evidence: [item],
  });
  if (!requiredStage) return { record, stage: null };
  const stage = decideFundingStage({ required_stage: requiredStage, record, pass_requires_source_url: true });
  const stageItem = fundingStageEvidenceItem({
    company_key: c.key, decision: stage, record, mission_id: ctx.mission_id,
    provider_call_id: ctx.provider_call_id, observed_at: ctx.observed_at, derived_from: [item.evidence_id],
  });
  // `answered: false` — discovery is not the verifier. A company it could not
  // settle still gets the verifier's completeness check.
  if (stageItem) applyVerifierFinding(c, { company_key: c.key, item: stageItem, answered: false, detail: {} }, { key: "funding_discovery", route_actor: ctx.actor_key });
  return { record, stage };
}

export function applyRegroundedVerification(
  c: EngineCompany, verification: GroundedVerification, missionId: string | null, at: string,
): { item: EvidenceItem | null; decision: string | null } {
  c.grounded = verification;
  const item = groundedBusinessModelItem(c, missionId, at);
  if (!item) return { item: null, decision: null };
  recordObservation(c, {
    version: CANDIDATE_OBSERVATION_VERSION,
    observation_id: observationIdFor("obs_grd_", item.evidence_id),
    capability: "web_evidence_verification", actor_key: "grounded_evidence_evaluation",
    provider: "engine", route_id: null, plan_version: null,
    provider_call_id: null, source_record_id: null, source_url: item.source.url,
    observed_at: item.observed_at,
    entity_hint: entityHintFromCompany(c.company),
    evidence: [item],
  });
  const a = item.assessment as { business_model_decision?: string } | undefined;
  return { item, decision: a?.business_model_decision ?? null };
}

/** Every identifier the pool knows for this company, from the row and every observation. */
export function entityIdentifiersOf(c: EngineCompany): EntityIdentifiers {
  let ids = identifiersFromHint(c.key, entityHintFromCompany(c.company));
  for (const o of c.observations ?? []) ids = absorbIdentifiers(ids, o.entity_hint);
  return ids;
}

/**
 * One more route's row for a company already in the pool. Fills identifiers the
 * pool lacked (never overwrites one it has), adds jobs it had not seen, and
 * keeps the observation beside the others. The company keeps its key.
 */
function absorbObservation(
  holder: EngineCompany, c: NormalizedHiringCompany, jobs: readonly NormalizedHiringJob[],
  prequalKey: string | null, o: CandidateObservation, method: FoundBy["method"],
): void {
  const h = holder.company;
  if (!h.linkedin_company_url && c.linkedin_company_url) h.linkedin_company_url = c.linkedin_company_url;
  if (!h.canonical_domain && c.canonical_domain) h.canonical_domain = c.canonical_domain;
  if (!h.website && c.website) h.website = c.website;
  if (!holder.prequal_key && prequalKey) holder.prequal_key = prequalKey;
  for (const j of jobs) {
    const id = j.job_id ?? j.job_url;
    if (!holder.yc_open_jobs.some((x) => (x.job_id ?? x.job_url) === id)) holder.yc_open_jobs.push(j);
  }
  holder.found_by = appendFoundBy(holder.found_by ?? [], foundByFrom(o, method));
  const obs = holder.observations ?? [];
  if (!obs.some((x) => x.observation_id === o.observation_id) && obs.length < MAX_OBSERVATIONS_PER_COMPANY) {
    obs.push(withCompanyKey(o, holder.key));
  }
  holder.observations = obs;
}

// --------------------------------------------------- evaluation telemetry ----

/**
 * How many articles one company's signal search may buy.
 *
 * Small on purpose. The question is "did they say this, and when", which one
 * dated story answers; paging deeper buys restatements of the same story.
 */
const NEWS_ARTICLES_PER_COMPANY = 5;

/**
 * Signal-verification capabilities this engine drives, through ONE shared stage.
 *
 * Exported for the same reason `ENGINE_DRIVEN_DISCOVERY` is: they share a
 * branch, so a test that derives "implemented" from single-condition `if (cap
 * === "…")` cannot see them, and the honest answer is for the engine to name
 * the set rather than for the test to hardcode one.
 */
export const ENGINE_DRIVEN_SIGNAL_VERIFICATION: ReadonlySet<CapabilityId> =
  new Set<CapabilityId>([
    "expansion_signal_verification",
    "product_launch_verification",
  ]);

/**
 * The words that make a search about THIS SIGNAL rather than the company.
 *
 * Deliberately narrow and deliberately not a model call: a compiled query is
 * inspectable, and the stage does not read the article anyway — the evaluator
 * judges the cited item.
 */
const SIGNAL_NEWS_TERMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  expansion: ["expands", "new office", "enters market", "expansion"],
  product_launch: ["launches", "announces", "unveils", "new product"],
});

export const EVALUATION_PATH_VERSION = "evaluation-path-telemetry-v1" as const;

export interface EvaluationPathSummary {
  version: typeof EVALUATION_PATH_VERSION;
  /** Companies the Brain's eligible filter actually admitted. */
  reached_evaluation: number;
  /** Verdicts produced WITHOUT consulting a model. */
  decided_without_model: number;
  /** Verdicts produced WITH a parsed model response. */
  decided_by_model: number;
  counts: Record<EvaluationPath, number>;
  /** Per company, so a single row can be explained. */
  companies: Array<{
    company_key: string;
    company_name: string | null;
    evaluation_path: EvaluationPath;
    verdict: "pass" | "reject" | "unknown" | null;
    brain_outcome: BrainDecision["outcome"] | null;
    /** True when the grounded classifier produced a verification for this company. */
    grounded: boolean;
    /** Whether the model decided, a fact decided, or nobody looked. */
    decision_source: DecisionSource;
    /** The evaluator's own terminal answer, when it ran. */
    decision: MissionEvaluation["decision"] | null;
    mission_fit: MissionEvaluation["mission_fit"] | null;
    icp_fit: MissionEvaluation["icp_fit"] | null;
    match_score: number | null;
  }>;
}

/**
 * WHO ACTUALLY DECIDED, per company and in aggregate.
 *
 * This is the measurement the previous audit had to reconstruct by hand from
 * three disagreeing fields. `decided_by_model` is the number the architecture
 * correction is judged on: today it is expected to be ZERO, and a run where it
 * stays zero after the inversion means the inversion did not land.
 *
 * PURE. Reads finished state, changes nothing.
 */
export function summariseEvaluationPaths(
  companies: readonly EngineCompany[],
): EvaluationPathSummary {
  const counts: Record<EvaluationPath, number> = {
    not_reached: 0, fabricated_pass: 0, fabricated_reject: 0,
    model_evaluated: 0, model_unavailable: 0, restored_decision: 0,
  };
  for (const c of companies) counts[c.evaluation_path]++;
  return {
    version: EVALUATION_PATH_VERSION,
    reached_evaluation: companies.length - counts.not_reached,
    decided_without_model: counts.fabricated_pass + counts.fabricated_reject +
      counts.model_unavailable,
    decided_by_model: counts.model_evaluated,
    counts,
    companies: companies.map((c) => ({
      company_key: c.key,
      company_name: c.company.company_name ?? null,
      evaluation_path: c.evaluation_path,
      verdict: c.verdict,
      brain_outcome: c.brain?.outcome ?? null,
      grounded: c.grounded !== null,
      decision_source: c.decision_source,
      decision: c.mission_evaluation?.decision ?? null,
      mission_fit: c.mission_evaluation?.mission_fit ?? null,
      icp_fit: c.mission_evaluation?.icp_fit ?? null,
      match_score: c.mission_evaluation?.match_score ?? null,
    })),
  };
}

/**
 * ONE ORDERED WALK OF THE PIPELINE, built from the companies themselves.
 *
 * The adapter between engine state and `buildMissionFunnel`. Every field is
 * READ, never recomputed — the funnel exists to join views that already agree,
 * and deriving anything here would let it drift from the Workbench and the
 * checkpoint the way two independent counters always eventually do.
 */
export function toFunnelCompanies(
  companies: readonly EngineCompany[],
  opts: { persistedKeys?: readonly string[] } = {},
): FunnelCompany[] {
  const persisted = new Set(opts.persistedKeys ?? []);
  return companies.map((c) => ({
    key: c.key,
    prequalified: c.prequalified !== null,
    triage: c.triage?.relevance ?? null,
    shortlisted: c.shortlisted,
    shortlist_exclusion: c.shortlist_exclusion,
    awaiting_investigation: isFrontier(c.investigation_state),
    // BLOCKED IS CHECKED FIRST. A company the deadline stopped has no identity
    // outcome to report, and calling that "unresolved" would turn a clock
    // decision into a permanent fact about the company.
    identity: c.stage_block?.capability === "company_identity_resolution"
      ? "blocked"
      : c.identity === null ? "not_attempted"
      : identityIsActionable(c.identity) ? "resolved"
      : c.identity.status === "mismatch" ? "mismatch" : "unresolved",
    enrichment: c.enrichment_outcome,
    reached_brain: c.brain !== null,
    // THE CLOCK, NOT A JUDGEMENT. Set when the qualification loop ran out of
    // budget before reaching this company; the funnel reports it as `withheld`
    // rather than counting it as a company that vanished.
    brain_blocked: c.brain === null &&
      c.stage_block?.reason === "qualification_deferred",
    // Read from the gate's own marker, never recomputed here.
    brain_refuted: c.brain === null && c.brain_gate === "refuted",
    brain_unproven: c.brain === null && c.brain_gate === "not_established",
    brain: c.brain?.outcome ?? null,
    evaluated: c.decision_source === "gpt_evaluation",
    decision_source: c.decision_source,
    verdict: c.verdict,
    persisted: persisted.has(c.key),
  }));
}

/** The funnel for a finished (or partial) run. */
export function missionFunnelFor(
  companies: readonly EngineCompany[],
  opts: { persistedKeys?: readonly string[] } = {},
): MissionFunnel {
  return buildMissionFunnel(toFunnelCompanies(companies, opts));
}

// ------------------------------------------------------- persistence bridge ----

/**
 * Adapt an engine run onto the shape the EXISTING persistence projection reads.
 *
 * Deliberately an adapter and not a second projection: `persistPlan` owns
 * accounts, contacts, lead_candidates and the contact-enrichment handoff, and
 * duplicating any of that to suit a new executor is how two write paths start
 * disagreeing about what a lead is. The engine supplies plans; persistence
 * stays exactly where it was.
 */
export function toRouteResultShape(run: CapabilityRunResult): {
  executed_source_order: string[];
  companies: Array<{
    record: CompanyRecordState;
    company: NormalizedHiringCompany;
    identity: IdentityResolution;
    enriched: NormalizedHiringCompany | null;
    hiring_jobs: NormalizedHiringJob[];
    founders: NormalizedHiringPerson[];
  }>;
  funnel: FunnelCounts;
} {
  const executed = [...new Set(
    run.state.provider_attempts
      .filter((a) => a.outcome === "ok" || a.outcome === "empty")
      .map((a) => a.provider),
  )];
  return {
    executed_source_order: executed,
    companies: run.companies.map((c) => ({
      record: c.record,
      company: c.company,
      // The projection reads identity unconditionally, so an unresolved company
      // carries an explicit unresolved identity rather than a null it would
      // dereference.
      identity: c.identity ?? {
        company_key: c.key, status: "unresolved",
        linkedin_company_url: c.company.linkedin_company_url ?? null,
        evidence: ["identity_resolution_did_not_run"], ambiguous_candidates: [],
      },
      enriched: c.enriched,
      hiring_jobs: c.hiring_jobs,
      // Only VERIFIED people are offered for persistence. An unverified founder
      // is a candidate, not a lead.
      founders: c.verified_founders,
    })),
    funnel: run.funnel,
  };
}

// --------------------------------------------------------------- preflight ----

/**
 * Compile the FIRST paid call without invoking it.
 *
 * The preflight has to validate the exact input that will be sent, and the only
 * honest way to do that is to compile it with the same compiler the engine uses.
 * On TEST task e8abeb8f-…-cfcbc6a416d4 the memo23 call was rejected by Apify with
 * `apify_input_schema_error` and the run treated that as "no candidates" — an
 * invalid input and an empty result are not the same thing, and only one of them
 * means the source was actually asked.
 */
export function compileFirstProviderCall(
  plan: CapabilityPlan, opts: Partial<CapabilityEngineOpts> = {},
): { provider: string | null; compiled: CompileResult<unknown> | null } {
  const step = plan.steps[0];
  if (!step) return { provider: null, compiled: null };
  const provider = step.providers[0] ?? null;
  if (!provider) return { provider: null, compiled: null };
  const maxCandidates = opts.maxCandidates ?? 50;

  if (provider === "apify_yc_companies_memo23") {
    return {
      provider,
      compiled: compileMemo23YcInput({
        mode: "companies",
        queries: [],
        topCompany: false,
        nonprofit: false,
        batch: ["All Batches"],
        regions: opts.ycRegions ?? ["United States of America"],
        industries: opts.ycIndustries ?? ["B2B"],
        isHiring: true,
        // THE CLOSEST BROAD FILTER, NOT THE TARGET RANGE. The mission wants
        // 10-150; the Actor's size options are fixed enums and 150 is not one of
        // them, so discovery casts to 10+ .. 500 and the exact 10-150 bound is
        // enforced later from ENRICHED headcount. Narrowing here to "100" would
        // silently drop every 100-150 company.
        minEmployeeSize: opts.ycMinSize ?? MEMO23_DEFAULT_MIN_SIZE,
        maxEmployeeSize: opts.ycMaxSize ?? MEMO23_DEFAULT_MAX_SIZE,
        scrapeOpenJobs: true,
        scrapeFounderDetails: false,
        enrichEmails: false,
        maxItems: maxCandidates,
      }) as CompileResult<unknown>,
    };
  }
  // Other entry providers are not engine-driven yet; the preflight records the
  // provider and leaves validation to the capability that owns it.
  return { provider, compiled: null };
}

// ── memo23 SIZE CEILING ─────────────────────────────────────────────────────

/** Numeric value of a memo23 size enum; "1000+" is no ceiling at all. */
function memo23SizeValue(v: string): number {
  return v === "1000+" ? Number.POSITIVE_INFINITY : Number.parseInt(v, 10);
}

/**
 * The smallest memo23 `maxEmployeeSize` at or above `max`, or null when there
 * is no bound. Rounding UP is what keeps every in-bound company in the result.
 */
export function memo23MaxSizeCeiling(max: number | null | undefined): string | null {
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return null;
  const ladder = YC_MEMO23_MAX_SIZES.filter((v) => v !== "1+");
  return ladder.find((v) => memo23SizeValue(v) >= max) ?? null;
}

/**
 * The strategy's `maxEmployeeSize`, never above the ceiling. An absent choice
 * means "no ceiling" to memo23, so it is replaced by the ceiling too.
 */
export function clampMemo23MaxSize(chosen: unknown, ceiling: string | null): string | null {
  const pick = typeof chosen === "string" && (YC_MEMO23_MAX_SIZES as readonly string[]).includes(chosen)
    ? chosen : null;
  if (!ceiling) return pick;
  if (!pick || memo23SizeValue(pick) > memo23SizeValue(ceiling)) return ceiling;
  return pick;
}
