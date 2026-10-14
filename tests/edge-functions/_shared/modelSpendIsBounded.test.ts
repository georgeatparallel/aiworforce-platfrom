// A WORKSPACE CANNOT SPEND WITHOUT LIMIT ON MODELS.
//
// ── THE HOLE ───────────────────────────────────────────────────────────────
//
// `toolRegistry` gates two things — `source_with_apify` and `scrape_url`. They
// reserve credits, write a ledger row and settle. Model calls did none of it.
// The lead engine bounds itself per run; chat had no ceiling of any kind, so a
// user in a loop was an unbounded bill with no row to attribute it to.
//
// These tests are about the BOUND, not about pricing. They cover the states a
// meter is actually found in: over, under, exactly at, unreadable, unpriced,
// and no workspace at all — because every one of those has a different right
// answer and the wrong one is either a runaway bill or an outage.
//
// ZERO network, ZERO models, ZERO providers, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeModelSpend, resolveSpendEnforcement, resolveCeiling, describeSpend, spendRefusalMessage,
  DEFAULT_CEILING_USD, DEFAULT_PERIOD_DAYS,
  MODEL_SPEND_ENFORCEMENT_ENV, MODEL_SPEND_CEILING_ENV, MODEL_SPEND_PERIOD_ENV,
  resolveRunBudget, RUN_MAX_CALLS_ENV, RUN_MAX_INPUT_ENV, RUN_MAX_OUTPUT_ENV, RUN_MAX_TOTAL_ENV,
  type SpendDb,
} from "../../../supabase/functions/_shared/modelSpendCeiling.ts";
import {
  MODEL_PRICES, canonicalModelId,
} from "../../../supabase/functions/_shared/modelCostModel.ts";

/** A db whose one query returns these rows, or fails. */
const dbOf = (
  rows: Array<Record<string, unknown>> | { error: unknown },
): SpendDb => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        gte: () =>
          Promise.resolve(
            Array.isArray(rows) ? { data: rows, error: null } : { data: null, error: rows.error },
          ),
      }),
    }),
  }),
});

const priced = (usd: number) => ({
  actual_cost_usd: usd, estimated_cost_usd: null, cost_source: "event_priced",
});

// ══════════ the bound itself ══════════════════════════════════════════════

Deno.test("THE HOLE: a workspace over the ceiling is refused in enforce", async () => {
  const v = await authorizeModelSpend({
    db: dbOf([priced(20), priced(6)]),
    workspace_id: "w", mode: "enforce", ceiling_usd: 25,
  });
  assertEquals(v.spent_usd, 26);
  assert(v.over_ceiling);
  assertEquals(v.allowed, false, "enforce must refuse");
  assertEquals(v.reason, "over_ceiling");
});

Deno.test("under the ceiling proceeds", async () => {
  const v = await authorizeModelSpend({
    db: dbOf([priced(0.34), priced(0.31)]),
    workspace_id: "w", mode: "enforce", ceiling_usd: 25,
  });
  // The two heaviest lineages this product has ever run, together.
  assertEquals(Math.round(v.spent_usd * 100) / 100, 0.65);
  assertEquals(v.over_ceiling, false);
  assert(v.allowed);
  assertEquals(v.reason, "under_ceiling");
});

Deno.test("exactly at the ceiling is over, not under", async () => {
  // A ceiling that lets you spend it and then one more call is a ceiling plus
  // one call. `>=` is the whole difference and it is worth pinning.
  const v = await authorizeModelSpend({
    db: dbOf([priced(25)]), workspace_id: "w", mode: "enforce", ceiling_usd: 25,
  });
  assert(v.over_ceiling);
  assertEquals(v.allowed, false);
});

// ══════════ observe must not be able to break anything ════════════════════

Deno.test("observe reports the same verdict and permits the call", async () => {
  const v = await authorizeModelSpend({
    db: dbOf([priced(100)]), workspace_id: "w", mode: "observe", ceiling_usd: 25,
  });
  assert(v.over_ceiling, "the honest answer does not change with the mode");
  assertEquals(v.allowed, true, "observe permits — that is what it is for");
  assertEquals(v.reason, "over_ceiling");
});

// ══════════ the failure modes a meter really has ══════════════════════════

// ENFORCE FAILS CLOSED. Each of these used to be permitted in `enforce` too, on
// the theory that credit reservations still bounded the expensive half of the
// bill. An enforced ceiling has to hold precisely when something is wrong, so
// `enforce` now refuses what it cannot measure; `observe` still permits it.

Deno.test("an unreadable meter: observe permits, ENFORCE REFUSES, both say why", async () => {
  for (const [mode, allowed] of [["observe", true], ["enforce", false]] as const) {
    const v = await authorizeModelSpend({
      db: dbOf({ error: { message: "connection reset" } }),
      workspace_id: "w", mode, ceiling_usd: 25,
    });
    assertEquals(v.allowed, allowed, `${mode}: unreadable meter`);
    assertEquals(v.reason, "query_failed");
    assertEquals(v.over_ceiling, false, "not being able to read spend is not a claim about spend");
    assert(v.detail?.includes("connection reset"), "and must say why");
  }
});

Deno.test("a throwing db is a failed read, not an exception — and enforce refuses it", async () => {
  const throwing: SpendDb = {
    from: () => ({
      select: () => ({ eq: () => ({ gte: () => { throw new Error("boom"); } }) }),
    }),
  };
  const v = await authorizeModelSpend({
    db: throwing, workspace_id: "w", mode: "enforce", ceiling_usd: 1,
  });
  assertEquals(v.reason, "query_failed");
  assertEquals(v.allowed, false);
  const o = await authorizeModelSpend({ db: throwing, workspace_id: "w", mode: "observe", ceiling_usd: 1 });
  assertEquals(o.allowed, true, "observe still cannot break anything");
});

Deno.test("no workspace: observe permits, ENFORCE REFUSES — unattributable spend is unmetered spend", async () => {
  for (const [mode, allowed] of [["observe", true], ["enforce", false]] as const) {
    for (const ws of [null, undefined, ""]) {
      const v = await authorizeModelSpend({ db: dbOf([]), workspace_id: ws, mode, ceiling_usd: 5 });
      assertEquals(v.reason, "no_workspace");
      assertEquals(v.allowed, allowed, `${mode} with workspace ${JSON.stringify(ws)}`);
    }
  }
});

Deno.test("a misconfigured ceiling: observe permits on the default, ENFORCE REFUSES", async () => {
  const cfg = resolveCeiling((k) => k === MODEL_SPEND_CEILING_ENV ? "abc" : k === MODEL_SPEND_PERIOD_ENV ? "1" : undefined);
  assert(cfg.config_error?.includes(MODEL_SPEND_CEILING_ENV));
  const e = await authorizeModelSpend({ db: dbOf([]), workspace_id: "w", mode: "enforce", ...cfg });
  assertEquals([e.allowed, e.reason], [false, "ceiling_misconfigured"]);
  assert(e.detail?.includes(MODEL_SPEND_CEILING_ENV), "and names the variable");
  const o = await authorizeModelSpend({ db: dbOf([]), workspace_id: "w", mode: "observe", ...cfg });
  assertEquals([o.allowed, o.reason], [true, "ceiling_misconfigured"]);
  // Checked before the meter: even a workspace with no spend is refused.
  const unset = resolveCeiling(() => undefined);
  const u = await authorizeModelSpend({ db: dbOf([]), workspace_id: "w", mode: "enforce", ...unset });
  assertEquals([u.allowed, u.reason], [false, "ceiling_misconfigured"]);
});

Deno.test("the production configuration ($5 / 1 day, enforce) meters normally and refuses at $5", async () => {
  const cfg = resolveCeiling((k) => ({ [MODEL_SPEND_CEILING_ENV]: "5.00", [MODEL_SPEND_PERIOD_ENV]: "1" } as Record<string, string>)[k]);
  assertEquals(cfg, { ceiling_usd: 5, period_days: 1, config_error: null });
  const under = await authorizeModelSpend({ db: dbOf([priced(4.99)]), workspace_id: "w", mode: "enforce", ...cfg });
  assertEquals([under.allowed, under.reason], [true, "under_ceiling"]);
  const at = await authorizeModelSpend({ db: dbOf([priced(5)]), workspace_id: "w", mode: "enforce", ...cfg });
  assertEquals([at.allowed, at.reason], [false, "over_ceiling"]);
});

Deno.test("a refusal says WHY — never 'you reached your ceiling' for a meter it could not read", async () => {
  const failed = await authorizeModelSpend({ db: dbOf({ error: { message: "x" } }), workspace_id: "w", mode: "enforce", ceiling_usd: 5 });
  assert(!spendRefusalMessage(failed).includes("reached"), spendRefusalMessage(failed));
  assert(spendRefusalMessage(failed).includes("could not be verified"));
  const over = await authorizeModelSpend({ db: dbOf([priced(9)]), workspace_id: "w", mode: "enforce", ceiling_usd: 5 });
  assert(spendRefusalMessage(over).includes("reached its model spend ceiling of $5"));
});

// ══════════ an unpriced call is not a free call ═══════════════════════════

Deno.test("THE BLIND SPOT: unpriced calls are counted, never read as $0", async () => {
  const v = await authorizeModelSpend({
    db: dbOf([
      priced(1),
      { actual_cost_usd: null, estimated_cost_usd: null, cost_source: "unknown" },
      { actual_cost_usd: null, estimated_cost_usd: null, cost_source: "unknown" },
    ]),
    workspace_id: "w", mode: "enforce", ceiling_usd: 25,
  });
  assertEquals(v.spent_usd, 1, "an unpriced call contributes no money, because none is known");
  assertEquals(v.unpriced_calls, 2, "but it is COUNTED, so the gap shows in the log");
  assert(describeSpend(v).unpriced_calls === 2, "and reaches the log line");
});

Deno.test("actual cost wins over estimated", async () => {
  const v = await authorizeModelSpend({
    db: dbOf([{ actual_cost_usd: 3, estimated_cost_usd: 99, cost_source: "provider_reported" }]),
    workspace_id: "w", mode: "enforce", ceiling_usd: 25,
  });
  assertEquals(v.spent_usd, 3);
});

// ══════════ every model the router can pick must be priceable ═════════════

Deno.test("THE GAP THIS MAKES LOUD: selectable models that cannot be priced", () => {
  // `spent_usd` can only see what `MODEL_PRICES` can price. A model the router
  // may select but the price table does not know contributes $0 to the ceiling
  // for ever — the meter reads clean while the bill runs. This test does not
  // invent prices; it names the models that need one.
  //
  // `claude-haiku-4-5-20251001` WAS on this list and has been retired from it.
  // It is the one model billed directly by Anthropic rather than through the
  // Lovable gateway — `ANTHROPIC_MODEL` in aiProvider, reached via
  // api.anthropic.com with ANTHROPIC_API_KEY — so the published list price IS
  // the billing basis and is checkable against an Anthropic invoice. The gateway
  // models stay unpriced for exactly the reason they always did.
  const SELECTABLE = [
    "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol",
    "claude-haiku-4-5-20251001", "openai/gpt-5-mini",
  ];
  const KNOWN_UNPRICED = ["openai/gpt-5-mini"];

  const unpriced = SELECTABLE.filter((m) => !MODEL_PRICES[canonicalModelId(m)]);
  assertEquals(
    unpriced.sort(), [...KNOWN_UNPRICED].sort(),
    `models the router can select but MODEL_PRICES cannot price: ${unpriced.join(", ")}. ` +
      `Each contributes $0 to the spend ceiling for ever. Add a price, or remove ` +
      `it from the router — do not leave it invisible.`,
  );
  // And the priced ones really are priced, so this cannot pass by matching two
  // empty lists.
  for (const m of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
    assert(MODEL_PRICES[canonicalModelId(m)], `${m} must be priced`);
  }
});

// ══════════ configuration ═════════════════════════════════════════════════

// FAIL CLOSED since launch hardening (2026-09-28).
Deno.test("enforcement is ON unless explicitly turned off", async () => {
  assertEquals(resolveSpendEnforcement(() => undefined), "enforce");
  assertEquals(resolveSpendEnforcement(() => "ENFORCE"), "enforce");
  assertEquals(resolveSpendEnforcement(() => "no"), "enforce", "only the exact word disarms it");
  assertEquals(resolveSpendEnforcement(() => "OBSERVE"), "observe");
  assertEquals(
    resolveSpendEnforcement((k) => k === MODEL_SPEND_ENFORCEMENT_ENV ? "observe" : undefined),
    "observe",
  );
  // And observe cannot refuse, whatever the numbers say.
  const v = await authorizeModelSpend({
    db: dbOf([priced(1e6)]), workspace_id: "w", mode: resolveSpendEnforcement(() => "observe"),
  });
  assertEquals(v.allowed, true);
  // Unset everything: enforced, and an unconfigured ceiling refuses rather than
  // becoming a $25 bound nobody chose — so a deploy must set both variables.
  const unset = await authorizeModelSpend({
    db: dbOf([]), workspace_id: "w", mode: resolveSpendEnforcement(() => undefined), ...resolveCeiling(() => undefined),
  });
  assertEquals([unset.allowed, unset.reason], [false, "ceiling_misconfigured"]);
});

Deno.test("the ceiling is configurable; a bad value falls back AND is reported", () => {
  const unset = resolveCeiling(() => undefined);
  assertEquals([unset.ceiling_usd, unset.period_days], [DEFAULT_CEILING_USD, DEFAULT_PERIOD_DAYS]);
  assert(unset.config_error, "an unset ceiling is not a configured one");
  assertEquals(
    resolveCeiling((k) => k === MODEL_SPEND_CEILING_ENV ? "5" : k === MODEL_SPEND_PERIOD_ENV ? "7" : undefined),
    { ceiling_usd: 5, period_days: 7, config_error: null },
  );
  // A misconfigured ceiling must not become "unlimited" or "nothing" — and
  // the fallback is never silent, so enforce can refuse on it.
  for (const bad of ["0", "-1", "abc", ""]) {
    const c = resolveCeiling(() => bad);
    assertEquals(c.ceiling_usd, DEFAULT_CEILING_USD, `"${bad}" must fall back`);
    assert(c.config_error, `"${bad}" must be reported`);
  }
});

// ══════════ the caller wires it ═══════════════════════════════════════════

Deno.test("pilot-chat checks the ceiling before it can spend", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/pilot-chat/index.ts", import.meta.url),
  );
  assert(src.includes("authorizeModelSpend("), "chat must consult the ceiling");
  // Order is the whole point: after membership, before any model call.
  const member = src.indexOf("not a member of this workspace");
  const guard = src.indexOf("authorizeModelSpend(");
  const firstModel = Math.min(
    ...["generateJson({", "generateText({"]
      .map((n) => src.indexOf(n)).filter((i) => i > 0),
  );
  assert(member > 0 && guard > member, "the ceiling is checked after membership is proven");
  assert(guard < src.lastIndexOf("generateText({"), "and before chat's model work");
  assert(firstModel > 0, "sanity: chat does call a model");
  assert(src.includes("429"), "a refused request must say too-many/over-limit, not 500");
});

// ══════════ capture: the meter needs something to sum ═════════════════════

import {
  generateText, type GenerateOpts, TASK_MODELS } from "../../../supabase/functions/_shared/aiProvider.ts";
import type { ModelCallTelemetry } from "../../../supabase/functions/_shared/modelCostModel.ts";

/** Stub the network and the env; nothing here reaches a provider. */
function withStubbedProvider(
  handler: (url: string) => Response,
  run: () => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const realGet = Deno.env.get;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(handler(String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )))) as typeof fetch;
  // `pilot_chat` intends Anthropic, and allows no fallback — so Anthropic is
  // the credential a stubbed pilot-chat call needs. (This used to stub
  // LOVABLE_API_KEY, back when every task was routed through that gateway.)
  Deno.env.get = ((k: string) =>
    k === "ANTHROPIC_API_KEY" ? "test-key" : undefined) as typeof Deno.env.get;
  return run().finally(() => {
    globalThis.fetch = realFetch;
    Deno.env.get = realGet;
  });
}

/** Anthropic's messages shape — `content[].text`, not `choices[].message`. */
const okBody = (usage: unknown) =>
  new Response(JSON.stringify({
    content: [{ type: "text", text: "hello" }], usage,
  }), { status: 200, headers: { "content-type": "application/json" } });

Deno.test("CAPTURE: a successful chat call reaches the sink with its tokens", async () => {
  const seen: Array<{ t: ModelCallTelemetry; ok: boolean }> = [];
  await withStubbedProvider(
    () => okBody({ prompt_tokens: 1200, completion_tokens: 300 }),
    async () => {
      const r = await generateText({
        taskType: "pilot_chat", messages: [{ role: "user", content: "hi" }],
        workspaceId: "w", functionName: "pilot-chat",
        onModelCall: (t, ok) => seen.push({ t, ok }),
      } as GenerateOpts);
      assert(r.ok, "the stubbed call must succeed");
    },
  );
  assertEquals(seen.length, 1, "exactly one call, one telemetry row");
  assertEquals(seen[0].ok, true);
  assertEquals(seen[0].t.input_tokens, 1200, "tokens must survive to the ledger");
  assertEquals(seen[0].t.output_tokens, 300);
  assert(seen[0].t.role.includes("pilot_chat"), "the row says what spent it");
});

Deno.test("CAPTURE: a FAILED attempt is still recorded", async () => {
  // An outage with no ledger rows is indistinguishable from a quiet afternoon,
  // which is exactly when spend data matters most.
  const seen: Array<{ t: ModelCallTelemetry; ok: boolean }> = [];
  await withStubbedProvider(
    () => new Response("upstream exploded", { status: 500 }),
    async () => {
      await generateText({
        taskType: "pilot_chat", messages: [{ role: "user", content: "hi" }],
        workspaceId: "w",
        onModelCall: (t, ok) => seen.push({ t, ok }),
      } as GenerateOpts);
    },
  );
  assert(seen.length >= 1, "a failed attempt must still produce a row");
  assert(seen.every((s) => s.ok === false), "and must be marked failed, not ok");
  // No usage is reported by a 500, and that must not price as free.
  assertEquals(seen[0].t.input_tokens, null);
  assert(
    seen[0].t.estimated_cost_usd === null && seen[0].t.actual_cost_usd === null,
    "no usage is `unknown` cost, never $0 — the distinction priceModelCall draws",
  );
});

Deno.test("CAPTURE: chat's model is PRICED now, and an unknown one is still marked", async () => {
  // This test used to assert the opposite, and was right to: `pilot_chat` ran
  // `google/gemini-3-flash-preview` through the Lovable gateway, which
  // `MODEL_PRICES` does not know, so every chat call landed in the ledger with
  // `cost_source: "unknown"` — volume recoverable, money not.
  //
  // Chat now runs the model its task policy names, which IS priced. The
  // unpriced path still has to work, because a model can always be added
  // before its price is, so both halves are asserted here.
  const seen: ModelCallTelemetry[] = [];
  await withStubbedProvider(
    () => okBody({ input_tokens: 10, output_tokens: 5 }),
    async () => {
      await generateText({
        taskType: "pilot_chat", messages: [{ role: "user", content: "hi" }],
        onModelCall: (t) => seen.push(t),
      } as GenerateOpts);
    },
  );
  assertEquals(seen.length, 1);
  assertEquals(seen[0].input_tokens, 10, "tokens are captured regardless of price");
  assertEquals(seen[0].model, TASK_MODELS.pilot_chat.model, "chat ran the model its policy names");
  assert(
    seen[0].cost_source !== "unknown",
    "the task's own model must be priced — an unpriced default is how chat spend went uncounted",
  );
});

Deno.test("pilot-chat drains what it captured, on every exit", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/pilot-chat/index.ts", import.meta.url),
  );
  assert(src.includes("onModelCall: fail.modelCalls?.sink"),
    "chat's own model calls must feed the collector");
  // `finally`, because the requests whose rows matter most are the ones that threw.
  const fin = src.lastIndexOf("} finally {");
  const drain = src.indexOf("fail.modelCalls.drain(");
  assert(fin > 0 && drain > fin, "the drain must sit in the finally, not the happy path");
  assert(
    src.slice(drain - 400, drain).includes("try {"),
    "and must be guarded — bookkeeping must not turn a served response into a 500",
  );
});

// ══════════ LAYER 2: unpriced calls are bounded by tokens and calls ═══════
//
// `modelSpendCeiling` bounds dollars, and four models this system selects
// every day have no price — chat runs on `google/gemini-3-flash-preview`
// through the Lovable gateway. A dollar ceiling cannot see them at all, so
// without this an unpriced model is an unlimited one.

import {
  ModelCallCollector, type ModelRunBudget,
} from "../../../supabase/functions/_shared/executionLedger.ts";
import {
  UNPRICED_MODELS, MODEL_PRICES as PRICES_FOR_ROSTER, priceModelCall as priceForRoster,
} from "../../../supabase/functions/_shared/modelCostModel.ts";

const BUDGET: ModelRunBudget = {
  max_calls: 3, max_input_tokens: 10_000,
  max_output_tokens: 2_000, max_total_tokens: 11_000,
};

const unpricedCall = (inTok: number, outTok: number) => ({
  version: "model-cost-model-v1" as const,
  role: "chat", model: "google/gemini-3-flash-preview", reasoning_effort: null,
  input_tokens: inTok, cached_input_tokens: 0, output_tokens: outTok,
  estimated_cost_usd: null, actual_cost_usd: null,
  cost_source: "unknown" as const, latency_ms: 5, fallback_reason: null,
});

const pricedCall = (usd: number) => ({
  version: "model-cost-model-v1" as const,
  role: "evaluator", model: "gpt-5.6-luna", reasoning_effort: null,
  input_tokens: 50_000, cached_input_tokens: 0, output_tokens: 5_000,
  estimated_cost_usd: null, actual_cost_usd: usd,
  cost_source: "event_priced" as const, latency_ms: 5, fallback_reason: null,
});

Deno.test("L2: an unpriced call within the token budget is allowed", () => {
  const c = new ModelCallCollector(BUDGET);
  c.sink(unpricedCall(1_000, 100), true);
  const v = c.check();
  assert(v.allowed);
  assertEquals(v.exceeded, null);
  assertEquals(v.unpriced_calls, 1);
});

Deno.test("L2: exceeding the CALL budget refuses", () => {
  const c = new ModelCallCollector(BUDGET);
  for (let i = 0; i < 3; i++) c.sink(unpricedCall(10, 10), true);
  const v = c.check();
  assertEquals(v.allowed, false);
  assertEquals(v.exceeded, "calls");
});

Deno.test("L2: exceeding the TOKEN budget refuses even with calls to spare", () => {
  const c = new ModelCallCollector(BUDGET);
  c.sink(unpricedCall(10_500, 10), true);
  const v = c.check();
  assertEquals(v.allowed, false);
  assertEquals(v.exceeded, "input_tokens");
  assertEquals(v.unpriced_calls, 1, "one call, and still over — tokens bound too");
});

Deno.test("L2: output and total bounds are separate from input", () => {
  const out = new ModelCallCollector(BUDGET);
  out.sink(unpricedCall(10, 2_500), true);
  assertEquals(out.check().exceeded, "output_tokens");

  const tot = new ModelCallCollector(
    { ...BUDGET, max_input_tokens: 1e9, max_output_tokens: 1e9 },
  );
  tot.sink(unpricedCall(9_000, 3_000), true);
  assertEquals(tot.check().exceeded, "total_tokens");
});

Deno.test("L2: MULTIPLE CALLS AGGREGATE against one run budget", () => {
  const c = new ModelCallCollector(BUDGET);
  c.sink(unpricedCall(4_000, 100), true);
  assert(c.check().allowed, "one call is fine");
  c.sink(unpricedCall(4_000, 100), true);
  assert(c.check().allowed, "two is still fine");
  c.sink(unpricedCall(4_000, 100), true);
  assertEquals(c.check().allowed, false, "three sums past the input bound");
  assertEquals(c.check().unpriced_input_tokens, 12_000);
});

Deno.test("L2: UNKNOWN COST IS NEVER TREATED AS ZERO", () => {
  const c = new ModelCallCollector(BUDGET);
  c.sink(unpricedCall(500, 50), true);
  const v = c.check();
  assertEquals(v.priced_usd, 0, "no money is claimed, because none is known");
  assertEquals(v.unpriced_calls, 1, "but the call is counted and bounded");
  assertEquals(v.priced_calls, 0);
});

Deno.test("L2: priced calls do NOT consume the unpriced budget", () => {
  // The heaviest real run made 95 priced calls and 688,303 tokens. A shared
  // ceiling low enough to catch a chat loop would have killed it.
  const c = new ModelCallCollector(BUDGET);
  for (let i = 0; i < 50; i++) c.sink(pricedCall(0.01), true);
  const v = c.check();
  assert(v.allowed, "Layer 1 governs money; Layer 2 must not double-bound it");
  assertEquals(v.priced_calls, 50);
  assertEquals(v.unpriced_calls, 0);
  assertEquals(Math.round(v.priced_usd * 100) / 100, 0.5);
});

Deno.test("L2: a FAILED unpriced call still consumes budget", () => {
  // A retry loop that counted only successes would be unbounded by
  // construction — which is the exact shape of the runaway this guards.
  const c = new ModelCallCollector(BUDGET);
  for (let i = 0; i < 3; i++) c.sink(unpricedCall(10, 10), false);
  assertEquals(c.check().allowed, false, "failures count; retries cannot be free");
  assertEquals(c.check().exceeded, "calls");
});

Deno.test("L2: no budget means unchanged behaviour for every existing caller", () => {
  const c = new ModelCallCollector();
  for (let i = 0; i < 500; i++) c.sink(unpricedCall(100_000, 10_000), true);
  const v = c.check();
  assert(v.allowed, "an absent budget bounds nothing — existing callers are untouched");
  assertEquals(v.exceeded, null);
  assertEquals(v.budget, null);
});

Deno.test("L2: separate runs do not share budget state", () => {
  const a = new ModelCallCollector(BUDGET);
  const b = new ModelCallCollector(BUDGET);
  for (let i = 0; i < 3; i++) a.sink(unpricedCall(10, 10), true);
  assertEquals(a.check().allowed, false, "a is exhausted");
  assertEquals(b.check().allowed, true, "b is untouched — budgets are per collector");
  assertEquals(b.check().unpriced_calls, 0);
});

Deno.test("L2: the fallback chain cannot bypass an exhausted budget", async () => {
  // `generateText` walks Lovable's default model, an alternate family, then
  // Anthropic. Checking once at the top would let an exhausted run buy one more
  // call from each. The check sits INSIDE the attempt loop; this proves it by
  // asserting the network is never reached.
  let fetches = 0;
  const realFetch = globalThis.fetch;
  const realGet = Deno.env.get;
  globalThis.fetch = (() => { fetches++; return Promise.resolve(new Response("{}", { status: 200 })); }) as typeof fetch;
  Deno.env.get = ((k: string) =>
    k === "OPENAI_API_KEY" || k === "ANTHROPIC_API_KEY" ? "test-key" : undefined) as typeof Deno.env.get;
  try {
    const exhausted = new ModelCallCollector(BUDGET);
    for (let i = 0; i < 3; i++) exhausted.sink(unpricedCall(10, 10), true);
    const r = await generateText({
      taskType: "pilot_chat", messages: [{ role: "user", content: "hi" }],
      budget: exhausted,
    } as GenerateOpts);
    assertEquals(r.ok, false, "an exhausted budget must refuse");
    assertEquals(r.errorCode, "model_budget_exhausted", "and say why, truthfully");
    assertEquals(fetches, 0, "NO provider was reached — not even the fallback");
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.get = realGet;
  }
});

Deno.test("the remaining unpriced models are named, and none has a price", () => {
  // Retiring one means adding a verifiable figure to MODEL_PRICES and deleting
  // the name here — never converting `unknown` to $0. Was four; haiku-4.5 has
  // been retired from the list (see the direct-Anthropic test below), so the
  // three that remain are all gateway-billed.
  const names = Object.keys(UNPRICED_MODELS).sort();
  assertEquals(names, [
    "google/gemini-2.5-flash-lite",
    "google/gemini-3-flash-preview",
    "openai/gpt-5-mini",
  ]);
  for (const m of names) {
    assertEquals(MODEL_PRICES[canonicalModelId(m)], undefined,
      `${m} is listed as unpriced but MODEL_PRICES has a figure — remove it from UNPRICED_MODELS`);
    assert(UNPRICED_MODELS[m].length > 10, `${m} must say where it is used`);
  }
});

Deno.test("THE RETIRED ENTRY: haiku-4.5 is priced, and priced correctly", () => {
  const MODEL_PRICES = PRICES_FOR_ROSTER; const priceModelCall = priceForRoster;
  // The one model billed directly by Anthropic. Verified against Anthropic's
  // published API pricing on 2026-09-10: Claude Haiku 4.5 is $1/MTok base
  // input, $0.10/MTok on cache hits, $5/MTok output.
  const price = MODEL_PRICES["claude-haiku-4-5-20251001"];
  assert(price, "the active Anthropic model must be priced");
  assertEquals(price.input_per_1m, 1.00);
  assertEquals(price.cached_input_per_1m, 0.10);
  assertEquals(price.output_per_1m, 5.00);
  // Provenance is not decoration: it is what makes the figure checkable against
  // an invoice rather than against a blog post.
  assertEquals(price.billed_by, "anthropic", "must record WHERE it is billed");
  assert(price.price_source && price.price_source.length > 20, "must say where the figure came from");
  assert(price.effective, "a price with no date is a rumour");

  // The exact call that ran in production: task 20fc24e7, 3153 in / 308 out.
  const real = priceModelCall({
    model: "claude-haiku-4-5-20251001",
    usage: { input_tokens: 3153, cached_input_tokens: 0, output_tokens: 308 },
  });
  assertEquals(real.source, "event_priced");
  assertEquals(real.estimated_usd, Math.round((3153 * 1.00 + 308 * 5.00) / 1e6 * 1e6) / 1e6);
});

Deno.test("FAIL SAFE: an unrecognised haiku snapshot does not inherit this price", () => {
  const priceModelCall = priceForRoster;
  // Keyed on the EXACT dated id, unlike the OpenAI entries whose bare ids let
  // `canonicalModelId` prefix-match snapshots. A future
  // `claude-haiku-4-5-<newdate>` may not carry today's rate, and prefix matching
  // would bill it silently at this one. Unknown must stay unknown.
  const future = priceModelCall({
    model: "claude-haiku-4-5-20260601",
    usage: { input_tokens: 1000, output_tokens: 100 },
  });
  assertEquals(future.source, "unknown");
  assertEquals(future.estimated_usd, null);
  assertEquals(future.actual_usd, null);

  // And a priced model reporting no usage is still not a free call.
  const noUsage = priceModelCall({ model: "claude-haiku-4-5-20251001", usage: {} });
  assertEquals(noUsage.source, "unknown");
  assertEquals(noUsage.estimated_usd, null);
});

Deno.test("L2 is OFF unless a limit is configured", () => {
  assertEquals(resolveRunBudget(() => undefined), null,
    "no config means no bound — today's behaviour, unchanged");
  assertEquals(resolveRunBudget((k) => k === RUN_MAX_CALLS_ENV ? "0" : undefined), null, "zero is not a bound, it is a mistake");
  assertEquals(resolveRunBudget((k) => k === RUN_MAX_CALLS_ENV ? "-5" : undefined), null);
  assertEquals(resolveRunBudget((k) => k === RUN_MAX_CALLS_ENV ? "abc" : undefined), null);

  const b = resolveRunBudget((k) => k === RUN_MAX_CALLS_ENV ? "40" : undefined);
  assertEquals(b?.max_calls, 40);
  assert((b?.max_input_tokens ?? 0) > 0, "a half-configured budget must not bound tokens at zero");
  assert((b?.max_total_tokens ?? 0) >= (b?.max_input_tokens ?? 0));

  const full = resolveRunBudget((k) =>
    k === RUN_MAX_CALLS_ENV ? "10" : k === RUN_MAX_INPUT_ENV ? "500" :
    k === RUN_MAX_OUTPUT_ENV ? "100" : k === RUN_MAX_TOTAL_ENV ? "550" : undefined);
  assertEquals(full, {
    max_calls: 10, max_input_tokens: 500, max_output_tokens: 100, max_total_tokens: 550,
  });
});

Deno.test("THE OTHER HALF: run-agent wires both layers too", async () => {
  // Layer 1 was in `pilot-chat` ONLY. run-agent does the bulk of this system's
  // model spend — 250 of the 257 ledger rows when this was written — and was
  // bounded by neither layer: no `authorizeModelSpend` call, and the generic
  // agent execution passed no `budget`.
  //
  // That mattered more once `claude-haiku-4-5-20251001` was priced. Layer 2's
  // `check()` counts ONLY unpriced calls, so pricing a model deliberately moves
  // it out of the token budget and into the money ceiling. Without Layer 1 here,
  // pricing it would have left it bounded by nothing at all.
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url),
  );
  assert(src.includes("authorizeModelSpend("),
    "run-agent must consult the workspace USD ceiling — it is where the spend is");
  assert(src.includes("MODEL_SPEND_REFUSED"),
    "and must refuse with the machine-readable code, not prose");
  assert(src.includes("budget: genericModelCalls"),
    "the generic agent execution must honour Layer 2 for models with no price");
  assert(src.includes("new ModelCallCollector(resolveRunBudget())"),
    "the collector must carry the run budget");

  // The ceiling must be checked AFTER the workspace guard — otherwise it is a
  // probe for another workspace's spend — and BEFORE any task row is inserted,
  // so a refusal leaves no orphaned `running` task behind.
  const guardAt = src.indexOf("decideWorkspaceAccess({");
  const ceilingAt = src.indexOf("authorizeModelSpend(");
  const taskInsertAt = src.indexOf('.from("tasks")\n        .insert(');
  assert(guardAt > 0 && ceilingAt > guardAt,
    "the ceiling must come after the workspace access guard");
  if (taskInsertAt > 0) {
    assert(ceilingAt < taskInsertAt,
      "the ceiling must be checked before a task row is created");
  }
});

Deno.test("LAYER 1 REACHES EVERY FUNCTION THAT SPENDS ON MODELS", async () => {
  // It was `pilot-chat` only, then `pilot-chat` + `run-agent`. Metering the
  // remaining four made them VISIBLE; it did not make them BOUNDED — an
  // onboarding or brief loop still reported every call against a ceiling that
  // never consulted it. All six now do.
  const SPENDERS = [
    "pilot-chat", "run-agent", "orchestrate",
    "daily-brief", "generate-company-brain-draft", "setup-company-brain",
  ];
  for (const fn of SPENDERS) {
    const src = await Deno.readTextFile(
      new URL(`../../../supabase/functions/${fn}/index.ts`, import.meta.url),
    );
    assert(
      src.includes("authorizeModelSpend("),
      `${fn} makes model calls but never consults the workspace USD ceiling`,
    );
    assert(
      src.includes("resolveSpendEnforcement()"),
      `${fn} must honour MODEL_SPEND_ENFORCEMENT rather than always refusing or never refusing`,
    );
  }
});

Deno.test("THE CEILING IS NOT OVER-BROAD: free paths are not gated", async () => {
  // A MODEL ceiling must not refuse work that spends nothing on models.
  // Getting this wrong is how a ceiling becomes an outage and gets switched off.
  const setup = await Deno.readTextFile(
    new URL("../../../supabase/functions/setup-company-brain/index.ts", import.meta.url),
  );
  // Only `analyze` and `generate_followups` reach a model; the other five
  // actions are pure writes. The gate is per-branch, not per-request.
  assert(
    setup.includes('refuseIfOverCeiling(admin, workspace_id, "analyze")') &&
      setup.includes('refuseIfOverCeiling(admin, workspace_id, "followups")'),
    "setup-company-brain must gate its two spending branches",
  );
  for (const free of ["save_basics", "save_structured", "save_sources", "finalize"]) {
    const at = setup.indexOf(`action === "${free}"`);
    assert(at > 0, `premise: ${free} still exists`);
    const branch = setup.slice(at, at + 700);
    assert(
      !branch.includes("refuseIfOverCeiling"),
      `${free} spends nothing on models and must not be refused by a model ceiling`,
    );
  }

  // orchestrate's liveness probe must not fail on a spend ceiling.
  const orch = await Deno.readTextFile(
    new URL("../../../supabase/functions/orchestrate/index.ts", import.meta.url),
  );
  const pingAt = orch.indexOf("?.ping === true");
  const ceilingAt = orch.indexOf("authorizeModelSpend(");
  assert(pingAt > 0 && ceilingAt > pingAt, "ping must return before the ceiling is consulted");

  // generate-company-brain-draft: the Apify/Firecrawl actions are credit-gated,
  // not model-gated, and must not be double-gated here.
  const draft = await Deno.readTextFile(
    new URL("../../../supabase/functions/generate-company-brain-draft/index.ts", import.meta.url),
  );
  const draftAt = draft.indexOf('action === "draft"');
  const ceil2 = draft.indexOf("authorizeModelSpend(");
  assert(draftAt > 0 && ceil2 > draftAt, "the ceiling must sit inside the draft branch");
  for (const free of ["research_founder", "research_company", "status"]) {
    const at = draft.indexOf(`action === "${free}"`);
    assert(at > 0, `premise: ${free} still exists`);
    assert(
      !draft.slice(at, at + 600).includes("authorizeModelSpend"),
      `${free} makes no model call and must not be gated by the model ceiling`,
    );
  }
});

Deno.test("THE BRIEF DEGRADES INSTEAD OF DISAPPEARING", async () => {
  // daily-brief is the one place the ceiling does not refuse. Its model call
  // POLISHES `deterministicMd`, which is already complete from real rows, so a
  // 429 would delete a working scheduled report to save half a cent — and a
  // report that vanishes is how a ceiling gets turned off.
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/daily-brief/index.ts", import.meta.url),
  );
  assert(src.includes("authorizeModelSpend("), "the ceiling must still be consulted");
  assert(
    !/return json\([^)]*MODEL_SPEND_REFUSED/.test(src),
    "daily-brief must NOT 429 — the deterministic brief is still worth sending",
  );
  assert(src.includes("class SkipPolish"), "the skip must be distinguishable from a provider failure");
  assert(
    src.includes("if (!spend.allowed) throw new SkipPolish()"),
    "an over-ceiling workspace must skip the polish, not lose the brief",
  );
  // And the log must not blame the provider for a ceiling decision.
  assert(
    src.includes("if (!(e instanceof SkipPolish))"),
    "a skipped polish must not be logged as an AI failure",
  );
});

Deno.test("chat wires both layers, and Layer 2 into the fallback chain", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/pilot-chat/index.ts", import.meta.url),
  );
  assert(src.includes("new ModelCallCollector(resolveRunBudget())"),
    "the collector must carry the run budget");
  assert(src.includes("budget: fail.modelCalls"),
    "and it must reach generateText, or the fallback chain is unbounded");
  assert(src.includes("authorizeModelSpend("), "Layer 1 still gates the request");
});
