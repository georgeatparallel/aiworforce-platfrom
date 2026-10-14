import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bandPrediction,
  comparability,
  efficiency,
  type Label,
  labels,
  metrics,
  readJSON,
  recorded,
  report,
} from "./benchmark.ts";
Deno.test("[matrix] quality metrics exclude unknown truth, retain abstentions in recall and disclose every denominator", () => {
  const r = metrics([
    { id: "tp", truth: "MATCH", prediction: "MATCH" },
    { id: "fn", truth: "MATCH", prediction: "NON_MATCH" },
    { id: "abstained", truth: "MATCH", prediction: "UNKNOWN" },
    { id: "fp", truth: "NON_MATCH", prediction: "MATCH" },
    { id: "unlabeled-positive", truth: "UNKNOWN", prediction: "MATCH" },
  ]);
  assertEquals(r.precision, { numerator: 1, denominator: 2, percentage: 50 });
  assertEquals(r.recall, { numerator: 1, denominator: 3, percentage: 33.33 });
  assertEquals(r.unknown_truth, {
    numerator: 1,
    denominator: 5,
    percentage: 20,
  });
  assertEquals(r.positive_predictions_on_unknown_truth, {
    numerator: 1,
    denominator: 3,
    percentage: 33.33,
  });
  assertEquals(r.prediction_coverage, {
    numerator: 4,
    denominator: 5,
    percentage: 80,
  });
  assertEquals(r.confusion.abstained_true_matches, 1);
});
Deno.test("[matrix] quality zero-qualified runs and zero evaluable predictions have undefined ratios", () => {
  assertEquals(metrics([]).precision, {
    numerator: 0,
    denominator: 0,
    percentage: null,
  });
  const r = efficiency(10, 0, 20, null);
  assertEquals(r.yield, { numerator: 0, denominator: 10, percentage: 0 });
  assertEquals(r.calls_per_qualified.value, null);
  assertEquals(r.estimated_cost_per_qualified.value_usd, null);
});
Deno.test("[matrix] quality labels and recorded evidence are separate, complete, unique and auditable", () => {
  const rows = recorded(), annotation = labels();
  assertEquals(new Set(rows.map((r) => r.id)).size, rows.length);
  assertEquals(
    annotation.industry.map((l) => l.id).sort(),
    rows.map((r) => r.id).sort(),
  );
  assert(
    annotation.industry.every((l) =>
      ["MATCH", "NON_MATCH", "UNKNOWN"].includes(l.label) && !!l.rationale &&
      !!l.confidence
    ),
  );
  for (const r of rows) {
    assert(
      r.source_file && r.source_key && r.snapshot_date && r.evidence_type &&
        r.confidence,
    );
    assertEquals(
      r.observation_date,
      null,
      "capture date must not become an invented provider observation date",
    );
  }
  // Original captured descriptions are the reference, not a generated company profile.
  const source = readJSON<
    { companies: { name: string; discovery_row: { description: string } }[] }
  >(
    "tests/fixtures/lead-v2/size-semantics-replay-2026-09-24/canary_companies.json",
    true,
  );
  for (const c of source.companies) {
    assertEquals(
      rows.find((r) => r.id === "size:" + c.name)?.description,
      c.discovery_row.description,
    );
  }
});
Deno.test("[matrix] quality coarse bands never prove narrower or overlapping ranges; associated members never act as exact headcount", () => {
  const row = recorded().find((r) =>
    r.band_evidence_type === "declared_company_record_band"
  )!;
  assertEquals(
    bandPrediction(row, { kind: "band", min: 11, max: 50 }),
    "MATCH",
  );
  assertEquals(
    bandPrediction(row, { kind: "exact_range", min: 11, max: 20 }),
    "UNKNOWN",
  );
  assertEquals(
    bandPrediction(row, { kind: "exact_range", min: 40, max: 70 }),
    "UNKNOWN",
  );
  assertEquals(
    bandPrediction(row, { kind: "exact_range", min: 27, max: 27 }),
    "UNKNOWN",
  );
  assertEquals(
    bandPrediction({ ...row, associated_member_count: 50000 }, {
      kind: "band",
      min: 11,
      max: 50,
    }),
    "MATCH",
  );
  assertEquals(
    bandPrediction(
      { ...row, band_evidence_type: "unverified_discovery_band" },
      { kind: "band", min: 11, max: 50 },
    ),
    "UNKNOWN",
  );
});
Deno.test("[matrix] quality synthetic exact-headcount controls and accounting plans remain outside recorded performance", () => {
  const r = report();
  assertEquals(r.industry.metrics.sample_count, 21);
  assertEquals(r.company_size.band_level.metrics.sample_count, 11);
  assertEquals(r.company_size.exact_headcount.evidence_available, {
    numerator: 0,
    denominator: 11,
    percentage: 0,
  });
  assertEquals(r.synthetic_controls.exact_headcount.precision, {
    numerator: 1,
    denominator: 1,
    percentage: 100,
  });
  assert(
    r.synthetic_controls.accounting_plans.every((p) =>
      p.estimated_cost_per_qualified.value_usd !== null
    ),
  );
  assertEquals(r.recorded_discovery.provider_estimate_coverage, {
    numerator: 0,
    denominator: 20,
    percentage: 0,
  });
  assertEquals(r.routing.valid_comparison_available, false);
  assertEquals(r.industry.grounded_verifier.metrics.sample_count, 0);
  assertEquals(r.industry.grounded_verifier.metrics.recall, {
    numerator: 0,
    denominator: 0,
    percentage: null,
  });
  assertEquals(r.industry.grounded_verifier.missing_output_count, 21);
});
Deno.test("[matrix] quality routing comparability refuses mismatched missions, dates, budgets or populations", () => {
  const a = {
    mission: "funding",
    as_of: "2026-10-14",
    budget: 0.14,
    population: "pool-a",
  };
  assert(comparability(a, { ...a }));
  for (
    const b of [{ ...a, mission: "hiring" }, { ...a, as_of: "2026-09-24" }, {
      ...a,
      budget: 0.28,
    }, { ...a, population: "pool-b" }]
  ) assert(!comparability(a, b));
});
Deno.test("[matrix] quality report percentages always carry numerator and denominator; UNKNOWN is never collapsed", () => {
  const r = report();
  function visit(v: unknown) {
    if (!v || typeof v !== "object") return;
    if ("percentage" in v) {
      assert("numerator" in v && "denominator" in v);
      const rate = v as {
        numerator: number;
        denominator: number;
        percentage: number | null;
      };
      assertEquals(
        rate.percentage,
        rate.denominator
          ? Number((100 * rate.numerator / rate.denominator).toFixed(2))
          : null,
      );
    }
    for (const child of Object.values(v)) visit(child);
  }
  visit(r);
  assertEquals(r.industry.metrics.truth_counts.UNKNOWN, 5);
  const allUnknown: Label = "UNKNOWN";
  assertEquals(
    metrics([{ id: "missing", truth: allUnknown, prediction: allUnknown }])
      .precision.percentage,
    null,
  );
});
