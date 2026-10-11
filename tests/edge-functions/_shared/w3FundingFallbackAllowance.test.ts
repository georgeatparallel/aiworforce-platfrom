// WAVE 3 — THE FUNDING FALLBACK MUST NOT CROWD A COMPANY'S OTHER CHECKS OUT OF ITS BUDGET.
//
// Atomus ($0.0036) left funding inconclusive, the verifier bought the Pvalyou
// recency fallback ($0.0201), Pvalyou PROVED the funding — and the job search
// ($0.049) was then refused at the $0.06 per-company evidence ceiling
// ($0.0237 + $0.049 = $0.0727). The company stayed pending forever, and the run
// reported `search_exhausted`. On a funding + hiring mission every company whose
// Atomus read was inconclusive was silently lost.
//
// Policy (product owner, 2026-10-07): the $0.06 default stays. A purchase marked
// as the funding fallback widens ITS companies' evidence ceiling by its own
// committed spend (settled → provisional → the reservation's estimate), capped
// at the funding per-call ceiling. Nothing else widens: call, route, mission
// and credit ceilings are untouched. Every one of them is an ADMISSION ceiling
// — checked when a purchase is reserved, against committed spend plus its
// estimate; a dearer receipt is recorded as it is and stops further purchases. And a run that ends with a candidate held
// back by nothing but its evidence ceiling ends as a BUDGET stop
// (`candidate_evidence_ceiling` → `budget_exhausted`), never as search exhaustion.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  candidateAllowanceUsd, candidateCeilingRefusal, type Ceilings, DEFAULT_CEILINGS, markExecuted, newSpendLedger, release,
  reserve, type ReserveRequest, settle, type SpendLedger, spendTotals,
} from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { type EvidenceGap, summarizeGaps } from "../../../supabase/functions/_shared/evidenceGapRouter.ts";
import {
  type AutoContinuationInput, decideAutoContinuation, settleV2Terminal,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { daysAgo, GOLDEN, li } from "../../replay/golden/scenarios.ts";
import { runGoldenMission, spendOf } from "../../replay/lib/mission.ts";
import type { FixtureProviderResponse } from "../../replay/lib/fixture.ts";
import { compileChain, funding, hiring, request } from "../../lead-v2-quality/lib/chain.ts";

// ── THE LEDGER ──────────────────────────────────────────────────────────────

const A = "https://www.linkedin.com/company/a", B = "https://www.linkedin.com/company/b";
const ledger = (over: Partial<Ceilings> = {}): SpendLedger => newSpendLedger({ ...DEFAULT_CEILINGS, ...over });
let n = 0;
const buy = (l: SpendLedger, q: Partial<ReserveRequest> & { estimate_usd: number }) => {
  const key = q.idempotency_key ?? `k${++n}`;
  const d = reserve(l, { idempotency_key: key, provider_call_id: key, purpose: "funding_evidence", route_id: null,
    candidate_keys: [A], ...q });
  if (d.ok) markExecuted(l, key, q.estimate_usd);
  return d;
};
const fallback = (l: SpendLedger, usd = 0.0201, over: Partial<ReserveRequest> = {}) =>
  buy(l, { estimate_usd: usd, candidate_allowance: "funding_fallback", ...over });
const jobSearch = (l: SpendLedger, keys = [A]) =>
  candidateCeilingRefusal(l, { purpose: "hiring_evidence", candidate_keys: keys, estimate_usd: 0.049 });

Deno.test("allowance: without a fallback the $0.06 boundary is unchanged (V06's $0.0235 + $0.049 still refused)", () => {
  const l = ledger();
  buy(l, { estimate_usd: 0.0235 });
  const over = jobSearch(l);
  assertEquals([over?.limit_usd, over?.spent_usd], [0.06, 0.0235]);
  assertEquals(candidateAllowanceUsd(l, A), 0);
});

Deno.test("allowance: the reference case — Atomus + Pvalyou fallback, then the job search fits at $0.0801", () => {
  const l = ledger();
  buy(l, { estimate_usd: 0.0036 });
  assert(fallback(l).ok, "the fallback itself is checked against the BASE ceiling");
  assertEquals(candidateAllowanceUsd(l, A), 0.0201);
  assertEquals(jobSearch(l), null, "$0.0237 + $0.049 ≤ $0.0801");
  const big = candidateCeilingRefusal(l, { purpose: "hiring_evidence", candidate_keys: [A], estimate_usd: 0.06 });
  assertEquals(big?.limit_usd, 0.0801, "the refusal reports the effective ceiling");
  // reserve and the pre-purchase check give the same answer.
  assert(reserve(l, { idempotency_key: "jobs", provider_call_id: "jobs", purpose: "hiring_evidence", route_id: null,
    candidate_keys: [A], estimate_usd: 0.049 }).ok);
});

Deno.test("allowance: follows the ledger — a cheaper settlement widens less; settled spend is what counts", () => {
  const l = ledger();
  buy(l, { estimate_usd: 0.0036 });
  fallback(l, 0.0201, { idempotency_key: "pv" });
  settle(l, "pv", 0.01);
  assertEquals(candidateAllowanceUsd(l, A), 0.01);
  assertEquals(spendTotals(l).by_candidate[A], 0.0136);
  assertEquals(jobSearch(l), null, "$0.0136 + $0.049 ≤ $0.07");
});

Deno.test("allowance: capped at the funding per-call ceiling, however much is committed", () => {
  const l = ledger();
  fallback(l, 0.03, { idempotency_key: "pv1" });
  fallback(l, 0.03, { idempotency_key: "pv2" });
  assertEquals(spendTotals(l).allowance_by_candidate[A], 0.06);
  assertEquals(candidateAllowanceUsd(l, A), DEFAULT_CEILINGS.per_call_usd.funding_evidence);
  settle(l, "pv1", 0.09);
  assertEquals(candidateAllowanceUsd(l, A), 0.05, "a receipt over the estimate still widens by at most $0.05");
});

Deno.test("allowance: a refused, released or failed fallback widens nothing", () => {
  // Reserved, then released before any run started (refused at the provider, or failed): nothing bought.
  const released = ledger();
  assert(reserve(released, { idempotency_key: "pv", provider_call_id: "pv", purpose: "funding_evidence", route_id: null,
    candidate_keys: [A], estimate_usd: 0.0201, candidate_allowance: "funding_fallback" }).ok);
  assertEquals(candidateAllowanceUsd(released, A), 0.0201, "a live reservation counts at its estimate, as reserve counts it");
  release(released, "pv");
  assertEquals(candidateAllowanceUsd(released, A), 0);
  const refused = ledger({ mission_provider_usd: 0.01 });
  assertFalse(fallback(refused).ok);
  assertEquals(candidateAllowanceUsd(refused, A), 0);
});

Deno.test("allowance: counted once — an idempotent re-reservation adds nothing", () => {
  const l = ledger();
  fallback(l, 0.0201, { idempotency_key: "pv" });
  fallback(l, 0.0201, { idempotency_key: "pv" });
  fallback(l, 0.0201, { idempotency_key: "pv" });
  assertEquals(l.reservations.filter((r) => r.idempotency_key === "pv").length, 1);
  assertEquals(candidateAllowanceUsd(l, A), 0.0201);
});

Deno.test("allowance: attributable — only the companies the fallback was bought for, by their share", () => {
  const l = ledger();
  fallback(l, 0.04, { candidate_keys: [A, B] });
  assertEquals([candidateAllowanceUsd(l, A), candidateAllowanceUsd(l, B)], [0.02, 0.02]);
  const solo = ledger();
  fallback(solo, 0.0201, { candidate_keys: [A] });
  assertEquals(candidateAllowanceUsd(solo, B), 0, "B never inherits A's allowance");
  buy(solo, { estimate_usd: 0.0235, candidate_keys: [B] });
  assertEquals(jobSearch(solo, [B])?.limit_usd, 0.06);
});

Deno.test("allowance: widens the candidate ceiling only — call, mission and credit ceilings are unchanged", () => {
  const mission = ledger({ mission_provider_usd: 0.06 });
  buy(mission, { estimate_usd: 0.0036 });
  fallback(mission);
  const d = reserve(mission, { idempotency_key: "jobs", provider_call_id: "jobs", purpose: "hiring_evidence", route_id: null,
    candidate_keys: [A], estimate_usd: 0.049 });
  assertEquals([d.ok, d.ok ? null : d.ceiling], [false, "mission"]);
  const credits = ledger({ mission_credits: 2 });
  buy(credits, { estimate_usd: 0.0036 });
  fallback(credits);
  const c = reserve(credits, { idempotency_key: "jobs", provider_call_id: "jobs", purpose: "hiring_evidence", route_id: null,
    candidate_keys: [A], estimate_usd: 0.049 });
  assertEquals([c.ok, c.ok ? null : c.ceiling], [false, "mission_credits"]);
  const call = ledger();
  fallback(call);
  const x = reserve(call, { idempotency_key: "big", provider_call_id: "big", purpose: "hiring_evidence", route_id: null,
    candidate_keys: [A], estimate_usd: 0.051 });
  assertEquals([x.ok, x.ok ? null : x.ceiling], [false, "call"]);
});

Deno.test("allowance: not hiring-specific — any later evidence purchase for the company reads the same ceiling", () => {
  const l = ledger();
  buy(l, { estimate_usd: 0.0036 });
  fallback(l);
  for (const purpose of ["web_evidence", "news_evidence", "team_composition"] as const) {
    const over = candidateCeilingRefusal(l, { purpose, candidate_keys: [A], estimate_usd: 0.06 });
    assertEquals(over?.limit_usd, 0.0801, purpose);
    assertEquals(candidateCeilingRefusal(l, { purpose, candidate_keys: [A], estimate_usd: 0.03 }), null, purpose);
  }
});

Deno.test("allowance: admission semantics — fallback settlement never invalidates an admitted purchase", () => {
  const headroomAfter = (pvSettle: number | null, jobSettle: number | null) => {
    const l = ledger();
    buy(l, { estimate_usd: 0.0036 });
    fallback(l, 0.0201, { idempotency_key: "pv" });
    assert(buy(l, { idempotency_key: "jobs", purpose: "hiring_evidence", estimate_usd: 0.049 }).ok, "admitted at $0.0801");
    if (pvSettle !== null) settle(l, "pv", pvSettle);
    if (jobSettle !== null) settle(l, "jobs", jobSettle);
    const eff = DEFAULT_CEILINGS.per_candidate_evidence_usd + candidateAllowanceUsd(l, A);
    return Math.round((eff - (spendTotals(l).by_candidate[A] ?? 0)) * 10000) / 10000;
  };
  // A cheaper or dearer fallback receipt (up to the cap) moves spend and allowance together.
  assertEquals([headroomAfter(null, null), headroomAfter(0.01, null), headroomAfter(0.03, null)], [0.0074, 0.0074, 0.0074]);
  // A receipt above an estimate is recorded as the truth — exactly as without any fallback.
  assertEquals(headroomAfter(null, 0.07), -0.0136);
  const plain = ledger();
  buy(plain, { estimate_usd: 0.0036 });
  buy(plain, { idempotency_key: "jobs", purpose: "hiring_evidence", estimate_usd: 0.049 });
  settle(plain, "jobs", 0.07);
  assertEquals(Math.round((0.06 - spendTotals(plain).by_candidate[A]) * 10000) / 10000, -0.0136, "the same overshoot, no fallback");
  assert(candidateCeilingRefusal(plain, { purpose: "web_evidence", candidate_keys: [A], estimate_usd: 0.005 }), "and it refuses what comes next");
});

// ── HONEST TERMINAL REPORTING ───────────────────────────────────────────────

const gap = (next: "verify" | "blocked", routes: Partial<EvidenceGap["considered"][number]>[]): EvidenceGap => ({
  criterion_id: "c", dimension: "hiring", claim: "open_role", missing: "?", next, route: null,
  considered: routes.map((r) => ({ actor: "apify_linkedin_job_search", capability: "hiring_verification", purpose: "hiring_evidence",
    readiness: "ready", tried: false, executable: next === "verify", why: "", cost_hint_usd: 0.049, ...r })) as EvidenceGap["considered"],
});

Deno.test("reporting: a candidate counts as budget-blocked only when its evidence ceiling is the sole blocker", () => {
  const s = summarizeGaps([
    { gaps: [gap("blocked", [{ budget_closed: true }])] },                         // budget only → counted
    { gaps: [gap("blocked", [{ tried: true }])] },                                 // tried → genuinely exhausted
    { gaps: [gap("verify", []), gap("blocked", [{ budget_closed: true }])] },      // the other gap verifiable → counted
    { gaps: [gap("blocked", [{ budget_closed: true }])], paid_verification_blocked: true }, // triage → not counted
  ]);
  assertEquals([s.blocked, s.budget_blocked], [4, 2]);
});

const decide = (over: Partial<AutoContinuationInput>) => decideAutoContinuation({
  cancelled: false, qualified: 0, requestedCount: 1, frontierRemaining: 0, continuationsUsed: 1, maxContinuations: 10,
  costUnitsUsed: 1, maxCostUnits: 40, barrenSlices: 2, providerFailed: false, discoveryRoutesRemain: false, ...over,
});

Deno.test("reporting: search exhaustion with a budget-blocked candidate is a budget stop", () => {
  for (const discoveryRoutesRemain of [false, true]) {
    const d = decide({ discoveryRoutesRemain, candidateBudgetBlocked: 1 });
    assertEquals([d.continue, d.reason], [false, "candidate_evidence_ceiling"]);
    assert(/per-company evidence budget/.test(d.detail), d.detail);
    assertEquals(settleV2Terminal(d.reason, "partial"), "budget_exhausted");
  }
  const outside = decide({ frontierRemaining: 3, candidateBudgetBlocked: 2 });
  assertEquals(outside.reason, "candidate_evidence_ceiling");
});

Deno.test("reporting: everything else is unchanged", () => {
  assertEquals(decide({}).reason, "frontier_exhausted", "no budget-blocked candidate: genuine exhaustion");
  assertEquals(decide({ discoveryRoutesRemain: true }).reason, "no_progress");
  assertEquals(decide({ candidateBudgetBlocked: 1, missionBudgetExhausted: "mission cap spent" }).reason, "cost_ceiling",
    "a spent mission cap keeps its own stop");
  assertEquals(decide({ candidateBudgetBlocked: 1, qualified: 1 }).reason, "quota_met");
  assertEquals(decide({ candidateBudgetBlocked: 1, providerFailed: true }).reason, "provider_failure", "RC16 first");
  const working = decide({ candidateBudgetBlocked: 1, verificationRoutesRemain: 1, barrenSlices: 0 });
  assertEquals([working.continue, working.reason], [true, "verification_required"]);
});

// ── END TO END: THE PRODUCTION ENGINE ON GOLDEN FIXTURES ────────────────────

const ATOMUS = "apify_funding_atomus", PVALYOU = "apify_funding_pvalyou", JOBS = "apify_linkedin_job_search";
const SEARCH = "apify_linkedin_company_search", DETAILS = "apify_linkedin_company_details";
const ACME = li("acme");
type R = FixtureProviderResponse[];
const atomus = (rs: R, rounds: Array<[string, string]>, complete: boolean): R => rs.map((r) => r.actor !== ATOMUS ? r : {
  ...r, rows: r.rows.map((row) => {
    const y = structuredClone(row) as { company: { financial: { funding: { rounds: unknown[]; num_funding_rounds: number } } } };
    y.company.financial.funding.rounds = rounds.map(([type, at]) => ({ type, announced_at: at, raised_amount: 5_000_000, investors: ["X"] }));
    y.company.financial.funding.num_funding_rounds = complete ? rounds.length : rounds.length + 2;
    return y as unknown as Record<string, unknown>;
  }),
});
const pvalyou = (rounds: Array<[string, string]>): FixtureProviderResponse => ({
  actor: PVALYOU, provenance: "pvalyou funding record", rows: [{
    query: "acme.com", status: "active", domain: "acme.com", record_as_of: new Date().toISOString(),
    record: { funding: { rounds_count: rounds.length, last_round_date: rounds[0]?.[1] ?? null, rounds: rounds.map(([t, at], i) => ({
      round_index: i + 1, round_type: t, round_title: t, round_date: at, round_date_precision: "day", round_amount_m_usd: 5,
      is_non_equity: false, source_urls: [`https://news.example/acme-${i}`], investors: [{ name: "Seedfund" }],
    })) } },
  }],
});
const MISSION = compileChain(request(
  "Find 1 US company with 11–50 employees that raised funding in the last 24 months and is currently hiring sales.", {
    count: 1,
    filters: [{ field: "geography", op: "eq", value: "United States" }, { field: "employee_count", op: "range", value: { min: 11, max: 50 } }],
    requirements: [funding("raised funding in the last 24 months", 730), hiring("currently hiring sales", ["sales"])],
  } as never), null).mission!;
async function run(name: string, edit: (rs: R) => R, extra: { missionCap?: unknown; ceilings?: Partial<Ceilings> } = {}) {
  const g = GOLDEN.qualified();
  g.name = `allow-${name}`;
  g.mission = MISSION;
  g.responses = edit(structuredClone(g.responses));
  Object.assign(g, extra);
  const r = await runGoldenMission(g);
  const sp = spendOf(r.ledger);
  return {
    r, lead: r.view.leads.find((l) => l.company.key === ACME),
    bought: (actor: string) => r.provider.calls.some((c) => c.actor === actor && !c.adopted),
    allowance: r.ledger.reservations.filter((x) => x.candidate_allowance),
    duplicates: sp.paid_keys.length - new Set(sp.paid_keys).size,
  };
}

Deno.test("E2E 1 core: the fallback proves funding, then the job search is bought and the company qualifies", async () => {
  const o = await run("core", (rs) => [...atomus(rs, [], false), pvalyou([["Series A", daysAgo(60)]])]);
  assert(o.bought(PVALYOU) && o.bought(JOBS), "fallback then job search");
  assertEquals(o.allowance.map((x) => [x.candidate_keys, x.status]), [[[ACME], "executed"]]);
  assertEquals(o.lead?.hard_checks, { geography: "pass", company_size: "pass", funding: "pass", hiring: "pass" });
  assert(o.r.qualifiedKeys.includes(ACME));
  assertEquals(o.r.terminal, "completed");
  assertEquals(o.duplicates, 0);
});

Deno.test("E2E 2: Atomus decisive — no fallback, no allowance, behaviour unchanged", async () => {
  const o = await run("decisive", (rs) => atomus(rs, [["SERIES_A", daysAgo(100)]], true));
  assertFalse(o.bought(PVALYOU));
  assertEquals(o.allowance.length, 0);
  assertEquals(o.r.terminal, "completed");
});

Deno.test("E2E 3: the fallback finds nothing — funding pending, hiring still held, nothing bought on the allowance", async () => {
  const o = await run("nothing", (rs) => [...atomus(rs, [], false), pvalyou([])]);
  assertEquals(o.lead?.hard_checks.funding, "unknown");
  assertFalse(o.bought(JOBS), "no downstream call merely because an allowance exists");
  assertFalse(o.r.qualifiedKeys.includes(ACME));
  assertEquals(o.r.terminal, "search_exhausted", "no budget blocked it: a genuine dead end");
});

Deno.test("E2E 4: the fallback provider fails — no allowance, no duplicate reservations", async () => {
  const o = await run("failure", (rs) => atomus(rs, [], false)); // no Pvalyou response: the call throws
  assertEquals(o.allowance.filter((x) => x.status === "executed" || x.status === "settled").length, 0);
  assertFalse(o.bought(JOBS));
  assertEquals(o.duplicates, 0);
});

Deno.test("E2E 5: an ineligible company — no hiring verification is bought", async () => {
  // The discovery row is in range; the company RECORD declares 501-1000, so the
  // proven band fails it after enrichment.
  const o = await run("ineligible", (rs) => [...atomus(rs, [], false), pvalyou([["Series A", daysAgo(60)]])].map((r) =>
    r.actor === DETAILS
      ? { ...r, rows: r.rows.map((x) => ({ ...x, employeeCountRange: { start: 501, end: 1000 }, employeeCount: 700 })) }
      : r));
  assertEquals(o.lead?.hard_checks.company_size, "fail");
  assertFalse(o.bought(JOBS));
  assertFalse(o.r.qualifiedKeys.includes(ACME));
});

Deno.test("E2E 5b: a clearly disjoint declared band at discovery — screened out before enrichment, nothing bought for it", async () => {
  const o = await run("ineligible-early", (rs) => [...atomus(rs, [], false), pvalyou([["Series A", daysAgo(60)]])].map((r) =>
    r.actor === SEARCH || r.actor === DETAILS
      ? { ...r, rows: r.rows.map((x) => ({ ...x, employeeCountRange: { start: 501, end: 1000 }, employeeCount: 700 })) }
      : r));
  assertEquals(o.lead?.bucket, "screened_out");
  // Honest about what was read: the discovery band, not a proven record.
  assertEquals(o.lead?.hard_checks.company_size, "unknown");
  assertFalse(o.bought(DETAILS));
  assertFalse(o.bought(ATOMUS));
  assertFalse(o.bought(JOBS));
  assertFalse(o.r.qualifiedKeys.includes(ACME));
});

Deno.test("E2E 6: a mission cap stays authoritative — the allowance never admits a purchase past it", async () => {
  const o = await run("cap", (rs) => [...atomus(rs, [], false), pvalyou([["Series A", daysAgo(60)]])],
    { missionCap: { provider_usd: 0.05, credits: null, invalid: [] } });
  assertFalse(o.bought(JOBS));
  assert(spendOf(o.r.ledger).committed_usd <= 0.05 + 1e-9, `${spendOf(o.r.ledger).committed_usd}`);
  assertEquals(o.r.terminal, "budget_exhausted");
});

Deno.test("E2E 7: the per-company ceiling really blocks the route — budget_exhausted, not search_exhausted", async () => {
  const o = await run("ceiling", (rs) => atomus(rs, [["SERIES_A", daysAgo(100)]], true),
    { ceilings: { per_candidate_evidence_usd: 0.05 } });
  assertFalse(o.bought(JOBS));
  assertEquals(o.r.slices.at(-1)?.decision, "candidate_evidence_ceiling");
  assertEquals(o.r.terminal, "budget_exhausted");
});

Deno.test("E2E 8: genuine search exhaustion is still search_exhausted", async () => {
  const o = await run("exhausted", (rs) => rs.map((r) => r.actor === JOBS ? { ...r, rows: [] } : r));
  assert(o.bought(JOBS));
  assertEquals(o.r.slices.at(-1)?.decision, "no_progress");
  assertEquals(o.r.terminal, "search_exhausted");
});
