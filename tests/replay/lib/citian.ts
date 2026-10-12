// LEAD V2 REPLAY LAB — CITIAN (Query B f6133796, production 2026-10-11).
//
// The company records, pages and grounded readings of the evidence-regression
// incident, shared by the replay (historical J) and the invariants. Copied
// from tests/edge-functions/_shared/evidenceMonotonicity.test.ts, which pins
// the same incident at the observation store; a test module cannot be
// imported without re-registering its tests.

import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { buildEvidenceRegistry } from "../../../supabase/functions/_shared/leadEvidenceRegistry.ts";
import { buildCompanyEvidence } from "../../../supabase/functions/_shared/leadCompanyEvidence.ts";
import type { RegroundPage } from "../../../supabase/functions/_shared/webEvidenceRegrounding.ts";
import type { GroundedVerification } from "../../../supabase/functions/_shared/groundedClaims.ts";
import {
  applyRegroundedVerification, companyEvidenceItems, missionCandidatesFrom, type EngineCompany,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import {
  entityHintFromCompany, type EvidenceDimension, type EvidenceItem,
} from "../../../supabase/functions/_shared/candidateObservation.ts";

export const TASK = "f6133796-c460-44cd-902e-f28ac638b423";
export const NOW = new Date("2026-10-11T16:45:00.000Z");
export const iso = (minutesAgo = 0) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

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
export const MISSION = compileLeadMission({ originalUserQuery: CANONICAL, proposal }).final_mission;
export const CRITERIA = deriveMissionCriteria(MISSION);

// ── THE TWO READINGS, AS PRODUCTION HAD THEM ────────────────────────────────
//
// Citian's LinkedIn description says "SaaS" but never who buys it, so the
// business model stays in review. Its own site says it sells to businesses.
const DESCRIPTION = "Citian is a fast-growing, venture-backed SaaS startup.";
export const PAGE: RegroundPage = {
  source_url: "https://www.citian.co/about", page_intent: "about", fetched_at: iso(20),
  source_text: "Citian is a cloud-based workspace for businesses, billed per seat each month, for transportation teams.",
};
export const CONSUMER_PAGE: RegroundPage = {
  source_url: "https://www.citian.co/pricing", page_intent: "pricing", fetched_at: iso(5),
  source_text: "Citian sells its app direct to consumers: a personal subscription for individual commuters.",
};

export const KEY = "https://www.linkedin.com/company/citian";

export function registryWith(pages: readonly RegroundPage[]) {
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
export const DESCRIPTION_ONLY = () => verification(registryWith([]), "description", "b2b_saas", "a fast-growing, venture-backed SaaS startup");
export const WEBSITE = () => verification(registryWith([PAGE]), "page", "b2b_saas", "a cloud-based workspace for businesses, billed per seat");
export const WEBSITE_CONSUMER = () => verification(registryWith([CONSUMER_PAGE]), "page", "consumer", "sells its app direct to consumers");
export const DESCRIPTION_CONSUMER = () => verification(registryWith([]), "description", "consumer", "a fast-growing, venture-backed SaaS startup");

let seq = 0;
const proven = (dimension: EvidenceDimension, value: unknown, actor: string): EvidenceItem => ({
  evidence_id: `ev_${dimension}_${++seq}`, company_key: KEY, dimension, value, status: "proven",
  source: { provider: "apify", actor, provider_call_id: `pc_${seq}`, url: KEY, excerpt: null },
  method: "provider_field", observed_at: iso(30), valid_until: null, confidence: "high",
  derived_from: [], mission_id: TASK, origin: "lead_mission",
});

/** Citian as the engine held it: every hard fact proven but the business model. */
export function citian(): EngineCompany {
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
export const read = (c: EngineCompany, v: GroundedVerification, pages: readonly RegroundPage[] = []) =>
  applyRegroundedVerification(c, v, TASK, iso(0), registryWith(pages));

export const businessModel = (c: EngineCompany) =>
  companyEvidenceItems(c, TASK).find((e) => e.dimension === "business_model")!;
/** The aggregated hard industry check (the mission states "b2b saas" and "saas"). */
export const industry = (c: EngineCompany) =>
  evaluateEligibility(CRITERIA, missionCandidatesFrom({ companies: [c] }, { missionId: TASK, now: NOW })[0].graph)
    .hard_checks.industry;

