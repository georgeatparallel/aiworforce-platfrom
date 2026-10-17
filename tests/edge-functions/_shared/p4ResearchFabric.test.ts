// LEAD V2 P4 — THE UNIFIED RESEARCH FABRIC, OFFLINE.
//
// Normalized observations, canonical entity resolution, the candidate union,
// the evidence graph, per-wave feedback and route control — pure first, then
// through the real engine with the P2 spec spine enforced, serving the job rows
// the P3 actor probe actually returned (tests/fixtures/lead-v2/p3-job-discovery-probe.json).

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addCompany, entityIdentifiersOf, projectResearchFabric, restoreWorkingSet, runCapabilityPlan, toResumeRecord,
  type EngineCompany,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import {
  jobEmployerToCompany, normalizeLinkedInJob, type NormalizedHiringCompany,
} from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import {
  observationFromCompany, type EvidenceItem, type ObservationContext,
} from "../../../supabase/functions/_shared/candidateObservation.ts";
import {
  identityKnown, newCandidateUnion, resolveEntity, unionObservation,
} from "../../../supabase/functions/_shared/entityResolution.ts";
import {
  buildCompanyEvidenceGraph, requiredEvidenceDimensions,
} from "../../../supabase/functions/_shared/evidenceGraph.ts";
import {
  stopRoutes, summarizeResearchWave, validateRouteControl, type ResearchWaveSummary,
} from "../../../supabase/functions/_shared/researchFeedback.ts";
import { readinessOf } from "../../../supabase/functions/_shared/actorIntelligence.ts";
import { routeActorReady } from "../../../supabase/functions/_shared/routeReadiness.ts";
import { buildRetrievalPlan, type RetrievalPlan } from "../../../supabase/functions/_shared/retrievalPlan.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { DEFAULT_CEILINGS } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { parseRouteControlProposal } from "../../../supabase/functions/_shared/gptRouteController.ts";
import {
  CHECKPOINT_RESULT_KEY, readCheckpointCompanies, RESUME_STATE_VERSION,
} from "../../../supabase/functions/_shared/leadResumeState.ts";
import { emptyDiscoverySelector, stubDiscoverySelector } from "./discoverySelectorFixture.ts";

globalThis.fetch = () => { throw new Error("P4 fabric tests must not reach the network"); };

const PROBE = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/p3-job-discovery-probe.json", import.meta.url)));
const ROWS = PROBE.probes["harvestapi~linkedin-job-search"].items as Record<string, unknown>[];
const row = (name: string) => structuredClone(ROWS.find((r) => (r.company as { name: string }).name === name)!);

const ctx = (over: Partial<ObservationContext> = {}): ObservationContext => ({
  capability: "job_discovery", actor_key: "apify_linkedin_job_search", provider: "apify",
  route_id: "job_discovery:apify_linkedin_job_search", plan_version: 1, provider_call_id: "pc_job_1",
  mission_id: "task-p4", observed_at: "2026-09-17T10:00:00.000Z", ...over,
});

/** The same company as a YC-directory row would carry it: website, no LinkedIn page. */
function ycRow(name: string, website: string): NormalizedHiringCompany {
  return {
    external_source_id: `yc:${name.toLowerCase()}`, company_name: name, canonical_domain: null,
    linkedin_company_url: null, website, description: `${name} (YC)`, provider_industry: "B2B",
    industry_ids: [], employee_count: 6, employee_range_advisory: null, geography: "San Francisco, CA, USA",
    company_type: null, startup_evidence: { batch: "W24" }, hiring_status: true,
    source_provenance: "memo23/apify-ycombinator-scraper", field_trust: {}, missing_fields: [],
    raw_ref: { actor_key: "apify_yc_companies_memo23", source_id: `yc-${name}` },
  };
}
const ycCtx = ctx({
  capability: "startup_company_discovery", actor_key: "apify_yc_companies_memo23",
  route_id: "startup_company_discovery:apify_yc_companies_memo23", provider_call_id: "pc_yc_1",
});

// ── A. NORMALIZED OBSERVATION ───────────────────────────────────────────────

Deno.test("a job-route row normalizes into a CandidateObservation with full provenance", () => {
  const r = row("Entropy");
  const o = observationFromCompany(jobEmployerToCompany(r)!, ctx(), [normalizeLinkedInJob(r)]);
  assertEquals([o.actor_key, o.route_id, o.plan_version, o.provider_call_id], ["apify_linkedin_job_search", "job_discovery:apify_linkedin_job_search", 1, "pc_job_1"]);
  assertEquals(o.entity_hint.linkedin_company_url, "https://www.linkedin.com/company/useentropy");
  assertEquals(o.entity_hint.domain, "useentropy.com");
  const dims = o.evidence.map((e) => e.dimension);
  for (const d of ["identity", "geography", "company_size_band", "linkedin_member_count", "job", "hiring"]) {
    assert(dims.includes(d as never), `${d} in ${dims}`);
  }
  // The employer's size arrives as its declared band — and nothing claims a staff count.
  assertFalse(dims.includes("headcount" as never), "a job row never carries a staff count");
  assertEquals(o.evidence.find((e) => e.dimension === "company_size_band")!.status, "plausible",
    "a discovery row's band is plausible until the company record is read");
  assert(o.evidence.every((e) => e.source.provider_call_id === "pc_job_1" && e.source.actor === "apify_linkedin_job_search"));
  const job = o.evidence.find((e) => e.dimension === "job")!;
  assertEquals(job.status, "proven");
  assert(job.valid_until && job.valid_until > job.observed_at, "a posting expires");
  assertEquals(o.evidence.find((e) => e.dimension === "industry")?.status ?? "plausible", "plausible");
});

// ── B. CANONICAL ENTITY RESOLUTION ──────────────────────────────────────────

Deno.test("the same company from two sources is one canonical company (domain joins URL)", () => {
  const set: EngineCompany[] = [];
  const r = row("Entropy");
  const a = addCompany(set, jobEmployerToCompany(r)!, [normalizeLinkedInJob(r)], null, undefined, ctx())!;
  const b = addCompany(set, ycRow("Entropy", "https://useentropy.com"), [], "yc-prequal", undefined, ycCtx)!;
  assertEquals(set.length, 1);
  assertEquals(a.key, b.key, "the second route's row resolves to the first company");
  assertEquals(b.found_by!.map((f) => [f.actor_key, f.method]), [["apify_linkedin_job_search", "first_seen"], ["apify_yc_companies_memo23", "verified_domain"]]);
  assertEquals(b.prequal_key, "yc-prequal", "a key the pool lacked is absorbed");
});

Deno.test("the merge works in either order, and a later LinkedIn URL fills identity without renaming", () => {
  const set: EngineCompany[] = [];
  const first = addCompany(set, ycRow("Entropy", "useentropy.com"), [], null, undefined, ycCtx)!;
  const keyBefore = first.key;
  assertFalse(identityKnown(entityIdentifiersOf(first)), "a website alone needs a search");
  const r = row("Entropy");
  addCompany(set, jobEmployerToCompany(r)!, [normalizeLinkedInJob(r)], null, undefined, ctx());
  assertEquals(set.length, 1);
  assertEquals(set[0].key, keyBefore, "ledgers keyed on the first key keep matching");
  assertEquals(set[0].company.linkedin_company_url, "https://www.linkedin.com/company/useentropy");
  assert(identityKnown(entityIdentifiersOf(set[0])), "known identity → no paid Company Search");
});

Deno.test("LinkedIn URL identity beats a fuzzy name match", () => {
  const known = [
    { entity_key: "a", external_ids: [], linkedin_company_url: "https://www.linkedin.com/company/acme-robotics", domains: [], name: "Acme Robotics", country: "US" },
    { entity_key: "b", external_ids: [], linkedin_company_url: "https://www.linkedin.com/company/acmerobotics-inc", domains: [], name: "Other Name", country: "US" },
  ];
  const hint = { external_ids: [], linkedin_company_url: "https://www.linkedin.com/company/acmerobotics-inc", domain: null, website: null, name: "Acme Robotics", country: "US" };
  const r = resolveEntity(known, hint);
  assertEquals(r.kind === "match" && [r.entity_key, r.method], ["b", "linkedin_url"]);
  // A name match whose LinkedIn URL disagrees is never merged.
  const noUrlMatch = resolveEntity([known[0]], hint);
  assertEquals(noUrlMatch.kind, "new");
  // Fuzzy only with no strong identifier on either side, same country.
  assertEquals(resolveEntity([{ ...known[0], linkedin_company_url: null }],
    { ...hint, linkedin_company_url: null }).kind === "match", true);
  assertEquals(resolveEntity([{ ...known[0], linkedin_company_url: null }],
    { ...hint, linkedin_company_url: null, country: "GB" }).kind, "new");
});

Deno.test("a shared host never merges two companies", () => {
  const u = newCandidateUnion();
  const mk = (name: string, website: string, id: string) => observationFromCompany(ycRow(name, website), ctx({ provider_call_id: id }));
  unionObservation(u, mk("Alpha", "https://linktr.ee/alpha", "1"), "alpha");
  const r = unionObservation(u, mk("Beta", "https://linktr.ee/beta", "2"), "beta");
  assertFalse(r.merged, "the same link-in-bio host is not the same company");
  assertEquals(u.companies.length, 2);
});

Deno.test("one domain with two different LinkedIn pages is two companies, and the conflict is recorded", () => {
  const set: EngineCompany[] = [];
  const a = jobEmployerToCompany(row("Entropy"))!;
  const b = { ...jobEmployerToCompany(row("Entropy"))!, external_source_id: "li_company:other",
    linkedin_company_url: "https://www.linkedin.com/company/entropy-labs-uk" };
  addCompany(set, a, [], null, undefined, ctx());
  addCompany(set, b, [], null, undefined, ctx({ provider_call_id: "pc_job_2" }));
  assertEquals(set.length, 2, "a domain match whose URLs disagree is refused");
  const c = set.find((x) => x.company.linkedin_company_url === "https://www.linkedin.com/company/useentropy")!;
  assertEquals(c.identity_conflicts!.map((x) => [x.kind, x.matched_by]), [["linkedin_url_mismatch", "verified_domain"]]);
});

// ── C. CANDIDATE UNION + D. EVIDENCE GRAPH ──────────────────────────────────

Deno.test("both sources' evidence survives the merge, and provenance survives a checkpoint", () => {
  const set: EngineCompany[] = [];
  const r = row("Entropy");
  addCompany(set, jobEmployerToCompany(r)!, [normalizeLinkedInJob(r)], null, undefined, ctx());
  addCompany(set, ycRow("Entropy", "useentropy.com"), [], null, undefined, ycCtx);
  const c = set[0];
  assertEquals(c.observations!.map((o) => o.actor_key), ["apify_linkedin_job_search", "apify_yc_companies_memo23"]);
  // The clock is the fixture's own observation time: the job row is a probe from
  // 2026-09-16, and against the real clock its posting ages out of the hiring
  // window (from 2026-10-17 this test failed on every branch).
  const fabric = projectResearchFabric({ companies: set, state: {} },
    { required: ["hiring", "company_stage", "funding"], now: new Date("2026-09-17T10:00:00.000Z") });
  const f = fabric.companies[0];
  assertEquals(f.discovery_sources, 2);
  assert(f.evidence_sources.includes("apify_linkedin_job_search") && f.evidence_sources.includes("apify_yc_companies_memo23"));
  const stage = f.evidence.dimensions.find((d) => d.dimension === "company_stage")!;
  assertEquals((stage.value as { batch: string }).batch, "W24", "the cohort fact only memo23 had is kept");
  assert(f.evidence.dimensions.some((d) => d.dimension === "job"), "the posting only the job route had is kept");
  assertEquals(f.evidence.gaps, ["funding"]);
  assertEquals(fabric.union.multi_source_companies, 1);
  // Through the REAL checkpoint path — written, persisted as JSON, read back by
  // the reader that validates it. Canary 0dbce8d5 lost `found_by` here: the
  // writer recorded it and `readWorkingSetSnapshot` did not read it.
  const persisted = JSON.parse(JSON.stringify({
    [CHECKPOINT_RESULT_KEY]: { version: RESUME_STATE_VERSION, companies: [toResumeRecord(c)] },
  }));
  const records = readCheckpointCompanies(persisted);
  assertEquals(records.length, 1);
  const restored = restoreWorkingSet(records);
  assertEquals(restored[0].found_by!.map((x) => x.provider_call_id), ["pc_job_1", "pc_yc_1"]);
  assertEquals(restored[0].observations!.length, 2);
});

Deno.test("conflicting single-valued claims are kept as conflicts, precedence picks the provider field", () => {
  const base = (id: string, value: unknown, method: EvidenceItem["method"], actor: string): EvidenceItem => ({
    evidence_id: id, company_key: "k", dimension: "geography", value, status: "plausible",
    source: { provider: "apify", actor, provider_call_id: id, url: null, excerpt: null }, method,
    observed_at: "2026-09-17T00:00:00Z", valid_until: null, confidence: "medium", derived_from: [], mission_id: null, origin: "lead_mission",
  });
  const g = buildCompanyEvidenceGraph("k", [
    base("1", "Austin, TX", "model_extraction", "firecrawl"),
    base("2", "San Francisco, CA", "provider_field", "apify_linkedin_company_details"),
  ], { now: new Date("2026-09-17T12:00:00Z") });
  const geo = g.claims.find((c) => c.dimension === "geography")!;
  assertEquals(geo.current!.value, "San Francisco, CA");
  assertEquals(geo.conflicting.map((e) => e.value), ["Austin, TX"]);
  assertEquals(g.conflicts, ["geography"]);
});

Deno.test("an expired claim never speaks for a dimension", () => {
  const r = row("Bobyard");
  const o = observationFromCompany(jobEmployerToCompany(r)!, ctx({ observed_at: "2026-06-01T00:00:00.000Z" }), [normalizeLinkedInJob(r)]);
  const g = buildCompanyEvidenceGraph("k", o.evidence, { now: new Date("2026-09-17T00:00:00Z"), required: ["hiring"] });
  assertEquals(g.claims.find((c) => c.dimension === "job")!.current, null);
  assertEquals(g.gaps, ["hiring"], "a 108-day-old posting does not prove hiring now");
});

// ── HARD VS TARGET ──────────────────────────────────────────────────────────

const CANONICAL = "Find 1 seed-stage B2B SaaS startup in the US hiring its first growth marketer.";
const proposal = {
  requested_opportunity_count: 1, requested_contact_ready_count: null, company_types: ["B2B SaaS"],
  geographies: ["United States"], geography_is_hard: true, employee_range: { min: null, max: null },
  decision_maker_roles: [], hard_constraints: [], soft_preferences: [],
  preferred_signals: ["hiring growth marketer"], required_signal_terms: ["growth marketer"],
  adjacent_signals: [], excluded_signals: [],
  allowed_broadening: { role_families: [], company_types: [], geographies: [], employee_range: { min: null, max: null } },
  disallowed_broadening: [], required_evidence: [], required_capabilities: ["startup_company_discovery", "hiring_verification"],
  preferred_source_strategy: [], evaluation_instructions: "", founder_unlock_recommended: false, confidence: 0.85, unknowns: [],
};
const MISSION = compileLeadMission({ originalUserQuery: CANONICAL, proposal }).final_mission;
const GRAPH = buildCapabilityGraph(MISSION, { executability: "enforce" });

Deno.test("targets and preferences never become required evidence or rejection rules", () => {
  const pref = compileLeadMission({ originalUserQuery: CANONICAL, proposal, companyBrain: { employee_min: 1, employee_max: 150 } }).final_mission;
  const policy = criteriaExecutionPolicy(pref);
  assertEquals(policy.dimensions.company_size.may_reject, false);
  assertFalse(requiredEvidenceDimensions(policy).includes("company_size_band"), "a Brain size PREFERENCE is not a required dimension");
  const rule = compileLeadMission({ originalUserQuery: CANONICAL, proposal, companyBrain: { employee_min: 1, employee_max: 150, employee_policy: true } }).final_mission;
  assert(requiredEvidenceDimensions(criteriaExecutionPolicy(rule)).includes("company_size_band"), "an enforced Brain RULE is");
  assert(requiredEvidenceDimensions(criteriaExecutionPolicy(MISSION)).includes("geography"));
});

// ── E/F. WAVE FEEDBACK + ROUTE CONTROL (pure) ───────────────────────────────

const JOB_A = { jobTitles: ['"growth marketer"'], locations: ["United States"], postedLimit: "month", maxItems: 10 };
const JOB_B = { jobTitles: ['"demand generation manager"'], locations: ["United States"], postedLimit: "month", maxItems: 10 };
function twoRoutePlan(): RetrievalPlan {
  return buildRetrievalPlan({
    mission: MISSION, mission_hash: "h".repeat(64), graph: GRAPH, policy: criteriaExecutionPolicy(MISSION), ceilings: DEFAULT_CEILINGS,
    execution_plan: { version: 1, source: "gpt", reasoning: "", violations: [], steps: [
      { step: 1, capability: "job_discovery", actor_key: "apify_linkedin_job_search", purpose: "a", input: JOB_A, depends_on: [] },
      { step: 2, capability: "job_discovery", actor_key: "apify_linkedin_job_search", purpose: "b", input: JOB_B, depends_on: [] },
    ] } as never,
  });
}
function wave(plan: RetrievalPlan, over: Partial<ResearchWaveSummary> = {}): ResearchWaveSummary {
  const [a, b] = plan.routes;
  const s = summarizeResearchWave({
    wave: 1, plan, ledger: null, adaptive_reserve_remaining_usd: 0.5,
    admitted: { available: 3, target: 8 },
    calls: [
      { route_id: a.route_id, capability: a.capability, actor_key: a.provider, calls: 1, rows: 12, exhausted: false },
      { route_id: b.route_id, capability: b.capability, actor_key: b.provider, calls: 1, rows: 0, exhausted: true },
    ],
    companies: [{ key: "x", found_by: [{ route_id: a.route_id, capability: a.capability, actor_key: a.provider, plan_version: 1, provider_call_id: "p", method: "first_seen", observed_at: "" }], has_linkedin_url: true, has_domain: true, hard_pass: false, gaps: [] }],
  });
  return { ...s, ...over };
}
const readyAll = (a: string, c: string) => routeActorReady(a, c);
const est = () => 0.02;

Deno.test("the wave summary measures each route: yield, merges, identity, hard gate, cost, gaps", () => {
  const plan = twoRoutePlan();
  const s = wave(plan);
  assertEquals(s.routes.length, 2);
  const [a, b] = s.routes;
  assertEquals([a.rows, a.new_companies, a.identity_with_linkedin_url, a.hard_fail], [12, 1, 1, 1]);
  assertEquals(s.low_yield_routes, [a.route_id], "12 rows, 1 new company, 0 passing the hard gate");
  assertEquals(s.exhausted_routes, [b.route_id]);
  assertEquals(s.hard_constraints, { passed: 0, failed: 1, pending: 0 });
  assertEquals(s.cost.mission_ceiling_usd, DEFAULT_CEILINGS.mission_provider_usd);
});

Deno.test("a low-yield route can be stopped without affecting another route", () => {
  const plan = twoRoutePlan();
  const [a, b] = plan.routes;
  const d = validateRouteControl({ action: "stop_route", route_id: a.route_id, trigger: "route_low_yield", rationale: "12 rows, 1 new" },
    { summary: wave(plan), plan, continuation: true, routeReady: readyAll, estimateUsd: est });
  assert(d.accepted && "plan" in d, JSON.stringify(d));
  const next = (d as { plan: RetrievalPlan }).plan;
  assertEquals(next.version, plan.version + 1);
  assert(/^route_stopped:route_low_yield/.test(next.routes[0].refused ?? ""));
  assertEquals(JSON.stringify(next.routes[1]), JSON.stringify(b), "the other route is byte-identical");
  assertEquals(next.amendment!.changes.map((c) => [c.path, c.kind]), [[`routes.${a.route_id}.refused`, "operational"]]);
  assert(next.content_hash !== plan.content_hash);
  // Stopping a route the numbers call healthy is refused.
  const healthy = validateRouteControl({ action: "stop_route", route_id: b.route_id, trigger: "route_low_yield", rationale: "" },
    { summary: wave(plan), plan, continuation: false, routeReady: readyAll, estimateUsd: est });
  assertEquals(!healthy.accepted && healthy.reason, "trigger_not_supported_by_feedback");
});

Deno.test("adding a second route requires a valid amendment: trigger, readiness, budget, never on continuation", () => {
  const plan = twoRoutePlan();
  const add = (over: Record<string, unknown> = {}) => ({ action: "add_route", capability: "job_discovery", actor_key: "apify_linkedin_job_search",
    input: { jobTitles: ['"head of growth"'], locations: ["United States"], postedLimit: "month", maxItems: 10 }, trigger: "insufficient_candidates", rationale: "3 of 8", ...over });
  const base = { summary: wave(plan), plan, continuation: false, routeReady: readyAll, estimateUsd: est };
  const ok = validateRouteControl(add(), base);
  assert(ok.accepted && "route" in ok, JSON.stringify(ok));
  const refused = (p: unknown, c: Partial<typeof base> = {}) => {
    const d = validateRouteControl(p, { ...base, ...c });
    return d.accepted ? "accepted" : d.reason;
  };
  assertEquals(refused(add(), { continuation: true }), "continuation_holds_plan");
  assertEquals(refused(add({ actor_key: "apify_linkedin_company_employees", capability: "hiring_verification" })), "actor_not_ready");
  assertEquals(refused(add({ actor_key: "apify_funding_rounds_datahyena", capability: "funding_signal_discovery" })), "actor_not_ready",
    "carded but never live as discovery");
  assertEquals(refused(add(), { summary: wave(plan, { admitted: { available: 9, target: 8 } }) }), "trigger_not_supported_by_feedback");
  assertEquals(refused(add(), { estimateUsd: () => 5 }), "no_budget_room");
  assertEquals(refused(add({ trigger: "safety_clamp" })), "trigger_not_allowed_for_action");
  assertEquals(refused({ action: "add_route" }), "trigger_not_allowed_for_action");
  assertEquals(refused(null), "malformed_proposal");
});

Deno.test("readiness is recorded, not asserted: only live-proven pairs are READY", () => {
  assertEquals(readinessOf("apify_linkedin_job_search", "job_discovery").readiness, "READY");
  assertEquals(readinessOf("apify_linkedin_company_employees", "hiring_verification").readiness, "NEEDS_PROVIDER_WORK");
  assertEquals(readinessOf("parseforge/career-site-jobs-scraper", "job_discovery").readiness, "NOT_PRESENT");
  assertEquals(readinessOf("apify_funding_rounds_datahyena", "funding_signal_discovery").readiness, "CARDED_BUT_NOT_LIVE");
  assertEquals(readinessOf("nobody/nothing", "job_discovery").readiness, "NOT_PRESENT");
});

Deno.test("GPT's structured answer parses into a proposal; junk proposes nothing", () => {
  assertEquals(parseRouteControlProposal({ action: "add_route", route_id: null, trigger: "insufficient_candidates", actor_key: "apify_linkedin_job_search", input_json: '{"jobTitles":["x"]}', rationale: "r" }),
    { action: "add_route", capability: "", actor_key: "apify_linkedin_job_search", input: { jobTitles: ["x"] }, trigger: "insufficient_candidates", rationale: "r" } as never);
  assertEquals(parseRouteControlProposal({ action: "rm -rf" }), null);
  assertEquals(parseRouteControlProposal(null), null);
});

// ── THROUGH THE ENGINE ──────────────────────────────────────────────────────

interface Sent { actor: string; input: Record<string, unknown>; spec?: Record<string, any> }

const A_ROWS = ["Entropy", "nothing else", "Bobyard"].map(row);
const B_ROWS = ["Bobyard", "Entropy", "Audicus", "Bevi"].map(row);

function engineDeps(sent: Sent[], o: { steps: Array<Record<string, unknown>>; control?: (i: any) => unknown }) {
  const byUrl = new Map(ROWS.map((r) => [(r.company as { linkedinUrl: string }).linkedinUrl, r.company as Record<string, unknown>]));
  const controls: any[] = [];
  return {
    controls,
    deps: {
      planDiscovery: emptyDiscoverySelector() as never,
      planExecution: () => Promise.resolve({ reasoning: "p4", steps: o.steps }),
      ...(o.control ? { controlRoutes: (i: any) => { controls.push(i); return Promise.resolve(o.control!(i)); } } : {}),
      invoke: (call: { actorKey: string; input: unknown; providerCallSpec?: Record<string, unknown>; onProviderRun?: (r: { run_id: string; dataset_id: null }) => void }) => {
        sent.push({ actor: call.actorKey, input: call.input as Record<string, unknown>, spec: call.providerCallSpec });
        call.onProviderRun?.({ run_id: `run-${sent.length}`, dataset_id: null });
        const input = call.input as Record<string, unknown>;
        if (call.actorKey === "apify_linkedin_job_search") {
          if (input.company || Number(input.startPage ?? 1) > 1) return Promise.resolve([]);
          const t = JSON.stringify(input.jobTitles ?? []);
          return Promise.resolve(t.includes("growth marketer") ? A_ROWS : t.includes("demand generation") || t.includes("head of growth") ? B_ROWS : []);
        }
        if (call.actorKey === "apify_linkedin_company_details") {
          return Promise.resolve(((input.companies as string[]) ?? []).map((u) => {
            const c = byUrl.get(u)!;
            return { id: c.id, name: c.name, linkedinUrl: u, website: c.website, employeeCount: c.employeeCount, description: c.description, industries: c.industries, locations: c.locations };
          }));
        }
        return Promise.resolve([]);
      },
      verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
    },
  };
}
const tail = [
  { capability: "company_identity_resolution", actor_key: "apify_linkedin_company_search", purpose: "only without a page", input: { searchQuery: "{{name}}", maxItems: 5 }, depends_on: [1] },
  { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details", input: { companies: ["{{url}}"] }, depends_on: [2] },
  { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [3] },
  { capability: "persistence", actor_key: null, purpose: "save", input: {}, depends_on: [4] },
];
const jobStep = (input: Record<string, unknown>) => ({ capability: "job_discovery", actor_key: "apify_linkedin_job_search", purpose: "open roles", input, depends_on: [] });

async function engine(o: { steps: Array<Record<string, unknown>>; control?: (i: any) => unknown; resume?: any; runBudget?: unknown; state?: unknown }) {
  const sent: Sent[] = [];
  const d = engineDeps(sent, o);
  const result = await runCapabilityPlan(d.deps as never, {
    mission: MISSION, plan: GRAPH, maxCandidates: 10,
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode: "enforce", specScope: { workspace_id: "ws-p4", lineage_id: "lineage-p4" },
    ...(o.resume ? { priorState: o.resume.state, resume: o.resume.resume } : {}),
    ...(o.runBudget ? { runBudget: o.runBudget } : {}),
    ...(o.state ? { state: o.state } : {}),
  } as never) as never as { state: Record<string, any>; companies: EngineCompany[] };
  return { sent, result, controls: d.controls };
}
const jobCalls = (s: Sent[]) => s.filter((x) => x.actor === "apify_linkedin_job_search" && !x.input.company);

const addRoute = (input: Record<string, unknown>) => ({
  action: "add_route", capability: "job_discovery", actor_key: "apify_linkedin_job_search", input,
  trigger: "insufficient_candidates", rationale: "3 of 8 admitted after wave 1",
});

Deno.test("engine: a second route → one canonical company per employer, both routes in found_by, no duplicate purchases", async () => {
  const { sent, result } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: (i) => i.summary.wave === 1 ? addRoute(JOB_B) : { action: "continue" },
  });
  assertEquals(jobCalls(sent).filter((x) => Number(x.input.startPage ?? 1) === 1).length, 2, "route A, then the amended route B");
  const keys = result.companies.map((c) => c.key);
  assertEquals(new Set(keys).size, keys.length, "no duplicate companies");
  for (const name of ["Entropy", "Bobyard"]) {
    const hits = result.companies.filter((c) => c.company.company_name === name);
    assertEquals(hits.length, 1, name);
    assertEquals(new Set(hits[0].found_by!.map((f) => f.route_id)).size, 2, JSON.stringify(hits[0].found_by));
    assert(hits[0].found_by!.every((f) => f.provider_call_id), "each sighting names its provider call");
    assertEquals(hits[0].observations!.filter((o) => o.capability === "job_discovery").length, 2, "both routes' observations kept");
  }
  assertEquals(result.companies.filter((c) => c.company.company_name === "Audicus")[0].found_by!.length, 1);
  // Identity known from the row → no paid Company Search; details bought once per company.
  assertEquals(sent.filter((x) => x.actor === "apify_linkedin_company_search").length, 0);
  const detailUrls = sent.filter((x) => x.actor === "apify_linkedin_company_details").flatMap((x) => (x.input.companies as string[]) ?? []);
  assertEquals(new Set(detailUrls).size, detailUrls.length, "no company's details bought twice");
  // Every executed input equals its spec; the two routes are distinct purchases.
  for (const x of sent) if (x.spec) assertEquals(JSON.stringify(x.input), JSON.stringify(x.spec.serialized_input));
  const idem = sent.filter((x) => x.spec).map((x) => x.spec!.idempotency_key);
  assertEquals(new Set(idem).size, idem.length, "no idempotency key bought twice");
  const fabric = projectResearchFabric(result as never);
  assertEquals(fabric.union.multi_source_companies, 2, JSON.stringify(fabric.union));
  assert((result.state.research_waves ?? []).length >= 2);
});

Deno.test("engine: an added route runs only as a validated amendment, and hard geography still binds", async () => {
  const HEAD = { jobTitles: ['"head of growth"'], postedLimit: "month", maxItems: 10 }; // GPT dropped the hard geography
  const { sent, result, controls } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: (i) => i.summary.wave === 1 ? addRoute(HEAD) : { action: "continue" },
  });
  assert(controls.length >= 1);
  const rec = result.state.route_controls[0];
  assert(rec.accepted, JSON.stringify(rec));
  const plans = result.state.retrieval_plans as RetrievalPlan[];
  const amended = plans.find((p) => p.version === rec.new_plan_version)!;
  assertEquals(amended.amendment!.trigger, "insufficient_candidates");
  const added = jobCalls(sent).find((x) => JSON.stringify(x.input.jobTitles).includes("head of growth"))!;
  assert(added, "the added route ran");
  assertEquals(added.spec!.plan_version, amended.version);
  assertEquals(added.input.locations, ["United States"], "the spec fills the hard geography GPT's input dropped");
  const fill = (added.spec!.provenance as Array<Record<string, unknown>>).find((p) => p.field === "locations")!;
  assertEquals([fill.changed_by, fill.proposed_value ?? null], ["mission_hard_constraint", null]);
});

Deno.test("engine: an unready or unsupported proposal changes nothing", async () => {
  const { sent, result } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: () => ({ action: "add_route", capability: "job_discovery", actor_key: "apify_linkedin_company_employees", input: {}, trigger: "insufficient_candidates", rationale: "x" }),
  });
  const rec = result.state.route_controls[0];
  assertEquals([rec.accepted, rec.reason, rec.new_plan_version], [false, "actor_not_ready", null]);
  // (The P3 first-hire team check may still call it in hiring_verification; discovery never does.)
  assertEquals(sent.filter((x) => x.actor === "apify_linkedin_company_employees" && x.spec?.capability === "job_discovery").length, 0);
  assertFalse((result.state.retrieval_plans as RetrievalPlan[]).some((p) => p.routes.some((r) => r.provider === "apify_linkedin_company_employees")));
  assertEquals(jobCalls(sent).filter((x) => Number(x.input.startPage ?? 1) === 1).length, 1, "no route was added");
});

Deno.test("engine: a stopped route stays stopped; its sibling route is untouched", async () => {
  const EMPTY = { jobTitles: ['"chief vibes officer"'], locations: ["United States"], postedLimit: "month", maxItems: 10 };
  const { sent, result } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: (i) => i.summary.wave === 1 ? addRoute(EMPTY)
      : i.summary.exhausted_routes[0]
      ? { action: "stop_route", route_id: i.summary.exhausted_routes[0], trigger: "route_exhausted", rationale: "0 rows" }
      : { action: "continue" },
  });
  const stop = (result.state.route_controls as any[]).find((r) => r.action === "stop_route");
  assert(stop?.accepted, JSON.stringify(result.state.route_controls));
  const plans = result.state.retrieval_plans as RetrievalPlan[];
  const v = plans.find((p) => p.version === stop.new_plan_version)!;
  const stopped = v.routes.filter((r) => /^route_stopped:route_exhausted/.test(r.refused ?? ""));
  assertEquals(stopped.map((r) => JSON.stringify(r.proposed_input?.jobTitles)), [JSON.stringify(EMPTY.jobTitles)]);
  const sibling = v.routes.find((r) => JSON.stringify(r.proposed_input?.jobTitles) === JSON.stringify(JOB_A.jobTitles))!;
  assertEquals(sibling.refused, null, "route A is untouched");
  // Nothing after the stop re-asks the stopped question.
  const emptyAsks = jobCalls(sent).filter((x) => JSON.stringify(x.input.jobTitles).includes("chief vibes"));
  assertEquals(emptyAsks.length, 1);
});

Deno.test("engine: continuation keeps the plan — route control cannot replan and discovery is not rebought", async () => {
  const first = await engine({ steps: [jobStep(JOB_A), jobStep(JOB_B), ...tail] });
  const plans = first.result.state.retrieval_plans as RetrievalPlan[];
  const plan = plans[plans.length - 1];
  const d = validateRouteControl({ action: "change_query", route_id: plan.routes[0].route_id, input: JOB_B, trigger: "route_low_yield", rationale: "" },
    { summary: wave(twoRoutePlan()), plan, continuation: true, routeReady: readyAll, estimateUsd: est });
  assertEquals(!d.accepted && d.reason, "continuation_holds_plan");
  const deepen = validateRouteControl({ action: "deepen", route_id: plan.routes[0].route_id, trigger: "insufficient_candidates", rationale: "" },
    { summary: wave(twoRoutePlan()), plan, continuation: true, routeReady: readyAll, estimateUsd: est });
  assertEquals(!deepen.accepted && deepen.reason, "continuation_holds_plan");
});

Deno.test("stopRoutes is a pure version bump over exactly the named routes", () => {
  const plan = twoRoutePlan();
  const v2 = stopRoutes(plan, [plan.routes[1].route_id], "route_exhausted", "0 rows", () => new Date("2026-09-17T00:00:00Z"));
  assertEquals(plan.routes[1].refused, null, "the input plan is not mutated");
  assertEquals([v2.version, v2.amendment!.approved_by, v2.amendment!.component], [2, "code_policy", "retrieval_controller"]);
  assertEquals(v2.routes[0], plan.routes[0]);
});

Deno.test("engine: a discovery actor outside the mission's graph is refused, not thrown (canary 849d6782)", async () => {
  // The replan proposes from the closed CATALOG, which is wider than this
  // mission's graph. memo23 is a real, carded actor — and not reachable here.
  const { sent, result } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: (i) => i.summary.wave === 1
      ? { action: "add_route", capability: "job_discovery", actor_key: "apify_yc_companies_memo23", input: { maxItems: 10 }, trigger: "insufficient_candidates", rationale: "widen" }
      : { action: "continue" },
  });
  // The run SURVIVES: before this fix the containment guard threw and the whole
  // mission ended `failed:unhandled_exception`.
  assert(result.companies.length > 0, "the mission still has its pool");
  assertEquals(sent.filter((x) => x.actor === "apify_yc_companies_memo23").length, 0, "it was never invoked");
  const rec = result.state.route_controls[0];
  assertEquals([rec.accepted, rec.reason], [false, "actor_not_ready"], "route control refuses it first");
});

Deno.test("engine: a DISCOVERY PLANNER proposal outside the graph is refused by the stage, and the run survives", async () => {
  // No job_discovery step in the chain, so the stage asks `planDiscovery` —
  // which proposes memo23: carded, validated by the catalog, and not in this
  // mission's graph. This is the exact shape that ended canary 849d6782 as
  // `failed:unhandled_exception`.
  const sent: Sent[] = [];
  const d = engineDeps(sent, { steps: [] });
  // No chain planner at all, so the stage asks `planDiscovery` itself — the
  // path a live replan takes.
  const deps = { ...d.deps, planDiscovery: stubDiscoverySelector() as never } as Record<string, unknown>;
  delete deps.planExecution;
  const result = await runCapabilityPlan(deps as never, {
    mission: MISSION, plan: GRAPH, maxCandidates: 10,
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode: "enforce", specScope: { workspace_id: "ws-p4c", lineage_id: "lineage-p4c" },
  } as never) as never as { state: Record<string, any>; companies: EngineCompany[] };

  assertEquals(sent.filter((x) => x.actor === "apify_yc_companies_memo23").length, 0, "never invoked");
  const attempts = (result.state.provider_attempts as Array<Record<string, unknown>>)
    .filter((a) => a.provider === "apify_yc_companies_memo23");
  assert(attempts.length > 0, "the refusal is recorded, not silent");
  for (const a of attempts) {
    assertEquals(a.outcome, "refused_policy");
    assert(String(a.reason).includes("outside this mission's capability graph"));
  }
});

Deno.test("RUN BUDGET: max_candidates bounds the MISSION's discovery, not each call — no second wave is bought, or planned", async () => {
  // Canary 6e4a93b9: a 2-candidate budget bought 2 + 2 rows over two waves,
  // because each call's maxItems was clamped to the allowance on its own.
  // Canary 87ecf153: a spent allowance still bought model calls to plan a wave
  // that could never execute.
  const { sent, result, controls } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: (i) => i.summary.wave === 1 ? addRoute(JOB_B) : { action: "continue" },
    runBudget: { provider_usd: null, max_candidates: 3 },
  });
  const discovery = jobCalls(sent);
  assertEquals(discovery.length, 1, "route B's wave is refused: the allowance is spent");
  assert(Number(discovery[0].input.maxItems) <= 3, `wave 1 asks for at most the allowance (${discovery[0].input.maxItems})`);
  assertEquals(result.state.discovery_rows_bought, A_ROWS.length, "the mission's running total");
  // The allowance is spent after wave 1, so nobody is asked to plan wave 2:
  // no route-control call (a model call), and discovery records why it stopped.
  assertEquals(controls.length, 0, "route control is not asked once no discovery can be bought");
  assertEquals(result.state.discovery_source_state?.stop_reason, "candidate_budget_spent");
  assertEquals(result.state.discovery_source_state?.exhausted, true, "no replenishment slice is scheduled either");
  assertEquals(result.companies.filter((c) => c.company.company_name === "Audicus").length, 0, "nothing from a wave never bought");
});

Deno.test("RUN BUDGET: a discovery call is still refused BEFORE it is sent if one gets past planning", async () => {
  // The engine guard is the backstop: an allowance of 3 against a first wave
  // of 3 leaves nothing, and any later call is refused with a trace, not sent.
  // Slice 1 buys the whole allowance.
  const budget = { provider_usd: null, max_candidates: 3 };
  const first = await engine({ steps: [jobStep(JOB_A), ...tail], runBudget: budget });
  assertEquals(first.result.state.discovery_rows_bought, 3);
  // A later slice that nonetheless reaches discovery (its completion cleared)
  // carries the spent counter with its state, and its call is refused unsent.
  const { sent, result } = await engine({
    steps: [jobStep(JOB_B), ...tail], runBudget: budget,
    state: { ...first.result.state, completed_capabilities: [] },
  });
  assertEquals(jobCalls(sent).length, 0, "nothing is sent");
  const refused = (result.state.mission_trace?.events ?? []).filter((e: any) => e.type === "call_refused_budget");
  assert(refused.some((e: any) => e.detail.ceiling === "max_candidates" && e.detail.limit === 3), JSON.stringify(refused));
});

Deno.test("RUN BUDGET: the later call is clamped to what is LEFT of the allowance", async () => {
  const { sent } = await engine({
    steps: [jobStep(JOB_A), ...tail],
    control: (i) => i.summary.wave === 1 ? addRoute(JOB_B) : { action: "continue" },
    runBudget: { provider_usd: null, max_candidates: 5 },
  });
  const discovery = jobCalls(sent).filter((x) => Number(x.input.startPage ?? 1) === 1);
  assertEquals(discovery.length, 2);
  assertEquals(Number(discovery[1].input.maxItems), 5 - A_ROWS.length, "only the 2 candidates left");
});
