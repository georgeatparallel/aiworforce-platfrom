import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  executeWebSearch,
  formatSearchContext,
  PARALLEL_SEARCH_URL,
  resolveWebSearch,
  SEARCH_USER_AGENT,
} from "../../../supabase/functions/_shared/parallelSearch.ts";
import {
  isToolConfigured,
  runTool,
} from "../../../supabase/functions/_shared/toolRegistry.ts";
import { resolvePlannedTool } from "../../../supabase/functions/_shared/plannedToolResolver.ts";
import {
  getActorByKey,
  isActorRuntimeEnabled,
} from "../../../supabase/functions/_shared/actorRegistry.ts";
import { webSearchAvailable } from "../../../supabase/functions/_shared/marketResearchSurface.ts";
import { installFakeNetwork, type Tables } from "../_helpers/fakeNetwork.ts";

const ENV_KEYS = [
  "ENABLE_SEARCH_WEB",
  "SEARCH_WEB_PROVIDER",
  "SEARCH_WEB_API_KEY",
  "GEMINI_SEARCH",
  "PARALLEL_API_KEY",
];
async function searchEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const saved = ENV_KEYS.map((key) => Deno.env.get(key));
  ENV_KEYS.forEach((key) => Deno.env.delete(key));
  Object.entries(vars).forEach(([key, value]) => {
    if (value !== undefined) Deno.env.set(key, value);
  });
  try {
    await run();
  } finally {
    ENV_KEYS.forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  }
}

const PAYLOAD = {
  results: [{
    url: "https://example.com/news?a=1&b=2",
    title: "Market news",
    excerpts: ["Verified fixture evidence."],
  }],
};
function mcpNetwork(
  options: {
    sse?: boolean;
    failure?: string;
    payload?: unknown;
    onSearch?: () => void;
  } = {},
) {
  const previous = globalThis.fetch;
  const calls: Array<
    {
      body: {
        method: string;
        params: { arguments: { search_queries: string[] } };
      };
      headers: Headers;
    }
  > = [];
  let streamCancelled = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== PARALLEL_SEARCH_URL) return previous(input, init);
    assertEquals(init?.redirect, "error");
    assertEquals(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    assertEquals(headers.get("user-agent"), SEARCH_USER_AGENT);
    assertEquals(
      headers.get("authorization"),
      null,
      "ambient keys must not be forwarded",
    );
    calls.push({ body, headers });
    if (body.method === "tools/call") options.onSearch?.();
    if (options.failure === "http") {
      return new Response("quota", { status: 429 });
    }
    if (options.failure === "wait" && body.method === "tools/call") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else {signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });}
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} } }
      : body.method === "tools/list"
      ? { tools: [{ name: "web_search" }] }
      : options.failure === "tool"
      ? { isError: true, content: [{ type: "text", text: "failure" }] }
      : options.sse
      ? { structuredContent: options.payload ?? PAYLOAD }
      : {
        content: [{
          type: "text",
          text: JSON.stringify(options.payload ?? PAYLOAD),
        }],
      };
    const message = {
      jsonrpc: "2.0",
      id: body.id,
      ...(options.failure === "rpc" ? { error: { code: -32603 } } : { result }),
    };
    if (options.failure === "invalid") {
      return new Response("broken", {
        headers: { "content-type": "application/json" },
      });
    }
    if (options.sse) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const data = `: keepalive\r\n\r\nevent: message\r\ndata: ${
              JSON.stringify(message)
            }\r\n\r\n`;
            // Split the response across arbitrary bytes, including CRLF.
            const encoded = encoder.encode(data);
            for (let p = 0; p < encoded.length; p += 7) {
              controller.enqueue(encoded.slice(p, p + 7));
            }
          },
          cancel() {
            streamCancelled = true;
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "fixture-session",
          },
        },
      );
    }
    return Response.json(message, {
      headers: { "mcp-session-id": "fixture-session" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
    cancelled: () => streamCancelled,
  };
}

Deno.test("selection preserves saved providers, credentials, disable controls and explicit overrides", async () => {
  for (
    const [vars, expected] of [
      [{}, "parallel"],
      [{ ENABLE_SEARCH_WEB: "false" }, "disabled"],
      [{ ENABLE_SEARCH_WEB: "0", SEARCH_WEB_PROVIDER: "parallel" }, "disabled"],
      [{ SEARCH_WEB_PROVIDER: "gemini" }, "unconfigured"],
      [{ SEARCH_WEB_API_KEY: "saved-key" }, "unconfigured"],
      [{ GEMINI_SEARCH: "saved-backend" }, "unconfigured"],
      [
        { GEMINI_SEARCH: "saved-backend", SEARCH_WEB_PROVIDER: "parallel" },
        "parallel",
      ],
    ] as const
  ) {
    assertEquals(
      resolveWebSearch((key) => (vars as Record<string, string>)[key]),
      expected,
    );
    await searchEnv(vars, async () => {
      assertEquals(
        isToolConfigured("search_web").ready,
        expected === "parallel",
      );
      assertEquals(webSearchAvailable(), expected === "parallel");
      assertEquals(
        isActorRuntimeEnabled(getActorByKey("search_web")!),
        expected === "parallel",
      );
    });
  }
  assertEquals(
    resolvePlannedTool({
      tool_needed: "search_web",
      tool_name: "source_with_apify",
    }).tool,
    "search_web",
  );
  assertEquals(
    resolvePlannedTool({ tool_needed: "scrape_url", tool_name: "search_web" })
      .tool,
    "scrape_url",
  );
  assertEquals(
    resolvePlannedTool({ selected_actor_key: "search_web" }).tool,
    "search_web",
  );
});

for (const sse of [false, true]) {
  Deno.test(`dispatcher consumes cited MCP results (${sse ? "SSE" : "JSON"}) anonymously`, async () => {
    await searchEnv({ PARALLEL_API_KEY: "ambient-never-send" }, async () => {
      const tables: Tables = { tool_calls: [], activity_feed: [] };
      const db = installFakeNetwork({
        supabaseUrl: "https://fake.supabase.test",
        tables,
        modelReplies: [],
      });
      const net = mcpNetwork({ sse });
      try {
        const resolved = resolvePlannedTool({ tool_needed: "search_web" });
        const result = await runTool(resolved.tool, {
          query: "market news",
          max_results: 1,
          session_id: "11111111-1111-4111-8111-111111111111",
        }, {
          admin: createClient("https://fake.supabase.test", "fake"),
          agent_slug: "hawk",
          agent_id: null,
          workspace_id: "w",
        });
        assert(result.ok);
        const context = formatSearchContext(result.data);
        assert(context.includes("Verified fixture evidence."));
        assert(context.includes("https://example.com/news?a=1&b=2"));
        assert(context.includes("untrusted evidence"));
        assertEquals(tables.tool_calls[0].status, "succeeded");
        assertEquals(net.calls.map((c) => c.body.method), [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
        ]);
        for (const call of net.calls.slice(1)) {
          assertEquals(call.headers.get("mcp-session-id"), "fixture-session");
          assertEquals(call.headers.get("mcp-protocol-version"), "2025-03-26");
        }
        assertEquals(net.calls[3].body.params.arguments.search_queries, [
          "market news",
        ]);
        if (sse) {
          assert(
            net.cancelled(),
            "persistent SSE must be closed after receiving the matching response",
          );
        }
      } finally {
        net.restore();
        db.restore();
      }
    });
  });
}

Deno.test("disabled, saved provider and forbidden agent never call MCP", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("unexpected network");
  }) as typeof fetch;
  try {
    for (
      const vars of [{ ENABLE_SEARCH_WEB: "false" }, {
        SEARCH_WEB_PROVIDER: "other",
      }, { SEARCH_WEB_API_KEY: "saved" }]
    ) {
      await searchEnv(
        vars,
        async () =>
          assertEquals(
            (await executeWebSearch({ query: "news" })).unavailable,
            true,
          ),
      );
    }
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = previous;
  }
  const tables: Tables = { tool_calls: [], activity_feed: [] };
  const db = installFakeNetwork({
    supabaseUrl: "https://fake.supabase.test",
    tables,
    modelReplies: [],
  });
  const net = mcpNetwork();
  try {
    const result = await runTool("search_web", { query: "news" }, {
      admin: createClient("https://fake.supabase.test", "fake"),
      agent_slug: "penn",
      agent_id: null,
      workspace_id: "w",
    });
    assertEquals(result.error, "tool_forbidden");
    assertEquals(net.calls.length, 0);
  } finally {
    net.restore();
    db.restore();
  }
});

Deno.test("errors, malformed output, timeouts and cancellation never fall back", async () => {
  await searchEnv({}, async () => {
    for (const failure of ["http", "rpc", "tool", "invalid", "wait"]) {
      const net = mcpNetwork({ failure });
      try {
        const result = await executeWebSearch({ query: "news" }, {
          timeoutMs: failure === "wait" ? 10 : 1000,
        });
        assertEquals(result.ok, false);
        if (failure === "http") assertEquals(result.error, "parallel_http_429");
        if (failure === "wait") {
          assertEquals(result.error, "search_web_timeout");
        }
        assertEquals(
          net.calls.filter((c) => c.body.method === "initialize").length,
          1,
        );
      } finally {
        net.restore();
      }
    }
    const net = mcpNetwork({ failure: "wait" });
    try {
      const controller = new AbortController();
      const pending = executeWebSearch({ query: "news" }, {
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(), 10);
      assertEquals((await pending).error, "search_web_cancelled");
      clearTimeout(timer);
    } finally {
      net.restore();
    }
    for (
      const url of ["javascript:alert(1)", "https://user:secret@example.com/"]
    ) {
      const net = mcpNetwork({
        payload: { results: [{ url, excerpts: ["bad"] }] },
      });
      try {
        assertEquals(
          (await executeWebSearch({ query: "news" })).error,
          "parallel_invalid_search_url",
        );
      } finally {
        net.restore();
      }
    }
    const empty = mcpNetwork({ payload: { results: [] } });
    try {
      const result = await executeWebSearch({ query: "news" });
      assert(result.ok);
      assert(formatSearchContext(result.data).includes("No matching results"));
    } finally {
      empty.restore();
    }
  });
});

Deno.test("the actual run-agent handler dispatches search and consumes evidence in its model prompt", async () => {
  const vars = {
    RUN_AGENT_IMPORT_ONLY: "1",
    SUPABASE_URL: "https://fake.supabase.test",
    SUPABASE_ANON_KEY: "fake-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fake-service",
    ANTHROPIC_API_KEY: "scripted-model-key",
    MODEL_SPEND_ENFORCEMENT: "enforce",
    MODEL_SPEND_CEILING_USD: "25",
    MODEL_SPEND_PERIOD_DAYS: "1",
    LINEAGE_LEASE_ENFORCED: "false",
  };
  const saved = Object.keys(vars).map((key) => Deno.env.get(key));
  Object.entries(vars).forEach(([key, value]) => Deno.env.set(key, value));
  try {
    const { handleRunAgent } = await import(
      "../../../supabase/functions/run-agent/index.ts"
    );
    for (
      const scenario of ["success", "disabled", "error", "retired", "cancelled"]
    ) {
      await searchEnv(
        scenario === "disabled" ? { ENABLE_SEARCH_WEB: "false" } : {},
        async () => {
          const workspace = "11111111-1111-4111-8111-111111111111";
          const plan = "22222222-2222-4222-8222-222222222222";
          const tables: Tables = {
            agents: [{
              id: "hawk-id",
              slug: "hawk",
              name: "Hawk",
              workspace_id: workspace,
            }],
            task_plans: [{
              id: plan,
              steps: [{ agent_slug: "hawk", tool_needed: "search_web" }],
            }],
            tasks: [],
            activity_feed: [],
            company_brain: [],
            tool_calls: [],
            lead_model_calls: [],
            lead_execution_calls: [],
            messages: [],
            lead_candidates: [],
            signals: [],
          };
          const db = installFakeNetwork({
            supabaseUrl: vars.SUPABASE_URL,
            tables,
            modelReplies: [{
              when: () => true,
              content: scenario === "success"
                ? "Evidence: https://example.com/news?a=1&b=2"
                : "Current evidence unavailable.",
            }],
          });
          const dbFetch = globalThis.fetch;
          // This fixture represents the supported pre-migration lease path.
          // Real routing, task writes, model budgeting and consumption still run.
          globalThis.fetch = ((input, init) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith("/rest/v1/rpc/acquire_lineage_lease")) {
              return Promise.resolve(
                Response.json(
                  { code: "PGRST202", message: "function absent" },
                  { status: 404 },
                ),
              );
            }
            return dbFetch(input, init);
          }) as typeof fetch;
          const controller = new AbortController();
          const net = mcpNetwork(
            scenario === "error"
              ? { failure: "http" }
              : scenario === "cancelled"
              ? { failure: "wait", onSearch: () => controller.abort() }
              : {},
          );
          try {
            const response = await handleRunAgent(
              new Request(`${vars.SUPABASE_URL}/functions/v1/run-agent`, {
                method: "POST",
                signal: controller.signal,
                headers: {
                  Authorization: "Bearer fake-service",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  plan_id: plan,
                  step_index: 0,
                  agent_slug: "hawk",
                  workspace_id: workspace,
                  user_id: "33333333-3333-4333-8333-333333333333",
                  instruction: scenario === "retired"
                    ? "Research market news"
                    : "Research market news about https://example.com/",
                  tool_needed: scenario === "retired"
                    ? "research_web"
                    : "search_web",
                  tool_input: {
                    tool_name: "search_web",
                    query: "market news",
                    max_results: 1,
                  },
                }),
              }),
            );
            if (scenario === "cancelled") {
              assertEquals(response.status, 499);
              assertEquals(
                db.modelCalls.length,
                0,
                "cancelled research must not start model inference",
              );
              assertEquals(tables.tasks[0].status, "failed");
              assertEquals(tables.task_plans[0].status, "failed");
              assertEquals(net.calls.length, 4);
              return;
            }
            assertEquals(
              response.status,
              200,
              JSON.stringify(await response.clone().json()),
            );
            assertEquals(
              db.modelCalls.length,
              1,
              "scripted model, actual model-call path",
            );
            assertEquals(
              tables.lead_execution_calls.length,
              1,
              "model inference still reaches its accounting ledger",
            );
            const prompt = db.modelCalls[0].user;
            if (scenario === "success") {
              assert(prompt.includes("Verified fixture evidence."));
              assert(prompt.includes("https://example.com/news?a=1&b=2"));
              assert(prompt.includes("Cite the source URLs"));
              assert(
                String(
                  (tables.tasks[0].result as Record<string, unknown>).output,
                ).includes("https://example.com/news"),
              );
            } else if (scenario === "retired") {
              assert(prompt.includes("Broad web research is unavailable"));
              assert(!prompt.includes("Verified fixture evidence."));
            } else {
              assert(prompt.includes("No current web evidence was retrieved"));
              assert(!prompt.includes("Verified fixture evidence."));
            }
            assertEquals(
              tables.tool_calls.map((row) => row.tool_name),
              scenario === "retired" ? [] : ["search_web"],
              "no provider substitution",
            );
            assertEquals(
              net.calls.length,
              ["disabled", "retired"].includes(scenario)
                ? 0
                : scenario === "error"
                ? 1
                : 4,
            );
          } finally {
            net.restore();
            db.restore();
          }
        },
      );
    }
  } finally {
    Object.keys(vars).forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  }
});
