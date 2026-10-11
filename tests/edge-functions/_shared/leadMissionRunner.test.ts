// The runner replays the queued kickoff into run-agent's handler in-process.
// A fake handler stands in for run-agent; everything the runner does around it
// is real. ZERO network, ZERO database.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createLeadMissionRunner, type LeadMissionRunnerDeps } from "../../../worker/leadMissionRunner.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import type { ClaimedMission } from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";
import type { RunAgentRunOptions } from "../../../supabase/functions/run-agent/index.ts";

const request = {
  plan_id: "plan-1", step_index: 0, agent_slug: "scout", workspace_id: "ws-1",
  instruction: "x", requested_lead_count: 5, tool_input: { requested_lead_count: 5, lead_mission: { v: 1 } },
};
const fresh: ClaimedMission = {
  queueId: "q1", workspaceId: "ws-1", request, taskId: null, lineageId: null,
  attempts: 1, isResume: false, heldUntil: null,
};

interface Captured { req?: Request; body?: Record<string, unknown>; opts?: RunAgentRunOptions; remainingAtBind?: number }

function deps(over: Partial<LeadMissionRunnerDeps> = {}, cap: Captured = {}): LeadMissionRunnerDeps {
  return {
    serviceRoleKey: "service-key",
    functionsBaseUrl: "https://fake.supabase.test/functions/v1/",
    createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs }),
    bind: async () => true,
    readTaskOutcome: async () => ({ status: "complete", terminal_status: "quota_met" }),
    handler: async (req, opts) => {
      cap.req = req; cap.opts = opts; cap.body = await req.clone().json();
      await opts.onExecutionBound?.({ taskId: "task-1", lineageId: "task-1", holdsLease: true });
      cap.remainingAtBind = opts.deadline?.remainingMs();
      return new Response(JSON.stringify({ success: true, task_id: "task-1" }), { status: 200 });
    },
    ...over,
  };
}
const ctl = (budget = 300_000, signal = new AbortController().signal) => ({ executionBudgetMs: budget, signal });

Deno.test("replays the kickoff with the service bearer, the preserved quota, and no resume field", async () => {
  const cap: Captured = {};
  const out = await createLeadMissionRunner(deps({}, cap)).run(fresh, ctl());
  assertEquals(cap.req!.method, "POST");
  assertEquals(cap.req!.url, "https://fake.supabase.test/functions/v1/run-agent");
  assertEquals(cap.req!.headers.get("Authorization"), "Bearer service-key");
  assertEquals(cap.body!.requested_lead_count, 5);
  assertEquals((cap.body!.tool_input as Record<string, unknown>).requested_lead_count, 5);
  assertFalse("resume_task_id" in cap.body!);
  assertEquals(out, { status: "quota_met", terminal: true, taskId: "task-1" });
});

Deno.test("the queue owns continuation: the handler is told never to self-dispatch", async () => {
  // Run 4250f181: the handler's own HTTP continuation hit 401 five times while
  // the queue re-claimed the same mission. Only one of them may continue it.
  const cap: Captured = {};
  await createLeadMissionRunner(deps({}, cap)).run(fresh, ctl());
  assertEquals(cap.opts!.continuationOwner, "v2_queue");
});

Deno.test("the run gets the worker's budget as its deadline, not the edge default", async () => {
  const cap: Captured = {};
  await createLeadMissionRunner(deps({}, cap)).run(fresh, ctl(300_000));
  assertEquals(cap.opts!.deadline!.budgetMs, 300_000);
  assert((cap.remainingAtBind ?? 0) > 150_000);
});

Deno.test("a resume replays with resume_task_id", async () => {
  const cap: Captured = {};
  await createLeadMissionRunner(deps({}, cap)).run(
    { ...fresh, taskId: "task-1", lineageId: "task-1", isResume: true }, ctl());
  assertEquals(cap.body!.resume_task_id, "task-1");
});

Deno.test("the task + lineage the handler created are bound onto the queue row", async () => {
  const binds: string[][] = [];
  await createLeadMissionRunner(deps({ bind: async (q, t, l) => { binds.push([q, t, l]); return true; } }))
    .run(fresh, ctl());
  assertEquals(binds, [["q1", "task-1", "task-1"]]);
});

Deno.test("lost ownership revokes the run's deadline — no room to start paid work", async () => {
  const ac = new AbortController();
  const cap: Captured = {};
  const run = createLeadMissionRunner(deps({
    handler: async (req, opts) => {
      cap.opts = opts; cap.body = await req.clone().json();
      ac.abort(); // the heartbeat reports lost ownership mid-run
      cap.remainingAtBind = opts.deadline!.remainingMs();
      return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
    },
    readTaskOutcome: async () => ({ status: "ready", terminal_status: "continuation_required" }),
  }, cap));
  const out = await run.run(fresh, ctl(300_000, ac.signal));
  assertEquals(cap.remainingAtBind, 0);
  assert(cap.opts!.deadline!.expired());
  assertEquals(out, { status: "continuation_required", terminal: false, taskId: "task-1" });
});

Deno.test("a refused bind also revokes the deadline", async () => {
  const cap: Captured = {};
  await createLeadMissionRunner(deps({ bind: async () => false }, cap)).run(fresh, ctl());
  assertEquals(cap.remainingAtBind, 0);
});

Deno.test("refused before any task existed: 409 retries later, 400 does not", async () => {
  const refusing = (status: number) => deps({
    handler: async () => new Response(JSON.stringify({ error: "x" }), { status }),
  });
  assertEquals((await createLeadMissionRunner(refusing(409)).run(fresh, ctl())).terminal, false);
  assertEquals((await createLeadMissionRunner(refusing(400)).run(fresh, ctl())).terminal, true);
});

Deno.test("the outcome is read from the task row, not the HTTP response", async () => {
  const out = await createLeadMissionRunner(deps({
    readTaskOutcome: async () => ({ status: "failed", terminal_status: "provider_error" }),
  })).run(fresh, ctl());
  assertEquals(out, { status: "failed:provider_error", terminal: true, taskId: "task-1" });
});
