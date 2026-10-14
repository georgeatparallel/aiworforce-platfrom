// THE USER'S REQUEST IS THE JOB, NOT THE INVOCATION.
//
// "Find 10 qualified AI startups in the US hiring software engineers" is one
// job. An edge invocation is a ~125s slice of it. Those are different things,
// and until now the product conflated them: a run investigated what one slice
// allowed, checkpointed the rest, and stopped — leaving the user to press
// Continue for a second slice that, across 202 tasks, nobody ever pressed and
// nothing ever triggered.
//
// This module owns the decision to take another slice AUTOMATICALLY, and every
// condition that must stop it. It is PURE: no network, no database, no clock of
// its own. `run-agent` asks it what to do and performs the dispatch, so the
// stopping rules can be exercised exhaustively without spending a penny.
//
// ── WHY A SEPARATE DECISION FROM `shouldTakeAnotherSlice` ─────────────────────
//
// That one decides whether THIS invocation has time for another slice. This one
// decides whether ANOTHER INVOCATION should exist at all. The first is bounded
// by the wall clock; the second is bounded by money, by lineage depth, and by
// whether the last slice actually achieved anything. Merging them would mean a
// run that is out of time and a run that is out of pool stop for the same
// reason, which is exactly the confusion the funnel work exists to remove.

export const AUTO_CONTINUATION_VERSION = "lead-auto-continuation-v1" as const;

/**
 * Where the running totals live on `tasks.result`.
 *
 * Beside `lead_resume_lineage_root`, and for the same reason: a continuation
 * reuses the task row, so anything the NEXT slice needs has to survive on it.
 */
export const LINEAGE_PROGRESS_KEY = "lead_lineage_progress" as const;

/**
 * How many continuations one request may spawn.
 *
 * A slice investigates ~10 companies and qualifies ~4, so ten continuations is
 * ~100 companies of investigation — the whole default discovery pool. Past that
 * the pool, not the ceiling, should be what stops the run.
 */
export const DEFAULT_MAX_CONTINUATIONS = 10;
export const MAX_CONTINUATIONS_CAP = 25;
export const MAX_CONTINUATIONS_ENV = "LEAD_MAX_AUTO_CONTINUATIONS";

/**
 * Provider cost units one REQUEST may spend across every slice.
 *
 * The per-invocation budget bounds a slice; this bounds the job. Without it,
 * "keep going until you have ten" is an unbounded instruction to spend money.
 */
export const DEFAULT_MAX_LINEAGE_COST_UNITS = 120;
export const MAX_LINEAGE_COST_UNITS_ENV = "LEAD_MAX_LINEAGE_COST_UNITS";

/**
 * How many consecutive slices may achieve nothing before the run stops.
 *
 * One barren slice is ordinary — a batch of candidates whose identities do not
 * resolve. Two in a row means the frontier is not yielding, and continuing to
 * pay for it is how an honest shortfall turns into an expensive one.
 */
export const MAX_BARREN_SLICES = 2;

export type StopReason =
  | "quota_met"
  | "frontier_exhausted"
  | "continuation_ceiling"
  | "cost_ceiling"
  /**
   * The run ran out of PER-COMPANY evidence budget, not of companies: a pending
   * candidate's only blocker is the route its evidence ceiling cannot pay for
   * (`GapSummary.budget_blocked`). A budget stop — never sealed — so a re-run
   * with more room can finish the job (Wave 3).
   */
  | "candidate_evidence_ceiling"
  | "no_progress"
  | "provider_failure"
  | "cancelled"
  /**
   * The job wanted to continue and the handoff did not happen — a refused or
   * unreachable dispatch. Its own reason because it is a fault in OUR plumbing,
   * not a finding about the candidates, and conflating it with
   * `provider_failure` blames Apify for a bug in the continuation path.
   */
  | "dispatch_failed";

/**
 * STOP REASONS THAT END THE LINEAGE, not merely this slice.
 *
 * ── WHY THIS IS A SET AND NOT `!decision.continue` ─────────────────────────
 *
 * Every reason here stops the current slice; only these three mean there is
 * nothing left to come back to.
 *
 *   quota_met           the request is satisfied
 *   frontier_exhausted  every discovered candidate has been investigated
 *   cancelled           the user ended it
 *
 * The others are deliberately absent, and the distinction is load-bearing:
 * `lead_lineages.status = 'terminal'` makes `acquire_lineage_lease` refuse
 * outright, so marking a lineage terminal is irreversible from the run's side.
 *
 *   continuation_ceiling / cost_ceiling  PROTECTIONS. They bound spend; they
 *       establish nothing about the candidates, and a deliberate re-run must
 *       still be able to continue.
 *   provider_failure                     the frontier is preserved on purpose.
 *   no_progress                          a barren streak bounds cost; the
 *       frontier may still hold candidates that a later slice could resolve.
 *   dispatch_failed                      a fault in OUR plumbing. Sealing the
 *       lineage on it would make a bug in the handoff permanently unrecoverable
 *       — which is the exact failure the sweeper exists to catch.
 */
export const LINEAGE_FINISHING_REASONS: ReadonlySet<StopReason> = new Set<StopReason>([
  "quota_met", "frontier_exhausted", "cancelled",
]);

/**
 * Does this decision end the LINEAGE, or only this generation?
 *
 * Takes the reason as a plain string because `AutoContinuationDecision.reason`
 * spans both the stop reasons and the CONTINUE reasons
 * (`quota_unmet_frontier_remains`). Membership of the set above is the whole
 * test, so a reason outside it — a continue reason included — is correctly
 * false rather than a type error at the call site.
 */
export function lineageIsFinished(
  decision: { continue: boolean; reason: string } | null | undefined,
): boolean {
  if (!decision || decision.continue) return false;
  return (LINEAGE_FINISHING_REASONS as ReadonlySet<string>).has(decision.reason);
}

export interface AutoContinuationInput {
  /** Qualified companies PERSISTED so far, across every slice of this request. */
  qualified: number;
  requestedCount: number;
  /** Candidates still `pending_investigation`. */
  frontierRemaining: number;
  /** How many continuations this request has already spawned. */
  continuationsUsed: number;
  maxContinuations: number;
  /** Provider cost units spent across the whole request. */
  costUnitsUsed: number;
  maxCostUnits: number;
  /**
   * Consecutive slices that neither qualified anybody nor investigated anybody.
   * Reset to zero by any slice that does either.
   */
  barrenSlices: number;
  /** The last slice ended on a provider failure. */
  providerFailed?: boolean;
  cancelled?: boolean;
  /**
   * IS THERE STILL DISCOVERY WORK THAT COULD WIDEN THE POOL?
   *
   * ── WHY AN EXHAUSTED FRONTIER STOPPED BEING TERMINAL ───────────────────
   *
   * `frontier_exhausted` reads "everything discovered has been investigated,
   * so a further slice has nothing to look at". That was true while discovery
   * was one-shot: the pool the first batch produced was the only pool there
   * would ever be, and once it was spent the run genuinely had no more to say.
   *
   * Discovery can now widen — the same source's next page, a `breadth` actor,
   * a `fallback` actor. So the sentence has two halves that used to be one:
   * the FRONTIER is exhausted, and the SOURCES may not be. Stopping on the
   * first while the second is false ends a mission that could still have
   * found the leads the user asked for, which is precisely the failure this
   * change exists to remove.
   *
   * Absent or false keeps the previous behaviour exactly: an exhausted
   * frontier is terminal. Only a caller that can actually replenish sets it.
   */
  discoveryRoutesRemain?: boolean;
  /**
   * Paid provider runs still in flight, from `state.pending_runs`.
   *
   * ── WHY THIS DECISION NEEDS IT ──────────────────────────────────────────
   *
   * Run 783fa163. The finalizer wrote
   * `{ status: "pending_external_run", reason: "provider_run_pending",
   * resumable: true }` for Apify run `Zs5bYFGlnua1hJWYg`, and this function —
   * which had no notion of a pending run — wrote `no_progress` for the same
   * moment: "2 consecutive slices qualified and investigated nobody". The
   * lineage stopped. The run then SUCCEEDED, in 796s, with 1,394 job rows
   * carrying exactly the evidence the mission asked for — "Senior Sales
   * Operations Manager, New Seller Recruitment" at Amazon, "Account Executive
   * (Enterprise)" at Salesforce, "Leader, Inside Sales" at Cisco — and nothing
   * will ever read them. The stage reported "no company had a relevant
   * commercial role", which was false for that pool.
   *
   * Two components describing one moment in contradictory terms is the defect.
   * The finalizer is the one that is right: a run that has been paid for and is
   * still executing has not finished telling us anything, so no FINDING about
   * the candidates can be true yet.
   */
  pendingRuns?: number;
  /**
   * Lead V2: PENDING candidates at least one of whose missing hard claims an
   * EXECUTABLE verification route can close — the canonical evidence-gap
   * router's `with_executable_route`. Verified before discovery is widened.
   * Absent or 0 keeps the previous behaviour exactly.
   */
  verificationRoutesRemain?: number;
  /**
   * THE MISSION'S HARD CAP IS SPENT (`budgetPolicy.missionBudgetState`, set
   * only when an operator cap is in force — `missionSpendCap.ts`). The detail
   * the stop reports. Absent or null keeps the previous behaviour exactly.
   *
   * Canary 4 (382de52c): nothing on the server knew the operator's $0.80 rule,
   * and the lineage dispatched four more slices past it. A spent cap ends the
   * lineage with `cost_ceiling` instead of dispatching slices whose every
   * purchase would be refused.
   */
  missionBudgetExhausted?: string | null;
  /**
   * Pending candidates held back by nothing but their per-company evidence
   * ceiling (`GapSummary.budget_blocked`). A run that would end as search
   * exhaustion with one of these ends as `candidate_evidence_ceiling` — a
   * budget stop — instead. Absent or 0 keeps the previous behaviour exactly.
   */
  candidateBudgetBlocked?: number;
}

export interface AutoContinuationDecision {
  continue: boolean;
  reason: StopReason | "quota_unmet_frontier_remains" | "awaiting_provider_run"
    | "replenishment_required" | "verification_required";
  /**
   * HOW the next slice should be started.
   *
   * `immediate` — self-dispatch now. The user asked once and is watching; a
   * slice that has work to do should get on with it.
   *
   * `deferred`  — checkpoint and let `resume-stalled-leads` pick it up on its
   *               next tick. For a run WAITING ON A PROVIDER there is nothing
   *               to do until the provider finishes, and self-dispatching turns
   *               the wait into a spin: run 8f59170d took ten four-second
   *               slices in about forty seconds and hit `continuation_ceiling`
   *               with the run still pending. The ceiling bounded it, as
   *               designed — but it bounded it by burning the entire lineage
   *               budget instead of waiting three minutes.
   *
   * Absent on a stop, where there is no next slice.
   */
  dispatch_mode?: "immediate" | "deferred";
  detail: string;
  /** What the Workbench should say while the next slice runs. */
  user_message: string | null;
}

/**
 * The continuation decisions whose next slice has work ready NOW — the reasons
 * `decideAutoContinuation` returns with `dispatch_mode: "immediate"`. The V2
 * queue reads this (through the worker) to release a productive slice with no
 * backoff; anything else, including a decision added later and not listed
 * here, keeps the queue's backoff. A test pins it to the function's own output.
 */
export const IMMEDIATE_CONTINUATION_REASONS: ReadonlySet<string> = new Set([
  "quota_unmet_frontier_remains", "replenishment_required", "verification_required",
]);

const stop = (
  reason: StopReason, detail: string,
): AutoContinuationDecision => ({ continue: false, reason, detail, user_message: null });

/**
 * A SEARCH-EXHAUSTION STOP THAT IS REALLY A BUDGET STOP. When a pending
 * candidate could still be verified but for its per-company evidence ceiling,
 * "nobody else to find" is not the reason the request is short (Wave 3).
 */
function searchExhausted(i: AutoContinuationInput, reason: "no_progress" | "frontier_exhausted", detail: string): AutoContinuationDecision {
  const blocked = Math.max(0, Math.trunc(i.candidateBudgetBlocked ?? 0));
  if (blocked > 0) {
    return stop("candidate_evidence_ceiling",
      `${blocked} pending candidate${blocked === 1 ? "" : "s"} could still be verified, but ` +
      `${blocked === 1 ? "its" : "their"} per-company evidence budget cannot pay for the remaining check; ` +
      `${i.qualified} of ${i.requestedCount} qualified`);
  }
  return stop(reason, detail);
}

/**
 * Should another slice run automatically?
 *
 * ORDER IS MEANING. Cancellation first, because a user who stopped the run must
 * not be billed for one more slice. Then the target, because reaching it is the
 * only ending that is a success. Then the pool, because an exhausted frontier is
 * an honest shortfall no amount of further spending can improve. Only then the
 * ceilings, which are protections rather than findings — a run that stops on one
 * of them has NOT established anything about the remaining candidates, and the
 * detail string says so.
 *
 * ── AND WHERE A PENDING RUN SITS IN THAT ORDER ─────────────────────────────
 *
 * Exactly on the seam the paragraph above already describes. `pendingRuns`
 * suppresses the three FINDINGS — an exhausted frontier, a provider failure, a
 * barren streak — because each of them asserts something about the candidates
 * that a still-executing paid call may be about to contradict. It does NOT
 * suppress the ceilings, because those are protections and a run that never
 * finishes must still be bounded: `continuationsUsed` is what stops an
 * indefinite wait, and it is checked below on exactly the path a pending run
 * takes. Cancellation and a met quota still outrank it — a user who stopped
 * must not be billed for another slice, and a request already satisfied does
 * not need more evidence.
 *
 * Adopting a pending run is a free `GET /actor-runs/{id}`; it re-reads work
 * already charged for and cannot buy the same call twice. So waiting spends a
 * continuation, never a credit.
 */
// ── D3: HOW LONG A PENDING RUN MAY HOLD THE LINEAGE ─────────────────────────
//
// `awaiting_provider_run` was bounded only by `continuationsUsed`: a run that
// never finished — or one no slice ever asked again (Query B d22d9ee6, chaos
// lab) — spent every continuation to the ceiling and ended the lineage
// `budget_exhausted`. A run stops HOLDING the lineage once it has been asked
// again and found still executing `PENDING_RUN_MAX_POLLS` times, or is older
// than `PENDING_RUN_MAX_WAIT_MS`. It stays in `pending_runs`: a later slice
// that asks its question still ADOPTS it — it is never bought again — but the
// lineage's findings (an exhausted frontier, a barren streak) may be stated.

/** Slices that asked a pending run again and found it still executing. */
export const PENDING_RUN_MAX_POLLS = 5;
/** Older than this, a pending run no longer holds the lineage whatever its polls. */
export const PENDING_RUN_MAX_WAIT_MS = 60 * 60_000;

export function awaitedPendingRuns(
  runs: ReadonlyArray<{ polls?: number | null; started_at?: string | null }> | null | undefined,
  nowMs: number,
): { awaited: number; overdue: number } {
  let awaited = 0;
  let overdue = 0;
  for (const r of runs ?? []) {
    const started = r.started_at ? Date.parse(r.started_at) : NaN;
    const tooOld = Number.isFinite(started) && nowMs - started > PENDING_RUN_MAX_WAIT_MS;
    if ((r.polls ?? 0) >= PENDING_RUN_MAX_POLLS || tooOld) overdue++;
    else awaited++;
  }
  return { awaited, overdue };
}

export function decideAutoContinuation(
  i: AutoContinuationInput,
): AutoContinuationDecision {
  if (i.cancelled) return stop("cancelled", "the request was cancelled");

  if (i.qualified >= i.requestedCount) {
    return stop("quota_met",
      `${i.qualified} of ${i.requestedCount} qualified — the request is met`);
  }

  const awaiting = (i.pendingRuns ?? 0) > 0;

  // ── A SPENT MISSION CAP ENDS THE LINEAGE — ONCE NOTHING PAID IS IN FLIGHT ─
  //
  // Ahead of verification and replenishment, because both are PURCHASES the
  // ledger would refuse. While a run already paid for is still executing this
  // falls through to `awaiting_provider_run`: adopting it is free (the ledger
  // commits nothing for an adoption and the credit ledger replays), and
  // abandoning it would discard results the mission has already paid for.
  if (i.missionBudgetExhausted && !awaiting) {
    return stop("cost_ceiling", i.missionBudgetExhausted);
  }

  // A PROVIDER FAILURE STOPS THE LINEAGE BEFORE ANY "KEEP GOING" BRANCH (RC16).
  // It used to be checked after the verify / replenish branches, so a slice
  // that ended on a provider failure with discovery routes still open went on
  // to `replenishment_required` and bought slices against the failing provider
  // until two came back barren (quality run 2026-10-06, probe W09). The
  // frontier is preserved, so a later run resumes where this one stopped. A
  // paid run still executing is the exception: it is adopted first.
  if (!awaiting && i.providerFailed) {
    return stop("provider_failure",
      "the last slice ended on a provider failure; the frontier is preserved");
  }

  // ── THE THREE FINDINGS, EACH UNSAYABLE WHILE A PAID RUN IS IN FLIGHT ─────
  //
  // Every one of these tells the user something about the candidates. None of
  // them can be known yet if a call we already paid for is still running.

  // AN EXHAUSTED POOL IS A REAL ANSWER — BUT ONLY ONCE NOTHING CAN WIDEN IT.
  //
  // Ordered before the ceilings deliberately: replenishment is still WORK, and
  // work is what `continuationsUsed`, `costUnitsUsed` and `barrenSlices` exist
  // to bound. So this branch decides only that the run is not FINISHED; every
  // ceiling below still gets to stop it, and a replenishing lineage is bounded
  // exactly as a normal one is.
  if (!awaiting && i.frontierRemaining <= 0) {
    // ── VERIFY BEFORE DISCOVERING (the plan, §7 / §22) ──────────────────────
    //
    // Candidates already in the pool that are PENDING on a hard claim an
    // executable route can verify are closer to a lead than any company the
    // next discovery page might find. "0 qualified" must never mean "buy
    // another job-search page" while one of them waits. The count comes from
    // the canonical evidence-gap router, and only routes with a canonical
    // executor count — a READY actor whose result cannot move the claim does
    // not. Bounded by the same ceilings as every other slice.
    const verifiable = Math.max(0, Math.trunc(i.verificationRoutesRemain ?? 0));
    // NO ZERO-PURCHASE LOOP. `verificationRoutesRemain` counts only candidates
    // that can still qualify (`canStillQualify`, the verifier phase's own rule).
    // As a backstop, verification slices that change nothing are bounded like
    // every other barren slice: after MAX_BARREN_SLICES the pool is an answer.
    if (verifiable > 0 && (i.barrenSlices ?? 0) < MAX_BARREN_SLICES &&
        i.continuationsUsed < i.maxContinuations && i.costUnitsUsed < i.maxCostUnits) {
      return {
        continue: true,
        reason: "verification_required",
        dispatch_mode: "immediate",
        detail:
          `${verifiable} pending candidate${verifiable === 1 ? "" : "s"} can be verified by a ready route; ` +
          `${i.qualified} of ${i.requestedCount} qualified — verifying before widening discovery`,
        user_message: `Still working — checking the missing facts on ${verifiable} promising ${verifiable === 1 ? "company" : "companies"} before searching for more.`,
      };
    }
    // A ROUTE THAT STAYS "OPEN" BUT WIDENS NOTHING IS NOT A ROUTE. Canary
    // f9b5ad8e: the funding feed had no further page to buy, its source state
    // still read "not exhausted", and every replenishment slice ended barren —
    // qualifying and investigating nobody — while this branch, ordered before
    // the barren check below, kept answering "widen the pool" until the
    // continuation ceiling. Consecutive barren slices end replenishment here
    // exactly as they end any other run.
    if (i.discoveryRoutesRemain && i.barrenSlices >= MAX_BARREN_SLICES) {
      return searchExhausted(i, "no_progress",
        `${i.barrenSlices} consecutive slices qualified and investigated nobody; the discovery ` +
        `routes still read as open but widened nothing — ${i.qualified} of ${i.requestedCount} qualified`);
    }
    if (!i.discoveryRoutesRemain) {
      return searchExhausted(i, "frontier_exhausted",
        `every discovered candidate has been investigated; ` +
        `${i.qualified} of ${i.requestedCount} qualified`);
    }
    // NOT AN ANSWER YET. The pool is spent and the sources are not, so the
    // honest state is "we have not finished looking", not "there is nobody
    // else". Falling through would report `quota_unmet_frontier_remains`,
    // which would be false — the frontier is empty; it is the SOURCES that
    // remain — so this says what is actually true about the next slice.
    if (i.continuationsUsed < i.maxContinuations &&
        i.costUnitsUsed < i.maxCostUnits) {
      const need = i.requestedCount - i.qualified;
      return {
        continue: true,
        reason: "replenishment_required",
        dispatch_mode: "immediate",
        detail:
          `every discovered candidate has been investigated and ` +
          `${i.qualified} of ${i.requestedCount} qualified; discovery routes ` +
          `remain, so the next slice widens the pool rather than ending the ` +
          `request ${need} short`,
        user_message:
          `Still working — I've been through every company found so far and ` +
          `need ${need} more, so I'm widening the search.`,
      };
    }
  }

  // NOTHING TWICE RUNNING IS EVIDENCE. See `MAX_BARREN_SLICES`.
  if (!awaiting && i.barrenSlices >= MAX_BARREN_SLICES) {
    return searchExhausted(i, "no_progress",
      `${i.barrenSlices} consecutive slices qualified and investigated nobody; ` +
      `${i.frontierRemaining} candidates remain unexamined`);
  }

  if (i.continuationsUsed >= i.maxContinuations) {
    return stop("continuation_ceiling",
      `${i.continuationsUsed} of ${i.maxContinuations} continuations used; ` +
      `${i.frontierRemaining} candidates remain unexamined`);
  }

  if (i.costUnitsUsed >= i.maxCostUnits) {
    return stop("cost_ceiling",
      `${i.costUnitsUsed} of ${i.maxCostUnits} provider cost units spent; ` +
      `${i.frontierRemaining} candidates remain unexamined`);
  }

  // ── THE PROTECTIONS HELD. NOW SAY WHY WE ARE CONTINUING ─────────────────
  //
  // Reached only after the ceilings, so an indefinitely pending run is bounded
  // by `continuationsUsed` like anything else.
  if (awaiting) {
    const n = i.pendingRuns ?? 0;
    return {
      continue: true,
      reason: "awaiting_provider_run",
      // WAITING IS NOT WORK. The sweeper's cadence is the backoff.
      dispatch_mode: "deferred",
      detail:
        `${n} paid provider run(s) still executing; adopting the result costs ` +
        `nothing further and no finding about the remaining ` +
        `${i.frontierRemaining} candidate(s) is established yet`,
      user_message:
        `Still working — waiting on ${n} provider search${n === 1 ? "" : "es"} ` +
        `already in progress.`,
    };
  }

  const need = i.requestedCount - i.qualified;
  return {
    continue: true,
    reason: "quota_unmet_frontier_remains",
    // There are candidates to investigate right now.
    dispatch_mode: "immediate",
    detail:
      `${i.qualified} of ${i.requestedCount} qualified, ${i.frontierRemaining} ` +
      `candidates still to investigate`,
    // WHAT THE USER SEES WHILE IT WORKS. They asked once and are waiting; the
    // Workbench must say the run is continuing rather than that it stopped.
    user_message:
      `Continuing automatically — ${i.qualified} of ${i.requestedCount} qualified, ` +
      `looking for ${need} more across ${i.frontierRemaining} remaining companies.`,
  };
}

/**
 * Did this slice achieve anything at all?
 *
 * Investigating somebody counts even when nobody qualified: the frontier moved
 * and the next slice sees a different set.
 *
 * ── AND SO DOES DECIDING SOMEBODY ────────────────────────────────────────
 *
 * This asked only about qualification and investigation, so a slice that
 * carried a dozen companies to a Brain verdict — durable, irreversible, and the
 * difference between a company that needs work and one that does not — counted
 * as having achieved nothing.
 *
 * Lineage 744644ab is what that cost. Its last three slices made new Brain
 * decisions and drained the frontier from sixteen to zero; none qualified
 * anybody and none investigated anybody new, because the companies were already
 * investigated and the verdicts were rejections. Two of them tripped the barren
 * counter, the sweeper terminated the run as `no_progress` at 1 of 5 with the
 * pool fully worked and page 3 unbought, and a job search that had already
 * SUCCEEDED was left unadopted.
 *
 * A RESTORED decision is not a new one. `brainDecidedDelta` is growth in
 * companies holding a Brain outcome, so a slice that only replays what the
 * checkpoint already knew still counts as barren — which is the case this
 * counter exists to catch.
 */
export function sliceWasBarren(
  i: {
    qualifiedDelta: number;
    investigatedDelta: number;
    /** Optional so an older caller keeps its exact previous behaviour. */
    brainDecidedDelta?: number;
    /**
     * Growth in canonical claim progress — hard checks resolved plus verifier
     * routes answered (`claimProgressCount`). Optional: absent keeps the
     * previous behaviour exactly.
     */
    claimProgressDelta?: number;
  },
): boolean {
  return i.qualifiedDelta <= 0 && i.investigatedDelta <= 0 &&
    (i.brainDecidedDelta ?? 0) <= 0 && (i.claimProgressDelta ?? 0) <= 0;
}

/**
 * HOW FAR THE POOL'S CLAIMS HAVE BEEN CARRIED — cumulative, for `foldSlice`.
 *
 * Production canary 9230df70 (2026-10-03). The run widened to page 2 as it
 * should, then spent two slices verifying the nine new companies — Atomus,
 * Pvalyou, Firecrawl, and adopting the Pvalyou runs those slices had started —
 * and both were counted BARREN. A company the verifiers carried from pending
 * to ineligible is still "decided" (`brain_decided` counts qualified + pending
 * + ineligible), a claim that went unknown → pass changes no bucket, and an
 * answered route that settles nothing changes no count. So `barren_slices`
 * reached 2 and the lineage stopped `no_progress` before page 3, with 18 pages
 * of discovery still open.
 *
 * A verifier that answered IS progress: it either resolved a hard check or
 * closed a route, and either one changes what the next slice can do — the
 * second is exactly what makes a pool unworkable and the search widen. So:
 *
 *   resolved hard checks (pass or fail) across the canonical view
 *   + verifier routes answered (`verify:` marks) across the working set
 *
 * Both only grow as work is done, and both are bounded — a route is answered
 * once per company — so a lineage that is genuinely stuck still reads barren.
 *
 * ── A COMPANY THE DISCOVERY GATE REJECTED IS NOT PROGRESS ──────────────────
 *
 * Query B d22d9ee6 (2026-10-12): every re-plan found a few more employers, all
 * outside 11–50, and each brought a resolved (failed) size check — so the
 * count grew every slice, `barren_slices` stayed 0 for six slices, and the
 * no-progress guard never fired. A screened-out lead now contributes nothing;
 * every other lead counts once for being admitted (a new admitted candidate is
 * progress before any of its claims resolve) plus its resolved checks.
 */
export function claimProgressCount(i: {
  leads: ReadonlyArray<{ bucket?: string | null; hard_check_details?: ReadonlyArray<{ result: string }> | null }>;
  /** Verifier routes answered, per company in the working set. */
  attemptedRoutesPerCompany: ReadonlyArray<number>;
}): number {
  let n = 0;
  for (const l of i.leads) {
    if (l.bucket === "screened_out") continue;
    n += 1; // admitted past discovery
    for (const h of l.hard_check_details ?? []) if (h.result === "pass" || h.result === "fail") n++;
  }
  for (const a of i.attemptedRoutesPerCompany) n += Math.max(0, Math.trunc(a));
  return n;
}

type EnvReader = (key: string) => string | undefined;

const readInt = (
  read: EnvReader, key: string, fallback: number, cap: number,
): number => {
  const raw = Number(read(key));
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(cap, Math.trunc(raw));
};

export function resolveMaxContinuations(read?: EnvReader): number {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  return readInt(get, MAX_CONTINUATIONS_ENV, DEFAULT_MAX_CONTINUATIONS, MAX_CONTINUATIONS_CAP);
}

export function resolveMaxLineageCostUnits(read?: EnvReader): number {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  return readInt(
    get, MAX_LINEAGE_COST_UNITS_ENV, DEFAULT_MAX_LINEAGE_COST_UNITS, 1_000);
}

/**
 * The running totals a request carries from slice to slice.
 *
 * Persisted on the task row so a continuation inherits them. Without this the
 * ceilings reset every slice and none of them bounds anything.
 */
/**
 * ── EVERY COUNT HERE IS ALREADY LINEAGE-CUMULATIVE ──────────────────────────
 *
 * THE DEFECT THIS SHAPE EXISTS TO END. `CapabilityExecutionState` is spread
 * from the checkpoint on every continuation (`leadCapabilityEngine.ts`, "state
 * = stateMatchesMission ? { ...opts.state } : newExecutionState"), so
 * `accumulated_cost_units` and `investigation_selected` do not reset — they are
 * running totals for the WHOLE lineage. `foldSlice` then ADDED them to running
 * totals of its own, once per slice, producing a sum of successive cumulative
 * snapshots. That is not a quantity of anything.
 *
 * Measured against the execution ledger, where one paid provider call is one
 * cost unit:
 *
 *     plan        provider calls    cost_units_used    continuations
 *     747ff464                 6                158                6
 *     a5332734                27                127                6
 *     958c86bc                29                124                5
 *     66554ea2                28                 58                3
 *     44c9c5c0                18                 27                2
 *
 * The inflation tracks the continuation count exactly. This was not a reporting
 * blemish: `a5332734` and `958c86bc` were both TERMINATED by the 120-unit
 * ceiling — "127 of 120 provider cost units spent; 78 candidates remain
 * unexamined" — after 27 and 29 real calls. The budget guard was killing runs
 * on money nobody had spent.
 *
 * So the rule for this record is now uniform and stated once: a cumulative
 * input is folded with MAX, never with addition. `max` is also self-healing —
 * if a slice ever arrives with a reset state (a mission-hash mismatch rebuilds
 * it from zero) the lineage keeps the higher figure, because the money was
 * still spent.
 *
 * `continuations_used` is the one true per-call increment and stays `+ 1`.
 */
export interface LineageProgress {
  version: typeof AUTO_CONTINUATION_VERSION;
  continuations_used: number;
  /** Cumulative paid provider work across the lineage. Governs the ceiling. */
  cost_units_used: number;
  barren_slices: number;
  /**
   * Companies this lineage has carried to a Brain outcome.
   *
   * A cumulative count, like the two beside it, so `foldSlice` can derive the
   * per-slice delta the same way. Optional on read: a lineage checkpointed
   * before this existed has none, and an absent value narrows to 0, which makes
   * the first slice after the upgrade look like it decided everything it holds
   * — generous in exactly the safe direction, since the counter only ever
   * PREVENTS a premature stop.
   */
  brain_decided?: number;
  /**
   * Canonical claim progress (`claimProgressCount`), cumulative. Optional on
   * read, like `brain_decided`: an older checkpoint narrows to 0, so the first
   * slice after the upgrade reads as progress — the safe direction.
   */
  claim_progress?: number;
  /** Highest qualified count observed. Never allowed to fall — see below. */
  qualified_high_water: number;
  /**
   * DISTINCT companies carried to a terminal investigation state.
   *
   * A COMPANY count. Derived from the working set, which is deduplicated by
   * construction and survives continuation, so a company investigated in slice
   * one is not counted again in slice four.
   *
   * Replaces `investigated_total`, which was none of those things: it summed
   * `investigation_selected`, a SPEND counter that deliberately re-counts
   * carried in-flight work ("this invocation buys those searches too"), across
   * every slice. It reported 40, 148, 360 and 406 against a pool of 100.
   */
  unique_companies_investigated: number;
  /**
   * AUTHORISATIONS, not companies — the other half of what the old field
   * conflated.
   *
   * `investigation_selected` counts every time this lineage authorised paying
   * to investigate a company, INCLUDING re-authorising work carried in flight
   * from an earlier pass. That is the right definition for a spend question and
   * the wrong one for "how many companies did we look at", so it now has its
   * own name and both questions can be answered.
   */
  investigation_authorisations: number;
  stopped_reason: StopReason | null;
  stopped_detail: string | null;
}

export function newLineageProgress(): LineageProgress {
  return {
    version: AUTO_CONTINUATION_VERSION,
    continuations_used: 0, cost_units_used: 0, barren_slices: 0,
    brain_decided: 0,
    qualified_high_water: 0,
    unique_companies_investigated: 0, investigation_authorisations: 0,
    stopped_reason: null, stopped_detail: null,
  };
}

/**
 * Fold one slice's result into the request's running totals.
 *
 * `qualified_high_water` is a MAXIMUM, not an assignment. A slice that evaluates
 * nobody reports zero qualified, and letting that overwrite the total is the
 * same defect the multi-round controller had — a barren round erasing a
 * productive one. Qualified companies are persisted; the count may not regress.
 */
export function foldSlice(
  prior: LineageProgress,
  /**
   * EVERY FIELD IS THE LINEAGE-CUMULATIVE VALUE AS THIS SLICE LEFT IT, and each
   * name says so. The old parameter was `{ qualified, investigated, costUnits }`
   * — three names that read as per-slice deltas while every caller passed a
   * cumulative total, which is precisely how the addition below became a sum of
   * snapshots. A name that lies is how the next person reintroduces this.
   */
  slice: {
    /** Distinct qualified companies in the pool. */
    qualifiedInPool: number;
    /** Distinct companies at a terminal investigation state, from the working set. */
    uniqueCompaniesInvestigatedInPool: number;
    /** Every authorisation this lineage has made, carried work included. */
    authorisationsInPool: number;
    /** Paid provider cost units accumulated across the lineage. */
    costUnitsInLineage: number;
    /**
     * Distinct companies holding a Brain outcome, from the working set.
     *
     * Cumulative like the two above. Optional: a caller that does not report it
     * gets exactly the previous behaviour.
     */
    brainDecidedInPool?: number;
    /** `claimProgressCount` over the pool as this slice left it. Optional, cumulative. */
    claimProgressInPool?: number;
    /**
     * The slice's verification was cut short by its deadline, a cancellation
     * or a lost lease (`verificationStop.ts`): work it would have done is
     * deferred, not shown to be pointless. Such a slice, if otherwise barren,
     * leaves `barren_slices` where it was — neither one closer to `no_progress`
     * nor a reset. A productive slice still resets it. Optional: absent keeps
     * the previous behaviour exactly.
     */
    deferredByStop?: boolean;
  },
): LineageProgress {
  // DELTAS ARE DERIVED HERE, from cumulative in and cumulative held. They are
  // not asked for, because a caller that has to compute one will eventually
  // compute it wrong — `sliceWasBarren` was documented as taking a delta and
  // handed a cumulative count, so no slice after the first could ever be
  // barren. Every run this year reported `barren_slices: 0`, including
  // lineages whose last four slices selected nobody at all.
  const qualifiedDelta = slice.qualifiedInPool - prior.qualified_high_water;
  const investigatedDelta =
    slice.uniqueCompaniesInvestigatedInPool - prior.unique_companies_investigated;
  // A DECISION IS PROGRESS. See `sliceWasBarren` for the run this exists for.
  // `brain_decided` is absent on a lineage checkpointed before this field, and
  // narrows to 0 — so the first slice after the upgrade reads its whole decided
  // set as new. That is generous in the safe direction: this term can only ever
  // PREVENT a stop, never cause one.
  const brainDecidedDelta = slice.brainDecidedInPool === undefined
    ? 0
    : slice.brainDecidedInPool - (prior.brain_decided ?? 0);
  // A VERIFIER THAT ANSWERED IS PROGRESS. See `claimProgressCount`.
  const claimProgressDelta = slice.claimProgressInPool === undefined
    ? 0
    : slice.claimProgressInPool - (prior.claim_progress ?? 0);
  const barren = sliceWasBarren({
    qualifiedDelta, investigatedDelta, brainDecidedDelta, claimProgressDelta,
  });
  const barrenSlices = !barren ? 0 : slice.deferredByStop ? prior.barren_slices : prior.barren_slices + 1;
  const keepHigher = (was: number, now: number) => Math.max(was, Math.max(0, now));
  return {
    ...prior,
    // The one true per-call increment.
    continuations_used: prior.continuations_used + 1,
    cost_units_used: keepHigher(prior.cost_units_used, slice.costUnitsInLineage),
    brain_decided: keepHigher(
      prior.brain_decided ?? 0, slice.brainDecidedInPool ?? 0),
    claim_progress: keepHigher(prior.claim_progress ?? 0, slice.claimProgressInPool ?? 0),
    barren_slices: barrenSlices,
    qualified_high_water: keepHigher(prior.qualified_high_water, slice.qualifiedInPool),
    unique_companies_investigated: keepHigher(
      prior.unique_companies_investigated, slice.uniqueCompaniesInvestigatedInPool),
    investigation_authorisations: keepHigher(
      prior.investigation_authorisations, slice.authorisationsInPool),
  };
}

export function readLineageProgress(raw: unknown): LineageProgress {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0;
  };
  return {
    version: AUTO_CONTINUATION_VERSION,
    continuations_used: n(o.continuations_used),
    cost_units_used: n(o.cost_units_used),
    barren_slices: n(o.barren_slices),
    // Written, declared AND read back — a field that skips the third never
    // survives a resume, which this file's neighbours have each learned once.
    brain_decided: n(o.brain_decided),
    claim_progress: n(o.claim_progress),
    qualified_high_water: n(o.qualified_high_water),
    // THE OLD FIELD IS DELIBERATELY NOT READ. A pre-split checkpoint holds
    // `investigated_total`, and its value is a sum of cumulative snapshots —
    // seeding a COMPANY count with it would pin the lineage to a meaningless
    // number for good, because `foldSlice` only ever moves these up. Starting a
    // resumed legacy lineage at zero and re-deriving from the working set is
    // strictly more correct: the working set is the thing that actually knows.
    //
    // `cost_units_used` IS still read, and a legacy value there is inflated by
    // the same defect. That errs toward stopping a resumed run early rather
    // than overspending on it, which is the right direction to be wrong in.
    unique_companies_investigated: n(o.unique_companies_investigated),
    investigation_authorisations: n(o.investigation_authorisations),
    stopped_reason: (o.stopped_reason as StopReason | null) ?? null,
    stopped_detail: typeof o.stopped_detail === "string" ? o.stopped_detail : null,
  };
}

/**
 * LEAD V2: THE CANONICAL STOP DECIDES THE TERMINAL STATUS.
 *
 * The legacy quota controller writes its own status from its own ROUND COUNT
 * and its own CONTACT quota. Neither ever saw the Workbench's answer:
 *
 *   - `continuation_required` after the canonical decision stopped would mark
 *     the task resumable and the V2 queue would claim it again ("Workbench says
 *     done, worker keeps buying");
 *   - `round_limit_reached` after `quota_met` (canary 9b1b70a2) made a mission
 *     that delivered 1 of 1 read `partial` on the plan and the task.
 *
 * So on V2 the stop reason decides. The legacy status survives only when it
 * records something the canonical decision cannot see: a request the platform
 * refused (`invalid_request`) or a paid round that could not be folded into
 * source state (`source_transition_failed`). A provider failure the mission
 * recovered from is not a failed mission when the request was met.
 */
const LEGACY_FAILURES_KEPT: ReadonlySet<string> = new Set(["invalid_request", "source_transition_failed"]);

export function settleV2Terminal<T extends string>(
  stopReason: string, legacyStatus: T,
): T | "completed" | "search_exhausted" | "budget_exhausted" | "provider_failure" {
  if (LEGACY_FAILURES_KEPT.has(legacyStatus)) return legacyStatus;
  switch (stopReason) {
    case "quota_met": return "completed";
    case "frontier_exhausted":
    case "no_progress": return "search_exhausted";
    case "continuation_ceiling":
    case "cost_ceiling":
    case "candidate_evidence_ceiling": return "budget_exhausted";
    case "provider_failure": return "provider_failure";
    // `cancelled` and anything unforeseen: the cancellation path reconciles
    // the records itself, and an unknown reason is not guessed at.
    default: return legacyStatus;
  }
}

/**
 * LEAD V2: ONE OUTCOME FOR EVERY TERMINAL SURFACE.
 *
 * The task status, the plan status, `company_first.quota` (read by the
 * browser's `taskQuotaUnmet`) and the completion message all used to be fed
 * the legacy CONTACT quota — `eligible_leads: 0` for a mission whose
 * deliverable is the qualified company and which had delivered it. When the
 * company is the deliverable, the canonical qualified count IS the quota.
 * A mission that asked for contact-ready leads keeps the contact quota.
 */
export interface V2Outcome {
  terminal: string;
  quota: { contactReady: number; requested: number };
  /** What the deliverable is counted in, for the words the user reads. */
  deliverable: "company" | "contact";
  delivered: number;
  requested: number;
}

export function settleV2Outcome(i: {
  continuing: boolean;
  stopReason: string;
  legacyStatus: string;
  legacyQuota: { eligible_leads: number; requested_leads: number };
  canonicalQualified: number;
  requestedCount: number;
  companyIsDeliverable: boolean;
}): V2Outcome {
  const terminal = i.continuing ? "continuation_required" : settleV2Terminal(i.stopReason, i.legacyStatus);
  if (i.companyIsDeliverable) {
    const requested = i.requestedCount;
    return {
      terminal, deliverable: "company", delivered: i.canonicalQualified, requested,
      quota: { contactReady: i.canonicalQualified, requested },
    };
  }
  return {
    terminal, deliverable: "contact", delivered: i.legacyQuota.eligible_leads, requested: i.legacyQuota.requested_leads,
    quota: { contactReady: i.legacyQuota.eligible_leads, requested: i.legacyQuota.requested_leads },
  };
}
