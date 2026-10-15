// The smoke admission gate WIRED: installed as `fetch` the way worker/main.ts
// installs it, in front of the real provider tool (`runTool`), the real model
// transports (`gptStructured`, `generateText`), the real credit RPCs and the
// real admission RPCs, on real Postgres + PostgREST.
//
// Vendors are FAKES: a function that answers api.apify.com, api.firecrawl.dev,
// api.openai.com and api.anthropic.com and records every request it receives.
// Nothing leaves localhost (run.sh grants net to 127.0.0.1 only), so "the
// vendor saw N requests" is exactly what would have been bought.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createAdmissionFetch, missionAdmission, type AdmissionDb, type MissionAdmissionContext,
} from "../../supabase/functions/_shared/smokeAdmission.ts";
import { runTool, type ToolContext } from "../../supabase/functions/_shared/toolRegistry.ts";
import { gptStructured } from "../../supabase/functions/_shared/gptProvider.ts";
import { generateText } from "../../supabase/functions/_shared/aiProvider.ts";
import { APIFY_START_UNCERTAIN } from "../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import { createLeadMissionRunner } from "../../worker/leadMissionRunner.ts";
import { mintJwt, REST_URL, sql } from "./lib/harness.ts";
import { seedSmokeMission, syntheticQuotes, type SmokeMission } from "./lib/smokeMission.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const HAIKU = "anthropic:claude-haiku-4-5-20251001";
const GPT = "openai:gpt-4.1-mini";

// The test's own client keeps the REAL fetch, as the worker's admission client does.
const realFetch = globalThis.fetch.bind(globalThis);
const client: SupabaseClient = createClient(REST_URL, await mintJwt("service_role"), {
  auth: { persistSession: false },
  global: { fetch: (u, i) => realFetch(String(u).replace(`${REST_URL}/rest/v1`, REST_URL), i) },
});

for (const [k, v] of Object.entries({
  APIFY_API_TOKEN: "apify-test-token", FIRECRAWL_API_KEY: "fc-test", OPENAI_API_KEY: "sk-test-not-a-key",
  ANTHROPIC_API_KEY: "ak-test", LEAD_CREDIT_ENFORCEMENT: "enforce",
})) Deno.env.set(k, v);

interface Seen { method: string; url: URL; body: string | null }
type Script = (r: Seen) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeVendor(script: Script) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const r = { method: (init?.method ?? "GET").toUpperCase(), url, body: typeof init?.body === "string" ? init.body : null };
    if (url.origin === new URL(REST_URL).origin) return realFetch(input, init);
    seen.push(r);
    return await script(r);
  }) as typeof fetch;
  return { seen, fetch: f, to: (host: string) => seen.filter((s) => s.url.hostname === host) };
}

/** Install the gate as the process fetch, run `fn` inside the mission, restore. */
async function inMission<T>(
  m: SmokeMission, vendor: ReturnType<typeof fakeVendor>, fn: () => Promise<T>,
  over: Partial<MissionAdmissionContext> = {},
): Promise<T> {
  const gate = createAdmissionFetch({ baseFetch: vendor.fetch, db: client as unknown as AdmissionDb, ownApi: REST_URL, log: () => {} });
  const ctx: MissionAdmissionContext = { queueId: m.queueId, workerId: m.workerId, taskId: m.taskId, generation: m.generation, ...over };
  globalThis.fetch = gate;
  try {
    return await missionAdmission.run(ctx, fn);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function fundedMission(o: Parameters<typeof seedSmokeMission>[0] = {}) {
  const m = await seedSmokeMission(o);
  await sql`insert into public.workspace_credit_balances (workspace_id, balance_credits) values (${m.ws}, 10)`;
  return m;
}
const toolCtx = (m: SmokeMission): ToolContext => ({
  admin: client, workspace_id: m.ws, agent_slug: "scout", agent_id: null, task_id: m.taskId, lineage_root: m.taskId,
});
const jobsSearch = (q = "growth marketing") => ({
  actor_id: "curious_coder/linkedin-jobs-scraper", source_type: "jobs", query: q, max_results: 5,
  defer_persistence: true, allow_disabled: true,
});
async function credits(ws: string) {
  const [b] = await sql`select balance_credits, reserved_credits from public.workspace_credit_balances where workspace_id = ${ws}`;
  const tx = await sql`select status from public.credit_transactions where workspace_id = ${ws} order by created_at`;
  return { balance: b.balance_credits as number, reserved: b.reserved_credits as number, statuses: tx.map((t) => t.status as string) };
}
async function ops(m: SmokeMission) {
  return await sql`select o.kind, o.actor, o.provider_run_id, o.provider_dataset_id, o.reported_microusd, o.committed_microusd
    from public.discovery_smoke_operations o join public.discovery_smoke_authorizations a on a.id = o.authorization_id
    where a.queue_id = ${m.queueId} order by o.admitted_at`;
}

// ── providers ───────────────────────────────────────────────────────────────

Deno.test("apify: admitted with the template's vendor caps, run id durable, polls admitted, one credit charged", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor((r) => {
    if (r.method === "POST") return json(201, { data: { id: "run-1", defaultDatasetId: "ds-1", status: "RUNNING" } });
    if (r.url.pathname.endsWith("/actor-runs/run-1")) {
      return json(200, { data: { id: "run-1", status: "SUCCEEDED", defaultDatasetId: "ds-1", usageTotalUsd: 0.012 } });
    }
    if (r.url.pathname.endsWith("/datasets/ds-1/items")) return json(200, []);
    return json(404, {});
  });
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(res.ok, JSON.stringify(res).slice(0, 300));
  const posts = v.seen.filter((s) => s.method === "POST");
  assertEquals(posts.length, 1);
  assertEquals(posts[0].url.searchParams.get("timeout"), "120", "vendor-side caps pinned from the template");
  assertEquals(posts[0].url.searchParams.get("maxItems"), "50");
  assertEquals(posts[0].url.searchParams.get("memory"), "1024");
  const o = await ops(m);
  assertEquals(o.map((r) => r.kind), ["provider", "poll", "poll"]);
  assertEquals(o[0].provider_run_id, "run-1");
  assertEquals(o[0].provider_dataset_id, "ds-1");
  assertEquals(o[0].reported_microusd, "12000", "Apify's reported usage is recorded against the purchase");
  assertEquals(await credits(m.ws), { balance: 9, reserved: 0, statuses: ["charged"] }, "the credit rule is unchanged");

  // A restarted slice asks the same question: no second purchase reaches Apify.
  const again = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assertEquals(again.ok, false);
  assertEquals(v.seen.filter((s) => s.method === "POST").length, 1, "never bought twice");
  assertEquals((await credits(m.ws)).balance, 9, "and never charged twice");
});

Deno.test("apify: a refused admission sends nothing and releases the credit", opts, async () => {
  const quotes = syntheticQuotes();
  delete quotes.apify_jobs;                    // no reviewed price for this actor
  const m = await fundedMission({ quotes });
  const v = fakeVendor(() => json(500, {}));
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assertEquals(res.error, "apify_start_failed:409");
  assertEquals(v.seen.length, 0, "the vendor saw nothing");
  assertEquals(await credits(m.ws), { balance: 10, reserved: 0, statuses: ["not_charged"] }, "a definite non-start is refunded");
  assertEquals((await ops(m)).length, 0);
});

Deno.test("apify: an uncertain start keeps its credit HELD and is never bought again", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor((r) => r.method === "POST" ? json(503, { error: "upstream" }) : json(404, {}));
  const first = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(String(first.error).startsWith(APIFY_START_UNCERTAIN), String(first.error));
  assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, "held (#88)");
  const o = await ops(m);
  assertEquals(o.length, 1);
  assertEquals(o[0].provider_run_id, null, "no run id: the purchase is uncertain");

  const replay = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(String(replay.error).startsWith(APIFY_START_UNCERTAIN), `the replay is still uncertain: ${replay.error}`);
  assertEquals(v.seen.filter((s) => s.method === "POST").length, 1, "the uncertain purchase is not sent again");
  assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, "still held, not refunded by the replay");
  assertEquals((await ops(m)).length, 1, "and the mission is not charged twice");
});

Deno.test("apify: when polls run out the wait stops at once; the run stays pending with its id", opts, async () => {
  const m = await fundedMission();
  await sql`update public.discovery_smoke_authorizations set provider_polls = 1 where queue_id = ${m.queueId}`;
  const v = fakeVendor((r) => r.method === "POST"
    ? json(201, { data: { id: "run-p", defaultDatasetId: "ds-p", status: "RUNNING" } })
    : json(200, { data: { id: "run-p", status: "RUNNING", defaultDatasetId: "ds-p" } }));
  const t0 = Date.now();
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  const ms = Date.now() - t0;
  assertEquals(res.ok, false);
  const d = res.data as { run_id?: string; pending?: boolean };
  assertEquals(d.run_id, "run-p");
  assertEquals(d.pending, true, "pending, resumable: never discarded");
  assertEquals(v.seen.filter((s) => s.method === "GET").length, 1, "one admitted poll, then nothing sent");
  assert(ms < 20_000, `stopped waiting after the refusal, not after the 90 s window (${ms} ms)`);
  assertEquals(await credits(m.ws), { balance: 9, reserved: 0, statuses: ["charged"] }, "a started run is charged");
});

Deno.test("firecrawl: the scrape's own retry after a 5xx is the same purchase and is never sent twice", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor(() => json(502, { error: "bad gateway" }));
  const res = await inMission(m, v, () => runTool("scrape_url", { url: "https://example.com/about", max_pages: 1 }, toolCtx(m)));
  assertEquals(res.ok, false);
  assertEquals(v.seen.length, 1, "one physical scrape");
  assertEquals(JSON.parse(v.seen[0].body!).proxy, "basic", "the template pinned the cheaper proxy");
  assertEquals((await ops(m)).length, 1);
});

// ── models ──────────────────────────────────────────────────────────────────

Deno.test("models: every physical attempt is admitted and counted; fallback and retry are attempts; unbounded output is refused", opts, async () => {
  const quotes = syntheticQuotes({
    gpt: { ...syntheticQuotes().gpt as object, maximum_microusd: 10000, allowed_actors: [GPT] },
    claude: { ...syntheticQuotes().claude as object, maximum_microusd: 10000, allowed_actors: [HAIKU] },
  });
  const m = await fundedMission({ quotes });
  let openaiCalls = 0;
  const v = fakeVendor((r) => {
    if (r.url.hostname === "api.anthropic.com") return json(500, { error: "overloaded" });
    openaiCalls++;
    if (openaiCalls === 3) return json(429, { error: { message: "Rate limit. Please try again in 10ms." } });
    return json(200, { choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  await inMission(m, v, async () => {
    const a = await gptStructured<{ ok: boolean }>({ purpose: "t", system: "s", user: "u", model: "gpt-4.1-mini", maxTokens: 500 });
    assert(a.ok, JSON.stringify(a));                                                       // attempt 1
    const unbounded = await gptStructured({ purpose: "t", system: "s", user: "u", model: "gpt-4.1-mini" });
    assertEquals(unbounded.ok, false, "no max output tokens: refused before transport");
    const t = await generateText({ taskType: "helper", messages: [{ role: "user", content: "hi" }], maxTokens: 300 });
    assert(t.ok, JSON.stringify(t));                                                       // attempts 2 (anthropic 500) + 3 (openai)
    const r = await gptStructured({ purpose: "t", system: "s", user: "u", model: "gpt-4.1-mini", maxTokens: 500 });
    assertEquals(r.ok, false, "attempt 4 is the 429; its retry would be a 5th attempt and is refused");
  });
  assertEquals(v.to("api.anthropic.com").length, 1);
  assertEquals(v.to("api.openai.com").length, 3);
  const o = await ops(m);
  assertEquals(o.length, 4, "four physical attempts, four admissions");
  assertEquals(o.map((r) => r.actor), [GPT, HAIKU, GPT, GPT]);
});

// ── no context, no binding, no unknown hosts ────────────────────────────────

Deno.test("gate: outside a mission, before binding, after revocation, or to an unknown host, nothing is sent", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor(() => json(200, { data: { id: "x" } }));
  const gate = createAdmissionFetch({ baseFetch: v.fetch, db: client as unknown as AdmissionDb, ownApi: REST_URL, log: () => {} });
  const start = () => gate("https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs?token=t", { method: "POST", body: "{}" });
  const decision = async (r: Response) => ((await r.json()) as { error: { decision: string } }).error.decision;

  assertEquals(await decision(await start()), "no_mission_context");
  const ctx = { queueId: m.queueId, workerId: m.workerId, taskId: null, generation: null };
  assertEquals(await missionAdmission.run(ctx, async () => decision(await start())), "not_bound");
  const ac = new AbortController(); ac.abort();
  assertEquals(await missionAdmission.run({ ...ctx, taskId: m.taskId, generation: m.generation, signal: ac.signal },
    async () => decision(await start())), "revoked");
  const bound = { ...ctx, taskId: m.taskId, generation: m.generation };
  for (const url of ["https://api.resend.com/emails", "https://api.perplexity.ai/chat", `${REST_URL}/functions/v1/run-agent`,
    "https://api.apify.com/v2/acts/x~y/runs/last", "http://api.openai.com/v1/chat/completions"]) {
    assertEquals(await missionAdmission.run(bound, async () => decision(await gate(url, { method: "POST", body: "{}" }))), "forbidden", url);
  }
  assertEquals(v.seen.length, 0, "none of it reached a vendor");
  // The project's own REST API is never gated.
  const rest = await missionAdmission.run(bound, () => gate(`${REST_URL}/rest/v1/workspaces?select=id&limit=1`, { headers: { apikey: "x" } }));
  assert(rest.status !== 409, "REST passes through");
  await rest.body?.cancel();
});

// ── the worker runner binds the mission, its task and its generation ────────

Deno.test("runner: the handler's billable calls run inside the mission, with the bound task and generation", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor(() => json(200, { choices: [{ message: { content: "{}" } }] }));
  const gate = createAdmissionFetch({ baseFetch: v.fetch, db: client as unknown as AdmissionDb, ownApi: REST_URL, log: () => {} });
  const decisions: number[] = [];
  let lastCtx: MissionAdmissionContext | null = null;
  const runner = createLeadMissionRunner({
    handler: async (_req, inProcess) => {
      lastCtx = missionAdmission.getStore() ?? null;
      const call = () => gptStructured({ purpose: "t", system: "s", user: "u", model: "gpt-4.1-mini", maxTokens: 100 })
        .then((r) => decisions.push(r.ok ? 1 : 0));
      await call();                                                     // before binding: refused
      await inProcess.onExecutionBound?.({ taskId: m.taskId, lineageId: m.taskId, holdsLease: true, generation: m.generation });
      await call();                                                     // bound: admitted
      return json(200, { task_id: m.taskId });
    },
    serviceRoleKey: "unused", functionsBaseUrl: "http://127.0.0.1:1",
    createDeadline: () => ({ startedAt: Date.now(), budgetMs: 60000, slowestCallMs: 0, elapsedMs: () => 0, remainingMs: () => 60000,
      expired: () => false, expiredForDurableStart: () => false, observeCall: () => {}, estimateFor: () => 0 }) as never,
    bind: async () => true,
    readTaskOutcome: async () => ({ status: "complete", terminal_status: "completed", lineage_slices: 0, continuation_decision: null }),
    admission: { workerId: m.workerId },
  });
  globalThis.fetch = gate;
  try {
    await runner.run({ queueId: m.queueId, taskId: null, lineageId: null, request: {} } as never,
      { signal: new AbortController().signal, executionBudgetMs: 60000 } as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(decisions, [0, 1]);
  assertEquals(v.to("api.openai.com").length, 1);
  // A promise the handler left behind still carries the context, and is refused.
  globalThis.fetch = gate;
  try {
    const late = await missionAdmission.run(lastCtx!, () =>
      gptStructured({ purpose: "t", system: "s", user: "u", model: "gpt-4.1-mini", maxTokens: 100 }));
    assertEquals(late.ok, false, "after the mission call ended nothing is admitted");
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(v.to("api.openai.com").length, 1);
  const [o] = await ops(m);
  assertEquals(o.kind, "model");
});
