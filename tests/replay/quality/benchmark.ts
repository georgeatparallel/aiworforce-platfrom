import { estimateCallUsd } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
// Offline evidence-facet diagnostics. This is not the model-grounded verifier.
import { matchBusinessModel } from "../../../supabase/functions/_shared/businessModelMatch.ts";
import {
  bandSatisfies,
  linkedInDeclaredSizeBand,
} from "../../../supabase/functions/_shared/companySize.ts";
import { assertSanitized } from "../lib/fixture.ts";
export type Label = "MATCH" | "NON_MATCH" | "UNKNOWN";
export interface Rate {
  numerator: number;
  denominator: number;
  percentage: number | null;
}
export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  percentage: denominator
    ? Number((100 * numerator / denominator).toFixed(2))
    : null,
});
export interface Evaluation {
  id: string;
  truth: Label;
  prediction: Label;
}
export const asLabel = (value: string): Label =>
  value === "pass" ? "MATCH" : value === "fail" ? "NON_MATCH" : "UNKNOWN";
export function metrics(rows: Evaluation[]) {
  const known = rows.filter((r) => r.truth !== "UNKNOWN"),
    positives = known.filter((r) => r.prediction === "MATCH");
  const tp = positives.filter((r) => r.truth === "MATCH").length,
    fp = positives.length - tp;
  const trueMatches = known.filter((r) => r.truth === "MATCH");
  const abstainedMatches =
    trueMatches.filter((r) => r.prediction === "UNKNOWN").length;
  const allPositives = rows.filter((r) => r.prediction === "MATCH");
  return {
    sample_count: rows.length,
    known_truth_count: known.length,
    truth_counts: Object.fromEntries(
      ["MATCH", "NON_MATCH", "UNKNOWN"].map((v) => [
        v,
        rows.filter((r) => r.truth === v).length,
      ]),
    ),
    prediction_counts: Object.fromEntries(
      ["MATCH", "NON_MATCH", "UNKNOWN"].map((v) => [
        v,
        rows.filter((r) => r.prediction === v).length,
      ]),
    ),
    confusion: {
      true_positive: tp,
      false_positive: fp,
      false_negative_non_match:
        trueMatches.filter((r) => r.prediction === "NON_MATCH").length,
      abstained_true_matches: abstainedMatches,
      true_negative:
        known.filter((r) =>
          r.truth === "NON_MATCH" && r.prediction === "NON_MATCH"
        ).length,
    },
    precision: rate(tp, positives.length),
    recall: rate(tp, trueMatches.length),
    label_coverage: rate(known.length, rows.length),
    prediction_coverage: rate(
      rows.filter((r) => r.prediction !== "UNKNOWN").length,
      rows.length,
    ),
    known_label_prediction_coverage: rate(
      known.filter((r) => r.prediction !== "UNKNOWN").length,
      known.length,
    ),
    unknown_truth: rate(rows.length - known.length, rows.length),
    prediction_abstentions: rate(
      rows.filter((r) => r.prediction === "UNKNOWN").length,
      rows.length,
    ),
    positive_predictions_on_unknown_truth: rate(
      allPositives.filter((r) => r.truth === "UNKNOWN").length,
      allPositives.length,
    ),
  };
}
export interface EvidenceRow {
  id: string;
  name: string;
  source_file: string;
  source_key: string;
  snapshot_date: string;
  observation_date: string | null;
  description: string;
  confidence: string;
  evidence_type: string;
  band?: { start: number; end: number };
  band_evidence_type?: string;
  band_confidence?: string;
  exact_headcount?: number | null;
  associated_member_count?: number;
}
export interface Requirement {
  kind: "band" | "exact_range";
  min: number;
  max: number;
}
export interface Labels {
  rubric: { target: string };
  industry: {
    id: string;
    label: Label;
    confidence: string;
    rationale: string;
  }[];
  size: {
    id: string;
    requirement: Requirement;
    label: Label;
    confidence: string;
    rationale: string;
  }[];
}
const local = new URL("./", import.meta.url),
  root = new URL("../../../", import.meta.url);
export function readJSON<T>(path: string, repo = false): T {
  const text = Deno.readTextFileSync(new URL(path, repo ? root : local));
  assertSanitized(path, text);
  return JSON.parse(text);
}
export function recorded() {
  return readJSON<{ rows: EvidenceRow[] }>("recorded-evidence.json").rows;
}
export function labels() {
  return readJSON<Labels>("independent-labels.json");
}
export function industryPrediction(description: string): Label {
  return asLabel(matchBusinessModel("B2B software", description));
}
export function bandPrediction(row: EvidenceRow, req: Requirement): Label {
  // Associated members are explicitly NOT staff; search-only bands are not proof.
  if (row.band_evidence_type !== "declared_company_record_band") {
    return "UNKNOWN";
  }
  const band = linkedInDeclaredSizeBand({ employeeCountRange: row.band });
  return band ? asLabel(bandSatisfies(req, band).verdict) : "UNKNOWN";
}
export function comparability(
  a: { mission: string; as_of: string; budget: number; population: string },
  b: { mission: string; as_of: string; budget: number; population: string },
) {
  return Object.keys(a).every((k) =>
    a[k as keyof typeof a] === b[k as keyof typeof b]
  );
}
export function efficiency(
  discovered: number,
  qualified: number,
  calls: number,
  estimate: number | null,
) {
  return {
    discovered,
    qualified,
    provider_calls: calls,
    yield: rate(qualified, discovered),
    calls_per_qualified: {
      numerator: calls,
      denominator: qualified,
      value: qualified ? calls / qualified : null,
    },
    estimated_cost_per_qualified: {
      numerator_usd: estimate,
      denominator: qualified,
      value_usd: qualified && estimate !== null ? estimate / qualified : null,
    },
  };
}
export function report() {
  const evidence = recorded(),
    annotation = labels(),
    byId = new Map(evidence.map((r) => [r.id, r]));
  const industry = annotation.industry.map((l) => ({
    id: l.id,
    truth: l.label,
    prediction: industryPrediction(byId.get(l.id)!.description),
  }));
  const size = annotation.size.map((l) => ({
    id: l.id,
    requirement: l.requirement,
    truth: l.label,
    prediction: bandPrediction(byId.get(l.id)!, l.requirement),
  }));
  const verifierOutputs = readJSON<
    {
      rows: {
        id: string;
        prediction: Label;
        source_file: string;
        source_key: string;
        provenance_kind: "recorded";
      }[];
    }
  >("recorded-verifier-outputs.json").rows;
  if (
    new Set(verifierOutputs.map((r) => r.id)).size !== verifierOutputs.length
  ) throw Error("Duplicate recorded verifier output");
  const truthById = new Map(annotation.industry.map((r) => [r.id, r.label]));
  for (const r of verifierOutputs) {
    if (
      !truthById.has(r.id) || r.provenance_kind !== "recorded" ||
      !r.source_file || !r.source_key ||
      !["MATCH", "NON_MATCH", "UNKNOWN"].includes(r.prediction)
    ) throw Error("Unjoinable or unproven verifier output: " + r.id);
  }
  const verifierEvaluation = verifierOutputs.map((r) => ({
    id: r.id,
    truth: truthById.get(r.id)!,
    prediction: r.prediction,
  }));
  const bands = evidence.filter((r) => r.band);
  interface RecordedTask {
    id: string;
    result: {
      run_outcome: {
        funnel: { discovered: number };
        qualification: {
          qualified: number;
          evaluated: number;
          not_reached: number;
          not_reached_reason: string;
        };
        spend: { usd_reported: number; provider_calls: number };
      };
    };
  }
  const task = readJSON<RecordedTask>(
    "tests/fixtures/lead-v2/run-4250f181/task.json",
    true,
  );
  // Read only the safe accounting subset of this previously committed capture.
  const calls = JSON.parse(
    Deno.readTextFileSync(
      new URL(
        "tests/fixtures/lead-v2/run-4250f181/lead_execution_calls.json",
        root,
      ),
    ),
  ) as {
    task_id: string;
    record_kind: string;
    provider_run_id: string | null;
    estimated_cost_usd: number | null;
    status: string;
  }[];
  const provider = calls.filter((r) =>
    r.task_id === task.id && r.record_kind === "provider_call" &&
    r.provider_run_id
  );
  const unique = [
    ...new Map(provider.map((r) => [r.provider_run_id, r])).values(),
  ];
  const estimates = unique.filter((r) => r.estimated_cost_usd !== null);
  const estimated = estimates.length === unique.length
    ? estimates.reduce((n, r) => n + r.estimated_cost_usd!, 0)
    : null;
  const out = task.result.run_outcome;
  const synthetic = readJSON<
    {
      provenance: string;
      industry: { id: string; description: string; truth: Label }[];
      sizes: {
        id: string;
        evidence_type: string;
        value: number | { min: number; max: number };
        observed_at: string;
        confidence: string;
        requirement: Requirement;
        truth: Label;
      }[];
    }
  >("synthetic-controls.json");
  const plans = readJSON<
    {
      accounting_plan_note: string;
      accounting_plans: {
        route: string;
        identity: {
          mission: string;
          as_of: string;
          budget: number;
          population: string;
        };
        discovered: number;
        qualified: number;
        calls: { actor: string; input: Record<string, unknown> }[];
      }[];
    }
  >("synthetic-controls.json");
  const planResults = plans.accounting_plans.map((plan) => {
    const calls = plan.calls.map((c) => {
      const card = hiringActorCard(c.actor);
      if (!card) throw Error("Unknown synthetic actor " + c.actor);
      return {
        ...c,
        estimate_usd: estimateCallUsd(c.actor, card.cost_model, c.input),
      };
    });
    return {
      route: plan.route,
      identity: plan.identity,
      calls,
      ...efficiency(
        plan.discovered,
        plan.qualified,
        calls.length,
        Number(calls.reduce((n, c) => n + c.estimate_usd, 0).toFixed(6)),
      ),
    };
  });
  const syntheticSize = synthetic.sizes.map((r) => ({
    id: r.id,
    truth: r.truth,
    prediction: r.evidence_type === "exact_headcount"
      ? (Number(r.value) >= r.requirement.min &&
          Number(r.value) <= r.requirement.max
        ? "MATCH"
        : "NON_MATCH") as Label
      : asLabel(
        bandSatisfies(r.requirement, {
          ...(r.value as { min: number; max: number }),
        }).verdict,
      ),
  }));
  return {
    schema: "discovery-quality-report-v1",
    as_of: "2026-10-14",
    scope:
      "Selected historical fixture sample; no production-wide accuracy claim. No model, network or provider run.",
    industry: {
      subject:
        "Production matchBusinessModel evidence-facet primitive over captured descriptions; NOT end-to-end grounded industry verification",
      target: annotation.rubric.target,
      metrics: metrics(industry),
      rows: industry,
      grounded_verifier: {
        valid_measurement_available: verifierOutputs.length > 0,
        metrics: metrics(verifierEvaluation),
        missing_output_count: evidence.length - verifierOutputs.length,
        note:
          "Missing output is excluded from the evaluation, not fabricated as an UNKNOWN prediction. Actual captured UNKNOWN predictions remain explicit.",
      },
      model_verifier_outputs_available: rate(
        verifierOutputs.length,
        evidence.length,
      ),
      metadata: {
        provider_observation_date_available: rate(
          evidence.filter((r) => r.observation_date !== null).length,
          evidence.length,
        ),
        snapshot_date_available: rate(
          evidence.filter((r) => !!r.snapshot_date).length,
          evidence.length,
        ),
      },
    },
    company_size: {
      band_level: {
        requirement: { min: 11, max: 50 },
        metrics: metrics(size.filter((r) => r.requirement.kind === "band")),
      },
      narrow_range_band_evidence: [{ min: 11, max: 20 }, { min: 40, max: 70 }]
        .map((req) => ({
          requirement: req,
          metrics: metrics(
            size.filter((r) =>
              r.requirement.min === req.min && r.requirement.max === req.max
            ),
          ),
        })),
      exact_headcount: {
        sample_count: bands.length,
        evidence_available: rate(
          bands.filter((r) => r.exact_headcount != null).length,
          bands.length,
        ),
        evaluation_count: 0,
        precision: rate(0, 0),
        reason:
          "No exact staff-count observations. Associated LinkedIn members are not staff headcount.",
      },
      metadata: {
        band_present: rate(bands.length, bands.length),
        read_company_record: rate(
          bands.filter((r) =>
            r.band_evidence_type === "declared_company_record_band"
          ).length,
          bands.length,
        ),
        provider_observation_date_available: rate(
          bands.filter((r) => r.observation_date !== null).length,
          bands.length,
        ),
        snapshot_date_available: rate(
          bands.filter((r) => !!r.snapshot_date).length,
          bands.length,
        ),
      },
      rows: size,
    },
    recorded_discovery: {
      task: task.id,
      qualification_evaluated_count: out.qualification.evaluated,
      capture_scope: "unfinished task; qualification was not evaluated",
      not_reached_count: out.qualification.not_reached,
      not_reached_reason: out.qualification.not_reached_reason,
      ...efficiency(
        out.funnel.discovered,
        out.qualification.qualified,
        unique.length,
        estimated,
      ),
      provider_estimate_coverage: rate(estimates.length, unique.length),
      recorded_summary_provider_calls: out.spend.provider_calls,
      reported_cost_usd: out.spend.usd_reported,
      note:
        "Single captured company-first task, not a complete lineage; cost reported by historic summary is not substituted for missing provider estimates.",
    },
    routing: {
      valid_comparison_available: false,
      matched_pair_count: 0,
      reason:
        "No saved job-first and company-first runs share the same mission, date, budget, population and observation/receipt boundary. Different canaries are not paired.",
    },
    synthetic_controls: {
      provenance: synthetic.provenance,
      accounting_plan_note: plans.accounting_plan_note,
      matched_identity: comparability(
        plans.accounting_plans[0].identity,
        plans.accounting_plans[1].identity,
      ),
      accounting_plans: planResults,
      industry: metrics(
        synthetic.industry.map((r) => ({
          id: r.id,
          truth: r.truth,
          prediction: industryPrediction(r.description),
        })),
      ),
      exact_headcount: metrics(
        syntheticSize.filter((r) =>
          synthetic.sizes.find((s) => s.id === r.id)!.evidence_type ===
            "exact_headcount"
        ),
      ),
      bands: metrics(
        syntheticSize.filter((r) =>
          synthetic.sizes.find((s) => s.id === r.id)!.evidence_type ===
            "employee_band"
        ),
      ),
    },
  };
}
if (import.meta.main) console.log(JSON.stringify(report(), null, 2));
