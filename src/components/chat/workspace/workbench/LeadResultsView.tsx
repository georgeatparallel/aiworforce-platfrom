import { useEffect, useMemo, useState, useCallback } from 'react';
import { useLeadResults, type LeadTableRow } from '@/hooks/useLeadResults';
import { dispatchResultAction, type LeadResultPanelAction } from '@/lib/chatActions';
import type { LeadResultsPanelMeta } from '@/contexts/ChatWorkspaceContext';
import LeadSpreadsheet from './leadTable/LeadSpreadsheet';
import LeadDetailDrawer from './leadTable/LeadDetailDrawer';
import { estimateCredits, recommendNextAction, isRecommendationDispatchable, ACTION_LABEL } from './leadTable/credits';
import { rowsToCsv, downloadCsv } from './leadTable/csv';
import LeadFilterBar from './LeadFilterBar';
import {
  EMPTY_WORKBENCH_FILTERS, applyWorkbenchFilters, filterOptionsFrom,
  activeFilterCount, type WorkbenchFilters,
} from '@/lib/workbench/leadFilters';
import {
  workbenchRowsToCsv, rowsForScope, exportFilename, qualificationOf,
  type ExportScope, type ExportableLead,
} from '@/lib/workbench/leadExport';
import { Loader2, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useToolAvailability } from '@/lib/workflows/useToolAvailability';
import { useChatWorkspace } from '@/contexts/ChatWorkspaceContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { runLeadAction } from '@/lib/leadActions';
import { LEAD_ACTION_LOADING, workbenchActionToLeadKind, type LeadActionKind } from '@/lib/leadActionRequest';
import { deriveRowAction, rowsForExport, type RowAction } from '@/lib/leadRowAction';
import { emptyBatchTally, formatBatchSummary } from '@/lib/leadActionOutcome';
import {
  emptyAccountView, mergeWorkbenchStage, STAGE_FOR_ACTION,
  type WorkbenchAccountView,
} from '@/lib/workbenchAccountView';
import { buildCompanyResearchView } from '@/lib/companyResearchDisplay';
import { toOutreachStageView } from '@/lib/outreachStageView';
import { hydrateAccountView, applyHydrationFloor, savedIcpFromBrain, hydrateAccountResearchSnapshot } from '@/lib/accountResearchHydration';
import { buildWhyRelevant } from '@/lib/icpSnapshot';
import {
  buildPersonalizationContext, assessOpenerEligibility, brainContextFromProfile,
  buildOutreachRowHint, type OutreachRowHint,
} from '@/lib/outreachOpener';
import { useCompanyBrain } from '@/hooks/useCompanyBrain';
import { buildQuotaProgress } from '@/lib/qualifiedLead/quotaProgress';
import { qualificationFromRow } from '@/lib/qualifiedLead/rowQualification';
import { resolveQualification as qualificationFromRecord } from '@/lib/qualifiedLead/qualification';
import { EMPTY_WORKBENCH_MESSAGE } from '@/lib/workbench/workbenchSession';
import { buildRunSummary, summaryCanonicalInput } from '@/lib/workbench/runSummary';
import {
  LEAD_TAB_EMPTY, type LeadTabId, notReachedCompanies, partitionLeads, tabsFor,
  partitionAllRows, bucketReasonFor, resultTabCounts,
} from '@/lib/workbench/leadTabs';
import type { PortfolioView } from '@/lib/workbench/portfolioView';
import type { WorkbenchProgress } from '@/lib/workbench/workbenchProgress';
import type { EvaluationRow } from '@/lib/workbench/evaluationRows';
import { workbenchFunnelCounts } from '@/lib/workbench/evaluationRows';
import RunSummaryHero from './RunSummaryHero';
import RunDetails from './RunDetails';
import { companySizeText, readCompanySizeFacts } from '@/lib/workbench/companySize';

interface Props {
  meta: LeadResultsPanelMeta;
  conversationId: string | null;
  taskId?: string | null;
  /**
   * The run's own projections, passed down rather than rendered as siblings.
   *
   * They used to be three fixed-height strips ABOVE this view, which is what
   * left the leads roughly 180px of an 800px panel. They now feed the one
   * headline and the collapsed Run details, both rendered here.
   */
  portfolio?: PortfolioView | null;
  progress?: WorkbenchProgress | null;
  evaluationRows?: EvaluationRow[];
  /**
   * The two secondary views, built by the panel.
   *
   * Both need the panel's `data`; passing the built elements keeps the leads
   * fetched once. `useLeadResults` holds plain state with no shared cache, so
   * calling it a second time to satisfy a tab would double every query.
   */
  insightsSlot?: React.ReactNode;
  activitySlot?: React.ReactNode;
}

export default function LeadResultsView({
  meta, conversationId, taskId = null,
  portfolio = null, progress = null, evaluationRows = [],
  insightsSlot = null, activitySlot = null,
}: Props) {
  const { closeWorkbench } = useChatWorkspace();
  const { workspaceId } = useWorkspace();
  // THE FULL OWNERSHIP CHAIN, not just the plan id. `meta.plan_id` alone is what
  // let a new conversation display a previous chat's completed run.
  const { items, loading, error, refresh } = useLeadResults({
    workspaceId: workspaceId ?? null,
    conversationId,
    taskId,
    planId: meta.plan_id ?? null,
  });
  const tools = useToolAvailability();
  // Direct lead-action state. Per-row (Part E) is the source of truth; a light
  // global banner is kept for selection/errors only.
  const [directRunning, setDirectRunning] = useState<LeadActionKind | null>(null);
  const [rowActions, setRowActions] = useState<Record<string, RowAction>>({});
  // Account-centric state: one slot PER STAGE per lead. rowActions holds only the
  // latest attempt for progress/banner purposes and must never decide which
  // completed stages still exist.
  const [accountViews, setAccountViews] = useState<Record<string, WorkbenchAccountView>>({});
  const [actionOutcome, setActionOutcome] = useState<{ kind: LeadActionKind; success: boolean; error?: string; summary?: string } | null>(null);
  // ONE FILTER OBJECT, not a variable per axis. `Has website` and the Fit chips
  // were the only two the Workbench ever had (unchanged since `ada8c9dc`); they
  // are `hasWebsite` and `minFit` here and behave exactly as before.
  const [filters, setFilters] = useState<WorkbenchFilters>({ ...EMPTY_WORKBENCH_FILTERS });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerRow, setDrawerRow] = useState<LeadTableRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ action: LeadResultPanelAction; ids: string[]; credits: number } | null>(null);

  // Active workspace Company Brain → saved ICP (never generic defaults).
  const { data: brain } = useCompanyBrain();
  const savedIcp = useMemo(
    () => savedIcpFromBrain((brain as { profile?: unknown } | null)?.profile ?? null),
    [brain],
  );

  // Zero-credit hydration. Seed each loaded account's research + saved-ICP stage
  // from data Agentory ALREADY collected (verified website, company LinkedIn, live
  // job posting, source proof, enrichment summary). Hydration is a FLOOR — an
  // action-updated stage always wins (applyHydrationFloor), so completed
  // intelligence survives every later action and no user is charged to rediscover
  // sources. No provider call, no network, no writes.
  useEffect(() => {
    if (items.length === 0) return;
    setAccountViews((prev) => {
      const next: Record<string, WorkbenchAccountView> = { ...prev };
      for (const r of items) {
        const { view } = hydrateAccountView(r, savedIcp);
        next[r.id] = applyHydrationFloor(view, prev[r.id]);
      }
      return next;
    });
  }, [items, savedIcp]);

  // Per-row personalized-opener hint (pure, zero-credit). Drives the Personalized
  // Message cell: a persisted opener, or a SPECIFIC blocker — never the generic
  // "Complete the required previous step first". Generation itself runs later via
  // run-agent with output_mode: "personalized_opener".
  const outreachHints = useMemo<Record<string, OutreachRowHint>>(() => {
    const brainCtx = brainContextFromProfile((brain as { profile?: unknown } | null)?.profile ?? null);
    const out: Record<string, OutreachRowHint> = {};
    for (const r of items) {
      const view = accountViews[r.id];
      const icpSnap = view?.icp_snapshot ?? null;
      if (!icpSnap) continue;
      const snap = hydrateAccountResearchSnapshot(r);
      const dm = view?.decision_makers.last_success?.primary_decision_maker ?? null;
      const ctx = buildPersonalizationContext({
        snapshot: snap, icp_snapshot: icpSnap, saved_icp: savedIcp, brain: brainCtx,
        decision_maker: dm, why_relevant: buildWhyRelevant(icpSnap),
      });
      const eligibility = assessOpenerEligibility(ctx, icpSnap);
      const persisted = (view?.outreach.last_success as { opener?: string } | null) ?? null;
      out[r.id] = buildOutreachRowHint({ eligibility, persisted: persisted && 'opener' in persisted ? persisted as never : null, source_count: snap.source_count });
    }
    return out;
  }, [items, accountViews, savedIcp, brain]);

  // ── THE TAB THE USER IS ON, AND WHAT IT CONTAINS ───────────────────────
  //
  // One table used to hold everything: a company that qualified, one still
  // waiting on a contact, and one the run never reached, as adjacent rows of
  // equal weight. Separated here, from the states the model already carried.
  // The default is decided once the rows arrive — see the effect below.
  const [tab, setTab] = useState<LeadTabId>('qualified');
  const [tabChosen, setTabChosen] = useState(false);
  const partition = useMemo(
    // `contact_status` is RESTORED after the spread. qualificationFromRow only
    // echoes it (`row.contact_status ?? null`) and its record types the field
    // loosely as `string | null`, because that module also reads export and
    // legacy rows. Spread last, that echo widened LeadTableRow's ContactStatus
    // to string. The row is required here, so this is the identical value.
    () => partitionLeads(items.map((r) => ({
      ...r, ...qualificationFromRow(r), contact_status: r.contact_status,
    }))),
    [items],
  );
  const notReached = useMemo(() => notReachedCompanies(evaluationRows), [evaluationRows]);
  // ── EVERY REVIEWED COMPANY, IN EXACTLY ONE BUCKET ─────────────────────────
  //
  // The screen showed "30 companies reviewed · Qualified 0 · In review 0 · Not
  // reached 1" and twenty-nine companies were on no tab at all — eighteen of
  // them carrying a stated headcount rejection nothing was reading.
  const allBuckets = useMemo(
    () => partitionAllRows(evaluationRows as never), [evaluationRows]);
  const ruledOut = allBuckets.rejected;
  // Lead V2: a company the backend holds as pending is an evaluation row, not a
  // lead row, and still belongs under In review. See `resultTabCounts`.
  const tabCounts = useMemo(() => resultTabCounts({
    qualifiedLeads: partition.qualified.length,
    inReviewLeads: partition.inReview.length,
    evaluationRows: evaluationRows as never,
  }), [partition, evaluationRows]);
  const tabs = useMemo(() => tabsFor({
    qualified: tabCounts.qualified,
    inReview: tabCounts.inReview,
    rejected: tabCounts.rejected,
    notReached: tabCounts.notReached,
    hasInsights: !!insightsSlot,
  }), [tabCounts, insightsSlot]);

  // OPEN ON WHERE THE RESULTS ACTUALLY ARE.
  //
  // Qualified is the hero and stays first, but opening it EMPTY while eleven
  // usable leads sit one tab over shows a blank page for a run that worked.
  // Decided once, when the rows first land, so it never yanks the tab out from
  // under someone mid-read.
  useEffect(() => {
    if (tabChosen || items.length === 0) return;
    setTabChosen(true);
    if (partition.qualified.length === 0 && partition.inReview.length > 0) {
      setTab('in_review');
    }
  }, [tabChosen, items.length, partition]);

  // A tab can vanish between renders — `Not reached` disappears once a resumed
  // run finishes it. Falling back to Qualified beats rendering nothing.
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab('qualified');
  }, [tabs, tab]);

  // SELECTION DOES NOT SURVIVE A TAB CHANGE.
  //
  // `selectedRows` is derived from the visible rows, so a selection made on
  // Qualified is already inert on In review — but it is still HELD, and comes
  // back on return. A toolbar reading "3 selected" for rows the user cannot see,
  // or a count that reappears after a detour, is a worse surprise than losing a
  // selection they can remake in one click.
  useEffect(() => {
    setSelected(new Set());
  }, [tab]);

  const tabRows = tab === 'in_review' ? partition.inReview : partition.qualified;

  // FILTERS COMPOSE WITH THE TAB, they do not replace it: the tab decides which
  // rows exist, the filters narrow that set. Qualified + UK + 20-200 is the tab's
  // rows, then the location, then the band — never a filter that reaches back
  // across a tab boundary.
  const filtered = useMemo(
    () => applyWorkbenchFilters(tabRows, filters),
    [tabRows, filters],
  );
  // Options come from the TAB's rows, so a menu never offers a value that can
  // only ever return nothing here.
  const filterOptions = useMemo(() => filterOptionsFrom(tabRows), [tabRows]);
  const activeFilters = activeFilterCount(filters);
  // The second export scope's size — the whole run, not this tab.
  const qualifiedTotal = useMemo(
    () => items.filter((r) => qualificationOf(r as ExportableLead).qualified).length,
    [items],
  );

  const selectedRows = useMemo(
    () => filtered.filter((r) => selected.has(r.id)),
    [filtered, selected],
  );
  const targetRows = selectedRows.length > 0 ? selectedRows : filtered;


  const counts = useMemo(() => ({
    found: items.length,
    contactReady: items.filter((r) => r.contact_status !== 'needs_contact').length,
    needContact: items.filter((r) => r.contact_status === 'needs_contact').length,
    enrichable: items.filter((r) => !!r.website && r.enrichment_status !== 'enriched').length,
    draftReady: items.filter((r) => r.draft_status === 'drafted' || r.draft_status === 'approved').length,
  }), [items]);

  // `qualifiedLeadCounts` (buildWorkbenchCounts) lived here and fed the six-chip
  // header. `buildRunSummary` supersedes it: same precedence discipline, but it
  // reconciles the portfolio and stage projections too, which the chips never
  // saw — and it reports the disagreements rather than rendering a fourth
  // opinion beside them.

  // ── THE ONE SET OF HEADLINE NUMBERS ────────────────────────────────────
  //
  // Replaces three counter systems that rendered simultaneously: this view's
  // six chips, PortfolioSummary's eleven cells and WorkflowProgressStrip's
  // seven stage lines. "Qualified" appeared three times across them, from three
  // different persisted projections that nothing ever compared.
  //
  // `buildRunSummary` picks one authority per number and RECORDS every dissent,
  // which `RunDetails` shows. A conflict nobody can see is a conflict that
  // survives.
  const runQuota = useMemo(() => {
    const run = meta.qualified_lead_run;
    if (!run || run.count_entity !== 'contact_ready_lead') return null;
    return buildQuotaProgress({
      requested_leads: run.requested_lead_count ?? null,
      quota_policy: run.quota_policy ?? null,
      terminal_status: run.terminal_status ?? null,
      rounds_completed: run.rounds_completed ?? null,
    }, items.map(qualificationFromRow));
  }, [meta.qualified_lead_run, items]);

  // ONE SOURCE FOR THE HERO AND THE TABS.
  //
  // They used to be derived separately: the tabs from `partitionLeads`, the
  // hero from a precedence chain that preferred `quota.qualifiedCompanies`. So
  // the hero read "11 qualified leads" beside a "Qualified 0" tab — a COMPANY
  // count under a LEAD label, on the same screen as the truth.
  //
  // `partition` is now the only answer to "how many qualified", and it feeds
  // both.
  const summary = useMemo(() => buildRunSummary({
    qualifiedLeads: partition.qualified.length,
    leadsInReview: partition.inReview.length,
    quota: runQuota,
    portfolio,
    progress,
    rows: { total: items.length, qualified: 0, pending: 0 },
    // Lead V2: the canonical decision is the only answer when the run wrote one.
    // The canonical mission view is authoritative whenever the run wrote one.
    canonical: summaryCanonicalInput(progress, tabCounts),
  }), [partition, items.length, runQuota, portfolio, progress, tabCounts]);

  // The qualification diagnostics were computed here and rendered inline above
  // the table. They are DIAGNOSTIC — read when a number looks wrong — so phase 2
  // moves them to an Insights tab. Both derivations are pure functions of
  // `meta.qualified_lead_run` (`insightsFromResult` / `processingState`) and are
  // recomputed there; keeping a dead copy here would be a second answer waiting
  // to drift from the live one.

  const recommendation = useMemo(() => meta.recommended_next_action
    ? {
        action: (meta.recommended_next_action.action as LeadResultPanelAction) ?? 'find_contacts',
        label: meta.recommended_next_action.label,
        reason: meta.recommended_next_action.reason,
        estimated_credits: meta.recommended_next_action.estimated_credits ?? 0,
      }
    : recommendNextAction(items),
  [items, meta.recommended_next_action]);

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  const toggleAll = useCallback(() => {
    setSelected((s) => {
      if (s.size === filtered.length) return new Set();
      return new Set(filtered.map((r) => r.id));
    });
  }, [filtered]);

  // Direct lead action → run-agent's lead_action branch with the given existing
  // lead_candidate_ids. Runs ONE company at a time and writes each row's own
  // lifecycle (running → success/empty/insufficient_context/error). The row/
  // drawer — not a chat transcript — is the result surface. NEVER starts Scout
  // sourcing.
  const runDirectLeadAction = useCallback(async (kind: LeadActionKind, rowsArg?: LeadTableRow[]) => {
    if (directRunning) return;
    const rows = rowsArg ?? selectedRows;
    if (rows.length === 0) {
      setActionOutcome({ kind, success: false, error: 'Select one or more Workbench rows first.' });
      return;
    }
    setActionOutcome(null);
    setDirectRunning(kind);
    setRowActions((s) => { const n = { ...s }; for (const r of rows) n[r.id] = { kind, status: 'running' }; return n; });

    // Tally by CATEGORY. A batch of pre-execution rejections must report
    // "4 request errors", not "0/4 succeeded" — the latter falsely implies four
    // leads were examined and none qualified.
    const tally = emptyBatchTally(rows.length);
    for (const r of rows) {
      try {
        const res = await runLeadAction({ leadAction: kind, leadCandidateIds: [r.id], workspaceId, planId: meta.plan_id });
        const p = (res.per_lead && res.per_lead[0]) ? res.per_lead[0] as Record<string, unknown> : {};
        const ra = deriveRowAction(kind, res, p);
        if (ra.status !== 'running') tally[ra.status] += 1;
        setRowActions((s) => ({ ...s, [r.id]: ra }));

        // Stage-aware merge: this updates ONE stage and carries every other
        // completed stage forward. Running Generate outreach can no longer
        // erase the research column.
        const stage = STAGE_FOR_ACTION[kind];
        setAccountViews((prev) => ({
          ...prev,
          [r.id]: mergeWorkbenchStage(prev[r.id] ?? emptyAccountView(r.id), {
            stage,
            lead_candidate_id: r.id,
            status: ra.status,
            reason_code: ra.reason_code,
            message: ra.detail,
            payload: stage === 'company_research'
              ? buildCompanyResearchView(p as never, ra.status === 'succeeded' ? 'succeeded' : 'partial')
              : stage === 'decision_makers'
                ? ra.decisionMakers ?? null
                // The FULL canonical outreach result. This used to be
                // `{ status: ra.status }`, which discarded the generated opener
                // along with its depth, evidence ids and approval state — the
                // row then had a success status and nothing to render.
                : toOutreachStageView({ ...p, status: ra.status, reason_code: ra.reason_code }),
            now: new Date().toISOString(),
          }),
        }));
      } catch (e) {
        // A thrown invoke never reached execution either.
        tally.request_error += 1;
        setRowActions((s) => ({
          ...s,
          [r.id]: { kind, status: 'request_error', detail: e instanceof Error ? e.message : undefined },
        }));
        // A thrown request is an attempt, not a reason to discard prior stages.
        setAccountViews((prev) => ({
          ...prev,
          [r.id]: mergeWorkbenchStage(prev[r.id] ?? emptyAccountView(r.id), {
            stage: STAGE_FOR_ACTION[kind],
            lead_candidate_id: r.id,
            status: 'request_error',
            now: new Date().toISOString(),
          }),
        }));
      }
    }
    setDirectRunning(null);
    setActionOutcome({ kind, success: tally.succeeded > 0, summary: formatBatchSummary(tally) });
    await refresh();
  }, [directRunning, selectedRows, workspaceId, meta.plan_id, refresh]);

  // ── EXPORT ─────────────────────────────────────────────────────────────
  //
  // Two named scopes instead of one control whose meaning depended on whether a
  // checkbox happened to be ticked. `current_view` takes the rows the table is
  // showing — already narrowed by the tab and the filters, and not re-decided
  // here, because an export that recomputes its own rows is an export that can
  // disagree with the screen. `qualified` reads the run's full row set.
  const runExport = useCallback((scope: ExportScope) => {
    const rows = rowsForScope(scope, {
      visible: filtered as ExportableLead[],
      all: items as ExportableLead[],
    });
    downloadCsv(exportFilename(scope, meta.plan_id), workbenchRowsToCsv(rows));
  }, [filtered, items, meta.plan_id]);

  // The ~110-column audit export, unchanged. Same rows as the current view, so
  // the two files describe the same set at different depths.
  const runDiagnosticExport = useCallback(() => {
    downloadCsv(
      `run-diagnostics-${meta.plan_id.slice(0, 8)}.csv`,
      rowsToCsv(filtered, meta.qualified_lead_run ?? null),
    );
  }, [filtered, meta.plan_id, meta.qualified_lead_run]);

  const runAction = useCallback((action: LeadResultPanelAction, rows: LeadTableRow[]) => {
    if (action === 'export_csv') {
      // The run context travels with the export so every row can be traced back
      // to the query, family and quota that produced it.
      downloadCsv(`leads-${meta.plan_id.slice(0, 8)}.csv`, rowsToCsv(rows, meta.qualified_lead_run ?? null));
      return;
    }
    const kind = workbenchActionToLeadKind(action);
    if (kind) { void runDirectLeadAction(kind, rows); return; }   // structured, row-scoped
    // Other actions (rank / save-to-signal-feed / enrich_and_draft) keep the
    // existing credits-confirm + chat path.
    const credits = estimateCredits(action, rows);
    if (credits > 0) {
      setConfirmAction({ action, ids: rows.map((r) => r.id), credits });
      return;
    }
    dispatchResultAction({
      conversationId,
      planId: meta.plan_id,
      leadCandidateIds: rows.map((r) => r.id),
      action,
      estimatedCredits: credits,
    });
  }, [conversationId, meta.plan_id, runDirectLeadAction]);

  // Bulk + recommended actions operate on the SELECTION (empty → clear message,
  // never all rows / a new search). Unlock cells operate on their own row.
  const onUnlock = useCallback((a: LeadResultPanelAction, id: string) => {
    const row = items.find((r) => r.id === id);
    if (!row) return;
    runAction(a, [row]);
  }, [runAction, items]);

  // A recommendation whose prerequisite does not exist must not be dispatchable:
  // "Find decision-makers" with no qualified company would spend a paid call
  // searching people at nothing.
  const onRunRecommendation = useCallback(() => {
    if (!isRecommendationDispatchable(recommendation)) return;
    runAction(recommendation.action, selectedRows);
  }, [runAction, recommendation, selectedRows]);

  const confirmAndDispatch = useCallback(() => {
    if (!confirmAction) return;
    dispatchResultAction({
      conversationId,
      planId: meta.plan_id,
      leadCandidateIds: confirmAction.ids,
      action: confirmAction.action,
      estimatedCredits: confirmAction.credits,
      confirmed: true,
    });
    setConfirmAction(null);
  }, [confirmAction, conversationId, meta.plan_id]);

  const isApifyPeopleReady = tools.apify_people?.configured && tools.apify_people?.enabled;
  const isFirecrawlReady = tools.firecrawl?.configured && tools.firecrawl?.enabled;

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-[#0a0d12] relative overflow-hidden">

      {/* ── THE ANSWER ────────────────────────────────────────────────────
          What stood here: a 13.5px title, a 6-chip counter row (ACCOUNTS
          FOUND / EVALUATED / QUALIFIED COMPANIES / DECISION-MAKERS VERIFIED /
          CONTACT-READY / REMAINING), a filter row, and a dismissible banner
          explaining what Workbench is. The largest text on the page was the
          title; the number the user came for rendered at 11px inside the chip
          row, beside two other components showing their own answer to the same
          question.

          One number, one line of context, one action. The counters live in Run
          details, under the table. */}
      {/* NO CTA BESIDE THE HERO.
          It was a large DISABLED panel carrying a paragraph explaining why it
          was disabled — the single biggest block on the screen, permanently
          unusable on every run in the history, and beside the one number the
          page exists to show. The action still exists in the action bar, where
          it appears when it can actually run. A disabled control with an
          explanation is a cost with no benefit: it takes prime space to say
          "not yet". */}
      <RunSummaryHero
        summary={summary}
        funnel={evaluationRows.length > 0
          // QUALIFIED COMPANIES, not contact-ready leads: a company with no
          // contact yet is still qualified (Query B d22d9ee6 read "0 qualified").
          ? workbenchFunnelCounts(evaluationRows, Math.max(partition.qualified.length, summary.qualifiedCompanies.value))
          : null}
        cta={isRecommendationDispatchable(recommendation) ? {
          label: recommendation.label,
          onClick: onRunRecommendation,
        } : null}
      />

      {/* ── THE TABS ───────────────────────────────────────────────────────
          Qualified is the default and the hero. The counts are on the tabs
          themselves, which is the only place a count belongs now: it labels
          the thing you are about to look at instead of floating above three
          other numbers claiming the same subject. */}
      <div className="px-6 flex items-center gap-1 border-b border-white/[0.06] shrink-0">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-3 text-[13px] transition-colors ${
                active ? 'text-[#F0F6FC] font-medium' : 'text-[#8b949e] hover:text-[#C9D1D9]'
              }`}
            >
              {t.label}
              {t.count !== null && (
                <span className={`ml-1.5 tabular-nums ${active ? 'text-emerald-300' : 'text-[#6e7681]'}`}>
                  {t.count}
                </span>
              )}
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-emerald-400" />
              )}
            </button>
          );
        })}
      </div>

      {/* Filters and export apply to the two lead tabs only — there is nothing
          to filter on a list of companies the run never reached, and offering a
          control that changes nothing is worse than not offering it.

          EXPORT LIVES HERE, not in the selection toolbar. It was in the
          always-rendered action bar until `2ba36cfc` folded that bar into a
          selection-gated one; the button survived, the way to reach it without
          ticking a checkbox did not. */}
      {(tab === 'qualified' || tab === 'in_review') && (
        <LeadFilterBar
          filters={filters}
          onFilters={setFilters}
          options={filterOptions}
          shown={filtered.length}
          total={tabRows.length}
          qualifiedTotal={qualifiedTotal}
          onExport={runExport}
          onExportDiagnostic={runDiagnosticExport}
        />
      )}

      {/* RecommendationBanner removed: the recommendation IS the hero CTA
          above, and rendering both stated one next step twice, in two visual
          languages, 60px apart. QualificationInsightsPanel moves to the
          Insights tab in phase 2 — it is diagnostic, not the answer. */}
      {/* `BulkActionToolbar` rendered here and is removed: with the action bar
          now appearing on selection, the two were the same bar twice. */}

      {actionOutcome && (
        <LeadActionOutcomeCard outcome={actionOutcome} onClose={() => setActionOutcome(null)} />
      )}

      {/* ── SECONDARY TABS ─────────────────────────────────────────────────
          Scrolled, bounded, and outside the lead-table branch entirely, so
          nothing about them can affect the space the leads get. */}
      {tab === 'in_review' && tabCounts.pendingEvidence.length > 0 && partition.inReview.length === 0 ? (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          <p className="text-[13px] text-[#8b949e] leading-relaxed mb-4 max-w-xl">
            These {tabCounts.pendingEvidence.length} companies match everything we could check so
            far, but a required fact is still unproven. They are not matches yet and not ruled out.
          </p>
          <ul className="space-y-px">
            {tabCounts.pendingEvidence.map((c) => (
              <li key={c.company_key} className="py-2.5 border-b border-white/[0.04]">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-[13.5px] text-[#C9D1D9] truncate">{c.company_name}</span>
                  <span className="text-[12px] text-[#6e7681] shrink-0 truncate max-w-[55%]">
                    {bucketReasonFor(c)}
                  </span>
                </div>
                {(c.canonical?.missing_evidence.length ?? 0) > 0 && (
                  <div className="text-[11.5px] text-[#6e7681] mt-0.5">
                    Missing: {c.canonical!.missing_evidence.slice(0, 3).join('; ')}
                  </div>
                )}
                {(c.canonical?.evidence_gaps ?? []).map((g) => (
                  <div key={g.dimension} className="text-[11.5px] text-[#6e7681] mt-0.5">
                    {g.next === 'verify'
                      ? <>Next check ({g.dimension.replace(/_/g, ' ')}): {g.route}</>
                      : <>Can't verify {g.dimension.replace(/_/g, ' ')} yet — {g.blocked_by.join('; ') || 'no source can establish it'}</>}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : tab === 'not_reached' ? (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          <p className="text-[13px] text-[#8b949e] leading-relaxed mb-4 max-w-xl">
            The run stopped before checking these {notReached.length} companies.
            Resuming picks up exactly here — nothing already paid for is bought
            again.
          </p>
          <ul className="space-y-px">
            {notReached.map((c) => (
              <li
                key={c.company_key}
                className="flex items-baseline justify-between gap-4 py-2.5 border-b border-white/[0.04]"
              >
                <span className="text-[13.5px] text-[#C9D1D9] truncate">{c.company_name}</span>
                <span className="text-[12px] text-[#6e7681] shrink-0 truncate max-w-[45%]">
                  {c.strongest_signal ?? 'Not checked yet'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : tab === 'rejected' ? (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          <p className="text-[13px] text-[#8b949e] leading-relaxed mb-4 max-w-xl">
            The run checked these {ruledOut.length} companies against what you asked
            for and they did not match. Nothing was bought for them beyond the
            search that found them.
          </p>
          <ul className="space-y-px">
            {ruledOut.map((c) => (
              <li
                key={c.company_key}
                className="flex items-baseline justify-between gap-4 py-2.5 border-b border-white/[0.04]"
              >
                <span className="text-[13.5px] text-[#C9D1D9] truncate">
                  {c.company_name}
                  {companySizeText(readCompanySizeFacts(c as unknown as Record<string, unknown>)) && (
                    <span className="text-[11.5px] text-[#6e7681] ml-2 tabular-nums">
                      {companySizeText(readCompanySizeFacts(c as unknown as Record<string, unknown>))}
                    </span>
                  )}
                </span>
                {/* WHY, not just THAT. A bucket with no reason is the same
                    silence in a smaller place. */}
                <span className="text-[12px] text-[#6e7681] shrink-0 truncate max-w-[55%]">
                  {bucketReasonFor(c)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : tab === 'insights' ? (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">{insightsSlot}</div>
      ) : tab === 'activity' ? (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          {activitySlot ?? (
            <p className="text-[13px] text-[#8b949e]">{LEAD_TAB_EMPTY.activity}</p>
          )}
        </div>
      ) : /* Body — the two lead tabs */
      loading && items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[12px] text-[#7D8590]">
          <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> Loading leads…
        </div>
      ) : error ? (
        <div className="m-3 text-[12px] text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-md p-2">
          {error} <button onClick={refresh} className="underline ml-2">Retry</button>
        </div>
      ) : items.length === 0 ? (
        // THIS WORKFLOW, not "some workflow". The distinction matters: the panel
        // used to show a previous chat's rows here, so an empty current run was
        // indistinguishable from a full one.
        <div className="flex-1 flex items-center justify-center text-[12px] text-[#7D8590]">
          {EMPTY_WORKBENCH_MESSAGE}
        </div>
      ) : tabRows.length === 0 ? (
        // WHAT THE BUCKET MEANS, not that it is empty. "No leads" leaves a
        // reader unable to tell a run that found nothing from a tab that does
        // not apply to their request.
        <div className="flex-1 flex items-center justify-center px-8">
          <p className="text-[13px] text-[#8b949e] text-center max-w-sm leading-relaxed">
            {LEAD_TAB_EMPTY[tab]}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        // THE TAB HAS ROWS AND THE FILTERS HID THEM ALL. Says which filters, and
        // offers the one action that helps — an empty state that only reports
        // emptiness leaves the reader hunting for what they set three tabs ago.
        <div className="flex-1 flex flex-col items-center justify-center px-8 gap-3">
          <p className="text-[13px] text-[#8b949e] text-center max-w-sm leading-relaxed">
            None of the {tabRows.length} {tab === 'qualified' ? 'qualified leads' : 'companies'} on
            this tab match {activeFilters === 1 ? 'this filter' : `these ${activeFilters} filters`}.
          </p>
          <button
            onClick={() => setFilters({ ...EMPTY_WORKBENCH_FILTERS })}
            className="px-2.5 py-1 rounded-md border border-white/[0.08] bg-white/[0.02] text-[12.5px] text-[#8b949e] hover:text-[#C9D1D9] transition-colors"
          >
            Clear filters
          </button>
        </div>
      ) : (
        // ── THE RESEARCH SPREADSHEET ─────────────────────────────────────
        //
        // Restored. The card list that stood here fixed the fourteen-column
        // scroll and removed the workspace with it: `accountViews` and
        // `outreachHints` — the per-stage unlock state this view has been
        // hydrating on every load — were being computed and passed to nothing.
        <LeadSpreadsheet
          rows={filtered}
          selected={selected}
          rowActions={rowActions}
          accountViews={accountViews}
          outreachHints={outreachHints}
          providers={{
            // Named readiness, so a cell says "setup needed" instead of
            // offering a button that cannot succeed.
            people: !!isApifyPeopleReady,
            research: !!isFirecrawlReady,
          }}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onOpen={setDrawerRow}
          onUnlock={onUnlock}
        />
      )}

      {/* ── ACTIONS, ONLY WHEN THERE IS SOMETHING TO ACT ON ────────────────
          This was a permanently-visible bar of four buttons, three of them
          disabled whenever nothing was selected — which is the state the page
          opens in. Fixed height, always present, mostly greyed out.

          It now appears on selection. `Done` moves to the header, where
          closing a panel belongs. */}
      {selectedRows.length > 0 && (tab === 'qualified' || tab === 'in_review') && (
        <div className="shrink-0 px-7 py-3 border-t border-white/[0.06] bg-[#0d1117] flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-[#8b949e] mr-1">
            {selectedRows.length} selected
          </span>
          <ActionButton
            primary
            busy={directRunning === 'find_decision_makers'}
            disabled={directRunning !== null}
            onClick={() => runDirectLeadAction('find_decision_makers')}
            label="Find decision-makers"
            busyLabel={LEAD_ACTION_LOADING.find_decision_makers}
          />
          <ActionButton
            busy={directRunning === 'research_company'}
            // A missing PROVIDER is a setup problem, not a selection problem,
            // and it is the only reason a shown button may be disabled here.
            disabled={directRunning !== null || !isFirecrawlReady}
            onClick={() => runDirectLeadAction('research_company')}
            label={isFirecrawlReady ? 'Research company' : 'Research company · setup needed'}
            busyLabel={LEAD_ACTION_LOADING.research_company}
          />
          <ActionButton
            busy={directRunning === 'generate_outreach'}
            disabled={directRunning !== null}
            onClick={() => runDirectLeadAction('generate_outreach')}
            label="Draft outreach"
            // Stated where it applies, not in a footer under every screen.
            title="Drafts always need your approval — nothing is sent automatically"
            busyLabel={LEAD_ACTION_LOADING.generate_outreach}
          />
          {/* Selection-scoped export. `rowsForExport` still encodes the old
              intent — selection if there is one, otherwise the visible rows —
              and this bar only renders WITH a selection, so it is the selection
              every time. The business columns, matching the Export menu. */}
          <ActionButton
            onClick={() => downloadCsv(
              exportFilename('current_view', meta.plan_id),
              workbenchRowsToCsv(rowsForExport(selectedRows, filtered) as ExportableLead[]),
            )}
            label={`Export CSV (${selectedRows.length})`}
          />
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-[13px] text-[#8b949e] hover:text-[#C9D1D9] transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* ── EVERYTHING TRUE BUT NOT THE POINT ──────────────────────────────
          The stage counts, the grading breakdown and the reviewed-but-not-
          selected companies. All three used to render above the table (and the
          last of them at `max-h-[45%]` below it), which is what left the leads
          roughly 180px of an 800px panel. */}
      <RunDetails
        summary={summary}
        portfolio={portfolio}
        progress={progress}
        evaluationRows={evaluationRows}
      />

      {/* The standing footer note is gone. "N of M shown" moved into the filter
          row, where it is a caption for the control that changes it; the
          approval promise moved onto the Draft outreach action, where it is
          read at the moment it applies rather than sitting under every screen
          forever. */}

      <LeadDetailDrawer row={drawerRow ? (items.find((r) => r.id === drawerRow.id) ?? drawerRow) : null} onClose={() => setDrawerRow(null)} />

      {confirmAction && (
        <ConfirmDialog
          action={confirmAction.action}
          rows={confirmAction.ids.length}
          credits={confirmAction.credits}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirmAndDispatch}
        />
      )}
    </div>
  );
}

/** One shape for every action button, so the bar cannot drift row to row. */
function ActionButton({ label, busyLabel, onClick, disabled, busy, primary, title }: {
  label: string; busyLabel?: string; onClick: () => void;
  disabled?: boolean; busy?: boolean; primary?: boolean;
  /**
   * Native tooltip. The "Draft outreach" caller already passed one — the
   * approval notice stated where it applies rather than in a footer — but the
   * prop was never declared or forwarded, so it was silently dropped.
   */
  title?: string;
}) {
  const off = disabled || busy;
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={off}
      className={`ag-btn h-9 px-3.5 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 ${
        off
          ? 'ag-btn-secondary text-[#6e7681] opacity-60 cursor-not-allowed'
          : primary
          ? 'ag-btn-primary'
          : 'ag-btn-secondary'
      }`}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {busy ? (busyLabel ?? 'Working…') : label}
    </button>
  );
}

// Lightweight global banner. Per-row status cells are the source of truth; this
// only reports the selection error or a one-line "N/M succeeded — see each row".
function LeadActionOutcomeCard({ outcome, onClose }: { outcome: { kind: LeadActionKind; success: boolean; error?: string; summary?: string }; onClose: () => void }) {
  const ok = outcome.success && !outcome.error;
  const title = outcome.kind === 'research_company' ? 'Company research'
    : outcome.kind === 'find_decision_makers' ? 'Decision-makers' : 'Outreach draft';
  return (
    <div className={`mx-4 mt-2 mb-1 rounded-lg border p-2.5 text-[12px] relative ${ok ? 'border-emerald-500/25 bg-emerald-500/[0.05] text-[#C9D1D9]' : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-200'}`}>
      <button onClick={onClose} className="absolute top-2 right-2 text-[#7D8590] hover:text-[#C9D1D9]"><X className="h-3.5 w-3.5" /></button>
      <div className="flex items-center gap-1.5 font-semibold pr-6">
        {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
        {title}
      </div>
      <div className="mt-0.5 text-[#9aa4af]">{outcome.error ?? outcome.summary}</div>
    </div>
  );
}


function getActionDescription(action: LeadResultPanelAction, rows: number): string {
  switch (action) {
    case 'find_contacts':
      return `Scout will search decision-makers for ${rows} account rows.`;
    case 'research_company':
    case 'enrich':
      return `Hawk will enrich company context for ${rows} account ${rows === 1 ? 'row' : 'rows'}.`;
    case 'draft_outreach':
      return `Penn will draft outreach sequences for ${rows} account ${rows === 1 ? 'row' : 'rows'}.`;
    case 'enrich_and_draft':
      return `Hawk and Penn will enrich and draft outreach for ${rows} account ${rows === 1 ? 'row' : 'rows'}.`;
    case 'rank':
      return `Aria will rank ${rows} account ${rows === 1 ? 'row' : 'rows'} against your ICP.`;
    default:
      return `${action.replace(/_/g, ' ')} will run for ${rows} account ${rows === 1 ? 'row' : 'rows'}.`;
  }
}

function getActionAgentTeam(action: LeadResultPanelAction): string[] {
  switch (action) {
    case 'find_contacts': return ['pilot', 'scout'];
    case 'research_company':
    case 'enrich': return ['pilot', 'hawk'];
    case 'draft_outreach': return ['pilot', 'penn'];
    case 'enrich_and_draft': return ['pilot', 'hawk', 'penn'];
    case 'rank': return ['pilot', 'aria'];
    default: return ['pilot'];
  }
}

function getActionLabel(action: LeadResultPanelAction): string {
  switch (action) {
    case 'find_contacts': return 'Find decision-makers';
    case 'research_company':
    case 'enrich': return 'Enrich companies';
    case 'draft_outreach': return 'Draft outreach';
    case 'enrich_and_draft': return 'Enrich & draft outreach';
    case 'rank': return 'Rank against ICP';
    default: return action.replace(/_/g, ' ');
  }
}

function getActionOutputDescription(action: LeadResultPanelAction): string {
  switch (action) {
    case 'find_contacts':
      return 'Decision-maker contacts in Workbench';
    case 'research_company':
    case 'enrich':
      return 'Company details and context in Workbench';
    case 'draft_outreach':
      return 'Outreach drafts in Awaiting You';
    case 'enrich_and_draft':
      return 'Company context in Workbench and drafts in Awaiting You';
    case 'rank':
      return 'ICP rank scores in Workbench';
    default:
      return 'Structured workspace output';
  }
}

function ConfirmDialog({ action, rows, credits, onCancel, onConfirm }: { action: LeadResultPanelAction; rows: number; credits: number; onCancel: () => void; onConfirm: () => void }) {
  const desc = getActionDescription(action, rows);
  const team = getActionAgentTeam(action);
  const label = getActionLabel(action);
  const outputDesc = getActionOutputDescription(action);
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
      <div className="absolute inset-0 bg-black/60 pointer-events-auto backdrop-blur-[2px]" onClick={onCancel} aria-hidden />
      <div className="relative pointer-events-auto w-[400px] max-w-[calc(100%-32px)] rounded-xl border border-emerald-500/25 bg-gradient-to-b from-emerald-500/[0.04] to-[#0a0d12] shadow-2xl p-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
        {/* Header */}
        <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-emerald-400/80 mb-0.5">
          Next step ready
        </div>
        <h4 className="text-[16px] font-bold text-white tracking-tight">{label}</h4>

        <div className="mt-3.5 space-y-3">
          {/* Task description */}
          <div>
            <div className="text-[11px] font-mono text-[#7D8590] uppercase tracking-wider">Task:</div>
            <p className="text-[13px] text-[#C9D1D9] mt-0.5 leading-relaxed">{desc}</p>
          </div>

          {/* Agent team */}
          <div>
            <div className="text-[11px] font-mono text-[#7D8590] uppercase tracking-wider mb-1">Agent team:</div>
            <div className="flex items-center gap-1.5 text-[12.5px] text-[#C9D1D9] font-semibold bg-white/[0.02] border border-white/[0.06] rounded-lg p-2">
              {team.map((slug, idx) => (
                <div key={slug} className="flex items-center gap-1.5">
                  <span className="text-[#C9D1D9] capitalize">{slug}</span>
                  {idx < team.length - 1 && (
                    <span className="text-neutral-600 text-[10px]">→</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Expected Output */}
          <div>
            <div className="text-[11px] font-mono text-[#7D8590] uppercase tracking-wider">Expected Output:</div>
            <p className="text-[12.5px] text-[#C9D1D9] mt-0.5 leading-relaxed">{outputDesc}</p>
          </div>

          {/* Footer */}
          <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-[12px]">
            <div className="text-[#7D8590]">
              Estimated: <span className="font-mono text-emerald-300">~{credits} credits</span>
            </div>
            <div className="flex items-center gap-1 text-[#7D8590]">
              <svg className="h-3.5 w-3.5 text-emerald-400/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
              Nothing will be sent
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={onConfirm}
              className="ag-btn ag-btn-primary rounded-lg font-medium flex items-center gap-1.5 text-[13px] px-4 py-2"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              Start
            </button>
            <button
              onClick={onCancel}
              className="text-[13px] px-3 py-2 rounded-lg text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
