// THE EXECUTION LEDGER — one row per external provider call, written before the
// call returns.
//
// WHAT EXISTS TODAY, AND WHY IT IS NOT THIS.
//
// `tool_calls` already records every `runTool` invocation: workspace, plan, task,
// tool name, provider, input, output, status, error. It is genuinely useful and
// `durableIdempotency` depends on it. But it cannot answer the operational
// questions, because:
//
//   * There is no cost column at all — not estimated, not actual. Spend is
//     tracked in an abstract "Agentory credit" elsewhere and never reconciled
//     against a provider.
//   * Duration is not stored, only derivable by subtracting two timestamps — and
//     on the tool-forbidden path `logToolCall` assigns `started_at` and
//     `completed_at` the same instant, so that subtraction is zero by
//     construction there.
//   * The Apify run id and dataset id exist only inside `output_json`, so
//     "which run produced these rows" is a JSON dig rather than a column.
//   * There are no funnel counts. "100 rows arrived, 82 normalized, 13 passed the
//     gate" is the shape of every real question and none of it is recorded.
//   * There is no reason. A row says a tool ran, never why it was allowed to.
//   * A retry overwrites nothing but is indistinguishable from a first attempt.
//
// This ledger adds those, and leaves `tool_calls` and its idempotency contract
// exactly as they are. Two tables with different jobs, not a migration of one
// into the other.
//
// WHAT THIS MODULE IS NOT. It observes. It never decides a provider, a budget, a
// retry, a broadening, a quota or a qualification — every one of those stays
// where it already lives. A ledger that can change what runs is not a ledger.
//
// PURE, except through the injected writer. No network, no Supabase import, no
// provider access. `LedgerWriter` is the only seam, which is what makes the whole
// lifecycle testable offline.

// TYPE-ONLY, and deliberately so. `modelCostModel` imports `ExecutionCost` from
// this module, so a value import here would be a cycle. Types are erased, so
// this one is not.
import type { ModelCallTelemetry } from "./modelCostModel.ts";
import { retryTransient, type RetryOptions } from "./retryTransient.ts";

export const EXECUTION_LEDGER_VERSION = "lead-execution-ledger-v1" as const;

// ── VOCABULARY ──────────────────────────────────────────────────────────────
//
// Deliberately the CURRENT vocabulary, not a canonical one. Canonical signals,
// capabilities and playbooks are later phases; this phase must not pre-empt their
// naming. Structuring these as columns is what lets those phases replace the
// VALUES without rewriting the table.

/** Where in the funnel a call sits. */
export type ExecutionStage =
  | "company_discovery"
  | "company_enrichment"
  | "hiring_evidence"
  | "person_resolution"
  | "contact_enrichment"
  | "generic_sourcing"
  | "other";

/** Why this call was allowed to happen. Machine-readable, never free prose. */
export type ExecutionReason =
  | "initial_discovery"
  | "fill_required_evidence"
  | "qualified_decision_maker"
  | "quota_shortfall_round"
  | "broadened_retry"
  | "resumed_run"
  | "unspecified";

export type ExecutionStatus =
  /** The row exists and the call is in flight. Never a final state. */
  | "started"
  | "succeeded"
  | "failed"
  | "timed_out"
  /** An already-paid provider run was adopted instead of starting a new one. */
  | "reused";

/**
 * How much a cost figure can be trusted. An estimate is never stored as actual.
 *
 * `event_priced` is the grade that was missing. Every row this table has ever
 * held said `unknown`, because the only alternatives were "the provider told
 * us" — which nothing read — and "estimated", which is where a figure computed
 * from a VERIFIED per-event price table would have been buried alongside
 * genuine guesses. Those are not the same claim: one is accurate to the cent
 * and one is not gradeable at all, and "what did this run cost?" cannot be
 * answered honestly without saying which you have.
 *
 * Only `provider_reported` may populate `actual_cost_usd`, and the database
 * enforces it: `lead_execution_calls_actual_cost_requires_provider`.
 */
export type CostSource =
  | "provider_reported"
  | "event_priced"
  | "estimated"
  | "unknown";

/**
 * Funnel counts.
 *
 * EVERY FIELD IS NULLABLE AND NULL MEANS UNKNOWN. This is not pedantry: the UI
 * has previously rendered "not searched" as zero evidence, which reads as "we
 * checked and found nothing" when the truth was "we never looked". A call site
 * that cannot know a count must leave it null rather than write 0.
 */
export interface ExecutionCounts {
  /** Rows the provider returned. */
  raw?: number | null;
  /** Rows that survived shape normalization. */
  normalized?: number | null;
  /** Rows left after de-duplication. */
  unique?: number | null;
  /** Rows that passed this stage's gate. */
  accepted?: number | null;
  /** Rows this stage rejected. */
  rejected?: number | null;
}

export interface ExecutionCost {
  actual_usd?: number | null;
  estimated_usd?: number | null;
  source: CostSource;
}

/** What is known before the call is made. */
/**
 * A provider call, a task-level stage outcome, or one LLM invocation.
 *
 * Kept in one table because they answer one question together — "what did this
 * run cost?" — and kept DISTINGUISHABLE because they are not the same event. An
 * Actor returning 100 rows does not entitle anyone to record "13
 * evidence-satisfied" against that Actor: several calls may have contributed to
 * those 13, and attributing them to one row makes the ledger untrustworthy
 * exactly where it must be trusted.
 *
 * `model_call` shares `estimated_cost_usd`, `duration_ms`, `status` and the
 * failure columns with the other kinds, which is what lets one query price a
 * whole run. It never shares the FUNNEL columns: token counts live in
 * `metadata`, because `accepted_count` is summed across the table by existing
 * queries and making it mean "output tokens" for one kind would corrupt every
 * one of them.
 *
 * Anything summing provider spend must filter on `record_kind`, which the
 * existing summary already does.
 */
export type RecordKind = "provider_call" | "stage_result" | "model_call";

export interface ExecutionCallSpec {
  record_kind?: RecordKind;
  workspace_id: string;
  task_id?: string | null;
  plan_id?: string | null;

  /** From the ownership ledger, so a row says which engine spent this money. */
  execution_owner?: string | null;
  /** From the plan artifact's provenance, so a row says which planner chose it. */
  planner_owner?: string | null;
  /**
   * The rest of the planner provenance triple.
   *
   * `planner_owner` alone says which adapter was SELECTED and nothing about
   * whether it worked. Without the outcome, "the ladder planned by design" and
   * "a model adapter ran and degraded" are the same row again — the exact
   * ambiguity the ownership phase removed.
   */
  planner_adapter?: "gpt" | "claude" | "none" | null;
  planner_outcome?: "selected_directly" | "model_validated" | "deterministic_fallback" | null;
  planner_fallback_reason?: string | null;

  stage: ExecutionStage;
  capability?: string | null;
  reason: ExecutionReason;

  provider_id: string;
  actor_id?: string | null;

  /** The provider-facing input, pre-redaction. Redacted by `beginExecution`. */
  request_input?: unknown;

  /**
   * Stable identity for the LOGICAL call — same question, same key.
   *
   * Two attempts at one logical call share this and differ by `attempt_number`,
   * which is what makes "did this retry, or is this a different call?" a query
   * rather than an inference.
   */
  logical_call_key: string;
  attempt_number?: number;
}

/** What is known once the call has finished. */
export interface ExecutionOutcome {
  status: Exclude<ExecutionStatus, "started">;
  provider_run_id?: string | null;
  dataset_id?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  counts?: ExecutionCounts;
  cost?: ExecutionCost;
  /** What the runtime did next. Recorded, never decided here. */
  next_decision?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ExecutionLedgerRow extends Omit<ExecutionCallSpec, "request_input"> {
  provider_call_id?: string;
  idempotency_key?: string;
  plan_version?: number | null;
  route_id?: string | null;
  id: string;
  version: typeof EXECUTION_LEDGER_VERSION;
  record_kind: RecordKind;
  attempt_number: number;
  status: ExecutionStatus;
  request_input: Record<string, unknown> | null;
  provider_run_id: string | null;
  dataset_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  raw_count: number | null;
  normalized_count: number | null;
  unique_count: number | null;
  accepted_count: number | null;
  rejected_count: number | null;
  actual_cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_source: CostSource;
  next_decision: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The only seam. Two operations, both fire-and-forget from the caller's view.
 *
 * `insert` must not throw in production — a ledger that can fail a run is worse
 * than a missing row — but the wrapper below defends against it anyway.
 */
export interface LedgerWriter {
  insert(row: ExecutionLedgerRow): Promise<void>;
  /**
   * Resolves `false` when the write did not land (the database answered an
   * error); anything else is "written". Optional to report: a writer that
   * resolves nothing is read as having written, as before.
   */
  finalize(id: string, patch: Partial<ExecutionLedgerRow>): Promise<void | boolean>;
}

// ── REDACTION ───────────────────────────────────────────────────────────────

/**
 * Keys whose VALUES are never persisted, at any depth.
 *
 * Matched case-insensitively on a normalized key (non-alphanumerics stripped), so
 * `api-key`, `API_KEY` and `apiKey` are one rule rather than three. The provider
 * input has to be reproducible — many past failures were malformed Actor inputs —
 * and reproducible must not mean "contains the token".
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  // ANY key ending in "token". The exact-match list missed `idToken`,
  // `sessionToken` and `supabaseAccessToken` — three of the most likely names
  // for a live Supabase credential. A suffix rule covers the whole family
  // without guessing at prefixes, and matches nothing benign in a provider
  // input: `dataset_id`, `run_id` and `identity` all normalize away from it.
  /token$/i,
  /^(api)?token$/i,
  /^jwt$/i,
  // Plural too: `cookies` slipped past a `^cookie$` rule.
  /^cookies?$/i,
  /^(api|access|secret|private|client)?key$/i,
  /^authorization$/i,
  /^auth$/i,
  /^password$/i,
  /^secret$/i,
  /^credentials?$/i,
  /^cookie$/i,
  /^sessionid$/i,
  /^bearer$/i,
  /^refreshtoken$/i,
  /^accesstoken$/i,
];

export const REDACTED = "[redacted]" as const;

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SECRET_KEY_PATTERNS.some((re) => re.test(normalized));
}

/**
 * A token embedded in a URL query string, which is how Apify authenticates.
 *
 * Redacting only object keys would miss `…/runs?token=apify_api_xxx` entirely —
 * the single most likely place for a live credential to reach the ledger.
 */
function redactUrlSecrets(value: string): string {
  return value.replace(
    /([?&](?:token|api_?key|access_?token|auth)=)[^&\s]+/gi,
    `$1${REDACTED}`,
  );
}

/** Bare provider tokens appearing as a whole value. */
const BARE_TOKEN = /^(apify_api_[A-Za-z0-9]+|sk-[A-Za-z0-9-_]{10,}|Bearer\s+\S+)$/;

/**
 * A JWT as a whole value, under any key name at all.
 *
 * Key-based redaction cannot help when the key is `auth_context` or `ctx`, and a
 * Supabase JWT is a live credential carrying workspace scope — precisely what
 * must never land in a column designed to be read.
 *
 * DELIBERATELY STRICT. Requiring the header segment to begin `eyJ` — the
 * base64url of `{"`, which every JWT header starts with — is what keeps
 * `example.com`, `version.1.2`, `1.2.3` and `some.nested.path` legible. A looser
 * "three dotted segments" rule would redact ordinary provider inputs and destroy
 * the reproducibility this column exists for, which is a worse failure than the
 * rare non-standard token it would additionally catch.
 */
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/;

/**
 * Deep-copy an input with every secret removed.
 *
 * Depth- and size-bounded: a provider input is a request payload, not a dataset,
 * and an unbounded structure would put a dataset in the ledger by accident.
 */
export function redactProviderInput(
  input: unknown,
  depth = 0,
): unknown {
  if (depth > 8) return "[truncated:depth]";
  if (input === null || input === undefined) return null;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (BARE_TOKEN.test(trimmed) || JWT_VALUE.test(trimmed)) return REDACTED;
    const cleaned = redactUrlSecrets(input);
    return cleaned.length > 2000 ? `${cleaned.slice(0, 2000)}…[truncated]` : cleaned;
  }
  if (typeof input === "number" || typeof input === "boolean") return input;

  if (Array.isArray(input)) {
    return input.slice(0, 200).map((v) => redactProviderInput(v, depth + 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redactProviderInput(v, depth + 1);
    }
    return out;
  }
  // Functions, symbols and anything else are not request data.
  return null;
}

// ── LIFECYCLE ───────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

/** Null unless a real number. Guards against `0` standing in for "unknown". */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function buildStartedRow(spec: ExecutionCallSpec): ExecutionLedgerRow {
  return {
    ...specIdentityColumns(spec.request_input),
    id: newId(),
    version: EXECUTION_LEDGER_VERSION,
    record_kind: spec.record_kind ?? "provider_call",
    workspace_id: spec.workspace_id,
    task_id: spec.task_id ?? null,
    plan_id: spec.plan_id ?? null,
    execution_owner: spec.execution_owner ?? null,
    planner_owner: spec.planner_owner ?? null,
    planner_adapter: spec.planner_adapter ?? null,
    planner_outcome: spec.planner_outcome ?? null,
    planner_fallback_reason: spec.planner_fallback_reason ?? null,
    stage: spec.stage,
    capability: spec.capability ?? null,
    reason: spec.reason,
    provider_id: spec.provider_id,
    actor_id: spec.actor_id ?? null,
    logical_call_key: spec.logical_call_key,
    attempt_number: spec.attempt_number ?? 1,
    status: "started",
    request_input: redactProviderInput(spec.request_input ?? null) as Record<string, unknown> | null,
    provider_run_id: null,
    dataset_id: null,
    failure_code: null,
    failure_message: null,
    started_at: nowIso(),
    finished_at: null,
    duration_ms: null,
    raw_count: null,
    normalized_count: null,
    unique_count: null,
    accepted_count: null,
    rejected_count: null,
    actual_cost_usd: null,
    estimated_cost_usd: null,
    cost_source: "unknown",
    next_decision: null,
    metadata: null,
  };
}

/**
 * LEAD V2 P2 — the ProviderCallSpec's identity as queryable columns.
 *
 * Present only when the envelope carries a spec, so every other row keeps
 * exactly the shape it had. The full spec stays in `request_input`.
 */
export function specIdentityColumns(requestInput: unknown): {
  provider_call_id?: string; idempotency_key?: string; plan_version?: number | null; route_id?: string | null;
} {
  const spec = (requestInput as { provider_call_spec?: Record<string, unknown> } | null)?.provider_call_spec;
  if (!spec || typeof spec !== "object") return {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const key = str(spec.idempotency_key);
  const id = str(spec.provider_call_id);
  if (!key || !id) return {};
  return {
    provider_call_id: id,
    idempotency_key: key,
    plan_version: typeof spec.plan_version === "number" ? spec.plan_version : null,
    route_id: str(spec.route_id),
  };
}

/**
 * ── WHAT A PROVIDER CALL COST: THREE FIGURES, THREE MOMENTS ─────────────────
 *
 *   pre-spend estimate    `request_input.provider_call_spec.cost.estimate_usd`
 *                         (and the spend-ledger reservation's `estimate_usd`).
 *                         Compiled BEFORE the call; what the ceilings reserve.
 *                         Not a column: `estimated_cost_usd` already means
 *                         "a cost that is not provider-reported" (see below)
 *                         and is not repurposed for it.
 *   actual_cost_usd       the provider's charge AS KNOWN WHEN THE CALL
 *                         RETURNED: the largest of the run's usage total, its
 *                         charged events, and its published start + per-result
 *                         price × billed rows (`priceProviderCall`). A FLOOR:
 *                         Apify posts per-result charges after SUCCEEDED, so
 *                         it can be lower than the bill. Never rewritten later.
 *   settled_usd           the bill, from the run's receipt re-read until stable,
 *   (settlement_source    after the run finished (`p2SpinePersistence`). Only
 *    = provider_receipt)  `provider_receipt` is a receipt; `derived_floor` is
 *                         the spend ledger's provisional figure written for a
 *                         call no receipt could settle, and is NOT one.
 *
 * Reports read ONE of them: {@link canonicalProviderCostUsd}.
 */
export interface ProviderCostColumns {
  actual_cost_usd?: number | string | null;
  settled_usd?: number | string | null;
  settlement_source?: string | null;
  /** The row's provider — decides whether a `derived_floor` is final. */
  provider_id?: string | null;
}

/**
 * PROVIDERS THAT NEVER ISSUE A RECEIPT, settled once, at call time, by their
 * published pricing rule (`settleByPublishedRule`).
 *
 * Firecrawl states credits, never dollars, so `actual_cost_usd` is null on
 * every Firecrawl row by construction (`priceFirecrawlCall`, and the database
 * CHECK behind it) and no receipt will ever arrive. For these rows the
 * `derived_floor` settlement is not provisional — it is the final figure, the
 * one the spend ledger, the ceilings and the Workbench already count. Reading
 * it as unknown dropped every Firecrawl call from `run_outcome.spend`
 * (production ComfyUI, plan 6f6be04b: $0.0298 reported of $0.049 settled).
 */
export const PUBLISHED_RULE_SETTLED_PROVIDERS: ReadonlySet<string> = new Set(["firecrawl"]);

/**
 * THE provider cost a report shows: the receipt-settled figure, else the
 * provider-reported figure at completion, else — for a provider that is
 * settled by its published rule and never by a receipt — that settlement,
 * else null (not known — never zero).
 */
export function canonicalProviderCostUsd(row: ProviderCostColumns): number | null {
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(x) ? x : null;
  };
  if (row.settlement_source === "provider_receipt") {
    const settled = n(row.settled_usd);
    if (settled !== null) return settled;
  }
  const actual = n(row.actual_cost_usd);
  if (actual !== null) return actual;
  // An Apify `derived_floor` stays unknown here: it is provisional, awaiting a
  // receipt, and its completion floor is `actual_cost_usd` above.
  if (row.settlement_source === "derived_floor" &&
      PUBLISHED_RULE_SETTLED_PROVIDERS.has(String(row.provider_id ?? ""))) {
    return n(row.settled_usd);
  }
  return null;
}

/**
 * The finalization patch.
 *
 * COST SEMANTICS. `actual_cost_usd` is only ever written when the provider
 * reported it. An estimate lands in `estimated_cost_usd` with
 * `cost_source: "estimated"`, and the two columns are never merged — the previous
 * audit found spend recorded in an abstract unit documented as "not dollars", and
 * the fix is not to guess harder but to say which kind of number this is.
 */
export function buildFinalPatch(
  row: Pick<ExecutionLedgerRow, "started_at">,
  outcome: ExecutionOutcome,
): Partial<ExecutionLedgerRow> {
  const finished = nowIso();
  const duration = Math.max(0, Date.parse(finished) - Date.parse(row.started_at));
  const cost = outcome.cost;

  return {
    status: outcome.status,
    provider_run_id: outcome.provider_run_id ?? null,
    dataset_id: outcome.dataset_id ?? null,
    failure_code: outcome.failure_code ?? null,
    failure_message: outcome.failure_message
      ? String(outcome.failure_message).slice(0, 500)
      : null,
    finished_at: finished,
    duration_ms: Number.isFinite(duration) ? duration : null,
    raw_count: num(outcome.counts?.raw),
    normalized_count: num(outcome.counts?.normalized),
    unique_count: num(outcome.counts?.unique),
    accepted_count: num(outcome.counts?.accepted),
    rejected_count: num(outcome.counts?.rejected),
    // An estimate never becomes an actual, whatever the caller passes.
    actual_cost_usd: cost?.source === "provider_reported" ? num(cost.actual_usd) : null,
    estimated_cost_usd: num(cost?.estimated_usd),
    cost_source: cost?.source ?? "unknown",
    next_decision: outcome.next_decision ?? null,
    metadata: outcome.metadata ?? null,
  };
}

export interface AuditedResult<T> {
  result: T;
  ledger_id: string;
}

/**
 * Run `fn` with a ledger row opened before it and closed after it, always.
 *
 * THE GUARANTEE. A provider call must never disappear because execution threw.
 * The row is inserted before `fn` runs and finalized in a `finally`, so a throw,
 * a rejection and a timeout all leave a terminal row behind. `fn` decides the
 * outcome for the success path by returning it alongside its own result; a throw
 * is recorded as `failed` with the error's message.
 *
 * The ledger never changes what `fn` returns and never swallows its exception.
 * Writer failures are logged and dropped — observability must not be able to fail
 * a run it is only watching.
 */
/**
 * Persist facts about a call that are known BEFORE it finishes.
 *
 * ── A RUN THAT EXISTS MUST BE REFERENCEABLE ──────────────────────────────
 *
 * The provider run id is created by the start POST and, until now, lived only
 * in memory until the call returned or the poll gave up. A run killed inside
 * that window — which is what the Edge Function wall clock does — left a row
 * reading `status: "started", provider_run_id: null` for an Apify run that was
 * started, billed, and unreferenceable.
 *
 * Run 78cff5e5 is exactly that: `harvestapi/linkedin-job-search` began at
 * 09:13:05, the function was hard-killed mid-call, and the task sat `running`
 * with `updated_at` frozen at creation. The resume machinery could not adopt
 * the run because nothing durable named it.
 */
export type LedgerProgress = (patch: Partial<ExecutionLedgerRow>) => Promise<void>;

/**
 * How a failed progress write is retried: 3 attempts, ~1.25 s of waiting at
 * most. Small on purpose — it sits between the start POST and the first poll.
 */
export const PROGRESS_WRITE_RETRY: RetryOptions = { attempts: 3, delaysMs: [250, 1_000] };

export async function withExecutionAudit<T>(
  writer: LedgerWriter | null | undefined,
  spec: ExecutionCallSpec,
  fn: (progress: LedgerProgress) => Promise<{ result: T; outcome: ExecutionOutcome }>,
): Promise<T> {
  // A null writer is a supported no-op: it is how the "auditing disabled behaves
  // identically" property is tested, and how a context without a database runs.
  if (!writer) return (await fn(async () => {})).result;

  const row = buildStartedRow(spec);
  try {
    await writer.insert(row);
  } catch (e) {
    console.error("[execution-ledger] insert failed", String(e));
  }

  let outcome: ExecutionOutcome = {
    status: "failed",
    failure_code: "unfinished",
    failure_message: "execution did not report an outcome",
  };
  // Mid-flight facts go straight to the row. Failures are logged, never thrown:
  // losing a progress write must not fail a call that is otherwise fine.
  //
  // RETRIED, BOUNDED. The one progress write is the provider run id, the
  // moment the start POST returns it — the only durable record of a billed run
  // until the call finalizes. One statement timeout there and a hard kill
  // before the `finally` left `started, provider_run_id: null`: a run nothing
  // can adopt. The write is an idempotent UPDATE by row id, so a failed one is
  // tried again (PROGRESS_WRITE_RETRY), and never past that.
  const progress: LedgerProgress = async (patch) => {
    const write = async (): Promise<boolean> => {
      try {
        return (await writer.finalize(row.id, patch)) !== false;
      } catch (e) {
        console.error("[execution-ledger] progress failed", String(e));
        return false;
      }
    };
    const { result: written, attempts } = await retryTransient(write, (ok) => !ok, PROGRESS_WRITE_RETRY);
    if (!written) console.error("[execution-ledger] progress lost", { attempts });
  };

  try {
    const r = await fn(progress);
    outcome = r.outcome;
    return r.result;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    outcome = {
      status: /timeout|timed[ _-]?out|deadline/i.test(message) ? "timed_out" : "failed",
      failure_code: (e as { code?: string })?.code ?? "exception",
      failure_message: message,
    };
    throw e;
  } finally {
    try {
      await writer.finalize(row.id, buildFinalPatch(row, outcome));
    } catch (e) {
      console.error("[execution-ledger] finalize failed", String(e));
    }
  }
}

// ── TASK SUMMARY ────────────────────────────────────────────────────────────

export interface StageSummary {
  stage: ExecutionStage;
  calls: number;
  raw: number | null;
  normalized: number | null;
  accepted: number | null;
  rejected: number | null;
  /** Provider-reported spend attributed to this stage. */
  actual_cost_usd: number;
  /** Everything not provider-reported. Never added to the line above. */
  estimated_cost_usd: number;
  /** How the figures above were obtained. */
  cost_confidence: ReturnType<typeof costConfidence>;
}

export interface TaskLedgerSummary {
  task_id: string | null;

  /** The planner story, read from whichever row recorded it. */
  planner: {
    owner: string | null;
    adapter: string | null;
    outcome: string | null;
    fallback_reason: string | null;
  };
  execution_owner: string | null;

  /** PROVIDER CALLS ONLY. Stage results are not calls and never inflate this. */
  calls: number;
  attempts_beyond_first: number;
  succeeded: number;
  failed: number;
  timed_out: number;
  reused: number;
  /** Only provider-reported figures. */
  actual_cost_usd: number;
  /** Only estimates. Kept apart so the two are never added together by accident. */
  estimated_cost_usd: number;
  /** True when any cost in this task is an estimate rather than a reported figure. */
  cost_is_partly_estimated: boolean;
  /** How many calls carry each grade of cost provenance. */
  cost_confidence: ReturnType<typeof costConfidence>;
  total_duration_ms: number;
  by_stage: StageSummary[];
  /** Task-level funnel outcomes no single provider call could know. */
  stage_results: StageSummary[];
  /** The last recorded `next_decision`, which is why the workflow stopped. */
  stop_reason: string | null;
}

/**
 * How much of a set of costs is the provider's own figure rather than ours.
 *
 * Lives here, not in `providerCostModel`, because it reads LEDGER ROWS and this
 * module owns both `CostSource` and the row shape. The pricing module depends
 * on this file for its types; a helper here that reached back for it would make
 * that a cycle.
 *
 * Reported beside the totals so a run's economics always carry their own grade.
 * "$0.41, none of it provider-confirmed" is a different statement from "$0.41",
 * and only one of them can be put in front of a customer.
 */
export function costConfidence(sources: readonly CostSource[]): {
  provider_reported: number;
  event_priced: number;
  estimated: number;
  unknown: number;
  /** True when every figure came from the provider itself. */
  fully_reported: boolean;
} {
  const count = (s: CostSource) => sources.filter((x) => x === s).length;
  return {
    provider_reported: count("provider_reported"),
    event_priced: count("event_priced"),
    estimated: count("estimated"),
    unknown: count("unknown"),
    fully_reported: sources.length > 0 && sources.every((s) => s === "provider_reported"),
  };
}

/** Sum, treating null as unknown rather than zero. Null when nothing was known. */
function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/**
 * Reconstruct one task's execution from ledger rows alone.
 *
 * Pure: give it rows, get the story. This is the function that has to make
 * "diagnosable in minutes, by someone who was not present" true, so it is
 * deliberately readable rather than clever.
 */
export function summarizeTaskLedger(rows: ExecutionLedgerRow[]): TaskLedgerSummary {
  const ordered = [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at));

  // THE TWO KINDS ARE NEVER MIXED. Summing a stage result into "provider calls"
  // would double-count the funnel and overstate how many times money was spent.
  const calls = ordered.filter((r) => (r.record_kind ?? "provider_call") === "provider_call");
  const stageRows = ordered.filter((r) => r.record_kind === "stage_result");

  const group = (rs: ExecutionLedgerRow[]): StageSummary[] => {
    const m = new Map<ExecutionStage, ExecutionLedgerRow[]>();
    for (const r of rs) m.set(r.stage, [...(m.get(r.stage) ?? []), r]);
    return [...m.entries()].map(([stage, list]) => ({
      stage,
      calls: list.length,
      raw: sumKnown(list.map((r) => r.raw_count)),
      normalized: sumKnown(list.map((r) => r.normalized_count)),
      accepted: sumKnown(list.map((r) => r.accepted_count)),
      rejected: sumKnown(list.map((r) => r.rejected_count)),
      // PER STAGE, BECAUSE THAT IS THE QUESTION PEOPLE ACTUALLY ASK. "What did
      // this run cost" is answerable from the total; "why is it expensive" is
      // only answerable if identity, discovery and enrichment are separable.
      // Kept apart by grade for the same reason the totals are.
      actual_cost_usd: Number(
        list.reduce((a, r) => a + (r.actual_cost_usd ?? 0), 0).toFixed(4)),
      estimated_cost_usd: Number(
        list.reduce((a, r) => a + (r.estimated_cost_usd ?? 0), 0).toFixed(4)),
      cost_confidence: costConfidence(list.map((r) => r.cost_source)),
    }));
  };

  // Provenance is stamped on every row of a run, so the first row that carries it
  // is authoritative; a task with no rows reports nulls rather than guessing.
  const provenanced = ordered.find((r) => r.planner_owner || r.planner_outcome);
  const withDecision = [...ordered].reverse().find((r) => r.next_decision);

  return {
    task_id: ordered[0]?.task_id ?? null,
    planner: {
      owner: provenanced?.planner_owner ?? null,
      adapter: provenanced?.planner_adapter ?? null,
      outcome: provenanced?.planner_outcome ?? null,
      fallback_reason: provenanced?.planner_fallback_reason ?? null,
    },
    execution_owner: ordered.find((r) => r.execution_owner)?.execution_owner ?? null,
    calls: calls.length,
    attempts_beyond_first: calls.filter((r) => r.attempt_number > 1).length,
    succeeded: calls.filter((r) => r.status === "succeeded").length,
    failed: calls.filter((r) => r.status === "failed").length,
    timed_out: calls.filter((r) => r.status === "timed_out").length,
    reused: calls.filter((r) => r.status === "reused").length,
    actual_cost_usd: Number(calls.reduce((a, r) => a + (r.actual_cost_usd ?? 0), 0).toFixed(4)),
    estimated_cost_usd: Number(calls.reduce((a, r) => a + (r.estimated_cost_usd ?? 0), 0).toFixed(4)),
    // ANY figure that is not the provider's own. `event_priced` is accurate and
    // still ours, so a run priced entirely from the card table is "partly
    // estimated" in the only sense that matters: nobody at Apify agreed to it.
    cost_is_partly_estimated: calls.some((r) => r.cost_source !== "provider_reported"),
    cost_confidence: costConfidence(calls.map((r) => r.cost_source)),
    total_duration_ms: calls.reduce((a, r) => a + (r.duration_ms ?? 0), 0),
    by_stage: group(calls),
    stage_results: group(stageRows),
    stop_reason: withDecision?.next_decision ?? null,
  };
}

/** A compact, human-readable rendering of the summary. Diagnostics only. */
export function renderTaskLedger(s: TaskLedgerSummary): string {
  const fmt = (n: number | null) => (n === null ? "unknown" : String(n));
  const lines: string[] = [];
  lines.push(`Task ${s.task_id ?? "(unknown)"}`);

  lines.push("");
  lines.push("planner:");
  if (!s.planner.owner && !s.planner.outcome) {
    lines.push("  unknown");
  } else if (s.planner.outcome === "deterministic_fallback") {
    // The degraded case names what degraded it — that reason is the only
    // interesting field in this state.
    lines.push(`  ${s.planner.adapter ?? "?"} → deterministic fallback (${s.planner.fallback_reason ?? "no reason recorded"})`);
  } else if (s.planner.outcome === "selected_directly") {
    lines.push("  deterministic (selected directly — no adapter enabled)");
  } else {
    lines.push(`  ${s.planner.adapter ?? s.planner.owner} (plan accepted)`);
  }

  lines.push("");
  lines.push("execution:");
  lines.push(`  ${s.execution_owner ?? "unknown"}`);

  lines.push("");
  lines.push(`provider calls:`);
  lines.push(`  ${s.calls}` + (s.attempts_beyond_first ? ` (${s.attempts_beyond_first} retried)` : ""));
  if (s.failed || s.timed_out) lines.push(`  ${s.failed} failed, ${s.timed_out} timed out`);
  if (s.reused) lines.push(`  ${s.reused} reused an already-paid run`);

  lines.push("");
  lines.push("spend:");
  lines.push(`  $${s.actual_cost_usd.toFixed(2)} actual`);
  lines.push(`  $${s.estimated_cost_usd.toFixed(2)} estimated`);

  for (const st of s.by_stage) {
    lines.push("");
    lines.push(`${st.stage}:`);
    // "unknown" is printed rather than 0, because the difference between "we
    // checked and found none" and "we never looked" is the whole point.
    lines.push(`  ${fmt(st.raw)} raw`);
    lines.push(`  ${fmt(st.normalized)} normalized`);
    lines.push(`  ${fmt(st.accepted)} accepted`);
  }

  // Task-level outcomes, printed apart from provider calls so nobody reads a
  // funnel number as something one Actor produced.
  for (const st of s.stage_results) {
    lines.push("");
    lines.push(`${st.stage} (stage result):`);
    lines.push(`  ${fmt(st.accepted)} passed`);
    if (st.rejected !== null) lines.push(`  ${fmt(st.rejected)} rejected`);
  }

  lines.push("");
  lines.push("stop:");
  lines.push(`  ${s.stop_reason ?? "unknown"}`);
  return lines.join("\n");
}

/**
 * Record a task-level stage outcome — a funnel number no single provider call
 * could truthfully claim.
 *
 * Written as its own row with `record_kind: "stage_result"` and no provider run
 * id, so summing never confuses it with a paid call. `status` is always
 * `succeeded` because a stage result is an observation, not an attempt.
 */
export async function recordStageResult(
  writer: LedgerWriter | null | undefined,
  spec: Omit<ExecutionCallSpec, "record_kind" | "provider_id"> & { counts: ExecutionCounts; next_decision?: string | null },
): Promise<void> {
  if (!writer) return;
  const row = buildStartedRow({
    ...spec,
    record_kind: "stage_result",
    // A stage result is produced by Agentory's own gates, not by a vendor. Naming
    // a provider here would make it look like a purchase.
    provider_id: "agentory_internal",
  });
  try {
    await writer.insert(row);
    await writer.finalize(row.id, buildFinalPatch(row, {
      status: "succeeded",
      counts: spec.counts,
      next_decision: spec.next_decision ?? null,
    }));
  } catch (e) {
    console.error("[execution-ledger] stage result failed", String(e));
  }
}

/**
 * Record one LLM invocation.
 *
 * ── WHAT THIS CLOSES ──────────────────────────────────────────────────────
 *
 * Phase 1 built the telemetry — role, model, effort, tokens, latency, cost,
 * provenance — and both transports emitted it to `console.log` and nothing
 * else. A run could be audited for Apify dollars to the cent and could not
 * answer "what did the models cost?", because the answer existed only in a log
 * line that nothing aggregated.
 *
 * ── WHERE EACH FIELD LANDS, AND WHY ───────────────────────────────────────
 *
 * Cost, latency, status and failure take their REAL columns. They are cross-kind
 * concepts, and sharing them is the entire point: `sum(estimated_cost_usd)` over
 * a task now prices the models and the Actors together, and
 * `group by record_kind` splits them again.
 *
 * Everything model-specific goes in `metadata` — token counts most of all. The
 * funnel columns (`raw_count`, `accepted_count`, …) are summed across the whole
 * table by existing queries, and overloading one of them to mean "output tokens"
 * for a single record kind would silently corrupt every one of those aggregates.
 * The `lead_model_calls` view projects the jsonb back into columns so this costs
 * nothing at query time.
 *
 * ── ACTUAL COST IS NEVER WRITTEN HERE ─────────────────────────────────────
 *
 * OpenAI returns token counts and no monetary charge, so the figure is ours and
 * belongs in `estimated_cost_usd` under `event_priced`. The database enforces
 * this independently — `actual_cost_usd IS NULL OR cost_source =
 * 'provider_reported'` — and a row attempting otherwise is REJECTED rather than
 * quietly stored. That constraint is general on purpose: if a provider ever does
 * report a charge, the honest path stays open.
 *
 * ── FAILURES ARE RECORDED TOO ─────────────────────────────────────────────
 *
 * A call that 429s is a call that happened. Recording only the successes would
 * make an outage look like a quiet period, which is the exact reading that cost
 * a day on 2026-08-21.
 */
export async function recordModelCall(
  writer: LedgerWriter | null | undefined,
  spec: Omit<ExecutionCallSpec, "record_kind" | "provider_id" | "stage" | "reason"> & {
    telemetry: ModelCallTelemetry;
    /** False for a call the provider refused or that never returned. */
    ok: boolean;
    failure_code?: string | null;
    failure_message?: string | null;
    stage?: ExecutionStage;
    reason?: ExecutionReason;
    /**
     * The vendor that ran it. Defaults to `openai`, which every text caller
     * uses and none of them passes.
     *
     * It exists because it is now possible to be WRONG. Text generation has one
     * vendor here; image generation sits behind `ImageGenerationProvider`
     * precisely so a second one can be added without touching Content, and a
     * hardcoded `openai` would keep this column reading `openai` while the
     * charge arrived from somewhere else. A provider column that cannot say who
     * charged you is worse than no column, because it is believed.
     */
    provider_id?: string;
  },
): Promise<void> {
  if (!writer) return;
  const t = spec.telemetry;
  // ── THE MODEL NAME MUST BE ON THE ROW THAT IS INSERTED ──────────────────
  //
  // `lead_execution_calls_model_call_names_model` is
  //
  //   record_kind <> 'model_call'
  //     OR (metadata ? 'model' AND length(coalesce(metadata->>'model','')) > 0)
  //
  // and a CHECK is evaluated on INSERT, not only on UPDATE. This function used
  // to insert first and attach `metadata.model` in the FOLLOWING `finalize`, so
  // the inserted row carried `metadata: null` — `buildStartedRow` hardcodes it —
  // and the constraint rejected every single one.
  //
  // NULL DOES NOT SAVE IT. `metadata ? 'model'` on a null column is NULL, but
  // the second conjunct `length(coalesce(null->>'model','')) > 0` is FALSE, and
  // `NULL AND FALSE` is FALSE in SQL. So the whole predicate is FALSE and the
  // row is refused — not the "NULL check passes" case that reasoning about the
  // first conjunct alone suggests. I made exactly that error while diagnosing
  // this and ruled the constraint out; it was the cause.
  //
  // `createLedgerWriter.insert` swallows anything that is not a unique
  // violation, by design, so the failure was silent. On lineage 4ef85feb the
  // collector drained 20 model calls across five slices and the table stayed
  // empty — which is precisely what the migration's own comment predicted would
  // happen if a `model_call` row were ever written without the model on it.
  //
  // The finalize below still writes the full metadata — token counts, effort,
  // latency, fallback reason. This carries only what the constraint demands, so
  // the row is admissible the moment it exists.
  const started = buildStartedRow({
    ...spec,
    record_kind: "model_call",
    // The vendor that ran it. Honest, and distinct from `agentory_internal`,
    // which is what a stage result — an observation we made ourselves — uses.
    provider_id: spec.provider_id ?? "openai",
    // `ExecutionStage` names the paid LEAD stages; none of them describes a
    // model call. The logical stage is `telemetry.role`, recorded below, and
    // claiming e.g. `company_discovery` here would put model rows into a funnel
    // they are not part of.
    stage: spec.stage ?? "other",
    reason: spec.reason ?? "unspecified",
  });
  const row = {
    ...started,
    metadata: {
      model: t.model,
      role: t.role,
      telemetry_version: t.version,
    } as Record<string, unknown>,
  };
  try {
    await writer.insert(row);
    await writer.finalize(row.id, {
      ...buildFinalPatch(row, {
      status: spec.ok ? "succeeded" : "failed",
      failure_code: spec.failure_code ?? null,
      failure_message: spec.failure_message ?? null,
      cost: {
        // NEVER `actual_usd`. See above — the counts are the provider's, the
        // prices are ours, and the database refuses the alternative.
        actual_usd: null,
        estimated_usd: t.estimated_cost_usd,
        source: t.cost_source,
      },
      metadata: {
        role: t.role,
        model: t.model,
        reasoning_effort: t.reasoning_effort,
        input_tokens: t.input_tokens,
        cached_input_tokens: t.cached_input_tokens,
        output_tokens: t.output_tokens,
        fallback_reason: t.fallback_reason,
        telemetry_version: t.version,
      },
      }),
      // THE MODEL'S LATENCY, NOT THE LEDGER'S.
      //
      // `buildFinalPatch` derives `duration_ms` from the wall clock between row
      // creation and finalize, which is right for a provider call the ledger
      // wraps in real time. A model call is recorded AFTER it returned, so that
      // figure would be the few milliseconds this function took — a latency
      // column full of near-zeroes, and a p95 that means nothing.
      duration_ms: t.latency_ms,
    });
  } catch (e) {
    // Swallowed like every other ledger failure: accounting must never be able
    // to take a run down. Logged loudly, because an empty model ledger and a
    // run that made no model calls look identical from the outside.
    console.error("[execution-ledger] model call failed", String(e));
  }
}

/**
 * Collects model telemetry during a stage, then writes it once the stage ends.
 *
 * ── WHY NOT WRITE FROM THE CALLBACK ───────────────────────────────────────
 *
 * `onModelCall` is synchronous, and the write is not. Calling `recordModelCall`
 * from inside it would leave a floating promise, which in an edge function can
 * be cut off the moment the response returns — so the rows most worth having,
 * the ones from a call that failed and ended the request, are exactly the ones
 * most likely to vanish.
 *
 * Collecting is synchronous and cannot fail. Draining is explicit, awaited, and
 * happens where the caller already knows the workspace and task.
 */
/**
 * LAYER 2: WHAT BOUNDS A CALL NOBODY CAN PRICE.
 *
 * ── WHY A SECOND LAYER AT ALL ──────────────────────────────────────────────
 *
 * `modelSpendCeiling` bounds a workspace in DOLLARS, which works only for
 * models `MODEL_PRICES` knows. Four models this system selects every day are
 * not in it — chat runs on `google/gemini-3-flash-preview` through the Lovable
 * gateway — and inventing prices for them would put an unverifiable number in
 * the audit trail. So they price as `unknown`, and a dollar ceiling cannot see
 * them at all.
 *
 * An unpriced model must not therefore be an unlimited one. Tokens and calls
 * are counted whatever the price is, so they are what bounds the half of the
 * bill nobody can value yet.
 *
 * ── WHY IT COUNTS ONLY UNPRICED CALLS ──────────────────────────────────────
 *
 * Because the priced half is already bounded, and double-bounding it would
 * make this ceiling fight the USD one. The heaviest real run made 95 model
 * calls and 688,303 tokens — all of them priced — so a shared ceiling low
 * enough to catch a chat loop would kill a legitimate lead mission. Layer 1
 * governs money; Layer 2 governs the calls money cannot yet be attached to.
 */
export interface ModelRunBudget {
  max_calls: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_total_tokens: number;
}

export type BudgetBreach =
  | "calls" | "input_tokens" | "output_tokens" | "total_tokens";

export interface ModelBudgetVerdict {
  /** May another model call be made? */
  allowed: boolean;
  /** Which bound was reached, if any. The honest answer regardless of mode. */
  exceeded: BudgetBreach | null;
  /** Unpriced usage so far. What the budget actually governs. */
  unpriced_calls: number;
  unpriced_input_tokens: number;
  unpriced_output_tokens: number;
  /** Priced spend so far, for the log line. Governed by Layer 1, not here. */
  priced_calls: number;
  priced_usd: number;
  budget: ModelRunBudget | null;
}

export class ModelCallCollector {
  private readonly calls: Array<{ telemetry: ModelCallTelemetry; ok: boolean }> = [];
  /**
   * Calls already drained by THIS collector. A second drain in the same run —
   * the failure-path flush after the success-path drain — continues the
   * sequence instead of restarting it, so its keys never collide with rows the
   * first drain wrote.
   */
  private drained = 0;

  /**
   * @param budget Bounds for UNPRICED calls. Omitted, nothing is bounded here
   *               and `check()` always allows — which is what every existing
   *               caller gets, unchanged.
   */
  constructor(private readonly budget: ModelRunBudget | null = null) {}

  /** The `onModelCall` seam, ready to pass to `GptDeps`. */
  readonly sink = (telemetry: ModelCallTelemetry, ok: boolean): void => {
    this.calls.push({ telemetry, ok });
  };

  get length(): number {
    return this.calls.length;
  }

  /**
   * May another model call be made?
   *
   * CONSULTED BEFORE A CALL, and before EVERY attempt in a fallback chain —
   * otherwise an exhausted budget would be bypassed by the next model down the
   * list, which is the failure this exists to prevent.
   *
   * A FAILED CALL STILL COUNTS. It reached the provider and may have been
   * billed, and a retry loop that only counted successes would be unbounded by
   * construction — exactly the shape of the runaway this guards.
   */
  check(): ModelBudgetVerdict {
    let unpriced = 0, inTok = 0, outTok = 0, pricedCalls = 0, usd = 0;
    for (const c of this.calls) {
      const t = c.telemetry;
      const cost = t.actual_cost_usd ?? t.estimated_cost_usd;
      // `unknown` is the marker `priceModelCall` sets for a model with no
      // price. It is NOT zero, and treating it as zero here would hand the
      // unpriced half of the bill an unlimited allowance.
      if (t.cost_source === "unknown" || cost === null) {
        unpriced++;
        inTok += t.input_tokens ?? 0;
        outTok += t.output_tokens ?? 0;
      } else {
        pricedCalls++;
        usd += cost;
      }
    }
    const base = {
      unpriced_calls: unpriced,
      unpriced_input_tokens: inTok,
      unpriced_output_tokens: outTok,
      priced_calls: pricedCalls,
      priced_usd: Math.round(usd * 1e6) / 1e6,
      budget: this.budget,
    };
    if (!this.budget) return { ...base, allowed: true, exceeded: null };
    const b = this.budget;
    const exceeded: BudgetBreach | null =
      unpriced >= b.max_calls ? "calls"
        : inTok >= b.max_input_tokens ? "input_tokens"
        : outTok >= b.max_output_tokens ? "output_tokens"
        : inTok + outTok >= b.max_total_tokens ? "total_tokens"
        : null;
    return { ...base, allowed: exceeded === null, exceeded };
  }

  /**
   * Write every collected call, then forget them.
   *
   * Cleared BEFORE the writes so a drain that partially fails cannot re-write
   * the rows it already wrote if it is called again — the ledger has no
   * uniqueness constraint that would catch a duplicate, and a double-counted
   * model call is a wrong bill rather than a loud error.
   */
  async drain(
    writer: LedgerWriter | null | undefined,
    spec: {
      workspace_id: string;
      task_id?: string | null;
      plan_id?: string | null;
      /** Prefix for the idempotency key; the role and index complete it. */
      logical_call_key: string;
    },
  ): Promise<number> {
    const pending = this.calls.splice(0, this.calls.length);
    const offset = this.drained;
    this.drained += pending.length;
    if (!writer) return 0;
    let written = 0;
    for (const [i, c] of pending.entries()) {
      await recordModelCall(writer, {
        ...spec,
        logical_call_key: `${spec.logical_call_key}:${c.telemetry.role}:${offset + i + 1}`,
        telemetry: c.telemetry,
        ok: c.ok,
        failure_code: c.ok ? null : c.telemetry.fallback_reason,
      });
      written++;
    }
    return written;
  }
}

// ── MODEL SPEND IS DURABLE ON EVERY EXIT ─────────────────────────────────────
//
// run-agent drained its collector in exactly one place, deep in the success
// path. The same-mission rerun of Lead V2 run 4250f181 (task 9144eaa4) made two
// planner calls (~$0.065) and then threw `ExecutionPlanBlockedError`: neither
// call reached `lead_model_calls`, so the daily spend ceiling — which sums that
// view — never saw them. A run that fails after spending was free to the meter.
//
// Armed once the collector and the task exist; flushed after the run settles,
// however it settled. `drain` empties the collector before writing, so a flush
// after the success-path drain writes only calls made after it, and a second
// flush writes nothing — exactly once, never twice.

export interface ModelDrainSpec {
  workspace_id: string;
  task_id?: string | null;
  plan_id?: string | null;
  logical_call_key: string;
}

export class PendingModelDrain {
  private armed: {
    collector: ModelCallCollector;
    writer: LedgerWriter | null | undefined;
    spec: () => ModelDrainSpec | null;
  } | null = null;

  /** `spec` is read at flush time: the task may not exist yet when this is armed. */
  arm(
    collector: ModelCallCollector,
    writer: LedgerWriter | null | undefined,
    spec: () => ModelDrainSpec | null,
  ): void {
    this.armed = { collector, writer, spec };
  }

  /** Write whatever the collector still holds. Never throws: bookkeeping must not fail a run. */
  async flush(): Promise<number> {
    const a = this.armed;
    if (!a || a.collector.length === 0) return 0;
    const spec = a.spec();
    if (!spec) return 0;
    try {
      return await a.collector.drain(a.writer, spec);
    } catch (e) {
      console.error("[execution-ledger] model drain on exit failed", String(e).slice(0, 200));
      return 0;
    }
  }
}

// ── SUPABASE-BACKED WRITER ──────────────────────────────────────────────────

/** The narrow slice of a Supabase client this module uses. */
export interface LedgerDb {
  from(table: string): {
    insert(values: unknown): Promise<{ error: unknown }>;
    update(values: unknown): { eq(col: string, val: string): Promise<{ error: unknown }> };
  };
}

export const LEAD_EXECUTION_CALLS_TABLE = "lead_execution_calls" as const;

/**
 * A writer backed by the real table.
 *
 * Every failure is swallowed after logging. This is deliberate and is the one
 * place where swallowing is correct: the ledger watches execution and must never
 * be able to fail it. A missing audit row is a gap in evidence; a thrown audit
 * write is a lost lead run.
 */
/**
 * Say what actually went wrong with a database write.
 *
 * `String(error)` on a PostgREST error object yields the literal text
 * "[object Object]", and that is exactly what every ledger failure has printed.
 * TEST run b7a9e112 logged four of them in eighty seconds; the table itself has
 * never held a single row on TEST. The swallow below is correct — the ledger
 * watches execution and must never be able to fail it — but a swallow that also
 * destroys the reason is not a swallow, it is a silence. Every paid Actor call
 * this system has made is unaudited, and nothing said why.
 *
 * PostgREST reports `message`, `details`, `hint` and `code`. All four are ours,
 * describe our own schema, and contain no row data — safe to log.
 */
export function describeDbError(error: unknown): string {
  const e = error as
    { message?: unknown; details?: unknown; hint?: unknown; code?: unknown } | null;
  if (!e || typeof e !== "object") return String(error);
  const parts = [
    typeof e.code === "string" && e.code ? `[${e.code}]` : null,
    typeof e.message === "string" && e.message ? e.message : null,
    typeof e.details === "string" && e.details ? `details: ${e.details}` : null,
    typeof e.hint === "string" && e.hint ? `hint: ${e.hint}` : null,
  ].filter((p): p is string => p !== null);
  // An object with none of those is still worth SOMETHING — better a JSON dump
  // than the string "[object Object]" that sent this one undiagnosed for weeks.
  if (parts.length === 0) {
    try { return JSON.stringify(e).slice(0, 400); } catch { return String(error); }
  }
  return parts.join(" ");
}

/**
 * The row, minus the field that is not a column.
 *
 * `version` is a module constant carried on the IN-MEMORY row for forward
 * compatibility — `executionLedgerWiring.test.ts` has said so since the table
 * was written, and exempts it from the "every column the writer sets exists"
 * check on exactly that grounds. The exemption was right about the intent and
 * wrong about the mechanism: nothing stripped it. `buildStartedRow`'s output
 * went to `db.insert()` verbatim, PostgREST rejected the whole row, and it has
 * done so every single time:
 *
 *     [execution-ledger] insert error [PGRST204] Could not find the 'version'
 *     column of 'lead_execution_calls' in the schema cache
 *
 * `lead_execution_calls` has held zero rows since it was created. Every paid
 * Actor call this system has made is unaudited, because a field everyone agreed
 * was not a column was sent to the database anyway.
 *
 * STRIPPED HERE, at the one place that talks to the table, rather than removed
 * from the row — in-process readers and the row's own type still carry it, which
 * is what the constant was for.
 */
function toDbRow<T extends { version?: unknown }>(row: T): Omit<T, "version"> {
  const { version: _version, ...rest } = row;
  return rest;
}

/**
 * Postgres 23505. Also matched by message, because PostgREST does not always
 * surface the SQLSTATE on a constraint violation.
 */
function isUniqueViolation(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string; details?: string };
  if (String(e.code ?? "") === "23505") return true;
  return /duplicate key value|unique constraint/i.test(
    `${e.message ?? ""} ${e.details ?? ""}`);
}

export function createLedgerWriter(db: LedgerDb): LedgerWriter {
  return {
    async insert(row) {
      // ── A COLLISION IS A LATER ATTEMPT, NOT A DUPLICATE ─────────────────
      //
      // `lead_execution_calls_attempt_uniq` is `(workspace_id,
      // logical_call_key, attempt_number)`. Now that the key spans a LINEAGE
      // rather than one task, a legitimate re-attempt in a later generation —
      // the first call failed, the frontier still holds the company — computes
      // the same key at `attempt_number: 1` and collides with the row the
      // earlier generation wrote.
      //
      // Dropping it would trade one defect for another: no duplicate charge,
      // but no record that the second attempt happened at all. So a unique
      // violation escalates the attempt number and tries again. The index
      // arbitrates, which makes this correct even without the lineage lease
      // holding two generations apart.
      //
      // MONEY IS NOT AT STAKE HERE. Charging is gated by `credits_reserve` on
      // the same key, which replays rather than reserving again; this loop only
      // decides whether the ATTEMPT is written down.
      const MAX_ATTEMPT_ESCALATION = 20;
      let attempt = row.attempt_number ?? 1;
      for (let i = 0; i < MAX_ATTEMPT_ESCALATION; i++) {
        const { error } = await db.from(LEAD_EXECUTION_CALLS_TABLE)
          .insert(toDbRow({ ...row, attempt_number: attempt }));
        if (!error) return;
        if (!isUniqueViolation(error)) {
          console.error("[execution-ledger] insert error", describeDbError(error));
          return;
        }
        attempt += 1;
      }
      console.error("[execution-ledger] insert error", {
        reason: "attempt_escalation_exhausted",
        logical_call_key: row.logical_call_key, tried_up_to: attempt - 1,
      });
    },
    async finalize(id, patch) {
      const { error } = await db.from(LEAD_EXECUTION_CALLS_TABLE)
        .update(toDbRow(patch)).eq("id", id);
      if (error) {
        console.error("[execution-ledger] finalize error", describeDbError(error));
        return false;
      }
      return true;
    },
  };
}

// ── STAGE INFERENCE ─────────────────────────────────────────────────────────
//
// Derived from the vocabulary the call sites ALREADY pass — `capability_key` and
// `source_type` — rather than requiring every caller to be edited. A caller that
// knows better may still pass `stage` and `reason` explicitly, and when canonical
// capabilities arrive this function is the single place that changes.

export function inferStage(
  capabilityKey: string | null | undefined,
  sourceType: string | null | undefined,
): ExecutionStage {
  const k = `${capabilityKey ?? ""} ${sourceType ?? ""}`.toLowerCase();
  if (/contact|email|phone/.test(k)) return "contact_enrichment";
  if (/people|person|founder|decision/.test(k)) return "person_resolution";
  if (/job|hiring/.test(k)) return "hiring_evidence";
  if (/company_details|company_enrich|enrich/.test(k)) return "company_enrichment";
  if (/company|discover|yc|search/.test(k)) return "company_discovery";
  return "other";
}

/**
 * A stable identity for one SEMANTIC provider purchase.
 *
 * Same lineage, capability and input hash ⇒ same key, so the same question asked
 * twice shares it and a different question does not.
 *
 * ── IT WAS KEYED ON THE TASK, AND THAT IS WHAT PAID TWICE ─────────────────
 *
 * The old doc said "same workspace, task, capability and input hash… so a
 * genuine retry of one question shares it". The premise is wrong in the one case
 * that matters: A CONTINUATION IS A DIFFERENT TASK ASKING THE SAME QUESTION.
 *
 * `providerOperationKey` has always known this — it is built from the lineage
 * root and its comment says so explicitly: "It excludes the task id and any
 * timestamp, because a continuation is a different task asking the same question
 * — and if the key changed per task, every resume would re-buy everything."
 *
 * Two keys for one idea, and the weaker one gated the money. On 2026-08-29,
 * lineage 06d3544a: identical input fingerprints, two generations, two paid runs
 * and two charges each —
 *
 *   298dc1a0  237717dd → FcGResJtI7CJGdOEa   0ed83116 → 8NnjlNJgwRcbdUH2M
 *   929a1a74  237717dd → QdMbpZGaNym2bzjZI   0ed83116 → EimrTjnSzy7TgIldA
 *   2df88a5a  237717dd → kCcPbdENXxrueROWZ   0ed83116 → EnRFGYQzHPSrwVQ5X
 *
 * — and an adoption that correctly reported `status: "reused"` was charged a
 * credit anyway, because its key differed from the one that bought the run.
 *
 * ── NOTHING ELSE HAD TO CHANGE ────────────────────────────────────────────
 *
 * The enforcement was already right, at both layers, and already race-safe:
 * `credit_transactions_idempotent UNIQUE (workspace_id, idempotency_key)` with
 * `credits_reserve` handling `unique_violation` by refunding and returning the
 * prior transaction; and `lead_execution_calls_attempt_uniq UNIQUE
 * (workspace_id, logical_call_key, attempt_number)`. Only the value written into
 * the key was wrong.
 *
 * `task_id` remains the fallback so a caller with no lineage — a one-off lead
 * action, a monitoring scan — behaves exactly as it does today. Such a task IS
 * its own lineage, which is the same rule `lineageRootOf` applies.
 */
export function logicalCallKey(args: {
  /** The lineage this call belongs to. Preferred over `task_id`. */
  lineage_root?: string | null;
  task_id?: string | null;
  capability?: string | null;
  stage: ExecutionStage;
  input_hash?: string | null;
}): string {
  return [
    args.lineage_root ?? args.task_id ?? "no-task",
    args.capability ?? args.stage,
    args.input_hash ?? "no-hash",
  ].join(":");
}
