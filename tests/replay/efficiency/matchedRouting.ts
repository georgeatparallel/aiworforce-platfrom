// Measurement only: canonical qualification on supplied evidence, never routing.
import type { EvidenceItem } from "../../../supabase/functions/_shared/candidateObservation.ts";
import type { MissionCriterion } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { buildCompanyEvidenceGraph } from "../../../supabase/functions/_shared/evidenceGraph.ts";
import { canonicalJson } from "../../../supabase/functions/_shared/providerInputFingerprint.ts";

export type Label = "MATCH" | "NON_MATCH" | "UNKNOWN";
export const fraction = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  percentage: denominator ? 100 * numerator / denominator : null,
});
export interface RoutingRun {
  id: string;
  provenance: "recorded" | "synthetic_control";
  strategy: "job_first" | "company_first";
  criteria: MissionCriterion[];
  /** Includes requested output/count and all compiled mission semantics. */
  compiled_mission_hash: string;
  /** Includes actor versions, discovery limits and all credit/candidate caps. */
  execution_policy_fingerprint: string;
  /** Same independently reviewed opportunity/evidence universe, not merely the same query text. */
  evidence_snapshot_id: string;
  observed_at: string;
  completion_boundary: string;
  qualification_policy_version: string;
  budget_usd: number | null;
  companies: Array<
    { key: string; independent_label: Label; evidence: EvidenceItem[] }
  >;
  calls: Array<{
    id: string;
    kind: "purchase" | "adoption" | "cache";
    estimated_price?: {
      usd: number;
      provenance: "recorded" | "synthetic_control";
      source_fixture: string;
      observed_at: string;
    } | null;
  }>;
}

export function routingMetrics(run: RoutingRun) {
  if (
    run.companies.some((company) =>
      !["MATCH", "NON_MATCH", "UNKNOWN"].includes(company.independent_label)
    )
  ) throw new Error("Explicit independent labels are required");
  if (
    !run.criteria.some((criterion) =>
      criterion.kind === "hard" && criterion.status === "ok"
    )
  ) throw new Error("A scored mission needs explicit enforceable requirements");
  if (!Number.isFinite(Date.parse(run.observed_at))) {
    throw new Error("Routing observation date is required");
  }
  if (new Set(run.companies.map((c) => c.key)).size !== run.companies.length) {
    throw new Error("Duplicate company keys");
  }
  if (new Set(run.calls.map((c) => c.id)).size !== run.calls.length) {
    throw new Error(
      "Duplicate call IDs; collapse repeated ledger observations first",
    );
  }
  const companies = run.companies.map((company) => ({
    ...company,
    eligibility: evaluateEligibility(
      run.criteria,
      buildCompanyEvidenceGraph(company.key, company.evidence, {
        now: new Date(run.observed_at),
      }),
    ).eligibility,
  }));
  const qualified = companies.filter((company) =>
    company.eligibility === "eligible"
  );
  const known = companies.filter((company) =>
    company.independent_label !== "UNKNOWN"
  );
  const purchases = run.calls.filter((call) => call.kind === "purchase");
  const pricesSupported = run.provenance === "recorded" &&
    purchases.every((call) => {
      const price = call.estimated_price;
      return price?.provenance === "recorded" && Number.isFinite(price.usd) &&
        price.usd >= 0 &&
        !!price.source_fixture.trim() &&
        Number.isFinite(Date.parse(price.observed_at));
    });
  const estimate = pricesSupported
    ? purchases.reduce(
      (total, call) => total + (call.estimated_price?.usd ?? 0),
      0,
    )
    : null;
  return {
    provenance: run.provenance,
    unique_discovered: companies.length,
    evidence_supported_qualified: qualified.length,
    yield: fraction(qualified.length, companies.length),
    unknown_truth: fraction(companies.length - known.length, companies.length),
    unknown_outcomes: fraction(
      companies.filter((company) => company.eligibility === "pending").length,
      companies.length,
    ),
    supported_matches:
      qualified.filter((company) => company.independent_label === "MATCH")
        .length,
    unsupported_matches:
      qualified.filter((company) => company.independent_label === "NON_MATCH")
        .length,
    positives_with_unknown_truth:
      qualified.filter((company) => company.independent_label === "UNKNOWN")
        .length,
    false_exclusions: fraction(
      known.filter((company) =>
        company.independent_label === "MATCH" &&
        company.eligibility === "ineligible"
      ).length,
      known.filter((company) => company.independent_label === "MATCH").length,
    ),
    provider_purchases: purchases.length,
    calls_per_qualified: {
      numerator: purchases.length,
      denominator: qualified.length,
      value: qualified.length ? purchases.length / qualified.length : null,
    },
    estimated_usd: estimate,
    estimated_usd_per_qualified: estimate !== null && qualified.length
      ? estimate / qualified.length
      : null,
  };
}

export function compareMatchedRouting(runs: readonly RoutingRun[]) {
  const groups = new Map<string, RoutingRun[]>();
  const unavailable: Array<{ run_id: string; reason: string }> = [];
  for (const run of runs) {
    if (run.provenance !== "recorded") {
      unavailable.push({
        run_id: run.id,
        reason: "synthetic_control_not_real_performance",
      });
      continue;
    }
    if (
      !run.compiled_mission_hash || !run.execution_policy_fingerprint ||
      !run.evidence_snapshot_id || !run.completion_boundary ||
      !run.qualification_policy_version ||
      !Number.isFinite(Date.parse(run.observed_at)) ||
      !run.criteria.some((criterion) =>
        criterion.kind === "hard" && criterion.status === "ok"
      )
    ) {
      unavailable.push({
        run_id: run.id,
        reason: "missing_matched_evidence_or_requirements",
      });
      continue;
    }
    const key = canonicalJson({
      mission: run.compiled_mission_hash,
      execution: run.execution_policy_fingerprint,
      criteria: [...run.criteria].sort((a, b) => a.id.localeCompare(b.id)),
      snapshot: run.evidence_snapshot_id,
      observed_at: run.observed_at,
      boundary: run.completion_boundary,
      policy: run.qualification_policy_version,
      budget: run.budget_usd,
    });
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const pairs: Array<
    {
      job_first: ReturnType<typeof routingMetrics>;
      company_first: ReturnType<typeof routingMetrics>;
    }
  > = [];
  for (const group of groups.values()) {
    const jobs = group.filter((run) => run.strategy === "job_first");
    const companies = group.filter((run) => run.strategy === "company_first");
    if (jobs.length !== 1 || companies.length !== 1) {
      for (const run of group) {
        unavailable.push({
          run_id: run.id,
          reason: "no_unique_matched_strategy_pair",
        });
      }
      continue;
    }
    pairs.push({
      job_first: routingMetrics(jobs[0]),
      company_first: routingMetrics(companies[0]),
    });
  }
  return {
    matched_recorded_pairs: pairs.length,
    valid_comparison_available: pairs.length > 0,
    pairs,
    unavailable,
  };
}
