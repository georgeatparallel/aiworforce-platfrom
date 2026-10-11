// LEAD V2 RUN 4250f181 — QUOTA PROVENANCE, DISCOVERY SIZE DRIFT, STAGE PROOF,
// AND A WORKBENCH THAT SEES EVERY ATTEMPT.
//
//   • Asked for 3, executed 1, and every surface showed one or the other.
//   • Attempt 3's memo23 call widened `maxEmployeeSize` to "1000+" for a
//     seed-stage mission whose Company Brain capped size at 150.
//   • "Seed-stage" was a hard constraint that nothing scheduled could prove,
//     and nothing said so — the YC directory has no funding field.
//   • The lineage held 33 companies; the Workbench projected the last 10.
//
// PURE, except the engine run, which uses stubbed providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  prepareV2LeadCount, leadQuotaProvenance,
} from "../../../supabase/functions/_shared/leadMissionV2Request.ts";
import {
  clampMemo23MaxSize, memo23MaxSizeCeiling, runCapabilityPlan, type CapabilityEngineDeps,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { assessRequestFeasibility } from "../../../supabase/functions/_shared/requestFeasibility.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { buildRunOutcome, readFactsFromResult } from "../../../supabase/functions/_shared/runOutcome.ts";
import { stubDiscoverySelector } from "./discoverySelectorFixture.ts";
import type { CompiledActorCall } from "../../../supabase/functions/_shared/hiringActorInputs.ts";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

// ═══ QUOTA ═════════════════════════════════════════════════════════════════

const MISSION = Object.freeze({ requested_count: 3, original_user_query: "Find 3 …" });
const BODY = { lead_mission: MISSION, tool_input: { requested_lead_count: 3, lead_mission: MISSION } };

Deno.test("V2 executes the three leads the approved mission requested", () => {
  const snapshot = JSON.stringify(BODY);
  const out = prepareV2LeadCount(BODY);
  assertEquals(out.requested_lead_count, 3);
  assertEquals(JSON.stringify(BODY), snapshot, "the input is not mutated");
  assert(out.lead_mission === MISSION, "the mission object — and so its hash — is the same object");
  assertEquals(leadQuotaProvenance(out, MISSION.requested_count, 3),
    { mission_requested: 3, execution_quota: 3, source: "mission" });
});

Deno.test("a three-lead mission cannot be SATISFIED after only one or two leads", () => {
  const queued = prepareV2LeadCount(BODY);
  const requested = queued.requested_lead_count as number;
  for (const delivered of [1, 2, 3]) {
    const facts = readFactsFromResult(null, requested);
    const outcome = buildRunOutcome({ ...facts,
      persistence: { leads_written: delivered, signals_written: 0 },
      continuation: { required: false, resumable: true, reason: null },
    });
    assertEquals(outcome.state, delivered === 3 ? "SATISFIED" : "PARTIALLY_SATISFIED");
  }
});

Deno.test("an ordinary run's quota says where it came from", () => {
  assertEquals(leadQuotaProvenance({}, 3, 3).source, "mission");
  assertEquals(leadQuotaProvenance({ requested_lead_count: 5 }, 3, 5).source, "explicit");
  assertEquals(leadQuotaProvenance({}, null, 10).source, "default");
});

Deno.test("run-agent writes both numbers into the result and company_first", () => {
  const ra = read("../../../supabase/functions/run-agent/index.ts");
  assert(ra.includes("const quotaProvenance = leadQuotaProvenance("));
  assertEquals(ra.match(/lead_quota_provenance: quotaProvenance/g)?.length, 2);
});

// ═══ DISCOVERY SIZE CEILING ════════════════════════════════════════════════

Deno.test("the ceiling rounds UP to the actor's enum, never down", () => {
  assertEquals(memo23MaxSizeCeiling(150), "250", "the audited Brain bound");
  assertEquals(memo23MaxSizeCeiling(250), "250");
  assertEquals(memo23MaxSizeCeiling(20), "25");
  assertEquals(memo23MaxSizeCeiling(null), null);
});

Deno.test("the strategy may narrow the size filter but not lift it past the bound", () => {
  assertEquals(clampMemo23MaxSize("1000+", "250"), "250", "the audited drift is clamped");
  assertEquals(clampMemo23MaxSize(undefined, "250"), "250", "absent means no ceiling to memo23");
  assertEquals(clampMemo23MaxSize("100", "250"), "100", "a tighter choice stands");
  assertEquals(clampMemo23MaxSize("1000+", null), "1000+", "no bound, no clamp");
  assertEquals(clampMemo23MaxSize("banana", null), null);
});

Deno.test("the engine's memo23 call carries the clamped ceiling", async () => {
  const inputs: Record<string, unknown>[] = [];
  const m = parseLeadMissionDeterministic("Find 10 qualified AI startups in the US currently hiring");
  await runCapabilityPlan({
    planDiscovery: stubDiscoverySelector(),
    invoke: (call: CompiledActorCall<unknown>) => {
      if (call.actorKey === "apify_yc_companies_memo23") inputs.push(call.input as Record<string, unknown>);
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
  } as unknown as CapabilityEngineDeps as never, {
    mission: m, plan: buildCapabilityGraph(m), maxCandidates: 10,
    brain: { employee_min: null, employee_max: 150 },
    readEnv: (k: string) => k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined,
  } as never);
  assert(inputs.length >= 1, "memo23 was called");
  for (const i of inputs) {
    const v = String(i.maxEmployeeSize);
    assert(v !== "1000+" && Number.parseInt(v, 10) <= 250, `maxEmployeeSize ${v} exceeds the bound`);
  }
});

// ═══ STAGE: A SOURCE THAT CANNOT PROVE IT IS NOT TREATED AS PROVING IT ══════

Deno.test("seed-stage is graded unsupported for a YC-discovery plan, disclosed, not blocking", () => {
  const base = parseLeadMissionDeterministic(
    "Find 3 seed-stage B2B SaaS startups in the US hiring their first growth marketer.");
  const staged = { ...base, hard_constraints: { ...base.hard_constraints, stage: { value: "seed-stage" } } };
  const plan = buildCapabilityGraph(staged);
  const without = assessRequestFeasibility({ ...base, hard_constraints: {} } as never, plan);
  const report = assessRequestFeasibility(staged as never, plan);
  assertEquals(report.constraints?.length, 1);
  assertEquals(report.constraints![0].status, "unsupported");
  assert(report.declared_gaps.includes("stage:seed-stage (unsupported)"));
  assertEquals(report.refusals.length, without.refusals.length, "a disclosed gap is not a refusal");
  if (report.mission_cohort === "y_combinator") {
    assert(report.constraints![0].message.includes("not a funding round"));
  }
});

Deno.test("stage unprovability is disclosed by feasibility, never announced to the planner", () => {
  // A note telling the execution planner that memo23 "CANNOT ESTABLISH FUNDING
  // STAGE" reached a prompt whose rules say to return an EMPTY plan when no
  // actor can establish what the request needs. The same-mission rerun of
  // 4250f181 (task 9144eaa4) died `no_valid_step` twice. Replaying the real
  // planner: pre-fix payload 5 steps; that note 0; a softened rewording 5 then
  // 0. Any unprovability statement is a coin-flip veto, so the planner-facing
  // contract carries none — the stage gap is graded by `assessRequestFeasibility`
  // and the constraint is judged from evidence by qualification.
  const src = read("../../../supabase/functions/_shared/actorInputContracts.ts");
  for (const veto of [/CANNOT ESTABLISH FUNDING STAGE/i, /FUNDING STAGE IS NOT A FILTER/i,
    /stage constraint stays hard/i]) {
    assertFalse(veto.test(src), `planner-facing contract must not say ${veto}`);
  }
});

// ═══ WORKBENCH: EVERY ATTEMPT ══════════════════════════════════════════════

Deno.test("run-agent projects earlier attempts' companies beside this slice's", () => {
  const ra = read("../../../supabase/functions/run-agent/index.ts");
  assert(/restoreWorkingSet\(\s*leadResumeRecords\.filter\(\(r\) => !sliceKeys\.has\(r\.company_key\)\)\)/.test(ra));
  assert(ra.includes("...capabilityRun.companies, ...priorAttemptCompanies,"));
  assertFalse(ra.includes("const evaluation = projectEvaluationRows(capabilityRun.companies.map("),
    "the slice-only projection is gone");
});
