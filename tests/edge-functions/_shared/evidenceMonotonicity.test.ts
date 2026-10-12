// EVIDENCE IS MONOTONIC UNLESS IT IS CONTRADICTED.
//
// Live Query B (task f6133796, 2026-10-11). Slice 3 bought Citian's /about and
// Coval's /pricing + /about-us pages; the website re-read accepted both
// business models (`proven`), and both companies became strong opportunities.
// Slice 4 restored the Stage-2 grounded results checkpointed at 16:26:40 —
// BEFORE the 16:29 re-read — so qualification rebuilt the business-model item
// from the LinkedIn description alone (`review` / `plausible`) and recorded it
// under the same observation id. `recordObservation` replaced the stronger
// website-backed reading, industry fell to `unknown`, and both ended PENDING.
// The final qualified set depended on execution order, not on evidence.
//
// What is pinned here:
//   * a weaker re-reading never erases a stronger, still-valid one;
//   * a decisive contradiction still replaces it (never suppressed);
//   * the final claim is the same whichever order the readings arrive in;
//   * the website proof survives a checkpoint and a restored stale grounding,
//     with its provenance, and no provider or grounding call is bought again.
//
// ZERO network, ZERO providers, ZERO real model calls, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { buildEvidenceRegistry } from "../../../supabase/functions/_shared/leadEvidenceRegistry.ts";
import { buildCompanyEvidence } from "../../../supabase/functions/_shared/leadCompanyEvidence.ts";
import { regroundPendingClaims, type RegroundPage } from "../../../supabase/functions/_shared/webEvidenceRegrounding.ts";
import type { GroundedVerification } from "../../../supabase/functions/_shared/groundedClaims.ts";
import {
  applyRegroundedVerification, applyVerifierFinding, checkpointSnapshot, companyEvidenceItems,
  missionCandidatesFrom, runCapabilityPlan, type EngineCompany,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { buildWorkbenchMissionView } from "../../../supabase/functions/_shared/workbenchMissionView.ts";
import {
  entityHintFromCompany, type EvidenceDimension, type EvidenceItem,
} from "../../../supabase/functions/_shared/candidateObservation.ts";
import { emptyDiscoverySelector } from "./discoverySelectorFixture.ts";

globalThis.fetch = () => { throw new Error("monotonicity tests must not reach the network"); };

const TASK = "f6133796-c460-44cd-902e-f28ac638b423";
const NOW = new Date("2026-10-11T16:45:00.000Z");
const iso = (minutesAgo = 0) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

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
const CRITERIA = deriveMissionCriteria(MISSION);

// ── THE TWO READINGS, AS PRODUCTION HAD THEM ────────────────────────────────
//
// Citian's LinkedIn description says "SaaS" but never who buys it, so the
// business model stays in review. Its own site says it sells to businesses.
const DESCRIPTION = "Citian is a fast-growing, venture-backed SaaS startup.";
const PAGE: RegroundPage = {
  source_url: "https://www.citian.co/about", page_intent: "about", fetched_at: iso(20),
  source_text: "Citian is a cloud-based workspace for businesses, billed per seat each month, for transportation teams.",
};
const CONSUMER_PAGE: RegroundPage = {
  source_url: "https://www.citian.co/pricing", page_intent: "pricing", fetched_at: iso(5),
  source_text: "Citian sells its app direct to consumers: a personal subscription for individual commuters.",
};

const KEY = "https://www.linkedin.com/company/citian";

function registryWith(pages: readonly RegroundPage[]) {
  return buildEvidenceRegistry({
    evidence: buildCompanyEvidence({
      company_key: KEY, source_capability: "job_discovery", source_query: CANONICAL,
      company: {
        company_name: "Citian", linkedin_company_url: KEY, canonical_domain: "citian.co", website: "https://www.citian.co",
        description: DESCRIPTION, geography: "Boston, Massachusetts, United States", provider_industry: "Software Development",
        field_trust: {}, missing_fields: [], raw_ref: { actor_key: "apify_linkedin_job_search", source_id: "citian" },
      } as never,
      enriched: null, identity_state: "resolved", linkedin_company_url: KEY,
      commercial_jobs: [], strongest_signal: null,
    }),
    web_pages: pages.map((p) => ({ ...p })),
  } as never);
}

/** A grounded verification citing one registry item, as the grounder returns it. */
function verification(
  registry: ReturnType<typeof registryWith>, cite: "description" | "page", value: string, excerpt: string,
): GroundedVerification {
  const item = cite === "description"
    ? registry.items.find((x) => x.evidence_type === "company_description")!
    : registry.items.find((x) => x.evidence_type === "web_page")!;
  const claim = {
    claim: "What the company says about itself.", claim_type: "business_model" as const,
    evidence_ids: [item.evidence_id], evidence_excerpts: [{ evidence_id: item.evidence_id, excerpt }],
  };
  return {
    version: "grounded-claims-v1",
    classifier_result: { business_model: { value, confidence: 0.9, claims: [claim] } },
    validated_claims: [claim], rejected_claims: [], grounding_score: 1, final_grounded_decision: "pass",
    downgrade_reasons: [], unacknowledged_conflicts: [],
  } as unknown as GroundedVerification;
}
const DESCRIPTION_ONLY = () => verification(registryWith([]), "description", "b2b_saas", "a fast-growing, venture-backed SaaS startup");
const WEBSITE = () => verification(registryWith([PAGE]), "page", "b2b_saas", "a cloud-based workspace for businesses, billed per seat");
const WEBSITE_CONSUMER = () => verification(registryWith([CONSUMER_PAGE]), "page", "consumer", "sells its app direct to consumers");
const DESCRIPTION_CONSUMER = () => verification(registryWith([]), "description", "consumer", "a fast-growing, venture-backed SaaS startup");

let seq = 0;
const proven = (dimension: EvidenceDimension, value: unknown, actor: string): EvidenceItem => ({
  evidence_id: `ev_${dimension}_${++seq}`, company_key: KEY, dimension, value, status: "proven",
  source: { provider: "apify", actor, provider_call_id: `pc_${seq}`, url: KEY, excerpt: null },
  method: "provider_field", observed_at: iso(30), valid_until: null, confidence: "high",
  derived_from: [], mission_id: TASK, origin: "lead_mission",
});

/** Citian as the engine held it: every hard fact proven but the business model. */
function citian(): EngineCompany {
  const company = {
    company_name: "Citian", linkedin_company_url: KEY, canonical_domain: "citian.co", website: "https://www.citian.co",
    description: DESCRIPTION, geography: "Boston, Massachusetts, United States", external_source_id: "li_company:citian",
    field_trust: {}, missing_fields: [], raw_ref: { actor_key: "apify_linkedin_job_search", source_id: "citian" },
  };
  return {
    key: KEY, company, observations: [{
      version: "candidate-observation-v1", observation_id: "obs_enrichment", capability: "company_enrichment",
      actor_key: "apify_linkedin_company_details", provider: "apify", route_id: null, plan_version: null,
      provider_call_id: null, source_record_id: null, source_url: KEY, observed_at: iso(30),
      entity_hint: entityHintFromCompany(company as never),
      evidence: [
        proven("identity", { linkedin_company_url: KEY, domain: "citian.co", name: "Citian" }, "apify_linkedin_company_details"),
        proven("geography", "Boston, Massachusetts, United States", "apify_linkedin_company_details"),
        proven("company_size_band", { min: 11, max: 50, source: "linkedin_declared" }, "apify_linkedin_company_details"),
        proven("hiring", { open_role: "Growth Marketing Manager", role_families: ["growth"] }, "apify_linkedin_job_search"),
      ],
    }],
    hiring_jobs: [], yc_open_jobs: [], hiring_assessment: null, first_in_function: null,
    enriched: null, identity: null, found_by: [], verdict: null, brain: null, shortlisted: true,
    prequalified: null, prequal_key: null, shortlist_exclusion: null, triage: null,
    investigation_state: "investigated", investigation_rank: 1, enrichment_outcome: "success",
    completed_operations: [], mission_evaluation: null, identity_conflicts: [], grounded: null,
    evidence_registry: registryWith([]),
  } as never;
}

/** One reading applied exactly as run-agent's re-grounding applies it. */
const read = (c: EngineCompany, v: GroundedVerification, pages: readonly RegroundPage[] = []) =>
  applyRegroundedVerification(c, v, TASK, iso(0), registryWith(pages));

const businessModel = (c: EngineCompany) =>
  companyEvidenceItems(c, TASK).find((e) => e.dimension === "business_model")!;
/** The aggregated hard industry check (the mission states "b2b saas" and "saas"). */
const industry = (c: EngineCompany) =>
  evaluateEligibility(CRITERIA, missionCandidatesFrom({ companies: [c] }, { missionId: TASK, now: NOW })[0].graph)
    .hard_checks.industry;

// ═══ THE LIVE FAILURE, AT THE OBSERVATION STORE ══════════════════════════════

Deno.test("a description-only re-read never erases website-backed proof (Citian, slice 3 → slice 4)", () => {
  const c = citian();
  read(c, WEBSITE(), [PAGE]);
  assertEquals([businessModel(c).status, businessModel(c).assessment?.business_model_decision], ["proven", "accepted"]);
  assertEquals(industry(c), "pass");

  read(c, DESCRIPTION_ONLY());
  const bm = businessModel(c);
  assertEquals([bm.status, bm.assessment?.business_model_decision, bm.confidence], ["proven", "accepted", "medium"],
    "the stronger, still-valid reading stands");
  assertEquals(bm.source.url, PAGE.source_url, "its website provenance survives");
  assert(bm.derived_from.every((id) => id.startsWith("web_page:")), bm.derived_from.join(","));
  assertEquals(industry(c), "pass", "industry stays satisfied");
});

Deno.test("a genuinely stronger reading still upgrades a weaker one", () => {
  const c = citian();
  read(c, DESCRIPTION_ONLY());
  assertEquals([businessModel(c).status, industry(c)], ["plausible", "unknown"]);
  read(c, WEBSITE(), [PAGE]);
  assertEquals([businessModel(c).status, industry(c)], ["proven", "pass"]);
});

// ═══ CONTRADICTIONS ARE NEVER SUPPRESSED ════════════════════════════════════

Deno.test("CONTRADICTION: trusted website evidence that the company is consumer-only replaces B2B proof and fails the claim", () => {
  const c = citian();
  read(c, WEBSITE(), [PAGE]);
  assertEquals(industry(c), "pass");
  read(c, WEBSITE_CONSUMER(), [CONSUMER_PAGE]);
  const bm = businessModel(c);
  assertEquals([bm.value, bm.status, bm.assessment?.business_model_decision], ["consumer", "proven", "accepted"]);
  assertEquals(industry(c), "fail", "the contradiction enters the graph and fails the rule, as existing policy does");
});

Deno.test("CONTRADICTION: a weaker, unverified contrary reading does not overturn proof", () => {
  const c = citian();
  read(c, WEBSITE(), [PAGE]);
  read(c, DESCRIPTION_CONSUMER());
  assertEquals([businessModel(c).value, businessModel(c).status, industry(c)], ["b2b saas", "proven", "pass"]);
});

// ═══ ORDER INDEPENDENCE ═════════════════════════════════════════════════════

Deno.test("ORDER: LinkedIn-weak → website-strong and website-strong → LinkedIn-weak end in the same claim", () => {
  const a = citian();
  read(a, DESCRIPTION_ONLY());
  read(a, WEBSITE(), [PAGE]);
  const b = citian();
  read(b, WEBSITE(), [PAGE]);
  read(b, DESCRIPTION_ONLY());
  const strip = (e: EvidenceItem) => ({
    value: e.value, status: e.status, confidence: e.confidence, url: e.source.url, excerpt: e.source.excerpt,
    derived_from: e.derived_from, decision: e.assessment?.business_model_decision, authority: e.authority,
  });
  assertEquals(strip(businessModel(a)), strip(businessModel(b)));
  assertEquals(industry(a), industry(b));
  assertEquals(industry(a), "pass");
});

Deno.test("ORDER at equal strength: a reading of the company's own page outranks a description-only one (click5)", () => {
  // Live f6133796: click5's website re-read was `review` (16:29:41); the
  // slice-4 description-only re-read, also `review`, replaced it and the page
  // provenance was lost. Equal claim state, equal confidence — source decides.
  const WEBSITE_REVIEW = () => verification(registryWith([PAGE]), "page", "b2b_saas", "for transportation teams");
  const a = citian();
  read(a, DESCRIPTION_ONLY());
  read(a, WEBSITE_REVIEW(), [PAGE]);
  const b = citian();
  read(b, WEBSITE_REVIEW(), [PAGE]);
  read(b, DESCRIPTION_ONLY());
  for (const c of [a, b]) {
    const bm = businessModel(c);
    assertEquals([bm.status, bm.source.url], ["plausible", PAGE.source_url]);
    assert(bm.derived_from.every((id) => id.startsWith("web_page:")), bm.derived_from.join(","));
  }
});

Deno.test("PROVENANCE: a quote citing the description AND the page names the page (Guava's shape)", () => {
  const c = citian();
  const registry = registryWith([PAGE]);
  const desc = registry.items.find((x) => x.evidence_type === "company_description")!;
  const page = registry.items.find((x) => x.evidence_type === "web_page")!;
  const claim = {
    claim: "What the company says about itself.", claim_type: "business_model" as const,
    evidence_ids: [desc.evidence_id, page.evidence_id],
    evidence_excerpts: [
      { evidence_id: desc.evidence_id, excerpt: "a fast-growing, venture-backed SaaS startup" },
      { evidence_id: page.evidence_id, excerpt: "a cloud-based workspace for businesses, billed per seat" },
    ],
  };
  applyRegroundedVerification(c, {
    version: "grounded-claims-v1", classifier_result: { business_model: { value: "b2b_saas", confidence: 0.9, claims: [claim] } },
    validated_claims: [claim], rejected_claims: [], grounding_score: 1, final_grounded_decision: "pass",
    downgrade_reasons: [], unacknowledged_conflicts: [],
  } as never, TASK, iso(0), registry);
  assertEquals([businessModel(c).status, businessModel(c).source.url], ["proven", PAGE.source_url]);
});

// ═══ THE RULE IS THE STORE'S, NOT THE BUSINESS MODEL'S ═══════════════════════

const hiringItem = (status: EvidenceItem["status"], confidence: EvidenceItem["confidence"], over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  evidence_id: `vfy_${KEY}_hiring`, company_key: KEY, dimension: "hiring",
  value: { open_role: "Growth Marketing Manager" }, status,
  source: { provider: "apify", actor: "apify_linkedin_job_search", provider_call_id: "pc_jobs", url: "https://jobs.example/1", excerpt: null },
  method: "provider_field", observed_at: iso(10), valid_until: null, confidence, derived_from: [], mission_id: TASK, origin: "lead_mission",
  ...over,
});
const finding = (item: EvidenceItem) => ({ company_key: KEY, item, answered: true, detail: {} });
const VERIFIER = { key: "hiring", route_actor: "apify_linkedin_job_search" };
const verifierItem = (c: EngineCompany) =>
  c.observations!.flatMap((o) => o.evidence).find((e) => e.evidence_id === `vfy_${KEY}_hiring`)!;

Deno.test("GENERIC: a verifier's weaker re-answer keeps the proven one; a decisive contrary answer replaces it", () => {
  const c = citian();
  applyVerifierFinding(c, finding(hiringItem("proven", "high")), VERIFIER);
  applyVerifierFinding(c, finding(hiringItem("plausible", "low")), VERIFIER);
  assertEquals([verifierItem(c).status, verifierItem(c).confidence], ["proven", "high"], "weaker re-read kept out");
  applyVerifierFinding(c, finding(hiringItem("disproven", "medium", { value: { open_role: null } })), VERIFIER);
  assertEquals(verifierItem(c).status, "disproven", "a decisive contradiction is recorded");
  applyVerifierFinding(c, finding(hiringItem("proven", "high", { observed_at: iso(1) })), VERIFIER);
  assertEquals(verifierItem(c).status, "proven", "and the newest decisive answer wins either way");
});

Deno.test("GENERIC: proof that has gone stale no longer blocks a fresher, weaker reading", () => {
  const c = citian();
  applyVerifierFinding(c, finding(hiringItem("proven", "high", { valid_until: iso(60 * 24) })), VERIFIER);
  applyVerifierFinding(c, finding(hiringItem("plausible", "medium")), VERIFIER);
  assertEquals(verifierItem(c).status, "plausible", "freshness requires the re-read");
});

// ═══ THE EXACT LIVE FAILURE, THROUGH THE ENGINE, ACROSS A CHECKPOINT ═════════

const PROBE = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/p3-job-discovery-probe.json", import.meta.url)));
const ROWS = (PROBE.probes["harvestapi~linkedin-job-search"].items as Array<Record<string, unknown>>)
  .filter((r) => (r.company as { name: string }).name === "Audicus");
const AUDICUS_DESCRIPTION = "Audicus is a fast-growing, venture-backed SaaS startup.";
const AUDICUS_PAGE: RegroundPage = {
  source_url: "https://www.audicus.com/pricing", page_intent: "pricing", fetched_at: iso(20),
  source_text: "Audicus Teams: a cloud-based workspace for businesses, billed per seat each month.",
};

Deno.test("LIVE REPLAY: website proof survives the checkpoint and a restored stale grounding — no pending flip, nothing re-bought", async () => {
  assert(ROWS.length > 0, "fixture employer present");
  const plan = buildCapabilityGraph(MISSION, { executability: "enforce" });
  const byUrl = new Map(ROWS.map((r) => [(r.company as { linkedinUrl: string }).linkedinUrl, r.company as Record<string, unknown>]));
  let batchCalls = 0;
  const invoked: string[] = [];
  /** Stage 2: grounds on the LinkedIn description only — what slice 3 checkpointed at 16:26:40. */
  const stage2: Array<{ company_key: string; verification: unknown }> = [];
  const evaluateBatch = (members: Array<{ company_key: string; company_name: string | null; registry: { items: Array<Record<string, unknown>> } }>) => {
    batchCalls++;
    const outcomes = members.map((m) => {
      const desc = m.registry.items.find((x) => x.evidence_type === "company_description")!;
      const claim = {
        claim: "the company's own description", claim_type: "business_model", evidence_ids: [String(desc.evidence_id)],
        evidence_excerpts: [{ evidence_id: String(desc.evidence_id), excerpt: "a fast-growing, venture-backed SaaS startup" }],
      };
      const v = {
        version: "grounded-claims-v1",
        classifier_result: { business_model: { value: "b2b_saas", confidence: 0.9, claims: [claim] } },
        validated_claims: [claim], rejected_claims: [], grounding_score: 1, final_grounded_decision: "pass",
        downgrade_reasons: [], unacknowledged_conflicts: [],
      };
      stage2.push({ company_key: m.company_key, verification: JSON.parse(JSON.stringify(v)) });
      return { company_key: m.company_key, failure: null, detail: null, verification: v };
    });
    return Promise.resolve({ version: "test", foreign_results: [], evaluated: members.length, failed: 0, outcomes });
  };
  const deps = (restored?: Map<string, unknown>) => ({
    planDiscovery: emptyDiscoverySelector(),
    planExecution: () => Promise.resolve({
      reasoning: "replay", steps: [
        { capability: "job_discovery", actor_key: "apify_linkedin_job_search", purpose: "roles", input: { jobTitles: ['"growth marketer"'], locations: ["United States"], postedLimit: "month", maxItems: 10 }, depends_on: [] },
        { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details", input: { companies: ["{{url}}"] }, depends_on: [1] },
        { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [2] },
      ],
    }),
    invoke: (call: { actorKey: string; input: Record<string, unknown>; onProviderRun?: (r: { run_id: string; dataset_id: null }) => void }) => {
      invoked.push(call.actorKey);
      call.onProviderRun?.({ run_id: `run-${call.actorKey}-${invoked.length}`, dataset_id: null });
      if (call.actorKey === "apify_linkedin_job_search") return Promise.resolve(call.input.company ? [] : ROWS);
      if (call.actorKey === "apify_linkedin_company_details") {
        return Promise.resolve(((call.input.companies as string[]) ?? []).map((u) => {
          const c = byUrl.get(u)!;
          return { id: c.id, name: c.name, linkedinUrl: u, website: c.website, employeeCount: c.employeeCount, description: AUDICUS_DESCRIPTION, industries: c.industries, locations: c.locations };
        }));
      }
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
    evaluateBatch,
    ...(restored ? { restoredGroundedResults: restored } : {}),
  });
  const opts = (extra: Record<string, unknown> = {}) => ({
    mission: MISSION, plan, maxCandidates: 10,
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode: "enforce", specScope: { workspace_id: "ws-mono", lineage_id: "lineage-mono" }, ...extra,
  });
  type Run = {
    companies: Array<EngineCompany & { company: { company_name: string } }>; state: Record<string, unknown>;
    rebuild_registry: (key: string, pages: readonly RegroundPage[]) => ReturnType<typeof registryWith> | null;
  };
  const view = (run: Run) => buildWorkbenchMissionView({
    mission: { requested_count: 1, execution_limit: 1, anchor: "hiring" }, criteria: CRITERIA, stage: "complete",
    candidates: missionCandidatesFrom(run as never, { missionId: TASK, now: NOW }),
  });
  const lead = (run: Run) => view(run).leads.find((l) => l.company.name === "Audicus")!;

  // ── SLICE 3 equivalent: Stage 2 on the description, then the website re-read ──
  const run1 = await runCapabilityPlan(deps() as never, opts() as never) as unknown as Run;
  assertEquals(batchCalls, 1);
  const audicus1 = run1.companies.find((c) => c.company.company_name === "Audicus")!;
  assertEquals(lead(run1).hard_checks.industry, "unknown", "description alone: business model in review");
  const pageRegistry = run1.rebuild_registry(audicus1.key, [AUDICUS_PAGE])!;
  const pageId = pageRegistry.items.find((x) => x.evidence_type === "web_page")!.evidence_id;
  const site = {
    claim: "What the company's own site says.", claim_type: "business_model",
    evidence_ids: [pageId], evidence_excerpts: [{ evidence_id: pageId, excerpt: "a cloud-based workspace for businesses, billed per seat" }],
  };
  applyRegroundedVerification(audicus1, {
    version: "grounded-claims-v1",
    classifier_result: { business_model: { value: "b2b_saas", confidence: 0.9, claims: [site] } },
    validated_claims: [site], rejected_claims: [], grounding_score: 1, final_grounded_decision: "pass",
    downgrade_reasons: [], unacknowledged_conflicts: [],
  } as never, TASK, iso(16), pageRegistry);
  const afterReread = lead(run1);
  assertEquals(afterReread.hard_checks.industry, "pass", "the website proves it");

  // ── CHECKPOINT. Stage 2's results are the STALE, pre-re-read ones (production) ──
  const snap = checkpointSnapshot(run1.state as never, run1.companies as never);
  assert(snap.coherent, String(snap.incoherence));
  const records = JSON.parse(JSON.stringify(snap.resume_records));
  const state = JSON.parse(JSON.stringify(snap.state));
  state.completed_capabilities = state.completed_capabilities.filter((c: string) => c !== "company_brain_qualification");
  if (!state.pending_capabilities.includes("company_brain_qualification")) {
    state.pending_capabilities = ["company_brain_qualification", ...state.pending_capabilities];
  }
  // As in production slice 4: slice 3's qualification loop stopped on its
  // deadline (`execution_deadline_checkpoint`), so the company carries no
  // decision and is re-qualified from the restored Stage-2 result.
  for (const r of records) {
    if (r.company_key !== audicus1.key) continue;
    r.brain = "not_started";
    r.snapshot.brain = null;
    r.snapshot.mission_evaluation = null;
  }
  const restoredStale = new Map(stage2.map((s) => [s.company_key, s.verification]));

  // ── SLICE 4 equivalent: a fresh process, from the checkpoint only ──
  batchCalls = 0;
  invoked.length = 0;
  const run2 = await runCapabilityPlan(deps(restoredStale) as never, opts({
    state, resume: { workspace_id: "ws-mono", lineage_root_task_id: TASK, records },
  }) as never) as unknown as Run;
  assertEquals(batchCalls, 0, "no second grounding call: the stored result is reused");
  assertEquals(invoked, [], "no provider is bought again");

  const audicus2 = run2.companies.find((c) => c.company.company_name === "Audicus")!;
  const bm = companyEvidenceItems(audicus2 as never, TASK).find((e) => e.dimension === "business_model")!;
  assertEquals([bm.status, bm.assessment?.business_model_decision], ["proven", "accepted"], "the claim stays proven");
  assertEquals(bm.source.url, AUDICUS_PAGE.source_url, "website-backed provenance survives");
  assert(bm.derived_from.length > 0 && bm.derived_from.every((id) => id.startsWith("web_page:")), bm.derived_from.join(","));
  const after = lead(run2);
  assertEquals(after.hard_checks.industry, "pass", "industry remains satisfied");
  assertEquals(after.bucket, afterReread.bucket, "the company does not move to pending");

  // The proof is in the rebuilt registry too, so the page is not bought or re-read.
  const regRows = (audicus2.evidence_registry?.items ?? []).filter((it) => it.evidence_type === "web_page");
  assertEquals(regRows.map((it) => it.source_url), [AUDICUS_PAGE.source_url]);
  let grounded = 0;
  const report = await regroundPendingClaims({
    requiresCommercialSignal: true, limit: 1,
    candidates: [{ company_key: audicus2.key, business_model_pending: true, grounded_source_urls: regRows.map((it) => it.source_url ?? "") }],
    deps: {
      pagesFor: () => Promise.resolve([AUDICUS_PAGE]), rebuildRegistry: (_k, p) => run2.rebuild_registry(audicus2.key, p),
      ground: () => { grounded++; return Promise.resolve(null); }, apply: () => ({ item: null, decision: null }),
    },
  });
  assertEquals([report.outcomes[0].skipped, grounded], ["no_new_pages", 0], "no redundant re-grounding of a page already read");
});
