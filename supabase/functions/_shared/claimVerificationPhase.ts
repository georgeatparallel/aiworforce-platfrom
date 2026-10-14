// LEAD V2 — THE VERIFICATION PHASE: CANONICAL GAPS → VERIFIER → PURCHASE.
//
// One authority decides which paid verification a company receives:
//
//   evidence graph → hard claim unknown → evidence-gap router → the verifier
//   whose route the router chose → that verifier buys, through the ledger →
//   canonical claim written → graph updated → eligibility re-read
//
// Before this, the business model had a second authority: the legacy Brain's
// `computeEvidenceDebts` picked which companies got Firecrawl pages, and the
// canonical router only decided afterwards whether the pages could be re-read.
// A company the canonical claim needed but the legacy Brain thought settled
// got no pages; a company the legacy Brain wanted researched got pages whether
// or not its canonical claim was already answered. Under Lead V2 the legacy
// debt no longer runs at all; every verifier — funding, business model — is
// selected here, from the canonical gaps, and only here.
//
// ORDER AND STOPPING.
//
//   * Verifiers run cheapest route first (`cost_hint_usd`). Eligibility is
//     re-read between them, so a company one verifier FAILS is not bought for
//     by the next.
//   * The quota is checked before every verifier. Once the canonical qualified
//     count meets the request, nothing more is bought this slice — a run that
//     has its leads stops verifying; runs already paid for are still adopted.
//     Below it, a verifier is given at most twice the shortfall (the most
//     promising first), never its whole pool: one lead short buys two checks.
//   * A target (preference) never reaches here: only HARD unknown checks are
//     gaps, so a ranking-only criterion cannot trigger a purchase.
//   * A company with a paid run STILL IN FLIGHT is held from every verifier's
//     new purchases until that run is adopted. Its answer may disprove it, and
//     cheapest-first only means something if the cheap answer arrives first.
//     Canary 4a0611b0: Pvalyou outlived the call's wait, the phase moved on,
//     and both companies got a job search while their funding was still open.
//   * A company whose PER-COMPANY evidence budget cannot cover an
//     all-or-nothing verifier's call for it is left out of its batch and the
//     route is marked unaffordable for it, so the gap router — and through it
//     continuation — stops calling it verifiable. Canary 7 (1303e533): the
//     ledger refused LlamaIndex's job search on two slices running while
//     continuation kept asking for exactly that verification.
//     The call is priced by COMPILING it and asking the ledger's own candidate
//     check (`ledgerAffordability`) — the estimate `reserve` will be handed,
//     never the verifier's raw ordering estimate. Canary 8 (c01d28d8): the raw
//     $0.121 blocked LlamaIndex ($0.0098 spent) from a $0.049 job search.
//
//   * The slice's DEADLINE, a CANCELLATION and a LOST LEASE stop it too
//     (`verificationStop.ts`). Asked before every verifier and before every
//     call a verifier makes — nested, fallback or adoption alike — so nothing
//     new is reserved, sent, fetched or asked of a model once the slice must
//     stop. What is deferred stays unanswered and resumable: a verifier that
//     never started carries its in-flight runs to the next slice unchanged, and
//     a call that never started reserved nothing and marked nothing.
//
// Pure orchestration; every effect is an injected function.

import {
  verificationTargets, type AffordabilityDecision, type ClaimVerifier, type PendingVerifierRun,
  type VerifiableCandidate, type VerificationTarget, type VerifierCall, type VerifierDeps, type VerifierFinding,
} from "./claimVerifier.ts";
import { CLAIM_REGISTRY, type ClaimDefinition } from "./evidenceGapRouter.ts";
import { PRODUCTION_READINESS, type ReadinessPolicy, routeActorReady } from "./routeReadiness.ts";
import { relevantVerifierActors, type ClaimPlan } from "./claimPlan.ts";
import { NEVER_STOP, type VerificationStop, type VerificationStopGate } from "./verificationStop.ts";

export const CLAIM_VERIFICATION_PHASE_VERSION = "claim-verification-phase-v1" as const;
/** Companies verified per missing lead, at most, per verifier per slice. */
export const SHORTFALL_MARGIN = 2;

export interface VerificationPhaseInput {
  mission_id: string | null;
  /** The request: the phase stops buying once the canonical qualified count reaches it. */
  requested_count: number;
  /** Candidates as they stand NOW — re-read after every verifier. */
  candidates: () => VerifiableCandidate[];
  /** The canonical qualified count as it stands now. */
  qualified: () => number;
  criteriaValue: (criterionId: string) => unknown;
  /** The criterion's time window in days (a recency claim's), or null. */
  criteriaWindow?: (criterionId: string) => number | null;
  verifiers: readonly ClaimVerifier[];
  /** Call, clock, log. `ready` is derived here from the readiness policy. */
  deps: Omit<VerifierDeps, "ready">;
  /** Per-mission refusals (opt-in gate, credit): such an actor is not ready. */
  unavailable?: (actor: string) => boolean;
  readiness?: ReadinessPolicy;
  /** Runs earlier slices started, to adopt before anything new is bought. */
  pending: readonly PendingVerifierRun[];
  /** The engine writes a finding onto its company. */
  apply: (finding: VerifierFinding, verifier: ClaimVerifier) => boolean;
  /**
   * Would the ledger reserve this call? `ledgerAffordability` over the SAME
   * spec compiler and ledger `deps.call` uses, so the answer is the one
   * `reserve` will give. Absent or null: not judged here — the ledger still
   * refuses at purchase.
   */
  affordability?: (call: VerifierCall) => AffordabilityDecision | null;
  /** Record on the company that this verifier's route is unaffordable for it (`unaffordableOpKey`). */
  markUnaffordable?: (companyKey: string, verifier: ClaimVerifier) => void;
  /**
   * May the slice still start an external operation? The run's deadline, the
   * worker's revocation (lost lease, cancellation) — `verificationStopGate`.
   * Absent: never stops, exactly the previous behaviour.
   */
  stop?: VerificationStopGate;
  registry?: readonly ClaimDefinition[];
  /**
   * The mission's claim plan. A verifier whose route answers no HARD claim of
   * it is not run at all — a claim the user did not require buys nothing.
   */
  claim_plan?: ClaimPlan;
  log?: (event: string, meta?: Record<string, unknown>) => void;
}

export interface VerificationPhaseReport {
  version: typeof CLAIM_VERIFICATION_PHASE_VERSION;
  /** Verifiers in the order they were considered (cheapest estimate first). */
  order: string[];
  /** The per-target estimate each verifier was ordered by. */
  order_estimates?: Record<string, number | null>;
  ran: Array<{ verifier: string; targets: string[]; findings: number; recorded: number; pending: number }>;
  /** Why the phase stopped buying early, when it did. */
  stopped: "quota_met" | null;
  /**
   * The deadline, cancellation or lost lease that stopped the phase, when one
   * did. Set only when it actually withheld work: a verifier not started, or a
   * call not sent.
   */
  stopped_by?: VerificationStop | null;
  /** Verifiers the stop withheld work from — not run at all, or cut short. Their gaps stay open. */
  deferred?: string[];
  /**
   * Verification steps the stop cut short AFTER part of them was bought
   * (`PendingVerifierRun.deferred`) — no provider run behind them. Kept apart
   * from `pending`, which stays the list of provider runs in flight that
   * continuation waits on; the caller hands both back to the next slice.
   */
  deferred_steps?: PendingVerifierRun[];
  /** Companies held from a verifier's new purchases because ANOTHER verifier's paid run for them was still in flight. */
  held: string[];
  /** Verifiers the claim plan made irrelevant: no hard claim they answer. */
  irrelevant: string[];
  /** Companies left out of a verifier because their evidence budget cannot cover its compiled call. */
  unaffordable?: Array<{ verifier: string; company_key: string; spent_usd: number; estimate_usd: number; limit_usd: number }>;
  pending: PendingVerifierRun[];
  changed: number;
}

function routeOf(v: ClaimVerifier, registry: readonly ClaimDefinition[]) {
  for (const d of registry) {
    const r = d.routes.find((x) => x.actor === v.route_actor);
    if (r) return r;
  }
  return null;
}

export async function runClaimVerificationPhase(i: VerificationPhaseInput): Promise<VerificationPhaseReport> {
  const registry = i.registry ?? CLAIM_REGISTRY;
  const policy = i.readiness ?? PRODUCTION_READINESS;
  const log = i.log ?? (() => {});
  // CHEAPEST UNRESOLVED VERIFIER FIRST, by the canonical estimate each verifier
  // publishes (the price its spec will be compiled with), else the registry's
  // static hint. Re-grounding between verifiers happens through `candidates()`:
  // a company a cheaper verifier disproved is never a later verifier's target.
  const costOf = (v: ClaimVerifier): number => {
    if (v.estimate_per_target_usd) {
      const e = v.estimate_per_target_usd();
      return e == null || !Number.isFinite(e) ? Infinity : e;
    }
    return routeOf(v, registry)?.cost_hint_usd ?? Infinity;
  };
  const ordered = [...i.verifiers].sort((a, b) => costOf(a) - costOf(b));
  const unaffordable: NonNullable<VerificationPhaseReport["unaffordable"]> = [];
  const report: VerificationPhaseReport = {
    version: CLAIM_VERIFICATION_PHASE_VERSION, order: ordered.map((v) => v.key),
    order_estimates: Object.fromEntries(ordered.map((v) => [v.key, Number.isFinite(costOf(v)) ? costOf(v) : null])),
    ran: [], stopped: null, stopped_by: null, deferred: [], held: [],
    irrelevant: [], unaffordable, pending: [], changed: 0,
  };
  const gate = i.stop ?? NEVER_STOP;
  const deferred = report.deferred!;
  // CAN THIS COMPANY'S EVIDENCE BUDGET STILL PAY FOR ASKING ABOUT IT ALONE?
  // Only asked of an all-or-nothing verifier, of the call it would send for
  // this one company, compiled and checked exactly as `reserve` will. A batch
  // only lowers each company's share, so a company that fits alone fits in any
  // batch. A spec refused for readiness or its call ceiling is not judged here
  // (null): the call path refuses it, and nothing is marked.
  const affordable = (v: ClaimVerifier, t: VerificationTarget): boolean => {
    if (!v.all_or_nothing_per_target || !v.call_for || !i.affordability) return true;
    const call = v.call_for([t]);
    const d = call ? i.affordability(call) : null;
    if (!d || d.ok) return true;
    unaffordable.push({
      verifier: v.key, company_key: t.company_key, spent_usd: d.spent_usd, estimate_usd: d.estimate_usd, limit_usd: d.limit_usd,
    });
    i.markUnaffordable?.(t.company_key, v);
    return false;
  };
  // IN FLIGHT: runs earlier slices started whose verifier has not adopted them
  // yet this slice, plus every run still pending after this slice's verifiers.
  const adoptedBy = new Set<string>();
  const inFlight = (): Set<string> => new Set([
    ...i.pending.filter((r) => !adoptedBy.has(r.verifier)).flatMap((r) => r.candidate_keys),
    ...report.pending.flatMap((r) => r.candidate_keys),
  ]);
  const relevant = i.claim_plan ? relevantVerifierActors(i.claim_plan) : null;
  for (const verifier of ordered) {
    if (relevant && !relevant.has(verifier.route_actor) && !i.pending.some((r) => r.verifier === verifier.key)) {
      report.irrelevant.push(verifier.key);
      continue;
    }
    const route = routeOf(verifier, registry);
    const mine = i.pending.filter((r) => r.verifier === verifier.key);
    // ── STOPPED: NOTHING NEW STARTS, NOTHING IN FLIGHT IS LOST ─────────────
    //
    // Not even an adoption: polling a run can wait a minute and a half. Its run
    // id is carried to the next slice exactly as it arrived, which adopts it
    // with a free status read. Asked BEFORE the quota, so a verifier with runs
    // in flight carries them whatever the count says.
    const halt = gate.check();
    if (halt) {
      report.pending.push(...mine);
      // Recorded only when the stop WITHHELD something — a run to adopt, or a
      // target this verifier would have bought for — so a slice with nothing
      // left to verify is not reported as cut short. Asked without the
      // affordability check, which marks companies: a stopped phase changes none.
      const quotaOpen = Math.max(1, i.requested_count) - i.qualified() > 0;
      const hadWork = mine.length > 0 || (quotaOpen && verificationTargets(
        verifier, i.candidates(), i.criteriaValue, registry, policy, i.criteriaWindow,
      ).length > 0);
      if (hadWork) {
        report.stopped_by = halt;
        deferred.push(verifier.key);
      }
      continue;
    }
    const need = Math.max(1, i.requested_count) - i.qualified();
    if (need <= 0) report.stopped = "quota_met";
    // A DEFERRED STEP IS A PURCHASE NOT YET MADE, not a run to adopt: once the
    // request is met it is carried, never resumed.
    const resumable = need <= 0 ? mine.filter((r) => !r.deferred) : mine;
    if (resumable.length < mine.length) report.pending.push(...mine.filter((r) => !resumable.includes(r)));
    // A RUN ALREADY PAID FOR IS STILL ADOPTED; NOTHING NEW IS BOUGHT.
    // A verifier's OWN in-flight companies are excluded too (it adopts them via
    // `mine`), but only another verifier's run counts as a hold in the report.
    const held = inFlight();
    const own = new Set(mine.flatMap((r) => r.candidate_keys));
    // Unaffordable companies are dropped BEFORE the verifier's own bound, so
    // they never take a slot an affordable company could have used.
    const targets = need <= 0 ? [] : verificationTargets(
      { ...verifier, max_targets: Number.MAX_SAFE_INTEGER }, i.candidates(), i.criteriaValue, registry, policy, i.criteriaWindow,
    )
      .filter((t) => affordable(verifier, t))
      .slice(0, Math.max(0, verifier.max_targets))
      .filter((t) => {
        if (!held.has(t.company_key)) return true;
        if (!own.has(t.company_key) && !report.held.includes(t.company_key)) report.held.push(t.company_key);
        return false;
      })
      .slice(0, need * SHORTFALL_MARGIN);
    if (targets.length === 0 && resumable.length === 0) continue;
    let callsDeferred = 0;
    const deps: VerifierDeps = {
      ...i.deps,
      // EVERY CALL ASKS FIRST — the first, a fallback, a retry, an adoption.
      // A durable start (the run id is recorded before any wait), so the
      // reserve and revocation decide, not a synchronous-call estimate.
      call: (c) => {
        const s = gate.check();
        if (s) {
          callsDeferred++;
          return Promise.resolve({ status: "deferred" as const, reason: `${s.reason}: ${s.detail}` });
        }
        return i.deps.call(c);
      },
      stop: (op) => gate.check(op ?? null),
      // THE ONE READINESS AUTHORITY, for this verifier's capability.
      // THE SAME QUESTION EVERY OTHER LAYER ASKS. This used to call
      // `policy.decide` directly, which skips the provider-class contract that
      // `routeActorReady` enforces — a weaker question than the graph, the
      // router, the planner and the runtime all ask. It was weaker because the
      // authority could not model a non-Apify provider: Firecrawl has no actor
      // card, so the strict check refused a provider that is declared READY and
      // runs every day. `providerClassOf` models it now, so the exemption is
      // gone and the verifier asks what everyone else asks.
      ready: (actor) =>
        !!route && routeActorReady(actor, route.capability, policy).ready &&
        !(i.unavailable?.(actor) ?? false),
    };
    const result = await verifier.verify(targets, deps, { mission_id: i.mission_id, pending: resumable });
    adoptedBy.add(verifier.key);
    // The gate only turns once something asked it and was refused, so a stop
    // observed here withheld part of this verifier's work.
    if (gate.stopped) {
      report.stopped_by = gate.stopped;
      if (!deferred.includes(verifier.key)) deferred.push(verifier.key);
      log("verifier_cut_short", { verifier: verifier.key, reason: gate.stopped.reason, calls_deferred: callsDeferred });
    }
    let recorded = 0;
    for (const f of result.findings) {
      if (i.apply(f, verifier)) recorded++;
      report.changed++;
    }
    report.pending.push(...result.pending);
    report.ran.push({
      verifier: verifier.key, targets: targets.map((t) => t.company_key),
      findings: result.findings.length, recorded, pending: result.pending.length,
    });
    log("verifier_ran", {
      verifier: verifier.key, targets: targets.length, findings: result.findings.length,
      recorded, pending: result.pending.length,
    });
  }
  if (report.held.length > 0) log("verification_held_in_flight", { companies: report.held, pending_runs: report.pending.length });
  if (unaffordable.length > 0) log("verification_unaffordable", { companies: unaffordable });
  if (report.stopped) log("verification_stopped", { reason: report.stopped, qualified: i.qualified(), requested: i.requested_count });
  // Provider runs in flight and deferred steps travel apart (see the report).
  const carried = report.pending;
  report.pending = carried.filter((r) => !r.deferred);
  report.deferred_steps = carried.filter((r) => r.deferred);
  if (report.stopped_by) {
    log("verification_deferred", {
      reason: report.stopped_by.reason, detail: report.stopped_by.detail, verifiers: deferred,
      carried_pending_runs: report.pending.length, carried_deferred_steps: report.deferred_steps.length,
    });
  }
  return report;
}
