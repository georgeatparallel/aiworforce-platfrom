import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  controls,
  evaluateControl,
  ratio,
  recordedReport,
  summarize,
  syntheticReport,
} from "./benchmark.ts";
import type { MissionCriterion } from "../../../supabase/functions/_shared/missionCriteria.ts";

Deno.test("[claims] accuracy: source-backed buyer controls improve recall without unsupported positives", () => {
  const after = syntheticReport();
  const before = JSON.parse(
    Deno.readTextFileSync(new URL("baseline.synthetic.json", import.meta.url)),
  );
  assertEquals(before.metrics, summarize(before.rows));
  assertEquals(after.metrics.industry_precision, ratio(4, 4));
  assertEquals(after.metrics.industry_recall, ratio(4, 4));
  assertEquals(after.metrics.unknown_truth, ratio(4, 10));
  assertEquals(after.metrics.unknown_predictions, ratio(4, 10));
  assertEquals(after.metrics.unsupported_positive_matches, 0);
  assertEquals(after.metrics.positive_matches_with_unknown_truth, 0);
  assertEquals(after.metrics.false_exclusions, 0);
  assertEquals(after.metrics.unresolved_known_matches, 0);
  assertEquals(after.metrics.company_yield, ratio(4, 10));
  assertEquals(after.metrics.mandatory_decision_coverage, ratio(16, 20));
  assertEquals(before.metrics.industry_recall, ratio(1, 4));
  assertEquals(before.metrics.unresolved_known_matches, 3);
  assertEquals(
    before.metrics.false_exclusions,
    0,
    "An abstention is not a hard exclusion",
  );
  assertEquals(
    before.rows.map((row: { id: string }) => row.id),
    after.rows.map((row) => row.id),
  );
  assertEquals(
    after.rows.map((row) => row.truth),
    before.rows.map((row: { truth: string }) => row.truth),
  );
  for (const row of after.rows.filter((row) => row.prediction === "MATCH")) {
    assert(row.source?.url?.endsWith(".example/product"));
    assertEquals(row.confidence, "medium");
    assertEquals(row.observed_at, "2026-10-14T12:00:00.000Z");
  }
});

Deno.test("[claims] accuracy: industry acceptance cannot replace missing geography, funding or hiring proof", () => {
  for (const dimension of ["geography", "funding", "hiring"] as const) {
    const hard: MissionCriterion = {
      id: dimension,
      dimension,
      kind: "hard",
      value: dimension === "geography" ? "United States" : true,
      label: dimension,
      source: "user_explicit",
      status: "ok",
      user_phrase: "synthetic",
      rationale: "synthetic",
    };
    const row = evaluateControl(controls.rows[0], [hard]);
    assertEquals(row.prediction, "MATCH");
    assertEquals(row.eligibility, "pending");
    assertEquals(
      row.checks.find((check) => check.dimension === dimension)?.result,
      "unknown",
    );
  }
});

Deno.test("[claims] accuracy: UNKNOWN truth stays outside precision/recall; abstentions count against recall", () => {
  const stats = summarize([
    {
      truth: "MATCH",
      prediction: "MATCH",
      eligibility: "eligible",
      checks: [],
    },
    {
      truth: "MATCH",
      prediction: "UNKNOWN",
      eligibility: "pending",
      checks: [],
    },
    {
      truth: "NON_MATCH",
      prediction: "MATCH",
      eligibility: "eligible",
      checks: [],
    },
    {
      truth: "UNKNOWN",
      prediction: "MATCH",
      eligibility: "eligible",
      checks: [],
    },
  ]);
  assertEquals(stats.industry_precision, ratio(1, 2));
  assertEquals(stats.industry_recall, ratio(1, 2));
  assertEquals(stats.unknown_truth, ratio(1, 4));
  assertEquals(stats.unsupported_positive_matches, 1);
  assertEquals(stats.positive_matches_with_unknown_truth, 1);
  assertEquals(stats.false_exclusions, 0);
  assertEquals(ratio(0, 0).percentage, null);
});

Deno.test("[claims] accuracy: recorded size coverage separates bands, narrow ranges and absent staff counts", () => {
  const recorded = recordedReport();
  assertEquals(recorded.size_rows.length, 11);
  assertEquals(
    recorded.employee_band.map((row) => row.sufficient_evidence_coverage),
    [ratio(7, 11), ratio(0, 11), ratio(0, 11)],
  );
  assertEquals(recorded.exact_headcount.available, ratio(0, 11));
  assert(recorded.employee_band.every((row) => row.precision === null));
  assert(recorded.size_rows.every((row) => row.observed_at === null));
  assertEquals(recorded.unfinished_run.company_yield, ratio(0, 10));
  assertEquals(recorded.unfinished_run.qualification_evaluated, 0);
  assertEquals(recorded.unfinished_run.provider_calls_reported, 20);
  assertEquals(recorded.unfinished_run.provider_calls_per_qualified, null);
  assertEquals(recorded.unfinished_run.estimated_usd_per_qualified, null);
  assertEquals(recorded.unfinished_run.mandatory_requirement_coverage, null);
  assertEquals(recorded.grounded_industry.samples, 0);
  assertEquals(recorded.routing.matched_recorded_pairs, 0);
});

Deno.test("[claims] accuracy: baseline cohort hashes pin evidence and independently assigned labels", async () => {
  const baseline = JSON.parse(
    Deno.readTextFileSync(new URL("baseline.synthetic.json", import.meta.url)),
  );
  assertEquals(
    baseline.baseline_commit,
    "fec34976d1d88a2539a9aaf8a8e27e5fe2be923a",
  );
  for (const name of ["synthetic-evidence.json", "synthetic-labels.json"]) {
    const bytes = Deno.readFileSync(new URL(name, import.meta.url));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((n) =>
      n.toString(16).padStart(2, "0")
    ).join("");
    assertEquals(
      hex,
      baseline.fixture_sha256[name],
      `Regenerate the executed baseline if ${name} changes`,
    );
  }
});
