// The V2 request and outcome rules. ZERO network, ZERO database.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import {
  excludeV2OwnedTasks, prepareV2LeadCount, loadV2OwnedTaskIds, mapRefusal, mapTaskOutcome,
  missionFromKickoff, queueStatusFor, terminalStatusOf, validateV2KickoffBody, withResume,
  type QueueLookupDb,
} from "../../../supabase/functions/_shared/leadMissionV2Request.ts";

const mission = parseLeadMissionDeterministic(
  "Find founders of SaaS startups hiring Sales Operations in the United States. Return 5 qualified leads.");

/** Orchestrate's kickoff body shape for a mission step. */
const kickoff = () => ({
  plan_id: "plan-1", step_index: 0, agent_slug: "scout", workspace_id: "ws-1", user_id: "u-1",
  instruction: mission.original_user_query, input: mission.original_user_query,
  tool_needed: "source_with_apify", execution_mode: "company_first",
  workflow_kind: "qualified_lead_sourcing", requested_lead_count: 5,
  quota_policy: "contact_only", count_entity: "contact_ready_lead",
  tool_input: { requested_lead_count: 5, lead_mission: mission },
});

Deno.test("a real mission kickoff validates", () => {
  assertEquals(validateV2KickoffBody(kickoff()), { ok: true });
  assertEquals(missionFromKickoff(kickoff()), mission);
});

Deno.test("anything that is not a mission step is refused with a stated code", () => {
  const cases: Array<[unknown, string]> = [
    [null, "request_not_object"],
    [[], "request_not_object"],
    [{ ...kickoff(), workspace_id: "" }, "missing_workspace_id"],
    [{ ...kickoff(), plan_id: undefined }, "missing_plan_id"],
    [{ ...kickoff(), step_index: "0" }, "missing_step_index"],
    [{ ...kickoff(), agent_slug: "hawk" }, "agent_must_be_scout"],
    [{ ...kickoff(), instruction: "  " }, "missing_instruction"],
    [{ ...kickoff(), tool_input: { requested_lead_count: 5 } }, "missing_lead_mission"],
    [{ ...kickoff(), tool_input: { requested_lead_count: 150,
      lead_mission: { ...mission, requested_count: 150 } } }, "requested_count_exceeds_product_limit"],
    [{ ...kickoff(), resume_task_id: "t-9" }, "resume_fields_not_allowed"],
  ];
  for (const [body, code] of cases) {
    assertEquals(validateV2KickoffBody(body), { ok: false, code }, `expected ${code}`);
  }
});

Deno.test("V2 queue preserves the approved mission count for 1, 3, and 10", () => {
  for (const count of [1, 3, 10]) {
    const approved = { ...mission, requested_count: count };
    const input = { ...kickoff(), requested_lead_count: count,
      tool_input: { requested_lead_count: count, lead_mission: approved } };
    const out = prepareV2LeadCount(input);
    assertEquals(out.requested_lead_count, count);
    assertEquals((out.tool_input as Record<string, unknown>).requested_lead_count, count);
    assertEquals((out.tool_input as Record<string, unknown>).lead_mission, approved);
    assertEquals(input.requested_lead_count, count);
  }
});

Deno.test("worker resume repairs a queued canary count using the approved mission", () => {
  const approved = { ...mission, requested_count: 3 };
  const oldQueue = { ...kickoff(), requested_lead_count: 1,
    lead_quota_provenance: { source: "v2_canary", execution_quota: 1 },
    tool_input: { requested_lead_count: 1, lead_mission: approved } };
  const resumed = prepareV2LeadCount(oldQueue);
  assertEquals(resumed.requested_lead_count, 3);
  assertEquals((resumed.tool_input as Record<string, unknown>).requested_lead_count, 3);
  assertEquals((resumed.lead_quota_provenance as Record<string, unknown>).source, "mission");
});

Deno.test("a resume adds the same field the sweeper sends; a first run adds nothing", () => {
  assertEquals(withResume(kickoff(), "t-1").resume_task_id, "t-1");
  assertFalse("resume_task_id" in withResume(kickoff(), null));
});

Deno.test("terminal status uses claim_sourcing_continuation's precedence", () => {
  assertEquals(terminalStatusOf({ terminal_status: "quota_met" }), "quota_met");
  assertEquals(terminalStatusOf({ company_first_state: { terminal_status: "frontier_exhausted" } }), "frontier_exhausted");
  assertEquals(terminalStatusOf({ company_first: { status: "completed" } }), "completed");
  assertEquals(terminalStatusOf({}), null);
  assertEquals(terminalStatusOf(null), null);
});

Deno.test("task outcome: continuation is resumable; finished and failed are terminal", () => {
  assertEquals(mapTaskOutcome(null), { status: "task_missing", terminal: false });
  assertEquals(mapTaskOutcome({ status: "ready", terminal_status: "continuation_required" }),
    { status: "continuation_required", terminal: false });
  assertEquals(mapTaskOutcome({ status: "complete", terminal_status: "quota_met" }),
    { status: "quota_met", terminal: true });
  assertEquals(mapTaskOutcome({ status: "failed", terminal_status: null }), { status: "failed", terminal: true });
  assertEquals(mapTaskOutcome({ status: "complete", terminal_status: null }), { status: "complete", terminal: true });
  assertEquals(mapTaskOutcome({ status: "running", terminal_status: null }), { status: "running", terminal: false });
});

Deno.test("refusals: 409/429/5xx retry later; other 4xx do not", () => {
  for (const s of [409, 429, 500, 503]) assertFalse(mapRefusal(s).terminal, String(s));
  for (const s of [400, 401, 403, 404]) assert(mapRefusal(s).terminal, String(s));
});

Deno.test("queue status: terminal is respected even after the worker stopped starting work", () => {
  assertEquals(queueStatusFor({ status: "continuation_required", terminal: false }), "resumable");
  assertEquals(queueStatusFor({ status: "quota_met", terminal: true }), "complete");
  assertEquals(queueStatusFor({ status: "cancelled", terminal: true }), "cancelled");
  assertEquals(queueStatusFor({ status: "failed:provider", terminal: true }), "failed");
  assertEquals(queueStatusFor({ status: "refused_400", terminal: true }), "failed");
});

Deno.test("the sweeper excludes V2-owned tasks and nothing else", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assertEquals(excludeV2OwnedTasks(rows, new Set()), rows);
  assertEquals(excludeV2OwnedTasks(rows, new Set(["b"])).map((r) => r.id), ["a", "c"]);
});

Deno.test("V2 ownership lookup is tolerant: any failure reads as 'no V2 tasks'", async () => {
  const db = (result: () => Promise<{ data: unknown; error: unknown }>): QueueLookupDb => ({
    from: () => ({ select: () => ({ in: () => result() }) }),
  });
  assertEquals([...await loadV2OwnedTaskIds(db(async () => ({ data: [{ task_id: "b" }, { task_id: null }], error: null })), ["a", "b"])], ["b"]);
  assertEquals((await loadV2OwnedTaskIds(db(async () => ({ data: null, error: { message: "relation does not exist" } })), ["a"])).size, 0);
  assertEquals((await loadV2OwnedTaskIds(db(async () => { throw new Error("network"); }), ["a"])).size, 0);
  assertEquals((await loadV2OwnedTaskIds(db(async () => ({ data: [{ task_id: "x" }], error: null })), [])).size, 0);
});
