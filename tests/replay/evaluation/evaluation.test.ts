import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateMissions, exampleEvaluation, labels } from "./evaluate.ts";
import { fraction, missionReport } from "./report.ts";
import { CONTROLS, fixedClock, OBSERVED_AT } from "./scenarios.ts";
import { runGoldenMission } from "../lib/mission.ts";
import { assessSmoke, type SmokeObservation } from "./smokeAcceptance.ts";

let batch: ReturnType<typeof evaluateMissions> | undefined;
const evaluation = () => batch ??= evaluateMissions();

for (const id of Object.keys(labels())) {
  Deno.test(`[golden] evaluation ${id}: canonical outcome, evidence and purchase safeguards`, async () => {
    const r = (await evaluation()).synthetic_controls.find((r) => r.id === id)!;
    assert(r, `missing scenario ${id}`);
    assert(r.acceptance.pass, JSON.stringify(r.acceptance));
    assertEquals(r.cost.actual_provider_receipts_usd, null);
    assertEquals(r.cost.settled_customer_credits, null);
  });
}

Deno.test("[failure] evaluation: worker interruption preserves all companies, decisions and purchased questions", async () => {
  const r = await evaluation();
  assert(r.summary.interruption_preserves_company_outcomes);
  assert(r.summary.interruption_preserves_purchase_count);
  assert(r.summary.interruption_preserves_purchased_questions);
  for (const observation of r.recorded_replays) {
    assert(observation.acceptance.pass);
    assert(Object.values(observation.recovery_checks).every(Boolean));
    assertEquals(observation.label_ref, null);
    assertEquals(
      observation.provenance,
      "recorded_fixture_with_declared_synthetic_rows",
    );
  }
  assertEquals(r.recorded_replays[1].execution.failures, [{
    kind: "injected_worker_death",
    attempt: 2,
    recovered: true,
  }]);
});

Deno.test("[golden] evaluation: frozen clock yields byte-equivalent reports and restores Date", async () => {
  const original = globalThis.Date;
  const first = await evaluation();
  assertEquals(globalThis.Date, original);
  assertEquals(first, await evaluateMissions());
  assertEquals(globalThis.Date, original);
  assertEquals(first.replay_observation_date, OBSERVED_AT);
  assertEquals(first.summary.independently_labeled_recorded_companies, 0);
  assertEquals(first.summary.matched_recorded_routing_pairs, 0);
  assertEquals(first.summary.live_smoke_authorized, false);
  assertEquals(
    exampleEvaluation(first),
    JSON.parse(
      Deno.readTextFileSync(new URL("example-report.json", import.meta.url)),
    ),
  );
});

Deno.test("[claims] evaluation: missing, partial, exact and stale evidence stay distinct; no fabricated denominators", async () => {
  const r = await evaluation();
  const byId = (id: string) => r.synthetic_controls.find((r) => r.id === id)!;
  for (
    const id of [
      "size_partial_overlap",
      "size_member_count_only",
      "funding_partial",
      "hiring_stale",
      "industry_unknown",
    ]
  ) {
    assertEquals(byId(id).counts, {
      discovered: 1,
      qualified: 0,
      rejected: 0,
      unresolved: 1,
    });
    assertEquals(byId(id).cost.estimated_usd_per_qualified_company, null);
  }
  assertEquals(
    byId("size_exact_requirement").provider_calls.total_transport,
    0,
  );
  assertEquals(byId("size_member_count_only").evidence.employee_band_proofs, 0);
  assertEquals(byId("multi_constraint_match").evidence.employee_band_proofs, 1);
  assertEquals(byId("zero_results").company_discovery_yield, fraction(0, 0));
  assertEquals(r.summary.synthetic_label_counts, {
    MATCH: 4,
    NON_MATCH: 3,
    UNKNOWN: 7,
  });
  assertEquals(r.summary.unlabeled_synthetic_scenarios, 1);
});

Deno.test("[budget] evaluation: disjoint companies buy no verifiers; pending adoption isn't another purchase", async () => {
  const r = await evaluation();
  for (const id of ["size_disjoint", "geography_disjoint"]) {
    const actors = r.synthetic_controls.find((r) =>
      r.id === id
    )!.provider_calls.by_actor;
    assertEquals(actors.apify_funding_atomus ?? 0, 0);
    assertEquals(actors.apify_linkedin_job_search ?? 0, 0);
  }
  const adoption = r.synthetic_controls.find((r) =>
    r.id === "interrupted_funding_adoption"
  )!;
  assertEquals(adoption.provider_calls.adoptions, 1);
  assertEquals(adoption.provider_calls.by_actor.apify_funding_pvalyou, 2);
  assertEquals(adoption.provider_calls.duplicate_purchases, 0);
  const capped = r.synthetic_controls.find((r) => r.id === "spending_cap")!;
  assertEquals(
    capped.provider_calls.by_actor.apify_linkedin_job_search ?? 0,
    0,
  );
  assert(capped.cost.ledger_committed_estimate_usd <= 0.05);
});

Deno.test("[budget] report acceptance catches duplicate, missing-reservation and missing-proof mutations", async () => {
  const r = await fixedClock(() =>
    runGoldenMission({
      ...CONTROLS.multi_constraint_match(),
      name: "acceptance-mutation",
    })
  );
  const input = {
    id: "multi_constraint_match",
    mission: CONTROLS.multi_constraint_match().mission,
    view: r.view,
    ledger: r.ledger,
    calls: r.provider.calls,
    terminal: r.terminal,
    queueStatus: r.queue.status,
    expected: { ...labels().multi_constraint_match, max_calls: 20 },
    slices: [],
  };
  assert(missionReport(input).acceptance.pass);
  assert(
    !missionReport({
      ...input,
      calls: [...r.provider.calls, r.provider.calls[0]],
    }).acceptance.checks.no_duplicate_purchase,
  );
  assert(
    !missionReport({ ...input, ledger: { ...r.ledger, reservations: [] } })
      .acceptance.checks.reservation_before_call,
  );
  const unsupported = structuredClone(r.view);
  unsupported.leads[0].hard_check_details[0].provenance = null;
  assert(
    !missionReport({ ...input, view: unsupported }).acceptance.checks
      .every_match_supported,
  );
  const plausible = structuredClone(r.view);
  plausible.leads[0].hard_check_details[0].provenance!.status = "plausible";
  assert(
    !missionReport({ ...input, view: plausible }).acceptance.checks
      .every_match_supported,
  );
  const unpriced = structuredClone(r.provider.calls);
  unpriced[0].estimate_usd = null;
  assertEquals(
    missionReport({ ...input, calls: unpriced }).cost
      .estimated_usd_per_qualified_company,
    null,
  );
  assert(
    !missionReport({
      ...input,
      expected: { ...input.expected, label: "UNKNOWN" },
    }).acceptance.checks.no_unknown_promoted,
  );
});

const goodSmoke = (): SmokeObservation => ({
  preconditions_verified: true,
  independent_evidence_review: true,
  discovered: 2,
  qualified: 1,
  rejected: 0,
  unresolved: 1,
  unsupported_matches: 0,
  false_exclusions: 0,
  unknown_promotions: 0,
  failures: 0,
  duplicate_purchases: 0,
  unreserved_purchases: 0,
  post_stop_purchases: 0,
  criteria_broadened: false,
  cost_complete: true,
  accounting_reconciled: true,
  committed_provider_usd: 0.06,
  committed_model_usd: 0.01,
  settled_credits: 6,
  model_calls: 2,
  provider_purchases: {
    apify_linkedin_job_search: 1,
    apify_linkedin_company_details: 1,
  },
  adoption_polls: 0,
  detail_urls: 2,
  discovery_rows: 2,
  discovery_pages: 1,
  slices: 1,
  duration_seconds: 90,
  terminal_rows_consistent: true,
  no_held_claim_or_lease: true,
  terminal: "completed",
});

Deno.test("[claims] proposed smoke acceptance: honest zero-result safety pass is not efficacy pass", () => {
  assert(assessSmoke(goodSmoke()).pass);
  const empty = assessSmoke({
    ...goodSmoke(),
    discovered: 0,
    qualified: 0,
    unresolved: 0,
    terminal: "search_exhausted",
  });
  assert(empty.safety_pass);
  assert(!empty.efficacy_pass);
  assert(!empty.pass);
  assert(empty.zero_result);
});

const violations: Array<[string, Partial<SmokeObservation>]> = [
  ["unsupported match", { unsupported_matches: 1 }],
  ["unknown promotion", { unknown_promotions: 1 }],
  ["unknown cost", { committed_provider_usd: null }],
  ["missing receipt reconciliation", { accounting_reconciled: false }],
  ["over budget", { committed_provider_usd: 0.21 }],
  ["unpriced model", { committed_model_usd: null }],
  ["excess model spend", { committed_model_usd: 0.051 }],
  ["excess credits", { settled_credits: 21 }],
  ["unexpected funding provider", {
    provider_purchases: { apify_funding_atomus: 1 },
  }],
  ["duplicate purchase", { duplicate_purchases: 1 }],
  ["purchase after cancellation", { post_stop_purchases: 1 }],
  ["lease retained", { no_held_claim_or_lease: false }],
  ["unbounded discovery", { discovered: 4, qualified: 1, unresolved: 3 }],
  ["fractional call count", { model_calls: 0.5 }],
  ["no preconditions", { preconditions_verified: false }],
];
for (const [name, mutation] of violations) {
  Deno.test(`[claims] proposed smoke acceptance fails closed: ${name}`, () => {
    const r = assessSmoke({ ...goodSmoke(), ...mutation });
    assert(!r.pass);
    assert(r.failed_checks.length > 0);
  });
}
