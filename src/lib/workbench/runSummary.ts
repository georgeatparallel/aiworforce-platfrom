// ONE SET OF HEADLINE NUMBERS FOR THE WORKBENCH.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// Three counter systems rendered at once, above the leads:
//
//   PortfolioSummary        11 cells  Requested, Shown, Opportunities,
//                                     Tier A/B/C, Qualified, Review, Watch,
//                                     Contact-ready
//   WorkflowProgressStrip    7 lines  Accounts found, Evaluated, Open roles
//                                     read, Eligible opportunities, Verified
//                                     companies, Qualified companies,
//                                     Decision-makers verified
//   LeadResultsView chips    6 chips  ACCOUNTS FOUND, EVALUATED, QUALIFIED
//                                     COMPANIES, DECISION-MAKERS VERIFIED,
//                                     CONTACT-READY, REMAINING
//
// Twenty-four numbers. "Qualified" appeared THREE times, and Accounts found,
// Evaluated, Contact-ready and Decision-makers verified each appeared twice.
//
// ── AND THEY COULD DISAGREE ─────────────────────────────────────────────────
//
// Not merely repetitive — they read three different persisted projections of
// the same fact: the engine's quota contract, the portfolio the engine built,
// and the row-level table. A user seeing "Qualified 3" beside "Qualified
// companies 6" has no way to know which is the answer, and neither did the UI:
// nothing compared them.
//
// So this does two things. It picks ONE authority per number, using the same
// precedence `buildWorkbenchCounts` already established — the engine's own
// answer beats a projection, a projection beats counting rows. And it RECORDS
// any disagreement instead of silently preferring one, because two projections
// of one run disagreeing is a data defect, and hiding it behind a chosen winner
// is how it would survive.
//
// ── WHY `qualified` IS NOT `!not_qualified` ─────────────────────────────────
//
// `qualification.ts` carries the scar: TEST plan edb4cbf6 reported 20 qualified
// companies for a run whose qualified set was empty, because the count asked
// "was this rejected?" instead of "was this accepted?". Absence of a rejection
// is not a pass. Every count here reads an explicit positive verdict.
//
// Pure — no React, no network.

import type { PortfolioView } from './portfolioView.ts';
import type { WorkbenchProgress } from './workbenchProgress.ts';
import type { QuotaProgress } from '../qualifiedLead/quotaProgress.ts';

export const RUN_SUMMARY_VERSION = 'workbench-run-summary-v1' as const;

/** Which projection answered a number. Shown in Run details, never on the hero. */
export type CountSource =
  | 'engine_quota'
  | 'portfolio'
  | 'progress'
  | 'rows'
  /** Lead V2: the backend's canonical decision (`workbench_mission_view`). */
  | 'canonical'
  | 'none';

export interface SummaryNumber {
  value: number;
  source: CountSource;
  /**
   * Other projections' answers, when they differ.
   *
   * Empty on the healthy path. Non-empty means two records of one run disagree,
   * which Run details reports — a number nobody can reconcile is worse than a
   * number nobody shows.
   */
  disagreements: Array<{ source: CountSource; value: number }>;
}

export interface RunSummary {
  version: typeof RUN_SUMMARY_VERSION;
  /** THE HEADLINE. Qualified LEADS — explicit positive verdicts only. */
  qualified: SummaryNumber;
  /** Companies that matched the mission. A different entity; never the headline. */
  qualifiedCompanies: SummaryNumber;
  /** Companies looked at, whatever the outcome. Context for the headline. */
  reviewed: SummaryNumber;
  /** Judged, but still waiting on something before they can qualify. */
  pending: SummaryNumber;
  /** Of `pending`, those nothing further will check in this run. 0 on legacy runs. */
  unverifiable: number;
  /** Looked at and ruled out. */
  notAFit: SummaryNumber;
  /** What the user asked for. Null when the request named no number. */
  requested: number | null;
  /** Short of the request, and still running or resumable. */
  shortfall: number;
  /** True while the run is still working. */
  inProgress: boolean;
  /** True when any two projections disagree about any headline number. */
  hasDisagreement: boolean;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/**
 * Pick the first source that has an answer, and record the rest when they differ.
 *
 * Candidates are supplied in PRECEDENCE ORDER. The winner is the first non-null;
 * every other non-null that disagrees with it is reported.
 */
function reconcile(
  candidates: Array<{ source: CountSource; value: number | null }>,
): SummaryNumber {
  const present = candidates.filter((c) => c.value !== null) as
    Array<{ source: CountSource; value: number }>;
  if (present.length === 0) return { value: 0, source: 'none', disagreements: [] };
  const [winner, ...rest] = present;
  return {
    value: winner.value,
    source: winner.source,
    disagreements: rest.filter((c) => c.value !== winner.value),
  };
}

export interface RunSummaryInput {
  /**
   * THE CANONICAL LEAD QUALIFICATION, counted from the rows themselves.
   *
   * Not reconciled against anything, and deliberately not overridable by a
   * projection. `resolveQualification(row).qualified` is the audited answer to
   * "is this a qualified LEAD", and every other number in this file is context
   * around it.
   *
   * This used to run through the precedence chain below, which is how the hero
   * came to say "11 qualified leads" while the Qualified tab said 0: the chain
   * preferred `quota.qualifiedCompanies` — a count of COMPANIES — and labelled
   * it leads. `workbenchCounts.ts` exists because of exactly that conflation:
   * "for a request asking for five CONTACT-ready LEADS, '5 FOUND' read as the
   * quota being met while zero leads existed."
   */
  qualifiedLeads: number;
  /** Rows evaluated and short of one thing. Canonical, same source. */
  leadsInReview: number;
  /** The engine's own quota contract. Highest authority where it speaks. */
  quota: QuotaProgress | null;
  /** The ranked portfolio the engine built for this run. */
  portfolio: PortfolioView | null;
  /** Stage-by-stage progress, written as the run proceeds. */
  progress: WorkbenchProgress | null;
  /** Row-level fallback for legacy runs the projections do not cover. */
  rows: { total: number; qualified: number; pending: number };
  /**
   * LEAD V2: THE CANONICAL DECISION, when the run wrote one.
   *
   * Then it is the only answer. The legacy portfolio and the lead-row total are
   * other projections of an older decision — reconciling against them reported
   * "counts disagree" on canary 9b1b70a2 for a run whose canonical numbers were
   * consistent (portfolio: 0 qualified; canonical: 1). Absent on legacy runs,
   * which reconcile exactly as before.
   */
  canonical?: { qualifiedCompanies: number; reviewed: number; pending: number; unverifiable?: number } | null;
}

/**
 * THE CANONICAL NUMBERS FOR `buildRunSummary`, OR NULL FOR A LEGACY RUN.
 *
 * The canonical mission view is the authority whenever the run wrote one —
 * `readWorkbenchProgress` carries its counts as `progress.canonical`. This used
 * to be decided by whether any EVALUATION ROW carried a canonical decision, and
 * a run whose every company qualified has none (a qualified company is a lead
 * row, not an evaluation row). Production Salvo, plan ce80738e (2026-09-26):
 * one company, qualified, one lead written, canonical qualified = 1 — and the
 * footer said "counts disagree", because the summary fell back to reconciling
 * the stale `workbench_portfolio` (written before the funding verifier ran:
 * qualified 0) against the lead. With a view present, the portfolio is never
 * consulted.
 *
 * The evaluation-row signal remains only as the fallback for a canonical run
 * whose progress was not written.
 */
export function summaryCanonicalInput(
  progress: WorkbenchProgress | null,
  tab: { canonical: boolean; inReview: number },
): RunSummaryInput["canonical"] {
  if (progress?.canonical) {
    return {
      qualifiedCompanies: progress.canonical.qualified_companies,
      reviewed: progress.canonical.reviewed,
      pending: progress.canonical.pending,
      unverifiable: progress.canonical.unverifiable ?? 0,
    };
  }
  return tab.canonical && progress
    ? { qualifiedCompanies: progress.qualified_companies, reviewed: progress.evaluated, pending: tab.inReview }
    : null;
}

export function buildRunSummary(i: RunSummaryInput): RunSummary {
  const { quota, portfolio, progress, rows } = i;

  // AN EMPTY TABLE HAS NOT COUNTED ANYTHING.
  //
  // With no rows, the row-level fallback would report a confident `0 qualified`
  // and become the authority for a run whose projections simply have not been
  // written yet — turning "we have not looked" into "we looked and found none",
  // which is the exact conflation this module exists to prevent, reintroduced
  // one layer down. Rows speak only when there are rows.
  const rowsSpeak = rows.total > 0;
  const fromRows = (v: number): number | null => (rowsSpeak ? v : null);

  // QUALIFIED LEADS. One source, no precedence, no override.
  const qualified: SummaryNumber = {
    value: Math.max(0, Math.trunc(i.qualifiedLeads)),
    source: 'rows',
    disagreements: [],
  };

  // QUALIFIED COMPANIES is a DIFFERENT ENTITY and is reconciled separately.
  // A company can match every criterion and still yield no contactable lead —
  // which is what the persisted runs show: 10 qualified companies, 0
  // contact-ready leads, on every one of them. Both numbers are true; neither
  // may stand in for the other, and this is where that rule is enforced.
  const qualifiedCompanies = reconcile([
    { source: 'engine_quota', value: num(quota?.qualifiedCompanies) },
    { source: 'portfolio', value: num(portfolio?.counts.qualified) },
    { source: 'progress', value: num(progress?.qualified_companies) },
  ]);

  // REVIEWED is discovery-shaped and says nothing about qualification. Kept
  // separate for exactly that reason — collapsing the two is what once made "5
  // found" read as a met quota for a run with zero leads.
  const reviewed = reconcile([
    { source: 'progress', value: num(progress?.evaluated) },
    { source: 'portfolio', value: num(portfolio?.counts.delivered) },
    { source: 'rows', value: fromRows(rows.total) },
  ]);

  if (i.canonical) {
    const one = (value: number): SummaryNumber =>
      ({ value: Math.max(0, Math.trunc(value)), source: 'canonical', disagreements: [] });
    const qc = one(i.canonical.qualifiedCompanies);
    const rv = one(i.canonical.reviewed);
    const pd = one(i.canonical.pending);
    const req = num(quota?.requested);
    return {
      version: RUN_SUMMARY_VERSION,
      qualified, qualifiedCompanies: qc, reviewed: rv, pending: pd,
      unverifiable: Math.min(pd.value, Math.max(0, Math.trunc(i.canonical.unverifiable ?? 0))),
      notAFit: one(rv.value - qc.value - pd.value),
      requested: req,
      shortfall: req != null ? Math.max(0, req - qualified.value) : 0,
      inProgress: progress?.in_progress === true,
      hasDisagreement: false,
    };
  }

  // PENDING: judged, not yet qualifiable. The portfolio's `review` bucket is the
  // same idea by another name.
  // PENDING is the canonical row answer too, for the same reason: it labels the
  // "In review" tab, and a tab count that disagrees with the list under it is
  // the defect this whole file was written to remove.
  const pending: SummaryNumber = {
    value: Math.max(0, Math.trunc(i.leadsInReview)),
    source: 'rows',
    disagreements: [],
  };

  // NOT A FIT is DERIVED, never counted independently — reviewed minus the two
  // positive buckets. A separately-counted total is a fourth number that can
  // disagree with the other three.
  // Against COMPANIES, because `reviewed` counts companies. Subtracting a lead
  // count from a company count is the same category error one line up.
  const notAFitValue = Math.max(0, reviewed.value - qualifiedCompanies.value - pending.value);

  const requested = num(quota?.requested);
  // The request is for LEADS, so the shortfall is measured in leads.
  const shortfall = requested != null ? Math.max(0, requested - qualified.value) : 0;

  return {
    version: RUN_SUMMARY_VERSION,
    qualified,
    qualifiedCompanies,
    reviewed,
    pending,
    unverifiable: 0,
    notAFit: { value: notAFitValue, source: reviewed.source, disagreements: [] },
    requested,
    shortfall,
    inProgress: progress?.in_progress === true,
    hasDisagreement: [qualifiedCompanies, reviewed].some((n) => n.disagreements.length > 0),
  };
}

/**
 * The one line under the headline.
 *
 * Plain language on purpose. "10 qualified" is the answer; this is the context a
 * reader needs to trust it, and it must not reintroduce the counter wall it
 * replaced — one sentence, three numbers at most.
 */
export function summaryCaption(s: RunSummary): string {
  const parts = [`${s.reviewed.value} ${s.reviewed.value === 1 ? 'company' : 'companies'} reviewed`];
  // A pending company nothing will check again is not "being checked"
  // (Query B a9a6791a: four such companies after the lineage ended).
  const unverifiable = Math.min(s.unverifiable ?? 0, s.pending.value);
  const checking = s.pending.value - unverifiable;
  if (checking > 0) parts.push(`${checking} still being checked`);
  if (unverifiable > 0) parts.push(`${unverifiable} could not be verified`);
  if (s.inProgress) parts.push('still running');
  return parts.join(' · ');
}

/**
 * The headline itself.
 *
 * Says QUALIFIED, never "found". The distinction is the whole reason this file
 * exists: a row being on the page has never meant it qualified.
 */
export function summaryHeadline(s: RunSummary): string {
  const n = s.qualified.value;
  if (n > 0) return `${n} qualified ${n === 1 ? 'lead' : 'leads'}`;

  // NOTHING QUALIFIED YET — SAY WHAT IS ACTUALLY THERE.
  //
  // The headline read "11 qualified leads" while the Qualified tab read 0,
  // because it was showing a COMPANY count under a LEAD label. With the
  // entities separated the honest answer for that state is that eleven leads
  // are still being checked, which is what the tabs already said.
  if (s.pending.value > 0) {
    const p = s.pending.value;
    return `${p} ${p === 1 ? 'lead' : 'leads'} in review`;
  }
  // No leads either way: fall back to the company-level fact, LABELLED as
  // companies. A run can qualify companies and produce no contactable lead —
  // every run in the persisted history did exactly that.
  if (s.qualifiedCompanies.value > 0) {
    const c = s.qualifiedCompanies.value;
    return `${c} ${c === 1 ? 'company' : 'companies'} matched`;
  }
  return s.inProgress ? 'Still looking' : 'No qualified leads yet';
}
