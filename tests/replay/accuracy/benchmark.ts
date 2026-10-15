// Offline evidence interpretation, not a model/provider accuracy benchmark.
import { buildCompanyEvidence } from "../../../supabase/functions/_shared/leadCompanyEvidence.ts";
import { buildEvidenceRegistry } from "../../../supabase/functions/_shared/leadEvidenceRegistry.ts";
import {
  parseGroundedResult,
  verifyGroundedResult,
} from "../../../supabase/functions/_shared/groundedClaims.ts";
import { groundedBusinessModelItem } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCompanyEvidenceGraph } from "../../../supabase/functions/_shared/evidenceGraph.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import {
  bandSatisfies,
  linkedInDeclaredSizeBand,
} from "../../../supabase/functions/_shared/companySize.ts";
import type { MissionCriterion } from "../../../supabase/functions/_shared/missionCriteria.ts";
import type { EvidenceItem } from "../../../supabase/functions/_shared/candidateObservation.ts";

export type Label = "MATCH" | "NON_MATCH" | "UNKNOWN";
export function ratio(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    percentage: denominator ? 100 * numerator / denominator : null,
  };
}
const load = (path: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(path, import.meta.url)));
export const controls = load("synthetic-evidence.json") as {
  rows: Array<{
    id: string;
    source_url: string;
    observed_at: string;
    evidence_type: string;
    source_text: string;
    proposed_business_model: string;
    employee_band: { min: number; max: number; source: "linkedin_declared" };
    size_evidence_type: string;
    size_confidence: "high";
  }>;
};
const labels = load("synthetic-labels.json") as {
  rows: Array<{ id: string; label: Label; rationale: string }>;
};
const criterion = (
  dimension: MissionCriterion["dimension"],
  value: unknown,
): MissionCriterion => ({
  id: dimension,
  dimension,
  value,
  kind: "hard",
  source: "user_explicit",
  status: "ok",
  label: dimension,
  user_phrase: "synthetic benchmark requirement",
  rationale: "synthetic control",
});

export function evaluateControl(
  row: typeof controls.rows[number],
  additional: MissionCriterion[] = [],
) {
  const evidence = buildCompanyEvidence({
    company_key: row.id,
    source_capability: "known_company_resolution",
    source_query: "synthetic",
    company: {
      company_name: row.id,
      canonical_domain: `${row.id}.example`,
      website: row.source_url,
      linkedin_company_url: null,
      geography: null,
      provider_industry: null,
      description: null,
      field_trust: {},
      missing_fields: [],
      raw_ref: {
        actor_key: "apify_linkedin_company_details",
        source_id: row.id,
      },
    } as never,
    enriched: null,
    identity_state: "resolved",
    linkedin_company_url: null,
    commercial_jobs: [],
    strongest_signal: null,
  });
  const registry = buildEvidenceRegistry({
    evidence,
    web_pages: [{
      source_url: row.source_url,
      page_intent: "product",
      source_text: row.source_text,
      fetched_at: row.observed_at,
    }],
  } as never);
  const id = registry.items.find((item) => item.source_url === row.source_url)!
    .evidence_id;
  const result = parseGroundedResult({
    business_model: {
      value: row.proposed_business_model,
      confidence: 0.9,
      claims: [{
        claim: "synthetic offering",
        claim_type: "business_model",
        evidence_ids: [id],
        evidence_excerpts: [{ evidence_id: id, excerpt: row.source_text }],
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
    reason: "synthetic",
  });
  const grounded = verifyGroundedResult({ registry, result });
  const item = groundedBusinessModelItem(
    { key: row.id, grounded, evidence_registry: registry } as never,
    "synthetic",
    row.observed_at,
  );
  const size: EvidenceItem = {
    evidence_id: `size:${row.id}`,
    company_key: row.id,
    dimension: "company_size_band",
    value: row.employee_band,
    status: "proven",
    source: {
      provider: "synthetic",
      actor: "synthetic_declared_band",
      provider_call_id: null,
      url: row.source_url,
      excerpt: null,
    },
    method: "provider_field",
    observed_at: row.observed_at,
    valid_until: null,
    confidence: row.size_confidence,
    derived_from: [],
    mission_id: "synthetic",
    origin: "lead_mission",
  };
  const eligibility = evaluateEligibility(
    [
      criterion("industry", "b2b software"),
      criterion("company_size", { min: 11, max: 50 }),
      ...additional,
    ],
    buildCompanyEvidenceGraph(row.id, [size, ...(item ? [item] : [])], {
      now: new Date(row.observed_at),
    }),
  );
  const check = eligibility.checks.find((check) =>
    check.dimension === "industry"
  )!;
  return {
    id: row.id,
    prediction:
      (check.result === "pass"
        ? "MATCH"
        : check.result === "fail"
        ? "NON_MATCH"
        : "UNKNOWN") as Label,
    eligibility: eligibility.eligibility,
    checks: eligibility.checks,
    source: item?.source ?? null,
    confidence: item?.confidence ?? null,
    observed_at: item?.observed_at ?? null,
  };
}

export function summarize(
  rows: Array<
    {
      truth: Label;
      prediction: Label;
      eligibility: string;
      checks: Array<{ result: string }>;
    }
  >,
) {
  const known = rows.filter((row) => row.truth !== "UNKNOWN");
  const predictedPositive = known.filter((row) => row.prediction === "MATCH");
  const truePositive =
    predictedPositive.filter((row) => row.truth === "MATCH").length;
  const mandatory = rows.flatMap((row) => row.checks);
  return {
    samples: rows.length,
    known_truth: known.length,
    unknown_truth: ratio(rows.length - known.length, rows.length),
    unknown_predictions: ratio(
      rows.filter((row) => row.prediction === "UNKNOWN").length,
      rows.length,
    ),
    industry_precision: ratio(truePositive, predictedPositive.length),
    industry_recall: ratio(
      truePositive,
      known.filter((row) => row.truth === "MATCH").length,
    ),
    industry_decision_coverage: ratio(
      rows.filter((row) => row.prediction !== "UNKNOWN").length,
      rows.length,
    ),
    supported_positive_matches: truePositive,
    unsupported_positive_matches: predictedPositive.length - truePositive,
    positive_matches_with_unknown_truth:
      rows.filter((row) =>
        row.truth === "UNKNOWN" && row.prediction === "MATCH"
      ).length,
    false_exclusions:
      known.filter((row) =>
        row.truth === "MATCH" && row.prediction === "NON_MATCH"
      ).length,
    unresolved_known_matches:
      known.filter((row) =>
        row.truth === "MATCH" && row.prediction === "UNKNOWN"
      ).length,
    qualified: rows.filter((row) => row.eligibility === "eligible").length,
    company_yield: ratio(
      rows.filter((row) => row.eligibility === "eligible").length,
      rows.length,
    ),
    mandatory_decision_coverage: ratio(
      mandatory.filter((check) => check.result !== "unknown").length,
      mandatory.length,
    ),
    mandatory_support_coverage: ratio(
      mandatory.filter((check) => check.result === "pass").length,
      mandatory.length,
    ),
  };
}

export function syntheticReport() {
  if (
    new Set(labels.rows.map((row) => row.id)).size !== labels.rows.length ||
    labels.rows.length !== controls.rows.length
  ) {
    throw new Error("Labels must map one-to-one to the controls");
  }
  const rows = controls.rows.map((row) => {
    const truth = labels.rows.find((label) => label.id === row.id)?.label;
    if (!truth) {
      throw new Error(`Missing independently assigned expectation: ${row.id}`);
    }
    return { ...evaluateControl(row), truth };
  });
  return {
    provenance:
      "synthetic controls; no provider/model calls, not production performance",
    rows,
    metrics: summarize(rows),
    provider_calls_per_qualified: null,
    estimated_usd_per_qualified: null,
    cost_limitation:
      "Pure evidence evaluation does not measure discovery purchases or savings.",
  };
}

export function recordedReport() {
  const fixture = load(
    "../../fixtures/lead-v2/size-semantics-replay-2026-09-24/canary_companies.json",
  ) as {
    source: string;
    companies: Array<
      {
        name: string;
        company_record_row: Record<string, unknown> | null;
        discovery_row: Record<string, unknown>;
      }
    >;
  };
  const bands = fixture.companies.map((company) => ({
    name: company.name,
    source: fixture.source,
    observed_at: null,
    snapshot_date: "2026-09-24",
    evidence_type: company.company_record_row
      ? "company_record_declared_band"
      : "discovery_declared_band",
    confidence: null,
    band: linkedInDeclaredSizeBand(company.company_record_row),
    discovery_band: linkedInDeclaredSizeBand(company.discovery_row),
    exact_staff_count: null,
  }));
  const size = (range: { min: number; max: number }) => {
    const predictions = bands.map((row) =>
      row.band ? bandSatisfies(range, row.band).verdict : "unknown"
    );
    return {
      required: range,
      sufficient_evidence_coverage: ratio(
        predictions.filter((p) => p !== "unknown").length,
        bands.length,
      ),
      unknown: ratio(
        predictions.filter((p) => p === "unknown").length,
        bands.length,
      ),
      precision: null,
      precision_limitation:
        "No independent staff census / adjudicated size labels; do not score a source against itself.",
    };
  };
  const task = load("../../fixtures/lead-v2/run-4250f181/task.json");
  const outcome = task.result.run_outcome;
  const qualified = outcome.qualification.qualified as number;
  const calls = outcome.spend.provider_calls as number;
  return {
    provenance: "saved sanitized recorded snapshots only; no new observations",
    size_rows: bands,
    employee_band: [
      size({ min: 11, max: 50 }),
      size({ min: 11, max: 20 }),
      size({ min: 40, max: 70 }),
    ],
    exact_headcount: {
      available: ratio(0, bands.length),
      precision: null,
      limitation: "Associated LinkedIn members are not staff headcount.",
    },
    unfinished_run: {
      source: "tests/fixtures/lead-v2/run-4250f181/task.json",
      task_id: task.id,
      discovered: outcome.funnel.discovered,
      qualification_evaluated: outcome.qualification.evaluated,
      qualified,
      company_yield: ratio(qualified, outcome.funnel.discovered),
      provider_calls_reported: calls,
      provider_calls_per_qualified: qualified ? calls / qualified : null,
      historical_usd_reported: outcome.spend.usd_reported,
      estimated_usd: null,
      estimated_usd_per_qualified: null,
      mandatory_requirement_coverage: null,
      mandatory_coverage_limitation:
        "No aligned per-candidate canonical mandatory proof table for this interrupted run.",
      limitation:
        "Interrupted, identity-unresolved run; not a completed quality cohort. Historical reported USD is not a reconstructed price estimate.",
    },
    grounded_industry: {
      samples: 0,
      precision: null,
      recall: null,
      limitation:
        "No paired recorded grounded answers and independent labels. PR #75's raw-text 1/8 recall is a different diagnostic.",
    },
    routing: {
      matched_recorded_pairs: 0,
      comparison: null,
      limitation:
        "Missing same mission, equivalent candidate/evidence snapshot, completion boundary and priced call trace for both strategies.",
    },
  };
}

if (import.meta.main) {
  const report = syntheticReport();
  const output = Deno.args.includes("--snapshot")
    ? {
      provenance: report.provenance,
      rows: report.rows.map((row) => ({
        id: row.id,
        truth: row.truth,
        prediction: row.prediction,
        eligibility: row.eligibility,
        checks: row.checks.map((check) => ({ result: check.result })),
      })),
      metrics: report.metrics,
    }
    : { recorded: recordedReport(), synthetic: report };
  console.log(JSON.stringify(output, null, 2));
}
