// LEAD V2 P2 — ABSOLUTE CEILINGS, AND ESTIMATE → RESERVE → EXECUTE → SETTLE.
//
// Before P2 a provider call's cost was learned after the fact, priced once from
// the run document before Apify settled its per-result charges. Run 1e52d43c's
// ledger recorded $0.2463 against $0.5902 billed; fd27bfac recorded $0.0711
// against $0.2711. No ceiling could stop a call it could not see coming.
//
// Now every call is ESTIMATED from its spec (the exact input it will send),
// RESERVED against absolute call / candidate / route / mission ceilings before
// the network call, marked EXECUTED with a provisional cost, and SETTLED from
// the provider's receipt when it is available. A call that would breach any
// ceiling is `refused_budget` and never runs. Unused budget stays unused — no
// percentage split (plan, "Cost and Idempotency").
//
// Pure. The ledger is plain data carried in the execution state and checkpoint.

export const BUDGET_POLICY_VERSION = "budget-policy-v1" as const;

export type CallPurpose =
  | "discovery" | "identity" | "enrichment" | "hiring_evidence" | "funding_evidence"
  | "news_evidence" | "team_composition" | "technology_evidence" | "people"
  /** A page read for required evidence (Firecrawl `/scrape`). */
  | "web_evidence";

export interface Ceilings {
  mission_provider_usd: number;
  mission_model_usd: number;
  per_route_usd: Record<string, number>;
  per_call_usd: Partial<Record<CallPurpose, number>>;
  per_candidate_evidence_usd: number;
  adaptive_reserve_usd: number;
  /**
   * The most PAID PROVIDER CALLS this mission may reserve — its credit ceiling
   * (`CREDITS_PER_PROVIDER_CALL` is one credit per call). Absent / null: no
   * per-mission credit ceiling, which is every ordinary mission. Set only by an
   * operator's mission cap (`missionSpendCap.ts`), and only ever lowered.
   */
  mission_credits?: number | null;
}

/** Plan defaults. Canary missions use `canaryCeilings`. */
export const DEFAULT_CEILINGS: Readonly<Ceilings> = Object.freeze({
  mission_provider_usd: 2.00,
  mission_model_usd: 0.40,
  per_route_usd: { company_profile: 0.40, hiring: 0.50, funding: 0.90 },
  per_call_usd: {
    identity: 0.03,
    enrichment: 0.05,
    hiring_evidence: 0.05,
    news_evidence: 0.05,
    funding_evidence: 0.05,
    team_composition: 0.03,
    technology_evidence: 0.05,
    people: 0.10,
    web_evidence: 0.01,
  },
  per_candidate_evidence_usd: 0.06,
  adaptive_reserve_usd: 0.30,
});

export function canaryCeilings(base: Ceilings = DEFAULT_CEILINGS): Ceilings {
  return { ...base, mission_provider_usd: Math.min(base.mission_provider_usd, 1.50) };
}

export function resolveCeilings(over: Partial<Ceilings> | null | undefined, canary = false): Ceilings {
  const base = canary ? canaryCeilings() : { ...DEFAULT_CEILINGS };
  if (!over) return base;
  return {
    ...base, ...over,
    per_route_usd: { ...base.per_route_usd, ...(over.per_route_usd ?? {}) },
    per_call_usd: { ...base.per_call_usd, ...(over.per_call_usd ?? {}) },
  };
}

/** Purposes whose spend counts against a candidate's evidence ceiling. */
const CANDIDATE_EVIDENCE: ReadonlySet<CallPurpose> = new Set([
  "identity", "enrichment", "hiring_evidence", "funding_evidence", "news_evidence",
  "team_composition", "technology_evidence", "web_evidence",
]);

export type ReservationStatus =
  | "reserved" | "executed" | "settled" | "refused_budget" | "adopted" | "released";

/**
 * A purchase that WIDENS its companies' evidence ceiling by what it commits
 * (Wave 3). Only the funding verifier's Pvalyou recency fallback — bought
 * because Atomus, the primary source, was inconclusive — carries it.
 */
export type CandidateAllowance = "funding_fallback";

export interface SpendReservation {
  idempotency_key: string;
  provider_call_id: string;
  purpose: CallPurpose;
  route_id: string | null;
  /** Companies a call is about. Batch calls split their estimate across them. */
  candidate_keys: string[];
  estimate_usd: number;
  status: ReservationStatus;
  provisional_usd: number | null;
  settled_usd: number | null;
  settlement_source: "provider_receipt" | "derived_floor" | null;
  variance_usd: number | null;
  /** The provider's run, so the receipt can be fetched after the call returns. */
  provider_run_id?: string | null;
  /**
   * True once two consecutive receipt reads agree. Apify posts per-result
   * charges AFTER a run reports SUCCEEDED (4250f181: $0.059 read at SUCCEEDED,
   * $0.355 billed), so a first read is not final until a later read repeats it.
   */
  settlement_stable?: boolean;
  receipt_reads?: number;
  /** Which ceiling refused this reservation (`refused_budget` only). */
  refused_ceiling?: RefusalCeiling;
  /** Set on the funding fallback: its committed spend widens its companies' ceiling (`candidateAllowanceUsd`). */
  candidate_allowance?: CandidateAllowance;
}

export type RefusalCeiling = "call" | "candidate" | "route" | "mission" | "mission_credits" | "price";

/**
 * WHAT THE DATABASE SAYS THIS LINEAGE HAS ALREADY COMMITTED, read at the start
 * of a slice (`lineageSpendFloor`). The ledger travels in the checkpoint, so a
 * slice whose checkpoint write was lost — a crash after a paid call — would
 * resume with a ledger that never saw that spend. The mission ceilings add
 * whatever the floor shows the ledger missed (`missionCommitted`), so a lost
 * write can only make the run stop sooner.
 */
export interface SpendFloor {
  committed_usd: number;
  paid_calls: number;
  /** Where the figure came from, for the log. */
  source: "lead_execution_calls" | "unreadable";
  /**
   * The ledger's own totals WHEN THE FLOOR WAS APPLIED (`applySpendFloor`). The
   * floor only adds what the ledger had not seen by then — spend this slice
   * reserves afterwards is the ledger's, and is counted exactly once.
   */
  ledger_usd_at_read?: number;
  ledger_calls_at_read?: number;
}

export interface SpendLedger {
  version: typeof BUDGET_POLICY_VERSION;
  ceilings: Ceilings;
  reservations: SpendReservation[];
  /**
   * Set per slice when a mission cap is in force. It rides along in the
   * checkpoint, but is replaced by a fresh database reading every slice and
   * cleared when no cap applies.
   */
  floor?: SpendFloor | null;
}

export function newSpendLedger(ceilings: Ceilings): SpendLedger {
  return { version: BUDGET_POLICY_VERSION, ceilings, reservations: [] };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** What a reservation commits: settled, else provisional, else the estimate. */
function committed(r: SpendReservation): number {
  if (r.status === "refused_budget" || r.status === "released" || r.status === "adopted") return 0;
  return r.settled_usd ?? r.provisional_usd ?? r.estimate_usd;
}

export function spendTotals(l: SpendLedger) {
  const live = l.reservations.filter((r) => committed(r) > 0);
  const byRoute: Record<string, number> = {};
  const byCandidate: Record<string, number> = {};
  const allowanceByCandidate: Record<string, number> = {};
  for (const r of live) {
    const c = committed(r);
    if (r.route_id) byRoute[r.route_id] = round4((byRoute[r.route_id] ?? 0) + c);
    if (CANDIDATE_EVIDENCE.has(r.purpose) && r.candidate_keys.length) {
      const share = c / r.candidate_keys.length;
      for (const k of r.candidate_keys) byCandidate[k] = round4((byCandidate[k] ?? 0) + share);
      if (r.candidate_allowance) {
        for (const k of r.candidate_keys) allowanceByCandidate[k] = round4((allowanceByCandidate[k] ?? 0) + share);
      }
    }
  }
  return {
    mission_committed_usd: round4(live.reduce((n, r) => n + committed(r), 0)),
    settled_usd: round4(l.reservations.reduce((n, r) => n + (r.settled_usd ?? 0), 0)),
    provisional_usd: round4(l.reservations.reduce((n, r) => n + (r.provisional_usd ?? 0), 0)),
    by_route: byRoute,
    by_candidate: byCandidate,
    /** Committed spend on allowance-bearing purchases (the funding fallback), per company. */
    allowance_by_candidate: allowanceByCandidate,
  };
}

/**
 * THE FUNDING-FALLBACK ALLOWANCE (Wave 3): how far a company's evidence
 * ceiling widens because the Pvalyou fallback was bought for it.
 *
 * Atomus ($0.0036) + the fallback ($0.0201) + the job search ($0.049) is
 * $0.0727, over the $0.06 per-company ceiling — so a company whose funding the
 * fallback PROVED could never be checked for hiring, and stayed pending. The
 * fallback is not allowed to crowd out the company's ordinary verification.
 *
 * Read from the ledger, never priced: the committed share (settled, else
 * provisional, else the reservation's estimate — the figure `reserve` itself
 * counts) of every reservation marked `candidate_allowance` for this company.
 * A refused, released or adopted reservation commits nothing and widens
 * nothing; an idempotent re-reservation is one reservation, so a slice
 * re-entering never counts it twice. Capped at the funding per-call ceiling.
 * It widens ONLY the candidate ceiling: the call, route, mission and credit
 * ceilings are unchanged.
 *
 * Like every ceiling here, the candidate ceiling is an ADMISSION ceiling: a
 * purchase is admitted when committed spend plus its estimate fits, and a
 * provider receipt above the estimate is recorded as the truth (quality V15).
 * A company left over its ceiling that way is refused every further purchase.
 * The allowance moves with the fallback's own committed spend, so a cheaper or
 * dearer fallback settlement (up to the cap) leaves the company's headroom
 * exactly where it was when the next purchase was admitted.
 */
export function candidateAllowanceUsd(
  l: SpendLedger, companyKey: string, totals: ReturnType<typeof spendTotals> = spendTotals(l),
): number {
  const raw = totals.allowance_by_candidate[companyKey] ?? 0;
  const cap = l.ceilings.per_call_usd.funding_evidence ?? 0;
  return round4(Math.max(0, Math.min(raw, cap)));
}

export interface ReserveRequest {
  idempotency_key: string;
  provider_call_id: string;
  purpose: CallPurpose;
  /** The funding fallback: its spend widens its companies' ceiling (`candidateAllowanceUsd`). */
  candidate_allowance?: CandidateAllowance | null;
  route_id: string | null;
  /** The route's anchor kind, which selects its ceiling. */
  route_anchor?: string | null;
  candidate_keys?: readonly string[];
  estimate_usd: number;
}

export type ReserveDecision =
  | { ok: true; reservation: SpendReservation }
  | { ok: false; ceiling: RefusalCeiling; limit_usd: number;
      would_commit_usd: number; reservation: SpendReservation };

/** A reservation that is, or may still become, a charged provider call. */
const isPaidCall = (r: SpendReservation) =>
  r.status === "reserved" || r.status === "executed" || r.status === "settled";

/** Paid provider calls this ledger has committed (adopted / released / refused excluded). */
export function paidCallCount(l: SpendLedger): number {
  return l.reservations.filter(isPaidCall).length;
}

/**
 * The mission totals the MISSION ceilings are checked against: the ledger's own,
 * plus whatever this slice's database floor shows the ledger had missed.
 */
export function missionCommitted(l: SpendLedger): { usd: number; paid_calls: number } {
  const own = spendTotals(l).mission_committed_usd;
  const calls = paidCallCount(l);
  const f = l.floor;
  if (!f) return { usd: own, paid_calls: calls };
  // What the database knew and the ledger did not, at the moment of reading.
  const missedUsd = Math.max(0, f.committed_usd - (f.ledger_usd_at_read ?? 0));
  const missedCalls = Math.max(0, f.paid_calls - (f.ledger_calls_at_read ?? 0));
  return { usd: round4(own + missedUsd), paid_calls: calls + missedCalls };
}

/**
 * Attach this slice's database floor. Records the ledger's totals at this
 * instant, so only spend the ledger MISSED is added on top of it.
 */
export function applySpendFloor(l: SpendLedger, floor: SpendFloor | null): void {
  if (!floor) { l.floor = null; return; }
  // THE SAME READING, APPLIED AGAIN (a second engine round in one slice): keep
  // the baseline taken the first time. Re-baselining against a ledger that now
  // holds this slice's own purchases would subtract them from the missed spend
  // and under-count. A new reading always differs — every paid call writes a row.
  const cur = l.floor;
  if (cur && cur.source === floor.source && cur.committed_usd === floor.committed_usd &&
      cur.paid_calls === floor.paid_calls && cur.ledger_usd_at_read !== undefined) {
    return;
  }
  l.floor = {
    ...floor,
    ledger_usd_at_read: spendTotals(l).mission_committed_usd,
    ledger_calls_at_read: paidCallCount(l),
  };
}

/** The per-call ceiling for a purpose; discovery calls are bounded by their route. */
export function callCeilingFor(c: Ceilings, purpose: CallPurpose, routeAnchor?: string | null): number {
  const perCall = c.per_call_usd[purpose];
  if (perCall != null) return perCall;
  const route = routeAnchor ? c.per_route_usd[routeAnchor] : undefined;
  return route ?? c.mission_provider_usd;
}

/**
 * The `candidate` ceiling's verdict on a call: the first company whose evidence
 * spend plus its share of this call's estimate would pass
 * `per_candidate_evidence_usd`, or null when every company fits.
 *
 * `reserve` refuses with exactly this. It is exported so a caller can ask the
 * ledger's own question before buying (`claimVerifier.ledgerAffordability`):
 * same rounding, same share, same tolerance — equality fits.
 */
export function candidateCeilingRefusal(
  l: SpendLedger,
  q: Pick<ReserveRequest, "purpose" | "candidate_keys" | "estimate_usd">,
  totals: ReturnType<typeof spendTotals> = spendTotals(l),
): { company_key: string; spent_usd: number; limit_usd: number; would_commit_usd: number } | null {
  const candidates = q.candidate_keys ?? [];
  if (!CANDIDATE_EVIDENCE.has(q.purpose) || !candidates.length) return null;
  const share = round4(q.estimate_usd) / candidates.length;
  for (const k of candidates) {
    // The base ceiling, widened by this company's own funding-fallback spend.
    const limit = round4(l.ceilings.per_candidate_evidence_usd + candidateAllowanceUsd(l, k, totals));
    const spent = totals.by_candidate[k] ?? 0;
    const would = spent + share;
    if (would > limit + 1e-9) return { company_key: k, spent_usd: spent, limit_usd: limit, would_commit_usd: would };
  }
  return null;
}

/**
 * Reserve a call against every ceiling, or refuse it.
 *
 * Idempotent: a key already reserved, executed or settled is returned as-is
 * and commits nothing new.
 */
export function reserve(l: SpendLedger, q: ReserveRequest): ReserveDecision {
  const existing = l.reservations.find((r) => r.idempotency_key === q.idempotency_key &&
    r.status !== "refused_budget" && r.status !== "released");
  if (existing && typeof existing.estimate_usd === "number" && Number.isFinite(existing.estimate_usd) && existing.estimate_usd >= 0) {
    return { ok: true, reservation: existing };
  }

  const candidates = [...(q.candidate_keys ?? [])];
  const reservation: SpendReservation = {
    idempotency_key: q.idempotency_key, provider_call_id: q.provider_call_id, purpose: q.purpose,
    route_id: q.route_id, candidate_keys: candidates, estimate_usd: round4(q.estimate_usd),
    status: "reserved", provisional_usd: null, settled_usd: null, settlement_source: null, variance_usd: null,
    ...(q.candidate_allowance ? { candidate_allowance: q.candidate_allowance } : {}),
  };
  const refuse = (ceiling: RefusalCeiling, limit: number, would: number): ReserveDecision => {
    const r = { ...reservation, status: "refused_budget" as const, refused_ceiling: ceiling };
    l.reservations.push(r);
    return { ok: false, ceiling, limit_usd: limit, would_commit_usd: round4(would), reservation: r };
  };

  const est = reservation.estimate_usd;
  // Reject missing/non-finite/negative quotes before committing anything. A prior
  // reservation above still adopts its original purchase without re-buying it.
  if (existing || typeof q.estimate_usd !== "number" || !Number.isFinite(q.estimate_usd) || q.estimate_usd < 0) {
    return refuse("price", 0, est);
  }
  const callLimit = callCeilingFor(l.ceilings, q.purpose, q.route_anchor);
  if (est > callLimit + 1e-9) return refuse("call", callLimit, est);

  const totals = spendTotals(l);
  const overCandidate = candidateCeilingRefusal(l, { purpose: q.purpose, candidate_keys: candidates, estimate_usd: est }, totals);
  if (overCandidate) return refuse("candidate", overCandidate.limit_usd, overCandidate.would_commit_usd);
  if (q.route_id && q.route_anchor && l.ceilings.per_route_usd[q.route_anchor] != null) {
    const limit = l.ceilings.per_route_usd[q.route_anchor];
    const would = (totals.by_route[q.route_id] ?? 0) + est;
    if (would > limit + 1e-9) return refuse("route", limit, would);
  }
  // THE MISSION CEILINGS READ THE LEDGER PLUS ANY SPEND IT MISSED (the floor).
  // Without a floor (every ordinary mission) this is exactly the ledger total.
  const mission = missionCommitted(l);
  const wouldMission = mission.usd + est;
  if (wouldMission > l.ceilings.mission_provider_usd + 1e-9) {
    return refuse("mission", l.ceilings.mission_provider_usd, wouldMission);
  }
  // THE CREDIT CEILING: one credit per paid call. Counted on the ledger, which
  // can only OVER-count credits (a call that never started is refunded by the
  // credit ledger but still counted here), so it errs towards stopping sooner.
  const creditLimit = l.ceilings.mission_credits;
  if (creditLimit != null && mission.paid_calls + 1 > creditLimit) {
    return refuse("mission_credits", creditLimit, mission.paid_calls + 1);
  }
  // SYNCHRONOUS FROM THE CHECK TO THE PUSH. No `await` separates reading the
  // totals from committing this reservation, so concurrent callers in one
  // process are serialised by the event loop and cannot both pass a check that
  // only one of them fits under.
  l.reservations.push(reservation);
  return { ok: true, reservation };
}

/**
 * IS THIS MISSION'S BUDGET SPENT? Read by the continuation decision so a run
 * whose next purchase cannot be afforded stops with `cost_ceiling` instead of
 * dispatching slices that can only be refused.
 *
 * Spent when a MISSION-level ceiling (dollars or credits) has refused a call,
 * or when the committed total already sits at the ceiling. A call / candidate /
 * route refusal does not spend the mission: other work may still fit.
 */
export function missionBudgetState(l: SpendLedger): {
  exhausted: boolean;
  committed_usd: number;
  limit_usd: number;
  paid_calls: number;
  credit_limit: number | null;
  detail: string;
} {
  const m = missionCommitted(l);
  const limit = l.ceilings.mission_provider_usd;
  const creditLimit = l.ceilings.mission_credits ?? null;
  const refusal = [...l.reservations].reverse().find((r) =>
    r.status === "refused_budget" &&
    (r.refused_ceiling === "mission" || r.refused_ceiling === "mission_credits"));
  const atUsd = m.usd >= limit - 1e-9;
  const atCredits = creditLimit != null && m.paid_calls >= creditLimit;
  const exhausted = Boolean(refusal) || atUsd || atCredits;
  const detail = !exhausted
    ? `$${m.usd} of $${limit} provider spend committed`
    : refusal
    ? `the mission ${refusal.refused_ceiling === "mission_credits" ? `credit ceiling (${creditLimit} paid calls)` : `provider ceiling ($${limit})`} ` +
      `refused the next paid call ($${refusal.estimate_usd} estimated); $${m.usd} committed over ${m.paid_calls} paid call(s)`
    : atCredits
    ? `${m.paid_calls} of ${creditLimit} paid calls committed — the mission credit ceiling is reached`
    : `$${m.usd} of $${limit} provider spend committed — the mission ceiling is reached`;
  return { exhausted, committed_usd: m.usd, limit_usd: limit, paid_calls: m.paid_calls, credit_limit: creditLimit, detail };
}

function find(l: SpendLedger, key: string): SpendReservation | undefined {
  // Latest non-refused entry for the key.
  for (let i = l.reservations.length - 1; i >= 0; i--) {
    const r = l.reservations[i];
    if (r.idempotency_key === key && r.status !== "refused_budget") return r;
  }
  return undefined;
}

/** The call ran. `provisional_usd` is the derived floor until a receipt settles it. */
export function markExecuted(l: SpendLedger, key: string, provisional_usd: number): SpendReservation | null {
  const r = find(l, key);
  if (!r) return null;
  r.status = "executed";
  r.provisional_usd = round4(provisional_usd);
  r.settlement_source = "derived_floor";
  return r;
}

/** Name the provider run that executed a reservation. */
export function attachProviderRun(l: SpendLedger, key: string, runId: string | null | undefined): SpendReservation | null {
  const r = find(l, key);
  if (!r || !runId) return r ?? null;
  r.provider_run_id = runId;
  return r;
}

/** An existing paid run was re-read, not bought: it commits nothing. */
export function markAdopted(l: SpendLedger, key: string): SpendReservation | null {
  const r = find(l, key);
  if (!r) return null;
  r.status = "adopted";
  return r;
}

/** The call never started (deadline, adoption decided late, compile failure). */
export function release(l: SpendLedger, key: string): SpendReservation | null {
  const r = find(l, key);
  if (!r || r.status !== "reserved") return r ?? null;
  r.status = "released";
  return r;
}

/**
 * Settle a call whose provider returns NO receipt, by its published pricing
 * contract (Firecrawl: credits per endpoint × the configured account rate).
 *
 * Final at once — there is no later receipt to wait for — and labelled
 * `derived_floor`, never `provider_receipt`: the figure is derived from what
 * came back under the published rule, not reported by the provider. Canary
 * 3be88a89's Firecrawl map stayed `executed` at its estimate forever because
 * the only settlement pass waits for an Apify run receipt it can never get.
 */
export function settleByPublishedRule(l: SpendLedger, key: string, usd: number): SpendReservation | null {
  const r = find(l, key);
  if (!r || (r.status !== "executed" && r.status !== "reserved")) return r ?? null;
  const settled = round4(usd);
  r.provisional_usd = r.provisional_usd ?? settled;
  r.settled_usd = settled;
  r.settlement_source = "derived_floor";
  r.variance_usd = round4(settled - r.estimate_usd);
  r.settlement_stable = true;
  r.status = "settled";
  return r;
}

/** Settle from the provider's receipt. The receipt is the truth. */
export function settle(
  l: SpendLedger, key: string, receipt_usd: number, mayBeFinal = true,
): SpendReservation | null {
  const r = find(l, key);
  if (!r) return null;
  const usd = round4(receipt_usd);
  // A repeat read that agrees with the last settlement makes it final.
  r.settlement_stable = mayBeFinal && r.status === "settled" && r.settled_usd === usd;
  r.receipt_reads = (r.receipt_reads ?? 0) + 1;
  r.settled_usd = usd;
  r.settlement_source = "provider_receipt";
  r.variance_usd = round4(usd - (r.provisional_usd ?? r.estimate_usd));
  r.status = "settled";
  return r;
}

// ── ESTIMATES ────────────────────────────────────────────────────────────────

export interface CostModelLike {
  start_usd?: number | null;
  per_result_usd?: number | null;
  events_usd?: Record<string, number> | null;
}

/** The rows a spec can bill for — the published multipliers included. */
export function billableRows(actorKey: string, input: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const len = (v: unknown) => (Array.isArray(v) ? v.length : v ? 1 : 0);
  switch (actorKey) {
    case "apify_linkedin_company_details":
      return len(input.companies) + len(input.searches);
    // One charge per company delivered (atomus: not-found is free).
    case "apify_funding_atomus":
    case "apify_funding_pvalyou":
      return len(input.companies);
    case "apify_linkedin_job_search":
      // "maxItems PER jobTitle PER location"
      return n(input.maxItems) * Math.max(1, len(input.jobTitles)) * Math.max(1, len(input.locations));
    case "apify_google_news":
      return n(input.maxArticles) * Math.max(1, len(input.keywords) + len(input.topics));
    case "apify_yc_companies_solidcode":
      return n(input.maxResults);
    default:
      return n(input.maxItems) || n(input.maxResults);
  }
}

/** Per-row price for the mode the input selects (e.g. full vs short company rows). */
export function perRowUsd(actorKey: string, model: CostModelLike, input: Record<string, unknown>): number {
  const ev = model.events_usd ?? {};
  const base = model.per_result_usd ?? 0;
  if (actorKey === "apify_linkedin_company_search") {
    return String(input.scraperMode ?? "short") === "full"
      ? (ev["full-company"] ?? base) : (ev["short-company"] ?? base);
  }
  if (actorKey === "apify_linkedin_company_employees" || actorKey === "apify_people_search") {
    const mode = String(input.profileScraperMode ?? "");
    if (/email/i.test(mode)) return ev["full-profile-with-email"] ?? base;
    if (/full/i.test(mode)) return ev["full-profile"] ?? base;
    return ev["short-profile"] ?? base;
  }
  // The base price is the BASIC profile. A full read is billed as a different
  // event at several times that, so pricing it as basic would under-state it.
  if (actorKey === "apify_funding_pvalyou") {
    return String(input.tier ?? "basic") === "full"
      ? (ev["company_full"] ?? Number.POSITIVE_INFINITY) : (ev["company_basic"] ?? base);
  }
  return base;
}

export function estimateCallUsd(actorKey: string, model: CostModelLike, input: Record<string, unknown>): number {
  return round4((model.start_usd ?? 0) + billableRows(actorKey, input) * perRowUsd(actorKey, model, input));
}

/** The largest row count a call ceiling affords, for the spec's count clamp. */
export function affordableRows(
  actorKey: string, model: CostModelLike, input: Record<string, unknown>, ceilingUsd: number,
): number {
  const per = perRowUsd(actorKey, model, input);
  if (per <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((ceilingUsd - (model.start_usd ?? 0) + 1e-9) / per));
}

/** Derived floor for an executed call: start + rows actually returned × row price. */
export function derivedFloorUsd(
  actorKey: string, model: CostModelLike, input: Record<string, unknown>, rowsReturned: number,
): number {
  return round4((model.start_usd ?? 0) + Math.max(0, rowsReturned) * perRowUsd(actorKey, model, input));
}

// ── SETTLEMENT PASS ─────────────────────────────────────────────────────────

export interface ProviderReceipt {
  /** The provider's settled total. */
  usageTotalUsd?: number | null;
  /** Charged event counts x the run's own event prices, when the run reports them. */
  chargedUsd?: number | null;
  status?: string | null;
  /** When the run finished; charges keep posting for a while after. */
  finishedAt?: string | null;
}

/** The receipt's charge: the larger of the usage total and the priced events, never their sum. */
export function receiptUsd(r: ProviderReceipt | null | undefined): number | null {
  const vals = [r?.usageTotalUsd, r?.chargedUsd]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Settle every executed reservation whose receipt is available.
 *
 * `receiptFor` is injected (Apify `GET /actor-runs/{id}` in production, fixture
 * receipts in tests). A receipt that is missing or unsettled leaves the
 * provisional floor in place — never a guess.
 */
export async function settlementPass(
  l: SpendLedger,
  receiptFor: (r: SpendReservation) => Promise<ProviderReceipt | null>,
  opts: { resettle?: boolean; minFinishedAgeMs?: number; now?: () => number } = {},
): Promise<{ settled: number; unsettled: number }> {
  let settled = 0, unsettled = 0;
  for (const r of l.reservations) {
    const open = r.status === "executed" ||
      (opts.resettle === true && r.status === "settled" && r.settlement_stable !== true);
    if (!open) continue;
    const receipt = await receiptFor(r).catch(() => null);
    const usd = receiptUsd(receipt);
    const done = !receipt?.status || /SUCCEEDED|FAILED|ABORTED|TIMED-OUT/i.test(String(receipt.status));
    if (typeof usd === "number" && Number.isFinite(usd) && done) {
      const finished = receipt?.finishedAt ? Date.parse(receipt.finishedAt) : NaN;
      const age = Number.isFinite(finished) ? (opts.now ?? Date.now)() - finished : Infinity;
      settle(l, r.idempotency_key, usd, age >= (opts.minFinishedAgeMs ?? 0));
      settled++;
    } else {
      unsettled++;
    }
  }
  return { settled, unsettled };
}
