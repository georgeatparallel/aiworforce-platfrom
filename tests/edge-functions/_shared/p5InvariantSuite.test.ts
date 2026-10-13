// LEAD V2 P5 — THE ARCHITECTURE'S INVARIANTS, AS ONE SUITE.
//
//   GPT researches and reasons. Evidence proves facts. Code enforces truth and
//   safety. The Workbench is the canonical result. Continuations do not waste
//   money. Missing data never becomes a false fact.
//
// Each Deno.test names the invariant it pins. The engine tests run the REAL
// capability engine over three slices with stubbed providers — no network, no
// model, no database.

import { readinessPolicy } from "../../../supabase/functions/_shared/routeReadiness.ts";
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { mergeCompanyBrainIntoMission } from "../../../supabase/functions/_shared/leadMission.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { buildCompanyEvidenceGraph } from "../../../supabase/functions/_shared/evidenceGraph.ts";
import type { EvidenceDimension, EvidenceItem } from "../../../supabase/functions/_shared/candidateObservation.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { businessModelDecision } from "../../../supabase/functions/_shared/groundedClaims.ts";
import {
  buildWorkbenchMissionView, decisionCounts, decisionSummary, type MissionCandidate,
} from "../../../supabase/functions/_shared/workbenchMissionView.ts";
import {
  canonicalDecisions, checkpointSnapshot, companyEvidenceItems, missionCandidatesFrom, reapplyMissionEvaluation, runCapabilityPlan,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { decideAutoContinuation, settleV2Terminal } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { markProviderUnavailable, unavailableProvider } from "../../../supabase/functions/_shared/providerAvailability.ts";
import { projectMissionCompanyRows } from "../../../supabase/functions/_shared/leadMissionPersistenceProjection.ts";
import {
  CANCELLED_REASON, reconcileTerminalRows, type CancelSweepDb,
} from "../../../supabase/functions/_shared/leadMissionCancellation.ts";
import { terminalViolations } from "../../../supabase/functions/_shared/leadMissionTerminal.ts";
import { emptyDiscoverySelector } from "./discoverySelectorFixture.ts";

globalThis.fetch = () => { throw new Error("the invariant suite must not reach the network"); };

const NOW = new Date("2026-09-18T12:00:00.000Z");
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
/**
 * The Brain's hard size rule. 1-200, not 1-150: size is answered by the
 * company's DECLARED LinkedIn band (companySize.ts), and the fixture's lead,
 * Audicus, declares 51-200 — a band 1-150 only partly overlaps, which leaves it
 * correctly PENDING on size. This suite is about continuation and decisions,
 * so it uses a range the real bands can settle.
 */
const BRAIN = { industries: ["B2B SaaS (founder-led or small teams)"], employee_min: 1, employee_max: 200, employee_policy: true };
const MISSION = mergeCompanyBrainIntoMission(
  compileLeadMission({ originalUserQuery: CANONICAL, proposal, companyBrain: BRAIN as never }).final_mission, BRAIN).mission;
const CRITERIA = deriveMissionCriteria(MISSION);

let seq = 0;
function ev(dimension: EvidenceDimension, value: unknown, over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    evidence_id: `ev_${dimension}_${++seq}`, company_key: "c1", dimension, value, status: "proven",
    source: { provider: "apify", actor: "apify_linkedin_company_details", provider_call_id: "pc", url: null, excerpt: null },
    method: "provider_field", observed_at: "2026-09-17T00:00:00.000Z", valid_until: null,
    confidence: "high", derived_from: [], mission_id: "t", origin: "lead_mission", ...over,
  };
}
const bm = (value: string, decision: "accepted" | "review") => ev("business_model", value, {
  evidence_id: "grd_c1_business_model", method: "model_extraction", origin: "web",
  status: decision === "accepted" ? "proven" : "plausible", confidence: decision === "accepted" ? "medium" : "low",
  source: { provider: "engine", actor: "grounded_evidence_evaluation", provider_call_id: null, url: null, excerpt: "x" },
  assessment: { decision: "review", grounding_score: 1, validated_claims: 1, business_model_decision: decision, business_model_reasons: [] },
});
const graph = (items: EvidenceItem[]) => buildCompanyEvidenceGraph("c1", items, { now: NOW });
const US = () => ev("geography", "Austin, TX, United States");
const hard = (items: EvidenceItem[]) => evaluateEligibility(CRITERIA, graph(items)).hard_checks;

// ══════════════════════════════════════════════════ MEANING & EVIDENCE ══

Deno.test("INV user criterion > Brain preference; a genuine Brain policy stays hard", () => {
  const byDim = (d: string) => CRITERIA.filter((c) => c.dimension === d);
  assertEquals(byDim("industry").filter((c) => c.kind === "hard").map((c) => [String(c.value).toLowerCase(), c.source]),
    [["b2b saas", "user_explicit"], ["saas", "user_explicit"]]);
  const pref = byDim("industry").find((c) => c.kind === "target")!;
  assertEquals([pref.value, pref.source], ["founder-led or small teams", "company_brain_preference"]);
  const size = byDim("company_size")[0];
  assertEquals([size.kind, size.source], ["hard", "company_brain_policy"]);
  assertFalse(CRITERIA.some((c) => c.kind === "hard" && /founder|small teams/i.test(String(c.value))));
});

Deno.test("INV accepted evidence PASS · verified contradiction FAIL · ambiguous PENDING · review never proves", () => {
  assertEquals(hard([US(), bm("b2b saas", "accepted")]).industry, "pass");
  assertEquals(hard([US(), bm("consumer", "accepted")]).industry, "fail");
  assertEquals(hard([US(), bm("b2b service", "accepted")]).industry, "fail");
  assertEquals(hard([US(), bm("ai saas", "accepted")]).industry, "unknown", "ambiguous audience");
  assertEquals(hard([US(), bm("b2b software", "accepted")]).industry, "unknown", "software is not automatically SaaS");
  assertEquals(hard([US(), bm("b2b saas", "review")]).industry, "unknown", "review never proves");
  assertEquals(hard([US(), bm("consumer", "review")]).industry, "unknown", "review never disproves either");
});

const band = (min: number, max: number | null) => ({ min, max, source: "linkedin_declared" });

Deno.test("INV a member count never decides size; a verified declared band wholly outside FAILS", () => {
  for (const n of [0, -5, Number.NaN, 20, 5000]) {
    assertEquals(hard([ev("linkedin_member_count", n)]).company_size, "unknown", `${n} LinkedIn members`);
  }
  assertEquals(hard([ev("company_size_band", band(201, 500))]).company_size, "fail");
  assertEquals(hard([ev("company_size_band", band(51, 200))]).company_size, "pass");
  assertEquals(hard([ev("company_size_band", band(201, 500), { status: "plausible" })]).company_size, "unknown",
    "an unverified band never rejects");
  assertEquals(hard([ev("company_size_band", band(51, 200)), ev("linkedin_member_count", 5000)]).company_size, "pass",
    "a member count far outside the band does not contest it");
});

Deno.test("INV a quote that argues against the label sends the business model to review", () => {
  const v = (value: string, excerpt: string) => businessModelDecision({
    version: "grounded-claims-v1", classifier_result: { business_model: { value, confidence: 0.9, claims: [] } },
    validated_claims: [{ claim: "c", claim_type: "business_model", evidence_ids: ["company_description:x:1"],
      evidence_excerpts: [{ evidence_id: "company_description:x:1", excerpt }] }],
    rejected_claims: [], grounding_score: 1, final_grounded_decision: "review", downgrade_reasons: [], unacknowledged_conflicts: [],
  } as never);
  assertEquals(v("b2b_saas", "consumer software, B2B SaaS, and hardware").decision, "review");
  assertEquals(v("b2b_service", "Our software and forward-deployed creative teams").decision, "review");
  // Silence is not support: a quote must STATE every facet its code asserts.
  assertEquals(v("b2b_saas", "a collaborative platform for event organizers").decision, "review");
  assertEquals(v("b2b_saas", "a SaaS platform for event marketing teams").decision, "accepted");
});

// ══════════════════════════════════════════ ONE CANONICAL DECISION SOURCE ══

const cand = (key: string, items: EvidenceItem[], over: Partial<MissionCandidate> = {}): MissionCandidate => ({
  company_key: key, name: key, domain: null, linkedin_url: null, found_by: [], screened_out: null,
  identity_resolved: true, investigated: true, graph: buildCompanyEvidenceGraph(key, items, { now: NOW }), ...over,
});

Deno.test("INV the canonical Workbench count controls continuation — no stale legacy counter", () => {
  const anchor = "hiring";
  const surfaced = cand("a", [US(), ev("company_size_band", band(11, 50)), bm("b2b saas", "accepted"), ev("hiring", true)]);
  const pending = cand("b", [US(), ev("company_size_band", band(11, 50)), bm("b2b saas", "review")]);
  const counts = decisionCounts({ criteria: CRITERIA, candidates: [surfaced, pending], anchor });
  const summary = decisionSummary(counts);
  assertEquals([summary.qualified, summary.pending], [1, 1]);
  // The view the UI renders produces the SAME counts — one projection.
  const view = buildWorkbenchMissionView({
    mission: { requested_count: 1, execution_limit: 1, anchor }, criteria: CRITERIA, candidates: [surfaced, pending], stage: "reasoning",
  });
  assertEquals(view.counts, counts);

  const base = {
    requestedCount: 1, continuationsUsed: 0, maxContinuations: 5, costUnitsUsed: 0, maxCostUnits: 50,
    barrenSlices: 0, providerFailed: false, pendingRuns: 0,
  };
  // Workbench reaches the requested count ⇒ no new discovery purchase, even with routes and a frontier left.
  const met = decideAutoContinuation({ ...base, qualified: summary.qualified, frontierRemaining: 5, discoveryRoutesRemain: true });
  assertEquals([met.continue, met.reason], [false, "quota_met"]);
  // The legacy counter said 0: had it decided, the mission would have bought another page.
  assertEquals(decideAutoContinuation({ ...base, qualified: 0, frontierRemaining: 0, discoveryRoutesRemain: true }).reason, "replenishment_required");
  // …and the stop is not re-opened by a legacy `continuation_required`.
  assertEquals(settleV2Terminal(met.reason, "continuation_required"), "completed");
  assertEquals(settleV2Terminal("frontier_exhausted", "continuation_required"), "search_exhausted");
  // The legacy controller's ROUND COUNT is not a terminal the mission reached
  // (canary 9b1b70a2: 1 of 1 delivered, `round_limit_reached`, plan partial).
  assertEquals(settleV2Terminal("quota_met", "round_limit_reached"), "completed", "the canonical stop decides");
  assertEquals(settleV2Terminal("quota_met", "invalid_request"), "invalid_request", "a refused request is kept");
  assertEquals(settleV2Terminal("frontier_exhausted", "source_transition_failed"), "source_transition_failed");
  // All decided, no legitimate route ⇒ terminate.
  const done = decideAutoContinuation({ ...base, qualified: 0, frontierRemaining: 0, discoveryRoutesRemain: false });
  assertEquals([done.continue, done.reason], [false, "frontier_exhausted"]);
  // Candidates still owed work (a valid evidence route) ⇒ continuation allowed.
  assert(decideAutoContinuation({ ...base, qualified: 0, frontierRemaining: 2, discoveryRoutesRemain: false }).continue);
});

Deno.test("INV run-agent: the view is built once, on V2 only, BEFORE the decision that reads it", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  const built = src.indexOf("const p5View = (p2Specs && capabilityRun && persistedMission)");
  const decided = src.indexOf("const autoDecision = decideAutoContinuation({");
  assert(built > 0 && decided > built, "the projection exists before the continuation decision");
  assert(src.includes("qualified: p5Decision ? p5Decision.qualified : progress.qualified_high_water"));
  assert(src.includes("qualifiedInPool: p5Decision ? p5Decision.qualified : sliceQualified"));
  assert(src.includes("const v2Outcome = p5Decision\n          ? settleV2Outcome({"), "V2 settles one outcome");
  assert(src.includes("verificationRoutesRemain: p5View?.evidence_gaps.with_executable_route ?? 0"),
    "continuation reads the canonical evidence-gap router");
  assert(src.includes("effectiveTerminal, cf.writeBoundary.invariantViolation, v2Outcome ? v2Outcome.quota : {"),
    "the task status reads the V2 quota");
  // `sized` measures the view and returns it unchanged (payloadSize.ts).
  assert(/workbench_mission_view: p5View\s*\n\s*\? sized\("canonical_view", \{ \.\.\.p5View,/.test(src), "the SAME object is written");
  assertEquals(src.match(/buildWorkbenchMissionView\(/g)?.length, 1, "exactly one construction site");
  assertEquals(src.match(/reasonForCandidates\(/g)?.length, 1, "the reasoner runs only inside the V2 view");
});

Deno.test("INV lead rows are exactly the canonical qualified set, carrying the backend's decision", () => {
  const company = (key: string, verdict: string) => ({
    key, verdict, company: { company_name: key, linkedin_company_url: `https://www.linkedin.com/company/${key}`, canonical_domain: `${key}.com`, website: null, geography: null, external_source_id: key },
    identity: { status: "verified_match", linkedin_company_url: `https://www.linkedin.com/company/${key}` }, hiring_jobs: [], yc_open_jobs: [], fit: null, enriched: null,
  }) as never;
  const companies = [company("canon", "unknown"), company("legacy", "pass")];
  const decisions = new Map([
    ["canon", { company_key: "canon", bucket: "strong_opportunity", label: "strong_opportunity", hard_checks: { industry: "pass" } }],
    ["legacy", { company_key: "legacy", bucket: "pending", label: null, hard_checks: { industry: "unknown" } }],
  ]) as never;
  const v2 = projectMissionCompanyRows(companies, "ws", "company", decisions);
  assertEquals(v2.rows.map((r) => r.company_key), ["canon"], "a Brain pass alone is not a V2 lead; a canonical label is");
  const raw = v2.rows[0].plan.leadCandidate!.raw as Record<string, unknown>;
  assertEquals([raw.verdict, raw.qualification_basis, raw.quota_eligible], ["QUALIFIED", "p5_canonical_eligibility", true]);
  assertEquals((raw.canonical_decision as Record<string, unknown>).label, "strong_opportunity");
  assertEquals(raw.company_brain_status, "evidence_pending", "the real Brain status is recorded, never relabelled");
  // V1: unchanged — the Brain pass decides and no canonical field appears.
  const v1 = projectMissionCompanyRows(companies, "ws", "company");
  assertEquals(v1.rows.map((r) => r.company_key), ["legacy"]);
  assertFalse("canonical_decision" in (v1.rows[0].plan.leadCandidate!.raw as Record<string, unknown>));
});

// ══════════════════════════════════════════════════ PROVIDER AVAILABILITY ══

Deno.test("INV an unavailable provider stays unavailable until readiness or an operator changes", () => {
  const rec = { provider: "p", capability: "hiring_verification", reason: "apify_actor_disabled_by_default", refused_at: "t", readiness_at_refusal: "NEEDS_PROVIDER_WORK" };
  const list = markProviderUnavailable(markProviderUnavailable([], rec), { ...rec, reason: "second" });
  assertEquals(list.length, 1, "one record per provider; the first refusal is kept");
  assert(unavailableProvider(list, "p", "NEEDS_PROVIDER_WORK"));
  assertEquals(unavailableProvider(list, "p", "READY"), null, "a readiness change re-opens it");
  assertEquals(unavailableProvider(list, "p", "NEEDS_PROVIDER_WORK", (k) => k === "LEAD_V2_RETRY_UNAVAILABLE_PROVIDERS" ? "p" : undefined), null);
  assertEquals(unavailableProvider(list, "other", "NEEDS_PROVIDER_WORK"), null);
});

// ══════════════════════════════════════════════ THE REAL ENGINE, 3 SLICES ══

const PROBE = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/p3-job-discovery-probe.json", import.meta.url)));
const ROWS = PROBE.probes["harvestapi~linkedin-job-search"].items as Array<Record<string, unknown>>;
/**
 * SYNTHETIC SELF-DESCRIPTIONS. The fixture's real descriptions do not state a
 * business model (Audicus is a hearing-aid company; its real first words are
 * "Audicus is a hearing hea…"), and a quote that states nothing can no longer
 * prove anything (canary 9b1b70a2). Two companies are therefore given words
 * that DO state every facet their code asserts, and the grounder quotes them.
 */
const SYNTHETIC_DESCRIPTION: Record<string, string> = {
  "Audicus": "Audicus is a cloud-based SaaS platform for hearing clinics.",
  "Bevi": "Bevi sells smart water coolers direct to consumers.",
};
const VERDICT: Record<string, { value: string; decision: "pass" | "review" | "fail"; confidence?: number }> = {
  "LinkedIn": { value: "b2b_saas", decision: "review" },
  "Audicus": { value: "b2b_saas", decision: "review" },
  "Bevi": { value: "consumer", decision: "fail" },
  "Bobyard": { value: "b2b_saas", decision: "review", confidence: 0.4 },
};

function withTeamLookup<T>(plan: T): T {
  const g = JSON.parse(JSON.stringify(plan));
  const hv = g.steps.find((s: { capability: string }) => s.capability === "hiring_verification");
  if (hv && !hv.providers.includes("apify_linkedin_company_employees")) hv.providers.push("apify_linkedin_company_employees");
  g.allowed_providers = [...new Set([...(g.allowed_providers ?? []), "apify_linkedin_company_employees"])];
  return g;
}

function harness(specMode: "enforce" | "off", employees: "disabled" | "empty" = "disabled") {
  const byUrl = new Map(ROWS.map((r) => [(r.company as { linkedinUrl: string }).linkedinUrl, r.company as Record<string, unknown>]));
  const calls: Array<{ actor: string; input: string; ok: boolean }> = [];
  const evaluateBatch = (members: Array<{ company_key: string; company_name: string | null; registry: { items: Array<Record<string, unknown>> } }>) =>
    Promise.resolve({
      version: "t", foreign_results: [], evaluated: members.length, failed: 0,
      outcomes: members.map((m) => {
        const v = VERDICT[String(m.company_name)];
        const desc = m.registry.items.find((x) => x.evidence_type === "company_description");
        if (!v || !desc) return { company_key: m.company_key, verification: null, failure: "malformed_result", detail: null };
        const claim = { claim: "own words", claim_type: "business_model", evidence_ids: [String(desc.evidence_id)],
          evidence_excerpts: [{ evidence_id: String(desc.evidence_id), excerpt: SYNTHETIC_DESCRIPTION[String(m.company_name)] ?? String(desc.source_text).slice(0, 24) }] };
        return { company_key: m.company_key, failure: null, detail: null, verification: {
          version: "grounded-claims-v1", classifier_result: { business_model: { value: v.value, confidence: v.confidence ?? 0.9, claims: [claim] } },
          validated_claims: [claim], rejected_claims: [], grounding_score: 1, final_grounded_decision: v.decision,
          downgrade_reasons: [], unacknowledged_conflicts: [] } };
      }),
    });
  const deps = (restored?: Map<string, unknown>) => ({
    planDiscovery: emptyDiscoverySelector(),
    planExecution: () => Promise.resolve({ reasoning: "inv", steps: [
      { capability: "job_discovery", actor_key: "apify_linkedin_job_search", purpose: "roles", input: { jobTitles: ['"growth marketer"'], locations: ["United States"], postedLimit: "month", maxItems: 10 }, depends_on: [] },
      { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details", input: { companies: ["{{url}}"] }, depends_on: [1] },
      { capability: "hiring_verification", actor_key: "apify_linkedin_job_search", purpose: "verify", input: {}, depends_on: [2] },
      { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [3] },
    ] }),
    invoke: (call: { actorKey: string; input: Record<string, unknown>; onProviderRun?: (r: { run_id: string; dataset_id: null }) => void }) => {
      const input = JSON.stringify(call.input);
      if (call.actorKey === "apify_linkedin_company_employees") {
        if (employees === "empty") {
          calls.push({ actor: call.actorKey, input, ok: true });
          call.onProviderRun?.({ run_id: `run-${calls.length}`, dataset_id: null });
          return Promise.resolve([]);
        }
        calls.push({ actor: call.actorKey, input, ok: false });
        return Promise.reject(new Error("apify_actor_disabled_by_default"));
      }
      calls.push({ actor: call.actorKey, input, ok: true });
      call.onProviderRun?.({ run_id: `run-${calls.length}`, dataset_id: null });
      if (call.actorKey === "apify_linkedin_job_search") {
        // A company-scoped verification search finds that company's own posting.
        if (call.input.company || call.input.companies) {
          return Promise.resolve(ROWS.filter((r) => JSON.stringify(call.input).includes(String((r.company as { linkedinUrl: string }).linkedinUrl))));
        }
        return Promise.resolve(ROWS);
      }
      if (call.actorKey === "apify_linkedin_company_details") {
        return Promise.resolve(((call.input.companies as string[]) ?? []).map((u) => {
          const c = byUrl.get(u)!;
          return { id: c.id, name: c.name, linkedinUrl: u, website: c.website, employeeCount: c.employeeCount, employeeCountRange: c.employeeCountRange, description: SYNTHETIC_DESCRIPTION[String(c.name)] ?? c.description, industries: c.industries, locations: c.locations };
        }));
      }
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
    evaluateBatch,
    ...(restored ? { restoredGroundedResults: restored } : {}),
  });
  const opts = (extra: Record<string, unknown> = {}) => ({
    // The team lookup is PLANNED here (V2 no longer grants it for a first-hire
    // target), so the once-per-mission refusal guarantee stays exercised.
    mission: MISSION, plan: withTeamLookup(buildCapabilityGraph(MISSION, { executability: "enforce" })), maxCandidates: 10,
    // …and let it run: the team actor is NEEDS_PROVIDER_WORK in production.
    readiness: readinessPolicy({ overrides: { "apify_linkedin_company_employees|hiring_verification": "READY" } }),
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode, specScope: { workspace_id: "ws-inv", lineage_id: "lineage-inv" }, identity: { task_id: "task-inv", workspace_id: "ws-inv" }, ...extra,
  });
  return { calls, deps, opts };
}

type Run = { companies: Array<Record<string, unknown> & { key: string; company: { company_name: string } }>; state: Record<string, unknown> & { qualified_company_keys: string[] } };

/** A continuation the way a reopened qualification leaves it: the paid stages still owed. */
function reopened(run: Run) {
  const snap = checkpointSnapshot(run.state as never, run.companies as never);
  const state = JSON.parse(JSON.stringify(snap.state));
  for (const cap of ["hiring_verification", "company_brain_qualification"]) {
    state.completed_capabilities = state.completed_capabilities.filter((c: string) => c !== cap);
    if (!state.pending_capabilities.includes(cap)) state.pending_capabilities.unshift(cap);
  }
  return {
    state, records: JSON.parse(JSON.stringify(snap.resume_records)),
    grounded: new Map(run.companies.filter((c) => c.grounded).map((c) => [c.key, JSON.parse(JSON.stringify(c.grounded))])),
  };
}

Deno.test("INV three slices: one refusal of a disabled actor, no duplicate purchase, same plan, evidence and decisions survive", async () => {
  const h = harness("enforce");
  const slices: Run[] = [await runCapabilityPlan(h.deps() as never, h.opts() as never) as unknown as Run];
  for (let i = 0; i < 2; i++) {
    const r = reopened(slices[slices.length - 1]);
    slices.push(await runCapabilityPlan(h.deps(r.grounded) as never, h.opts({
      state: r.state, resume: { workspace_id: "ws-inv", lineage_root_task_id: "task-inv", records: r.records },
    }) as never) as unknown as Run);
  }

  // DISABLED ACTOR: refused once per MISSION, recorded, and the gap kept.
  const refusals = h.calls.filter((c) => c.actor === "apify_linkedin_company_employees");
  assertEquals(refusals.length, 1, `1 refusal total, not 1 per slice (got ${refusals.length})`);
  const last = slices[2];
  const unavailable = (last.state.unavailable_providers ?? []) as Array<{ provider: string }>;
  assertEquals(unavailable.map((u) => u.provider), ["apify_linkedin_company_employees"]);
  for (const c of last.companies.filter((x) => x.first_in_function)) {
    const f = c.first_in_function as { status: string; source: string };
    assertFalse(f.status === "supported" && f.source === "team_composition", "an unavailable check never becomes a success");
  }

  // IDEMPOTENCY: no successful provider purchase twice with the same input.
  const bought = h.calls.filter((c) => c.ok).map((c) => `${c.actor}|${c.input}`);
  assertEquals(bought.length, new Set(bought).size, `duplicate purchase: ${bought.filter((b, i) => bought.indexOf(b) !== i).join(" ; ")}`);

  // THE PLAN: a continuation executes the current plan version; nothing silently amends it.
  const plans = slices.map((s) => ((s.state.retrieval_plans ?? []) as Array<{ version: number; content_hash: string }>));
  const tail = (p: typeof plans[number]) => p.length ? `${p[p.length - 1].version}:${p[p.length - 1].content_hash}` : "none";
  assertEquals(tail(plans[1]), tail(plans[0]));
  assertEquals(tail(plans[2]), tail(plans[0]));

  // CHECKPOINT: identity, found_by, observations, grounded result, provenance and hard checks survive.
  const keys = (s: Run) => s.companies.map((c) => c.key).sort();
  assertEquals(keys(slices[2]), keys(slices[0]), "no company lost");
  const decisionsOf = (s: Run) => {
    const d = canonicalDecisions(s.companies as never, h.opts() as never);
    return Object.fromEntries([...d].map(([k, v]) => [k, `${v.bucket}|${JSON.stringify(v.hard_checks)}`]));
  };
  assertEquals(decisionsOf(slices[2]), decisionsOf(slices[0]), "every decision survives two continuations");
  for (const s0 of slices[0].companies) {
    const s2 = slices[2].companies.find((c) => c.key === s0.key)!;
    assertEquals(JSON.stringify(s2.found_by), JSON.stringify(s0.found_by), `${s0.key}: found_by`);
    const bmOf = (c: unknown) => companyEvidenceItems(c as never).find((e) => e.dimension === "business_model");
    assertEquals(JSON.stringify(bmOf(s2)), JSON.stringify(bmOf(s0)), `${s0.key}: grounded business model + assessment + provenance`);
  }

  // ONE DECISION TRUTH in the engine: the qualified set is the canonical label set.
  const labelled = [...canonicalDecisions(last.companies as never, h.opts() as never)].filter(([, d]) => d.label).map(([k]) => k).sort();
  assertEquals([...last.state.qualified_company_keys].sort(), labelled);
  assert(labelled.length > 0, "the fixture surfaces a lead, so the equality is not vacuous");
  const verdictPass = last.companies.filter((c) => c.verdict === "pass").map((c) => c.key).sort();
  assertFalse(JSON.stringify(verdictPass) === JSON.stringify(labelled), "the legacy verdict disagrees here, so the checks below can tell them apart");
  // The progress counter the Workbench header used to read is the canonical count too.
  assertEquals((last.state.progress as { qualified_companies: number }).qualified_companies, labelled.length);
  // A post-run re-evaluation (run-agent's reapply) re-derives the SAME canonical set — never the verdict set.
  const copy = JSON.parse(JSON.stringify(last)) as Run;
  copy.state.qualified_company_keys = [];
  reapplyMissionEvaluation(copy as never, [], h.opts() as never);
  assertEquals([...copy.state.qualified_company_keys].sort(), labelled);
});

Deno.test("INV the in-slice yield gate stops on the canonical count, not the Brain verdict", async () => {
  const h = harness("enforce");
  const gates: Array<{ qualified: number; reason: string; take_another_slice: boolean }> = [];
  const run = await runCapabilityPlan({
    ...h.deps(), log: (m: string, d: unknown) => { if (m === "investigation_yield_gate") gates.push(d as never); },
  } as never, h.opts() as never) as unknown as Run;
  const labelled = [...canonicalDecisions(run.companies as never, h.opts() as never)].filter(([, d]) => d.label);
  assertEquals(run.companies.filter((c) => c.verdict === "pass").length, 0, "the legacy verdict qualified nothing");
  assertEquals(labelled.length, 1, "the Workbench surfaced the one lead asked for");
  assertEquals(gates.length, 1);
  assertEquals([gates[0].qualified, gates[0].reason, gates[0].take_another_slice], [1, "quota_met", false],
    "the Workbench says the goal is met, so the engine buys nothing more");
});

Deno.test("INV an employee search that finds nobody is not proof of a first hire", async () => {
  const h = harness("enforce", "empty");
  const run = await runCapabilityPlan(h.deps() as never, h.opts() as never) as unknown as Run;
  assert(h.calls.some((c) => c.actor === "apify_linkedin_company_employees" && c.ok), "the team check ran");
  const checked = run.companies.map((c) => c.first_in_function as { status: string; source: string } | null)
    .filter((f) => f?.source === "team_composition");
  assert(checked.length > 0, "at least one company went through the team check");
  for (const f of checked) {
    assertEquals(f!.status, "unverified", "zero results mean the actor found nobody, not that there is nobody");
  }
});

// ═══════════════════════════════════════════════════════ ISOLATION ══

Deno.test("INV V1 untouched: no P5 evidence, the legacy qualified set, no canonical rows", async () => {
  const h = harness("off");
  const run = await runCapabilityPlan(h.deps() as never, h.opts() as never) as unknown as Run;
  for (const c of run.companies) {
    const grd = ((c.observations ?? []) as Array<{ evidence: EvidenceItem[] }>)
      .flatMap((o) => o.evidence).filter((e) => e.source.actor === "grounded_evidence_evaluation");
    assertEquals(grd.length, 0, `${c.key}: V1 checkpoints gain no P5 evidence`);
  }
  assertEquals([...run.state.qualified_company_keys].sort(),
    run.companies.filter((c) => c.verdict === "pass").map((c) => c.key).sort(), "V1 qualifies by the Brain verdict, as before");
});

Deno.test("INV Signals untouched: the monitoring scan never enables the V2 spine or P5", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/run-monitoring-scan/index.ts", import.meta.url));
  assertFalse(/specMode:\s*"enforce"/.test(src), "Signals never runs the engine in V2 mode");
  for (const p5 of ["workbenchMissionView", "opportunityReasoningRun", "gptOpportunityReasoner", "candidateEligibility", "canonicalDecisions"]) {
    assertFalse(src.includes(p5), `Signals does not import ${p5}`);
  }
});

// ═══════════════════════════════════════════════ TERMINAL AGREEMENT ══

function store(task: string, lineage: string, plan: string) {
  const tasks = new Map([["t1", { status: task, result: { terminal_status: "continuation_required" } as Record<string, unknown> }]]);
  const lineages = new Map([["t1", { status: lineage }]]);
  const plans = new Map([["p1", { status: plan }]]);
  const db: CancelSweepDb = {
    readTask: (id) => Promise.resolve((tasks.get(id) ?? null) as never),
    readLineage: (id) => Promise.resolve((lineages.get(id) ?? null) as never),
    readPlan: (id) => Promise.resolve((plans.get(id) ?? null) as never),
    writeTask: (id, p) => { tasks.set(id, { status: String(p.status), result: p.result as Record<string, unknown> }); return Promise.resolve(); },
    writeLineage: (id, p) => { lineages.set(id, { status: String(p.status) }); return Promise.resolve(); },
    writePlan: (id, p) => { plans.set(id, { status: String(p.status) }); return Promise.resolve(); },
    listCancelled: () => Promise.resolve([]),
  };
  const rows = () => ({ task: tasks.get("t1") as never, lineage: lineages.get("t1") as never, plan: plans.get("p1") as never });
  return { db, rows };
}

Deno.test("INV cancelled / complete / failed: queue, task, lineage and plan end in agreement", async () => {
  for (const [queue, reason] of [["cancelled", CANCELLED_REASON], ["complete", "round_limit_reached"], ["failed", "unhandled_exception"]] as const) {
    const s = store("ready", "active", "executing");
    await reconcileTerminalRows(s.db, queue, reason, { taskId: "t1", lineageId: "t1", planId: "p1" }, NOW.toISOString());
    assertEquals(terminalViolations(queue, s.rows()), [], `${queue}: all records agree`);
  }
  // A cancelled row can never be claimed: the claim SQL reads only queued / resumable rows.
  const claimSql = Deno.readTextFileSync(new URL("../../../supabase/migrations-held/20260910140000_lead_mission_v2_claim.sql", import.meta.url));
  const claimFn = claimSql.slice(claimSql.indexOf("function public.claim_next_lead_mission"));
  const where = claimFn.slice(0, claimFn.indexOf("for update"));
  assert(/q\.status in \('queued', 'resumable'\)/.test(where), "claimable statuses are queued / resumable");
  assert(/or \(q\.status = 'running' and q\.lease_expires_at is not null/.test(where), "the only other claim is a lapsed running lease");
  // Every queue-status predicate names only claimable states…
  for (const m of where.matchAll(/q\.status (?:in \(([^)]*)\)|= '([a-z_]+)')/g)) {
    assertFalse(String(m[1] ?? m[2]).includes("cancelled"), `a cancelled queue row is never claimable: ${m[0]}`);
  }
  // …and a cancelled lineage vetoes its queue row, whatever that row says.
  assert(/l\.status in \('cancelled', 'terminal'\)/.test(where), "a cancelled lineage is never claimed");
});

// ═══════════════════════════════════════════════════════ SWEEPER ══

Deno.test("INV the stuck-run sweeper skips any task an active V2 queue row owns", () => {
  const sql = Deno.readTextFileSync(new URL("../../../supabase/migrations-held/20260915120000_sweep_skips_v2_queue_tasks.sql", import.meta.url));
  assert(/and not exists \(\s*select 1 from public\.lead_mission_queue q\s*where q\.task_id = t\.id\s*and q\.status in \('queued', 'running', 'resumable'\)\s*\)/.test(sql));
  assert(sql.includes("insert into public.ops_stuck_run_archive"), "archive-before-alter is kept");
});
