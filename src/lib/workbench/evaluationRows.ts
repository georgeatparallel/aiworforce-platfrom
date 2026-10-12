import {
  readMissionView, LABEL_BUCKETS, describeHardCheck,
  type CanonicalBucket, type CanonicalEvidenceGap, type CanonicalHardCheck, type CanonicalMissionView,
} from './missionView.ts';
import { readCompanySizeFacts } from './companySize.ts';

// EVALUATED COMPANIES — visible, explained, and never actionable.
//
// TEST task 42e39fb1 shortlisted six companies with real commercial hiring
// signals inside the size range, resolved none of their LinkedIn identities, and
// showed the user an empty Workbench. The work was done and invisible.
//
// These rows fix the visibility WITHOUT reopening the fail-open hole. They come
// from `tasks.result.workbench_evaluation_rows`, they carry NO
// `lead_candidate_id`, and every action in the product requires one — so they
// cannot be selected, enriched, drafted against, or fed to a paid people search.
// The impossibility is structural, not a rule someone has to remember.
//
// ── AND NOT EVERY ROW HERE IS A REJECTION ────────────────────────────────────
//
// This table was captioned "evaluated but NOT QUALIFIED" for every row it
// received, including companies the run never spent a cent on. The backend
// projection now distinguishes a judged rejection from a company that was
// deferred by the clock, held for missing evidence, or never investigated at
// all — and `decided` carries that distinction onto each row so this side never
// has to guess it.
//
// READ DEFENSIVELY. A task written by an older build has none of the new fields.
// Such a row degrades to `decided: false` — the safe direction, because the
// failure mode being fixed is calling something a rejection when it is not.
//
// PURE. No React, no network, no database.

export type WorkbenchLifecycle =
  | 'discovered' | 'evaluated' | 'not_investigated' | 'shortlisted'
  | 'identity_unresolved' | 'verifying' | 'deferred' | 'held_for_evidence'
  | 'qualified' | 'not_qualified' | 'contact_ready';

export type TriageRelevance = 'relevant' | 'uncertain' | 'irrelevant';

export type EnrichmentState =
  | 'not_attempted' | 'success' | 'empty' | 'provider_error' | 'deferred';

export interface EvaluationRow {
  company_key: string;
  company_name: string;
  domain: string | null;
  /** The DECLARED LinkedIn size band label ("11-50"), when one was read. */
  company_size_band: string | null;
  /** LinkedIn associated members — NOT a staff count (companySize.ts). */
  linkedin_associated_members: number | null;
  /** A YC directory's self-reported team size. */
  self_reported_team_size: number | null;
  /** A pre-2026-09-24 row's single `employee_count`: reported, unverified. */
  legacy_reported_count: number | null;
  strongest_signal: string | null;
  signal_tier: 'A' | 'B' | 'C' | null;
  supporting_job_title: string | null;
  supporting_job_url: string | null;
  prequalification_score: number;
  status: WorkbenchLifecycle;
  explanation: string;
  reasons: string[];
  exclusion: string | null;
  /** Did anyone actually judge this company? False ⇒ never call it rejected. */
  decided: boolean;
  decision_source: string;
  /** True when resuming the run would continue this company. */
  resumable: boolean;
  triage_relevance: TriageRelevance | null;
  triage_signal_strength: number | null;
  triage_reasons: string[];
  shortlist_exclusion: string | null;
  shortlist_exclusion_explanation: string | null;
  enrichment_state: EnrichmentState;
  enrichment_explanation: string;
  mission_decision: string | null;
  mission_match_score: number | null;
  mission_reasoning: string | null;
  mission_failed_requirements: string[];
  /**
   * Lead V2: the backend's canonical decision for this company. When present
   * it — not anything the UI derives — decides the tab, and its hard checks are
   * what the row shows. Absent on legacy runs.
   */
  canonical?: {
    bucket: CanonicalBucket;
    hard_check_details: CanonicalHardCheck[];
    missing_evidence: string[];
    /** What could close each unknown hard check, or why nothing can yet. */
    evidence_gaps?: CanonicalEvidenceGap[];
    caveats: string[];
    /** Pending only: whether anything can still prove it (`CanonicalLead.pending_state`). */
    pending_state?: 'verifying' | 'unverifiable' | null;
  };
}

/** Statuses that mean a company genuinely progressed, for ordering/filtering. */
const ADVANCED: ReadonlySet<WorkbenchLifecycle> = new Set([
  'shortlisted', 'identity_unresolved', 'verifying', 'deferred', 'held_for_evidence',
]);

/** The only statuses that assert anything about the company. */
const DECIDED: ReadonlySet<WorkbenchLifecycle> = new Set([
  'qualified', 'not_qualified', 'contact_ready',
]);

const LIFECYCLES: ReadonlySet<string> = new Set<string>([
  'discovered', 'evaluated', 'not_investigated', 'shortlisted',
  'identity_unresolved', 'verifying', 'deferred', 'held_for_evidence',
  'qualified', 'not_qualified', 'contact_ready',
]);

const ENRICHMENT_STATES: ReadonlySet<string> = new Set<string>([
  'not_attempted', 'success', 'empty', 'provider_error', 'deferred',
]);

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** How each canonical bucket reads as a lifecycle row. Surfaced leads are lead rows, never evaluation rows. */
const CANONICAL_STATUS: Readonly<Record<Exclude<CanonicalBucket, 'exact_match' | 'strong_opportunity' | 'worth_considering' | 'low_priority'>, WorkbenchLifecycle>> = {
  ineligible: 'not_qualified',
  pending: 'held_for_evidence',
  screened_out: 'not_investigated',
  investigating: 'deferred',
  identity_unresolved: 'identity_unresolved',
};

/**
 * The canonical decision as evaluation rows: every company the run did NOT
 * surface, each with the backend's own bucket and hard checks. Only
 * `ineligible` is a decision against a company — a hard criterion verified
 * false; `pending` is a question, never a rejection.
 */
export function canonicalEvaluationRows(view: CanonicalMissionView): EvaluationRow[] {
  return view.leads
    .filter((l) => !LABEL_BUCKETS.has(l.bucket))
    .map((l) => {
      const bucket = l.bucket as keyof typeof CANONICAL_STATUS;
      const failing = l.hard_check_details.filter((h) => h.result === 'fail');
      const explanation = bucket === 'ineligible'
        ? `Ruled out: ${failing.map((h) => h.reason).join('; ') || 'a hard requirement is verified false'}`
        : bucket === 'pending' && l.pending_state === 'unverifiable'
        ? `Could not be verified: ${l.missing_evidence.slice(0, 2).join('; ') || 'a hard requirement is not established'} — nothing further could prove it in this run.`
        : bucket === 'pending'
        ? `Needs verification: ${l.missing_evidence.slice(0, 2).join('; ') || 'a hard requirement is not yet established'}`
        : bucket === 'screened_out'
        ? 'Screened out by the free first pass, before any paid research.'
        : bucket === 'investigating'
        ? 'Not reached yet — a continuation would investigate it.'
        : 'Identity not resolved — which company this is could not be established.';
      return {
        company_key: l.company.key,
        company_name: l.company.name ?? l.company.key,
        domain: l.company.domain,
        company_size_band: null,
        linkedin_associated_members: null,
        self_reported_team_size: null,
        legacy_reported_count: null,
        strongest_signal: null,
        signal_tier: null,
        supporting_job_title: null,
        supporting_job_url: null,
        prequalification_score: 0,
        status: CANONICAL_STATUS[bucket],
        explanation,
        reasons: l.hard_check_details.map(describeHardCheck),
        exclusion: null,
        decided: bucket === 'ineligible',
        decision_source: 'p5_canonical_eligibility',
        resumable: bucket === 'investigating',
        triage_relevance: null,
        triage_signal_strength: null,
        triage_reasons: [],
        shortlist_exclusion: null,
        shortlist_exclusion_explanation: null,
        enrichment_state: 'not_attempted',
        enrichment_explanation: '',
        mission_decision: l.bucket,
        mission_match_score: null,
        mission_reasoning: explanation,
        mission_failed_requirements: failing.map((h) => h.reason),
        canonical: {
          bucket: l.bucket, hard_check_details: l.hard_check_details,
          missing_evidence: l.missing_evidence, caveats: l.caveats, evidence_gaps: l.evidence_gaps,
          pending_state: l.pending_state,
        },
      };
    });
}

export function readEvaluationRows(result: unknown): EvaluationRow[] {
  if (!result || typeof result !== 'object') return [];
  // LEAD V2: THE BACKEND'S CANONICAL DECISION, when the run wrote one.
  const view = readMissionView(result);
  if (view) return canonicalEvaluationRows(view);
  const raw = (result as { workbench_evaluation_rows?: unknown }).workbench_evaluation_rows;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => {
      // AN UNKNOWN STATUS IS NOT A DECISION. A row from a future or corrupted
      // build falls back to `discovered`, which claims nothing.
      const status = (LIFECYCLES.has(String(r.status ?? ''))
        ? String(r.status) : 'discovered') as WorkbenchLifecycle;
      return {
        company_key: String(r.company_key ?? ''),
        company_name: String(r.company_name ?? r.company_key ?? 'Unknown'),
        domain: typeof r.domain === 'string' ? r.domain : null,
        ...((f) => ({
          company_size_band: f.declared_band ? `${f.declared_band.min}${f.declared_band.max === null ? '+' : `-${f.declared_band.max}`}` : null,
          linkedin_associated_members: f.linkedin_members,
          self_reported_team_size: f.self_reported_team_size,
          legacy_reported_count: f.legacy_reported_count,
        }))(readCompanySizeFacts(r)),
        strongest_signal: typeof r.strongest_signal === 'string' ? r.strongest_signal : null,
        signal_tier: (r.signal_tier === 'A' || r.signal_tier === 'B' || r.signal_tier === 'C')
          ? r.signal_tier : null,
        supporting_job_title: typeof r.supporting_job_title === 'string' ? r.supporting_job_title : null,
        supporting_job_url: typeof r.supporting_job_url === 'string' ? r.supporting_job_url : null,
        prequalification_score: typeof r.prequalification_score === 'number' ? r.prequalification_score : 0,
        status,
        explanation: String(r.explanation ?? ''),
        reasons: strArr(r.reasons),
        exclusion: typeof r.exclusion === 'string' ? r.exclusion : null,
        // TRUSTED ONLY WHEN THE STATUS AGREES. `decided` is the field that
        // authorises the word "rejected", so it is confirmed against the
        // lifecycle rather than taken on the row's word alone — and an older
        // row that has no `decided` at all falls to the status, which for
        // anything but a real decision is false.
        decided: r.decided === true && DECIDED.has(status),
        decision_source: String(r.decision_source ?? 'not_evaluated'),
        resumable: r.resumable === true,
        triage_relevance: (r.triage_relevance === 'relevant' ||
          r.triage_relevance === 'uncertain' || r.triage_relevance === 'irrelevant')
          ? r.triage_relevance : null,
        triage_signal_strength: typeof r.triage_signal_strength === 'number'
          ? r.triage_signal_strength : null,
        triage_reasons: strArr(r.triage_reasons),
        shortlist_exclusion: typeof r.shortlist_exclusion === 'string' ? r.shortlist_exclusion : null,
        shortlist_exclusion_explanation: typeof r.shortlist_exclusion_explanation === 'string'
          ? r.shortlist_exclusion_explanation : null,
        enrichment_state: (ENRICHMENT_STATES.has(String(r.enrichment_state ?? ''))
          ? String(r.enrichment_state) : 'not_attempted') as EnrichmentState,
        enrichment_explanation: String(r.enrichment_explanation ?? ''),
        mission_decision: typeof r.mission_decision === 'string' ? r.mission_decision : null,
        mission_match_score: typeof r.mission_match_score === 'number' ? r.mission_match_score : null,
        mission_reasoning: typeof r.mission_reasoning === 'string' ? r.mission_reasoning : null,
        mission_failed_requirements: strArr(r.mission_failed_requirements),
      };
    });
}

/**
 * Rows that may be shown as rejected. Nothing else may be.
 *
 * The predicate the table calls instead of assuming every row it was handed is
 * a rejection — which is exactly what it used to do.
 */
export function notQualifiedRows(rows: readonly EvaluationRow[]): EvaluationRow[] {
  return rows.filter((r) => r.decided && r.status === 'not_qualified');
}

/** Rows nobody judged. Never rendered under a rejection heading. */
export function undecidedRows(rows: readonly EvaluationRow[]): EvaluationRow[] {
  return rows.filter((r) => !r.decided);
}

/** Rows the run still owes work on — a resume would continue these. */
export function resumableRows(rows: readonly EvaluationRow[]): EvaluationRow[] {
  return rows.filter((r) => r.resumable);
}

/** Rows excluded before any money was spent on them. */
export function notInvestigatedRows(rows: readonly EvaluationRow[]): EvaluationRow[] {
  return rows.filter((r) => r.status === 'not_investigated');
}

/**
 * An evaluation row is NEVER actionable.
 *
 * A function rather than a convention, so a test can assert the rule directly
 * and a future call site cannot quietly assume otherwise.
 */
export function evaluationRowIsActionable(_row: EvaluationRow): boolean {
  return false;
}

/** Rows a paid people search may run against. Structurally always empty. */
export function peopleSearchEligibleEvaluationRows(rows: readonly EvaluationRow[]): EvaluationRow[] {
  return rows.filter(() => false);
}

/**
 * The funnel, counted from evaluation rows plus the REAL qualified rows.
 *
 * `qualified` and `contactReady` are passed in from the lead table, never
 * derived here — an evaluation row can never contribute to them, which is the
 * whole point of keeping the two projections apart.
 */
export function evaluationFunnel(
  rows: readonly EvaluationRow[],
  qualified: { qualified: number; contactReady: number },
): {
  accountsFound: number; evaluated: number; shortlisted: number;
  identityUnresolved: number; qualified: number; contactReady: number;
} {
  return {
    // Qualified companies leave the evaluation projection, so they are added
    // back for the top-of-funnel count.
    accountsFound: rows.length + qualified.qualified,
    evaluated: rows.filter((r) => r.status !== 'discovered').length + qualified.qualified,
    shortlisted: rows.filter((r) => ADVANCED.has(r.status)).length + qualified.qualified,
    identityUnresolved: rows.filter((r) => r.status === 'identity_unresolved').length,
    qualified: qualified.qualified,
    contactReady: qualified.contactReady,
  };
}

export const LIFECYCLE_LABEL: Readonly<Record<WorkbenchLifecycle, string>> = Object.freeze({
  discovered: 'Discovered',
  evaluated: 'Evaluated',
  not_investigated: 'Not investigated',
  shortlisted: 'Shortlisted',
  identity_unresolved: 'Identity unresolved',
  verifying: 'Verifying',
  deferred: 'Deferred',
  held_for_evidence: 'Awaiting evidence',
  qualified: 'Qualified',
  not_qualified: 'Not qualified',
  contact_ready: 'Contact-ready',
});

/**
 * THE SIX NUMBERS A LEAD RUN OWES THE USER, each counted once.
 *
 * Lead V2 run 4250f181 rendered "10 reviewed / 8 ruled out" for a mission that
 * had discovered 33 companies, triaged 20 out, and was still trying to confirm
 * the identity of eight — none of which had been ruled out. These are counted
 * from the same rows the tabs use, and no count borrows another's meaning.
 *
 *   discovered          every company the run holds, qualified included
 *   triaged_out         set aside by triage before any money was spent
 *   investigating       shortlisted, being verified, or waiting on evidence
 *   identity_unresolved looked up, not yet confirmed — pending, not rejected
 *   verified            identity confirmed and carried on to verification
 *   qualified           passed — passed in from the lead table, never derived
 */
export interface WorkbenchFunnelCounts {
  discovered: number;
  triaged_out: number;
  investigating: number;
  identity_unresolved: number;
  verified: number;
  qualified: number;
}

const INVESTIGATING: ReadonlySet<WorkbenchLifecycle> = new Set([
  'shortlisted', 'verifying', 'held_for_evidence', 'deferred',
]);

export function workbenchFunnelCounts(
  rows: readonly EvaluationRow[],
  qualified: number,
): WorkbenchFunnelCounts {
  const q = Math.max(0, Math.trunc(qualified));
  // LEAD V2: the backend's buckets, never re-derived from lifecycle statuses.
  // A canonical `pending` row is `held_for_evidence`, which the legacy reading
  // counted as "investigating" — the caption said "4 investigating" for four
  // companies the run had finished checking.
  if (rows.some((r) => r.canonical)) {
    const n = (b: string) => rows.filter((r) => r.canonical?.bucket === b).length;
    return {
      discovered: rows.length + q,
      triaged_out: n('screened_out'),
      investigating: n('investigating'),
      identity_unresolved: n('identity_unresolved'),
      verified: n('pending') + n('ineligible') + q,
      qualified: q,
    };
  }
  const triagedOut = (r: EvaluationRow) =>
    r.shortlist_exclusion === 'triage_irrelevant' ||
    (r.status === 'not_investigated' && r.triage_relevance === 'irrelevant');
  return {
    discovered: rows.length + q,
    triaged_out: rows.filter(triagedOut).length,
    investigating: rows.filter((r) => INVESTIGATING.has(r.status)).length,
    identity_unresolved: rows.filter((r) => r.status === 'identity_unresolved').length,
    // Past identity: verifying, held, or judged by the evaluator — plus every
    // qualified company, which had to pass through all of it.
    verified: rows.filter((r) =>
      r.status === 'verifying' || r.status === 'held_for_evidence' ||
      (r.status === 'not_qualified' && r.decision_source === 'gpt_evaluation')).length + q,
    qualified: q,
  };
}

/** One line, in pipeline order. Zeroes are shown: "0 verified" is an answer. */
export function funnelCaption(c: WorkbenchFunnelCounts): string {
  return [
    `${c.discovered} discovered`,
    `${c.triaged_out} triaged out`,
    `${c.investigating} investigating`,
    `${c.identity_unresolved} identity unresolved`,
    `${c.verified} verified`,
    `${c.qualified} qualified`,
  ].join(' · ');
}
