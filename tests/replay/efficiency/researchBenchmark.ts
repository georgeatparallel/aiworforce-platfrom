import { replayEmptyEnrichment } from "../../edge-functions/_shared/emptyEnrichmentReplay.ts";
import {
  compareMatchedRouting,
  fraction,
  type Label,
  type RoutingRun,
} from "./matchedRouting.ts";
import {
  bandSatisfies,
  linkedInDeclaredSizeBand,
} from "../../../supabase/functions/_shared/companySize.ts";

const load = (path: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(path, import.meta.url)));
export async function measureResearchReplay() {
  const run = await replayEmptyEnrichment({
    specMode: "enforce",
    initialRecord: true,
    emptyCompanies: 11,
  });
  const labels = load("synthetic-labels.json").rows as Array<
    { company_key: string; label: Label }
  >;
  if (
    labels.length !== run.first.companies.length ||
    new Set(labels.map((row) => row.company_key)).size !== labels.length
  ) throw new Error("Labels must map one-to-one");
  const initiallyAnswered = new Set(
    run.first.companies.filter((c) => c.enrichment_outcome === "empty").map((
      c,
    ) => c.identity!.linkedin_company_url),
  );
  const outcomes = run.checks.map((candidate) => {
    const truth = labels.find((label) =>
      label.company_key === candidate.company_key
    )?.label;
    if (!truth) {
      throw new Error(`Missing independent label: ${candidate.company_key}`);
    }
    return { ...candidate, truth };
  });
  const qualified = outcomes.filter((candidate) =>
    run.qualified.includes(candidate.company_key)
  );
  const known = outcomes.filter((candidate) => candidate.truth !== "UNKNOWN");
  return {
    provenance: "synthetic_control",
    execution_mode: "enforced_spine",
    samples: outcomes.length,
    unique_discovered: run.first.companies.length,
    calls_by_slice: [
      run.firstCalls.length,
      run.calls.length,
      run.thirdCalls.length,
    ],
    company_queries_by_slice: [
      run.firstCalls.flat().length,
      run.calls.flat().length,
      run.thirdCalls.flat().length,
    ],
    repeated_answered_empty_queries:
      [...run.calls.flat(), ...run.thirdCalls.flat()].filter((url) =>
        initiallyAnswered.has(url)
      ).length,
    evidence_supported_qualified: qualified.length,
    yield: fraction(qualified.length, outcomes.length),
    unknown_truth: fraction(outcomes.length - known.length, outcomes.length),
    unknown_outcomes: fraction(
      outcomes.filter((candidate) => candidate.eligibility === "pending")
        .length,
      outcomes.length,
    ),
    unsupported_matches:
      qualified.filter((candidate) => candidate.truth === "NON_MATCH").length,
    positives_with_unknown_truth:
      qualified.filter((candidate) => candidate.truth === "UNKNOWN").length,
    false_exclusions: fraction(
      known.filter((candidate) =>
        candidate.truth === "MATCH" && candidate.eligibility === "ineligible"
      ).length,
      known.filter((candidate) => candidate.truth === "MATCH").length,
    ),
    provider_calls_per_qualified: null,
    estimated_usd: null,
    estimated_usd_per_qualified: null,
    cost_limitation:
      "Scripted transport invocations, including a failure; no settled receipts or recorded per-call prices. Zero qualified makes cost per qualified undefined.",
    outcomes,
  };
}

export function recordedEvidenceAudit() {
  const source =
    "../../fixtures/lead-v2/size-semantics-replay-2026-09-24/canary_companies.json";
  const snapshot = load(source) as {
    companies: Array<
      { name: string; company_record_row: Record<string, unknown> | null }
    >;
  };
  const ranges = [{ min: 11, max: 50 }, { min: 11, max: 20 }, {
    min: 40,
    max: 70,
  }, { min: 27, max: 27 }];
  const bands = snapshot.companies.map((company) =>
    linkedInDeclaredSizeBand(company.company_record_row)
  );
  const task = load("../../fixtures/lead-v2/run-4250f181/task.json");
  const outcome = task.result.run_outcome;
  return {
    provenance: "recorded_sanitized_snapshot",
    size_source: source,
    samples: bands.length,
    source_observation_dates: null,
    snapshot_date: "2026-09-24",
    source_confidence: null,
    employee_band_coverage: ranges.map((required) => ({
      required,
      sufficient: fraction(
        bands.filter((band) =>
          band && bandSatisfies(required, band).verdict !== "unknown"
        ).length,
        bands.length,
      ),
    })),
    exact_staff_count_coverage: fraction(0, bands.length),
    size_precision: null,
    size_limitation:
      "Structural band coverage only. No original dates/confidence or independently reviewed staff census; associated members are not staff counts.",
    unfinished_run: {
      task_id: task.id,
      discovered: outcome.funnel.discovered,
      evaluated: outcome.qualification.evaluated,
      qualified: outcome.qualification.qualified,
      reported_provider_calls: outcome.spend.provider_calls,
      yield: fraction(
        outcome.qualification.qualified,
        outcome.funnel.discovered,
      ),
      historical_usd_reported: outcome.spend.usd_reported,
      estimated_usd: null,
      cost_per_qualified: null,
    },
    routing: compareMatchedRouting(
      (load("routing-recordings.json").runs ?? []) as RoutingRun[],
    ),
  };
}

if (import.meta.main) {
  const synthetic = await measureResearchReplay();
  if (Deno.args.includes("--snapshot")) {
    console.log(JSON.stringify(synthetic, null, 2));
  } else {
    const before = load("baseline.synthetic.json");
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    console.log(JSON.stringify(
      {
        recorded: recordedEvidenceAudit(),
        synthetic: {
          before,
          after: synthetic,
          provider_calls_avoided: sum(before.calls_by_slice) -
            sum(synthetic.calls_by_slice),
          company_queries_avoided: sum(before.company_queries_by_slice) -
            sum(synthetic.company_queries_by_slice),
          repeated_answered_empty_queries_avoided:
            before.repeated_answered_empty_queries -
            synthetic.repeated_answered_empty_queries,
        },
      },
      null,
      2,
    ));
  }
}
