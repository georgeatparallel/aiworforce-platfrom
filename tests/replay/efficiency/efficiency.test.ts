import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  measureResearchReplay,
  recordedEvidenceAudit,
} from "./researchBenchmark.ts";
import {
  compareMatchedRouting,
  fraction,
  routingMetrics,
  type RoutingRun,
} from "./matchedRouting.ts";
import {
  toStoredRows,
  writeWebEvidence,
} from "../../../supabase/functions/_shared/webEvidenceStore.ts";

Deno.test("[claims] efficiency: empty enrichment reuse removes redundant calls with identical canonical UNKNOWN outcomes", async () => {
  const before = JSON.parse(
    Deno.readTextFileSync(new URL("baseline.synthetic.json", import.meta.url)),
  );
  const after = await measureResearchReplay();
  assertEquals(before.calls_by_slice, [2, 2, 0]);
  assertEquals(after.calls_by_slice, [2, 0, 0]);
  assertEquals(before.company_queries_by_slice, [12, 11, 0]);
  assertEquals(after.company_queries_by_slice, [12, 0, 0]);
  assertEquals(before.repeated_answered_empty_queries, 9);
  assertEquals(after.repeated_answered_empty_queries, 0);
  assertEquals(after.samples, 12);
  assertEquals(
    before.outcomes,
    after.outcomes,
    "The actual eligibility checks remain identical",
  );
  assertEquals(after.evidence_supported_qualified, 0);
  assertEquals(after.unknown_outcomes, fraction(12, 12));
  assertEquals(after.unknown_truth, fraction(12, 12));
  assertEquals(
    after.false_exclusions.percentage,
    null,
    "No known MATCH ground truth means this rate is unavailable",
  );
  assertEquals(after.estimated_usd, null);
});

Deno.test("[claims] efficiency: executed baseline pins the synthetic cohort and labels", async () => {
  const before = JSON.parse(
    Deno.readTextFileSync(new URL("baseline.synthetic.json", import.meta.url)),
  );
  assertEquals(
    before.baseline_commit,
    "fec34976d1d88a2539a9aaf8a8e27e5fe2be923a",
  );
  for (
    const path of [
      "../../edge-functions/_shared/emptyEnrichmentReplay.ts",
      "synthetic-labels.json",
    ]
  ) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Deno.readFileSync(new URL(path, import.meta.url)),
    );
    const hex = [...new Uint8Array(digest)].map((n) =>
      n.toString(16).padStart(2, "0")
    ).join("");
    assertEquals(before.cohort_sha256[path], hex);
  }
});

Deno.test("[claims] efficiency: recorded size coverage is band-only and routing data remains explicitly unmatched", () => {
  const audit = recordedEvidenceAudit();
  assertEquals(audit.samples, 11);
  assertEquals(audit.employee_band_coverage.map((range) => range.sufficient), [
    fraction(7, 11),
    fraction(0, 11),
    fraction(0, 11),
    fraction(0, 11),
  ]);
  assertEquals(audit.exact_staff_count_coverage, fraction(0, 11));
  assertEquals(audit.size_precision, null);
  assertEquals(audit.unfinished_run.yield, fraction(0, 10));
  assertEquals(audit.unfinished_run.evaluated, 0);
  assertEquals(audit.unfinished_run.reported_provider_calls, 20);
  assertEquals(audit.unfinished_run.estimated_usd, null);
  assertEquals(audit.routing.matched_recorded_pairs, 0);
  assertEquals(audit.routing.valid_comparison_available, false);
});

// Invented test inputs exercise admission rules only; never placed in recorded
// datasets or presented as actual strategy performance. Changing the mock's
// provenance flag below simulates an imported recorded run for gate tests.
function control(strategy: RoutingRun["strategy"]): RoutingRun {
  return {
    id: strategy,
    compiled_mission_hash: "synthetic-mission",
    execution_policy_fingerprint: "synthetic-execution-policy",
    strategy,
    provenance: "synthetic_control",
    evidence_snapshot_id: "synthetic-world",
    observed_at: "2026-10-14T00:00:00.000Z",
    completion_boundary: "all-work-finished",
    qualification_policy_version: "synthetic-policy",
    budget_usd: null,
    criteria: [{
      id: "geo",
      dimension: "geography",
      value: "United States",
      kind: "hard",
      source: "user_explicit",
      status: "ok",
      label: "US",
      user_phrase: "US",
      rationale: "control",
    }],
    companies: [{
      key: "control.example",
      independent_label: "UNKNOWN",
      evidence: [],
    }],
    calls: [{ id: "purchase", kind: "purchase" }, {
      id: "adoption",
      kind: "adoption",
    }],
  };
}
Deno.test("[claims] efficiency: synthetic routing controls cannot become a recorded comparison", () => {
  const result = compareMatchedRouting([
    control("job_first"),
    control("company_first"),
  ]);
  assertEquals(result.matched_recorded_pairs, 0);
  assertEquals(result.unavailable.length, 2);
});

Deno.test("[claims] efficiency: the routing gate requires unique equivalent missions, snapshots, cutoffs, budgets and completion", () => {
  const job = { ...control("job_first"), provenance: "recorded" as const };
  const company = {
    ...control("company_first"),
    provenance: "recorded" as const,
  };
  assertEquals(
    compareMatchedRouting([job, company]).matched_recorded_pairs,
    1,
    "Gate control only, not a real performance measurement",
  );
  for (
    const patch of [
      { compiled_mission_hash: "different-count-or-output" },
      { execution_policy_fingerprint: "different-credit-or-candidate-cap" },
      { evidence_snapshot_id: "other-world" },
      { observed_at: "2026-10-13T00:00:00.000Z" },
      { completion_boundary: "interrupted" },
      { qualification_policy_version: "other-policy" },
      { budget_usd: 1 },
      { criteria: [{ ...company.criteria[0], value: "Canada" }] },
    ]
  ) {
    assertEquals(
      compareMatchedRouting([job, { ...company, ...patch }])
        .matched_recorded_pairs,
      0,
    );
  }
  assertEquals(
    compareMatchedRouting([job, company, { ...company, id: "duplicate" }])
      .matched_recorded_pairs,
    0,
  );
  assertEquals(
    compareMatchedRouting([{ ...job, criteria: [] }, company])
      .matched_recorded_pairs,
    0,
  );
});

Deno.test("[claims] efficiency: missing and expired evidence remains UNKNOWN and zero qualified has no cost denominator", () => {
  const run = control("job_first");
  const missing = routingMetrics(run);
  assertEquals(missing.evidence_supported_qualified, 0);
  assertEquals(missing.unknown_outcomes, fraction(1, 1));
  assertEquals(
    missing.provider_purchases,
    1,
    "Adoption is never counted as a new purchase",
  );
  assertEquals(missing.calls_per_qualified.value, null);
  run.companies[0].evidence.push({
    evidence_id: "geo",
    company_key: "control.example",
    dimension: "geography",
    value: "United States",
    status: "proven",
    source: {
      provider: "synthetic",
      actor: "synthetic_company_record",
      provider_call_id: "pc",
      url: "https://control.example",
      excerpt: null,
    },
    method: "provider_field",
    observed_at: "2026-10-01T00:00:00.000Z",
    valid_until: "2026-10-13T00:00:00.000Z",
    confidence: "high",
    derived_from: [],
    mission_id: "synthetic",
    origin: "lead_mission",
  });
  assertEquals(routingMetrics(run).evidence_supported_qualified, 0);
  run.companies[0].evidence[0].valid_until = "2026-10-15T00:00:00.000Z";
  const fresh = routingMetrics(run);
  assertEquals(fresh.evidence_supported_qualified, 1);
  assertEquals(
    fresh.positives_with_unknown_truth,
    1,
    "UNKNOWN truth stays distinct even when the evidence decision passes",
  );
  assertEquals(fresh.supported_matches, 0);
  assertEquals(fresh.calls_per_qualified.value, 1);
  assertEquals(
    fresh.estimated_usd,
    null,
    "No recorded price means no invented estimate",
  );
  run.companies[0].independent_label = "MATCH";
  assertEquals(routingMetrics(run).supported_matches, 1);
  run.companies[0].independent_label = "NON_MATCH";
  assertEquals(routingMetrics(run).unsupported_matches, 1);
  run.companies[0].independent_label = "MATCH";
  run.companies[0].evidence[0].value = "Canada";
  assertEquals(
    routingMetrics(run).false_exclusions,
    fraction(1, 1),
    "A reviewed MATCH excluded by contradictory provider proof counts as a false exclusion in the synthetic scorer control",
  );
});

Deno.test("[claims] efficiency: malformed duplicate trace rows are rejected and synthetic prices cannot masquerade as recorded spend", () => {
  const run = control("job_first");
  assertThrows(() =>
    routingMetrics({ ...run, companies: [...run.companies, ...run.companies] })
  );
  assertThrows(() =>
    routingMetrics({ ...run, calls: [...run.calls, ...run.calls] })
  );
  assertThrows(() =>
    routingMetrics({
      ...run,
      companies: [{
        ...run.companies[0],
        independent_label: "missing" as never,
      }],
    })
  );
  run.calls[0].estimated_price = {
    usd: 1,
    provenance: "synthetic_control",
    source_fixture: "synthetic-price",
    observed_at: run.observed_at,
  };
  assertEquals(
    routingMetrics({ ...run, provenance: "recorded" }).estimated_usd,
    null,
  );
  assert(compareMatchedRouting([]).pairs.length === 0);
});

Deno.test("[claims] efficiency: negative page URL collision is a schema-level limitation, not a qualification fact", async () => {
  const rows = toStoredRows({
    workspace_id: "synthetic-workspace",
    company_key: "control.example",
    domain: "control.example",
    pages: ["/about", "/company"].map((path) => ({
      url: `https://control.example${path}`,
      intent: "about",
      markdown: "",
      fetched_at: "2026-10-14T00:00:00.000Z",
      status: "not_found",
    })),
  });
  const held = new Map<string, unknown>();
  const db = {
    from: () => ({
      upsert: (written: typeof rows, options: { onConflict: string }) => {
        for (const row of written) {
          held.set(
            options.onConflict.split(",").map((field) =>
              String(Reflect.get(row, field))
            ).join("|"),
            row,
          );
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
  await writeWebEvidence(db as never, rows);
  assertEquals(new Set(rows.map((row) => row.source_url)).size, 2);
  assertEquals(
    held.size,
    1,
    "Current upsert/index identity coalesces distinct missing URLs; changing the schema is a separate proposal",
  );
  assert(
    rows.every((row) => row.source_text === "" && row.status === "not_found"),
    "A missing page never establishes company fit",
  );
});
