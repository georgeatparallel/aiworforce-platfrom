import type { SpendLedger } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { restoreWorkingSet } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import type { LeadMissionV1 } from "../../../supabase/functions/_shared/leadMission.ts";
import { readCheckpointCompanies } from "../../../supabase/functions/_shared/leadResumeState.ts";
import { spendFloorFromRows } from "../../../supabase/functions/_shared/missionSpendCap.ts";
import { assessRequestFeasibility } from "../../../supabase/functions/_shared/requestFeasibility.ts";
import { ChaosLab, type Fault, type LedgerRow } from "../lib/chaos.ts";
import { loadFixture } from "../lib/fixture.ts";
import type { LineageFixture } from "../lib/lineage.ts";
import { runGoldenMission } from "../lib/mission.ts";
import type { RecordedProviderCall } from "../lib/provider.ts";
import { canonicalView } from "../lib/verification.ts";
import { type Expected, fraction, missionReport } from "./report.ts";
import {
  CONTROLS,
  fixedClock,
  industryControl,
  OBSERVED_AT,
} from "./scenarios.ts";

export function labels(): Record<string, Expected> {
  return JSON.parse(
    Deno.readTextFileSync(new URL("labels.synthetic.json", import.meta.url)),
  ).scenarios;
}

function transportCalls(rows: LedgerRow[]): RecordedProviderCall[] {
  return rows.map((r) => ({
    actor: String(r.capability),
    capability: null,
    candidate_keys: [],
    input_hash: "",
    estimate_usd: r.estimate_usd,
    idempotency_key: r.idempotency_key,
    rows: 0,
    input: (r.request_input as { input?: Record<string, unknown> })?.input ??
      {},
    adopted: r.reused,
  }));
}

async function chaosReport(
  id: string,
  fx: LineageFixture,
  expected: Expected,
  faults: Fault[] = [],
) {
  const lab = await ChaosLab.open(fx, faults);
  try {
    await lab.runToSettle();
    const task = await lab.taskRow();
    const result = task?.result ?? {};
    const state = (result.capability_execution_state ?? {}) as {
      spend_ledger?: SpendLedger;
    };
    const companies = restoreWorkingSet(readCheckpointCompanies(result));
    const mission = fx.mission as unknown as LeadMissionV1;
    const view = canonicalView(
      { companies },
      mission,
      fx.provenance.task_id,
      "job_discovery",
    );
    const queue = await lab.lab.row(lab.queueId);
    const lineage = await lab.lineageRow();
    const report = missionReport({
      id,
      mission,
      view,
      ledger: state.spend_ledger ?? null,
      calls: transportCalls(lab.ledger),
      terminal: typeof result.terminal_status === "string"
        ? result.terminal_status
        : null,
      queueStatus: queue.status,
      pendingObservationsAvailable: false,
      expected,
      slices: lab.runs.map((r) => ({
        decision: r.decision ?? r.reason ?? "no_decision",
        qualified: r.qualified?.length ?? 0,
        pending_runs: null,
      })),
    });
    const floor = spendFloorFromRows(lab.ledger.map((r) => ({
      status: r.status ?? null,
      provider_call_id: (r.request_input as {
        provider_call_spec?: { provider_call_id?: string };
      })?.provider_call_spec?.provider_call_id ?? null,
      settled_usd: null,
      actual_cost_usd: null,
      estimate_usd: r.estimate_usd,
      resumed_from:
        (r.request_input as { resume_run_id?: string })?.resume_run_id ?? null,
    })));
    const recoveryChecks = {
      no_duplicate_question: lab.duplicatePurchases().length === 0,
      no_held_claim: !await lab.claimHeld(),
      no_held_lease: lineage?.lease_holder === null &&
        queue.claimed_by === null,
      lineage_terminal: lineage?.status === "terminal",
      rows_agree: task?.status === "complete" && queue.status === "complete" &&
        lab.reconciled.every((r) => r.remaining.length === 0),
      spend_floor_counts_purchases:
        floor.paid_calls === lab.ledger.filter((r) => !r.reused).length,
      injected_failure_observed: !faults.length ||
        lab.events.some((e) => e.at === "worker_died"),
    };
    report.acceptance.pass &&= Object.values(recoveryChecks).every(Boolean);
    return {
      ...report,
      execution: {
        ...report.execution,
        failures: lab.events.filter((e) => e.at === "worker_died").map((e) => ({
          kind: "injected_worker_death",
          attempt: e.attempt,
          recovered: queue.status === "complete",
        })),
        attempts: lab.invocations,
        pending_run_counts_available: false, // ChaosLab does not expose these per slice; never invent zero observations.
      },
      recovery_checks: recoveryChecks,
      purchased_questions: lab.purchases().map((p) => p.key).sort(),
      durable_spend_floor: {
        paid_calls: floor.paid_calls,
        committed_estimate_usd: floor.committed_usd,
        actual_settlement: null,
      },
    };
  } finally {
    await lab.close();
  }
}

/** Full offline batch. Clock mutation and PGlite drivers require sequential execution. */
export async function evaluateMissions() {
  return await fixedClock(async () => {
    const expected = labels();
    const synthetic = [];
    for (const [id, make] of Object.entries(CONTROLS)) {
      const g = { ...make(), name: id };
      const plan = buildCapabilityGraph(g.mission, {
        executability: "enforce",
        readiness: g.readiness,
      });
      const feasibility = assessRequestFeasibility(g.mission, plan, {
        executability: "enforce",
        readiness: g.readiness,
      });
      // The existing golden driver starts AFTER paid-execution preflight. Exercise the refusal separately.
      if (id === "size_exact_requirement") {
        synthetic.push(missionReport({
          id,
          mission: g.mission,
          view: null,
          ledger: null,
          calls: [],
          terminal: feasibility.ok ? null : "preflight_refused",
          queueStatus: null,
          expected: expected[id],
          refusalCodes: feasibility.refusals.map((r) => r.code),
          slices: [],
        }));
        continue;
      }
      const r = await runGoldenMission(g);
      synthetic.push(missionReport({
        id,
        mission: g.mission,
        view: r.view,
        ledger: r.ledger,
        calls: r.provider.calls,
        terminal: r.terminal,
        queueStatus: r.queue.status,
        failures: r.companies.filter((c) =>
          c.enrichment_outcome === "provider_error" ||
          c.stage_block?.reason === "provider_error"
        ).map((c) => ({
          kind: "provider_error",
          company_key: c.key,
          capability: c.stage_block?.capability ?? "company_enrichment",
        })),
        expected: expected[id],
        slices: r.slices.map((s) => ({
          decision: s.decision,
          qualified: s.qualified,
          pending_runs: s.pendingRuns,
        })),
      }));
    }
    for (
      const [id, label] of [["industry_supported", "MATCH"], [
        "industry_non_match",
        "NON_MATCH",
      ], ["industry_unknown", "UNKNOWN"]] as const
    ) {
      synthetic.push(
        await chaosReport(id, industryControl(label), expected[id]),
      );
    }
    // Existing recorded/mixed-provenance fixture, preserved verbatim. Faults are synthetic.
    const historicExpected: Expected = {
      label: null,
      reason:
        "Observed replay outcome, no independent company truth labels assigned.",
      counts: [68, 1, 64, 3],
      terminal: "search_exhausted",
      checks: {},
      max_calls: 7,
    };
    const historical = [];
    for (const interrupted of [false, true]) {
      const fx = loadFixture("queryBd22d9ee6.loop") as LineageFixture;
      const r = await chaosReport(
        interrupted ? "query_b_worker_interrupted" : "query_b_baseline",
        fx,
        historicExpected,
        interrupted ? [{ kind: "worker_dies_after_engine", attempt: 2 }] : [],
      );
      historical.push({
        ...r,
        provenance: "recorded_fixture_with_declared_synthetic_rows" as const,
        label_ref: null,
        evidence_provenance_ref:
          "../fixtures/queryBd22d9ee6.loop.json#/provenance",
        synthetic_rows: fx.provenance.synthetic_rows,
        annotation:
          "Replay outcome only. Model/website findings are recorded outputs; out-of-band employers, staffing rows, query wording and interruption are synthetic. No production-wide accuracy claim.",
      });
    }
    const sameOutcome = JSON.stringify(historical[0].companies) ===
      JSON.stringify(historical[1].companies);
    const samePurchases = historical[0].provider_calls.purchases ===
      historical[1].provider_calls.purchases;
    const sameQuestions = JSON.stringify(historical[0].purchased_questions) ===
      JSON.stringify(historical[1].purchased_questions);
    const all = [...synthetic, ...historical];
    return {
      schema: "discovery-mission-evaluation-v1",
      replay_observation_date: OBSERVED_AT,
      network:
        "denied by Deno permissions and Replay Lab noNetwork; scripted transport only",
      scope:
        "Replay Lab orchestration; not the hosted run-agent endpoint, live models, real receipts or real Supabase contracts",
      synthetic_controls: synthetic,
      recorded_replays: historical,
      summary: {
        scenarios: all.length,
        passing: fraction(
          all.filter((r) => r.acceptance.pass).length,
          all.length,
        ),
        synthetic_label_counts: Object.fromEntries(
          ["MATCH", "NON_MATCH", "UNKNOWN"].map((
            label,
          ) => [
            label,
            Object.values(expected).filter((r) => r.label === label).length,
          ]),
        ),
        unlabeled_synthetic_scenarios: Object.values(expected).filter((r) =>
          r.label === null
        ).length,
        independently_labeled_recorded_companies: 0,
        interruption_preserves_company_outcomes: sameOutcome,
        interruption_preserves_purchase_count: samePurchases,
        interruption_preserves_purchased_questions: sameQuestions,
        matched_recorded_routing_pairs: 0,
        routing_comparison:
          "unavailable: no equivalent recorded mission/evidence/budget/observation boundary pair",
        live_smoke_authorized: false,
        pass: all.every((r) => r.acceptance.pass) && sameOutcome &&
          samePurchases && sameQuestions,
      },
    };
  });
}

export function exampleEvaluation(
  report: Awaited<ReturnType<typeof evaluateMissions>>,
) {
  const r = report.synthetic_controls.find((r) =>
    r.id === "multi_constraint_match"
  )!;
  return {
    schema: report.schema,
    replay_observation_date: report.replay_observation_date,
    example:
      "selected fields from one synthetic control; not production performance",
    scenario: r.id,
    provenance: r.provenance,
    label_ref: r.label_ref,
    counts: r.counts,
    company_discovery_yield: r.company_discovery_yield,
    evidence: r.evidence,
    provider_calls: r.provider_calls,
    cost: r.cost,
    execution: r.execution,
    acceptance_pass: r.acceptance.pass,
    live_smoke_authorized: false,
  };
}

if (import.meta.main) {
  const output = console.log;
  console.log = (...args) => console.error(...args);
  try {
    const report = await evaluateMissions();
    output(
      JSON.stringify(
        Deno.args.includes("--example") ? exampleEvaluation(report) : report,
        null,
        2,
      ),
    );
    if (!report.summary.pass) Deno.exitCode = 1;
  } catch (error) {
    output(
      JSON.stringify({
        schema: "discovery-mission-evaluation-v1",
        batch_failed: true,
        execution_failure: String(error),
        live_smoke_authorized: false,
      }),
    );
    Deno.exitCode = 1;
  } finally {
    console.log = output;
  }
}
