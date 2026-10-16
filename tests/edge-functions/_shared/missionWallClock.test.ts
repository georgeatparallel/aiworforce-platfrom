// The smoke's fixed mission deadline: 300 s from the PERSISTED queue timestamp,
// opt-in (LEAD_V2_SMOKE_WALL_CLOCK). From Codex's codex/smoke-execution-guards
// (9cdb1372), integrated after PR #90. The durable admission RPC refuses paid
// work past the same deadline; this ends the mission itself, so a worker does
// not keep a slice running on refusals. ZERO network, ZERO database.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createLeadMissionRunner } from "../../../worker/leadMissionRunner.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import {
  missionExpiry, missionWallClockEnabled, QUEUE_CLOCK_SKEW_MS, SMOKE_MISSION_RUNTIME_MS,
} from "../../../supabase/functions/_shared/missionWallClock.ts";
import type { ClaimedMission } from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";

const enqueued = "2026-10-14T00:00:00Z";
const T0 = Date.parse(enqueued);
const mission: ClaimedMission = {
  queueId: "q1", workspaceId: "ws-1", request: {}, taskId: "task", lineageId: "task",
  attempts: 1, isResume: true, heldUntil: null, enqueuedAt: enqueued,
};
const ctl = { executionBudgetMs: 300_000, signal: new AbortController().signal };
const ok = () => Promise.resolve(new Response("{}"));

function runner(now: () => number, handler: Parameters<typeof createLeadMissionRunner>[0]["handler"], enforce = true) {
  return createLeadMissionRunner({
    enforceMissionWallClock: enforce,
    now,
    handler,
    serviceRoleKey: "offline",
    functionsBaseUrl: "https://offline.example",
    createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs, now }),
    bind: () => Promise.resolve(true),
    readTaskOutcome: () => Promise.resolve({ status: "partial", terminal_status: "continuation_required" }),
  });
}

Deno.test("wall clock: off unless configured; only an explicit off disables a configured value", () => {
  assertEquals(missionWallClockEnabled(undefined), false, "unset: disabled by default");
  assertEquals(missionWallClockEnabled("off"), false);
  for (const raw of ["enforce", "", "typo", "true"]) assert(missionWallClockEnabled(raw), `${JSON.stringify(raw)} enforces`);
});

Deno.test("wall clock: a worker restart with a lost checkpoint never resets the persisted queue deadline", async () => {
  let time = T0 + 290_000;
  let handlerCalls = 0;
  await runner(() => time, (_r, options) => {
    handlerCalls++;
    assertEquals(options.deadline!.remainingMs(), 10_000, "the slice gets only what is left of the 300 s");
    time += 10_001;
    assert(options.deadline!.expiredForDurableStart());
    assertEquals(options.deadline!.remainingMs(), 0);
    return ok(); // checkpointing can still finish after the deadline
  }).run(mission, ctl);
  const out = await runner(() => time, () => {
    handlerCalls++;
    return ok();
  }).run({ ...mission, taskId: null, attempts: 2 }, ctl);
  assertEquals(out.terminal, true);
  assertEquals(out.error, "mission_deadline_expired");
  assertEquals(handlerCalls, 1, "the restarted mission never reaches the handler");
});

for (const at of [undefined, null, "bad", new Date(T0 + QUEUE_CLOCK_SKEW_MS + 1).toISOString()]) {
  Deno.test(`wall clock: unreadable or future queue timestamp ${String(at)} refuses before the handler`, async () => {
    let calls = 0;
    const out = await runner(() => T0, () => {
      calls++;
      return ok();
    }).run({ ...mission, enqueuedAt: at }, ctl);
    assertEquals(calls, 0);
    assertEquals(out.error, "mission_deadline_unreadable");
  });
}

Deno.test("wall clock: a database clock slightly ahead of the worker still runs, and never extends the deadline", async () => {
  const at = T0 + 2_000; // queue row stamped 2 s "in the future" by the database clock
  assertEquals(missionExpiry(new Date(at).toISOString(), T0), at + SMOKE_MISSION_RUNTIME_MS);
  let remaining = -1;
  await runner(() => T0, (_r, options) => {
    remaining = options.deadline!.remainingMs();
    return ok();
  }).run({ ...mission, enqueuedAt: new Date(at).toISOString() }, ctl);
  assertEquals(remaining, 300_000, "capped by the slice budget; the expiry is still created_at + 300 s");
});

Deno.test("wall clock: disabled, the runner ignores the queue timestamp exactly as before", async () => {
  let calls = 0;
  const out = await runner(() => T0 + 10 * SMOKE_MISSION_RUNTIME_MS, () => {
    calls++;
    return ok();
  }, false).run({ ...mission, enqueuedAt: undefined }, ctl);
  assertEquals(calls, 1);
  assert(out.error !== "mission_deadline_unreadable" && out.error !== "mission_deadline_expired");
});
