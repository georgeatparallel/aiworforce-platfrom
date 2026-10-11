// LEAD V2 P2 — THE ENGINE EXECUTES THE SPEC, AND ONLY THE SPEC.
//
// The real `runCapabilityPlan`, offline: a P1-compiled mission, a Company Brain
// size PREFERENCE, a GPT execution plan carrying actor-native inputs, and an
// invoker that records exactly what would have been sent to Apify.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runCapabilityPlan } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { buildInvoker } from "../../../supabase/functions/_shared/capabilityExecution.ts";
import { buildQualificationContext } from "../../../supabase/functions/_shared/missionQualificationContext.ts";
import { buildAgentoryBriefing } from "../../../supabase/functions/_shared/agentoryBriefing.ts";
import { authorisedActorKeys } from "../../../supabase/functions/_shared/gptExecutionPlanner.ts";
import { buildExecutionPlannerPayload } from "../../../supabase/functions/_shared/leadExecutionPlan.ts";
import { canonicalJson } from "../../../supabase/functions/_shared/providerInputFingerprint.ts";
import type { CompiledActorCall } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { emptyDiscoverySelector, stubDiscoverySelector } from "./discoverySelectorFixture.ts";

globalThis.fetch = () => { throw new Error("P2 engine tests must not reach the network"); };

const proposal = (over: Record<string, unknown> = {}) => ({
  requested_opportunity_count: 3, requested_contact_ready_count: null, company_types: ["B2B SaaS"],
  geographies: ["United States"], geography_is_hard: true, employee_range: { min: null, max: null },
  decision_maker_roles: [], hard_constraints: [], soft_preferences: [],
  preferred_signals: ["hiring software engineers"], required_signal_terms: ["software engineers"],
  adjacent_signals: [], excluded_signals: [],
  allowed_broadening: { role_families: [], company_types: [], geographies: [], employee_range: { min: null, max: null } },
  disallowed_broadening: [], required_evidence: [], required_capabilities: [],
    // A startup-COHORT mission: exercises the memo23 spec path. Hiring-led routing is P3 (p3JobFirstRoute.test.ts).
    preferred_source_strategy: ["startup_cohort_first"],
  evaluation_instructions: "", founder_unlock_recommended: false, confidence: 0.8, unknowns: [], ...over,
});
const BRAIN_MERGE = { employee_min: 10, employee_max: 150 };
const MISSION = compileLeadMission({
  originalUserQuery: "Find 3 B2B SaaS startups in the US hiring software engineers.",
  proposal: proposal(), companyBrain: BRAIN_MERGE,
}).final_mission;
const GRAPH = buildCapabilityGraph(MISSION, { executability: "enforce" });
const ENGINE_BRAIN = {
  employee_min: 10, employee_max: 150, positive_industries: ["b2b saas"], excluded_industries: [] as string[],
  required_geography: null,
};

const PLANNED_MEMO23 = {
  mode: "companies", queries: ["B2B SaaS", "developer tools"], regions: ["United States of America"],
  industries: ["B2B"], isHiring: true, maxItems: 100, maxEmployeeSize: "50",
};
const AMENDED_MEMO23 = { ...PLANNED_MEMO23, queries: ["API infrastructure"] };

function executionProposal(memo23: Record<string, unknown>) {
  return {
    reasoning: "YC startups hiring engineers; resolve, enrich, qualify",
    steps: [
      { capability: "startup_company_discovery", actor_key: "apify_yc_companies_memo23", purpose: "discover", input: memo23, depends_on: [] },
      { capability: "company_identity_resolution", actor_key: "apify_linkedin_company_search", purpose: "identity",
        input: { searchQuery: "{{step_1.name}}", scraperMode: "full", maxItems: 5, locations: ["United States"] }, depends_on: [1] },
      { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details",
        input: { companies: ["{{step_2.linkedinUrl}}"] }, depends_on: [2] },
      { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [3] },
      { capability: "persistence", actor_key: null, purpose: "save", input: {}, depends_on: [4] },
    ],
  };
}

const yc = (name: string, domain: string, teamSize: number) => ({
  name, website: `https://${domain}`, teamSize, batch: "W22", industries: ["B2B"], id: name.toLowerCase(),
  regions: ["United States of America"], isHiring: true, openJobs: [{ title: "Senior Software Engineer" }],
});
const YC_ROWS = [
  yc("Mux", "mux.com", 95), yc("Zentail", "zentail.com", 30), yc("Etleap", "etleap.com", 11),
  yc("Mashgin", "mashgin.com", 150), yc("OneSignal", "onesignal.com", 150), yc("Tara AI", "tara.ai", 13),
] as unknown as Record<string, unknown>[];

interface Sent { actor: string; input: Record<string, unknown>; spec: Record<string, unknown> | undefined }

function deps(sent: Sent[], opts: { amendWith?: Record<string, unknown>; discovery?: unknown } = {}) {
  let planCalls = 0;
  return {
    planDiscovery: (opts.discovery ?? emptyDiscoverySelector()) as never,
    planExecution: (i: { results?: unknown }) => {
      planCalls++;
      return Promise.resolve(executionProposal(i.results && opts.amendWith ? opts.amendWith : PLANNED_MEMO23));
    },
    invoke: (call: CompiledActorCall<unknown> & {
      providerCallSpec?: Record<string, unknown>; onProviderRun?: (r: { run_id: string; dataset_id: string | null }) => void;
    }) => {
      sent.push({ actor: call.actorKey, input: call.input as Record<string, unknown>, spec: call.providerCallSpec });
      call.onProviderRun?.({ run_id: `run-${sent.length}`, dataset_id: null });
      if (call.actorKey === "apify_yc_companies_memo23") return Promise.resolve(YC_ROWS);
      if (call.actorKey === "apify_linkedin_company_search") {
        const q = String((call.input as { searchQuery?: string }).searchQuery ?? "");
        const row = YC_ROWS.find((r) => r.name === q) as { website: string } | undefined;
        const slug = q.toLowerCase().replace(/\s+/g, "");
        return Promise.resolve(row ? [{ id: slug, name: q, linkedinUrl: `https://www.linkedin.com/company/${slug}`, website: row.website }] : []);
      }
      if (call.actorKey === "apify_linkedin_company_details") {
        const urls = ((call.input as { companies?: string[] }).companies ?? []);
        return Promise.resolve(urls.map((u) => {
          const slug = u.split("/").filter(Boolean).pop()!;
          const row = YC_ROWS.find((r) => String(r.name).toLowerCase().replace(/\s+/g, "") === slug) as { name: string; website: string } | undefined;
          return { id: slug, name: row?.name ?? slug, linkedinUrl: u, website: row?.website, employeeCount: 40,
            description: `${row?.name ?? slug} is a B2B SaaS platform.`, locations: [{ linkedinText: "United States" }] };
        }));
      }
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
    get planCalls() { return planCalls; },
  };
}

async function run(mode: "enforce" | "off", over: Record<string, unknown> = {}, depOpts: Parameters<typeof deps>[1] = {}) {
  const sent: Sent[] = [];
  const d = deps(sent, depOpts);
  const result = await runCapabilityPlan(d as never, {
    mission: MISSION, plan: GRAPH, brain: ENGINE_BRAIN, maxCandidates: 10,
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode: mode, specScope: { workspace_id: "ws-p2", lineage_id: "lineage-p2" },
    ...over,
  } as never);
  return { sent, result, deps: d };
}
const byActor = (s: Sent[], a: string) => s.filter((x) => x.actor === a);

// ── exactness ────────────────────────────────────────────────────────────────

Deno.test("enforce: every provider call carries a spec, and what is sent IS the spec", async () => {
  const { sent, result } = await run("enforce");
  assert(sent.length >= 3, `calls: ${sent.map((s) => s.actor).join(", ")}`);
  for (const s of sent) {
    assert(s.spec, `${s.actor} has a spec`);
    assertEquals(canonicalJson(s.input), canonicalJson(s.spec!.serialized_input), `${s.actor}: exact`);
  }
  const st = result.state;
  assertEquals(st.retrieval_plans?.length, 1);
  const types = new Set(st.mission_trace!.events.map((e) => e.type));
  for (const t of ["retrieval_plan_created", "spec_compiled", "call_reserved", "call_executed"]) assert(types.has(t as never), t);
  const executed = st.spend_ledger!.reservations.filter((r) => r.status === "executed");
  assertEquals(executed.length, sent.length, "one reservation executed per call");
  assert(executed.every((r) => r.settlement_source === "derived_floor" && r.provisional_usd! >= 0));
});

Deno.test("enforce: memo23 gets the planner's question; the Brain size preference is not a filter", async () => {
  const { sent, result } = await run("enforce");
  const memo = byActor(sent, "apify_yc_companies_memo23")[0].input;
  assertEquals(memo.queries, ["B2B SaaS", "developer tools"]);
  assertEquals(memo.regions, ["United States of America"], "hard US geography");
  assertEquals(memo.maxEmployeeSize, undefined, "Company Brain 10–150 is a preference");
  assertEquals(memo.maxItems, 10, "discovery pool bound, recorded");
  const spec = result.state.provider_call_specs!.find((s) => s.actor === "apify_yc_companies_memo23")!;
  const size = spec.changes.find((c) => c.field === "maxEmployeeSize")!;
  assertEquals(size.changed_by, "criteria_policy");
  assertEquals(size.proposed_value, "50");
  const count = spec.changes.find((c) => c.field === "maxItems")!;
  assertEquals([count.proposed_value, count.final_value, count.changed_by], [100, 10, "budget_policy"]);
});

Deno.test("enforce: identity search sends the planner's 5 rows, not the engine's 15", async () => {
  const { sent } = await run("enforce");
  const searches = byActor(sent, "apify_linkedin_company_search");
  assert(searches.length > 0);
  for (const s of searches) {
    assertEquals(s.input.maxItems, 5);
    assertEquals(s.input.scraperMode, "full");
    assertEquals(s.input.locations, ["United States"]);
    assert(YC_ROWS.some((r) => r.name === s.input.searchQuery), String(s.input.searchQuery));
  }
});

Deno.test("legacy mode is unchanged: the old silent rewrites still happen there (V1 / monitoring)", async () => {
  const { sent, result } = await run("off");
  const memo = byActor(sent, "apify_yc_companies_memo23")[0].input;
  assert(memo.maxEmployeeSize != null, "legacy clamps from the Brain");
  const searches = byActor(sent, "apify_linkedin_company_search");
  assert(searches.length > 0 && searches.every((s) => s.input.maxItems === 15), "legacy identity 15 rows");
  assert(sent.every((s) => !s.spec));
  assertEquals(result.state.retrieval_plans, undefined);
  assertEquals(result.state.spend_ledger, undefined);
});

// ── continuation, budget, amendments ─────────────────────────────────────────

Deno.test("a continuation never re-plans and never re-buys an executed spec", async () => {
  const first = await run("enforce");
  const second = await run("enforce", {
    state: first.result.state,
    discoveryReplenishment: { reason: "replenishment_required", sources_attempted: [], pages_taken: {} },
  });
  assertEquals(byActor(second.sent, "apify_yc_companies_memo23").length, 0, "discovery is not bought again");
  assertEquals(second.result.state.retrieval_plans?.length, 1, "no new plan version");
  assert(second.result.state.mission_trace!.events.some((e) => e.type === "continuation_resumed"));
  const keys = second.sent.map((s) => String(s.spec?.idempotency_key));
  const firstKeys = new Set(first.sent.map((s) => String(s.spec?.idempotency_key)));
  assertFalse(keys.some((k) => firstKeys.has(k)), "no idempotency key is executed twice");
});

Deno.test("an identity call over its ceiling is refused before invoke, and says so", async () => {
  const { sent, result } = await run("enforce", { ceilings: { per_call_usd: { identity: 0.004 } } });
  assertEquals(byActor(sent, "apify_linkedin_company_search").length, 0);
  const refused = result.state.provider_attempts.filter((a) => a.provider === "apify_linkedin_company_search");
  assert(refused.length > 0 && refused.every((a) => a.outcome === "refused_budget"), JSON.stringify(refused.slice(0, 2)));
  assert(result.state.mission_trace!.events.some((e) => e.type === "spec_refused" || e.type === "call_refused_budget"));
});

Deno.test("a post-discovery amendment cannot rewrite the discovery route it follows (canary 6000f9a9)", async () => {
  // GPT proposes new memo23 queries after discovery ran. Discovery is spent: the
  // route is held, so there is no new version, no new key, nothing re-bought.
  const a = await run("enforce", {}, { amendWith: AMENDED_MEMO23 });
  assertEquals(a.deps.planCalls, 2, "the plan, then the post-discovery amendment");
  const plans = a.result.state.retrieval_plans!;
  assertEquals(plans.length, 1);
  assertEquals(plans[0].routes[0].proposed_input?.queries, ["B2B SaaS", "developer tools"]);
  assertEquals(byActor(a.sent, "apify_yc_companies_memo23").length, 1);
  assertFalse(a.result.state.mission_trace!.events.some((e) => e.type === "retrieval_plan_amended"));
});

Deno.test("a continuation holds its plan while admitted candidates remain, and buys no new discovery", async () => {
  const first = await run("enforce", { maxCandidates: 10, readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "0" : undefined) });
  const plansBefore = first.result.state.retrieval_plans!.length;
  const second = await run("enforce", {
    state: first.result.state,
    discoveryReplenishment: { reason: "replenishment_required", sources_attempted: [], pages_taken: {} },
  }, { amendWith: AMENDED_MEMO23 });
  const events = second.result.state.mission_trace!.events;
  assert(events.some((e) => e.type === "continuation_resumed"));
  assertEquals(second.result.state.retrieval_plans!.length, plansBefore, JSON.stringify(events.filter((e) => e.type.startsWith("amend") || e.type.startsWith("retrieval")).map((e) => e.detail)));
  assertEquals(byActor(second.sent, "apify_yc_companies_memo23").length, 0);
});

Deno.test("a continuation's discovery reopen buys nothing and records why", async () => {
  const first = await run("enforce");
  const second = await run("enforce", {
    state: first.result.state,
    discoveryReplenishment: { reason: "replenishment_required", sources_attempted: [], pages_taken: {} },
  });
  assertEquals(second.sent.length, 0);
  const memo = second.result.state.provider_attempts.filter((a) => a.provider === "apify_yc_companies_memo23");
  assert(memo.some((a) => a.outcome === "skipped_repeat_query" || a.outcome === "skipped_idempotent"), JSON.stringify(memo));
});

// Production Query B (d72bc1ce), slices 7–8: the reopened discovery could read
// no new page, replayed its old question, and its re-plan was refused with
// `adaptive_reserve_exhausted` — yet it recorded `exhausted: false`, so the
// continuation scheduled two barren slices before the guard ended the mission.
const WIDEN = stubDiscoverySelector([{ actor_key: "apify_linkedin_company_search", role: "primary",
  input: { searchQuery: "API infrastructure", locations: ["United States"] }, rationale: "widen the pool" } as never]);
const REPLENISH = { reason: "replenishment_required", sources_attempted: [], pages_taken: {} };

Deno.test("a replenishment slice with nothing new to read and the reserve spent records discovery exhausted", async () => {
  const first = await run("enforce");
  const state = structuredClone(first.result.state) as { spend_ledger: { ceilings: { adaptive_reserve_usd: number } } };
  state.spend_ledger.ceilings.adaptive_reserve_usd = 0;
  const second = await run("enforce", { state, discoveryReplenishment: REPLENISH }, { discovery: WIDEN });
  assertEquals(second.sent.length, 0, "nothing new was bought");
  const d = second.result.state.discovery_source_state!;
  assertEquals([d.exhausted, d.stop_reason], [true, "discovery_spent"]);
});

Deno.test("with reserve left, a refused-free re-plan is not called exhausted", async () => {
  const first = await run("enforce");
  const second = await run("enforce", { state: first.result.state, discoveryReplenishment: REPLENISH }, { discovery: WIDEN });
  assertFalse(second.result.state.discovery_source_state!.stop_reason === "discovery_spent");
});

// ── criteria alignment in qualification ─────────────────────────────────────

Deno.test("qualification rejects only on hard criteria: a Brain-filled geography ranks, never rejects", () => {
  const brainGeo = compileLeadMission({
    originalUserQuery: "Find 3 B2B SaaS startups hiring software engineers.",
    proposal: proposal({ geographies: [], geography_is_hard: false }), companyBrain: { locations: ["United States"] },
  }).final_mission;
  assertEquals(brainGeo.company_profile.locations, ["united states"]);
  assert(buildQualificationContext(brainGeo).mission_owns.geography, "legacy: presence made it a rejecting axis");
  const aligned = buildQualificationContext(brainGeo, { criteriaAuthority: true });
  assertFalse(aligned.mission_owns.geography);
  assertEquals(aligned.hard_constraints["company_profile.locations"], undefined);

  const explicit = buildQualificationContext(MISSION, { criteriaAuthority: true });
  assert(explicit.mission_owns.geography, "the user's US is hard");
  assertFalse(explicit.mission_owns.employee_count, "the Brain's 10–150 is a preference");
});

// ── the ledger row, the playbook subset, the switches ───────────────────────

Deno.test("the spec travels in the call envelope the ledger persists as request_input", async () => {
  const envelopes: Record<string, unknown>[] = [];
  const invoke = buildInvoker({
    runTool: (_name: string, envelope: Record<string, unknown>) => {
      envelopes.push(envelope);
      return Promise.resolve({ ok: true, data: { items: [] } });
    },
    auditOwnership: () => ({}), toolCtx: {}, persistenceAuthority: "test",
  } as never);
  await invoke({ actorKey: "apify_yc_companies_memo23", actorId: "x", input: { queries: ["a"] }, inputHash: "h",
    providerCallSpec: { provider_call_id: "pc_1", idempotency_key: "k" } } as never).catch(() => []);
  assertEquals((envelopes[0].provider_call_spec as { provider_call_id: string }).provider_call_id, "pc_1");
});

Deno.test("planners receive only the relevant playbook subset", () => {
  const keys = authorisedActorKeys(buildExecutionPlannerPayload(MISSION, GRAPH, {}));
  assert(keys.includes("apify_yc_companies_memo23"));
  const full = buildAgentoryBriefing({ brain: null }).length;
  const subset = buildAgentoryBriefing({ brain: null, actorKeys: keys }).length;
  assert(subset < full * 0.75, `subset ${subset} vs full ${full}`);
  const sub = buildAgentoryBriefing({ brain: null, actorKeys: keys });
  assertFalse(sub.includes('"actor_key": "apify_google_news"'), "an actor the graph did not admit is not shown");
});

Deno.test("specs and subsetting are on only for Lead V2 enforce; V1 and Signals monitoring do not opt in", () => {
  const ra = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(ra.includes('const p2Specs = leadExecutabilityGate === "enforce"'));
  assert(ra.includes('specMode: p2Specs ? "enforce" : "off"'));
  assertEquals(ra.split("playbookSubset: p2Specs,").length - 1, 2);
  assert(ra.includes('readEnvSafe("LEAD_V2_SPECS")'), "kill switch");
  const scan = Deno.readTextFileSync(new URL("../../../supabase/functions/run-monitoring-scan/index.ts", import.meta.url));
  assertFalse(scan.includes("specMode"));
  assertFalse(scan.includes("playbookSubset"));
});

// ── receipts need the run ─────────────────────────────────────────────────────

Deno.test("enforce: every executed reservation names the provider run its receipt will settle", async () => {
  const { sent, result } = await run("enforce");
  const ledger = (result as { state: { spend_ledger: { reservations: Array<{ status: string; provider_run_id?: string; idempotency_key: string }> } } }).state.spend_ledger;
  const executed = ledger.reservations.filter((r) => r.status === "executed");
  assert(executed.length > 0 && executed.length === sent.length, `${executed.length} executed vs ${sent.length} sent`);
  for (const [i, r] of executed.entries()) {
    assertEquals(r.provider_run_id, `run-${i + 1}`);
    assertEquals(r.idempotency_key, (sent[i].spec as { idempotency_key: string }).idempotency_key);
  }
});
