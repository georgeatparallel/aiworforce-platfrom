// Active CHARACTERIZATIONS of unsafe paths, not acceptance tests. They pass by
// reproducing current gaps and MUST NOT be used to authorize the live smoke.
// No production implementation changes; only injected/mock transports.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { completeOpenAiCompatible } from "../../../supabase/functions/_shared/leadStrategy/adapters/shared.ts";
import { ModelCallCollector } from "../../../supabase/functions/_shared/executionLedger.ts";
import { runTool } from "../../../supabase/functions/_shared/toolRegistry.ts";
const budget = () =>
  new ModelCallCollector({
    max_calls: 10,
    max_all_calls: 1,
    require_priced: true,
    max_input_tokens: 10000,
    max_output_tokens: 10000,
    max_total_tokens: 20000,
  });
const call = (model: string) => ({
  model,
  systemPrompt: "synthetic control",
  userMessage: "return {}",
});
const response = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
Deno.test("[known-gap] strategist check-only transport starts an unknown-price model despite strict collector", async () => {
  const c = budget();
  let starts = 0;
  const result = await completeOpenAiCompatible(
    call("unpriced-smoke-control"),
    {
      provider: "openai",
      endpoint: "https://example.invalid",
      headers: {},
      budget: c,
      onModelCall: c.sink,
      fetchImpl: () => {
        starts++;
        return Promise.resolve(response());
      },
    },
  );
  assertEquals(
    starts,
    1,
    "current unsafe behavior; desired admission would send zero requests",
  );
  assertEquals(result.ok, true);
});
Deno.test("[known-gap] two concurrent strategist calls exceed a one-attempt cap before telemetry arrives", async () => {
  const c = budget();
  let starts = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoke = () =>
    completeOpenAiCompatible(call("gpt-4.1"), {
      provider: "openai",
      endpoint: "https://example.invalid",
      headers: {},
      budget: c,
      onModelCall: c.sink,
      fetchImpl: () => {
        starts++;
        return gate.then(response);
      },
    });
  const a = invoke(), b = invoke();
  const beforeCompletion = starts;
  release();
  await Promise.all([a, b]);
  assertEquals(
    beforeCompletion,
    2,
    "current unsafe behavior; desired prospective admission allows one",
  );
  assertEquals(
    c.check().allowed,
    false,
    "the retrospective refusal happens after both mock purchases",
  );
});
function noopQuery(): unknown {
  const q: Record<string, unknown> = {};
  for (
    const key of [
      "select",
      "insert",
      "update",
      "upsert",
      "delete",
      "eq",
      "in",
      "is",
      "not",
      "order",
      "limit",
      "match",
      "filter",
      "single",
      "maybeSingle",
      "range",
      "contains",
    ]
  ) q[key] = () => q;
  q.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return q;
}
Deno.test("[known-gap] Firecrawl internal retry sends two POSTs under one logical credit reservation", async () => {
  const originalFetch = globalThis.fetch;
  const names = ["FIRECRAWL_API_KEY", "LEAD_CREDIT_ENFORCEMENT"];
  const saved = names.map((name) => Deno.env.get(name));
  let posts = 0, reserves = 0;
  try {
    Deno.env.set("FIRECRAWL_API_KEY", "synthetic-not-a-credential");
    Deno.env.set("LEAD_CREDIT_ENFORCEMENT", "enforce");
    globalThis.fetch = (_input, _init) => {
      posts++;
      return Promise.resolve(
        posts === 1
          ? new Response(
            JSON.stringify({ error: "synthetic uncertain server failure" }),
            { status: 500 },
          )
          : new Response(
            JSON.stringify({
              success: true,
              data: { markdown: "synthetic evidence", metadata: {} },
            }),
            { status: 200 },
          ),
      );
    };
    const result = await runTool("scrape_url", {
      url: "https://company.example",
      max_pages: 1,
      defer_persistence: true,
    }, {
      workspace_id: "11111111-1111-4111-8111-111111111111",
      agent_slug: "scout",
      agent_id: null,
      admin: {
        from: () => noopQuery(),
        rpc: (name: string) => {
          if (name === "credits_reserve") reserves++;
          return Promise.resolve({
            data: {
              ok: true,
              transaction_id: "synthetic-credit",
              actual_credits: 1,
            },
            error: null,
          });
        },
      },
    } as never);
    assertEquals(result.ok, true);
    assertEquals(reserves, 1);
    assertEquals(posts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, i) =>
      saved[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, saved[i]!)
    );
  }
});
