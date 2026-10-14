// LEAD V2 — ONE SHAPE FOR EVERY CLAIM VERIFIER.
//
// "Verification proves claims. Evidence gaps choose the next route."
//
// Before this, each proof route was its own hand-wired branch in run-agent:
// Phase C re-grounds the business model from first-party pages, and the funding
// stage had nothing at all. A verifier is now one object with one contract:
//
//   route_actor   the Claim Registry route it executes — the gap router already
//                 decides WHEN that route is the next step for a company
//   verify()      buy the evidence for the selected companies, through the
//                 mission's spend ledger, and return one canonical EvidenceItem
//                 per company (or none: PENDING is the absence of an answer)
//
// and one runner around it that owns what every verifier must get right:
//
//   - targets come ONLY from canonical gaps whose next step is THIS route —
//     never a legacy verdict, never a target criterion (§7, §22);
//   - a company a verifier has answered is marked, so the router never sends
//     it to the same route twice (`verify:<route_actor>` on the company);
//   - every paid call reserves against the ledger under a stable idempotency
//     key, so a resumed slice adopts a running provider run instead of buying
//     it again, and a refused provider is refused once per mission.
//
// Pure except for the injected `call`; no clock beyond what deps provide.

import {
  attachProviderRun, type CandidateAllowance, candidateCeilingRefusal, markExecuted, release, reserve, type CallPurpose,
  type SpendLedger,
} from "./budgetPolicy.ts";
import type { ProviderCallSpec } from "./providerCallSpec.ts";
import type { EvidenceItem } from "./candidateObservation.ts";
import type { CompanyEvidenceGraph } from "./evidenceGraph.ts";
import { canStillQualify, evidenceGapsFor, type ClaimDefinition, CLAIM_REGISTRY } from "./evidenceGapRouter.ts";
import { PRODUCTION_READINESS, type ReadinessPolicy } from "./routeReadiness.ts";
import type { TraceEventType } from "./missionTrace.ts";

export const CLAIM_VERIFIER_VERSION = "claim-verifier-v1" as const;

/** The mark a verifier leaves on a company it answered — read by the gap router. */
export const verifyOpKey = (routeActor: string): string => `verify:${routeActor}`;
export const VERIFY_OP_PREFIX = "verify:";

/** Route actors a company has already been verified through, from its operation marks. */
export function attemptedRoutes(completedOperations: readonly string[] | null | undefined): string[] {
  return (completedOperations ?? []).filter((o) => o.startsWith(VERIFY_OP_PREFIX))
    .map((o) => o.slice(VERIFY_OP_PREFIX.length));
}

/**
 * A route this company's per-company evidence budget can no longer pay for.
 *
 * Spend against a company only grows, so once the `candidate` ceiling
 * (`budgetPolicy.per_candidate_evidence_usd`) cannot cover a verifier's
 * purchase it never will this mission. Canary 7 (production 2026-10-04, task
 * 1303e533): LlamaIndex had $0.06 of evidence bought, the router still read
 * its hiring gap as `verify`, continuation asked for a verification slice
 * twice, and the ledger refused the job search both times (`budget_candidate:
 * 0.0714 > 0.06`) until two barren slices ended the run `no_progress`. The
 * mark makes the router say what the ledger will do.
 */
export const UNAFFORDABLE_OP_PREFIX = "unaffordable:";
export const unaffordableOpKey = (routeActor: string): string => `${UNAFFORDABLE_OP_PREFIX}${routeActor}`;

/** Route actors a company's evidence budget can no longer pay for, from its operation marks. */
export function unaffordableRoutes(completedOperations: readonly string[] | null | undefined): string[] {
  return (completedOperations ?? []).filter((o) => o.startsWith(UNAFFORDABLE_OP_PREFIX))
    .map((o) => o.slice(UNAFFORDABLE_OP_PREFIX.length));
}

export interface VerificationTarget {
  company_key: string;
  name: string | null;
  domain: string | null;
  linkedin_url: string | null;
  /** The hard criterion this verification answers — with its time window, when it has one. */
  criterion: { criterion_id: string; dimension: string; value: unknown; window_days?: number | null };
  /**
   * What the mission already holds about this company. A verifier reads it
   * before it buys anything — evidence discovery carried is never re-bought.
   */
  graph: CompanyEvidenceGraph;
}

export interface VerifierCall {
  actor_key: string;
  /** The claim-verifier capability this call serves (`CLAIM_VERIFIER_CAPABILITIES`). */
  capability: string;
  input: Record<string, unknown>;
  candidate_keys: string[];
  purpose: CallPurpose;
  /** A provider run already started for this exact call — adopted, never re-bought. */
  resume_run_id?: string | null;
  /** The funding fallback: its spend widens its companies' evidence ceiling (`candidateAllowanceUsd`). */
  ceiling_allowance?: CandidateAllowance;
}

export type VerifierCallOutcome =
  | { status: "ok"; rows: Record<string, unknown>[]; provider_call_id: string }
  /** The provider is still working: the run is recorded and adopted on a later slice. */
  | { status: "running"; run_id: string; provider_call_id: string }
  /** Nothing was bought: budget, readiness, or a provider that refuses this mission. */
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string }
  /**
   * NOT STARTED: the slice's deadline, a cancellation or a lost lease stopped
   * it before anything was reserved or sent (`verificationStop.ts`). Unlike a
   * refusal it says nothing about the company or the route — the claim stays
   * unanswered, and a run being adopted stays pending, for the next slice.
   */
  | { status: "deferred"; reason: string };

export interface VerifierDeps {
  call(c: VerifierCall): Promise<VerifierCallOutcome>;
  /** Actor Intelligence readiness AND not refused for this mission. */
  ready(actorKey: string): boolean;
  now(): string;
  log(event: string, meta?: Record<string, unknown>): void;
  /**
   * Non-null once the slice may start no further external operation — asked
   * before work that does not go through `call` (a page collection, a model
   * re-grounding). `call` itself answers `deferred` once stopped. Absent: never.
   */
  stop?(op?: string | null): { reason: string; detail: string } | null;
}

/** A provider run a verifier is waiting on, carried in the checkpoint. */
export interface PendingVerifierRun {
  verifier: string;
  stage: string;
  actor_key: string;
  run_id: string;
  input: Record<string, unknown>;
  candidate_keys: string[];
  started_at: string;
  /** What the verifier already knows about these companies, to finish the decision on adoption. */
  carry?: Record<string, unknown>;
  /**
   * NOT A PROVIDER RUN. Verification the slice's stop cut short after part of
   * it was bought (Atomus read, Pvalyou not yet asked): carried so the next
   * slice finishes it from what was bought instead of buying it again. Its
   * `run_id` is empty and it is never counted as a provider run in flight.
   */
  deferred?: boolean;
}

export interface VerifierFinding {
  company_key: string;
  /** The canonical item to record; null when the claim stays PENDING. */
  item: EvidenceItem | null;
  /**
   * Evidence the answer RESTS ON, recorded beside the verdict.
   *
   * The funding verifier's verdict is a `company_stage` item; the dated rounds
   * it read are a `funding` record. Recording only the verdict left those dates
   * out of the graph, so `recently_funded` — which is answered from funding
   * records — had nothing to read after the pair had already bought them.
   * Funding discovery has always recorded both; this makes the verifier do the
   * same.
   */
  supporting?: EvidenceItem[];
  /** True once the route has ANSWERED for this company, whatever the verdict. */
  answered: boolean;
  /**
   * Other route actors this answer consumed — the Pvalyou recency fallback —
   * marked as tried beside `route_actor`, so the router never sends the same
   * company back to a route that has already answered (or refused) it.
   */
  attempted_actors?: string[];
  detail: Record<string, unknown>;
}

export interface VerifierResult {
  findings: VerifierFinding[];
  /** Runs still executing, to adopt next slice. */
  pending: PendingVerifierRun[];
}

export interface ClaimVerifier {
  key: string;
  claim: string;
  /** The Claim Registry route this verifier executes. */
  route_actor: string;
  /**
   * Every registry route this verifier can execute, when it is more than one —
   * the funding verifier runs Atomus and, after it, the conditional Pvalyou
   * recency fallback. Absent = `[route_actor]`.
   */
  route_actors?: readonly string[];
  /** Companies per slice — the verifier's own bound, below every ledger ceiling. */
  max_targets: number;
  /**
   * What verifying ONE company costs, from the same canonical price its spec
   * will be compiled with (the actor card, or the Firecrawl account rate).
   * The phase orders verifiers by this, cheapest first. Null = cannot be priced
   * (e.g. Firecrawl unpriced under a USD cap): ordered last, and its spec is
   * refused anyway. Absent = the Claim Registry's static hint.
   */
  estimate_per_target_usd?: () => number | null;
  /**
   * The verifier buys ONE call per batch and asks nothing for a company unless
   * that call runs — so a company whose evidence budget cannot cover asking
   * about it alone can never be answered by it, and (the ledger checks every
   * company in a batch) would get the whole batch refused.
   * The phase leaves such a company out and marks the route `unaffordable` for
   * it. Absent: the verifier's purchases are partial or priced per route
   * (business-model pages, the funding pair), and the phase does not pre-judge.
   *
   * The price is the COMPILED call's (`call_for` → spec → `ledgerAffordability`),
   * never `estimate_per_target_usd`: the spec compiler clamps the row count to
   * the call ceiling, so the raw input can price far above what the ledger will
   * reserve. Canary 8 (c01d28d8): 12 titles priced $0.121 raw against a $0.049
   * compiled reservation, and LlamaIndex ($0.0098 spent) was refused a job
   * search the ledger would have allowed.
   */
  all_or_nothing_per_target?: boolean;
  /**
   * The exact call `verify` would send for these targets — built by the same
   * input builder — or null when it would send none. The phase compiles it to
   * price the purchase (`all_or_nothing_per_target`).
   */
  call_for?(targets: readonly VerificationTarget[]): VerifierCall | null;
  verify(targets: VerificationTarget[], deps: VerifierDeps, ctx: {
    mission_id: string | null;
    /** This verifier's runs from earlier slices, to adopt first. */
    pending: PendingVerifierRun[];
  }): Promise<VerifierResult>;
}

/** A candidate as the runner needs it: identity, graph, its hard checks, and what was tried. */
export interface VerifiableCandidate {
  company_key: string;
  name: string | null;
  domain: string | null;
  linkedin_url: string | null;
  graph: CompanyEvidenceGraph;
  eligibility: "eligible" | "ineligible" | "pending";
  hard_checks: ReadonlyArray<{ criterion_id: string; dimension: string; result: string; reason: string; value?: unknown }>;
  attempted_routes: readonly string[];
  /** Routes this company's evidence budget can no longer pay for (`unaffordableRoutes`). */
  unaffordable_routes?: readonly string[];
  /** Set when triage withheld paid verification (`missionTriage.paidVerificationBlockedBy`). */
  paid_verification_blocked?: string | null;
}

/**
 * The companies this verifier should work on now: PENDING candidates with a
 * hard gap whose next step, per the gap router, is exactly this verifier's
 * route. The most promising first — fewest hard checks still unknown — capped
 * at the verifier's own bound.
 */
/**
 * Pipeline stages that answer hard claims cheaply and before any claim
 * verifier: a claim still waiting on one is settled there first.
 */
export const CHEAP_STAGE_CAPABILITIES: ReadonlySet<string> = new Set(["company_enrichment"]);

/** The registry routes a verifier executes. */
export function verifierRouteActors(v: Pick<ClaimVerifier, "route_actor" | "route_actors">): readonly string[] {
  return v.route_actors?.length ? v.route_actors : [v.route_actor];
}

export function verificationTargets(
  verifier: Pick<ClaimVerifier, "route_actor" | "route_actors" | "max_targets">,
  candidates: readonly VerifiableCandidate[],
  criteriaValue: (criterionId: string) => unknown,
  registry: readonly ClaimDefinition[] = CLAIM_REGISTRY,
  /** The same readiness decision the router and the planner read. */
  policy: ReadinessPolicy = PRODUCTION_READINESS,
  /** The criterion's time window (days), so a verifier can tell a decisive answer from an open one. */
  criteriaWindow?: (criterionId: string) => number | null,
): VerificationTarget[] {
  const out: Array<VerificationTarget & { open: number }> = [];
  for (const c of candidates) {
    if (c.eligibility !== "pending") continue;
    // TRIAGE CALLED IT IRRELEVANT, CONFIDENTLY: no further purchase. Its verdict
    // is untouched — it stays PENDING on the evidence it has (`missionTriage`).
    if (c.paid_verification_blocked) continue;
    const gaps = evidenceGapsFor(c.hard_checks, c.graph, registry, new Set(c.attempted_routes), policy,
      new Set(c.unaffordable_routes ?? []));
    const routes = verifierRouteActors(verifier);
    const mine = gaps.find((g) => g.next === "verify" && !!g.route && routes.includes(g.route.actor));
    if (!mine) continue;
    // ── ONLY A VIABLE CANDIDATE IS WORTH ANOTHER PURCHASE ─────────────────
    //
    // A failed hard claim already made the candidate ineligible (skipped
    // above). The other two ways a purchase here is wasted:
    //
    //   a CHEAP hard claim is still open — country or declared size band, answered by
    //   the company-enrichment stage, not by a verifier. It is settled first:
    //   if it fails, this purchase bought evidence for a rejected company.
    //   Canary 6e4a93b9 bought atomus for Quark, a candidate screened out
    //   before enrichment whose country and size were never read.
    //
    //   another hard claim has NO route: the company can never become
    //   eligible, so evidence for this claim cannot change its outcome.
    //
    // Open gaps routed to a verifier (this one, or another claim verifier) do
    // not block — those are the claims this phase exists to answer.
    // THE ONE VIABILITY RULE (`canStillQualify`), shared with continuation: a
    // hard claim no executable route can close means nothing bought here can
    // make the candidate eligible.
    if (!canStillQualify(gaps)) continue;
    const cheapFirst = gaps.find((g) => g !== mine && !(g.route && routes.includes(g.route.actor)) &&
      g.considered.some((r) => CHEAP_STAGE_CAPABILITIES.has(r.capability) && !r.tried));
    if (cheapFirst) continue;
    out.push({
      company_key: c.company_key, name: c.name, domain: c.domain, linkedin_url: c.linkedin_url,
      criterion: {
        criterion_id: mine.criterion_id, dimension: mine.dimension, value: criteriaValue(mine.criterion_id),
        window_days: criteriaWindow ? criteriaWindow(mine.criterion_id) : null,
      },
      graph: c.graph,
      open: gaps.length,
    });
  }
  return out.sort((a, b) => a.open - b.open || a.company_key.localeCompare(b.company_key))
    .slice(0, Math.max(0, verifier.max_targets))
    .map(({ open: _open, ...t }) => t);
}

/** Split a list into batches of at most `size`. */
export function batches<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, size)) out.push(xs.slice(i, i + Math.max(1, size)));
  return out;
}

// ── ONE PAID CALL, THROUGH THE SPEC, THE GUARD AND THE LEDGER ───────────────
//
// A verifier's purchase is an ordinary provider call, and goes the way every
// engine call goes:
//
//   compileProviderCallSpec   readiness, live contract, max billable units,
//                             estimate against the call ceiling — refused here
//                             is refused before any reservation or network
//   reserve                   the spec's idempotency key and estimate, against
//                             the call, candidate, route and mission ceilings
//   guardedInvoker            readiness asked again at the moment of spending
//   provider                  sent `serialized_input` and nothing else, with the
//                             spec in the envelope, so the ledger row carries
//                             its `provider_call_id` and a receipt settles it
//
// Before this the verifier path reserved under a key of its own and sent the
// raw input unguarded: the spend was bounded, but the ledger row had no
// provider_call_id, no estimate and no settlement (task 3f082b22).

export interface LedgerCallDeps {
  ledger: SpendLedger;
  /** Compile the call. Pure; the spec decides readiness, units, estimate and ceiling. */
  spec(c: VerifierCall): ProviderCallSpec;
  actorIdFor(actorKey: string): string | null;
  /**
   * The GUARDED invoker (`guardedInvoker`, no plan, the mission's readiness).
   * Throws with `toolResult` on a failed or still-running run.
   */
  invoke(call: {
    actorKey: string; actorId: string; capabilityId: string; input: Record<string, unknown>; inputHash: string;
    providerCallSpec: ProviderCallSpec;
    resumeRunId?: string; onProviderRun?: (r: { run_id: string; dataset_id: string | null }) => void;
  }): Promise<Record<string, unknown>[]>;
  hash(input: Record<string, unknown>, actorKey: string): string;
  /** A deterministic refusal (opt-in gate, vendor credit, auth): refused ONCE per mission. */
  onRefused?(actorKey: string, reason: string): void;
  /**
   * The mission trace — the SAME one the engine's own calls and every
   * settlement write to.
   *
   * The ordering below (spec before reservation, reservation before network)
   * was always enforced here, and never RECORDED: a live canary (task
   * c6d4b4fe) showed enrichment's full `spec_compiled → call_reserved →
   * call_executed → call_settled` and, for the funding pair, `call_settled`
   * alone. A spend that cannot be shown to have been checked before it
   * happened is indistinguishable from one that was not. Same event names and
   * detail shapes as the engine's, so one reader serves both.
   */
  trace?(type: TraceEventType, detail: Record<string, unknown>, refs: TraceRefs): void;
}

type TraceRefs = { plan_version: number | null; provider_call_id: string | null; idempotency_key: string | null };

/** A refusal that no retry within this mission can change. */
const REFUSAL_RE =
  /disabled_by_default|actor_not_configured|actor_missing|actor_key_unknown|not configured|unauthori[sz]ed|insufficient|credit|\b429\b|rate.?limit/i;

/**
 * The `call` a verifier is given. Every call:
 *
 *   - is compiled into a ProviderCallSpec first; a spec refused for readiness
 *     or for its estimate never reserves and never reaches the network;
 *   - has ONE idempotency key — the spec's — so a call already executed is
 *     never bought again; only a RUNNING one is adopted, by its run id;
 *   - reserves the spec's estimate against the mission ledger BEFORE any
 *     network, and is refused when it would cross a ceiling;
 *   - settles the reservation to what actually happened: executed when a run
 *     started, released when nothing was bought.
 */
export function ledgerBoundCall(d: LedgerCallDeps): (c: VerifierCall) => Promise<VerifierCallOutcome> {
  return async (c) => {
    const actorId = d.actorIdFor(c.actor_key);
    if (!actorId) return { status: "refused", reason: `${c.actor_key} has no actor card` };
    const spec = d.spec(c);
    const refs: TraceRefs = {
      plan_version: spec.plan_version ?? null, provider_call_id: spec.provider_call_id ?? null,
      idempotency_key: spec.idempotency_key ?? null,
    };
    const trace = (type: TraceEventType, detail: Record<string, unknown>) =>
      d.trace?.(type, { actor: c.actor_key, ...detail }, refs);
    trace(spec.status === "intended" ? "spec_compiled" : "spec_refused", {
      capability: spec.capability, purpose: spec.purpose, route_id: spec.route_id,
      estimate_usd: spec.cost.estimate_usd, ceiling_usd: spec.cost.ceiling_usd, refusal: spec.refusal,
    });
    if (spec.status !== "intended") {
      return { status: "refused", reason: `spec_${spec.status}: ${spec.refusal?.code ?? ""} ${spec.refusal?.detail ?? ""}`.trim() };
    }
    const key = spec.idempotency_key;
    const provider_call_id = spec.provider_call_id;
    const input = spec.serialized_input as Record<string, unknown>;
    const existing = d.ledger.reservations.find((r) => r.idempotency_key === key &&
      (r.status === "executed" || r.status === "settled" || r.status === "adopted"));
    if (existing && !c.resume_run_id) {
      trace("call_idempotent_skip", { capability: spec.capability });
      return { status: "failed", reason: "already_executed: this exact call was bought earlier in the mission" };
    }
    if (existing && c.resume_run_id) trace("call_adopted", { capability: spec.capability, run_id: c.resume_run_id });
    if (!existing) {
      const decision = reserve(d.ledger, {
        idempotency_key: key, provider_call_id, purpose: spec.purpose, route_id: spec.route_id, route_anchor: "funding",
        candidate_keys: spec.candidate_keys, estimate_usd: spec.cost.estimate_usd,
        ...(c.ceiling_allowance ? { candidate_allowance: c.ceiling_allowance } : {}),
      });
      if (!decision.ok) {
        trace("call_refused_budget", {
          capability: spec.capability, ceiling: decision.ceiling, limit_usd: decision.limit_usd,
          would_commit_usd: decision.would_commit_usd,
        });
        return { status: "refused", reason: `budget_${decision.ceiling}: ${decision.would_commit_usd} > ${decision.limit_usd}` };
      }
      trace("call_reserved", { estimate_usd: spec.cost.estimate_usd });
    }
    const estimate = spec.cost.estimate_usd;
    try {
      const rows = await d.invoke({
        actorKey: c.actor_key, actorId, capabilityId: spec.capability, input,
        inputHash: d.hash(input, c.actor_key), providerCallSpec: spec,
        ...(c.resume_run_id ? { resumeRunId: c.resume_run_id } : {}),
        onProviderRun: (r) => { attachProviderRun(d.ledger, key, r.run_id); },
      });
      if (!existing) markExecuted(d.ledger, key, estimate);
      trace("call_executed", { rows: rows.length, provisional_usd: estimate });
      return { status: "ok", rows, provider_call_id };
    } catch (e) {
      const tr = ((e as { toolResult?: unknown }).toolResult ?? null) as
        { run_id?: unknown; pending?: unknown } | null;
      const runId = tr && typeof tr.run_id === "string" ? tr.run_id : null;
      const message = String((e as Error)?.message ?? e);
      if (runId && tr?.pending === true) {
        if (!existing) markExecuted(d.ledger, key, estimate);
        attachProviderRun(d.ledger, key, runId);
        trace("call_executed", { rows: 0, provisional_usd: estimate, run_id: runId, pending: true });
        return { status: "running", run_id: runId, provider_call_id };
      }
      // The guard refused before the network: readiness, at the moment of spending.
      if (!runId && (e as { name?: string })?.name === "CapabilityContainmentError") {
        if (!existing) release(d.ledger, key);
        trace("call_released", { reason: "containment", detail: message.slice(0, 160) });
        return { status: "refused", reason: message.slice(0, 160) };
      }
      if (!runId && REFUSAL_RE.test(message)) {
        if (!existing) release(d.ledger, key);
        trace("call_released", { reason: "provider_refused", detail: message.slice(0, 160) });
        d.onRefused?.(c.actor_key, message.slice(0, 160));
        return { status: "refused", reason: message.slice(0, 160) };
      }
      // A run that started is paid for, whatever it returned.
      if (runId) { if (!existing) markExecuted(d.ledger, key, estimate); }
      else if (!existing) release(d.ledger, key);
      trace("call_failed", { run_id: runId, paid: !!runId, detail: message.slice(0, 160) });
      return { status: "failed", reason: message.slice(0, 160) };
    }
  };
}

// ── CAN THE LEDGER PAY FOR IT? ASKED OF THE SAME COMPILED CALL ──────────────
//
// The affordability question the verification phase asks before a purchase
// (`all_or_nothing_per_target`) must be the question `reserve` will answer.
// So it compiles the call with the SAME `spec` compiler `ledgerBoundCall` is
// given and asks the ledger's own candidate check of `spec.cost.estimate_usd`
// — the figure `reserve` is handed. There is no second price: when the card,
// the call ceiling or the count clamp changes, both read the change.
//
// PR #22 priced the RAW input instead (12 titles × 10 rows = $0.121), while the
// spec clamps the rows to the $0.05 call ceiling and the ledger reserves $0.049
// (Canary 8, c01d28d8). Every company read as unaffordable; none was.

export type AffordabilityDecision =
  | { ok: true; estimate_usd: number }
  | { ok: false; company_key: string; spent_usd: number; estimate_usd: number; limit_usd: number; would_commit_usd: number };

/**
 * Would `reserve` accept this call at the `candidate` ceiling? Null when the
 * spec itself is refused (readiness, call ceiling): not an affordability
 * question — `ledgerBoundCall` refuses it at the spec, and nothing is marked.
 */
export function ledgerAffordability(d: Pick<LedgerCallDeps, "ledger" | "spec">):
  (c: VerifierCall) => AffordabilityDecision | null {
  return (c) => {
    const spec = d.spec(c);
    if (spec.status !== "intended") return null;
    const estimate_usd = spec.cost.estimate_usd;
    const over = candidateCeilingRefusal(d.ledger, {
      purpose: spec.purpose, candidate_keys: spec.candidate_keys, estimate_usd,
    });
    return over ? { ok: false, estimate_usd, ...over } : { ok: true, estimate_usd };
  };
}
