// Synthetic, source-backed control quotes. No model, network or provider call.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalBusinessModel,
  excerptInconsistency,
  statedFacets,
  unstatedFacets,
} from "../../../supabase/functions/_shared/businessModelMatch.ts";
import {
  businessModelDecision,
  parseGroundedResult,
  verifyGroundedResult,
} from "../../../supabase/functions/_shared/groundedClaims.ts";
import { buildCompanyEvidence } from "../../../supabase/functions/_shared/leadCompanyEvidence.ts";
import { buildEvidenceRegistry } from "../../../supabase/functions/_shared/leadEvidenceRegistry.ts";

function verify(code: string, quote: string) {
  const key = "buyer-context-control";
  const registry = buildEvidenceRegistry({
    evidence: buildCompanyEvidence({
      company_key: key,
      source_capability: "known_company_resolution",
      source_query: "synthetic",
      company: {
        company_name: "Control",
        linkedin_company_url: null,
        canonical_domain: "control.example",
        website: "https://control.example",
        geography: null,
        provider_industry: null,
        description: null,
        field_trust: {},
        missing_fields: [],
        raw_ref: {
          actor_key: "apify_linkedin_company_details",
          source_id: key,
        },
      } as never,
      enriched: null,
      identity_state: "resolved",
      linkedin_company_url: null,
      commercial_jobs: [],
      strongest_signal: null,
    }),
    web_pages: [{
      source_url: "https://control.example/product",
      page_intent: "product",
      source_text: quote,
      fetched_at: "2026-10-14T12:00:00.000Z",
    }],
  } as never);
  const id =
    registry.items.find((i) =>
      i.source_url === "https://control.example/product"
    )!.evidence_id;
  const result = parseGroundedResult({
    business_model: {
      value: code,
      confidence: 0.9,
      claims: [{
        claim: "Synthetic product description",
        claim_type: "business_model",
        evidence_ids: [id],
        evidence_excerpts: [{ evidence_id: id, excerpt: quote }],
      }],
    },
    company_fit: "pass",
    agentory_use_case: "plausible",
    mission_signal_assessment: {
      strongest_signal: null,
      signal_strength: "none",
      evidence_ids: [],
      reason: "",
    },
    supporting_claims: [],
    conflicting_evidence_ids: [],
    missing_evidence: [],
    unknown_fields: [],
    confidence: 0.9,
    reason: "",
  });
  return { registry, verification: verifyGroundedResult({ registry, result }) };
}
for (
  const quote of [
    "Our cloud-based SaaS software is built for staffing agencies.",
    "Our software is sold to consulting firms.",
    "Our SaaS application is designed for professional service providers.",
  ]
) {
  Deno.test(`buyer context: a software vendor's customers are not its primary service delivery — ${quote}`, () => {
    const code = quote.includes("SaaS") ? "b2b_saas" : "b2b_software";
    const { verification } = verify(code, quote);
    assertEquals(
      verification.rejected_claims,
      [],
      "the actual quoted source must validate",
    );
    assertEquals(excerptInconsistency(code, [quote]), null);
    assert(!statedFacets([quote]).has("service_primary"));
    assertEquals(businessModelDecision(verification).decision, "accepted");
  });
}
Deno.test("buyer context: SaaS and software companies are customers, not proof of a consultant being software", () => {
  const quote = "We offer consulting services for B2B SaaS software companies.";
  assertEquals(
    canonicalBusinessModel("B2B consulting services for SaaS companies"),
    "b2b_service",
  );
  const facts = statedFacets([quote]);
  assert(facts.has("business_customer") && facts.has("service_primary"));
  assert(!facts.has("software_product") && !facts.has("saas_delivery"));
  assertEquals(
    businessModelDecision(verify("b2b_service", quote).verification).decision,
    "accepted",
  );
  assertEquals(
    businessModelDecision(verify("b2b_saas", quote).verification).decision,
    "review",
  );
});
Deno.test("buyer context: AI companies as customers do not establish an AI product", () => {
  const quote = "Our software is built for AI companies.";
  assert(!statedFacets([quote]).has("ai"));
  assertEquals(unstatedFacets("ai_saas", [quote]), ["ai", "saas_delivery"]);
});
Deno.test("buyer context safeguards: genuine mixed delivery, missing delivery and negated quotes remain review", () => {
  for (
    const quote of [
      "Our B2B SaaS software and consulting services are sold to businesses.",
      "A platform for consulting firms.",
      "We are not a consulting agency; we sell B2B SaaS software.",
      "Our software serves businesses and consumers.",
    ]
  ) {
    assertEquals(
      businessModelDecision(verify("b2b_saas", quote).verification).decision,
      "review",
      quote,
    );
  }
});
