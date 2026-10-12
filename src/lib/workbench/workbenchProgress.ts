import { canonicalSummary, readMissionView } from './missionView.ts';
// THE RUN, WHILE IT IS STILL RUNNING.
//
// The Workbench used to be binary: empty until the run finished, then fully
// populated. A five-minute sourcing run therefore looked identical to a hung one
// — which is how TEST task c8a6e53d went unnoticed while the plan sat in Running
// forever.
//
// run-agent's capability engine now publishes a snapshot after each stage into
// `tasks.result.workbench_progress`. This module turns one of those snapshots
// into display lines.
//
// THE RULE THAT MAKES IT SAFE. Nothing here can report a company as QUALIFIED.
// The engine sets `qualified_companies` only from an explicit Company Brain
// verdict, and this module only ever reads it — it never derives a qualification
// from "we found some accounts". A mid-run row that looks qualified is the exact
// fail-open the persistence-authority work was for.
//
// PURE. No React, no network, no database.

/** The snapshot shape run-agent persists. Mirrors `EngineProgress`. */
export interface WorkbenchProgress {
  stage: string;
  accounts_found: number;
  evaluated: number;
  eligible_opportunities: number;
  exclusion_reasons: Record<string, number>;
  identity_resolved: number;
  identity_unresolved: number;
  companies_enriched: number;
  hiring_verified: number;
  qualified_companies: number;
  decision_makers_verified: number;
  open_jobs_evaluated: number;
  shortlisted: number;
  in_progress: boolean;
  /** A billed Actor run is still in flight — resumable, not running here. */
  awaiting_external_run: boolean;
  /**
   * LEAD V2: the counts the canonical mission view owns, present exactly when
   * the run wrote one. Its presence is what makes the view AUTHORITATIVE for the
   * run summary — see `summaryCanonicalInput`.
   */
  canonical?: { qualified_companies: number; reviewed: number; pending: number; unverifiable?: number };
}

export interface ProgressLine {
  label: string;
  value: number;
  /** Shown only once the stage that produces it has actually run. */
  reached: boolean;
}

const EXCLUSION_LABEL: Record<string, string> = {
  employee_size: 'outside the employee-size range',
  technical_only: 'hiring engineers only',
  insufficient_commercial: 'no commercial hiring signal',
  duplicate: 'duplicate',
  artifact: 'not a company',
};

/** Read a persisted `tasks.result` and return the snapshot, if any. */
/**
 * LEAD V2: the counts the canonical view owns replace the legacy counters —
 * one number per question, from the backend's one projection. Execution state
 * (stage, in-progress, stage-by-stage counters) still comes from progress.
 */
export function readWorkbenchProgress(result: unknown): WorkbenchProgress | null {
  const legacy = readLegacyWorkbenchProgress(result);
  const view = readMissionView(result);
  if (!view) return legacy;
  const c = canonicalSummary(view.counts);
  const base: WorkbenchProgress = legacy ?? {
    stage: 'accounts_found', accounts_found: 0, evaluated: 0, eligible_opportunities: 0,
    exclusion_reasons: {}, identity_resolved: 0, identity_unresolved: 0, companies_enriched: 0,
    hiring_verified: 0, qualified_companies: 0, decision_makers_verified: 0, open_jobs_evaluated: 0,
    shortlisted: 0, in_progress: view.stage === 'retrieving', awaiting_external_run: false,
  };
  return {
    ...base,
    accounts_found: c.discovered,
    evaluated: c.qualified + c.pending + c.ineligible,
    qualified_companies: c.qualified,
    identity_unresolved: view.counts.identity_unresolved,
    canonical: {
      qualified_companies: c.qualified, reviewed: c.qualified + c.pending + c.ineligible, pending: c.pending,
      unverifiable: view.pending_unverifiable,
    },
  };
}

function readLegacyWorkbenchProgress(result: unknown): WorkbenchProgress | null {
  if (!result || typeof result !== 'object') return null;
  const p = (result as { workbench_progress?: unknown }).workbench_progress;
  if (!p || typeof p !== 'object') return null;
  const q = p as Partial<WorkbenchProgress>;
  if (typeof q.accounts_found !== 'number') return null;
  return {
    stage: String(q.stage ?? 'accounts_found'),
    accounts_found: q.accounts_found,
    evaluated: q.evaluated ?? 0,
    eligible_opportunities: q.eligible_opportunities ?? 0,
    exclusion_reasons: (q.exclusion_reasons ?? {}) as Record<string, number>,
    identity_resolved: q.identity_resolved ?? 0,
    identity_unresolved: q.identity_unresolved ?? 0,
    companies_enriched: q.companies_enriched ?? 0,
    hiring_verified: q.hiring_verified ?? 0,
    qualified_companies: q.qualified_companies ?? 0,
    decision_makers_verified: q.decision_makers_verified ?? 0,
    open_jobs_evaluated: q.open_jobs_evaluated ?? 0,
    shortlisted: q.shortlisted ?? 0,
    in_progress: q.in_progress === true,
    awaiting_external_run: q.awaiting_external_run === true,
  };
}

/**
 * What the strip should say about the run's state.
 *
 * Three states, not two. A workflow that stopped holding a billed Actor run is
 * neither running nor finished — calling it either would be a lie the user acts
 * on.
 */
export type RunActivity = 'running' | 'awaiting_provider' | 'finished';

export function runActivity(progress: WorkbenchProgress): RunActivity {
  if (progress.awaiting_external_run) return 'awaiting_provider';
  return progress.in_progress ? 'running' : 'finished';
}

/** Stages in the order the engine reaches them. */
const STAGE_ORDER = [
  'accounts_found', 'prequalified', 'identity_resolved',
  'companies_enriched', 'hiring_verified', 'qualified', 'decision_makers_verified',
];

function reachedBy(progress: WorkbenchProgress, stage: string): boolean {
  const at = STAGE_ORDER.indexOf(progress.stage);
  const need = STAGE_ORDER.indexOf(stage);
  return at >= 0 && need >= 0 && at >= need;
}

/**
 * The counters to display for this snapshot.
 *
 * `reached` is what keeps this honest: a zero that has not been measured yet is
 * NOT the same claim as a measured zero, and rendering both as "0" would tell
 * the user the run found nothing while it was still looking.
 */
export function progressLines(progress: WorkbenchProgress): ProgressLine[] {
  return [
    { label: 'Accounts found', value: progress.accounts_found, reached: true },
    { label: 'Evaluated', value: progress.evaluated, reached: reachedBy(progress, 'prequalified') },
    {
      label: 'Open roles read', value: progress.open_jobs_evaluated,
      reached: reachedBy(progress, 'prequalified'),
    },
    {
      label: 'Eligible opportunities', value: progress.eligible_opportunities,
      reached: reachedBy(progress, 'prequalified'),
    },
    {
      label: 'Verified companies', value: progress.companies_enriched,
      reached: reachedBy(progress, 'companies_enriched'),
    },
    {
      label: 'Qualified companies', value: progress.qualified_companies,
      reached: reachedBy(progress, 'qualified'),
    },
    {
      label: 'Decision-makers verified', value: progress.decision_makers_verified,
      reached: reachedBy(progress, 'decision_makers_verified'),
    },
  ];
}

/** "5 outside the employee-size range, 5 hiring engineers only" */
export function exclusionSummary(progress: WorkbenchProgress): string[] {
  return Object.entries(progress.exclusion_reasons)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${EXCLUSION_LABEL[kind] ?? kind}`);
}

/**
 * May the rows on screen be acted on yet?
 *
 * FALSE while the run is still going. Intermediate rows exist to show progress;
 * offering "Find decision-makers" against a company the Brain has not judged is
 * how paid people-search ran on unqualified companies before.
 */
export function progressRowsAreActionable(progress: WorkbenchProgress | null): boolean {
  if (!progress) return true;
  return runActivity(progress) === 'finished';
}
