// The smoke admission gate WIRED: installed as `fetch` the way worker/main.ts
// installs it, in front of the real provider tool (`runTool`), the real model
// transports (`gptStructured`, `generateText`), the real credit RPCs and the
// real admission RPCs, on real Postgres + PostgREST.
//
// Vendors are FAKES: a function that answers api.apify.com, api.firecrawl.dev,
// api.openai.com and api.anthropic.com and records every request it receives.
// Nothing leaves localhost (run.sh grants net to 127.0.0.1 only), so "the
// vendor saw N requests" is exactly what would have been bought.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createAdmissionFetch, missionAdmission, type AdmissionDb, type MissionAdmissionContext,
} from "../../supabase/functions/_shared/smokeAdmission.ts";
import { runTool, type ToolContext } from "../../supabase/functions/_shared/toolRegistry.ts";
import { gptStructured } from "../../supabase/functions/_shared/gptProvider.ts";
import { generateText } from "../../supabase/functions/_shared/aiProvider.ts";
import { APIFY_START_UNCERTAIN } from "../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import { createLeadMissionRunner } from "../../worker/leadMissionRunner.ts";
import { APIFY_SETTLED_SOURCE } from "../../supabase/functions/_shared/smokeAdmissionRefusal.ts";
import { completeOpenAiCompatible } from "../../supabase/functions/_shared/leadStrategy/adapters/shared.ts";
import { OPENAI_CHAT_URL } from "../../supabase/functions/_shared/leadStrategy/adapters/openai.ts";
import { LOVABLE_GATEWAY_URL } from "../../supabase/functions/_shared/leadStrategy/adapters/lovableAi.ts";
import { mintJwt, REST_URL, sql } from "./lib/harness.ts";
import { authorizeSmoke, seedSmokeMission, syntheticActorLimits, syntheticQuotes, type SmokeMission } from "./lib/smokeMission.ts";

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
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
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
  over: Partial<MissionAdmissionContext> = {}, db: AdmissionDb = client as unknown as AdmissionDb,
): Promise<T> {
  const gate = createAdmissionFetch({ baseFetch: vendor.fetch, db, ownApi: REST_URL, log: () => {} });
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
  return await sql`select o.kind, o.actor, o.provider_run_id, o.provider_dataset_id, o.reported_microusd, o.committed_microusd, o.report_source
    from public.discovery_smoke_operations o join public.discovery_smoke_authorizations a on a.id = o.authorization_id
    where a.queue_id = ${m.queueId} order by o.admitted_at`;
}

// ── providers ───────────────────────────────────────────────────────────────

Deno.test("apify: admitted with the template's vendor caps, run id durable, polls admitted, one credit charged", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor((r) => {
    if (r.method === "POST") return json(201, { data: { id: "run-1", defaultDatasetId: "ds-1", status: "RUNNING" } });
    if (r.url.pathname.endsWith("/actor-runs/run-1")) {
      // Finished 11 s ago: this terminal status read is already the settled receipt.
      return json(200, { data: { id: "run-1", status: "SUCCEEDED", defaultDatasetId: "ds-1", usageTotalUsd: 0.012, finishedAt: ago(11_000) } });
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
  assertEquals(o[0].report_source, APIFY_SETTLED_SOURCE, "and recorded as settled");
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
  // Three reads: exactly one run's lifecycle. Two status reads leave the one the
  // dataset needs (the receipt is the read a final run defers), so the plan
  // stops waiting after them.
  await sql`update public.discovery_smoke_authorizations set provider_polls = 3 where queue_id = ${m.queueId}`;
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
  assertEquals(v.seen.filter((s) => s.method === "GET").length, 2, "two admitted polls, then nothing sent");
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

// ── Codex review R1, R2, R7 on real credit RPCs ───────────────────────────────

/** The admission RPC fails; everything else (reads, credits) still works. */
const admissionOutage = {
  rpc: (fn: string, args: Record<string, unknown>) => fn === "admit_discovery_smoke"
    ? Promise.resolve({ data: null, error: { message: "synthetic admission outage" } })
    : client.rpc(fn, args),
  from: (t: string) => client.from(t),
} as unknown as AdmissionDb;

for (const [why, prepare, db] of [
  ["the authorization is stopped", (m: SmokeMission) => sql`select public.stop_discovery_smoke(${m.queueId}, 'test')`, undefined],
  ["the admission RPC is down", async () => {}, admissionOutage],
  ["the mission is revoked locally", async () => {}, undefined],
] as const) {
  Deno.test(`R1: a later refusal (${why}) never refunds an earlier uncertain Apify hold`, opts, async () => {
    const m = await fundedMission();
    const v = fakeVendor((r) => r.method === "POST" ? json(503, { error: "upstream" }) : json(404, {}));
    await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
    assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] });
    await prepare(m);
    const ac = new AbortController();
    if (why === "the mission is revoked locally") ac.abort();
    const replay = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)), { signal: ac.signal }, db);
    assert(String(replay.error).startsWith(APIFY_START_UNCERTAIN), String(replay.error));
    assertEquals(v.seen.filter((x) => x.method === "POST").length, 1, "never bought again");
    assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, "still held, not refunded");
  });
}

Deno.test("R1: a first purchase refused outright is still a definite non-start and refunds its own credit", opts, async () => {
  const m = await fundedMission();
  await sql`select public.stop_discovery_smoke(${m.queueId}, 'test')`;
  const v = fakeVendor(() => json(500, {}));
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assertEquals(res.error, "apify_start_failed:409");
  assertEquals(await credits(m.ws), { balance: 10, reserved: 0, statuses: ["not_charged"] });
});

Deno.test("R2: in the smoke, an uncertain Firecrawl purchase keeps its credit HELD", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor(() => json(503, { error: "upstream" }));
  const res = await inMission(m, v, () => runTool("scrape_url", { url: "https://example.com/about", max_pages: 1 }, toolCtx(m)));
  assert(String(res.error).startsWith("firecrawl_uncertain"), String(res.error));
  assertEquals(v.seen.length, 1, "the retry is the same purchase and is not sent");
  assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, "held, not refunded");
  // A definite 4xx is still refunded.
  const m2 = await fundedMission();
  const v2 = fakeVendor(() => json(400, { error: "bad request" }));
  const r2 = await inMission(m2, v2, () => runTool("scrape_url", { url: "https://example.com/about", max_pages: 1 }, toolCtx(m2)));
  assertEquals(r2.ok, false);
  assertEquals(await credits(m2.ws), { balance: 10, reserved: 0, statuses: ["not_charged"] });
});

Deno.test("R2: outside the smoke, Firecrawl settlement is unchanged", opts, async () => {
  const m = await fundedMission();
  const prior = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === new URL(REST_URL).origin) return realFetch(input, init);
    calls++;
    return json(503, {});
  }) as typeof fetch;
  try {
    const res = await runTool("scrape_url", { url: "https://example.com/about", max_pages: 1 }, toolCtx(m));
    assert(String(res.error).startsWith("Firecrawl 503"), String(res.error));
  } finally {
    globalThis.fetch = prior;
  }
  assertEquals(calls, 2, "no gate: the existing retry runs");
  assertEquals(await credits(m.ws), { balance: 10, reserved: 0, statuses: ["not_charged"] }, "refunded exactly as before");
});

Deno.test("R7: a charge reported in the START response is recorded, and an over-quote stops the mission", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor((r) => r.method === "POST"
    ? json(201, { data: { id: "run-x", defaultDatasetId: "ds-x", status: "SUCCEEDED", usageTotalUsd: 1 } })
    : r.url.pathname.endsWith("/items") ? json(200, []) : json(200, { data: { id: "run-x", status: "SUCCEEDED" } }));
  await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  const [op] = await ops(m);
  assertEquals(op.reported_microusd, "1000000");
  const [a] = await sql`select status, stop_reason from public.discovery_smoke_authorizations where queue_id = ${m.queueId}`;
  assertEquals(a.status, "stopped");
  const v2 = fakeVendor(() => json(200, {}));
  await inMission(m, v2, () => runTool("scrape_url", { url: "https://example.com/x", max_pages: 1 }, toolCtx(m)));
  assertEquals(v2.seen.length, 0, "nothing further is admitted after an over-quote charge");
});

Deno.test("R2 (Codex P2): in the smoke, an uncertain Firecrawl CRAWL start keeps its credit HELD", opts, async () => {
  const at = new Date(Date.now() - 3600e3).toISOString();
  const quotes = syntheticQuotes({
    fc_crawl: { allowed_kinds: ["provider"], allowed_actors: ["firecrawl:crawl"], maximum_microusd: 30000, observed_at: at,
      source: "synthetic contract control", liability_bound_ref: "tests/db-contract (not a vendor quote)",
      request_limits: { max_request_bytes: 2048, max_fields: { limit: 5 } } },
  });
  for (const [why, script] of [
    ["a 5xx start", () => json(503, { error: "upstream" })],
    ["a lost connection", () => { throw new TypeError("connection reset"); }],
  ] as Array<[string, Script]>) {
    const m = await fundedMission({ quotes, actorLimits: { ...syntheticActorLimits, "firecrawl:crawl": 1 } });
    const v = fakeVendor(script);
    const res = await inMission(m, v, () => runTool("scrape_url", { url: "https://example.com", max_pages: 3 }, toolCtx(m)));
    assert(String(res.error).startsWith("firecrawl_uncertain:crawl_"), `${why}: ${res.error}`);
    assertEquals(v.seen.length, 1, `${why}: one physical start`);
    assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, `${why}: held, not refunded`);
  }
});

// Codex SAF-008: the quote's mandatory `maxItems` is never sent as an absent or
// empty body. Codex's reproduction, through the real admission RPC.
Deno.test("SAF-008: an absent or empty body never bypasses the quote's mandatory fields", opts, async () => {
  const quotes = syntheticQuotes({
    apify_jobs: { ...(syntheticQuotes().apify_jobs as Record<string, unknown>),
      request_limits: { max_request_bytes: 4096, max_fields: { maxItems: 3 } } },
  });
  const url = "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs";
  for (const body of [null, "", "{}", "null", "[]", " ", '{"maxItems":"3"}', '{"maxItems":4}']) {
    const m = await fundedMission({ quotes });
    const v = fakeVendor(() => json(201, { data: { id: "run-unbounded", status: "RUNNING" } }));
    const res = await inMission(m, v, () => fetch(url, { method: "POST", body }));
    const refusal = await res.json();
    assertEquals(res.status, 409, `${JSON.stringify(body)}: a definite non-start`);
    assertEquals(refusal.error.decision, "request_limits", JSON.stringify(body));
    assertEquals(v.seen.length, 0, `${JSON.stringify(body)}: nothing reaches the vendor`);
    assertEquals((await ops(m)).length, 0, `${JSON.stringify(body)}: no durable purchase`);
  }
  const m = await fundedMission({ quotes });
  const v = fakeVendor(() => json(201, { data: { id: "run-bounded", status: "RUNNING" } }));
  const ok = await inMission(m, v, () => fetch(url, { method: "POST", body: '{"maxItems":3}' }));
  await ok.body?.cancel();
  assertEquals(ok.status, 201, "the bounded request is still bought");
  assertEquals(v.seen.length, 1);
  assertEquals((await ops(m)).length, 1);
});

// ── the strategist transport (Codex's codex/smoke-execution-guards gaps) ────
//
// Codex characterized two strategist gaps against the request-local collector:
// an unknown-price model still started, and two concurrent calls both started
// under a one-attempt cap. The strategist adapter calls the PROCESS fetch at
// call time (no production caller injects `fetchImpl`), so in the smoke every
// strategist attempt goes through the durable gate. These pin that.
const strategist = (model: string, endpoint = OPENAI_CHAT_URL, provider: "openai" | "lovable_ai" = "openai") =>
  completeOpenAiCompatible(
    { model, systemPrompt: "synthetic control", userMessage: "return {}", maxCompletionTokens: 500 },
    { provider, endpoint, headers: { Authorization: "Bearer test" } },
  );
const chat = () => json(200, { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

Deno.test("strategist: an unpriced model, or the Lovable gateway, is refused before transport", opts, async () => {
  const m = await fundedMission();
  const v = fakeVendor(chat);
  const [unpriced, lovable] = await inMission(m, v, () =>
    Promise.all([strategist("unpriced-smoke-control"), strategist(GPT.slice("openai:".length), LOVABLE_GATEWAY_URL, "lovable_ai")]));
  assertEquals(unpriced.ok, false, JSON.stringify(unpriced));
  assertEquals(lovable.ok, false, JSON.stringify(lovable));
  assertEquals(v.seen.length, 0, "nothing reaches a vendor");
  assertEquals((await ops(m)).length, 0, "nothing is admitted");
});

Deno.test("strategist: concurrent attempts in flight never exceed the mission's four model attempts", opts, async () => {
  const m = await fundedMission();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => release = r);
  const v = fakeVendor(() => held.then(chat));
  const results = await inMission(m, v, async () => {
    const calls = Array.from({ length: 6 }, () => strategist(GPT.slice("openai:".length)));
    // Every admission is decided while all six are still in flight.
    for (let i = 0; i < 100 && (await ops(m)).length < 4; i++) await new Promise((r) => setTimeout(r, 20));
    release();
    return await Promise.all(calls);
  });
  assertEquals(v.seen.length, 4, "four physical starts, never more");
  assertEquals(results.filter((r) => r.ok).length, 4);
  assertEquals((await ops(m)).map((o) => o.kind), ["model", "model", "model", "model"]);
});

// ── THE SMOKE'S APIFY READ LIFECYCLE (five reads, shared) ───────────────────
//
// Every status, dataset, resume and receipt GET is one admitted read. A run is
// bought only when its lifecycle fits; a status read is long-polled and spent
// only while the dataset and receipt reads still fit; the receipt is either
// settled (`apify_run(settled).receipt`) or listed by the reconciliation.
const reconciliation = Deno.readTextFileSync(new URL("../../scripts/test-project/smoke-reconciliation.sql", import.meta.url));
const unsettled = async (m: SmokeMission) =>
  (await sql.unsafe(reconciliation.replace(":'queue_id'", `'${m.queueId}'`))).filter((r) => r.receipt === "unsettled");
const reads = async (m: SmokeMission) => (await ops(m)).filter((o) => o.kind === "poll").length;
/** An Apify that honours `waitForFinish`: `finishAfter` status reads, then SUCCEEDED with `finishedAt` `settleLeftMs` short of settled. */
function apify(o: { id: string; finishAfter: number; settleLeftMs?: number; usd?: number; finalUsd?: number; statusDelayMs?: number }) {
  let statusReads = 0;
  let finishedAt: string | null = null;
  const kinds: string[] = [];
  const v = fakeVendor((r) => {
    if (r.method === "POST") return json(201, { data: { id: o.id, defaultDatasetId: `ds-${o.id}`, status: "RUNNING" } });
    if (r.url.pathname.endsWith(`/datasets/ds-${o.id}/items`)) { kinds.push("dataset"); return json(200, []); }
    if (r.url.pathname.endsWith(`/actor-runs/${o.id}`)) {
      const longPoll = r.url.searchParams.has("waitForFinish");
      kinds.push(longPoll ? `status(wait=${r.url.searchParams.get("waitForFinish")})` : "receipt");
      if (longPoll && ++statusReads < o.finishAfter) return json(200, { data: { id: o.id, status: "RUNNING", defaultDatasetId: `ds-${o.id}` } });
      if (o.finishAfter === Infinity) return json(200, { data: { id: o.id, status: "RUNNING", defaultDatasetId: `ds-${o.id}` } });
      finishedAt ??= ago(10_000 - (o.settleLeftMs ?? 200));
      const body = json(200, { data: { id: o.id, status: "SUCCEEDED", defaultDatasetId: `ds-${o.id}`, finishedAt,
        usageTotalUsd: longPoll ? (o.usd ?? 0.004) : (o.finalUsd ?? o.usd ?? 0.004) } });
      // A snapshot taken now, answered late: the delay must not make it "settled".
      return longPoll && o.statusDelayMs ? new Promise<Response>((r) => setTimeout(() => r(body), o.statusDelayMs)) : body;
    }
    return json(404, {});
  });
  return { ...v, kinds };
}

Deno.test("read lifecycle: a run finishing in its first long poll uses exactly three reads, and its receipt is settled", opts, async () => {
  const m = await fundedMission();
  const v = apify({ id: "r1", finishAfter: 1, usd: 0.004, finalUsd: 0.0045 });
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(res.ok, JSON.stringify(res).slice(0, 300));
  assertEquals(v.kinds, ["status(wait=60)", "receipt", "dataset"], "long-poll, settle, then the rows");
  assertEquals(await reads(m), 3, "three of the mission's five reads");
  const [p] = (await ops(m)).filter((o) => o.kind === "provider");
  assertEquals(p.reported_microusd, "4500", "the settled figure, not the preliminary one");
  assertEquals(p.report_source, APIFY_SETTLED_SOURCE);
  assertEquals((await unsettled(m)).length, 0, "nothing left to reconcile");
});

Deno.test("read lifecycle: a slow run takes four reads; a second run that could not be settled is never bought", opts, async () => {
  const m = await fundedMission();
  const v = apify({ id: "r2", finishAfter: 2 });
  const first = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(first.ok, JSON.stringify(first).slice(0, 300));
  assertEquals(v.kinds, ["status(wait=60)", "status(wait=60)", "receipt", "dataset"]);
  assertEquals(await reads(m), 4);
  // One read left: a second run's lifecycle needs three, so the gate does not
  // buy it. Company details: not a discovery page, so only the read plan refuses it.
  const second = await inMission(m, v, () => fetch("https://api.apify.com/v2/acts/harvestapi~linkedin-company/runs?token=t",
    { method: "POST", body: JSON.stringify({ companies: ["https://www.linkedin.com/company/x"] }) }));
  const why = (await second.json()).error;
  assertEquals([second.status, why.decision, why.detail], [409, "read_plan", "reads_exhausted"], "a definite non-start");
  assertEquals(v.seen.filter((s) => s.method === "POST").length, 1, "nothing more was bought");
  assertEquals(await reads(m), 4, "and nothing more was read");
  assertEquals(await credits(m.ws), { balance: 9, reserved: 0, statuses: ["charged"] }, "one credit, for the one run");
});

Deno.test("read lifecycle: a run still RUNNING at the reserve stays pending, its receipt explicitly unsettled and listed", opts, async () => {
  const m = await fundedMission();
  const v = apify({ id: "r3", finishAfter: Infinity });
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  const d = res.data as { run_id?: string; pending?: boolean; receipt?: string };
  assertEquals([res.ok, d.run_id, d.pending, d.receipt], [false, "r3", true, "unsettled"]);
  assertEquals(await reads(m), 4, "status reads stop while the dataset read is still reserved");
  // The next slice's resume is a status read too: one read left is the dataset's reserve, so it is not made.
  const resumed = await inMission(m, v, () => runTool("source_with_apify", { ...jobsSearch(), resume_run_id: "r3" }, toolCtx(m)));
  assertEquals(resumed.error, "smoke_read_plan:reads_reserved");
  assertEquals(resumed.data as Record<string, unknown>, { run_id: "r3", pending: true, resumable: true, receipt: "unsettled", actor_id: "curious_coder/linkedin-jobs-scraper" });
  assertEquals(await reads(m), 4);
  const rows = await unsettled(m);
  assertEquals(rows.map((r) => r.provider_run_id), ["r3"], "the reconciliation lists the run whose charge was never settled");
});

Deno.test("read lifecycle: the FINAL run is bought with two reads; its receipt is deferred, held at the maximum, and blocks the next smoke", opts, async () => {
  const m = await fundedMission();
  // Two reads left for this run: what the second actor of the two-actor smoke finds.
  await sql`update public.discovery_smoke_authorizations set provider_polls = 2 where queue_id = ${m.queueId}`;
  const v = apify({ id: "r5", finishAfter: 1, usd: 0.004 });
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(res.ok, JSON.stringify(res).slice(0, 300));
  assertEquals((res.data as { receipt?: string }).receipt, "unsettled", "never reported as settled");
  assertEquals(v.kinds, ["status(wait=60)", "dataset"], "status, then the rows; no read is left for the receipt");
  assertEquals(await reads(m), 2, "the cap is the cap");
  const [p] = (await ops(m)).filter((o) => o.kind === "provider");
  assertEquals([p.committed_microusd, p.reported_microusd, p.report_source], ["60000", "4000", "apify_run(status).receipt"],
    "liability stays at the committed maximum; the preliminary figure is evidence, labelled as such");
  assertEquals((await unsettled(m)).map((r) => r.provider_run_id), ["r5"], "listed for reconciliation");
  assertEquals(await credits(m.ws), { balance: 9, reserved: 0, statuses: ["charged"] }, "the customer credit is charged, never refunded");
  // No new smoke until a person reconciles it.
  const next = await seedSmokeMission({ authorize: false });
  await assertRejects(() => authorizeSmoke(next.queueId, { keepPriorLiability: true }), Error, "unreconciled");
  // One read left: a run whose dataset could not be read is never bought.
  const n2 = await fundedMission();
  await sql`update public.discovery_smoke_authorizations set provider_polls = 1 where queue_id = ${n2.queueId}`;
  const v2 = apify({ id: "r6", finishAfter: 1 });
  const refused = await inMission(n2, v2, () => runTool("source_with_apify", jobsSearch(), toolCtx(n2)));
  assertEquals(refused.ok, false);
  assertEquals(v2.seen.filter((s) => s.method === "POST").length, 0, "nothing bought");
  assertEquals(await credits(n2.ws), { balance: 10, reserved: 0, statuses: ["not_charged"] }, "a definite non-start is not charged");
});

Deno.test("read lifecycle: the long poll is clamped to the time left; too little time buys nothing", opts, async () => {
  const m = await fundedMission();
  const v = apify({ id: "r4", finishAfter: 1, settleLeftMs: -1_000 }); // already settled when first seen
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)), { remainingMs: () => 90_000 });
  assert(res.ok, JSON.stringify(res).slice(0, 300));
  assertEquals(v.kinds, ["status(wait=40)", "dataset"], "90 s left: 40 s of waiting, the rest kept for the dataset and receipt; a settled status is the receipt");
  assertEquals(await reads(m), 2);
  const late = await fundedMission();
  const v2 = apify({ id: "r5", finishAfter: 1 });
  const refused = await inMission(late, v2, () => runTool("source_with_apify", jobsSearch(), toolCtx(late)), { remainingMs: () => 60_000 });
  assertEquals(refused.error, "apify_start_failed:409", "a definite non-start");
  const direct = await inMission(late, v2, () => fetch("https://api.apify.com/v2/acts/harvestapi~linkedin-company/runs?token=t",
    { method: "POST", body: JSON.stringify({ companies: ["https://www.linkedin.com/company/x"] }) }), { remainingMs: () => 60_000 });
  const why = (await direct.json()).error;
  assertEquals([why.decision, why.detail], ["read_plan", "no_time"], "refused by the read plan, not by a cap");
  assertEquals(v2.seen.length, 0, "a run whose lifecycle cannot fit in the time left is not bought");
});

// ── THE JOBS ACTORS' BILLED-RESULT BOUNDS ───────────────────────────────────

const HARVEST_JOBS = "apify:harvestapi~linkedin-job-search";
const harvestQuotes = () => syntheticQuotes({
  harvest_jobs: {
    allowed_kinds: ["provider"], allowed_actors: [HARVEST_JOBS], maximum_microusd: 5000, discovery_page: true,
    observed_at: ago(3_600_000), source: "synthetic contract control", liability_bound_ref: "tests/db-contract (not a vendor quote)",
    request_limits: {
      max_request_bytes: 4096, pin_query: { timeout: "120", memory: "256" },
      max_fields: { maxItems: 3 }, max_array_items: { jobTitles: 1, locations: 1, geoIds: 0 },
    },
  },
});
const HARVEST_START = "https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/runs?token=t";

Deno.test("jobs: more titles, locations or rows than one search of three is refused before purchase; the vendor cap never exceeds the quote", opts, async () => {
  const m = await fundedMission({ quotes: harvestQuotes(), actorLimits: { ...syntheticActorLimits, [HARVEST_JOBS]: 1 } });
  const v = fakeVendor(() => json(201, { data: { id: "h1", defaultDatasetId: "ds-h1", status: "RUNNING" } }));
  const ok = { jobTitles: ["Account Executive"], locations: ["United States"], maxItems: 3, postedLimit: "week" };
  for (const [why, body] of [
    ["two titles multiply the rows", { ...ok, jobTitles: ["Account Executive", "Sales Executive"] }],
    ["two locations multiply the rows", { ...ok, locations: ["United States", "Canada"] }],
    ["a second location filter", { ...ok, geoIds: ["103644278"] }],
    ["more rows per search", { ...ok, maxItems: 4 }],
    ["no row bound at all", { jobTitles: ok.jobTitles, locations: ok.locations, postedLimit: "week" }],
    ["a title that is not an array", { ...ok, jobTitles: "Account Executive" }],
  ] as Array<[string, unknown]>) {
    const r = await inMission(m, v, () => fetch(HARVEST_START, { method: "POST", body: JSON.stringify(body) }));
    const e = (await r.json()).error;
    assertEquals([r.status, e.decision], [409, "request_limits"], why);
  }
  assertEquals([v.seen.length, (await ops(m)).length], [0, 0], "none of them was sent or admitted");
  const sent = await inMission(m, v, () =>
    fetch(`${HARVEST_START}&maxTotalChargeUsd=1`, { method: "POST", body: JSON.stringify(ok) }));
  await sent.body?.cancel();
  assertEquals(sent.status, 201);
  assertEquals(v.seen.length, 1);
  assertEquals(v.seen[0].url.searchParams.get("maxTotalChargeUsd"), "0.005", "a larger caller cap is replaced by the authorized maximum");
});

Deno.test("jobs: the legacy LinkedIn jobs actor gets one URL, three per source, no `count`, in the smoke", opts, async () => {
  const m = await fundedMission();
  const v = apify({ id: "c1", finishAfter: 1, settleLeftMs: -1_000 });
  const urls = ["growth", "sales", "marketing"].map((k) => `https://www.linkedin.com/jobs/search/?keywords=${k}&position=1&pageNum=0`);
  const res = await inMission(m, v, () => runTool("source_with_apify", { ...jobsSearch(), input: { urls } }, toolCtx(m)));
  assert(res.ok, JSON.stringify(res).slice(0, 300));
  const [post] = v.seen.filter((s) => s.method === "POST");
  assertEquals(JSON.parse(post.body!), { urls: [urls[0]], limitPerSource: 3, splitByLocation: false, scrapeCompany: true },
    "three URLs would have been three billed searches; exactly one is sent");
  assertEquals(post.url.searchParams.get("maxTotalChargeUsd"), "0.06", "capped at the template's maximum");
});

Deno.test("models: a Terra template priced above the model allocation is never admitted", opts, async () => {
  const quotes = syntheticQuotes({
    terra: { allowed_kinds: ["model"], allowed_actors: ["openai:gpt-5.6-terra"], maximum_microusd: 113_536, observed_at: ago(3_600_000),
      source: "synthetic contract control", liability_bound_ref: "tests/db-contract (not a vendor quote)",
      request_limits: { max_request_bytes: 32_768, max_output_tokens: 4_000 } },
  });
  const m = await fundedMission({ quotes });
  const v = fakeVendor(() => json(200, { choices: [{ message: { content: "{}" } }] }));
  const r = await inMission(m, v, () => gptStructured({ purpose: "t", system: "s", user: "u", model: "gpt-5.6-terra", maxTokens: 500 }));
  assertEquals(r.ok, false);
  assertEquals([v.seen.length, (await ops(m)).length], [0, 0], "its maximum exceeds the $0.05 model allocation: refused, nothing sent");
});

Deno.test("read lifecycle: a replay of an uncertain start refused by the read plan keeps its credit HELD", opts, async () => {
  // SAF-001/002's rule holds for the read plan too: refusing a purchase that may
  // already exist is uncertain, never a refund (the gate decides, after `prior`).
  const m = await fundedMission();
  const v = fakeVendor((r) => r.method === "POST" ? json(503, { error: "upstream" }) : json(404, {}));
  const first = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(String(first.error).startsWith(APIFY_START_UNCERTAIN), String(first.error));
  assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, "held (#88)");
  const replay = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)), { remainingMs: () => 30_000 });
  assert(String(replay.error).startsWith(APIFY_START_UNCERTAIN), `refused by the read plan, still uncertain: ${replay.error}`);
  assertEquals(v.seen.filter((s) => s.method === "POST").length, 1, "not sent again");
  assertEquals(await credits(m.ws), { balance: 9, reserved: 1, statuses: ["reserved"] }, "still held, never refunded");
});

Deno.test("read lifecycle (Codex P2): a preliminary snapshot answered late is not taken as settled", opts, async () => {
  // The terminal status is snapshotted 150 ms before it settles, and arrives
  // 400 ms later. Judged against arrival it would look settled; judged against
  // when the request left (the snapshot's lower bound) it is not.
  const m = await fundedMission();
  const v = apify({ id: "r6", finishAfter: 1, settleLeftMs: 150, statusDelayMs: 400, usd: 0.004, finalUsd: 0.0045 });
  const res = await inMission(m, v, () => runTool("source_with_apify", jobsSearch(), toolCtx(m)));
  assert(res.ok, JSON.stringify(res).slice(0, 300));
  assertEquals(v.kinds, ["status(wait=60)", "receipt", "dataset"], "the settled receipt is still read");
  const [p] = (await ops(m)).filter((o) => o.kind === "provider");
  assertEquals([p.reported_microusd, p.report_source], ["4500", APIFY_SETTLED_SOURCE], "the settled figure, from the receipt read");
  assertEquals((await unsettled(m)).length, 0);
});
