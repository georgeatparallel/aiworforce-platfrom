// LEAD V2 INVARIANTS — EIGHTEEN PROPERTIES THAT MUST HOLD FOR EVERY MISSION.
//
// Each one is asserted directly, through the production function that owns
// it, on the replayed production data (Query B a9a6791a, Citian f6133796).
// These matter more than another production query: a property that fails here
// would fail on every mission, not just the one that happened to show it.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { replayEngineSlice } from "../lib/engine.ts";
import {
  carried, discoveryState, JOB_SEARCH, jobSearchCalls, qualifiedNames, queryBFixture,
  recordedRouteControl, replayLineage,
} from "../lib/queryB.ts";
import {
  businessModel, citian, CONSUMER_PAGE, DESCRIPTION_ONLY, industry, PAGE, read, WEBSITE, WEBSITE_CONSUMER,
} from "../lib/citian.ts";
import { canonicalView } from "../lib/verification.ts";
import {
  boundJobDiscoveryTitles, compileHarvestJobDiscoveryInput, JOB_DISCOVERY_LIMITS,
} from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { prequalifyNormalizedCompany } from "../../../supabase/functions/_shared/leadGenericPrequalification.ts";
import { jobEmployerToCompany } from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import { decideAutoContinuation, settleV2Outcome } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { effectiveRequestedCount } from "../../../supabase/functions/_shared/leadMission.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { reserve, settle, spendTotals, type SpendLedger } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import type { EngineCompany } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";

const fx = queryBFixture();
const PAGE_1 = fx.provider_responses.find((r) => r.actor === JOB_SEARCH && r.rows.length === 30)!.rows;
const SALES = { role_families: ["gtm_sales"], window_days: null };
const lineage = () => replayLineage(fx);
const company = (s: { companies: EngineCompany[] }, name: string) => s.companies.find((c) => c.company.company_name === name)!;
const provesHiring = (c: EngineCompany) =>
  (c.hiring_jobs ?? []).length > 0 ||
  (c.observations ?? []).some((o) => o.evidence.some((e) => e.dimension === "hiring" && e.value === true));
const outcome = (qualified: number, requested: number, reason: string) =>
  settleV2Outcome({ continuing: false, stopReason: reason, legacyStatus: "completed", legacyQuota: {},
    canonicalQualified: qualified, requestedCount: requested, companyIsDeliverable: true } as never);
const decide = (o: Partial<Parameters<typeof decideAutoContinuation>[0]>) => decideAutoContinuation({
  cancelled: false, qualified: 0, requestedCount: 3, frontierRemaining: 0, continuationsUsed: 1, maxContinuations: 10,
  costUnitsUsed: 2, maxCostUnits: 40, barrenSlices: 0, providerFailed: false, pendingRuns: 0,
  verificationRoutesRemain: 0, discoveryRoutesRemain: false, ...o,
} as never);

Deno.test("[invariant] 1 a historical slice error cannot poison the current slice", async () => {
  const s1 = await replayEngineSlice(fx, { deps: { controlRoutes: recordedRouteControl(fx) } });
  const state = structuredClone(s1.state) as { provider_attempts: Array<Record<string, unknown>> };
  state.provider_attempts.push({ capability: "job_discovery", provider: JOB_SEARCH, attempt: 99, outcome: "compile_failed",
    rows: 0, cost_units: 0, reason: "an earlier slice's invalid proposal" });
  const s2 = await replayEngineSlice(fx, { ...carried(s1), resume: { state, records: s1.resume_records } });
  assertEquals(jobSearchCalls(s2).length, 1);
  assert(discoveryState(s2).stop_reason !== "schema_failure");
});

Deno.test("[invariant] 2 provider input limits can never be exceeded", async () => {
  const pools = [
    ["SDR"], ["AE", "SDR", "BDR", "Sales Manager", "Sales Director", "Account Executive", "sdr"],
    ['"Account Executive" OR SDR OR BDR OR "Sales Manager"', "Head of Sales", "Founding AE", "VP Sales", "Revenue"],
    Array.from({ length: 12 }, (_, i) => `Sales Role ${i}`),
  ];
  for (const titles of pools) {
    const b = boundJobDiscoveryTitles(titles, SALES, JOB_DISCOVERY_LIMITS.jobTitles);
    assert(b.length >= 1 && b.length <= JOB_DISCOVERY_LIMITS.jobTitles, JSON.stringify(b));
    const c = compileHarvestJobDiscoveryInput({ jobTitles: b, locations: ["United States"], postedLimit: "month", maxItems: 30 } as never);
    assert(c.ok, JSON.stringify(titles));
  }
  const { s1, s2, s3 } = await lineage();
  for (const call of [s1, s2, s3].flatMap(jobSearchCalls)) {
    assert((call.input.jobTitles as unknown[]).length <= JOB_DISCOVERY_LIMITS.jobTitles);
    assert(Number(call.input.maxItems) <= JOB_DISCOVERY_LIMITS.maxItems);
    assert((call.input.locations as unknown[]).length <= JOB_DISCOVERY_LIMITS.locations);
  }
});

Deno.test("[invariant] 3 weaker evidence cannot overwrite stronger evidence", () => {
  const c = citian();
  read(c, WEBSITE(), [PAGE]);
  read(c, DESCRIPTION_ONLY());
  assertEquals([businessModel(c).status, businessModel(c).source.url], ["proven", PAGE.source_url]);
});

Deno.test("[invariant] 4 trusted contradictions remain visible", () => {
  const c = citian();
  read(c, WEBSITE(), [PAGE]);
  read(c, WEBSITE_CONSUMER(), [CONSUMER_PAGE]);
  assertEquals([businessModel(c).value, industry(c)], ["consumer", "fail"]);
});

Deno.test("[invariant] 5 agency jobs cannot prove agency hiring", async () => {
  const { s1 } = await lineage();
  assertFalse(provesHiring(company(s1, "Shift Group")), "client postings");
  assertFalse(s1.companies.some((c) => c.company.company_name === "Apex Talent"), "a staffing-industry employer is not a candidate");
});

Deno.test("[invariant] 6 employer-conflicting jobs cannot prove hiring", async () => {
  const variant = structuredClone(fx);
  const rows = variant.provider_responses.find((r) => r.actor === JOB_SEARCH && r.rows.length === 30)!.rows;
  for (const r of rows) {
    if ((r.company as { universalName: string }).universalName === "shipdayinc") r.companyLinkedinUrl = "https://www.linkedin.com/company/a-different-employer";
  }
  const s = await replayEngineSlice(variant);
  const shipday = company(s, "Shipday");
  assert(shipday, "the employer stays a candidate");
  assertFalse(provesHiring(shipday));
  assertFalse(qualifiedNames(s).includes("Shipday"));
});

Deno.test("[invariant] 7 disjoint trusted size bands reject early", async () => {
  const { s1 } = await lineage();
  const bands = new Map(PAGE_1.map((r) => {
    const c = r.company as { name: string; employeeCountRange?: { start: number; end: number } };
    return [c.name, c.employeeCountRange] as const;
  }));
  let disjoint = 0;
  for (const c of s1.companies) {
    const band = bands.get(c.company.company_name ?? "");
    if (band && (band.end < 11 || band.start > 50)) {
      disjoint++;
      assertEquals(c.prequalified?.size_exclusion_basis, "disjoint_declared_band_at_discovery", c.company.company_name ?? "");
    }
  }
  assertEquals(disjoint, 15, "every out-of-band employer was checked");
});

Deno.test("[invariant] 8 partial overlap does not early reject", () => {
  for (const slug of ["buynomics", "flagright", "o-hive-ai"]) {
    const row = PAGE_1.find((r) => (r.company as { universalName: string }).universalName === slug)!;
    const v = prequalifyNormalizedCompany(jobEmployerToCompany(row)!, { min: 5, max: 60 });
    assertEquals(v.exclusion, null, slug);
  }
});

Deno.test("[invariant] 9 a duplicate discovery page exhausts its route", async () => {
  const { s3 } = await lineage();
  assertEquals([discoveryState(s3).exhausted, discoveryState(s3).stop_reason], [true, "duplicate_page"]);
});

Deno.test("[invariant] 10 no useful route → search_exhausted", () => {
  const d = decide({ qualified: 0, discoveryRoutesRemain: false, verificationRoutesRemain: 0 });
  assertFalse(d.continue);
  assertEquals(outcome(0, 3, d.reason).terminal, "search_exhausted");
});

Deno.test("[invariant] 11 the quota requested is the execution target", () => {
  for (const n of [1, 3, 7]) {
    const m = compileLeadMission({ originalUserQuery: `Find ${n} US software companies with 11-50 employees hiring sales.`,
      proposal: { ...(fx as unknown as { proposal: Record<string, unknown> }).proposal, requested_opportunity_count: n } as never }).final_mission;
    assertEquals([m.requested_count, effectiveRequestedCount(m)], [n, n]);
  }
  assertEquals(effectiveRequestedCount(fx.mission as never), 3);
});

Deno.test("[invariant] 12 requested 3 never silently becomes 1", () => {
  for (const q of [0, 1, 2]) {
    const o = outcome(q, 3, decide({ qualified: q }).reason);
    assertEquals(o.requested, 3);
    assert(o.terminal !== "completed", `${q} of 3 is not completed`);
  }
  assertEquals(outcome(3, 3, "quota_met").terminal, "completed");
});

Deno.test("[invariant] 13 no candidate qualifies without every hard criterion proven", async () => {
  const { s3 } = await lineage();
  const v = canonicalView({ companies: s3.companies }, s3.mission, fx.provenance.task_id) as unknown as {
    leads: Array<{ label: string | null; hard_checks: Record<string, string> }>;
  };
  for (const l of v.leads.filter((x) => x.label !== null)) {
    assert(Object.values(l.hard_checks).every((r) => r === "pass"), JSON.stringify(l.hard_checks));
  }
  const weak = citian();
  read(weak, DESCRIPTION_ONLY());
  assertEquals(industry(weak), "unknown", "a plausible reading is not proof");
});

Deno.test("[invariant] 14 no duplicate provider purchase across the lineage", async () => {
  const { s1, s2, s3 } = await lineage();
  const bought = [s1, s2, s3].flatMap((s) => s.provider.calls.filter((c) => !c.adopted));
  const keys = bought.map((c) => c.idempotency_key);
  assertEquals(new Set(keys).size, keys.length, keys.join(","));
  const pages = [s1, s2, s3].flatMap(jobSearchCalls).filter((c) => c.input.industryIds !== undefined).map((c) => c.input.page ?? 1);
  assertEquals(pages, [1, 2, 3], "each page bought once, in order");
});

Deno.test("[invariant] 15 no double settlement", async () => {
  const { s3 } = await lineage();
  const ledger = structuredClone(s3.state.spend_ledger) as SpendLedger;
  const before = spendTotals(ledger).mission_committed_usd;
  const again = reserve(ledger, { ...ledger.reservations[0], estimate_usd: 9 } as never);
  assert(again.ok && again.reservation === ledger.reservations.find((r) => r.idempotency_key === ledger.reservations[0].idempotency_key));
  assertEquals(spendTotals(ledger).mission_committed_usd, before, "a repeated reservation commits nothing new");
  for (const r of ledger.reservations) { settle(ledger, r.idempotency_key, 0.02); settle(ledger, r.idempotency_key, 0.02); }
  assertEquals(spendTotals(ledger).mission_committed_usd, Math.round(ledger.reservations.length * 0.02 * 10000) / 10000,
    "two receipt reads of one call count once");
});

Deno.test("[invariant] 16 replaying the same mission produces the same final decision", async () => {
  const a = await lineage();
  const b = await lineage();
  assertEquals(qualifiedNames(a.s3), qualifiedNames(b.s3));
  assertEquals(discoveryState(a.s3), discoveryState(b.s3));
  assertEquals([a.s1, a.s2, a.s3].flatMap((s) => s.provider.calls.map((c) => c.input_hash)),
    [b.s1, b.s2, b.s3].flatMap((s) => s.provider.calls.map((c) => c.input_hash)));
});

Deno.test("[invariant] 17 continuation order does not change the final qualification", async () => {
  // Evidence delivered in any slice order ends in one claim…
  const finals = [[DESCRIPTION_ONLY, WEBSITE], [WEBSITE, DESCRIPTION_ONLY]].map((seq) => {
    const c = citian();
    for (const r of seq) read(c, r(), r === WEBSITE ? [PAGE] : []);
    return [businessModel(c).status, industry(c)];
  });
  assertEquals(finals[0], finals[1]);
  // …and the qualified set after page 1 does not depend on whether later slices ran.
  const once = await replayEngineSlice(fx);
  const { s3 } = await lineage();
  assertEquals(qualifiedNames(s3), qualifiedNames(once));
});

Deno.test("[invariant] 18 a stale checkpoint must not downgrade durable evidence", () => {
  const c = citian();
  read(c, WEBSITE(), [PAGE]);
  const restored = JSON.parse(JSON.stringify(c)) as EngineCompany;
  read(restored, DESCRIPTION_ONLY());
  assertEquals([businessModel(restored).status, industry(restored)], ["proven", "pass"]);
});

// ══════════ 19–25: TERMINATION AND STATE (Query B d22d9ee6, 2026-10-12) ═════

import { type LineageFixture, replayLineage as replayD22 } from "../lib/lineage.ts";
import { claimProgressCount } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { guardProgressWrite, resolveLineageProgress } from "../../../supabase/functions/_shared/lineageProgressGuard.ts";
import { LINEAGE_PROGRESS_KEY, readLineageProgress } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { DEFAULT_WORKER_CONFIG } from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { cancelAndFinalizeMission, type CancelMissionDb } from "../../../supabase/functions/_shared/leadMissionCancellation.ts";
import { buildRunSummary } from "../../../src/lib/workbench/runSummary.ts";
import { workbenchFunnelCounts } from "../../../src/lib/workbench/evaluationRows.ts";
import { loadFixture as loadD22 } from "../lib/fixture.ts";

const D22 = () => loadD22("queryBd22d9ee6.loop") as LineageFixture;

Deno.test("[invariant] 19 all pages consumed + an unproductive re-plan + no unseen route ⇒ discovery exhausted", async () => {
  const r = await replayD22(D22(), { maxSlices: 10 });
  const last = r.slices.at(-1)!.discovery!;
  assertEquals([last.exhausted, last.stop_reason, last.pages_taken.apify_linkedin_job_search], [true, "replan_unproductive", 3]);
  assert(r.terminal !== null);
});

Deno.test("[invariant] 20 companies rejected at discovery are not progress", () => {
  const screened = Array.from({ length: 200 }, () => ({ bucket: "screened_out", hard_check_details: [{ result: "fail" }, { result: "pass" }] }));
  assertEquals(claimProgressCount({ leads: screened, attemptedRoutesPerCompany: [] }), 0);
  assert(claimProgressCount({ leads: [...screened, { bucket: "pending", hard_check_details: [] }], attemptedRoutesPerCompany: [] }) > 0);
});

Deno.test("[invariant] 21 lineage progress counters never decrease, whichever copy is lost or stale", () => {
  const P = (n: number) => ({ ...readLineageProgress({}), continuations_used: n });
  for (const [stored, lineage, queue] of [[3, null, 3], [null, 3, 2], [2, 4, 3], [4, 1, 0], [null, null, 3]] as const) {
    const r = resolveLineageProgress({
      stored: stored === null ? undefined : P(stored),
      lineageState: lineage === null ? null : { [LINEAGE_PROGRESS_KEY]: P(lineage) },
      queueContinuations: queue,
    });
    assertEquals(r.progress.continuations_used, Math.max(stored ?? 0, lineage ?? 0, queue ?? 0));
  }
  for (const next of [{}, { [LINEAGE_PROGRESS_KEY]: P(1) }, { [LINEAGE_PROGRESS_KEY]: "garbage" }]) {
    const g = guardProgressWrite("any", { [LINEAGE_PROGRESS_KEY]: P(3) }, next as never);
    assertEquals((g.result[LINEAGE_PROGRESS_KEY] as { continuations_used: number }).continuations_used, 3);
  }
});

Deno.test("[invariant] 22 an active slice never silently outlives its lineage lease", async () => {
  // The worker heartbeats well inside the lease, and the heartbeat renews the lineage lease too.
  assert(DEFAULT_WORKER_CONFIG.heartbeatIntervalMs * 2 < DEFAULT_WORKER_CONFIG.leaseSeconds * 1000);
  const sql = await Deno.readTextFile(new URL("../../../supabase/migrations-held/20260910140000_lead_mission_v2_claim.sql", import.meta.url));
  const hb = sql.slice(sql.indexOf("function public.heartbeat_lead_mission"));
  assert(/renew_lineage_lease\(v_q\.lineage_id/.test(hb), "the heartbeat renews the lineage lease");
});

Deno.test("[invariant] 23 an exhausted deadline starts no paid work and leaves a resumable slice; resuming buys nothing twice", async () => {
  const fx = D22();
  // A real deadline whose budget cannot fit a single provider call.
  const deadline = createExecutionDeadline({ budgetMs: 1 });
  assert(deadline.expired(), "the deadline reads as exhausted");
  const { replayEngineSlice: slice } = await import("../lib/engine.ts");
  const dead = await slice(fx, { deps: { deadline } });
  assertEquals(dead.provider.calls.length, 0, "nothing bought after the deadline");
  const resumed = await slice(fx, { resume: { state: dead.state, records: dead.resume_records } });
  assert(resumed.provider.calls.length > 0, "the resumed slice does the work the exhausted one deferred");
  const keys = resumed.provider.calls.filter((c) => !c.adopted).map((c) => c.idempotency_key);
  assertEquals(new Set(keys).size, keys.length, "and buys nothing twice");
});

Deno.test("[invariant] 24 a supported cancellation leaves queue, task, lineage and plan mutually consistent", async () => {
  const st: Record<string, Record<string, unknown>> = {
    q: { id: "q", workspace_id: "w", status: "resumable", claimed_by: null, task_id: "t", lineage_id: "t", plan_id: "p" },
    t: { status: "ready", result: { terminal_status: "continuation_required" } }, l: { status: "active" }, p: { status: "partial" },
  };
  const db: CancelMissionDb = {
    readQueueRow: () => Promise.resolve(structuredClone(st.q) as never),
    cancelQueueRow: () => { st.q.status = "cancelled"; return Promise.resolve({ cancelled: true, reason: "cancelled" }); },
    readTask: () => Promise.resolve(structuredClone(st.t) as never), readLineage: () => Promise.resolve(structuredClone(st.l) as never),
    readPlan: () => Promise.resolve(structuredClone(st.p) as never),
    writeTask: (_i, x) => { st.t = { ...x }; return Promise.resolve(); }, writeLineage: (_i, x) => { st.l = { ...x }; return Promise.resolve(); },
    writePlan: (_i, x) => { st.p = { ...x }; return Promise.resolve(); },
  };
  const r = await cancelAndFinalizeMission(db, { queueId: "q", workspaceId: "w", nowIso: "2026-10-12T14:36:48Z" });
  assertEquals([st.q.status, st.t.status, (st.t.result as Record<string, unknown>).terminal_status, st.l.status, st.p.status],
    ["cancelled", "failed", "cancelled", "cancelled", "failed"]);
  assertEquals(r.reconcile?.remaining, []);
});

Deno.test("[invariant] 25 the qualified-company count is independent of contact readiness", () => {
  const s = buildRunSummary({
    qualifiedLeads: 0, leadsInReview: 3, quota: { requested: 3 } as never, portfolio: null,
    progress: { in_progress: false, qualified_companies: 1, evaluated: 47 } as never, rows: { total: 3, qualified: 0, pending: 3 },
    canonical: { qualifiedCompanies: 1, reviewed: 47, pending: 3, unverifiable: 3 },
  } as never);
  assertEquals([s.qualified.value, s.qualifiedCompanies.value, s.shortfall], [0, 1, 2]);
  assertEquals(workbenchFunnelCounts([], Math.max(s.qualified.value, s.qualifiedCompanies.value)).qualified, 1);
});
