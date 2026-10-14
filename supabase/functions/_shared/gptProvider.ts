// THE LEAD WORKFLOW'S ONLY MODEL. GPT, with no fallback.
//
// ── WHY THIS IS NOT `aiProvider.ts` ──────────────────────────────────────────
//
// `aiProvider` is shared product infrastructure: pilot chat, orchestration,
// intent routing, workflow classification, Company Brain generation, the daily
// brief and the Workbench opener all call it, and it fans out across a Gemini
// gateway and Anthropic with automatic fallback between them. That fallback is
// correct for a chat reply — a slightly different model still answers the user.
//
// It is wrong for this workflow. Lead sourcing spends money on the strength of
// what the model decides: which Actors run, what JSON they receive, whether a
// company's evidence qualifies it. A silent degradation to a different model
// mid-run changes those decisions and leaves no trace in the result, and the
// user's bill is already paid by the time anyone notices.
//
// So the lead path imports this module and never `aiProvider`. GPT answers, or
// the stage fails and says so. A wrong actor selection is recoverable; an
// invisible one is not.
//
// ── AND WHY IT DOES NOT RETRY ACROSS MODELS ──────────────────────────────────
//
// `aiProvider` tries Gemini, then a second Gemini model, then Anthropic. On the
// migrated project `LOVABLE_API_KEY` is a placeholder, so every one of its calls
// currently burns two failed authentications before reaching a working provider.
// That is invisible latency against an edge-function wall clock. This module has
// one credential and one endpoint: if it fails, the caller learns immediately.
//
// PURE OF SECRETS. The key is read from the environment at call time and never
// returned, logged, or included in an error — an error path that echoes its own
// credential is how keys reach log aggregators.

export const GPT_PROVIDER_VERSION = "gpt-provider-v1" as const;

/**
 * The model this workflow runs on.
 *
 * Named here rather than passed in, because "which model decided this" must be
 * answerable from the code for a run that spent money, not from whatever a
 * caller happened to pass six frames up.
 *
 * THE REASONING TIER. Every stage where a wrong answer costs money or
 * misdirects the whole run.
 */
/**
 * LEGACY FALLBACK ONLY — no longer reachable from the lead flow.
 *
 * Every lead stage now resolves its model through `gptModelRouter`, which
 * answers Luna or Terra. `modelForTier` survives for a call site that passes no
 * route at all, and there are none left in the lead pipeline —
 * `lunaFirstRouting.test.ts` test 16 asserts that every routed stage lands on
 * the Luna/Terra ladder.
 *
 * Kept rather than deleted because a call site that forgets to route should get
 * a WORKING model and show up as gpt-4.1 in the telemetry, which is loud and
 * harmless. Deleting it would turn that mistake into a crash in production for
 * the sake of tidiness.
 */
export const GPT_MODEL = "gpt-4.1" as const;

/**
 * THE FAST TIER.
 *
 * Same provider, same JSON guarantees, a fraction of the cost. For work that is
 * high-volume and structurally easy: reading twenty-five company descriptions
 * and saying which ones plausibly match a mission, normalising a field,
 * classifying a title.
 */
export const GPT_FAST_MODEL = "gpt-4.1-mini" as const;

/**
 * WHICH KIND OF THINKING A CALL NEEDS.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every intelligence stage ran on `gpt-4.1`, because one constant named the
 * model and nothing distinguished the calls. Mission triage reads a batch of
 * twenty-five companies and answers "plausibly worth paying for?" — a
 * high-volume, low-stakes classification, and the single most frequent call the
 * pipeline makes. Interpreting an ambiguous mission, choosing a multi-actor
 * strategy or qualifying a company on cited evidence are none of those things.
 * Paying the same rate for both is not a safety property, it is an absence of a
 * decision.
 *
 * TWO TIERS, NOT A CONTINUUM. A knob with five settings invites tuning; a
 * binary invites a judgement about the work, which is the thing that actually
 * needs making. The rule:
 *
 *   reasoning  a wrong answer misdirects the run or spends money badly —
 *              mission interpretation, strategy, actor selection,
 *              qualification, ranking, re-planning
 *   fast       a wrong answer costs one row its ORDER and nothing else —
 *              triage, extraction, normalisation, classification
 *
 * THE DEFAULT IS `reasoning`. A caller that has not thought about which tier it
 * needs gets the one that cannot quietly degrade a decision; downgrading is
 * always explicit and always recorded.
 */
export type GptTier = "reasoning" | "fast";

export function modelForTier(tier: GptTier | undefined): string {
  return tier === "fast" ? GPT_FAST_MODEL : GPT_MODEL;
}

/** A JSON Schema the model must satisfy. Enforced by the API, not by hope. */
export interface GptSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface GptRequest {
  /** What this call is for. Appears in diagnostics; never sent verbatim. */
  purpose: string;
  system: string;
  user: string;
  /**
   * The output contract, when this caller has no validator of its own.
   *
   * OMIT IT ONLY when a downstream parser already owns the shape — see the
   * `response_format` note in `gptStructured`. Every call still returns a JSON
   * object either way; the question is only which layer defines its contents,
   * and there must be exactly one.
   */
  schema?: GptSchema;
  maxTokens?: number;
  /**
   * Defaults to 0. These are decisions, not drafts — the same request should
   * produce the same plan, and a run that varies for no reason is a run nobody
   * can debug.
   */
  temperature?: number;
  /**
   * Which model tier this call needs. Defaults to `reasoning` — see `GptTier`.
   *
   * A caller asking for `fast` is asserting that a wrong answer here cannot
   * misdirect the run.
   */
  tier?: GptTier;
  /**
   * The model the ROUTER chose. Overrides the tier lookup when present.
   *
   * A caller never writes a model id here; it passes `route.model` from
   * `gptModelRouter`. The tier fallback survives only for call sites that have
   * not yet been moved, and every one of them is a stage still resolving to the
   * gpt-4.1 pair — so a stage whose model is absent from a trace is a stage
   * nobody has routed.
   */
  model?: string;
  /**
   * WHY that tier, in the caller's own words.
   *
   * Persisted with the call. "Which model decided this, and who decided that it
   * was enough?" must be answerable from the task row — otherwise a cost
   * regression and a quality regression look identical in the telemetry.
   */
  routing_reason?: string;
  /**
   * The effort this call was routed at.
   *
   * SENT NOW, where the model accepts it. Phase 2 made the body a function of
   * the model — `buildChatCompletionsBody` emits `reasoning_effort` and
   * `max_completion_tokens` for a GPT-5 model and `temperature`/`max_tokens`
   * for gpt-4.1 — so this is a live parameter on the Luna path and telemetry
   * only on the legacy one. The builder decides which; no caller does.
   */
  reasoningEffort?: ReasoningEffort | null;
}

/**
 * Failure codes that mean THE PROVIDER did not answer, as opposed to the model
 * answering badly.
 *
 * The distinction is not cosmetic. A caller that gets a malformed plan has
 * something to say back to the model — "that step was refused, plan again" —
 * and a repair round is worth the tokens. A caller that got HTTP 429 has
 * nothing to say to anybody; sending the same payload again immediately is how
 * TEST run 9105aa67 turned a 4-second rate limit into a dead run.
 */
export const PROVIDER_FAILURE_CODES = [
  "no_api_key", "http_error", "transport_error",
  "model_budget_exhausted",
  /**
   * The balance is gone. A PROVIDER failure like the others, and the only one
   * that no amount of waiting, retrying or re-prompting can clear.
   *
   * It used to be reported as `http_error`. The quota case was detected
   * correctly — `bodyIsQuotaExhausted` has always been right — but the finding
   * only ever reached a log line and the `retryable` flag, while the CODE, the
   * one field callers branch on, still said `http_error`. So every layer above
   * saw a generic HTTP fault and had nothing to say about it.
   *
   * On 2026-08-21 that cost a day: the chat stopped answering, and diagnosing
   * why took a manual call to the OpenAI API to discover a fact the code had
   * already established and thrown away.
   */
  "quota_exhausted",
] as const;

export type GptFailureCode =
  | typeof PROVIDER_FAILURE_CODES[number]
  | "empty_response"
  | "unparseable_json"
  | "schema_refused";

export function isProviderFailure(code: GptFailureCode): boolean {
  return (PROVIDER_FAILURE_CODES as readonly string[]).includes(code);
}

export type GptResult<T> =
  | {
    ok: true; value: T; model: string; latency_ms: number;
    /** Token counts as OpenAI reported them, and what they cost. */
    telemetry?: ModelCallTelemetry;
  }
  | {
    ok: false;
    /** Why it failed, in a form a caller can branch on. */
    code: GptFailureCode;
    /** Safe to log and to persist. Never contains the key. */
    detail: string;
    latency_ms: number;
    /**
     * Would trying again plausibly succeed?
     *
     * True for the transient server-side statuses only — 429 and 5xx. A caller
     * that cannot wait can still refuse; what it must not do is report a rate
     * limit as though the model had decided something.
     */
    retryable: boolean;
    /** How many attempts were actually made. 1 unless a retry happened. */
    attempts: number;
  };

export interface GptDeps {
  /** Injected so tests exercise every branch without a network or a key. */
  fetch?: (url: string, init: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    /** Present on a real `Response`. Read for `Retry-After` only. */
    headers?: { get: (name: string) => string | null };
  }>;
  readEnv?: (key: string) => string | undefined;
  now?: () => number;
  log?: (msg: string, meta?: unknown) => void;
  /** Injected so a retry test does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where this call's telemetry goes, beyond the log.
   *
   * AN EXPLICIT SEAM, NOT A GLOBAL SINK. A module-level "current writer" would
   * be simpler to wire and would misattribute one request's model calls to
   * another's task whenever two runs share an isolate. Passed through `GptDeps`,
   * the attribution comes from the caller that already knows it.
   *
   * Optional, and its absence changes nothing: the log line is emitted either
   * way, so a call site that has no ledger behaves exactly as before.
   */
  onModelCall?: (t: ModelCallTelemetry, ok: boolean) => void;
  budget?: {
    check(): { allowed: boolean; exceeded: string | null };
    reserveAttempt?(model?: string): { allowed: boolean; exceeded: string | null };
    holdUncertainAttempt?(): void;
  };
}

import {
  readModelUsage, buildModelTelemetry, type ModelCallTelemetry,
} from "./modelCostModel.ts";
import {
  buildChatCompletionsBody, type ReasoningEffort,
} from "./modelRequestBody.ts";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/**
 * THE ENDPOINT, WHICH IS OPENAI UNLESS A LOOPBACK STUB SAYS OTHERWISE.
 *
 * Local development has no OpenAI key on purpose (see
 * `supabase/functions/.env.local`), and the execution planner is a model call,
 * so the whole lead pipeline stops at `no_api_key` and nothing downstream of
 * planning can be exercised at all. A stub on localhost answers it for free.
 *
 * THE OVERRIDE IS LOOPBACK-ONLY, and that is the entire security argument: an
 * env var that could point this function at an arbitrary host would be a way to
 * exfiltrate every prompt — including workspace data — to somebody else's
 * server, and a deployed function has no business talking to 127.0.0.1. So a
 * non-loopback value is IGNORED, loudly, rather than honoured.
 */
function resolveEndpoint(readEnv: (k: string) => string | undefined): string {
  const raw = readEnv("OPENAI_BASE_URL");
  if (!raw) return DEFAULT_ENDPOINT;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    console.warn("[gpt] OPENAI_BASE_URL is not a URL — using api.openai.com");
    return DEFAULT_ENDPOINT;
  }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost" && u.hostname !== "[::1]") {
    console.warn("[gpt] OPENAI_BASE_URL is not loopback — ignored, using api.openai.com");
    return DEFAULT_ENDPOINT;
  }
  return `${raw.replace(/\/+$/, "")}/chat/completions`;
}

// ── THE TRANSIENT-FAILURE POLICY ───────────────────────────────────────────
//
// TEST run 9105aa67 qualified 2 of 10 and elected to continue. The
// continuation slice asked the execution planner for a plan, got
//
//     HTTP 429 … TPM: Limit 30000, Used 15706, Requested 16508.
//                Please try again in 4.428s.
//
// re-sent the same ~16k-token payload 291ms later, got 429 again, and the run
// died 1.6 seconds in with `plan_not_a_list` — a message about the shape of an
// answer that was never received. OpenAI had said exactly how long to wait.
//
// ONE retry, and the count is a CONSTANT rather than a condition, so the worst
// case is two calls whatever happens inside. A rate limit that survives the
// provider's own advised wait is not going to yield to a third attempt in the
// same minute; it needs a smaller payload or a bigger quota, and both of those
// are somebody's decision, not a loop's.

/** Attempts beyond the first. A constant — see above. */
export const MAX_TRANSIENT_RETRIES = 1;
/** Longer than this and the caller's own deadline is the better authority. */
export const MAX_RETRY_WAIT_MS = 8000;
/** Used when the provider says "retry" without saying when. */
export const DEFAULT_RETRY_WAIT_MS = 1000;

/**
 * An exhausted balance wearing a rate limit's status code.
 *
 * OpenAI returns HTTP 429 for two situations that could not be less alike:
 *
 *   "Rate limit reached … Please try again in 4.428s"     — transient
 *   "You have no credits remaining. Add credits to        — permanent
 *    continue using the API." (insufficient_quota)
 *
 * TEST 2026-08-21 16:34: the account ran out of credits and every chat message
 * stopped being answered. The retry added this morning treated it as a hiccup
 * and waited a second before asking again, twice per compiler attempt, four
 * calls per message — for a condition that cannot resolve without somebody
 * topping up an account.
 *
 * Waiting is not merely useless here, it is misleading: it makes a billing
 * problem look like a slow provider.
 */
function bodyIsQuotaExhausted(body: string): boolean {
  return /insufficient_quota|credit_balance_exhausted|no credits remaining|billing_hard_limit/i
    .test(body);
}

/** 429 and the 5xx family. Everything else is a decision, not a hiccup. */
function statusIsTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * How long the provider asked us to wait, in ms, or null if it did not say.
 *
 * `Retry-After` first, because it is the standard header and it is
 * authoritative. OpenAI does not always send it on a TPM rejection — the wait
 * appears only in the message body — so the body is read as a fallback. Both
 * are provider-supplied numbers; neither is a guess of ours.
 */
export function retryDelayMs(
  headers: { get: (name: string) => string | null } | undefined,
  body: string,
): number | null {
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  const stated = /try again in ([0-9]+(?:\.[0-9]+)?)\s*(ms|s)\b/i.exec(body);
  if (stated) {
    const value = Number(stated[1]);
    if (Number.isFinite(value) && value >= 0) {
      return Math.round(stated[2].toLowerCase() === "ms" ? value : value * 1000);
    }
  }
  return null;
}

/**
 * Strip anything credential-shaped out of text that will be persisted.
 *
 * NOT PARANOIA — a test caught this leaking. Two paths carry provider text into
 * a stored result: an HTTP error body and a transport error string. Neither is
 * ours, both are echoed, and an auth failure is exactly the case where a
 * provider is most likely to quote the credential it rejected.
 *
 * The known key is removed by value, so nothing depends on guessing its shape;
 * the pattern sweep then catches a DIFFERENT key that might appear in the same
 * text — a key from another service, or one the provider quoted back.
 */
function redact(text: string, key: string): string {
  let out = text;
  if (key) out = out.split(key).join("[redacted]");
  // Any OpenAI-style token, whoever it belongs to.
  return out.replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "[redacted]");
}

/**
 * Ask GPT for one typed object.
 *
 * NEVER THROWS. Every failure is a value, because the callers are pipeline
 * stages that must decide whether to fall back to a deterministic plan, and an
 * exception thrown through them would abandon a run that has already spent
 * money on discovery.
 */
export async function gptStructured<T>(
  req: GptRequest, deps: GptDeps = {},
): Promise<GptResult<T>> {
  const readEnv = deps.readEnv ?? ((k: string) => Deno.env.get(k));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const started = now();
  const elapsed = () => now() - started;

  // THE TIER IS RESOLVED ONCE, HERE, and every subsequent mention of "the
  // model" in this call refers to it — the request body, the success log, the
  // returned result and the diagnostics. A second place that re-derives it is a
  // second place that can disagree about what actually ran.
  // THE ROUTER'S CHOICE, or the tier fallback for a stage not yet moved.
  // Resolved ONCE, here, and every subsequent mention of "the model" in this
  // call refers to it — the request body, the success log, the returned result
  // and the diagnostics. A second place that re-derives it is a second place
  // that can disagree about what actually ran.
  const model = req.model ?? modelForTier(req.tier);

  const key = readEnv("OPENAI_API_KEY");
  if (!key) {
    // NOT A DEGRADATION. The caller decides what to do without a model; this
    // module will not quietly answer with a different one.
    return {
      ok: false, code: "no_api_key", detail: "OPENAI_API_KEY is not set",
      latency_ms: elapsed(), retryable: false, attempts: 0,
    };
  }

  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) =>
    fetch(url, init) as unknown as Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers?: { get: (name: string) => string | null };
    }>);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let raw: string;
  let attempts = 0;
  // ONE REQUEST BODY, BUILT ONCE. A retry must send exactly what was rejected;
  // rebuilding it would make the second attempt a different call.
  // ── THE BODY IS A FUNCTION OF THE MODEL, NOT OF THIS FILE ─────────────
  //
  // This built the gpt-4.1 shape by hand — `temperature`, `max_tokens` — which
  // the GPT-5 models reject outright. That is why mission compilation,
  // discovery selection and execution planning could never be pointed at
  // `gpt-5.6-*`: the wall was in the request body, and nothing said so.
  //
  // `buildChatCompletionsBody` decides the shape from the model id, so this
  // transport can now reach either family. No model and no effort changes
  // here — see `reasoningEffort` on the request.
  const requestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(buildChatCompletionsBody({
      model,
      systemPrompt: req.system,
      userMessage: req.user,
      maxOutputTokens: req.maxTokens ?? null,
      temperature: req.temperature ?? null,
      // Carried through at last. On a gpt-4.1 model the builder omits it, so
      // this is inert until routing actually moves a stage to GPT-5.
      reasoningEffort: (req.reasoningEffort as ReasoningEffort | null | undefined) ?? null,
      schema: req.schema ?? null,
    })),
  } satisfies RequestInit;

  // BOUNDED RETRY, NOT A LOOP. The bound is a constant, so the worst case is
  // two calls whatever the provider does — see MAX_TRANSIENT_RETRIES.
  let failure: Extract<GptResult<T>, { ok: false }> | null = null;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    const admission = deps.budget?.reserveAttempt?.(model) ?? deps.budget?.check();
    if (admission && !admission.allowed) {
      failure = { ok: false, code: "model_budget_exhausted", detail: `model attempt refused (${admission.exceeded})`, latency_ms: elapsed(), retryable: false, attempts };
      if (attempts === 0) return failure;
      break;
    }
    attempts = attempt + 1;
    let transientWaitMs: number | null = null;
    try {
      const res = await doFetch(resolveEndpoint(readEnv), requestInit);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // A 429 that says the balance is gone is not a rate limit. Retrying it
        // burns the caller's clock on a condition only a human can clear.
        const quotaExhausted = bodyIsQuotaExhausted(body);
        const transient = statusIsTransient(res.status) && !quotaExhausted;
        // The status and a bounded excerpt only. A provider error body can echo
        // request content, and this string is persisted into task results.
        failure = {
          ok: false,
          // NAMED, NOT BURIED. The distinction already existed one line above
          // and only reached `retryable`; a caller cannot branch on a boolean
          // that says "do not retry" without knowing WHY not.
          code: quotaExhausted ? "quota_exhausted" : "http_error",
          detail: redact(`OpenAI returned HTTP ${res.status}: ${body.slice(0, 300)}`, key),
          latency_ms: elapsed(), retryable: transient, attempts,
        };
        if (quotaExhausted) {
          // SAID OUT LOUD, because it is the one provider failure a person has
          // to act on. The alternative is what actually happened: four silent
          // retries and a chat that answers nothing.
          log("gpt_quota_exhausted", {
            purpose: req.purpose, model,
            detail: redact(body.slice(0, 200), key),
          });
        }
        // WAIT AS LONG AS THE PROVIDER ASKED, AND NO LONGER. Beyond the cap the
        // caller's own deadline is the better authority, and a run that sits
        // out a 60-second rate limit has spent its slice on nothing.
        const advised = transient ? retryDelayMs(res.headers, body) : null;
        const wait = advised ?? (transient ? DEFAULT_RETRY_WAIT_MS : null);
        transientWaitMs = wait != null && wait <= MAX_RETRY_WAIT_MS ? wait : null;
      } else {
        raw = await res.text();
        failure = null;
        break;
      }
    } catch (e) {
      // A THROWN fetch is a transport fault: a reset connection, a DNS blip, an
      // aborted socket. Transient by nature, and retried on the same terms.
      failure = {
        ok: false, code: "transport_error",
        detail: redact(String(e).slice(0, 300), key),
        latency_ms: elapsed(), retryable: true, attempts,
      };
      transientWaitMs = DEFAULT_RETRY_WAIT_MS;
    }

    deps.budget?.holdUncertainAttempt?.();
    if (transientWaitMs == null || attempt === MAX_TRANSIENT_RETRIES) break;
    log("gpt_transient_retry", {
      purpose: req.purpose, model, attempt: attempts,
      code: failure.code, wait_ms: transientWaitMs,
      detail: failure.detail.slice(0, 160),
    });
    await sleep(transientWaitMs);
  }
  if (failure) {
    // A FAILED CALL IS STILL A CALL THAT HAPPENED.
    //
    // Recording only successes makes an outage look like a quiet period — which
    // is exactly how 2026-08-21 read from the outside. There is no usage to
    // report (nothing parsed a body), so `priceModelCall` grades the cost
    // `unknown` rather than claiming a priced zero.
    const failTelemetry = buildModelTelemetry({
      role: req.purpose,
      model,
      reasoning_effort: req.reasoningEffort ?? null,
      usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null },
      latency_ms: elapsed(),
      fallback_reason: failure.code,
    });
    log("gpt_call_telemetry", failTelemetry);
    deps.onModelCall?.(failTelemetry, false);
    return failure;
  }
  raw = raw!;

  // ── WHAT IT COST, READ OFF THE SAME BODY ────────────────────────────────
  //
  // `usage` was never parsed on either transport, so no model spend of any kind
  // was recorded and the routing question could not be settled by measurement.
  // Read before the content, because a response that fails to parse below still
  // consumed tokens and was still billed.
  let envelope: unknown = null;
  try { envelope = JSON.parse(raw); } catch { /* handled below */ }
  const usage = readModelUsage(envelope);
  const telemetry = buildModelTelemetry({
    role: req.purpose,
    model,
    // gpt-4.1 takes no effort parameter; the GPT-5 models require one. Null
    // means "not applicable", never "default".
    reasoning_effort: req.reasoningEffort ?? null,
    usage,
    latency_ms: elapsed(),
  });
  log("gpt_call_telemetry", telemetry);
  deps.onModelCall?.(telemetry, true);

  let content: string | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string; refusal?: string | null } }>;
    };
    const choice = parsed.choices?.[0]?.message;
    // A REFUSAL IS NOT AN EMPTY ANSWER. The model declining is a distinct
    // outcome from it failing, and a caller may reasonably treat them
    // differently — one is worth retrying with a different prompt, the other
    // is not.
    if (choice?.refusal) {
      return {
        ok: false, code: "schema_refused",
        detail: redact(`the model refused: ${String(choice.refusal).slice(0, 200)}`, key),
        latency_ms: elapsed(), retryable: false, attempts,
      };
    }
    content = choice?.content ?? undefined;
  } catch {
    return {
      ok: false, code: "unparseable_json", detail: "the API envelope was not JSON",
      latency_ms: elapsed(), retryable: false, attempts,
    };
  }

  if (!content || !content.trim()) {
    return {
      ok: false, code: "empty_response", detail: "the model returned no content",
      latency_ms: elapsed(), retryable: false, attempts,
    };
  }

  try {
    const value = JSON.parse(content) as T;
    log("gpt_call_ok", {
      purpose: req.purpose, model, tier: req.tier ?? "reasoning",
      routing_reason: req.routing_reason ?? null, latency_ms: elapsed(),
    });
    return { ok: true, value, model, latency_ms: elapsed(), telemetry };
  } catch {
    // `strict` should make this unreachable. It is handled anyway, because
    // "unreachable" is a claim about a provider we do not control.
    return {
      ok: false, code: "unparseable_json",
      detail: "the content field was not valid JSON despite a strict schema",
      latency_ms: elapsed(), retryable: false, attempts,
    };
  }
}

/** Is the lead workflow's model available at all? For preflight, not for routing. */
export function gptAvailable(readEnv: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return !!readEnv("OPENAI_API_KEY");
}

/**
 * Compact record of one call, for the execution state. Carries no payload.
 *
 * `tier` and `routing_reason` are recorded alongside the model because a cost
 * regression and a quality regression are indistinguishable without them: both
 * show up as "the answers got worse" or "the bill went up", and only the
 * routing decision says which one someone chose.
 *
 * A FAILED call still reports the tier it was ROUTED to, so a stage that failed
 * on the fast model is not later mistaken for one that never had a tier.
 */
export function gptDiagnostics<T>(
  purpose: string, r: GptResult<T>, routing?: { tier?: GptTier; reason?: string },
): Record<string, unknown> {
  const tier: GptTier = routing?.tier ?? "reasoning";
  return {
    purpose,
    provider: "openai",
    model: r.ok ? r.model : modelForTier(tier),
    tier,
    routing_reason: routing?.reason ?? null,
    ok: r.ok,
    latency_ms: r.latency_ms,
    ...(r.ok ? {} : { failure_code: r.code, detail: r.detail }),
  };
}
