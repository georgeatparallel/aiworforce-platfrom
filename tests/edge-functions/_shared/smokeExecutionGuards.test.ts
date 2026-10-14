// deno-lint-ignore-file require-await
// Offline transport/dependency fakes implement asynchronous contracts with immediate answers.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ModelCallCollector } from "../../../supabase/functions/_shared/executionLedger.ts";
import { resolveRunBudget } from "../../../supabase/functions/_shared/modelSpendCeiling.ts";
import { gptStructured } from "../../../supabase/functions/_shared/gptProvider.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { createLeadMissionRunner } from "../../../worker/leadMissionRunner.ts";
import { missionWallClockEnabled } from "../../../supabase/functions/_shared/missionWallClock.ts";
import {
  DEFAULT_CEILINGS,
  newSpendLedger,
  reserve,
} from "../../../supabase/functions/_shared/budgetPolicy.ts";

const budget = (all = 4) => ({
  max_calls: 20,
  max_input_tokens: 10000,
  max_output_tokens: 10000,
  max_total_tokens: 20000,
  max_all_calls: all,
});
const telemetry = (priced: boolean) => ({
  version: "model-cost-model-v1" as const,
  role: "test",
  model: "gpt-5.6-luna",
  reasoning_effort: null,
  input_tokens: 1,
  cached_input_tokens: 0,
  output_tokens: 1,
  estimated_cost_usd: priced ? 0.01 : null,
  actual_cost_usd: null,
  cost_source: priced ? "event_priced" as const : "unknown" as const,
  latency_ms: 0,
  fallback_reason: null,
});
const req = {
  purpose: "test",
  model: "gpt-5.6-luna",
  system: "test",
  user: "test",
  schema: {
    name: "smoke_test",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
};
const good = () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
});

for (const priced of [true, false]) {
  Deno.test(`all-call cap counts ${priced ? "priced" : "unpriced"} telemetry`, () => {
    const c = new ModelCallCollector(budget());
    for (let i = 0; i < 4; i++) c.sink(telemetry(priced), true);
    assertEquals(c.check().allowed, false);
  });
}

Deno.test("model drain cannot renew any request-local call budget", async () => {
  const c = new ModelCallCollector({ ...budget(1), max_calls: 1 });
  c.sink(telemetry(false), false);
  await c.drain(null, { workspace_id: "test", logical_call_key: "test" });
  assertEquals(c.length, 0);
  assertEquals(c.check().allowed, false);
  assertEquals(c.check().unpriced_calls, 1);
});

Deno.test("the existing unpriced budget survives drain when the optional all-call cap is absent", async () => {
  const c = new ModelCallCollector({
    max_calls: 1,
    max_input_tokens: 100,
    max_output_tokens: 100,
    max_total_tokens: 200,
  });
  c.sink(telemetry(false), false);
  await c.drain(null, { workspace_id: "test", logical_call_key: "test" });
  assertEquals(c.check().allowed, false);
});

Deno.test("prospective attempt admission is atomic while both calls are in flight", async () => {
  const c = new ModelCallCollector(budget(1));
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const deps = {
    budget: c,
    onModelCall: c.sink,
    readEnv: () => "offline-placeholder",
    fetch: async () => {
      calls++;
      await wait;
      return good();
    },
  };
  const first = gptStructured(req, deps);
  const second = gptStructured(req, deps);
  await Promise.resolve();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert(a.ok);
  assertEquals(b.ok, false);
  assertEquals(calls, 1);
});

Deno.test("a failed GPT attempt holds its slot and refuses a retry before transport", async () => {
  const c = new ModelCallCollector(budget(1));
  let calls = 0;
  const r = await gptStructured(req, {
    budget: c,
    onModelCall: c.sink,
    readEnv: () => "offline-placeholder",
    fetch: async () => {
      calls++;
      return { ok: false, status: 500, text: async () => "retry" };
    },
    sleep: async () => {},
  });
  assertEquals(calls, 1);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.code, "model_budget_exhausted");
    assertEquals(r.retryable, false);
    assertEquals(r.attempts, 1);
  }
  assertEquals(c.check().allowed, false);
});

Deno.test("unknown model price refuses the first attempt without pretending to record spend", async () => {
  const c = new ModelCallCollector({ ...budget(), require_priced: true });
  let calls = 0;
  const r = await gptStructured({ ...req, model: "unpriced-control" }, {
    budget: c,
    onModelCall: c.sink,
    readEnv: () => "offline-placeholder",
    fetch: async () => {
      calls++;
      return good();
    },
  });
  assertEquals(r.ok, false);
  assertEquals(calls, 0);
  assertEquals(c.length, 0);
});

Deno.test("cancellation during research forbids the next model request", async () => {
  let cancelled = false;
  const c = new ModelCallCollector(budget());
  c.stopBeforeAttempt = () => cancelled;
  let calls = 0;
  const deps = {
    budget: c,
    onModelCall: c.sink,
    readEnv: () => "offline-placeholder",
    fetch: async () => {
      calls++;
      cancelled = true;
      return good();
    },
  };
  assert((await gptStructured(req, deps)).ok);
  assertEquals((await gptStructured(req, deps)).ok, false);
  assertEquals(calls, 1);
});

Deno.test("strict pricing holds an uncertain model attempt instead of buying a retry", async () => {
  const c = new ModelCallCollector({ ...budget(4), require_priced: true });
  let calls = 0;
  const result = await gptStructured(req, {
    budget: c,
    onModelCall: c.sink,
    readEnv: () => "offline-placeholder",
    fetch: async () => {
      calls++;
      throw new Error("uncertain start");
    },
    sleep: async () => {},
  });
  assertEquals(result.ok, false);
  assertEquals(calls, 1);
  assertEquals(c.check().allowed, false);
});

Deno.test("missing usage blocks later strict model attempts after telemetry drain", async () => {
  const c = new ModelCallCollector({ ...budget(4), require_priced: true });
  c.sink(telemetry(false), true);
  await c.drain(null, { workspace_id: "test", logical_call_key: "unknown" });
  assertEquals(c.check().allowed, false);
});

for (const raw of ["", "-1", "typo", "1.5"]) {
  Deno.test(`malformed all-call cap ${JSON.stringify(raw)} fails closed`, () => {
    const b = resolveRunBudget((k) =>
      k === "MODEL_RUN_MAX_ALL_CALLS" ? raw : undefined
    );
    assert(b);
    assertEquals(new ModelCallCollector(b).check().allowed, false);
  });
}

const enqueued = "2026-10-14T00:00:00Z";
for (const raw of ["", "typo", "true"]) {
  Deno.test(`configured guard typo ${JSON.stringify(raw)} enforces`, () => {
    assert(missionWallClockEnabled(raw));
    assert(
      resolveRunBudget((k) =>
        k === "MODEL_RUN_REQUIRE_PRICED" ? raw : undefined
      )?.require_priced,
    );
  });
}
const mission = {
  queueId: "test",
  workspaceId: "test",
  request: {},
  taskId: "task",
  lineageId: "task",
  attempts: 1,
  isResume: true,
  heldUntil: null,
  enqueuedAt: enqueued,
};
function runner(
  now: () => number,
  handler: Parameters<typeof createLeadMissionRunner>[0]["handler"],
) {
  return createLeadMissionRunner({
    enforceMissionWallClock: true,
    now,
    handler,
    serviceRoleKey: "offline",
    functionsBaseUrl: "https://offline.example",
    createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs, now }),
    bind: async () => true,
    readTaskOutcome: async () => ({
      status: "partial",
      terminal_status: "continuation_required",
    }),
  });
}
const ctl = { executionBudgetMs: 300000, signal: new AbortController().signal };

Deno.test("worker restart with a lost checkpoint never resets the persisted queue deadline", async () => {
  let time = Date.parse(enqueued) + 290000;
  let handlerCalls = 0;
  const run = runner(() => time, async (_r, options) => {
    handlerCalls++;
    assertEquals(options.deadline!.remainingMs(), 10000);
    time += 10001;
    assert(options.deadline!.expiredForDurableStart());
    assertEquals(options.deadline!.remainingMs(), 0);
    return new Response("{}"); // Checkpointing can finish after authorization expires.
  });
  await run.run(mission, ctl);
  const restarted = runner(() => time, async () => {
    handlerCalls++;
    return new Response("{}");
  });
  const out = await restarted.run(
    { ...mission, taskId: null, attempts: 2 },
    ctl,
  );
  assertEquals(out.terminal, true);
  assertEquals(out.error, "mission_deadline_expired");
  assertEquals(handlerCalls, 1);
});

for (const at of [undefined, "bad", "2026-10-15T00:00:00Z"]) {
  Deno.test(`unreadable/future queue timestamp ${at} refuses before handler`, async () => {
    let calls = 0;
    const out = await runner(() => Date.parse(enqueued), async () => {
      calls++;
      return new Response("{}");
    }).run({ ...mission, enqueuedAt: at }, ctl);
    assertEquals(calls, 0);
    assertEquals(out.error, "mission_deadline_unreadable");
  });
}

for (const quote of [NaN, Infinity, -0.01, null, undefined]) {
  Deno.test(`invalid provider quote ${String(quote)} reserves nothing`, () => {
    const l = newSpendLedger(DEFAULT_CEILINGS);
    const r = reserve(l, {
      idempotency_key: "control",
      provider_call_id: "control",
      purpose: "discovery",
      route_id: "control",
      estimate_usd: quote as number,
    });
    assertEquals(r.ok, false);
    assertEquals(
      l.reservations.filter((r) => r.status === "reserved").length,
      0,
    );
  });
}

Deno.test("a price refusal does not reopen or replace a previously purchased provider key", () => {
  const l = newSpendLedger(DEFAULT_CEILINGS);
  const q = {
    idempotency_key: "paid",
    provider_call_id: "paid",
    purpose: "discovery" as const,
    route_id: "control",
    estimate_usd: 0.01,
  };
  const a = reserve(l, q);
  assert(a.ok);
  a.reservation.status = "executed";
  const b = reserve(l, { ...q, estimate_usd: NaN });
  assert(b.ok);
  assertEquals(b.reservation, a.reservation);
  assertEquals(l.reservations.length, 1);
});

Deno.test("new collector after a crash has no durable mission reservation: activation must remain blocked", () => {
  const a = new ModelCallCollector(budget(1));
  a.sink(telemetry(true), true);
  assertEquals(a.check().allowed, false);
  const restarted = new ModelCallCollector(budget(1));
  assertEquals(
    restarted.check().allowed,
    true,
    "request-local enforcement is not a mission-wide dollar/call guarantee",
  );
});

Deno.test("an invalid restored provider reservation cannot authorize a fresh purchase", () => {
  const l = newSpendLedger(DEFAULT_CEILINGS);
  const q = {
    idempotency_key: "unknown",
    provider_call_id: "unknown",
    purpose: "discovery" as const,
    route_id: "control",
    estimate_usd: 0.01,
  };
  const paid = reserve(l, q);
  assert(paid.ok);
  paid.reservation.estimate_usd = NaN; // Legacy checkpoint corruption; no proof of a priced purchase.
  assertEquals(reserve(l, q).ok, false);
  assertEquals(l.reservations.filter((r) => r.status === "reserved").length, 1);
});
