import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import spec from "../../docs/launch/discovery-smoke-budget.spec.json" with {
  type: "json",
};

Deno.test("smoke specification has one bounded monetary and purchase authorization", () => {
  const l = spec.limits;
  assertEquals(l.total_authorized_usd, 0.25);
  assertEquals(
    l.provider_committed_max_usd + l.model_committed_max_usd,
    l.total_authorized_usd,
  );
  assertEquals(l.provider_purchases, 5);
  assertEquals(l.customer_credits, 5);
  assertEquals(l.model_attempts, 4);
  assertEquals(l.runtime_ms, 300000);
  assertEquals([l.workspaces, l.workers], [1, 1]);
  assertEquals(l.other_actors, 0);
  assertEquals(l.discovery_pages, 1);
  assertEquals(l.provider_polls, 5);
});

Deno.test("candidate settings tighten the old proposal and distinguish per-request guards", () => {
  const e = spec.candidate_environment_spec_not_applied;
  assertEquals(
    Number(e.LEAD_V2_MISSION_PROVIDER_USD_CAP),
    spec.limits.provider_committed_max_usd,
  );
  assertEquals(
    Number(e.LEAD_V2_MISSION_CREDIT_CAP),
    spec.limits.provider_purchases,
  );
  assertEquals(Number(e.MODEL_RUN_MAX_ALL_CALLS), spec.limits.model_attempts);
  assertEquals(e.LEAD_V2_SMOKE_WALL_CLOCK, "enforce");
  assertEquals(e.MODEL_RUN_REQUIRE_PRICED, "true");
  assertEquals(e.LEAD_V2_WORKER_WORKSPACES, e.LEAD_V2_MISSION_CAP_WORKSPACES);
  assertEquals(
    spec.enforcement.local_all_model_attempts,
    "IMPLEMENTED_REQUEST_ONLY",
  );
  assert(
    spec.enforcement.durable_mission_model_reservations.startsWith("BLOCKED"),
  );
});

Deno.test("unproved durable enforcement and test billing keep activation blocked", () => {
  assertEquals(spec.status, "BLOCKED");
  assertEquals(spec.authorizes_execution, false);
  assertEquals(spec.activation_gate.ready, false);
  assert(spec.activation_gate.separate_execution_approval_required);
  assert(spec.activation_gate.durable_failure_injection_required);
  assert(spec.activation_gate.worker_proposal_remains_inactive);
  assert(!spec.activation_gate.all_required_prices_verified);
  assert(!spec.activation_gate.live_receipts_and_credits_reconciled);
  assert(!spec.activation_gate.nonproduction_target_verified);
  assert(
    spec.enforcement.atomic_shared_usd_and_purchase_limits.startsWith(
      "BLOCKED",
    ),
  );
  assert(spec.enforcement.actual_vendor_charge_maximum.startsWith("BLOCKED"));
});

Deno.test("specification is an inert JSON/document contract, not an active worker workflow", () => {
  for (
    const file of Deno.readDirSync(
      new URL("../../.github/workflows/", import.meta.url),
    )
  ) {
    const source = Deno.readTextFileSync(
      new URL(`../../.github/workflows/${file.name}`, import.meta.url),
    );
    assert(!source.includes("discovery-smoke-budget.spec.json"));
    assert(!source.includes("LEAD_V2_SMOKE_WALL_CLOCK"));
  }
});
