// THE FUNDING SCREEN: A WIDER POOL, ONE ATOMUS READ, THEN ADMISSION.
//
// Four live canaries (1156c062, 5bfa76db, 4a0611b0, 021d4987) bought exactly
// `max_candidates` search rows and paid details + Atomus (+ Pvalyou) for the two
// companies at the head of LinkedIn's most-followed list — media brands, mostly.
// 0 of 21 funding checks passed. Under the screen, discovery buys a wider
// short-mode pool, the funding verifier (fallback off) reads the whole pool with
// ONE Atomus call, and only `max_candidates` companies — passes first, never a
// FAIL — go on to identity, details and the claim verifiers.
//
// The engine runs for real; the provider is scripted. No network.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fundingScreenPlan, nextUnreadPage, recentlyCheckedPages, screenAdmissionOrder, searchShape, SCREEN_MAX_POOL_ROWS,
  SCREEN_MAX_TOPUP_ROWS, type FundingScreenPlan,
} from "../../../supabase/functions/_shared/fundingPoolScreen.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { PRODUCTION_READINESS } from "../../../supabase/functions/_shared/routeReadiness.ts";
import { parseRunBudget } from "../../../supabase/functions/_shared/runBudget.ts";
import { hiringEstimatePerTargetUsd } from "../../../supabase/functions/_shared/hiringClaimVerifier.ts";
import { businessModelEstimatePerTargetUsd } from "../../../supabase/functions/_shared/businessModelVerifier.ts";
import { fundingStageVerifier } from "../../../supabase/functions/_shared/fundingStageVerifier.ts";
import {
  missionCandidatesFrom, runCapabilityPlan, type EngineCompany,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { CLAIM_REGISTRY, evidenceGapsFor } from "../../../supabase/functions/_shared/evidenceGapRouter.ts";
import {
  attemptedRoutes, type PendingVerifierRun, type VerificationTarget, type VerifierCall, type VerifierCallOutcome,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import type { CompiledActorCall } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { stubMissionEvaluator } from "./missionEvaluatorFixture.ts";
import { decideAutoContinuation } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

globalThis.fetch = () => { throw new Error("these tests must not reach the network"); };

const FX = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/canary-5bfa76db/result.json", import.meta.url)));
const MISSION = FX.lead_mission;
const CRITERIA = deriveMissionCriteria(MISSION, PRODUCTION_READINESS);
const DOWNSTREAM = hiringEstimatePerTargetUsd({ titles: ["growth"], window_days: 30 })! + businessModelEstimatePerTargetUsd(0.005)!;
const ATOMUS = "apify_funding_atomus", PVALYOU = "apify_funding_pvalyou";
type Row = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════ the plan ══

Deno.test("PRICED FIRST: at $0.14 / 2 candidates — first page 4, top-up up to 2, ONE Atomus read of <=4, worst case $0.1385", () => {
  const r = fundingScreenPlan({ criteria: CRITERIA, runBudget: parseRunBudget({ provider_usd: 0.14, max_candidates: 2 }),
    requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM });
  assertEquals(r.reason, "screening");
  const p = r.plan!;
  assertEquals([p.first_rows, p.topup_rows, p.pool_rows, p.screen_max, p.fresh_target, p.admit, p.scraper_mode],
    [4, 2, 6, 4, 3, 2, "short"]);
  assertEquals(p.worst_case_usd, 0.1385);
  assert(p.worst_case_usd <= 0.14 - 0.001, "priced with the margin kept under provider_usd");
  assertEquals(p.window_days, 365);
  // Every shape tried is recorded; the five-company shapes do not fit with a top-up.
  const s5 = r.priced.filter((x) => x.screen_max === 5 && x.topup_rows > 0);
  assert(s5.length > 0 && s5.every((x) => x.worst_case_usd > 0.139), JSON.stringify(s5));
});

Deno.test("WITHOUT A TOP-UP NOTHING CHEAPER IS HIDDEN: the single-page shape is only the fallback", () => {
  // At $0.14 a single 5-row page (the canary-6 shape, $0.139) also fits, but a
  // shape that can fetch fresh candidates is preferred whenever one fits.
  const r = fundingScreenPlan({ criteria: CRITERIA, runBudget: parseRunBudget({ provider_usd: 0.14, max_candidates: 2 }),
    requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM });
  assert(r.plan!.topup_rows > 0);
  assert(r.priced.some((x) => x.topup_rows === 0) === false, "never reached the fallback pass");
});

Deno.test("THE PAGE CURSOR: past every page a same-shaped search read; filters decide 'same'; bounded by the actor", () => {
  const us = { locations: ["United States"], industryIds: ["4", "6"], companySize: ["11-50"] };
  assertEquals(nextUnreadPage([], us), 1);
  assertEquals(nextUnreadPage([{ ...us, maxItems: 2 }, { ...us, maxItems: 5, startPage: 1, takePages: 5 }], us), 2,
    "every canary read the top of page 1");
  assertEquals(nextUnreadPage([{ ...us, industryIds: ["6", "4"], maxItems: 2, startPage: 3 }], us), 4, "order of filters is not shape");
  assertEquals(nextUnreadPage([{ ...us, maxItems: 25, startPage: 2 }], us), 5, "a 25-row read spans pages 2-4");
  assertEquals(nextUnreadPage([{ ...us, industryIds: ["4"], maxItems: 2 }], us), 1, "a different filter set is a different search");
  assertEquals(nextUnreadPage([{ ...us, maxItems: 2, startPage: 20 }], us), 20, "never past the actor's page bound");
  assertEquals(searchShape({ ...us, maxItems: 9, scraperMode: "short", startPage: 7 }), searchShape(us), "paging and size of read are not shape");
});

Deno.test("NEVER WEAKENS THE BUDGET: at $0.10 no wider pool fits, so the screen is OFF and discovery is unchanged", () => {
  const r = fundingScreenPlan({ criteria: CRITERIA, runBudget: parseRunBudget({ provider_usd: 0.10, max_candidates: 2 }),
    requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM });
  assertEquals([r.plan, r.reason], [null, "pool_does_not_fit_provider_usd"]);
});

Deno.test("OFF unless every condition holds: hard windowed funding claim, a run budget, every part priced", () => {
  const budget = parseRunBudget({ provider_usd: 0.14, max_candidates: 2 });
  const soft = CRITERIA.map((c) => c.dimension === "funding" ? { ...c, kind: "target" as const } : c);
  assertEquals(fundingScreenPlan({ criteria: soft, runBudget: budget, requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM }).reason,
    "no_hard_windowed_funding_claim");
  const noWindow = CRITERIA.map((c) => c.dimension === "funding" ? { ...c, time_window: undefined } : c);
  assertEquals(fundingScreenPlan({ criteria: noWindow, runBudget: budget, requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM }).reason,
    "no_hard_windowed_funding_claim");
  assertEquals(fundingScreenPlan({ criteria: CRITERIA, runBudget: null, requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM }).reason,
    "no_run_budget");
  assertEquals(fundingScreenPlan({ criteria: CRITERIA, runBudget: parseRunBudget({ provider_usd: 0.14 }), requestedCount: 1,
    downstream_verifiers_usd: DOWNSTREAM }).reason, "no_run_budget");
  assertEquals(fundingScreenPlan({ criteria: CRITERIA, runBudget: budget, requestedCount: 1, downstream_verifiers_usd: null }).reason,
    "unpriced", "Firecrawl unpriced under a USD cap → no screen");
});

Deno.test("ADMISSION ORDER: passes first, then pending, each in the free ranking's order; a FAIL is never admitted", () => {
  const order = screenAdmissionOrder([
    { key: "a", rank: 0, verdict: "pending" as const }, { key: "b", rank: 1, verdict: "fail" as const },
    { key: "c", rank: 2, verdict: "pass" as const }, { key: "d", rank: 3, verdict: "pending" as const },
    { key: "e", rank: 4, verdict: "pass" as const },
  ]).map((x) => x.key);
  assertEquals(order, ["c", "e", "a", "d"]);
});

Deno.test("RECENTLY CHECKED: earlier tasks' Atomus keys, canonicalised; this task's own are not counted", () => {
  const pages = recentlyCheckedPages([
    { task_id: "old", candidate_keys: ["https://www.linkedin.com/company/BigRio/", "https://www.linkedin.com/company/design-milk?x=1"] },
    { task_id: "now", candidate_keys: ["https://www.linkedin.com/company/mine"] },
    { task_id: "old2", candidate_keys: "not-a-list" },
  ], "now");
  assertEquals([...pages].sort(), ["https://www.linkedin.com/company/bigrio", "https://www.linkedin.com/company/design-milk"]);
});

// ═══════════════════════════════════════════════════ the engine, end to end ══

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
const page = (slug: string) => `https://www.linkedin.com/company/${slug}`;
/** A SHORT-mode company-search row: no declared band, no member count. */
const searchRow = (slug: string) => ({
  name: slug, linkedinUrl: page(slug), website: `https://${slug}.com`, industry: "Software Development",
  description: `${slug} builds B2B SaaS.`, locations: [{ country: "US", city: "Austin" }],
});
const atomusEmpty = (slug: string): Row => ({ input: page(slug), status: "success",
  summary: { name: slug, linkedin_url: page(slug), domain: `${slug}.com` }, company: { financial: {} } });
const atomusRounds = (slug: string, dates: string[], complete: boolean): Row => ({ input: page(slug), status: "success",
  summary: { name: slug, linkedin_url: page(slug), domain: `${slug}.com` },
  company: { financial: { funding: { type: "SEED", num_funding_rounds: complete ? dates.length : dates.length + 3,
    rounds: dates.map((d) => ({ announced_at: d, raised_amount: 1_000_000, type: "SEED_ROUND" })), date: dates[0] } } } });

/** LinkedIn's result pages for the mission's filters: page 1 is the head every canary read. */
const PAGES: Record<number, Row[]> = {
  1: ["alpha", "bravo", "charlie", "delta"].map(searchRow),
  2: ["echo", "foxtrot", "golf", "hotel"].map(searchRow),
};
const ATOMUS_SAYS: Record<string, (s: string) => Row> = {
  alpha: atomusEmpty,
  bravo: (s) => atomusRounds(s, [daysAgo(800)], true),       // complete history, nothing recent → FAIL
  charlie: (s) => atomusRounds(s, [daysAgo(90)], false),     // a dated round inside 365 days → PASS
  delta: (s) => atomusRounds(s, [daysAgo(200)], false),      // PASS
  echo: (s) => atomusRounds(s, [daysAgo(120)], false),       // PASS
  foxtrot: atomusEmpty,
};

const PLAN: FundingScreenPlan = fundingScreenPlan({ criteria: CRITERIA, runBudget: parseRunBudget({ provider_usd: 0.14, max_candidates: 2 }),
  requestedCount: 1, downstream_verifiers_usd: DOWNSTREAM }).plan!;

const GRAPH = buildCapabilityGraph(MISSION as never, { executability: "enforce", readiness: PRODUCTION_READINESS } as never);

Deno.test("THE CANARY'S GRAPH: Lead V2 enters through general company discovery (the screen's precondition)", () => {
  assertEquals((GRAPH as unknown as { entry_capability: string }).entry_capability, "general_company_discovery");
});

async function run(o: {
  screen?: boolean; recentlyChecked?: string[]; atomus?: Record<string, (s: string) => Row>;
  /** LinkedIn's pages, when not the default two. */
  pages?: Record<number, Row[]>;
  /** This workspace's earlier same-window company searches (the page cursor's input). */
  priorSearches?: Record<string, unknown>[];
  /** A plan other than the priced one (e.g. a narrower Atomus cap). */
  plan?: FundingScreenPlan;
  /** A continuation: the previous slice's state and resume records. */
  resume?: { state: Record<string, unknown>; records: unknown[] };
  /** The continuation asked for a wider pool (`replenishment_required`), from these pages. */
  replenish?: Record<string, number>;
  /**
   * What an Atomus call answers instead of reading the rows: `running` (the
   * run outlives the slice), `deferred` (a stop), `failed`. Null/absent → ok.
   * `n` counts this slice's Atomus calls from 0.
   */
  atomusOutcome?: (c: VerifierCall, n: number) => VerifierCallOutcome | null;
} = {}) {
  const calls: Array<{ actorKey: string; input: Record<string, unknown> }> = [];
  const screened: string[][] = [];
  const pvalyouBought: string[][] = [];
  /** Every Atomus call: the pages asked, and the run it adopted (null = a new read). */
  const atomusCalls: Array<{ companies: string[]; resume_run_id: string | null }> = [];
  const says = o.atomus ?? ATOMUS_SAYS;
  const result = await runCapabilityPlan({
    invoke: (call: CompiledActorCall<unknown>) => {
      const input = (call as unknown as { input: Record<string, unknown> }).input ?? {};
      calls.push({ actorKey: call.actorKey, input });
      if (call.actorKey === "apify_linkedin_company_search") {
        const onPage = (o.pages ?? PAGES)[Number(input.startPage ?? 1)] ?? [];
        return Promise.resolve(onPage.slice(0, Number(input.maxItems ?? onPage.length)) as Row[]);
      }
      if (call.actorKey === "apify_linkedin_company_details") {
        return Promise.resolve(((input.companies as string[]) ?? []).map((u) => ({
          linkedinUrl: u, name: u.split("/company/")[1], website: `https://${u.split("/company/")[1]}.com`,
          employeeCountRange: { start: 11, end: 50 }, employeeCount: 30,
          locations: [{ country: "US", city: "Austin", headquarter: true }],
          industries: [{ id: 4, name: "Software Development" }],
          description: "A B2B SaaS platform sold on subscription.",
        })) as Row[]);
      }
      return Promise.resolve([] as Row[]);
    },
    verifyEmployer: () => ({ verified: true, outcome: "ok" }),
    evaluateMission: stubMissionEvaluator({ mission_fit: "pass" }),
    // THE LIVE CHAIN on canary 8ac3d99e: the execution planner's discovery step
    // proposes FULL mode, so the retrieval plan carries `scraperMode: "full"` —
    // the proposal the spec kept over the screen's `short`.
    planExecution: () => Promise.resolve({ reasoning: "replay 8ac3d99e", steps: [
      { capability: "general_company_discovery", actor_key: "apify_linkedin_company_search", purpose: "profile discovery",
        input: { scraperMode: "full", maxItems: 5, locations: ["United States"], industryIds: ["4", "6"], companySize: ["11-50"],
          startPage: 1, takePages: 2 }, depends_on: [] },
      { capability: "company_identity_resolution", actor_key: "apify_linkedin_company_search", purpose: "only without a page",
        input: { searchQuery: "{{name}}", maxItems: 5 }, depends_on: [1] },
      { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details", input: { companies: ["{{url}}"] }, depends_on: [2] },
      { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [3] },
      { capability: "persistence", actor_key: null, purpose: "save", input: {}, depends_on: [4] },
    ] }),
    // WHAT THE LIVE STRATEGY PROPOSED on canary 8ac3d99e: full mode, five rows.
    planDiscovery: () => Promise.resolve([{
      actor_key: "apify_linkedin_company_search", role: "primary",
      input: { scraperMode: "full", maxItems: 5, locations: ["United States"], industryIds: ["4", "6"], companySize: ["11-50"],
        startPage: 1, takePages: 2 },
    }]),
  } as never, {
    // AS run-agent BUILDS IT for Lead V2: the executability gate enforced.
    mission: MISSION, plan: GRAPH,
    maxCandidates: o.screen === false ? 2 : (o.plan ?? PLAN).pool_rows, remainingLeads: 1, readEnv: () => undefined,
    identity: { workspace_id: "ws-test", task_id: "task-screen" },
    // AS LEAD V2 RUNS: the ProviderCallSpec spine on, under the run's budget.
    // Canary 8ac3d99e failed exactly here — the spec capped discovery at
    // max_candidates and kept the planner's full mode — and these tests did not
    // turn the spec on.
    specMode: "enforce", specScope: { workspace_id: "ws-test", lineage_id: "lineage-screen" },
    readiness: PRODUCTION_READINESS, runBudget: parseRunBudget({ provider_usd: 0.14, max_candidates: 2 }),
    ...(o.replenish ? {
      discoveryReplenishment: {
        reason: "replenishment_required", pages_taken: o.replenish,
        sources_attempted: ["apify_linkedin_company_search"],
      },
    } : {}),
    ...(o.resume ? {
      state: o.resume.state,
      resume: { workspace_id: "ws-test", lineage_root_task_id: "lineage-screen", records: o.resume.records },
    } : {}),
    ...(o.screen === false ? {} : {
      fundingScreen: {
        plan: o.plan ?? PLAN,
        recentlyChecked: new Set(o.recentlyChecked ?? []),
        priorSearches: o.priorSearches ?? [],
        screen: async (targets: VerificationTarget[], _state: unknown, pending: PendingVerifierRun[]) => {
          screened.push(targets.map((t) => t.company_key));
          const r = await fundingStageVerifier({ fallback: false }).verify(targets, {
            now: () => NOW.toISOString(), log: () => {}, ready: () => true,
            call: (c) => {
              if (c.actor_key === PVALYOU) pvalyouBought.push(c.candidate_keys);
              if (c.actor_key !== ATOMUS) return Promise.resolve({ status: "refused", reason: "not in this test" } as VerifierCallOutcome);
              const n = atomusCalls.length;
              atomusCalls.push({ companies: c.input.companies as string[], resume_run_id: c.resume_run_id ?? null });
              const forced = o.atomusOutcome?.(c, n) ?? null;
              if (forced) return Promise.resolve(forced);
              const rows = (c.input.companies as string[]).map((u) => {
                const slug = u.split("/company/")[1];
                return (says[slug] ?? atomusEmpty)(slug);
              });
              return Promise.resolve({ status: "ok", rows, provider_call_id: "pc_screen_atomus" } as VerifierCallOutcome);
            },
          }, { mission_id: "task-screen", pending });
          return { findings: r.findings, pending: r.pending };
        },
      },
    }),
  } as never);
  const run_ = result as unknown as { companies: EngineCompany[]; state: Record<string, unknown>; resume_records: unknown[] };
  const companies = run_.companies;
  return {
    calls, screened, pvalyouBought, atomusCalls, companies, state: run_.state, resume_records: run_.resume_records,
    search: calls.filter((c) => c.actorKey === "apify_linkedin_company_search"),
    detailsFor: calls.filter((c) => c.actorKey === "apify_linkedin_company_details").flatMap((c) => c.input.companies as string[]),
    byKey: (slug: string) => companies.find((c) => c.key === page(slug))!,
  };
}

Deno.test("SCREEN: a fresh first page of 4 short rows, ONE Atomus read, the two PASSES admitted — details for them alone, no top-up", async () => {
  const r = await run();
  assertEquals(r.search.length, 1, "the first page held enough fresh candidates: no second page");
  assertEquals([r.search[0].input.maxItems, r.search[0].input.scraperMode, r.search[0].input.startPage], [4, "short", 1]);
  assertEquals(r.screened.length, 1, "one Atomus read");
  assertEquals(r.screened[0].length, 4, "over the whole pool");
  assertEquals(r.pvalyouBought, [], "the screen never asks Pvalyou");
  assertEquals([...r.detailsFor].sort(), [page("charlie"), page("delta")], "only the admitted two get details");
  assertEquals(r.byKey("bravo").investigation_state, "excluded_permanently");
  assertEquals(r.byKey("bravo").shortlist_exclusion, "funding_screen_fail");
  // ISSUE 3 (canary 16699a45): with both admissions spent, the still-open rest
  // of the pool can never be investigated this mission — closed, with a reason,
  // so continuation does not count it as work.
  for (const s of ["alpha"]) {
    assertEquals(r.byKey(s).investigation_state, "excluded_permanently", `${s} is closed, not waiting`);
    assertEquals(r.byKey(s).shortlist_exclusion, "screen_not_admitted");
  }
  assertEquals(r.companies.filter((c) => c.investigation_state === "pending_investigation").length, 0, "no frontier left");
});

Deno.test("SCREEN: no pass in the pool → the top two still-open companies by rank are admitted; the FAIL never is", async () => {
  const r = await run({ atomus: { ...ATOMUS_SAYS, charlie: atomusEmpty, delta: atomusEmpty } });
  assertEquals([...r.detailsFor].sort(), [page("alpha"), page("charlie")]);
  assertFalse(r.detailsFor.includes(page("bravo")));
});

Deno.test("SCREEN: a company this workspace checked recently is not screened again and never admitted", async () => {
  const r = await run({ recentlyChecked: [page("charlie") + "/"] });
  assertFalse(r.screened[0].includes(page("charlie")), "no second Atomus read");
  assertEquals(r.byKey("charlie").shortlist_exclusion, "recently_funding_checked");
  assertEquals(r.screened[0].length, 3);
  assertEquals(r.search.length, 1, "three fresh is the target: no top-up for one repeat");
  assertEquals([...r.detailsFor].sort(), [page("alpha"), page("delta")], "delta passes; alpha is the best-ranked open one");
});

Deno.test("SCREEN → FALLBACK: an admitted company Atomus left open routes to Pvalyou next — not blocked, not re-read by Atomus", async () => {
  const r = await run({ atomus: { ...ATOMUS_SAYS, charlie: atomusEmpty, delta: atomusEmpty } });
  const cands = missionCandidatesFrom({ companies: r.companies }, { missionId: "task-screen" });
  const alpha = cands.find((c) => c.company_key === page("alpha"))!;
  const e = evaluateEligibility(CRITERIA, alpha.graph);
  const funding = evidenceGapsFor(e.checks.filter((c) => c.kind === "hard"), alpha.graph, CLAIM_REGISTRY,
    new Set(attemptedRoutes(r.byKey("alpha").completed_operations)), PRODUCTION_READINESS).find((g) => g.dimension === "funding")!;
  assertEquals([funding.next, funding.route?.actor], ["verify", PVALYOU]);
  assert(r.byKey("alpha").completed_operations.some((o) => o.endsWith(ATOMUS)), "the screen's Atomus answer is marked");
});

Deno.test("REGRESSION: without a screen, discovery is exactly what it was — full mode, the run's pool, no Atomus", async () => {
  const r = await run({ screen: false });
  assertEquals([r.search[0].input.maxItems, r.search[0].input.scraperMode], [2, "full"]);
  assertEquals(r.screened, []);
});

Deno.test("THE CAP HOLDS: the pool is at most SCREEN_MAX_POOL_ROWS, and admission never exceeds max_candidates", async () => {
  assert(PLAN.pool_rows <= SCREEN_MAX_POOL_ROWS + SCREEN_MAX_TOPUP_ROWS);
  assert(PLAN.screen_max <= SCREEN_MAX_POOL_ROWS);
  const r = await run();
  const investigated = r.companies.filter((c) => c.investigation_state === "in_flight" || c.investigation_state === "investigated");
  assertEquals(investigated.length, PLAN.admit);
});

// ══════════════════════════════════════ canary 16699a45: the three engine issues ══

Deno.test("ISSUE 1 — A CLOSED COMPANY STAYS CLOSED ACROSS A RESUME: the screen's FAIL is not re-ranked back onto the frontier", async () => {
  const s1 = await run();
  assertEquals(s1.byKey("bravo").investigation_state, "excluded_permanently");
  // The continuation slice: the same pool restored from the checkpoint, triage and ranking re-applied.
  const s2 = await run({ resume: { state: s1.state, records: s1.resume_records } });
  assertEquals(s2.byKey("bravo").investigation_state, "excluded_permanently", "the FAIL was reopened on resume");
  assertEquals(s2.byKey("bravo").shortlist_exclusion, "funding_screen_fail", "and it keeps the reason it was closed for");
  assertEquals(s2.companies.filter((c) => c.investigation_state === "pending_investigation").length, 0,
    "no frontier for continuation to chase");
  assertEquals(s2.screened, [], "and nothing is screened twice");
  assertEquals(s2.search.length, 0, "and no search page is bought twice");
});

Deno.test("ISSUE 2 — A DOMAINLESS PLACEHOLDER PAGE never reaches the paid screen", async () => {
  // "Stealth Startup" with no website — canary 16699a45's third new row, which Atomus was paid to read.
  const stealth = { ...searchRow("stealth-startup-community"), name: "Stealth Startup", website: null };
  const r = await run({ pages: { 1: [stealth, ...["alpha", "bravo", "charlie"].map(searchRow)], 2: PAGES[2] } });
  assertFalse(r.screened.flat().includes(page("stealth-startup-community")), "no Atomus read for a placeholder");
  assertFalse(r.companies.some((c) => c.key === page("stealth-startup-community")), "it leaves the working set");
  assertEquals(r.screened[0].length, 3);
});

// ═════════════════════════════════════════════ fresh candidates: cursor and top-up ══

/** The first call's input as the engine sends it, to use as an earlier "same-shaped" search. */
async function firstSearchInput() { return (await run()).search[0].input; }

Deno.test("CURSOR: the first page is the next one this workspace has not read — canary history reads page 1, so page 2", async () => {
  const prior = { ...(await firstSearchInput()), maxItems: 2, startPage: 1 };
  const r = await run({ priorSearches: [prior] });
  assertEquals([r.search[0].input.startPage, r.search[0].input.maxItems, r.search[0].input.scraperMode], [2, 4, "short"]);
  assertEquals([...r.screened[0]].sort(), ["echo", "foxtrot", "golf", "hotel"].map(page).sort(), "fresh companies, not the head");
  assertEquals(r.search.length, 1);
});

Deno.test("TOP-UP: a first page that is mostly RECENTLY CHECKED buys ONE later page, within the row allowance", async () => {
  const r = await run({ recentlyChecked: ["alpha", "bravo", "charlie"].map(page) });
  assertEquals(r.search.length, 2, "one top-up page");
  assertEquals([r.search[1].input.startPage, r.search[1].input.maxItems, r.search[1].input.scraperMode], [2, 2, "short"],
    "the next page, only the rows the allowance has left");
  const rows = r.search.reduce((n, c) => n + Number(c.input.maxItems), 0);
  assert(rows <= PLAN.pool_rows, `${rows} rows > ${PLAN.pool_rows}`);
  assertEquals(r.screened.length, 1, "still ONE Atomus read, after both pages");
  assertEquals([...r.screened[0]].sort(), ["delta", "echo", "foxtrot"].map(page).sort(), "only fresh companies are screened");
  assertEquals([...r.detailsFor].sort(), [page("delta"), page("echo")], "the two passes are admitted");
});

Deno.test("TOP-UP: placeholders and duplicates on the first page are not fresh either", async () => {
  const stealth = { ...searchRow("stealth-startup-community"), name: "Stealth Startup", website: null };
  const confidential = { ...searchRow("confidential-careers"), name: "Confidential Careers", website: null };
  const dup = { ...searchRow("alpha"), name: "Alpha Inc." };
  const r = await run({ pages: { 1: [stealth, searchRow("alpha"), dup, confidential], 2: PAGES[2] } });
  assertEquals(r.search.length, 2, "one fresh company of four rows → the top-up page");
  assertEquals(r.search[1].input.startPage, 2);
  assertEquals([...r.screened[0]].sort(), ["alpha", "echo", "foxtrot"].map(page).sort());
  assertEquals(r.screened[0].filter((k) => k === page("alpha")).length, 1, "a duplicate is screened once");
});

Deno.test("TOP-UP IS BOUNDED: an empty later page ends discovery — no third page, no re-plan onto another provider", async () => {
  const r = await run({ recentlyChecked: ["alpha", "bravo", "charlie", "delta"].map(page), pages: { 1: PAGES[1], 2: [] } });
  assertEquals(r.search.length, 2);
  assert(r.calls.every((c) => ["apify_linkedin_company_search", "apify_linkedin_company_details"].includes(c.actorKey)),
    JSON.stringify(r.calls.map((c) => c.actorKey)));
  assertEquals(r.screened, [], "nothing fresh to screen, nothing bought");
  assertEquals(r.detailsFor, []);
});

Deno.test("SCREEN CAP: a fresh pool wider than one Atomus read is screened up to screen_max; the rest is closed, never admitted unscreened", async () => {
  const r = await run({ plan: { ...PLAN, screen_max: 3 } });
  assertEquals(r.screened[0].length, 3);
  assertEquals(r.byKey("delta").investigation_state, "excluded_permanently");
  assertEquals(r.byKey("delta").shortlist_exclusion, "screen_pool_overflow");
  assertFalse(r.detailsFor.includes(page("delta")));
});

Deno.test("TOP-UP BELOW THE YIELD FLOOR: a first page of nothing but placeholders still gets its later page", async () => {
  // Admitted over raw is 0 here — beneath MIN_PAGINATION_YIELD, where ordinary
  // pagination reads "this index does not hold what the mission wants". For the
  // screen a stale page is exactly when the top-up must run.
  const ph = (slug: string, name: string) => ({ ...searchRow(slug), name, website: null });
  const r = await run({ pages: { 1: [ph("stealth-a", "Stealth Startup"), ph("conf-b", "Confidential"),
    ph("free-c", "Freelance"), ph("self-d", "Self Employed")], 2: PAGES[2] } });
  assertEquals(r.search.length, 2, "the top-up ran");
  assertEquals([r.search[1].input.startPage, r.search[1].input.maxItems], [2, 2]);
  assertEquals([...r.screened[0]].sort(), ["echo", "foxtrot"].map(page).sort(), "no placeholder is ever screened");
});

// ═══════════════════ canary 1a0c3234: no discovery once the admissions are spent ══

Deno.test("ADMISSIONS SPENT → DISCOVERY EXHAUSTED: the state the checkpoint carries says no routes remain, though rows are left", async () => {
  const s1 = await run();
  const st = s1.state as { funding_screen?: { admissions_spent?: boolean }; discovery_source_state?: { exhausted: boolean; stop_reason: string } };
  assertEquals(s1.search.reduce((n, c) => n + Number(c.input.maxItems), 0), 4, "4 of the 6-row allowance bought");
  assertEquals(st.funding_screen?.admissions_spent, true);
  assertEquals([st.discovery_source_state?.exhausted, st.discovery_source_state?.stop_reason], [true, "screen_admissions_spent"]);
  // Continuation reads `!exhausted` as "discovery routes remain" (run-agent). With both admitted
  // companies investigated and none qualified, it now ends instead of asking for a wider pool.
  const d = decideAutoContinuation({
    cancelled: false, qualified: 0, requestedCount: 1, frontierRemaining: 0, continuationsUsed: 2, maxContinuations: 5,
    costUnitsUsed: 2, maxCostUnits: 50, barrenSlices: 1, providerFailed: false, pendingRuns: 0,
    discoveryRoutesRemain: !st.discovery_source_state!.exhausted, verificationRoutesRemain: 0,
  } as never);
  assertFalse(d.continue);
  assert(d.reason !== "replenishment_required", d.reason);
});

Deno.test("REPLAY 1a0c3234: a replenishment slice after the admissions are spent buys NO page and NO second Atomus read", async () => {
  const s1 = await run();
  const pages = (s1.state as { discovery_source_state?: { pages_taken: Record<string, number> } }).discovery_source_state!.pages_taken;
  // Forced, as the pre-fix continuation did: `replenishment_required` with rows left in the allowance.
  const s2 = await run({ resume: { state: s1.state, records: s1.resume_records }, replenish: pages });
  assertEquals(s2.search.length, 0, "no page 3");
  assertEquals(s2.screened, [], "no second Atomus read");
  assertEquals(s2.detailsFor, []);
  assertEquals(s2.companies.filter((c) => c.investigation_state === "pending_investigation").length, 0);
});

Deno.test("NO SLOT LEFT, NO SCREEN: an unscreened company still open after the admissions are spent is closed, never read by Atomus", async () => {
  const s1 = await run();
  // A checkpoint that carries an open, never-screened company past the admissions (defence in
  // depth: discovery cannot add one once the budget reads spent, but a restored pool could hold one).
  const records = structuredClone(s1.resume_records) as Array<{ company_key: string; completed_operations?: string[];
    snapshot?: { investigation_state?: string; shortlist_exclusion?: string | null } }>;
  const alpha = records.find((r) => r.company_key === page("alpha"))!;
  alpha.completed_operations = (alpha.completed_operations ?? []).filter((o) => !o.endsWith(ATOMUS));
  alpha.snapshot = { ...alpha.snapshot, investigation_state: "pending_investigation", shortlist_exclusion: null };
  const state = structuredClone(s1.state) as { funding_screen?: { verdicts: Record<string, string> } };
  delete state.funding_screen!.verdicts[page("alpha")];
  const s2 = await run({ resume: { state: state as Record<string, unknown>, records } });
  assertEquals(s2.screened, [], "no Atomus read with no slot left");
  assertEquals(s2.byKey("alpha").investigation_state, "excluded_permanently");
  assertEquals(s2.byKey("alpha").shortlist_exclusion, "screen_not_admitted");
});

// ══════════════════ canary 207dbdb6: the screen reads ONCE, then discovery is over ══

/** Canary 8's page 4: three long-dormant funding histories and one company nobody holds rounds for. */
const PAGE_4: Row[] = ["loyyal", "tumblr", "cryptobriefing", "thehustle"].map(searchRow);
const DORMANT: Record<string, (s: string) => Row> = {
  loyyal: (s) => atomusRounds(s, [daysAgo(2612)], true),
  tumblr: (s) => atomusRounds(s, [daysAgo(4181)], true),
  thehustle: (s) => atomusRounds(s, [daysAgo(3483)], true),
  cryptobriefing: atomusEmpty,
};

Deno.test("SCREEN READ → DISCOVERY EXHAUSTED even with an admission slot left (1 of 2 used)", async () => {
  const s1 = await run({ pages: { 1: PAGE_4, 2: PAGES[2] }, atomus: DORMANT });
  const st = s1.state as { funding_screen?: { screened?: boolean; admissions_spent?: boolean };
    discovery_source_state?: { exhausted: boolean; stop_reason: string } };
  assertEquals(s1.detailsFor, [page("cryptobriefing")], "the one company that did not fail is the only admission");
  assertFalse(st.funding_screen?.admissions_spent === true, "a slot is still free");
  assertEquals(st.funding_screen?.screened, true);
  assertEquals([st.discovery_source_state?.exhausted, st.discovery_source_state?.stop_reason], [true, "screen_complete"]);
  const d = decideAutoContinuation({
    cancelled: false, qualified: 0, requestedCount: 1, frontierRemaining: 0, continuationsUsed: 2, maxContinuations: 5,
    costUnitsUsed: 2, maxCostUnits: 50, barrenSlices: 1, providerFailed: false, pendingRuns: 0,
    discoveryRoutesRemain: !st.discovery_source_state!.exhausted, verificationRoutesRemain: 0,
  } as never);
  assertFalse(d.continue);
  assert(d.reason !== "replenishment_required", d.reason);
});

Deno.test("REPLAY 207dbdb6: a forced replenishment after the screen buys NO page 5 and NO second Atomus read", async () => {
  const s1 = await run({ pages: { 1: PAGE_4, 2: PAGES[2] }, atomus: DORMANT });
  const pages = (s1.state as { discovery_source_state?: { pages_taken: Record<string, number> } }).discovery_source_state!.pages_taken;
  const s2 = await run({ resume: { state: s1.state, records: s1.resume_records }, replenish: pages, atomus: DORMANT });
  assertEquals(s2.search.length, 0, "no second discovery page");
  assertEquals(s2.screened, [], "no second Atomus read");
  assertEquals(s2.detailsFor, []);
});

Deno.test("THE TOP-UP STILL RUNS: it is BEFORE the screen, so a stale first page is still topped up", async () => {
  const r = await run({ recentlyChecked: ["alpha", "bravo", "charlie"].map(page) });
  assertEquals(r.search.length, 2);
  assertEquals(r.screened.length, 1, "and the screen still reads once, after both pages");
  assertEquals((r.state as { funding_screen?: { screened?: boolean } }).funding_screen?.screened, true);
});

Deno.test("ONE READ: after the screen read its pool, an unscreened open company is closed — never a second Atomus read — even with a slot free", async () => {
  const s1 = await run({ pages: { 1: PAGE_4, 2: PAGES[2] }, atomus: DORMANT });
  const records = structuredClone(s1.resume_records) as Array<{ company_key: string; completed_operations?: string[];
    snapshot?: { investigation_state?: string; shortlist_exclusion?: string | null } }>;
  const loyyal = records.find((r) => r.company_key === page("loyyal"))!;
  loyyal.completed_operations = (loyyal.completed_operations ?? []).filter((o) => !o.endsWith(ATOMUS));
  loyyal.snapshot = { ...loyyal.snapshot, investigation_state: "pending_investigation", shortlist_exclusion: null };
  const state = structuredClone(s1.state) as { funding_screen?: { verdicts: Record<string, string> } };
  delete state.funding_screen!.verdicts[page("loyyal")];
  const s2 = await run({ resume: { state: state as Record<string, unknown>, records }, atomus: DORMANT });
  assertEquals(s2.screened, [], "the one priced read is already spent");
  assertEquals(s2.byKey("loyyal").investigation_state, "excluded_permanently");
});

// ══════════════════════════ INTERRUPTED SCREEN: the paid read is awaited, adopted, never re-bought ══
//
// Codex PR #74 (G5) measured it: an Atomus read still executing when the slice
// ended was read as "unavailable" — every company answered PENDING, the screen
// marked complete, the paid run never read again. The read is now carried with
// its run id and input, the screen holds (nothing admitted, nothing discovered),
// and the next slice ADOPTS it by run id: a free re-read, never a second buy.

type ScreenState = {
  screened?: boolean; pending?: PendingVerifierRun[]; waits?: number; wait_exhausted?: boolean;
  verdicts?: Record<string, string>;
};
const screenOf = (r: { state: Record<string, unknown> }) => (r.state.funding_screen ?? {}) as ScreenState;
const RUNNING: VerifierCallOutcome = { status: "running", run_id: "run-screen-1", provider_call_id: "pc_screen_atomus" };
const POOL_PAGES = ["alpha", "bravo", "charlie", "delta"].map(page);

Deno.test("INTERRUPTED SCREEN: a read still running is carried, the screen holds, and the next slice ADOPTS it — same outcome as the clean run", async () => {
  const clean = await run();
  const s1 = await run({ atomusOutcome: () => RUNNING });
  assertEquals(s1.atomusCalls.length, 1, "one read bought");
  assertEquals(s1.atomusCalls[0].resume_run_id, null);
  const fs1 = screenOf(s1);
  assertFalse(fs1.screened === true, "a screen whose read has not answered is NOT complete");
  assertEquals(fs1.pending?.map((p) => [p.stage, p.run_id, p.candidate_keys.length]), [["atomus", "run-screen-1", 4]]);
  assertEquals((fs1.pending?.[0].input as { companies: string[] }).companies, s1.atomusCalls[0].companies,
    "carried with the exact input it was bought with (the same idempotency key)");
  assertEquals(fs1.waits, 1);
  assertEquals(s1.detailsFor, [], "nothing is admitted before the screen answers");
  assertEquals(s1.companies.filter((c) => c.investigation_state === "in_flight" || c.investigation_state === "investigated").length, 0);
  assertEquals(s1.search.length, clean.search.length, "no extra discovery while the screen waits");
  for (const slug of ["alpha", "bravo", "charlie", "delta"]) {
    assertFalse(s1.byKey(slug).completed_operations.some((o) => o.endsWith(ATOMUS)), `${slug} is not marked screened`);
    assertEquals(s1.byKey(slug).investigation_state, "pending_investigation");
  }

  const s2 = await run({ resume: { state: s1.state, records: s1.resume_records } });
  assertEquals(s2.atomusCalls, [{ companies: s1.atomusCalls[0].companies, resume_run_id: "run-screen-1" }],
    "ADOPTED by run id with the same input — no second Atomus read");
  assertEquals(s2.search.length, 0, "no page bought again");
  const fs2 = screenOf(s2);
  assertEquals(fs2.screened, true);
  assertEquals(fs2.pending, []);
  assertEquals(s2.byKey("bravo").shortlist_exclusion, "funding_screen_fail", "the FAIL Atomus reported is closed");
  assertEquals([...s2.detailsFor].sort(), [...clean.detailsFor].sort(), "the same two PASSES are admitted as in the clean run");
  assertEquals(fs2.verdicts, screenOf(clean).verdicts, "and every verdict is the clean run's");
});

Deno.test("INTERRUPTED SCREEN, NEVER FINISHES: the wait is BOUNDED, the run is handed to verification, never re-bought", async () => {
  let r = await run({ atomusOutcome: () => RUNNING });
  const slices = [r];
  for (let i = 0; i < 8 && screenOf(r).screened !== true; i++) {
    r = await run({ resume: { state: r.state, records: r.resume_records }, atomusOutcome: () => RUNNING });
    slices.push(r);
  }
  const fs = screenOf(r);
  assertEquals(fs.screened, true, "the screen stops waiting");
  assertEquals(fs.wait_exhausted, true, "and says why");
  assertEquals(slices.length, 6, "after PENDING_RUN_MAX_POLLS slices — never an unbounded loop");
  const all = slices.flatMap((s) => s.atomusCalls);
  assertEquals(all.filter((c) => c.resume_run_id === null).length, 1, "ONE purchase over the whole wait");
  assert(all.slice(1).every((c) => c.resume_run_id === "run-screen-1"), "every later ask is an adoption of that run");
  const handed = ((r.state.verifier_pending_runs ?? []) as PendingVerifierRun[]).filter((p) => p.run_id === "run-screen-1");
  assertEquals(handed.length, 1, "the run is handed to the verification phase, which adopts it instead of buying Atomus again");
  // Unanswered companies are released PENDING — exactly what an unanswered read always meant.
  assertEquals(Object.values(fs.verdicts ?? {}).every((v) => v === "pending"), true);
});

Deno.test("INTERRUPTED SCREEN, STOPPED: a deferred read buys nothing, the screen holds, and the next slice asks with the SAME input", async () => {
  const s1 = await run({ atomusOutcome: () => ({ status: "deferred", reason: "deadline: checkpoint reserve reached" }) });
  const fs1 = screenOf(s1);
  assertFalse(fs1.screened === true);
  assertEquals(fs1.pending, [], "no run was started, none is carried");
  assertEquals(fs1.waits, 1);
  assertEquals(s1.detailsFor, []);
  const s2 = await run({ resume: { state: s1.state, records: s1.resume_records } });
  assertEquals(s2.atomusCalls.map((c) => [c.companies, c.resume_run_id]), [[s1.atomusCalls[0].companies, null]],
    "asked again with the same pages: the same idempotency key, so the ledger replays rather than buys twice");
  assertEquals(screenOf(s2).screened, true);
});

Deno.test("UNCHANGED: a read that FAILED or was REFUSED still settles the screen at once, every company PENDING", async () => {
  for (const out of [{ status: "failed", reason: "actor run failed" }, { status: "refused", reason: "budget" }] as VerifierCallOutcome[]) {
    const r = await run({ atomusOutcome: () => out });
    const fs = screenOf(r);
    assertEquals(fs.screened, true, out.status);
    assertEquals(fs.pending ?? [], []);
    assertEquals(Object.values(fs.verdicts ?? {}).every((v) => v === "pending"), true, out.status);
  }
});

Deno.test("VERIFICATION PHASE adopts a screen read it was handed: no second Atomus call for that company", async () => {
  const t: VerificationTarget = {
    company_key: page("charlie"), name: "charlie", domain: "charlie.com", linkedin_url: page("charlie"), graph: null as never,
    criterion: { criterion_id: "funding", dimension: "funding", value: null, window_days: 365 * 2 },
  };
  const carried: PendingVerifierRun = {
    verifier: "funding_stage_corroboration", stage: "atomus", actor_key: ATOMUS, run_id: "run-screen-1",
    input: { companies: [page("charlie"), page("delta")] }, candidate_keys: [page("charlie"), page("delta")],
    started_at: NOW.toISOString(), polls: 5, carry: { targets: [t] },
  };
  const asked: Array<{ actor: string; resume: string | null; input: unknown }> = [];
  const r = await fundingStageVerifier().verify([t], {
    now: () => NOW.toISOString(), log: () => {}, ready: () => true,
    call: (c) => {
      asked.push({ actor: c.actor_key, resume: c.resume_run_id ?? null, input: c.input });
      if (c.actor_key !== ATOMUS) return Promise.resolve({ status: "refused", reason: "not in this test" } as VerifierCallOutcome);
      const rows = (c.input.companies as string[]).map((u) => (ATOMUS_SAYS[u.split("/company/")[1]] ?? atomusEmpty)(u.split("/company/")[1]));
      return Promise.resolve({ status: "ok", rows, provider_call_id: "pc_adopted" } as VerifierCallOutcome);
    },
  }, { mission_id: "m", pending: [carried] });
  assertEquals(asked.filter((a) => a.actor === ATOMUS), [{ actor: ATOMUS, resume: "run-screen-1", input: carried.input }],
    "the carried run is adopted with its own input; no new Atomus read");
  assertEquals(r.findings.find((f) => f.company_key === page("charlie"))?.answered, true);
  assertEquals(r.pending, []);
});
