// Shared AI provider adapter. Lovable AI Gateway is the default brain;
// Anthropic is an optional advanced/fallback provider used only when
// ANTHROPIC_API_KEY is set.
//
// Used by: pilot-chat, orchestrate, run-agent.

export type ProviderName = "anthropic" | "openai";
export type TaskType =
  | "pilot_chat"
  | "orchestration_plan"
  | "agent_execution"
  | "tool_input_planning"
  // COMPANY BRAIN. These were being PASSED already, by `setup-company-brain`,
  // without being members — so `DEFAULT_MODELS[opts.taskType]` returned
  // `undefined` and the first provider attempt went out with no model at all.
  // Lovable rejected it, and the call quietly succeeded on the alt-model
  // fallback: a wasted round trip and an unasked-for model on every Company
  // Brain request, invisible because the end result still arrived.
  | "company_brain_analyze"
  | "company_brain_followups"
  | "helper";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOpts {
  taskType: TaskType;
  messages: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  preferredProvider?: ProviderName;
  agentSlug?: string;
  functionName?: string;
  workspaceId?: string;
  // when true, request JSON-shaped output (best-effort)
  jsonMode?: boolean;
  /**
   * WHERE THIS CALL'S COST GOES.
   *
   * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
   *
   * `lead_model_calls` held 256 rows, 255 of them the lead engine's and one
   * from a mission compilation. Every other model call this function makes —
   * every chat turn, every Company Brain analysis, every orchestration plan —
   * went to `logProviderCall`, which writes an `activity_feed` row carrying no
   * token counts and no cost at all. So chat spend was not merely uncapped, it
   * was unrecorded, and `modelSpendCeiling` summing that table would have read
   * $0.00 for chat for ever and called it a clean bill.
   *
   * The SAME seam `gptStrategistModel` already uses, so one `ModelCallCollector`
   * drains both. Synchronous and unable to fail, because nothing on a paid path
   * should be slowed or broken by bookkeeping — collect now, write later.
   *
   * Optional: a caller that does not pass it is unchanged.
   */
  onModelCall?: (telemetry: ModelCallTelemetry, ok: boolean) => void;
  /**
   * LAYER 2. Consulted before EVERY attempt, not once per call.
   *
   * `generateText` walks a fallback chain — Lovable's default model, then an
   * alternate family, then Anthropic. Checking a budget once at the top would
   * let an exhausted run keep spending simply by falling through to the next
   * model, which is the bypass this ordering exists to close.
   *
   * Bounds UNPRICED calls, because those are the ones the dollar ceiling in
   * `modelSpendCeiling` cannot see. Omitted, nothing is bounded and every
   * existing caller behaves exactly as before.
   */
  budget?: {
    check(): { allowed: boolean; exceeded: string | null };
    reserveAttempt?(model?: string): { allowed: boolean; exceeded: string | null };
  };
}

export interface GenerateResult {
  ok: boolean;
  content: string;
  json?: unknown;
  provider: ProviderName | "none";
  model: string;
  usage?: unknown;
  error?: string;
  errorCode?: string;
  latencyMs: number;
  /** True when the task ran on its declared fallback rather than its own model. */
  degraded?: boolean;
  /** The model the task intended, whatever actually ran. */
  intendedModel?: string;
}

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
import {
  readModelUsage, buildModelTelemetry, type ModelCallTelemetry,
} from "./modelCostModel.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// `Record<TaskType, string>` on purpose: a new task type cannot be added
// without choosing a model for it, which is what would have caught the two
// below before they reached production.
// ── ONE DELIBERATE MODEL PER TASK, AND NO SILENT DEMOTION ───────────────────
//
// This map used to point every task at `google/gemini-3-flash-preview` through
// the Lovable gateway, with `helper` on a cheaper Gemini. That gateway needs
// `LOVABLE_API_KEY`, which is not set in the environment Agentory actually runs
// in — so every attempt in the chain was skipped and all seven tasks fell
// through to one hardcoded Anthropic helper model. Pilot chat, orchestration,
// agent execution, tool-input planning and both Company Brain tasks were
// running on a helper-grade model, silently, because of a missing credential.
// Nothing reported it: `ok: true` came back and the model name was in a log
// nobody reads.
//
// So the Gemini routing is gone rather than revived. Agentory holds its own
// OpenAI and Anthropic credentials and its lead pipeline already routes OpenAI
// directly (`gptModelRouter`); a third-party reseller gateway in front of the
// same two vendors is a dependency without a job.
//
// Each task now names the model it INTENDS, and `fallback` says what may
// happen when that model cannot run. `none` means the call fails loudly.
export type ModelVendor = "anthropic" | "openai";

export interface TaskModelPolicy {
  /** The model this task is meant to run on. */
  model: string;
  vendor: ModelVendor;
  /**
   * What may substitute when `vendor`'s credential is absent or the call fails.
   * `null` = nothing may: the task fails with `no_provider_for_task` rather
   * than quietly running somewhere else.
   */
  fallback: { model: string; vendor: ModelVendor } | null;
  /** Why this tier — read by a human deciding whether to change it. */
  rationale: string;
}

const HAIKU = "claude-haiku-4-5-20251001";

export const TASK_MODELS: Record<TaskType, TaskModelPolicy> = {
  pilot_chat: {
    model: HAIKU, vendor: "anthropic", fallback: null,
    rationale: "user-facing conversation; a substitute would change the product's voice mid-session",
  },
  orchestration_plan: {
    model: HAIKU, vendor: "anthropic", fallback: null,
    rationale: "decides what work runs; a demoted planner spends money on a worse plan",
  },
  agent_execution: {
    model: HAIKU, vendor: "anthropic", fallback: null,
    rationale: "produces the work the user reads",
  },
  tool_input_planning: {
    model: HAIKU, vendor: "anthropic",
    fallback: { model: "gpt-4.1-mini", vendor: "openai" },
    rationale: "structured actor input; a second vendor is acceptable because the output is validated against the actor contract",
  },
  company_brain_analyze: {
    model: HAIKU, vendor: "anthropic", fallback: null,
    rationale: "writes the Brain every later decision reads",
  },
  company_brain_followups: {
    model: HAIKU, vendor: "anthropic", fallback: null,
    rationale: "same source of truth as the analyze pass",
  },
  helper: {
    model: HAIKU, vendor: "anthropic",
    fallback: { model: "gpt-4.1-mini", vendor: "openai" },
    rationale: "short mechanical completions; either vendor is fine",
  },
};

const ANTHROPIC_MODEL = HAIKU;

// ----- JSON extraction (tolerant of fences / preamble / truncation) -----

export function stripFences(s: string): string {
  return s.replace(/```json/gi, "").replace(/```/g, "").trim();
}

export function extractJson(raw: string): unknown {
  const cleaned = stripFences(raw);
  const start = cleaned.search(/[\{\[]/);
  if (start === -1) throw new Error("no JSON found");
  const opener = cleaned[start];
  const closer = opener === "[" ? "]" : "}";
  const end = cleaned.lastIndexOf(closer);
  const slice = end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    let braces = 0, brackets = 0;
    for (const ch of slice) {
      if (ch === "{") braces++;
      else if (ch === "}") braces--;
      else if (ch === "[") brackets++;
      else if (ch === "]") brackets--;
    }
    let repaired = slice.replace(/[\x00-\x1F\x7F]/g, "");
    while (brackets-- > 0) repaired += "]";
    while (braces-- > 0) repaired += "}";
    return JSON.parse(repaired);
  }
}

// ----- Provider callers -----

/**
 * OpenAI's chat-completions API. This function used to point at the Lovable
 * gateway, which speaks the same shape; the gateway is gone, the shape stayed.
 */
async function callOpenAICompat(
  model: string,
  opts: GenerateOpts,
  apiKey: string,
): Promise<{ ok: boolean; content: string; usage?: unknown; error?: string; errorCode?: string }> {
  const messages: ChatMessage[] = [];
  if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
  for (const m of opts.messages) messages.push(m);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      let code = `openai_${res.status}`;
      if (res.status === 429) code = "rate_limited";
      else if (res.status === 402) code = "credits_exhausted";
      return { ok: false, content: "", error: `OpenAI ${res.status}: ${text.slice(0, 300)}`, errorCode: code };
    }
    const data = JSON.parse(text);
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    return { ok: true, content, usage: data?.usage };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, content: "", error: `openai fetch failed: ${String(e)}`, errorCode: "network_error" };
  }
}

async function callAnthropic(
  opts: GenerateOpts,
  apiKey: string,
): Promise<{ ok: boolean; content: string; usage?: unknown; error?: string; errorCode?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: opts.maxTokens ?? 2048,
        system: opts.systemPrompt,
        messages: opts.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, content: "", error: `Anthropic ${res.status}: ${text.slice(0, 300)}`, errorCode: `anthropic_${res.status}` };
    }
    const data = JSON.parse(text);
    const content: string = (data?.content ?? []).map((c: any) => c?.text ?? "").join("\n").trim();
    return { ok: true, content, usage: data?.usage };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, content: "", error: `anthropic fetch failed: ${String(e)}`, errorCode: "network_error" };
  }
}

// ----- Public API -----

/**
 * The attempt chain for one task: its intended model, then its declared
 * fallback, and nothing else.
 *
 * Exported so the policy can be asserted without a network: given a set of
 * credentials, exactly which models may this task reach, in what order?
 */
export function plannedAttempts(
  taskType: TaskType, hasKey: (v: ModelVendor) => boolean,
): Array<{ vendor: ModelVendor; model: string; intended: boolean }> {
  const policy = TASK_MODELS[taskType];
  const out: Array<{ vendor: ModelVendor; model: string; intended: boolean }> = [];
  if (hasKey(policy.vendor)) out.push({ vendor: policy.vendor, model: policy.model, intended: true });
  if (policy.fallback && hasKey(policy.fallback.vendor)) {
    out.push({ ...policy.fallback, intended: false });
  }
  return out;
}

export async function generateText(opts: GenerateOpts): Promise<GenerateResult> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const hasKey = (v: ModelVendor) => (v === "anthropic" ? !!anthropicKey : !!openaiKey);
  const policy = TASK_MODELS[opts.taskType];
  const started = Date.now();

  type Attempt = {
    provider: ProviderName; model: string; intended: boolean;
    run: () => Promise<Awaited<ReturnType<typeof callAnthropic>>>;
  };
  const attempts: Attempt[] = plannedAttempts(opts.taskType, hasKey).map((a) =>
    a.vendor === "anthropic"
      ? { provider: "anthropic" as ProviderName, model: a.model, intended: a.intended,
          run: () => callAnthropic(opts, anthropicKey!) }
      : { provider: "openai" as ProviderName, model: a.model, intended: a.intended,
          run: () => callOpenAICompat(a.model, opts, openaiKey!) }
  );

  if (attempts.length === 0) {
    // NO SILENT DEMOTION. The task named a model; its vendor has no credential
    // and its policy allows no substitute, so the call fails and says which
    // credential to set. Running the task somewhere else would be the bug this
    // whole policy exists to remove.
    const needed = policy.vendor === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    console.error("[ai-provider] no provider for task", {
      task: opts.taskType, intended_model: policy.model, needed_env: needed,
      fallback_allowed: !!policy.fallback,
    });
    return {
      ok: false,
      content: "",
      provider: "none",
      model: policy.model,
      error: `No provider for task "${opts.taskType}" (intended ${policy.model}; set ${needed}).`,
      errorCode: "no_provider_for_task",
      latencyMs: Date.now() - started,
    };
  }

  let lastErr = "no attempts";
  let lastCode = "unknown";
  /** A vendor that answered 402/429 is not asked again in this call. */
  const exhausted = new Set<ProviderName>();
  for (const att of attempts) {
    if (exhausted.has(att.provider)) continue;

    // ── THE BUDGET IS CHECKED HERE, INSIDE THE LOOP ──────────────────────
    //
    // Before every attempt, so an exhausted run cannot buy one more call by
    // falling through to the next model in the chain. Returns a truthful
    // bounded result rather than throwing: the caller gets `ok: false` with a
    // code that names the bound, so a partial answer stays a partial answer
    // instead of becoming an unhandled failure.
    const verdict = opts.budget?.reserveAttempt?.(att.model) ?? opts.budget?.check();
    if (verdict && !verdict.allowed) {
      console.warn("[aiProvider] model budget reached", {
        fn: opts.functionName, task: opts.taskType,
        exceeded: verdict.exceeded, model: att.model,
      });
      return {
        ok: false, content: "", provider: "none", model: "",
        error: `model run budget reached (${verdict.exceeded})`,
        errorCode: "model_budget_exhausted",
        latencyMs: Date.now() - started,
      };
    }
    const r = await att.run();
    if (r.ok && r.content) {
      const latencyMs = Date.now() - started;
      console.log("[aiProvider] ok", {
        fn: opts.functionName, task: opts.taskType, agent: opts.agentSlug,
        provider: att.provider, model: att.model, latencyMs,
      });
      opts.onModelCall?.(
        buildModelTelemetry({
          role: `${opts.functionName ?? "aiProvider"}:${opts.taskType}`,
          model: att.model,
          // `readModelUsage` reads `raw.usage` — it takes the WHOLE response,
          // not the usage object. `callLovable`/`callAnthropic` have already
          // unwrapped it, so it has to be wrapped back or every token count
          // reads null and every chat call prices as unknown.
          usage: readModelUsage({ usage: r.usage }),
          latency_ms: latencyMs,
          fallback_reason: att === attempts[0] ? null : "primary_attempt_failed",
        }),
        true,
      );
      // A FALLBACK THAT NOBODY NOTICES IS THE ORIGINAL BUG. When the task did
      // not get the model it named, say so in the result AND in the log — the
      // caller can surface it, and an operator can see it without reading
      // model names out of a successful trace.
      if (!att.intended) {
        console.warn("[ai-provider] task ran on its FALLBACK model", {
          task: opts.taskType, intended: policy.model, actual: att.model,
          provider: att.provider, fn: opts.functionName,
        });
      }
      return {
        ok: true, content: r.content, provider: att.provider, model: att.model,
        usage: r.usage, latencyMs,
        degraded: !att.intended,
        intendedModel: policy.model,
      };
    }
    // A FAILED ATTEMPT IS STILL A CALL. It may have been billed, and during an
    // outage a ledger with no rows is indistinguishable from a quiet period —
    // the same reason the mission-compiler drain runs before its throw.
    opts.onModelCall?.(
      buildModelTelemetry({
        role: `${opts.functionName ?? "aiProvider"}:${opts.taskType}`,
        model: att.model,
        usage: readModelUsage(undefined),
        latency_ms: Date.now() - started,
        fallback_reason: r.errorCode ?? "attempt_failed",
      }),
      false,
    );
    lastErr = r.error ?? "unknown error";
    lastCode = r.errorCode ?? "unknown";
    console.warn("[aiProvider] attempt failed", {
      fn: opts.functionName, task: opts.taskType,
      provider: att.provider, model: att.model, error: lastErr,
    });
    // On credits/rate errors, don't waste more Lovable calls — but let the loop
    // continue to any configured Anthropic fallback attempt.
    if (lastCode === "credits_exhausted" || lastCode === "rate_limited") exhausted.add(att.provider);
  }

  return {
    ok: false, content: "", provider: "none", model: "",
    error: lastErr, errorCode: lastCode, latencyMs: Date.now() - started,
  };
}

export async function generateJson(opts: GenerateOpts): Promise<GenerateResult> {
  const r = await generateText({ ...opts, jsonMode: true });
  if (!r.ok) return r;
  try {
    const parsed = extractJson(r.content);
    return { ...r, json: parsed };
  } catch (e) {
    return { ...r, ok: false, error: `json_parse_failed: ${String(e)}`, errorCode: "json_parse_failed" };
  }
}

// ----- Lightweight metadata logger -----

export async function logProviderCall(
  admin: any,
  meta: {
    workspace_id?: string | null;
    plan_id?: string | null;
    agent_id?: string | null;
    function_name: string;
    agent_slug?: string | null;
    task_type: TaskType;
    provider: ProviderName | "none";
    model: string;
    success: boolean;
    latency_ms: number;
    error_code?: string;
    prompt_version?: string;
  },
): Promise<void> {
  if (!meta.workspace_id) return;
  try {
    await admin.from("activity_feed").insert({
      workspace_id: meta.workspace_id,
      plan_id: meta.plan_id ?? null,
      agent_id: meta.agent_id ?? null,
      event_type: "ai_provider_call",
      title: `${meta.provider}:${meta.model}`,
      body: meta.success ? "ok" : `failed: ${meta.error_code ?? "unknown"}`,
      metadata: {
        function: meta.function_name,
        agent_slug: meta.agent_slug ?? null,
        task_type: meta.task_type,
        provider: meta.provider,
        model: meta.model,
        success: meta.success,
        latency_ms: meta.latency_ms,
        error_code: meta.error_code ?? null,
        prompt_version: meta.prompt_version ?? null,
      },
    });
  } catch (e) {
    console.warn("[aiProvider] logProviderCall failed:", String(e));
  }
}
