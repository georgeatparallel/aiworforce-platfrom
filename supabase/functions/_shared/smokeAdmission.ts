// DURABLE SMOKE ADMISSION — the transport gate for ONE controlled Discovery
// mission. Opt-in: the worker installs it only when DISCOVERY_SMOKE_ADMISSION
// is set (and not "off"). Unset, nothing here runs and nothing changes.
//
// ── WHERE IT SITS, AND WHY THERE ────────────────────────────────────────────
//
// At `fetch`, in the worker process. Every model attempt, provider purchase,
// retry, fallback, status poll and dataset page is one physical request, and
// each one needs its own committed `admitted` answer from
// `admit_discovery_smoke` (supabase/migrations-held/20261015140000_…) before it
// is sent. A path nobody wired is not a gap: a request to a paid host that this
// file does not recognise, or that runs outside a bound mission, is refused.
//
// Requests to the project's own REST/Auth/Storage API pass through untouched.
// Everything else is classified:
//
//   free       — never; there is no allow-list beyond the project's own API
//   provider   — Apify run start, Firecrawl scrape/map/crawl
//   poll       — Apify run status, Apify dataset items, Firecrawl crawl status
//   model      — OpenAI chat completions, Anthropic messages
//   forbidden  — everything else (edge-function calls included: they would
//                spend outside this gate)
//
// ── WHAT A REFUSAL LOOKS LIKE ───────────────────────────────────────────────
//
// A synthetic HTTP 409 that no request reached. Every existing caller already
// reads a non-5xx 4xx as a DEFINITE "nothing started": the Apify start reports
// `apify_start_failed:409` (credit released, no uncertain spend), Firecrawl and
// the model transports report their own 409 codes and do not retry it. The body
// names the decision, so the poll loops can stop waiting (`isAdmissionRefusal`).
// The one exception: a replay of a purchase that may already exist answers 503
// (still unsent), so it stays UNCERTAIN everywhere — see `refusal`.
//
// ── THE PRICE IS NEVER THE WORKER'S ─────────────────────────────────────────
//
// The authorization pins a catalog of reviewed maximum-price templates. The
// gate finds the one template for this request's (kind, actor), applies its
// vendor-side caps (`pin_query`, `pin_body`), checks the FINAL request against
// its limits, and names the template; the database charges the template's
// maximum. No template, two templates, a missing output-token bound or a body
// larger than the bound: refused before any money moves.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  ADMISSION_GATE_MARK, ADMISSION_REFUSED_STATUS, ADMISSION_REFUSED_TYPE, APIFY_SETTLED_SOURCE, apifyRunSettled,
  isAdmissionRefusal, planSmokeStart, SMOKE_ADMISSION_ENV, SMOKE_APPROVED_ACTORS_MARK, SMOKE_READ_STATE_MARK,
  smokeAdmissionEnforced,
  type SmokeReadState,
} from "./smokeAdmissionRefusal.ts";

export { ADMISSION_REFUSED_STATUS, ADMISSION_REFUSED_TYPE, isAdmissionRefusal, SMOKE_ADMISSION_ENV, smokeAdmissionEnforced };

/** An admission RPC slower than this is a refusal, never a send. */
export const ADMISSION_RPC_TIMEOUT_MS = 10_000;


// ── CLASSIFICATION ───────────────────────────────────────────────────────────

export type OpKind = "provider" | "model" | "poll";

export type Classified =
  | { kind: "free" }
  | { kind: "forbidden"; reason: string }
  | { kind: "provider"; vendor: "apify" | "firecrawl"; actor: string; captures: "apify_run" | "firecrawl_crawl" | null }
  | { kind: "model"; vendor: "openai" | "anthropic"; actor: string; outputField: "max_tokens" | "max_completion_tokens" }
  | { kind: "poll"; vendor: "apify" | "firecrawl"; ref: { runId: string } | { datasetId: string } };

export interface PhysicalRequest {
  method: string;
  url: URL;
  /** Null for a request with no body; undefined when the body cannot be read as text. */
  body: string | null | undefined;
}

const APIFY = "api.apify.com";
const FIRECRAWL = "api.firecrawl.dev";
const OPENAI = "api.openai.com";
const ANTHROPIC = "api.anthropic.com";

function parseBody(body: string | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * What one physical request is. Pure. `ownApi` is the project's own origin
 * (SUPABASE_URL); only its REST, Auth and Storage paths are free.
 */
export function classifyRequest(req: PhysicalRequest, ownApi: URL | null): Classified {
  const { url } = req;
  const method = req.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (ownApi && url.origin === ownApi.origin) {
    return /^\/(rest|auth|storage)\/v1(\/|$)/.test(url.pathname)
      ? { kind: "free" }
      : { kind: "forbidden", reason: "own_api_path_not_allowed" };
  }
  if (url.protocol !== "https:") return { kind: "forbidden", reason: "not_https" };
  let m: RegExpExecArray | null;
  switch (url.hostname) {
    case APIFY:
      if (method === "POST" && (m = /^\/v2\/acts\/([^/]+)\/runs$/.exec(path))) {
        return { kind: "provider", vendor: "apify", actor: `apify:${decodeURIComponent(m[1]).replace("/", "~")}`, captures: "apify_run" };
      }
      if (method === "GET" && (m = /^\/v2\/actor-runs\/([^/]+)$/.exec(path))) {
        return { kind: "poll", vendor: "apify", ref: { runId: decodeURIComponent(m[1]) } };
      }
      if (method === "GET" && (m = /^\/v2\/datasets\/([^/]+)\/items$/.exec(path))) {
        return { kind: "poll", vendor: "apify", ref: { datasetId: decodeURIComponent(m[1]) } };
      }
      return { kind: "forbidden", reason: `apify_${method.toLowerCase()}_${path.split("/")[2] ?? "root"}` };
    case FIRECRAWL:
      if (method === "POST" && (m = /^\/v2\/(scrape|map|crawl)$/.exec(path))) {
        return { kind: "provider", vendor: "firecrawl", actor: `firecrawl:${m[1]}`, captures: m[1] === "crawl" ? "firecrawl_crawl" : null };
      }
      if (method === "GET" && (m = /^\/v2\/crawl\/([^/]+)$/.exec(path))) {
        return { kind: "poll", vendor: "firecrawl", ref: { runId: decodeURIComponent(m[1]) } };
      }
      return { kind: "forbidden", reason: "firecrawl_path_not_allowed" };
    case OPENAI: {
      if (method !== "POST" || path !== "/v1/chat/completions") return { kind: "forbidden", reason: "openai_path_not_allowed" };
      const b = parseBody(req.body);
      const model = typeof b?.model === "string" ? b.model : null;
      if (!model) return { kind: "forbidden", reason: "model_unnamed" };
      return { kind: "model", vendor: "openai", actor: `openai:${model}`,
        outputField: b && "max_completion_tokens" in b ? "max_completion_tokens" : "max_tokens" };
    }
    case ANTHROPIC: {
      if (method !== "POST" || path !== "/v1/messages") return { kind: "forbidden", reason: "anthropic_path_not_allowed" };
      const b = parseBody(req.body);
      const model = typeof b?.model === "string" ? b.model : null;
      if (!model) return { kind: "forbidden", reason: "model_unnamed" };
      return { kind: "model", vendor: "anthropic", actor: `anthropic:${model}`, outputField: "max_tokens" };
    }
    default:
      return { kind: "forbidden", reason: `host_not_allowed:${url.hostname}` };
  }
}

// ── TEMPLATES: THE REVIEWED MAXIMUM AND THE LIMITS THAT MAKE IT TRUE ─────────

export interface QuoteTemplate {
  allowed_kinds: string[];
  allowed_actors: string[];
  maximum_microusd: number;
  discovery_page?: boolean;
  source: string;
  liability_bound_ref: string;
  observed_at: string;
  request_limits: RequestLimits;
}

export interface RequestLimits {
  /** Query parameters set on the URL (vendor-side caps, e.g. Apify timeout/maxItems/maxTotalChargeUsd). */
  pin_query?: Record<string, string>;
  /** Top-level JSON body fields set before sending (e.g. Firecrawl proxy). */
  pin_body?: Record<string, unknown>;
  /** Reads templates: each actor's share of the shared poll cap (enforced by admit_discovery_smoke). */
  max_reads_per_actor?: Record<string, number>;
  /** The final body, in UTF-8 bytes. Required for every kind that has a body. */
  max_request_bytes?: number;
  /** Model kinds: the output-token field must be present and at most this. */
  max_output_tokens?: number;
  /** Top-level body fields that must be present numbers at most this. */
  max_fields?: Record<string, number>;
  /** Top-level body fields whose value (or each array element) must be one of these, compared as JSON. */
  allowed_values?: Record<string, unknown[]>;
  /**
   * Top-level body arrays that may hold at most this many entries; absent is
   * allowed, anything but an array is refused. For inputs a vendor bills per
   * entry: search URLs, job titles, locations (results = limit × entries).
   */
  max_array_items?: Record<string, number>;
}

export interface Authorization {
  id: string;
  queue_id: string;
  workspace_id: string;
  status: string;
  deadline_at: string;
  approved_quotes: Record<string, QuoteTemplate>;
  actor_limits: Record<string, number>;
  /** The read allowance (status, dataset, resume and receipt GETs together). */
  provider_polls?: number;
}

/** The ONE template for this (kind, actor). None or several: refused. */
export function templateFor(
  a: Pick<Authorization, "approved_quotes">, kind: OpKind, actor: string,
): { ok: true; id: string; template: QuoteTemplate } | { ok: false; reason: string } {
  const hits = Object.entries(a.approved_quotes ?? {}).filter(([, t]) =>
    Array.isArray(t?.allowed_kinds) && t.allowed_kinds.includes(kind) &&
    Array.isArray(t?.allowed_actors) && t.allowed_actors.includes(actor)
  );
  if (hits.length === 0) return { ok: false, reason: "unknown_quote" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous_quote" };
  return { ok: true, id: hits[0][0], template: hits[0][1] };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Apify's run-level charge ceiling query parameter. */
export const APIFY_CHARGE_CAP = "maxTotalChargeUsd";

/**
 * Apply a template's pins and check the FINAL request against its limits.
 * Pure. Returns the request to send, or why it may not be sent.
 */
export function boundRequest(
  req: PhysicalRequest, c: Exclude<Classified, { kind: "free" | "forbidden" }>, limits: RequestLimits | undefined,
  maximumMicrousd?: number,
): { ok: true; request: PhysicalRequest } | { ok: false; reason: string } {
  if (!limits || typeof limits !== "object") return { ok: false, reason: "no_request_limits" };
  const url = new URL(req.url.href);
  for (const [k, v] of Object.entries(limits.pin_query ?? {})) url.searchParams.set(k, String(v));
  // THE VENDOR'S OWN MONEY STOP. Apify's `maxTotalChargeUsd` caps a run's charge
  // across every pricing model (act-runs-post). Every Apify start carries one
  // no greater than the authorized maximum: a lower pinned or caller value is
  // kept; anything higher, absent or unreadable becomes the maximum itself.
  if (c.kind === "provider" && c.vendor === "apify" && typeof maximumMicrousd === "number") {
    const quote = maximumMicrousd / 1e6;
    const asked = Number(url.searchParams.get(APIFY_CHARGE_CAP) ?? NaN);
    url.searchParams.set(APIFY_CHARGE_CAP, String(Number.isFinite(asked) && asked >= 0 && asked < quote ? asked : quote));
  }
  let body = req.body;
  if (body === undefined) return { ok: false, reason: "unreadable_body" };
  const hasBody = body !== null && body !== "";
  // SAF-008. A purchase whose template names mandatory fields is checked even
  // without a body (as `{}`), so an absent or empty body is refused like `{}`.
  // Polls never carry the purchase's fields and are bounded by their parent.
  const mandatory = c.kind !== "poll" && Object.keys(limits.max_fields ?? {}).length > 0;
  if (hasBody || limits.pin_body || mandatory || limits.max_array_items) {
    const parsed = parseBody(hasBody ? body : "{}");
    if (!parsed) return { ok: false, reason: "body_not_json_object" };
    const pinned = { ...parsed, ...(limits.pin_body ?? {}) };
    if (limits.pin_body) body = JSON.stringify(pinned);
    for (const [k, max] of Object.entries(limits.max_fields ?? {})) {
      const v = pinned[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v > max) return { ok: false, reason: `field_unbounded:${k}` };
    }
    for (const [k, max] of Object.entries(limits.max_array_items ?? {})) {
      if (!(k in pinned)) continue;
      if (!Array.isArray(pinned[k]) || (pinned[k] as unknown[]).length > max) return { ok: false, reason: `array_unbounded:${k}` };
    }
    for (const [k, allowed] of Object.entries(limits.allowed_values ?? {})) {
      if (!(k in pinned)) continue;
      const vals = Array.isArray(pinned[k]) ? pinned[k] as unknown[] : [pinned[k]];
      if (!vals.every((v) => allowed.some((a) => sameJson(a, v)))) return { ok: false, reason: `value_not_allowed:${k}` };
    }
    if (c.kind === "model") {
      // R3. Request bytes bound input tokens only for TEXT. A remote image,
      // file, audio or tool call is charged for content those bytes never
      // contain, so anything but the audited text-only shape is refused.
      const textOnly = textOnlyModelRequest(c.vendor, pinned);
      if (textOnly) return { ok: false, reason: `not_text_only:${textOnly}` };
      const out = pinned[c.outputField];
      if (typeof limits.max_output_tokens !== "number") return { ok: false, reason: "no_output_bound" };
      if (typeof out !== "number" || !Number.isInteger(out) || out < 1 || out > limits.max_output_tokens) {
        return { ok: false, reason: "output_tokens_unbounded" };
      }
      // `n` choices multiply the output; anything but one is unbounded here.
      if ("n" in pinned && pinned.n !== 1) return { ok: false, reason: "multiple_choices" };
    }
  }
  if (typeof body === "string" && body.length > 0) {
    if (typeof limits.max_request_bytes !== "number") return { ok: false, reason: "no_size_bound" };
    if (new TextEncoder().encode(body).length > limits.max_request_bytes) return { ok: false, reason: "request_too_large" };
  } else if (c.kind === "model") {
    return { ok: false, reason: "model_request_without_body" };
  }
  return { ok: true, request: { method: req.method, url, body: body ?? null } };
}

// ── THE AUDITED TEXT-ONLY MODEL REQUEST ─────────────────────────────────────
//
// Exactly the fields our three model transports send (aiProvider,
// gptProvider/modelRequestBody, the strategist transport), and nothing that
// pulls in content or charges beyond the request's own bytes: no media or file
// parts, no tools, no web search, no audio, no streaming options, no logprobs.
// A field not listed here is refused, so a future option fails closed.
const OPENAI_FIELDS = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p",
  "response_format", "reasoning_effort", "seed", "stop", "n"]);
const ANTHROPIC_FIELDS = new Set(["model", "messages", "max_tokens", "system", "temperature", "top_p", "top_k",
  "stop_sequences"]);
const isPlainText = (v: unknown): boolean => typeof v === "string";
/** A content value: a string, or text parts only (`{type:"text", text}`). */
function textContent(v: unknown): boolean {
  if (isPlainText(v)) return true;
  return Array.isArray(v) && v.every((p) =>
    p && typeof p === "object" && !Array.isArray(p) &&
    Object.keys(p).every((k) => k === "type" || k === "text") &&
    (p as Record<string, unknown>).type === "text" && isPlainText((p as Record<string, unknown>).text)
  );
}

/** Why a model request is not the audited text-only shape, or null when it is. */
export function textOnlyModelRequest(vendor: "openai" | "anthropic", b: Record<string, unknown>): string | null {
  const allowed = vendor === "openai" ? OPENAI_FIELDS : ANTHROPIC_FIELDS;
  for (const k of Object.keys(b)) if (!allowed.has(k)) return `field:${k}`;
  const roles = vendor === "openai" ? ["system", "developer", "user", "assistant"] : ["user", "assistant"];
  // Absent messages carry no input at all (the vendor refuses such a request).
  if ("messages" in b && !Array.isArray(b.messages)) return "messages";
  for (const m of (b.messages ?? []) as unknown[]) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return "message";
    const msg = m as Record<string, unknown>;
    if (!Object.keys(msg).every((k) => k === "role" || k === "content" || (vendor === "openai" && k === "name"))) {
      return "message_field";
    }
    if (!roles.includes(String(msg.role))) return "message_role";
    if (!textContent(msg.content)) return "message_content";
  }
  if (vendor === "anthropic" && "system" in b && !textContent(b.system)) return "system";
  if (vendor === "openai" && "response_format" in b) {
    const rf = b.response_format as Record<string, unknown> | null;
    if (!rf || typeof rf !== "object" || !["text", "json_object", "json_schema"].includes(String(rf.type)) ||
      !Object.keys(rf).every((k) => k === "type" || k === "json_schema")) return "response_format";
  }
  if (vendor === "openai" && "reasoning_effort" in b && typeof b.reasoning_effort !== "string") return "reasoning_effort";
  return null;
}

/** sha256 hex of the request as sent, minus any credential in the query string. */
export async function payloadHash(req: PhysicalRequest): Promise<string> {
  const u = new URL(req.url.href);
  u.searchParams.delete("token");
  u.searchParams.sort();
  const text = `${req.method.toUpperCase()} ${u.host}${u.pathname}?${u.searchParams.toString()}\n${req.body ?? ""}`;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── THE DATABASE SIDE ────────────────────────────────────────────────────────

/** The two calls the gate makes; a supabase-js client satisfies it. */
export interface AdmissionDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): { select(cols: string): AdmissionFilter };
}
/** A supabase-js filter chain, as far as the gate uses it. */
export interface AdmissionFilter {
  eq(col: string, v: unknown): AdmissionFilter;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type AdmissionDecision =
  | { decision: "admitted"; operation_key: string; reservation_token: string; committed_microusd: number; deadline_at: string }
  | { decision: "adopt" | "uncertain"; operation_key: string; provider_run_id: string | null; provider_dataset_id: string | null }
  | { decision: string; [k: string]: unknown };

export interface AdmitArgs {
  queueId: string; workerId: string; taskId: string; generation: number;
  key: string; kind: OpKind; actor: string; templateId: string; payloadHash: string; parentKey?: string | null;
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error("admission_timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why an `admitted` answer cannot be trusted, or null when it can. Every field
 * the send depends on is checked: the reservation token, the operation it
 * names (it must be the one asked for), a finite non-negative commitment and a
 * finite deadline. A missing deadline once compared as `now >= NaN`, which is
 * false, and let the request through (Codex review R5).
 */
export function malformedAdmission(d: Record<string, unknown>, expectedKey: string): string | null {
  if (typeof d.reservation_token !== "string" || !UUID_RE.test(d.reservation_token)) return "reservation_token";
  if (d.operation_key !== expectedKey) return "operation_key";
  const c = d.committed_microusd;
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) return "committed_microusd";
  if (typeof d.deadline_at !== "string" || !Number.isFinite(Date.parse(d.deadline_at))) return "deadline_at";
  return null;
}

/** One admission. Any error, timeout or malformed answer is a refusal. */
export async function admitOperation(db: AdmissionDb, a: AdmitArgs, timeoutMs = ADMISSION_RPC_TIMEOUT_MS): Promise<AdmissionDecision> {
  try {
    const { data, error } = await withTimeout(db.rpc("admit_discovery_smoke", {
      p_queue: a.queueId, p_worker: a.workerId, p_task: a.taskId, p_generation: a.generation,
      p_key: a.key, p_kind: a.kind, p_actor: a.actor, p_template: a.templateId,
      p_payload_hash: a.payloadHash, p_parent_key: a.parentKey ?? null,
    }), timeoutMs);
    if (error) return { decision: "admission_unavailable", detail: error.message.slice(0, 160) };
    const d = data as { decision?: unknown } | null;
    if (!d || typeof d.decision !== "string") return { decision: "admission_unavailable", detail: "malformed_answer" };
    if (d.decision === "admitted") {
      const bad = malformedAdmission(d as Record<string, unknown>, a.key);
      if (bad) return { decision: "admission_unavailable", detail: `malformed_admission:${bad}` };
    }
    return d as AdmissionDecision;
  } catch (e) {
    return { decision: "admission_unavailable", detail: String(e).slice(0, 160) };
  }
}

export async function recordReceipt(db: AdmissionDb, r: {
  queueId: string; key: string; token: string; runId?: string | null; datasetId?: string | null;
  reportedMicrousd?: number | null; source?: string | null;
}): Promise<boolean> {
  try {
    const { data, error } = await withTimeout(db.rpc("record_discovery_smoke_receipt", {
      p_queue: r.queueId, p_key: r.key, p_token: r.token,
      p_run_id: r.runId ?? null, p_dataset_id: r.datasetId ?? null,
      p_reported_microusd: r.reportedMicrousd ?? null, p_source: r.source ?? null,
    }), ADMISSION_RPC_TIMEOUT_MS);
    return !error && data === true;
  } catch {
    return false;
  }
}

/** The queue row's authorization; null when there is none; "unavailable" when it could not be read. */
export async function loadAuthorization(db: AdmissionDb, queueId: string): Promise<Authorization | null | "unavailable"> {
  try {
    const { data, error } = await withTimeout(db.from("discovery_smoke_authorizations")
      .select("id, queue_id, workspace_id, status, deadline_at, approved_quotes, actor_limits, provider_polls")
      .eq("queue_id", queueId).maybeSingle(), ADMISSION_RPC_TIMEOUT_MS);
    if (error) return "unavailable";
    return (data as Authorization | null) ?? null;
  } catch {
    return "unavailable";
  }
}

/**
 * Was this exact purchase (actor + payload) already admitted under this
 * authorization? "yes" / "no", or "unknown" when the read failed. Decides how a
 * refusal of a PROVIDER request reads (Codex review R1): a refused attempt is
 * not proof that an earlier attempt bought nothing.
 */
export async function priorPurchase(
  db: AdmissionDb, authorizationId: string, actor: string, payloadHash: string,
): Promise<"yes" | "no" | "unknown"> {
  try {
    const { data, error } = await withTimeout(db.from("discovery_smoke_operations")
      .select("operation_key, kind")
      .eq("authorization_id", authorizationId).eq("actor", actor).eq("payload_hash", payloadHash)
      .eq("kind", "provider").maybeSingle(), ADMISSION_RPC_TIMEOUT_MS);
    if (error) return "unknown";
    return data ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

/** The provider operation a poll belongs to: by run id, or by dataset id. */
export async function findParent(
  db: AdmissionDb, authorizationId: string, ref: { runId: string } | { datasetId: string },
): Promise<{ operation_key: string; actor: string; reservation_token: string } | null> {
  const [col, v] = "runId" in ref ? ["provider_run_id", ref.runId] : ["provider_dataset_id", ref.datasetId];
  try {
    const { data, error } = await withTimeout(db.from("discovery_smoke_operations")
      .select("operation_key, actor, kind, reservation_token")
      .eq("authorization_id", authorizationId).eq(col, v).maybeSingle(), ADMISSION_RPC_TIMEOUT_MS);
    const row = data as { operation_key?: string; actor?: string; kind?: string; reservation_token?: string } | null;
    if (error || !row || row.kind !== "provider" || !row.operation_key || !row.actor || !row.reservation_token) return null;
    return { operation_key: row.operation_key, actor: row.actor, reservation_token: row.reservation_token };
  } catch {
    return null;
  }
}

// ── THE MISSION A REQUEST BELONGS TO ─────────────────────────────────────────

/**
 * Bound by the worker around ONE mission's handler call, so every request in
 * that call tree — however deep — is attributed to it. A request with no bound
 * mission (an API route, a stray timer) is refused.
 */
export interface MissionAdmissionContext {
  queueId: string;
  workerId: string;
  /** Set once run-agent reports the task it executes on (`onExecutionBound`). */
  taskId: string | null;
  /** That slice's generation (`tasks.checkpoint_version`). */
  generation: number | null;
  /** The worker's revocation: once aborted, nothing more is admitted. */
  signal?: AbortSignal;
  /** Loaded once found; the database stays the authority. */
  authorization?: Authorization | null;
  /** Set when the database said no more polls / stopped: refused locally from then on. */
  closedReason?: string | null;
  /** The slice's remaining time (the worker's deadline, wall clock included), for the smoke's read plan. */
  remainingMs?: () => number;
}

export const missionAdmission = new AsyncLocalStorage<MissionAdmissionContext>();

// ── REFUSALS ─────────────────────────────────────────────────────────────────

/**
 * Decisions that mean "this purchase may ALREADY exist": a replay of an
 * admitted operation. Nothing is sent, but the caller must read the outcome as
 * UNCERTAIN, not as a refusal, so the existing rules hold: an uncertain Apify
 * start keeps its credit HELD (creditSettlementFor, #88) and counts in the
 * mission's spend; reporting 409 here would release it as "never started".
 */
const PURCHASE_MAY_EXIST = new Set(["uncertain", "adopt"]);
export const ADMISSION_UNCERTAIN_STATUS = 503;

/**
 * A refusal response. `earlierPurchase` is the gate's own finding that an
 * earlier attempt may already have bought this purchase (R1).
 */
export function refusal(decision: string, detail?: unknown, earlierPurchase = false): Response {
  const purchaseMayExist = PURCHASE_MAY_EXIST.has(decision) || earlierPurchase;
  return new Response(JSON.stringify({ error: { type: ADMISSION_REFUSED_TYPE, decision, detail: detail ?? null, purchase_may_exist: purchaseMayExist, message: `mission admission refused: ${decision}` } }), {
    status: purchaseMayExist ? ADMISSION_UNCERTAIN_STATUS : ADMISSION_REFUSED_STATUS,
    headers: { "content-type": "application/json", "x-agentory-admission": "refused" },
  });
}

/** A redirect the runtime was told not to follow ("manual"). */
function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

/** Decisions after which nothing else in this mission can be admitted. */
const CLOSING = new Set(["stopped", "lost_ownership", "stale_generation", "identity_mismatch", "not_authorized"]);

// ── THE GATE ─────────────────────────────────────────────────────────────────

export interface AdmissionGateDeps {
  /** The real fetch, captured before the gate is installed. */
  baseFetch: typeof fetch;
  /** A service-role client whose own fetch is `baseFetch` (never the gate). */
  db: AdmissionDb;
  /** SUPABASE_URL: only its REST/Auth/Storage paths pass without admission. */
  ownApi: string | null;
  now?: () => number;
  log?: (msg: string, meta?: unknown) => void;
  newKey?: () => string;
}

async function readRequest(input: RequestInfo | URL, init?: RequestInit): Promise<PhysicalRequest> {
  if (input instanceof Request) {
    const method = init?.method ?? input.method;
    const raw = init?.body !== undefined ? init.body : (input.body ? await input.clone().text() : null);
    return { method, url: new URL(input.url), body: raw === null || typeof raw === "string" ? raw : undefined };
  }
  const url = new URL(input instanceof URL ? input.href : String(input));
  const raw = init?.body;
  return { method: init?.method ?? "GET", url, body: raw === undefined || raw === null ? null : typeof raw === "string" ? raw : undefined };
}

/**
 * A `fetch` that admits every billable request durably before sending it.
 * Install it as `globalThis.fetch` in the worker; every module that calls
 * `fetch` at call time goes through it.
 */
export function createAdmissionFetch(d: AdmissionGateDeps): typeof fetch {
  const now = d.now ?? (() => Date.now());
  const log = d.log ?? ((m: string, meta?: unknown) => console.log(m, meta ?? ""));
  const newKey = d.newKey ?? (() => crypto.randomUUID());
  const ownApi = d.ownApi ? new URL(d.ownApi) : null;

  /**
   * Reads left (database) and time left (slice and authorization); null where
   * unknown. With an actor that has an allocation, its reads left are the
   * smaller of the shared cap's and its own.
   */
  const readState = async (ctx: MissionAdmissionContext, auth: Authorization, actor?: string): Promise<SmokeReadState> => {
    const untilDeadline = Date.parse(auth.deadline_at) - now();
    const slice = ctx.remainingMs?.();
    const remainingMs = Number.isFinite(untilDeadline)
      ? Math.max(0, Math.min(untilDeadline, typeof slice === "number" && Number.isFinite(slice) ? slice : Infinity))
      : null;
    const used = await pollsUsed(d.db, auth.id);
    const cap = auth.provider_polls;
    let readsLeft = used === null || typeof cap !== "number" ? null : Math.max(0, cap - used);
    const share = actor ? readAllocation(auth, actor) : null;
    if (share !== null && readsLeft !== null) {
      const mine = await pollsUsed(d.db, auth.id, actor);
      readsLeft = mine === null ? null : Math.min(readsLeft, Math.max(0, share - mine));
    }
    return { readsLeft, remainingMs };
  };

  const gate = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let req: PhysicalRequest;
    try {
      req = await readRequest(input, init);
    } catch (e) {
      return refusal("unreadable_request", String(e).slice(0, 120));
    }
    const c = classifyRequest(req, ownApi);
    // R4. Never follow a redirect: the next hop would skip classification and
    // admission. The project's own API answers without one.
    if (c.kind === "free") {
      const res = await d.baseFetch(input, { ...(init ?? {}), redirect: "manual" });
      if (!isRedirect(res)) return res;
      await res.body?.cancel();
      log("[smoke-admission] refused", { decision: "redirect_refused", host: req.url.hostname, path: req.url.pathname });
      return refusal("redirect_refused", res.status);
    }
    const ctx = missionAdmission.getStore();
    // What is known about THIS purchase's identity, filled in as it is worked
    // out, so a refusal can say whether the same purchase may already exist.
    let authUnavailable = false;
    let actor: string | null = c.kind === "provider" || c.kind === "model" ? c.actor : null;
    // R1. Whether an EARLIER attempt may already have bought this purchase,
    // read before this attempt asks for admission (so its own admission, even
    // one whose answer is lost, never counts as "earlier").
    let prior: "yes" | "no" | "unknown" | null = null;
    const refuse = (decision: string, detail?: unknown) => {
      // A PROVIDER request refused now is not proof the same purchase was
      // never made before: it is reported uncertain whenever an earlier one
      // exists or could not be ruled out, so an earlier uncertain credit hold
      // is never refunded by a later refusal.
      const earlier = c.kind === "provider" && (authUnavailable || (prior !== null && prior !== "no"));
      log("[smoke-admission] refused", { decision, detail: detail ?? null, earlier_purchase: earlier, host: req.url.hostname, path: req.url.pathname, queue: ctx?.queueId ?? null });
      return refusal(decision, detail, earlier);
    };
    if (c.kind === "forbidden") return refuse("forbidden", c.reason);
    if (!ctx) return refuse("no_mission_context");
    // Cached once found; a missing or unreadable row is asked again next time.
    if (!ctx.authorization) {
      const loaded = await loadAuthorization(d.db, ctx.queueId);
      if (loaded === "unavailable") {
        authUnavailable = true;
        return refuse("authorization_unavailable");
      }
      ctx.authorization = loaded;
    }
    const auth = ctx.authorization;
    if (!auth) return refuse("not_authorized");

    // A poll belongs to a purchase this authorization admitted, or to nothing.
    let parent: { operation_key: string; actor: string; reservation_token: string } | null = null;
    if (c.kind === "poll") {
      parent = await findParent(d.db, auth.id, c.ref);
      if (!parent) return refuse("missing_parent");
      actor = parent.actor;
    }
    const tpl = templateFor(auth, c.kind, actor!);
    if (!tpl.ok) return refuse(tpl.reason, actor);
    const bounded = boundRequest(req, c, tpl.template.request_limits, tpl.template.maximum_microusd);
    if (!bounded.ok) return refuse("request_limits", bounded.reason);
    const final = bounded.request;
    const hash = await payloadHash(final);
    const key = c.kind === "provider" ? `provider:${actor}:${hash}` : `${c.kind}:${newKey()}`;
    if (c.kind === "provider") prior = await priorPurchase(d.db, auth.id, actor!, hash);

    // Local stops, checked once the purchase is identifiable so a refusal of a
    // replay still reads as uncertain.
    if (ctx.signal?.aborted) return refuse("revoked");
    if (ctx.closedReason) return refuse(ctx.closedReason, "closed");
    if (!ctx.taskId || typeof ctx.generation !== "number") return refuse("not_bound");
    // THE READ PLAN: an Apify run whose lifecycle cannot be read and settled is
    // not bought. Here, after `prior`, so a refused replay stays uncertain.
    if (c.kind === "provider" && c.vendor === "apify") {
      const plan = planSmokeStart(await readState(ctx, auth, actor!));
      if (!plan.ok) return refuse("read_plan", plan.reason);
    }

    const decision = await admitOperation(d.db, {
      queueId: ctx.queueId, workerId: ctx.workerId, taskId: ctx.taskId, generation: ctx.generation,
      key, kind: c.kind, actor: actor!, templateId: tpl.id, payloadHash: hash, parentKey: parent?.operation_key ?? null,
    });
    if (decision.decision !== "admitted") {
      if (CLOSING.has(decision.decision)) ctx.closedReason = decision.decision;
      return refuse(decision.decision, decision);
    }
    const admitted = decision as Extract<AdmissionDecision, { decision: "admitted" }>;
    // Rechecked AFTER admission, immediately before the send: revocation, a
    // mission call that ended while the admission was in flight (R6), and the
    // deadline. The slot stays consumed (conservative); the request is not made.
    if (ctx.signal?.aborted) return refuse("revoked_after_admission");
    if (ctx.closedReason) return refuse("closed_after_admission", ctx.closedReason);
    if (!(now() < Date.parse(admitted.deadline_at))) return refuse("deadline_after_admission");

    // Exactly the request that was bounded and hashed: its URL (with any
    // pinned caps) and its body. Headers and signal are the caller's.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("content-length");
    // When the request left: the vendor's snapshot is no older than this, so
    // judging "settled" against it never mistakes a preliminary figure.
    const sentAt = now();
    const res = await d.baseFetch(final.url.href, {
      method: final.method, headers, body: final.body ?? undefined, redirect: "manual",
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    });
    if (isRedirect(res)) {
      // Sent and admitted, but not followed: a provider request stays uncertain.
      await res.body?.cancel();
      log("[smoke-admission] refused", { decision: "redirect_refused", key: admitted.operation_key, status: res.status });
      return refusal("redirect_refused", res.status, c.kind === "provider");
    }
    log("[smoke-admission] sent", { kind: c.kind, actor, key: admitted.operation_key, committed_microusd: admitted.committed_microusd, status: res.status });
    await observe(d.db, ctx.queueId, c, res, admitted, parent, log, sentAt);
    return res;
  };
  // Lets the transports tell the smoke is active (smokeAdmissionActive).
  Object.defineProperty(gate, ADMISSION_GATE_MARK, { value: true });
  // The read plan's inputs (smokeReadState): reads left from the database, time
  // left from the slice and the authorization. Unknown is null, and the plan
  // spends nothing on an unknown. Reads only; it admits nothing.
  Object.defineProperty(gate, SMOKE_READ_STATE_MARK, {
    value: async (actor?: string): Promise<SmokeReadState> => {
      const ctx = missionAdmission.getStore();
      if (!ctx) return { readsLeft: null, remainingMs: null };
      if (!ctx.authorization) {
        const loaded = await loadAuthorization(d.db, ctx.queueId);
        if (loaded === "unavailable" || !loaded) return { readsLeft: null, remainingMs: null };
        ctx.authorization = loaded;
      }
      return await readState(ctx, ctx.authorization, actor);
    },
  });
  // The provider actors the authorization's catalog approves (read only).
  Object.defineProperty(gate, SMOKE_APPROVED_ACTORS_MARK, {
    value: async (): Promise<readonly string[] | null> => {
      const ctx = missionAdmission.getStore();
      if (!ctx) return null;
      if (!ctx.authorization) {
        const loaded = await loadAuthorization(d.db, ctx.queueId);
        if (loaded === "unavailable" || !loaded) return null;
        ctx.authorization = loaded;
      }
      const actors = Object.values(ctx.authorization.approved_quotes ?? {})
        .filter((t) => Array.isArray(t?.allowed_kinds) && t.allowed_kinds.includes("provider"))
        .flatMap((t) => (Array.isArray(t.allowed_actors) ? t.allowed_actors : []));
      return [...new Set(actors.map(String))];
    },
  });
  return gate;
}

/**
 * Reads (polls) this authorization has admitted, or null when that could not
 * be read. A supabase-js filter chain is itself awaitable (rows); a client
 * whose chain is not leaves the count unknown, which spends no read.
 */
async function pollsUsed(db: AdmissionDb, authorizationId: string, actor?: string): Promise<number | null> {
  try {
    let chain = db.from("discovery_smoke_operations").select("operation_key")
      .eq("authorization_id", authorizationId).eq("kind", "poll");
    if (actor) chain = chain.eq("actor", actor);
    const q = chain as unknown as Partial<PromiseLike<{ data: unknown; error: unknown }>>;
    if (typeof q.then !== "function") return null;
    const { data, error } = await withTimeout(q as PromiseLike<{ data: unknown; error: unknown }>, ADMISSION_RPC_TIMEOUT_MS);
    return error || !Array.isArray(data) ? null : data.length;
  } catch {
    return null;
  }
}

/** A reads template's allocation for this actor (`max_reads_per_actor`), or null when none is set. */
export function readAllocation(auth: Pick<Authorization, "approved_quotes">, actor: string): number | null {
  for (const t of Object.values(auth.approved_quotes ?? {})) {
    if (!Array.isArray(t?.allowed_kinds) || !t.allowed_kinds.includes("poll")) continue;
    if (!Array.isArray(t.allowed_actors) || !t.allowed_actors.includes(actor)) continue;
    const n = t.request_limits?.max_reads_per_actor?.[actor];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Durable evidence from a response: the run/dataset id a purchase created
 * (so a later poll can find its parent and a replay adopts instead of buying),
 * and any charge Apify reports for the run. Never blocks or alters the
 * response; a failed write leaves the operation `uncertain`, which buys nothing.
 */
async function observe(
  db: AdmissionDb, queueId: string, c: Classified, res: Response,
  admitted: { operation_key: string; reservation_token: string },
  parent: { operation_key: string; reservation_token: string } | null,
  log: (m: string, meta?: unknown) => void,
  /** When the request was sent (a lower bound on the vendor's snapshot time). */
  sentAt: number = Date.now(),
): Promise<void> {
  try {
    if (c.kind === "provider" && c.captures && res.ok) {
      const j = await res.clone().json().catch(() => null) as { id?: unknown; data?: Record<string, unknown> } | null;
      const run = (c.captures === "apify_run" ? j?.data : j) as Record<string, unknown> | null | undefined;
      const runId = typeof run?.id === "string" ? run.id : null;
      const datasetId = c.captures === "apify_run" && typeof j?.data?.defaultDatasetId === "string" ? j.data.defaultDatasetId : null;
      // R7. The start response can already carry the run's charges (a run that
      // finished at once); they are recorded with the ids in one write.
      const charge = c.captures === "apify_run" ? apifyCharge(run ?? null) : null;
      if (runId || charge !== null) {
        const ok = await recordReceipt(db, {
          queueId, key: admitted.operation_key, token: admitted.reservation_token, runId, datasetId,
          ...(charge !== null ? { reportedMicrousd: charge, source: "apify_run(start).receipt" } : {}),
        });
        if (!ok) log("[smoke-admission] start receipt NOT recorded; the purchase stays uncertain", { key: admitted.operation_key });
      }
    }
    if (c.kind === "poll" && c.vendor === "apify" && "runId" in c.ref && parent && res.ok) {
      const j = await res.clone().json().catch(() => null) as { data?: Record<string, unknown> } | null;
      const charge = apifyCharge(j?.data ?? null);
      if (charge !== null) {
        // SETTLED or not, recorded durably: the reconciliation lists every
        // Apify purchase whose figure is not `APIFY_SETTLED_SOURCE`.
        await recordReceipt(db, {
          queueId, key: parent.operation_key, token: parent.reservation_token,
          reportedMicrousd: charge,
          source: apifyRunSettled(j?.data ?? null, sentAt) ? APIFY_SETTLED_SOURCE : "apify_run(status).receipt",
        });
      }
    }
  } catch (e) {
    log("[smoke-admission] observation failed", String(e).slice(0, 160));
  }
}

/**
 * The run's charge in micro-dollars, by the repository's receipt rule: the
 * larger of Apify's settled usage total and its priced charged events, never
 * their sum (`budgetPolicy.receiptUsd` over `providerReceipts.apifyReceiptFromRun`).
 * Each report is a running total, and the database keeps the largest one, so a
 * start figure followed by later status figures is never counted twice.
 *
 * Self-contained on purpose (this module imports nothing it does not own); a
 * test pins it equal to those two functions so the rules cannot drift.
 */
export function apifyCharge(run: Record<string, unknown> | null): number | null {
  if (!run) return null;
  const money = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const vals: number[] = [];
  if (typeof run.usageTotalUsd === "number" && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0) {
    vals.push(run.usageTotalUsd);
  }
  const events = (run.pricingInfo as { pricingPerEvent?: { actorChargeEvents?: Record<string, { eventPriceUsd?: unknown }> } } | null)
    ?.pricingPerEvent?.actorChargeEvents;
  const counts = run.chargedEventCounts as Record<string, unknown> | null | undefined;
  if (events && typeof events === "object" && counts && typeof counts === "object") {
    const prices: Record<string, number> = {};
    for (const [name, ev] of Object.entries(events)) {
      const p = money(ev?.eventPriceUsd);
      if (p !== null) prices[name] = p;
    }
    if (Object.keys(prices).length) {
      let charged = 0;
      for (const [ev, n] of Object.entries(counts)) {
        if (typeof n === "number" && Number.isFinite(n) && prices[ev] !== undefined) charged += n * prices[ev];
      }
      if (Number.isFinite(charged) && charged >= 0) vals.push(charged);
    }
  }
  return vals.length ? Math.ceil(Math.max(...vals) * 1_000_000) : null;
}
