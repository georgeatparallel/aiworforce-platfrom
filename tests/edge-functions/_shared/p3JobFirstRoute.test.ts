// LEAD V2 P3 — THE FIRST REAL HIRING-FIRST ROUTE, OFFLINE.
//
// The canonical mission, compiled by the real compiler; the V2 graph; a GPT
// execution plan carrying LinkedIn-job-search-native JSON; the real engine with
// P2 specs enforced; and an invoker serving the rows the actor-audit probe
// actually returned on 2026-09-16 (tests/fixtures/lead-v2/p3-job-discovery-probe.json).

import { readinessPolicy } from "../../../supabase/functions/_shared/routeReadiness.ts";
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runCapabilityPlan, functionTitlesFor, teamFunctionMembers } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph, firstInFunctionRequested, hiringLedMission } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { assessRequestFeasibility } from "../../../supabase/functions/_shared/requestFeasibility.ts";
import { compileHarvestJobDiscoveryInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import {
  firstHireLanguage, jobEmployerAgencyReason, jobEmployerToCompany,
} from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { discoveryCatalogBriefing } from "../../../supabase/functions/_shared/leadDiscoveryStrategy.ts";
import { buildExecutionPlannerPayload } from "../../../supabase/functions/_shared/leadExecutionPlan.ts";
import { authorisedActorKeys } from "../../../supabase/functions/_shared/gptExecutionPlanner.ts";
import { registeredEngineFields } from "../../../supabase/functions/_shared/providerCallSpec.ts";
import { canonicalJson } from "../../../supabase/functions/_shared/providerInputFingerprint.ts";
import { firstInFunctionPhrase } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { emptyDiscoverySelector } from "./discoverySelectorFixture.ts";

globalThis.fetch = () => { throw new Error("P3 route tests must not reach the network"); };

const CANONICAL = "Find 1 seed-stage B2B SaaS startup in the US hiring its first growth marketer.";
const PROBE = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/p3-job-discovery-probe.json", import.meta.url)));
const PROBE_ROWS = PROBE.probes["harvestapi~linkedin-job-search"].items as Record<string, unknown>[];

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
/**
 * A plan that DOES schedule the team lookup. V2 no longer grants it for a
 * first-hire TARGET (a target never buys expensive verification); these tests
 * keep proving what the engine does when a lookup is planned.
 */
/**
 * …and whose team actor may run. It is NEEDS_PROVIDER_WORK in production, so
 * the spec compiler refuses it there before any call (pinned below); these
 * tests open it by fixture to keep the engine's team mechanism proven.
 */
const TEAM_READY = readinessPolicy({ overrides: { "apify_linkedin_company_employees|hiring_verification": "READY" } });
const TEAM_PLAN = (() => {
  const g = JSON.parse(JSON.stringify(GRAPH));
  g.steps.find((s: { capability: string }) => s.capability === "hiring_verification").providers.push("apify_linkedin_company_employees");
  g.allowed_providers = [...new Set([...g.allowed_providers, "apify_linkedin_company_employees"])];
  return g;
})();

/** What GPT is expected to author from the job actor's card: actor-native, no company[]. */
const GPT_JOB_INPUT = {
  jobTitles: ['"growth marketer" OR "growth marketing manager" OR "head of growth" OR "demand generation manager"'],
  locations: ["United States"],
  postedLimit: "month",
  sortBy: "date",
  maxItems: 10,
};

// A B2B SaaS employer whose posting says it is the first marketing hire, built
// from the probe's own row shape (Bobyard's) so the route has a qualifying case.
const FIRST_HIRE_ROW = (() => {
  const base = structuredClone(PROBE_ROWS.find((r) => (r.company as { name: string }).name === "Bobyard")!);
  const c = base.company as Record<string, unknown>;
  Object.assign(base, {
    id: "p3-founding-growth", title: "Founding Growth Marketer",
    linkedinUrl: "https://www.linkedin.com/jobs/view/p3-founding-growth/",
    descriptionText: "You'll be our first marketing hire, reporting to the founders of a seed-stage B2B SaaS company.",
  });
  Object.assign(c, { id: "900001", universalName: "pipewise", name: "Pipewise",
    linkedinUrl: "https://www.linkedin.com/company/pipewise", website: "https://pipewise.io", employeeCount: 9,
    // Its own DECLARED band — not the one cloned from Bobyard (51-200).
    employeeCountRange: { start: 2, end: 10 },
    description: "Pipewise is B2B SaaS for revenue teams." });
  return base;
})();
const JOB_ROWS = [...PROBE_ROWS, FIRST_HIRE_ROW];

function executionProposal() {
  return {
    reasoning: "hiring-led: search the open role, take identity from the posting, verify, qualify",
    steps: [
      { capability: "job_discovery", actor_key: "apify_linkedin_job_search", purpose: "find employers with an open growth-marketing role", input: GPT_JOB_INPUT, depends_on: [] },
      { capability: "company_identity_resolution", actor_key: "apify_linkedin_company_search", purpose: "only employers without a LinkedIn page",
        input: { searchQuery: "{{step_1.company.name}}", scraperMode: "full", maxItems: 5, locations: ["United States"] }, depends_on: [1] },
      { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details",
        input: { companies: ["{{step_1.company.linkedinUrl}}"] }, depends_on: [2] },
      { capability: "hiring_verification", actor_key: "apify_linkedin_job_search", purpose: "postings already in hand", input: {}, depends_on: [3] },
      { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [4] },
      { capability: "persistence", actor_key: null, purpose: "save", input: {}, depends_on: [5] },
    ],
  };
}

interface Sent { actor: string; input: Record<string, unknown>; spec?: Record<string, unknown> }

function deps(sent: Sent[], opts: { refuseTeam?: boolean; chainOmitsHiring?: boolean; jobRows?: Record<string, unknown>[] } = {}) {
  const rows = opts.jobRows ?? JOB_ROWS;
  const byUrl = new Map(rows.map((r) => [(r.company as { linkedinUrl: string }).linkedinUrl, r.company as Record<string, unknown>]));
  return {
    planDiscovery: emptyDiscoverySelector() as never,
    planExecution: () => Promise.resolve(((p) => opts.chainOmitsHiring
      ? { ...p, steps: p.steps.filter((st) => st.capability !== "hiring_verification") } : p)(executionProposal())),
    invoke: (call: { actorKey: string; input: unknown; providerCallSpec?: Record<string, unknown>;
      onProviderRun?: (r: { run_id: string; dataset_id: null }) => void }) => {
      sent.push({ actor: call.actorKey, input: call.input as Record<string, unknown>, spec: call.providerCallSpec });
      call.onProviderRun?.({ run_id: `run-${sent.length}`, dataset_id: null });
      const input = call.input as Record<string, unknown>;
      if (call.actorKey === "apify_linkedin_job_search") return Promise.resolve(input.company ? [] : rows);
      if (call.actorKey === "apify_linkedin_company_details") {
        return Promise.resolve(((input.companies as string[]) ?? []).map((u) => {
          const c = byUrl.get(u)!;
          return { id: c.id, name: c.name, linkedinUrl: u, website: c.website, employeeCount: c.employeeCount,
            employeeCountRange: c.employeeCountRange,
            description: c.description, industries: c.industries, locations: c.locations };
        }));
      }
      if (call.actorKey === "apify_linkedin_company_employees") {
        if (opts.refuseTeam) {
          // What the tool layer does for an opt-in-only actor: refused, no run.
          const err = new Error("apify_actor_disabled_by_default") as Error & { toolResult?: unknown };
          err.toolResult = { actor_id: "harvestapi/linkedin-company-employees", source_type: "people" };
          return Promise.reject(err);
        }
        const url = (input.companies as string[])[0];
        return Promise.resolve([{ id: "p1", currentPositions: [{ title: "Founder & CEO", companyLinkedinUrl: url, current: true }] }]);
      }
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
  };
}

async function run(over: Record<string, unknown> = {}, depOpts: { refuseTeam?: boolean; chainOmitsHiring?: boolean; jobRows?: Record<string, unknown>[] } = {}) {
  const sent: Sent[] = [];
  const result = await runCapabilityPlan(deps(sent, depOpts) as never, {
    mission: MISSION, plan: GRAPH, maxCandidates: 10,
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode: "enforce", specScope: { workspace_id: "ws-p3", lineage_id: "lineage-p3" },
    ...over,
  } as never);
  return { sent, result: result as never as {
    state: Record<string, any>; companies: Array<Record<string, any>>; capability_outcomes: Array<Record<string, any>>;
  } };
}
const byActor = (s: Sent[], a: string) => s.filter((x) => x.actor === a);

Deno.test("wrong-employer discovery posting remains a candidate but cannot prove hiring", async () => {
  const bad = structuredClone(FIRST_HIRE_ROW);
  bad.descriptionText = "← All jobs\nFounding Growth Marketer\nOtherCo\nBoston, MA\nPosted 2d ago";
  const { result } = await run({}, { jobRows: [bad] });
  const pipewise = result.companies.find((c) => c.company.company_name === "Pipewise")!;
  assert(pipewise, "the company remains available for separate verification");
  assertEquals(pipewise.hiring_jobs.length, 0, "the conflicting job is not hiring evidence");
  assert(pipewise.hiring_assessment?.verdict !== "hiring_verified");
  assert(pipewise.mission_evaluation?.decision !== "qualified");
});

// ── the actor, verified ─────────────────────────────────────────────────────

Deno.test("the probe proves the contract: employer identity arrives on every job row", () => {
  assertEquals(PROBE_ROWS.length, 10);
  for (const r of PROBE_ROWS) {
    const c = jobEmployerToCompany(r)!;
    assert(c.linkedin_company_url?.startsWith("https://www.linkedin.com/company/"), String(r.id));
    assert(c.canonical_domain, `${c.company_name}: domain`);
    // The employer's DECLARED band and its LinkedIn member count, as two facts.
    assert(c.company_size_band, `${c.company_name}: declared size band`);
    assert(typeof c.linkedin_associated_member_count === "number", `${c.company_name}: LinkedIn members`);
  }
  assertEquals(PROBE.probes["harvestapi~linkedin-job-search"].chargedEventCounts, { job: 10, "actor-start": 1 });
  const reasons = Object.fromEntries(PROBE_ROWS.map((r) => [(r.company as { name: string }).name, jobEmployerAgencyReason(r)]));
  // The employer's OWN industry decides first — Scion's posting was tagged Software Development.
  for (const n of ["Aquent", "Goodwin Recruiting", "Skill", "Scion Staffing"]) {
    assertEquals(reasons[n], "employer_industry:Staffing and Recruiting", n);
  }
  for (const n of ["LinkedIn", "Entropy", "nothing else", "Bobyard", "Audicus", "Bevi"]) assertEquals(reasons[n], null, n);
  // The fallbacks, each on its own.
  assertEquals(jobEmployerAgencyReason({ title: "Growth Lead", company: { name: "Northwind Labs", industries: [] } }), null);
  assertEquals(jobEmployerAgencyReason({ title: "Growth Lead", company: { name: "Northstar Recruiting", industries: [] } }), "employer_name_is_agency");
  assertEquals(jobEmployerAgencyReason({ title: "Growth Marketer [AQ-18078]", company: { name: "Acme", industries: [] } }), "agency_requisition_code");
  const card = hiringActorCard("apify_linkedin_job_search")!;
  assert(card.purposes.includes("job_discovery") && card.purposes.includes("hiring_verification"));
  assert(card.known_defects.some((d) => d.id === "job_search_agency_postings"));
});

Deno.test("the discovery compiler refuses company[], requires freshness and bounds the multiplier", () => {
  assert(compileHarvestJobDiscoveryInput(GPT_JOB_INPUT as never).ok);
  assertFalse(compileHarvestJobDiscoveryInput({ ...GPT_JOB_INPUT, company: ["https://www.linkedin.com/company/x"] } as never).ok);
  assertFalse(compileHarvestJobDiscoveryInput({ ...GPT_JOB_INPUT, postedLimit: undefined } as never).ok);
  assertFalse(compileHarvestJobDiscoveryInput({ ...GPT_JOB_INPUT, jobTitles: ["a", "b", "c", "d"] } as never).ok);
  assertFalse(compileHarvestJobDiscoveryInput({ ...GPT_JOB_INPUT, maxItems: 500 } as never).ok);
  assertEquals(registeredEngineFields("apify_linkedin_job_search", "discovery"), {}, "discovery input is the planner's alone");
});

Deno.test("posting language and team rows answer 'first in the function' deterministically", () => {
  assertEquals(firstInFunctionPhrase(CANONICAL), "first growth marketer");
  assert(firstHireLanguage(FIRST_HIRE_ROW));
  assertEquals(PROBE_ROWS.filter((r) => firstHireLanguage(r)).length, 0);
  const vocab = { required_titles: ["growth marketer"] };
  assert(functionTitlesFor(vocab).includes("marketing"));
  const url = "https://www.linkedin.com/company/acme";
  assertEquals(teamFunctionMembers([{ currentPositions: [{ title: "Head of Marketing", companyLinkedinUrl: url, current: true }] }], url, vocab), ["Head of Marketing"]);
  assertEquals(teamFunctionMembers([{ currentPositions: [{ title: "Head of Marketing", companyLinkedinUrl: "https://www.linkedin.com/company/other", current: true }] }], url, vocab), []);
  assertEquals(teamFunctionMembers([{ currentPositions: [{ title: "CTO", companyLinkedinUrl: url, current: true }] }], url, vocab), []);
});

// ── the route ────────────────────────────────────────────────────────────────

Deno.test("the canonical mission is hiring-led: V2 enters through job discovery, never YC-first", () => {
  assert(hiringLedMission(MISSION));
  assert(firstInFunctionRequested(MISSION), "the user's 'first growth marketer' is carried on the hiring requirement");
  assertEquals(GRAPH.entry_capability, "job_discovery");
  assertEquals(GRAPH.steps.map((s) => s.capability), ["job_discovery", "job_deduplication", "company_identity_resolution",
    "company_enrichment", "hiring_verification", "company_brain_qualification", "persistence"]);
  assertFalse(GRAPH.allowed_providers.includes("apify_yc_companies_memo23"));
  // A first hire is a TARGET: read from the posting, never bought as a team lookup.
  assertFalse(GRAPH.steps.find((s) => s.capability === "hiring_verification")!.providers.includes("apify_linkedin_company_employees"),
    "no paid team lookup for a target");
  assertFalse(GRAPH.allowed_providers.includes("apify_linkedin_company_employees"));
  assertFalse(buildCapabilityGraph(MISSION).allowed_providers.includes("apify_linkedin_company_employees"),
    "legacy (V1) plans never carried the team lookup, and still do not");
  assert(assessRequestFeasibility(MISSION, GRAPH, { executability: "enforce" }).ok);
  assertEquals(buildCapabilityGraph(MISSION).entry_capability, "startup_company_discovery", "V1 plan unchanged");
  // Without "first", no team provider is granted.
  const plain = compileLeadMission({ originalUserQuery: "Find 1 B2B SaaS startup in the US hiring a growth marketer.", proposal }).final_mission;
  const plainGraph = buildCapabilityGraph(plain, { executability: "enforce" });
  assertEquals(plainGraph.entry_capability, "job_discovery");
  assertFalse(plainGraph.allowed_providers.includes("apify_linkedin_company_employees"));
});

Deno.test("the planner payload tells the truth about the job route (canary 357f93e8: a stale advisory made GPT return no steps)", () => {
  const payload = buildExecutionPlannerPayload(MISSION, GRAPH, { brain: null }) as Record<string, any>;
  const text = JSON.stringify(payload);
  assertFalse(text.includes("No registered Actor can DISCOVER"), "the pre-P3 advisory is gone on the job route");
  assertFalse(text.includes("company-scoped by contract"));
  assertFalse(/a general company index does not and\s+cannot prove/.test(text), "no startup-cohort veto on the job route");
  const advisories = (payload.execution_advisories ?? []) as string[];
  assert(advisories.some((a) => a.includes("WITHOUT `company` discovers employers")));
  assert(advisories.some((a) => a.includes("never a reason to plan fewer steps")));
  assert(advisories.some((a) => a.includes("'First in the function' is a target: it is read from the posting's own words")));
  for (const a of advisories) assertFalse(/\bcannot\b/i.test(a), `positive wording only: ${a}`);
  const job = payload.authorised_capabilities.find((c: { capability: string }) => c.capability === "job_discovery");
  assertEquals(job.actors.map((a: { actor_key: string }) => a.actor_key), ["apify_linkedin_job_search"], "uncarded boards are not offered");
  const actor = job.actors[0];
  assertFalse("company" in actor.input_contract.example, "the discovery example omits company");
  assert(String(actor.concept_discovery).includes("omit company"));
  // Legacy (V1) payload is untouched.
  const legacy = JSON.stringify(buildExecutionPlannerPayload(MISSION, buildCapabilityGraph(MISSION), { brain: null }));
  assert(legacy.includes("No registered Actor can DISCOVER"), "V1 prompt byte-for-byte as before");
});

Deno.test("GPT is briefed with the hiring actor card and its discovery guidance, not the YC cards", () => {
  const keys = authorisedActorKeys(buildExecutionPlannerPayload(MISSION, GRAPH, { brain: null }) as never);
  assert(keys.includes("apify_linkedin_job_search"));
  assertFalse(keys.includes("apify_yc_companies_memo23"));
  const entry = discoveryCatalogBriefing().find((e) => e.actor_key === "apify_linkedin_job_search") as Record<string, any>;
  assert(entry, "briefed for discovery");
  assert(String(entry.input_strategy?.discovery_pattern ?? JSON.stringify(entry)).includes("JOB-FIRST"));
});

Deno.test("job discovery sends GPT's JSON exactly, takes identity from the rows and never runs Company Search", async () => {
  const { sent, result } = await run();
  const jobs = byActor(sent, "apify_linkedin_job_search");
  assertEquals(jobs.length, 1, "one discovery call; no company-scoped re-search of the same employers");
  assertEquals(canonicalJson(jobs[0].input), canonicalJson(GPT_JOB_INPUT), "sent == GPT's actor-native JSON");
  assertEquals(canonicalJson(jobs[0].input), canonicalJson(jobs[0].spec!.serialized_input), "sent == spec");
  assertFalse("company" in jobs[0].input);
  const spec = jobs[0].spec as { purpose: string; provenance: Array<{ changed: boolean; changed_by: string; reason: string }>; route_id: string };
  assertEquals(spec.purpose, "discovery");
  assertEquals(spec.provenance.filter((p) => p.changed), [], "no field of GPT's discovery input was changed");
  assertEquals(result.state.retrieval_plans[0].anchors.primary, "hiring");

  assertEquals(byActor(sent, "apify_linkedin_company_search").length, 0, "every employer arrived identified");
  assertEquals(byActor(sent, "apify_yc_companies_memo23").length, 0);
  const keys = result.companies.map((c) => c.company.linkedin_company_url);
  for (const agency of ["aquent", "goodwin-hospitality-and-recruiting", "skill-recruiting", "scion-staffing"]) {
    assertFalse(keys.includes(`https://www.linkedin.com/company/${agency}`), `${agency} dropped before any paid stage`);
  }
  assertEquals(result.companies.length, 7, "6 non-agency probe employers + the first-hire employer");
  const dropped = result.state.provider_attempts.find((a: { outcome: string }) => a.outcome === "rows_dropped");
  assert(String(dropped?.reason).includes("staffing_agency"), JSON.stringify(dropped));
  const dedup = result.capability_outcomes.find((o) => o.capability === "job_deduplication");
  assertEquals(dedup?.status, "complete");
});

Deno.test("hiring verification buys nothing it holds; the team check runs only where the posting is silent", async () => {
  const { sent, result } = await run({ plan: TEAM_PLAN, readiness: TEAM_READY });
  const verificationSearches = byActor(sent, "apify_linkedin_job_search").filter((s) => "company" in s.input);
  assertEquals(verificationSearches.length, 0);
  const pipewise = result.companies.find((c) => c.company.linkedin_company_url === "https://www.linkedin.com/company/pipewise")!;
  assertEquals(pipewise.first_in_function?.source, "job_posting", "the posting's own words settle it — no team call");
  const team = byActor(sent, "apify_linkedin_company_employees");
  assertFalse(team.some((t) => (t.input.companies as string[])[0] === "https://www.linkedin.com/company/pipewise"));
  assertEquals(team.length, 2, "bounded to twice the requested count, and used");
  const checked = team.map((t) => (t.input.companies as string[])[0]);
  // Ordered by the DECLARED band: "nothing else" declares 0-1 (with 197 LinkedIn
  // members — the count that used to put it third), Entropy 11-50, Audicus
  // 51-200. Two checks, so Audicus is the one the bound leaves out.
  assertEquals(checked, ["https://www.linkedin.com/company/thenothingelse", "https://www.linkedin.com/company/useentropy"],
    "smallest declared band first; Pipewise was settled by its posting");
  const linkedin = result.companies.find((c) => c.company.linkedin_company_url === "https://www.linkedin.com/company/linkedin")!;
  assertFalse(checked.includes("https://www.linkedin.com/company/linkedin"));
  assert(linkedin.first_in_function === undefined || linkedin.first_in_function.source !== "team_composition");
  for (const t of team) {
    const c = result.companies.find((x) => x.company.linkedin_company_url === (t.input.companies as string[])[0])!;
    assert(c.enriched, "team checks run on enriched (shortlisted) companies only");
    assertEquals(c.first_in_function?.source, "team_composition");
    assertEquals(canonicalJson(t.input), canonicalJson(t.spec!.serialized_input));
    assert((t.spec as { provenance: Array<{ changed: boolean; reason: string }> }).provenance
      .filter((p) => p.changed).every((p) => p.reason.length > 0), "every engine-set field is recorded with a reason");
  }
});

Deno.test("companies found by the job search are never re-searched by paid hiring verification", () => {
  // Every probe posting is a Tier A match for this vocabulary, so the paid
  // path is unreachable in the engine test above; the guard is pinned here.
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url));
  assert(src.includes("const toCheck = targets.filter((t) => !jobSourced(t));"));
  const at = src.indexOf("const needsPaid:");
  const loop = src.slice(at, at + 2000);
  assert(loop.includes("for (const c of claimVerifierOwnsPaidHiring ? [] : toCheck) {"),
    "the paid loop iterates the filtered set — and nothing at all under the spec spine, where the claim verifier buys");
});

Deno.test("a continuation does not repeat the discovery purchase", async () => {
  const first = await run();
  const second = await run({ state: first.result.state });
  assertEquals(byActor(second.sent, "apify_linkedin_job_search").length, 0, JSON.stringify(second.sent.map((s) => s.actor)));
  assertEquals(second.result.state.retrieval_plans.length, first.result.state.retrieval_plans.length);
  const keys = second.result.state.spend_ledger.reservations
    .filter((r: { status: string }) => r.status === "executed" || r.status === "settled")
    .map((r: { idempotency_key: string }) => r.idempotency_key);
  assertEquals(new Set(keys).size, keys.length, "no key bought twice");
});

// ── what the live canary 03f4c9c6 taught ────────────────────────────────────

Deno.test("a first-hire TARGET buys no team lookup: the posting's words decide, nothing else is bought", async () => {
  const { sent, result } = await run();
  assertEquals(byActor(sent, "apify_linkedin_company_employees").length, 0);
  const pipewise = result.companies.find((c) => c.company.linkedin_company_url === "https://www.linkedin.com/company/pipewise")!;
  assertEquals(pipewise.first_in_function?.source, "job_posting", "still read from the posting");
  for (const c of result.companies) assert(c.first_in_function?.source !== "team_composition", String(c.company.company_name));
});

Deno.test("a team lookup the tool layer refuses is tried once, releases its reservation and blocks no company", async () => {
  const { sent, result } = await run({ plan: TEAM_PLAN, readiness: TEAM_READY }, { refuseTeam: true });
  assertEquals(byActor(sent, "apify_linkedin_company_employees").length, 1, "an unavailable provider is not retried per company");
  const team = result.state.spend_ledger.reservations.filter((r: { purpose: string }) => r.purpose === "hiring_evidence");
  assertEquals(team.map((r: { status: string }) => r.status), ["released"], "refused before any run: nothing booked");
  for (const c of result.companies) {
    assertFalse(c.stage_block?.capability === "hiring_verification", `${c.company.company_name} is not held back`);
    if (c.company.company_name === "Pipewise") continue;
    assertEquals(c.first_in_function?.status, "unverified");
    assert(String(c.first_in_function?.reason).includes("apify_actor_disabled_by_default"), String(c.first_in_function?.reason));
  }
});

Deno.test("a spent job-first pool widens by the next page on continuation, as a distinct purchase", async () => {
  const first = await run();
  const firstJob = byActor(first.sent, "apify_linkedin_job_search")[0];
  const again = await run({ state: first.result.state,
    discoveryReplenishment: { reason: "replenishment_required", sources_attempted: ["apify_linkedin_job_search"], pages_taken: {} } });
  const jobs = byActor(again.sent, "apify_linkedin_job_search");
  assertEquals(jobs.length, 1);
  assertEquals(canonicalJson(jobs[0].input), canonicalJson({ ...GPT_JOB_INPUT, page: 2 }), "only the page moved");
  assert((jobs[0].spec as { idempotency_key: string }).idempotency_key !== (firstJob.spec as { idempotency_key: string }).idempotency_key,
    "page 2 is not mistaken for the page already bought");
  assertEquals(again.result.state.discovery_source_state?.pages_taken?.apify_linkedin_job_search, 2);
});

Deno.test("the first-hire check still runs when GPT's chain omits hiring verification (canary 2a215d44)", async () => {
  const { sent, result } = await run({ plan: TEAM_PLAN, readiness: TEAM_READY }, { chainOmitsHiring: true });
  assertEquals(byActor(sent, "apify_linkedin_job_search").length, 1, "no paid job re-search is added back");
  assertEquals(byActor(sent, "apify_linkedin_company_employees").length, 2, "the bounded team checks run");
  const hv = result.capability_outcomes.find((o) => o.capability === "hiring_verification");
  assert(hv?.status !== "skipped_no_input", JSON.stringify(hv));
  // And without a first-hire request the chain's skip is honoured exactly as before.
  const plain = compileLeadMission({ originalUserQuery: "Find 1 B2B SaaS startup in the US hiring a growth marketer.", proposal }).final_mission;
  const plainRun = await run({ mission: plain, plan: buildCapabilityGraph(plain, { executability: "enforce" }) }, { chainOmitsHiring: true });
  assertEquals(plainRun.result.capability_outcomes.find((o) => o.capability === "hiring_verification")?.status, "skipped_no_input");
  assertEquals(byActor(plainRun.sent, "apify_linkedin_company_employees").length, 0);
});

// ── P3 freeze: the Company Brain's enforced size rule is visible, not hidden ──

import { criteriaSections, deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { compileCompanyBrainContext } from "../../../supabase/functions/_shared/companyBrainCompiler.ts";

Deno.test("an explicit numeric Company Brain size is a hard Brain rule on the card, not a hidden filter (canary 2a215d44)", () => {
  // Compiled the way pilot-chat compiles: Brain merged, then criteria derived.
  const policy = compileLeadMission({ originalUserQuery: CANONICAL, proposal, companyBrain: { employee_min: 1, employee_max: 150, employee_policy: true } }).final_mission;
  assertEquals(policy.field_provenance["company_profile.employee_range"], "company_brain_policy");
  const size = deriveMissionCriteria(policy).find((c) => c.dimension === "company_size")!;
  assertEquals([size.kind, size.source], ["hard", "company_brain_policy"]);
  const hard = criteriaSections(policy).hard;
  assert(hard.some((l) => l.includes("Company size: 1–150") && l.includes("Company Brain rule")), JSON.stringify(hard));
  assert(criteriaExecutionPolicy(policy).dimensions.company_size.may_reject,
    "the run's enforced size rule and the criteria agree");
  // A Brain size band that is NOT an enforced rule stays a preference.
  const pref = compileLeadMission({ originalUserQuery: CANONICAL, proposal, companyBrain: { employee_min: 1, employee_max: 150 } }).final_mission;
  const prefSize = deriveMissionCriteria(pref).find((c) => c.dimension === "company_size")!;
  assertEquals([prefSize.kind, prefSize.source], ["target", "company_brain_preference"]);
  // Pilot derives the rule with the SAME compiler run-agent enforces from. The
  // live Brain stores a LABEL, not numbers (canary 1fb4e5b3 card showed no size
  // while execution enforced 1–150): the label must still reach the card.
  const pilot = Deno.readTextFileSync(new URL("../../../supabase/functions/pilot-chat/index.ts", import.meta.url));
  assert(/compileCompanyBrainContext\(\{ workspace_id: "", profile: brain as Record<string, unknown> \}\)\.icp/.test(pilot));
  assert(pilot.includes("companyBrainContextForCompiler({ ...profile, icp })"), "the card passes the whole profile");
  const runAgent = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(runAgent.includes("compileCompanyBrainContext({ workspace_id, profile: brain as unknown as Record<string, unknown> })"));
  const labelled = compileCompanyBrainContext({ workspace_id: "", profile: { icp: { company_size: "Founder-led to early-stage teams; lean GTM or recruiting ops" } } }).icp;
  assertEquals([labelled.company_size_min, labelled.company_size_max], [1, 150]);
});

Deno.test("PRODUCTION: a planned team lookup is refused by readiness before any call is sent", async () => {
  const { sent, result } = await run({ plan: TEAM_PLAN });
  assertEquals(byActor(sent, "apify_linkedin_company_employees").length, 0, "never sent");
  const refused = (result.state.provider_attempts as Array<Record<string, unknown>>)
    .filter((a) => a.provider === "apify_linkedin_company_employees");
  assert(refused.length > 0 && refused.every((a) => a.outcome === "refused_policy" && String(a.reason).startsWith("route_not_ready")),
    JSON.stringify(refused));
});

Deno.test("a first-hire TARGET schedules no team lookup even were the team actor READY — the target rule, not readiness", () => {
  const plan = buildCapabilityGraph(MISSION, { executability: "enforce",
    readiness: readinessPolicy({ overrides: { "apify_linkedin_company_employees|hiring_verification": "READY" } }) });
  assert(firstInFunctionRequested(MISSION), "this mission does ask for a first hire");
  assertFalse(plan.allowed_providers.includes("apify_linkedin_company_employees"));
  assertFalse(plan.steps.some((st) => st.providers.includes("apify_linkedin_company_employees")));
});
