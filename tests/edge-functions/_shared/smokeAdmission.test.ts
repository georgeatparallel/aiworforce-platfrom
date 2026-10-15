// The smoke admission gate, offline: request classification, the template
// limits that make a price an upper bound, the refusal semantics every caller
// relies on, and fail-closed handling of a slow, broken or lying admission
// RPC. The database contract itself is proven on real Postgres + PostgREST in
// tests/db-contract/smokeAdmission*.contract.test.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  admitOperation, boundRequest, classifyRequest, createAdmissionFetch, missionAdmission, payloadHash, refusal,
  smokeAdmissionEnforced, templateFor, type AdmissionDb, type Classified, type PhysicalRequest, type QuoteTemplate,
} from "../../../supabase/functions/_shared/smokeAdmission.ts";
import { isAdmissionRefusal } from "../../../supabase/functions/_shared/smokeAdmissionRefusal.ts";

const OWN = new URL("https://proj.supabase.co");
const req = (method: string, url: string, body: string | null | undefined = null): PhysicalRequest =>
  ({ method, url: new URL(url), body });
const classify = (method: string, url: string, body: string | null = null) => classifyRequest(req(method, url, body), OWN);

Deno.test("enforcement: only omission or an explicit off disables it", () => {
  assertEquals(smokeAdmissionEnforced(undefined), false);
  assertEquals(smokeAdmissionEnforced("off"), false);
  assertEquals(smokeAdmissionEnforced(" OFF "), false);
  assertEquals(smokeAdmissionEnforced(""), false);
  for (const v of ["enforce", "on", "true", "of", "1"]) assertEquals(smokeAdmissionEnforced(v), true, v);
});

Deno.test("classify: the project's own REST/Auth/Storage are free; its functions and every other host are not", () => {
  assertEquals(classify("GET", "https://proj.supabase.co/rest/v1/tasks?id=eq.1").kind, "free");
  assertEquals(classify("POST", "https://proj.supabase.co/auth/v1/user").kind, "free");
  assertEquals(classify("POST", "https://proj.supabase.co/functions/v1/run-agent"),
    { kind: "forbidden", reason: "own_api_path_not_allowed" }, "an edge function would spend outside the gate");
  for (const u of ["https://api.resend.com/emails", "https://api.perplexity.ai/chat/completions",
    "https://ai.gateway.lovable.dev/v1/chat/completions", "https://example.com/", "http://api.openai.com/v1/chat/completions",
    "https://api.openai.com/v1/images/generations", "https://api.apify.com/v2/acts/a~b/runs/last",
    "https://api.apify.com/v2/actor-runs/r/abort", "https://api.firecrawl.dev/v2/extract"]) {
    assertEquals(classify("POST", u).kind, "forbidden", u);
  }
});

Deno.test("classify: purchases, polls and model attempts", () => {
  assertEquals(classify("POST", "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs?token=t"),
    { kind: "provider", vendor: "apify", actor: "apify:curious_coder~linkedin-jobs-scraper", captures: "apify_run" });
  assertEquals(classify("POST", "https://api.apify.com/v2/acts/curious_coder%2Flinkedin-jobs-scraper/runs").kind, "provider");
  assertEquals((classify("POST", "https://api.apify.com/v2/acts/curious_coder%2Flinkedin-jobs-scraper/runs") as { actor: string }).actor,
    "apify:curious_coder~linkedin-jobs-scraper", "one actor name however the path spells it");
  assertEquals(classify("GET", "https://api.apify.com/v2/actor-runs/r1?token=t"), { kind: "poll", vendor: "apify", ref: { runId: "r1" } });
  assertEquals(classify("GET", "https://api.apify.com/v2/datasets/d1/items?clean=true&limit=200"),
    { kind: "poll", vendor: "apify", ref: { datasetId: "d1" } });
  assertEquals((classify("POST", "https://api.firecrawl.dev/v2/scrape") as { actor: string }).actor, "firecrawl:scrape");
  assertEquals((classify("POST", "https://api.firecrawl.dev/v2/crawl") as { captures: string }).captures, "firecrawl_crawl");
  assertEquals(classify("GET", "https://api.firecrawl.dev/v2/crawl/j1"), { kind: "poll", vendor: "firecrawl", ref: { runId: "j1" } });
  assertEquals(classify("POST", "https://api.openai.com/v1/chat/completions", JSON.stringify({ model: "gpt-4.1-mini", max_tokens: 5 })),
    { kind: "model", vendor: "openai", actor: "openai:gpt-4.1-mini", outputField: "max_tokens" });
  assertEquals((classify("POST", "https://api.openai.com/v1/chat/completions",
    JSON.stringify({ model: "gpt-5.6-mini", max_completion_tokens: 5 })) as { outputField: string }).outputField, "max_completion_tokens");
  assertEquals(classify("POST", "https://api.anthropic.com/v1/messages", JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 9 })),
    { kind: "model", vendor: "anthropic", actor: "anthropic:claude-haiku-4-5", outputField: "max_tokens" });
  assertEquals(classify("POST", "https://api.anthropic.com/v1/messages", "{}"), { kind: "forbidden", reason: "model_unnamed" });
});

const model = classify("POST", "https://api.openai.com/v1/chat/completions", "{\"model\":\"m\"}") as Exclude<Classified, { kind: "free" | "forbidden" }>;
const apify = classify("POST", "https://api.apify.com/v2/acts/a~b/runs") as Exclude<Classified, { kind: "free" | "forbidden" }>;
const scrape = classify("POST", "https://api.firecrawl.dev/v2/scrape") as Exclude<Classified, { kind: "free" | "forbidden" }>;

Deno.test("limits: a model request needs a bounded output, one choice and a bounded size", () => {
  const lim = { max_request_bytes: 200, max_output_tokens: 100 };
  const body = (o: Record<string, unknown>) => JSON.stringify({ model: "m", messages: [], ...o });
  const at = (o: Record<string, unknown>) => boundRequest(req("POST", "https://api.openai.com/v1/chat/completions", body(o)), model, lim);
  assert(at({ max_tokens: 100 }).ok);
  assertEquals(at({}), { ok: false, reason: "output_tokens_unbounded" });
  assertEquals(at({ max_tokens: 101 }), { ok: false, reason: "output_tokens_unbounded" });
  assertEquals(at({ max_tokens: 0 }), { ok: false, reason: "output_tokens_unbounded" });
  assertEquals(at({ max_tokens: 50, n: 2 }), { ok: false, reason: "multiple_choices" });
  assertEquals(at({ max_tokens: 50, pad: "x".repeat(300) }), { ok: false, reason: "request_too_large" });
  assertEquals(boundRequest(req("POST", "https://api.openai.com/v1/chat/completions", body({ max_tokens: 5 })), model, { max_request_bytes: 999 }),
    { ok: false, reason: "no_output_bound" });
  assertEquals(boundRequest(req("POST", "https://api.openai.com/v1/chat/completions", body({ max_tokens: 5 })), model, { max_output_tokens: 9 }),
    { ok: false, reason: "no_size_bound" });
  assertEquals(boundRequest({ method: "POST", url: new URL("https://api.openai.com/v1/chat/completions"), body: undefined }, model, lim),
    { ok: false, reason: "unreadable_body" }, "a stream or form body cannot be bounded");
  assertEquals(boundRequest(req("POST", "https://api.openai.com/v1/chat/completions", body({ max_tokens: 5 })), model, undefined),
    { ok: false, reason: "no_request_limits" });
  // UTF-8 bytes, not string length.
  assertEquals(at({ max_tokens: 5, t: "é".repeat(80) }), { ok: false, reason: "request_too_large" });
});

Deno.test("limits: vendor-side caps are pinned onto the request that is sent and hashed", async () => {
  const r = boundRequest(req("POST", "https://api.apify.com/v2/acts/a~b/runs?token=T&maxItems=500", "{\"q\":1}"), apify,
    { max_request_bytes: 100, pin_query: { timeout: "120", maxItems: "50" } });
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.request.url.searchParams.get("maxItems"), "50", "a larger caller value is overridden, never kept");
  assertEquals(r.request.url.searchParams.get("timeout"), "120");
  assertEquals(r.request.url.searchParams.get("token"), "T");
  const f = boundRequest(req("POST", "https://api.firecrawl.dev/v2/scrape", "{\"url\":\"u\",\"formats\":[\"markdown\",\"json\"]}"), scrape,
    { max_request_bytes: 500, pin_body: { proxy: "basic" }, allowed_values: { formats: ["markdown", "summary"] } });
  assertEquals(f, { ok: false, reason: "value_not_allowed:formats" }, "a surcharged format is refused");
  const g = boundRequest(req("POST", "https://api.firecrawl.dev/v2/scrape", "{\"url\":\"u\",\"proxy\":\"stealth\"}"), scrape,
    { max_request_bytes: 500, pin_body: { proxy: "basic" } });
  assert(g.ok && JSON.parse(g.request.body!).proxy === "basic", "the pinned body wins");
  assertEquals(boundRequest(req("POST", "https://api.firecrawl.dev/v2/map", "{\"url\":\"u\"}"), scrape, { max_request_bytes: 99, max_fields: { limit: 120 } }),
    { ok: false, reason: "field_unbounded:limit" }, "a required bound that is absent is unbounded");
  // The token never reaches the digest; the pinned caps do.
  const h1 = await payloadHash(req("POST", "https://api.apify.com/v2/acts/a~b/runs?token=ONE&timeout=1", "{}"));
  const h2 = await payloadHash(req("POST", "https://api.apify.com/v2/acts/a~b/runs?timeout=1&token=TWO", "{}"));
  const h3 = await payloadHash(req("POST", "https://api.apify.com/v2/acts/a~b/runs?timeout=2&token=ONE", "{}"));
  assertEquals(h1, h2);
  assert(h1 !== h3);
  assert(/^[0-9a-f]{64}$/.test(h1));
});

Deno.test("templates: exactly one per kind and actor", () => {
  const t = (actors: string[], kinds = ["model"]) => ({ allowed_kinds: kinds, allowed_actors: actors } as unknown as QuoteTemplate);
  assertEquals(templateFor({ approved_quotes: { a: t(["x"]) } }, "model", "y"), { ok: false, reason: "unknown_quote" });
  assertEquals(templateFor({ approved_quotes: { a: t(["x"]), b: t(["x"]) } }, "model", "x"), { ok: false, reason: "ambiguous_quote" });
  assertEquals(templateFor({ approved_quotes: { a: t(["x"], ["provider"]) } }, "model", "x"), { ok: false, reason: "unknown_quote" });
  assertEquals((templateFor({ approved_quotes: { a: t(["x"]) } }, "model", "x") as { id: string }).id, "a");
});

Deno.test("refusals: 409 reads as a definite non-start; a purchase that may exist reads as uncertain (503)", async () => {
  const r = refusal("actor_limit");
  assertEquals(r.status, 409);
  assert(isAdmissionRefusal({ status: r.status, data: await r.json() }));
  for (const d of ["uncertain", "adopt"]) assertEquals(refusal(d).status, 503, d);
  assertEquals(isAdmissionRefusal({ status: 409, data: { error: "conflict" } }), false, "a vendor's own 409 is not ours");
});

// ── fail-closed RPC handling ────────────────────────────────────────────────

function fakeDb(rpc: (fn: string, args: Record<string, unknown>) => unknown, rows: Record<string, unknown> = {}): AdmissionDb {
  const sel = (table: string) => ({
    eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[`${table}:parent`] ?? null, error: null }) }),
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }),
  });
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const v = await rpc(fn, args);
      return v instanceof Error ? { data: null, error: { message: v.message } } : { data: v, error: null };
    },
    from: (table: string) => ({ select: () => sel(table) }),
  } as unknown as AdmissionDb;
}
const AUTH = {
  id: "auth-1", queue_id: "q", workspace_id: "w", status: "active", deadline_at: new Date(Date.now() + 60000).toISOString(),
  actor_limits: {},
  approved_quotes: { gpt: { allowed_kinds: ["model"], allowed_actors: ["openai:m"], maximum_microusd: 1, source: "s", liability_bound_ref: "r",
    observed_at: new Date().toISOString(), request_limits: { max_request_bytes: 1000, max_output_tokens: 10 } } },
};
const call = () => fetch("https://api.openai.com/v1/chat/completions",
  { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }) });

async function withGate(rpc: (fn: string, a: Record<string, unknown>) => unknown, over: Record<string, unknown> = {}, now?: () => number) {
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = createAdmissionFetch({
    baseFetch: (async (u: RequestInfo | URL) => { sent.push(String(u)); return new Response("{}"); }) as typeof fetch,
    db: fakeDb(rpc, { discovery_smoke_authorizations: AUTH }), ownApi: OWN.href, log: () => {}, ...(now ? { now } : {}),
  });
  try {
    const res = await missionAdmission.run({ queueId: "q", workerId: "w", taskId: "t", generation: 1, ...over }, call);
    const body = await res.json() as { error?: { decision?: string } };
    return { status: res.status, decision: body.error?.decision ?? null, sent };
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("gate: an RPC error, a malformed answer or a token-less admission sends nothing", async () => {
  for (const [why, answer] of [["error", new Error("boom")], ["null", null], ["no decision", { ok: true }],
    ["admitted without token", { decision: "admitted" }]] as const) {
    const r = await withGate(() => answer);
    assertEquals(r.status, 409, why);
    assertEquals(r.decision, "admission_unavailable", why);
    assertEquals(r.sent, [], why);
  }
});

Deno.test("gate: a slow RPC is a refusal, never a send", async () => {
  const slow = admitOperation(fakeDb(() => new Promise((res) => setTimeout(() => res({ decision: "admitted", reservation_token: "x" }), 200))),
    { queueId: "q", workerId: "w", taskId: "t", generation: 1, key: "k", kind: "model", actor: "a", templateId: "g", payloadHash: "0".repeat(64) }, 20);
  assertEquals((await slow).decision, "admission_unavailable");
  await new Promise((r) => setTimeout(r, 250));
});

Deno.test("gate: admitted, then rechecked immediately before sending", async () => {
  const ok = { decision: "admitted", operation_key: "k", reservation_token: "tok", committed_microusd: 1, deadline_at: AUTH.deadline_at };
  const sent = await withGate(() => ok);
  assertEquals(sent.sent.length, 1, "admitted and in time: sent once");
  const late = await withGate(() => ok, {}, () => Date.parse(AUTH.deadline_at) + 1);
  assertEquals([late.decision, late.sent.length], ["deadline_after_admission", 0]);
  const ac = new AbortController();
  const revoked = await withGate(() => { ac.abort(); return ok; }, { signal: ac.signal });
  assertEquals([revoked.decision, revoked.sent.length], ["revoked_after_admission", 0]);
});

Deno.test("gate: a closing decision stops every later request without asking again", async () => {
  let asked = 0;
  const ctx = { queueId: "q", workerId: "w", taskId: "t", generation: 1 };
  const real = globalThis.fetch;
  globalThis.fetch = createAdmissionFetch({
    baseFetch: (async () => new Response("{}")) as typeof fetch,
    db: fakeDb(() => { asked++; return { decision: "stopped" }; }, { discovery_smoke_authorizations: AUTH }), ownApi: OWN.href, log: () => {},
  });
  try {
    await missionAdmission.run(ctx, async () => {
      for (let i = 0; i < 3; i++) await (await call()).body?.cancel();
    });
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(asked, 1);
});

Deno.test("gate: no authorization row, no admission", async () => {
  const real = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = createAdmissionFetch({
    baseFetch: (async (u: RequestInfo | URL) => { sent.push(String(u)); return new Response("{}"); }) as typeof fetch,
    db: fakeDb(() => ({ decision: "admitted", reservation_token: "t" })), ownApi: OWN.href, log: () => {},
  });
  try {
    const r = await missionAdmission.run({ queueId: "q", workerId: "w", taskId: "t", generation: 1 }, call);
    assertEquals(((await r.json()) as { error: { decision: string } }).error.decision, "not_authorized");
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(sent, []);
});
