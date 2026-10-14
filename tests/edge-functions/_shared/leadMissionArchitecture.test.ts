// LOCK THE MISSION, NOT THE INDIVIDUAL ACTOR.
//
// One typed mission, interpreted once, executed deterministically. These tests
// are written against the exact failure they replace: TEST task
// 8af17651-5fa2-48e2-af87-4bc923146243, where the user asked for founders of
// SaaS startups and the system ran harvestapi/linkedin-company-search (0 rows)
// then two broad LinkedIn Jobs rounds — 50 raw jobs, 20 companies, 0 leads.
//
// ZERO network, ZERO Actor runs, ZERO model calls, ZERO database writes.

import { assert, assertEquals, assertFalse, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LEAD_MISSION_VERSION, isLeadMissionV1, mergeCompanyBrainIntoMission,
  parseLeadMissionDeterministic, validateLeadMission, type LeadMissionV1,
} from "../../../supabase/functions/_shared/leadMission.ts";
import {
  CAPABILITY_REGISTRY, CapabilityContainmentError, assertProviderAllowed,
  buildCapabilityGraph, isCapabilityId, isProviderAllowed, isProviderAllowedForCapability,
  onCapabilityExhausted,
} from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import {
  legacyLoopReachable, missionRouteRequest, readPersistedLeadMission,
} from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import {
  evaluateCompanyBrainEvidence, industryFamilies,
} from "../../../supabase/functions/_shared/companyIcpFilter.ts";

const CANONICAL =
  "Find founders of SaaS startups hiring Sales Operations in the United States. Return 5 qualified leads.";

/** Verbatim `tasks.payload.instruction` from the failed task — the rewrite. */
const PLANNER_REWRITE =
  "Find 5 jobs matching: Sales Operations OR Revenue Operations OR GTM Operations OR " +
  "Revenue Strategy and Operations OR Sales Strategy and Operations in USA " +
  "(roles: Sales Operations, Revenue Operations, GTM Operations)";

/** The workspace Brain from that run. Note the third industry. */
const BRAIN = {
  industries: ["B2B SaaS", "AI SaaS", "Recruiting Agencies"],
  employee_min: 10,
  employee_max: 150,
};

function canonicalMission(): LeadMissionV1 {
  return parseLeadMissionDeterministic(CANONICAL);
}

// ═══════════════════════════════════════════════ 1. the canonical mission ══

Deno.test("1. the canonical query produces a startup-first company mission", () => {
  const m = canonicalMission();
  assertEquals(m.version, LEAD_MISSION_VERSION);
  assertEquals(m.original_user_query, CANONICAL);
  assertEquals(m.mission_type, "qualified_lead_sourcing");
  assertEquals(m.target_entity, "person");
  assertEquals(m.requested_output, "contact_ready_leads");
  assertEquals(m.requested_count, 5);
  assert(m.company_profile.verticals.includes("saas"));
  assertEquals(m.company_profile.stages, ["startup"]);
  assertEquals(m.company_profile.locations, ["United States"]);
  assertEquals(m.decision_makers.roles, ["Founder", "Co-Founder", "CEO"]);
  assert(m.decision_makers.current_employment_required);
  const hiring = m.required_signals.find((s) => s.type === "hiring");
  assert(hiring, "the hiring signal must be required");
  // THE CANONICAL FAMILY NAME, not the old marker-table shorthand.
  //
  // The structured reader resolves a role against `ROLE_FAMILY_ALIASES` — the
  // one table the title filter and the actor input planner already match
  // against — so it emits `sales_operations` rather than `sales_ops`. Both are
  // legal mission keys (`MISSION_FAMILY_TO_CANONICAL` carries identity entries
  // for the canonical names), and the canonical one is the better answer: it is
  // the same string the rest of the funnel compares titles with.
  assertEquals(hiring!.role_families, ["sales_operations"]);

  // The requirement is now structured, not just named.
  assertEquals(hiring!.event, "hiring");
  assertEquals(hiring!.subject, "company");
  assertEquals(hiring!.qualifier?.role_families, ["sales_operations"]);
});

Deno.test("1b. its capability graph is startup-first, enriches before qualifying", () => {
  const plan = buildCapabilityGraph(canonicalMission());
  const order = plan.steps.map((s) => s.capability);

  assertEquals(plan.entry_capability, "startup_company_discovery");
  assertEquals(order[0], "startup_company_discovery");

  // memo23 PRIMARY, solidcode FALLBACK, LinkedIn company search BREADTH.
  // The third is what lets a mission Y Combinator cannot answer — manufacturers,
  // agencies, engineering firms — reach a source that can. It is last because it
  // is the only one whose catalog entry records that its query matches company
  // NAMES rather than concepts.
  assertEquals(plan.steps[0].providers, [
    "apify_yc_companies_memo23", "apify_yc_companies_solidcode",
    "apify_linkedin_company_search",
  ]);

  // Enrichment strictly BEFORE qualification.
  const enrich = order.indexOf("company_enrichment");
  const qualify = order.indexOf("company_brain_qualification");
  assert(enrich >= 0 && qualify >= 0, "both capabilities must be present");
  assert(enrich < qualify, "enrichment must precede Company Brain qualification");

  // FOUNDER DISCOVERY IS ABSENT. It is an offer, not a step — the graph never
  // schedules a people Actor, so "after qualification" is no longer a question
  // the plan can answer.
  assertEquals(order.indexOf("founder_discovery"), -1,
    "founder discovery must not appear in an automatic graph");
  assertEquals(order.indexOf("employer_verification"), -1);
  assertEquals(order.indexOf("contact_enrichment"), -1);
  // `offer_deep_company_research` is also an offer and also never a step: deep
  // website research is a DEPTH upgrade on a company that already qualified,
  // not part of qualifying it. The three assertions above still hold — no
  // people or contact capability appears in `order`.
  assertEquals(plan.offered_capabilities,
    ["offer_founder_unlock", "offer_contact_unlock", "offer_deep_company_research"],
    "the people work and the deep research are surfaced as offers instead");

  // And the full expected chain is present, in order.
  for (const [a, b] of [
    ["startup_company_discovery", "company_identity_resolution"],
    ["company_identity_resolution", "company_enrichment"],
    ["company_enrichment", "hiring_verification"],
    ["hiring_verification", "company_brain_qualification"],
    ["company_brain_qualification", "persistence"],
  ]) {
    assert(order.indexOf(a) < order.indexOf(b), `${a} must precede ${b}`);
  }
});

// ══════════════════════════════════════════ 2. rewrites cannot alter it ══

Deno.test("2. a planner rewrite cannot alter the stored mission", () => {
  const m = canonicalMission();
  // The model returns the rewrite as if it were the goal, and asks for jobs.
  const v = validateLeadMission({
    original_user_query: PLANNER_REWRITE,      // ← attempts to restate the goal
    mission_type: "job_research",
    target_entity: "job",
    requested_output: "job_listings",
    requested_count: 5,
    company_profile: { verticals: [], stages: [] },
    required_signals: [{ type: "hiring" }],
    decision_makers: { roles: [] },
  }, { originalUserQuery: CANONICAL, isCapabilityId });

  // ── WHAT IS STILL DEFENDED ────────────────────────────────────────────────
  // The defence that closes the 8af17651 failure is that the model may not
  // restate the GOAL. It cannot, and this is the assertion that says so.
  assertEquals(v.mission.original_user_query, CANONICAL,
    "the user's query is immutable and never taken from the model");

  // ── WHAT R2's CUTOVER CHANGED ─────────────────────────────────────────────
  //
  // `requested_output` / `target_entity` / `mission_type` used to be overwritten
  // from the deterministic reading whenever the two differed, so a keyword scan
  // — "lead"/"contact"/a founder word in the sentence — decided what the run was
  // FOR, outranking a model that had read it. Those three now stand as the model
  // stated them, and the disagreement is recorded instead of resolved.
  //
  // This is a REAL trade. Here it means a model that answers `job_listings` for
  // a founders query is obeyed, where the marker table used to catch it. What
  // makes that the right side of the trade is that the model reads the user's
  // own sentence (immutable, above) rather than a rewrite, gets bounded retries,
  // and refuses rather than degrading — so a wrong answer here is a model
  // failure to fix, not a second interpreter to keep.
  assertEquals(v.mission.requested_output, "job_listings",
    "the model's reading of what was asked for now stands");
  assertEquals(v.mission.target_entity, "job");
  assert(v.repairs.some((r) => r.startsWith("output_intent_disagreement:")),
    "and the disagreement with the deterministic reading is recorded, not silent");
  assert(v.repairs.some((r) => r.startsWith("target_entity_disagreement:")));

  // The CONSTRAINT half of the mission is untouched by that change: a model
  // cannot widen or substitute a target the user's words state (tests 7 and 24
  // in leadMissionCompiler.test.ts), and a mission that names startups still
  // enters at startup discovery.
  assertEquals(buildCapabilityGraph(m).entry_capability, "startup_company_discovery");
});

Deno.test("2b. a model cannot smuggle an Actor id in as a capability", () => {
  const v = validateLeadMission({
    required_capabilities: [
      "startup_company_discovery",
      "memo23/y-combinator-scraper",     // ← a raw provider id
      "apify_indeed_jobs_automation_lab",
    ],
  }, { originalUserQuery: CANONICAL, isCapabilityId });

  assertEquals(v.mission.required_capabilities, ["startup_company_discovery"]);
  assert(v.repairs.includes("non_capability_dropped:memo23/y-combinator-scraper"));
  assert(v.repairs.includes("non_capability_dropped:apify_indeed_jobs_automation_lab"));
});

// ══════════════════════════════════ 3. the Brain cannot broaden a request ══

Deno.test("3. Company Brain cannot broaden SaaS startups into Recruiting Agencies", () => {
  const merged = mergeCompanyBrainIntoMission(canonicalMission(), BRAIN);

  assertFalse(merged.mission.company_profile.verticals.includes("recruiting agencies"),
    "the user did not ask for recruiting agencies");
  const rejected = merged.rejected_broadening.find(
    (r) => r.field === "company_profile.verticals");
  assert(rejected, "the refusal must be recorded, not silent");
  assert(rejected!.values.includes("recruiting agencies"));

  // The two SaaS entries ARE compatible refinements and may be applied.
  assert(merged.mission.company_profile.verticals.some((v) => v.includes("saas")));

  // Size was left open by the user, so the Brain legitimately FILLS it.
  assertEquals(merged.mission.company_profile.employee_range, { min: 10, max: 150 });
  assertEquals(merged.mission.field_provenance["company_profile.employee_range"], "company_brain");
  // …and the user's own fields keep their stronger provenance.
  assertEquals(merged.mission.field_provenance["company_profile.verticals"], "explicit_user_request");
});

Deno.test("3b. the Brain fills a field the user left open", () => {
  const open = parseLeadMissionDeterministic("Find 5 founders hiring Sales Operations");
  assertEquals(open.company_profile.verticals, []);
  const merged = mergeCompanyBrainIntoMission(open, BRAIN);
  assertEquals(merged.mission.company_profile.verticals,
    ["b2b saas", "ai saas", "recruiting agencies"]);
  assertEquals(merged.mission.field_provenance["company_profile.verticals"], "company_brain");
  assertEquals(merged.rejected_broadening.length, 0);
});

// ═══════════════════════════════ 4/5. one authority, preview and backend ══

Deno.test("4. preview and backend consume the exact same mission object", async () => {
  const view = await Deno.readTextFile(
    new URL("../../../src/lib/leadMission/missionView.ts", import.meta.url));
  const card = await Deno.readTextFile(
    new URL("../../../src/components/chat/workspace/bubbles/WorkflowConfirmationCard.tsx", import.meta.url));
  const contract = await Deno.readTextFile(
    new URL("../../../src/lib/qualifiedLead/contract.ts", import.meta.url));

  assert(view.includes("required_capabilities"),
    "the preview must READ the capabilities the mission carries");
  assertFalse(/buildCapabilityGraph/.test(view),
    "the preview must not rebuild the graph — that is a second authority");
  assert(card.includes("payload.lead_mission") || card.includes("lead_mission"),
    "the card must render from the mission");
  assert(card.includes("missionRows(mission)"), "the card renders mission rows");
  assert(contract.includes("lead_mission:"),
    "Start Workflow must carry the mission to orchestrate");
});

Deno.test("5. no second route inference occurs for a LeadMissionV1 task", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));

  assert(src.includes("const persistedMission = readPersistedLeadMission("),
    "run-agent must look for a persisted mission");
  assert(src.includes("const routeUserRequest: string | null = persistedMission"),
    "a mission task must not build the carrier union");
  assert(src.includes("? persistedMission.original_user_query"),
    "a mission task routes from the immutable query only");
  assert(src.includes("...missionRouteRequest(persistedMission)"),
    "the route must be TRANSLATED from the mission, never re-inferred");
  // The compatibility branch still exists, and only in the else.
  assert(src.includes("inferRouteFromRequest(routeUserRequest)"),
    "carrier inference survives for pre-mission tasks");
  assert(src.includes('authority: persistedMission ? "lead_mission_v1" : "legacy_carrier_union"'),
    "which authority ran must be observable");
});

// ═══════════════════════════════════════════ 6/7. containment invariants ══

Deno.test("6. a non-job mission cannot reach LinkedIn Cookies, Jobs, Indeed or Glassdoor", () => {
  const plan = buildCapabilityGraph(canonicalMission());
  for (const forbidden of [
    "apify_jobs",                          // broad LinkedIn Jobs
    "apify_linkedin_jobs_crawlworks",
    "apify_indeed_jobs_automation_lab",    // Indeed
    "apify_glassdoor_jobs",                // Glassdoor
  ]) {
    assertFalse(isProviderAllowed(plan, forbidden), `${forbidden} must be unreachable`);
    const err = assertThrows(
      () => assertProviderAllowed(plan, forbidden),
      CapabilityContainmentError,
    );
    assert(String(err.message).length > 0);
  }
  // The approved ones ARE reachable.
  for (const allowed of [
    "apify_yc_companies_memo23", "apify_yc_companies_solidcode",
    "apify_linkedin_company_details", "apify_linkedin_job_search",
  ]) {
    assert(isProviderAllowed(plan, allowed), `${allowed} must be reachable`);
  }
  // THE PEOPLE ACTOR MOVED SIDES. It used to be on the approved list above,
  // because founder discovery was a step in every people-shaped mission. It is
  // an OFFER now, so its Actor is outside this plan entirely and the same
  // containment assertion that refuses Indeed refuses it too.
  assertFalse(isProviderAllowed(plan, "apify_linkedin_company_employees"),
    "the people Actor is unreachable until an explicit unlock");
  assertThrows(
    () => assertProviderAllowed(plan, "apify_linkedin_company_employees"),
    CapabilityContainmentError,
  );
});

// `apify_linkedin_company_search` USED to be on the forbidden list above, as
// "LinkedIn Cookies initial discovery" — the actor that returned 0 rows when a
// startup mission was misrouted to `general_company_discovery`.
//
// It is now the CORRECT provider for `company_identity_resolution`: the search
// Actor searches, and `apify_linkedin_company_details` enriches a URL it is
// given. Plan-wide containment cannot express that distinction, and its
// inability to is exactly why identity resolution was able to call the
// enrichment Actor with `{searches:[name]}` sixteen times for nothing.
//
// So the guarantee is not dropped, it is SHARPENED: the question is no longer
// "may this mission use this Actor?" but "may THIS STEP use it?".
Deno.test("6b. a provider may only be used by the capability that declares it", () => {
  const plan = buildCapabilityGraph(canonicalMission());

  // Reachable by the mission, and correct for identity resolution.
  assert(isProviderAllowed(plan, "apify_linkedin_company_search"));
  assert(isProviderAllowedForCapability(
    plan, "apify_linkedin_company_search", "company_identity_resolution"));

  // The exact defect: identity resolution reaching for the ENRICHMENT actor.
  assertFalse(isProviderAllowedForCapability(
    plan, "apify_linkedin_company_details", "company_identity_resolution"),
    "the enrichment Actor is not a name-search index");
  const err = assertThrows(
    () => assertProviderAllowed(plan, "apify_linkedin_company_details",
      { capability: "company_identity_resolution" }),
    CapabilityContainmentError,
  );
  assert(String(err.message).includes("company_identity_resolution"));

  // ...and the mirror image: enrichment may not run the search Actor.
  assertFalse(isProviderAllowedForCapability(
    plan, "apify_linkedin_company_search", "company_enrichment"));

  // Each declared pairing still holds.
  assert(isProviderAllowedForCapability(
    plan, "apify_linkedin_company_details", "company_enrichment"));
  assert(isProviderAllowedForCapability(
    plan, "apify_yc_companies_memo23", "startup_company_discovery"));

  // A capability that is not in this plan falls back to the plan-wide answer
  // rather than failing open on a typo.
  assertFalse(isProviderAllowedForCapability(plan, "apify_jobs", "job_discovery"));
});

Deno.test("7. zero YC results do not silently trigger broad job discovery", () => {
  const plan = buildCapabilityGraph(canonicalMission());

  // memo23 returned nothing → solidcode is the ALLOWED next move.
  const first = onCapabilityExhausted(plan, "startup_company_discovery", ["apify_yc_companies_memo23"]);
  assertEquals(first.status, "provider_fallback_available");
  assertEquals(first.next_provider, "apify_yc_companies_solidcode");

  // Every DECLARED provider exhausted → EXHAUSTED, an explicit reportable
  // state. Not a job board.
  //
  // The list includes the LinkedIn company search because the capability now
  // declares it. Note what the engine does with this: exhaustion there is
  // measured against the STRATEGY, not this permission list, so a run whose
  // strategy never selected an actor does not report it as an untried fallback
  // waiting to be spent on.
  const both = onCapabilityExhausted(plan, "startup_company_discovery",
    ["apify_yc_companies_memo23", "apify_yc_companies_solidcode",
      "apify_linkedin_company_search"]);
  assertEquals(both.status, "exhausted");
  assertEquals(both.next_provider, null);
  assert(both.reason.includes("rather than sourcing outside its graph"));

  // And the boundary still refuses, however little was found.
  assertThrows(() => assertProviderAllowed(plan, "apify_jobs"), CapabilityContainmentError);
});

Deno.test("7b. the legacy loop is unreachable for a mission without job_discovery", () => {
  const m = canonicalMission();
  const plan = buildCapabilityGraph(m);
  const r = legacyLoopReachable(m, plan);
  assertFalse(r.reachable);
  assert(r.reason.startsWith("mission_graph_excludes_job_discovery"));

  // A pre-mission task keeps the old behaviour.
  assert(legacyLoopReachable(null, null).reachable);
});

Deno.test("7c. run-agent blocks the legacy loop before it can justify itself", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(src.includes("const missionLegacy = legacyLoopReachable(persistedMission, missionPlan);"));
  assert(src.includes("legacySkipReason = `lead_mission_forbids_broad_job_sourcing:"));
  // The mission check must come BEFORE the derived-reason path, or the reason
  // path could re-open the door.
  const guard = src.indexOf("const missionLegacy = legacyLoopReachable");
  const derived = src.indexOf("const candidateReason = companyFirstRoute === null");
  assert(guard > 0 && derived > 0 && guard < derived,
    "the mission guard must precede the legacy fallback-reason derivation");
});

// ══════════════════════════════════════════ 8/9/10. different graph shapes ══

Deno.test("8. a known-company query skips discovery entirely", () => {
  const m = parseLeadMissionDeterministic(
    "Enrich these companies: intelligems.io, sortly.com, harmonic.security");
  assertEquals(m.mission_type, "known_company_enrichment");
  assertEquals(m.company_profile.known_companies,
    ["intelligems.io", "sortly.com", "harmonic.security"]);

  const plan = buildCapabilityGraph(m);
  assertEquals(plan.entry_capability, "known_company_resolution");
  const order = plan.steps.map((s) => s.capability);
  for (const discovery of [
    "startup_company_discovery", "general_company_discovery", "job_discovery",
  ]) {
    assertFalse(order.includes(discovery), `${discovery} must not run for supplied companies`);
  }
  assert(order.includes("company_enrichment"));
});

Deno.test("9. a job-output query IS allowed to use job discovery", () => {
  const m = parseLeadMissionDeterministic("Find 100 Sales Operations jobs in the United States");
  assertEquals(m.requested_output, "job_listings");
  assertEquals(m.target_entity, "job");
  assertEquals(m.requested_count, 100);

  const plan = buildCapabilityGraph(m);
  assertEquals(plan.entry_capability, "job_discovery");
  assert(isProviderAllowed(plan, "apify_jobs"));
  assert(isProviderAllowed(plan, "apify_indeed_jobs_automation_lab"));
  assert(plan.steps.some((s) => s.capability === "job_deduplication"));
  // A job mission legitimately reaches the broad-job route, WITH a reason.
  assertEquals(missionRouteRequest(m), {
    route: "broad_job_fallback", fallback_reason: "user_requested_broad_coverage",
  });
  // …and the legacy loop is therefore reachable for it.
  assert(legacyLoopReachable(m, plan).reachable);
});

Deno.test("10. a funding or expansion signal never routes discovery into a stage that cannot discover", () => {
  // ── WHAT THIS TEST USED TO ASSERT, AND WHY IT WAS BACKWARDS ───────────────
  //
  // It required `entry_capability` to be `funding_signal_discovery` and
  // `expansion_signal_discovery`, on the reasonable-sounding principle that a
  // signal should shape the graph. The consequence was the worst outcome the
  // graph can produce.
  //
  // `ENGINE_DRIVEN_DISCOVERY` contains only `startup_company_discovery` and
  // `general_company_discovery`. Every other discovery capability is reported
  // `skipped_no_input`. So entering at a signal stage meant the ENTRY step was
  // skipped, discovery never ran, and the mission returned zero companies —
  // while the signal was reported as covered.
  //
  // It also inverted precedence: `hasSignal(expansion)` was tested before the
  // profile branches, so asking for MORE evidence about industrial companies
  // made the run worse at finding industrial companies.
  //
  // Both capabilities are now `supported: false` in the registry, with the
  // verified reason their providers cannot keep the claim.
  const funding = parseLeadMissionDeterministic(
    "Find recently funded cybersecurity companies and their CEOs");
  assert(funding.required_signals.some((s) => s.type === "funding"));
  const fPlan = buildCapabilityGraph(funding);

  // ── PHASE 4: THE FUNDING ENTRY IS REAL NOW ────────────────────────────────
  //
  // This asserted `general_company_discovery` while funding discovery was a
  // stage the engine skipped. With a provider that returns dated funding events
  // and an engine branch that drives it, entering through funding is the RIGHT
  // plan for a funding-shaped mission: it discovers by the round and carries the
  // event forward as evidence.
  assertEquals(fPlan.entry_capability, "funding_signal_discovery");
  assert(fPlan.steps.map((s) => s.capability).includes("funding_signal_discovery"));
  // Enrichment still precedes qualification: a company that raised is not
  // thereby shown to fit the ICP.
  const fOrder = fPlan.steps.map((s) => s.capability);
  assert(fOrder.indexOf("company_enrichment") < fOrder.indexOf("company_brain_qualification"));

  // UNCHANGED: people are offered, never purchased.
  assertFalse(fPlan.steps.map((s) => s.capability).includes("founder_discovery"));
  assert(fPlan.offered_capabilities.includes("offer_founder_unlock"));
  assertFalse(isProviderAllowed(fPlan, "apify_jobs"));

  const expansion = parseLeadMissionDeterministic(
    "Find industrial companies expanding into Europe and their owners");
  assert(expansion.required_signals.some((s) => s.type === "expansion"));
  // ── PHASE 5: EXPANSION BECAME REAL ────────────────────────────────────────
  //
  // This asserted a fallthrough to profile discovery while expansion's declared
  // providers were a company-NAME matcher and a JOB search — neither of which
  // can state that a company entered a market. Both stages now run the carded
  // news source, so entering through expansion is the right plan.
  const ePlan = buildCapabilityGraph(expansion);
  assertEquals(ePlan.entry_capability, "expansion_signal_discovery");

  const eOrder = ePlan.steps.map((s) => s.capability);
  assert(eOrder.includes("expansion_signal_verification"));
  // THE OLD PROVIDER IS GONE. A job's location must never stand as proof that a
  // company entered a market.
  assertFalse(
    CAPABILITY_REGISTRY.expansion_signal_verification.providers
      .includes("apify_linkedin_job_search"),
    "a job search may never be an expansion verifier",
  );

  // UNCHANGED: enrichment still precedes qualification.
  assert(eOrder.indexOf("company_enrichment") < eOrder.indexOf("company_brain_qualification"));
});

// ═════════════════════════════════════ 11/12. three-valued qualification ══

const SAAS_ICP = {
  positive_industries: ["b2b saas", "ai saas"],
  business_models: ["b2b saas"],
  min_employees: 10,
  max_employees: 150,
};

Deno.test('11. "Software Development" WITH SaaS evidence can pass', () => {
  const r = evaluateCompanyBrainEvidence({
    company: "Sortly",
    industry: "Software Development",
    description: "Sortly is a SaaS inventory platform sold on a subscription to businesses.",
    employee_count: 97,
  }, SAAS_ICP);
  const industry = r.results.find((x) => x.constraint === "industry");
  assertEquals(industry?.outcome, "pass", industry?.reason);
  assertFalse(r.failedConstraints.includes("industry"));
});

Deno.test('12. "Software Development" with NO model evidence is UNKNOWN, not FAIL', () => {
  const r = evaluateCompanyBrainEvidence({
    company: "Harmonic Security",
    industry: "Software Development",
    employee_count: 77,
  }, SAAS_ICP);
  const industry = r.results.find((x) => x.constraint === "industry");
  assertEquals(industry?.outcome, "unknown", industry?.reason);
  assertFalse(r.failedConstraints.includes("industry"),
    "insufficient evidence is not a proven mismatch — this is the false-negative fix");
  assert(r.unknownConstraints.includes("industry"));

  const model = r.results.find((x) => x.constraint === "business_model");
  assertEquals(model?.outcome, "unknown");
});

Deno.test("12b. a genuinely different sector still FAILS", () => {
  const r = evaluateCompanyBrainEvidence({
    company: "ForceBrands",
    industry: "Staffing and Recruiting",
    description: "Executive search for food and beverage brands.",
    employee_count: 120,
  }, SAAS_ICP);
  const industry = r.results.find((x) => x.constraint === "industry");
  assertEquals(industry?.outcome, "fail",
    "contradictory evidence must still reject — the fix must not make the gate toothless");
  assert(r.failedConstraints.includes("industry"));
});

Deno.test("12c. industry families separate contradiction from coarseness", () => {
  assertEquals(industryFamilies("Software Development"), ["software"]);
  assertEquals(industryFamilies("B2B SaaS"), ["software"]);
  assertEquals(industryFamilies("Restaurants"), ["hospitality"]);
  assertEquals(industryFamilies("Staffing and Recruiting"), ["staffing"]);
  // An unrecognised label evidences nothing, which is UNKNOWN rather than FAIL.
  assertEquals(industryFamilies("Miscellaneous"), []);
  assertEquals(industryFamilies(""), []);
});

// ══════════════════════════════════════════════ 13/14/15. runtime plumbing ══

Deno.test("13. resume reads the persisted mission and never re-interprets", () => {
  const m = canonicalMission();
  // The shapes run-agent actually receives, in authority order.
  assertEquals(readPersistedLeadMission({ lead_mission: m }), m);
  assertEquals(readPersistedLeadMission({ qualified_lead_plan: { lead_mission: m } }), m);
  assertEquals(readPersistedLeadMission(null, m), m);
  // A malformed mission is ABSENT, not half-executed.
  assertEquals(readPersistedLeadMission({ lead_mission: { version: "lead-mission-v9" } }), null);
  assertEquals(readPersistedLeadMission({ lead_mission: { version: LEAD_MISSION_VERSION } }), null);
  assertEquals(readPersistedLeadMission(null, undefined), null);
  // Round-trip through JSON, which is how it is actually stored.
  const revived = readPersistedLeadMission({ lead_mission: JSON.parse(JSON.stringify(m)) });
  assert(revived && isLeadMissionV1(revived));
  assertEquals(revived!.original_user_query, CANONICAL);
});

Deno.test("14. mission, graph, providers and route telemetry are PERSISTED", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  // The PERSISTED result block, not the HTTP response. Anchored on a key that
  // only the persisted block carries, then bounded by that block's own update.
  const start = src.indexOf("sequential_source_execution: sequentialSourceDiagnostics");
  assert(start > 0, "the persisted telemetry block must exist");
  // The slice-result write, fenced since D1: its block ends where its outcome is read.
  const end = src.indexOf("const sliceResultError = sliceResultWrite.error;", start);
  assert(end > start, "the persisted block must end in a task update");
  const persisted = src.slice(start, end);
  for (const key of [
    "original_user_query:", "lead_mission:", "lead_mission_version:",
    "mission_authority:", "field_provenance:", "capability_graph:",
    "legacy_loop_containment:", "hiring_route:",
  ]) {
    assert(persisted.includes(key), `${key} must be persisted on the task result`);
  }
  assert(persisted.includes("allowed_providers: missionPlan.allowed_providers"),
    "the providers the mission authorised must be persisted");
  assert(persisted.includes("estimated_cost_units"), "cost forecast must be persisted");
});

Deno.test("15. an old task with no mission still uses the carrier union", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  // All four legacy carriers remain in the compatibility branch.
  for (const carrier of [
    "tool_input_body?.user_request as string | undefined",
    "input ?? undefined",
    "instruction,",
    "tool_input_body?.query as string | undefined",
  ]) {
    assert(src.includes(carrier), `${carrier} must survive for pre-mission tasks`);
  }
  // And nothing about a missing mission throws.
  assertEquals(readPersistedLeadMission({ query: "anything" }), null);
  assertEquals(legacyLoopReachable(null, null).reason, "legacy_task_without_mission");
});

// ═══════════════════════════════════════════════════ registry invariants ══

Deno.test("the provider registry maps capabilities to the approved Actors", () => {
  assertEquals(CAPABILITY_REGISTRY.startup_company_discovery.providers,
    ["apify_yc_companies_memo23", "apify_yc_companies_solidcode",
      "apify_linkedin_company_search"]);
  // THE SAME DISCOVERY UNIVERSE AS THE STARTUP ENTRY. A single-provider
  // capability is not a permission list, it is a forced move — see the note on
  // the spec itself.
  assertEquals(CAPABILITY_REGISTRY.general_company_discovery.providers,
    ["apify_yc_companies_memo23", "apify_yc_companies_solidcode",
      "apify_linkedin_company_search"]);
  assertEquals(CAPABILITY_REGISTRY.company_enrichment.providers,
    ["apify_linkedin_company_details"]);
  assertEquals(CAPABILITY_REGISTRY.hiring_verification.providers,
    ["apify_linkedin_job_search"]);
  assertEquals(CAPABILITY_REGISTRY.founder_discovery.providers,
    ["apify_linkedin_company_employees", "apify_people_search"]);
});

Deno.test("every capability's allowed_next names a real capability", () => {
  for (const [id, spec] of Object.entries(CAPABILITY_REGISTRY)) {
    assertEquals(spec.id, id, "registry key and spec id must agree");
    for (const n of spec.allowed_next) {
      assert(isCapabilityId(n), `${id} → ${n} is not a capability`);
    }
    assert(spec.max_attempts >= 1);
  }
});

Deno.test("every graph step's providers come from its own registry entry", () => {
  for (const q of [
    CANONICAL,
    "Find 100 Sales Operations jobs in the United States",
    "Enrich these companies: clay.com",
    "Find recently funded cybersecurity companies and their CEOs",
    "Find industrial companies expanding into Europe and their owners",
  ]) {
    const plan = buildCapabilityGraph(parseLeadMissionDeterministic(q));
    for (const s of plan.steps) {
      assertEquals(s.providers, [...CAPABILITY_REGISTRY[s.capability].providers],
        `${q}: ${s.capability} may not invent providers`);
    }
    // allowed_providers is exactly the union of the steps' providers.
    assertEquals([...plan.allowed_providers].sort(),
      [...new Set(plan.steps.flatMap((s) => s.providers))].sort());
  }
});
