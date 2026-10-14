// A WORKSPACE CANNOT SPEND WITHOUT LIMIT ON MODELS.
//
// ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────
//
// `toolRegistry` gates exactly two things: `PAID_TOOLS = {source_with_apify,
// scrape_url}`. Those reserve credits, write a ledger row, and settle. Model
// calls do none of it. The lead engine bounds itself per run — `calls_allowed`,
// `MAX_COMPILATION_ATTEMPTS`, the investigation budget — but chat has no
// ceiling of any kind, so a user in a loop is an unbounded bill.
//
// ── WHY NOT CREDITS ────────────────────────────────────────────────────────
//
// The obvious move is `authorizeProviderCall` with a new `model_call` kind. It
// is the wrong instrument. `CREDITS_PER_PROVIDER_CALL = 1`, and lineage
// `ab06540f` made over a hundred model calls against thirty-nine Apify calls —
// so a credit would stop meaning "a paid provider run" and start meaning
// "either a LinkedIn scrape or one sentence of chat", and every existing
// balance would silently revalue. It also needs the `kind` CHECK widened, and
// this file's neighbours record two separate outages caused by sending a value
// a CHECK did not permit.
//
// Models are priced per token, not per call, and `lead_model_calls` already
// carries `workspace_id`, `estimated_cost_usd`, `actual_cost_usd` and
// `cost_source` for every call the lead engine makes. The ceiling is therefore
// a SUM OVER MONEY ALREADY RECORDED, which is also the shape `monitoring_
// budgets` uses (`period_ceiling` + `period_days`) for the same problem.
//
// ── A CEILING OVER UNRECORDED SPEND IS THEATRE ─────────────────────────────
//
// This only works on calls that reach `lead_model_calls`. 255 of the 256 rows
// there belong to the lead engine; chat writes to `activity_feed` with no token
// counts and no cost at all. So capture comes first and enforcement second, and
// `unpriced_calls` below exists to make the remaining blind spot loud instead
// of letting it read as $0.00 and a clean bill of health.

/** Env knob, mirroring `LEAD_CREDIT_ENFORCEMENT`. */
export const MODEL_SPEND_ENFORCEMENT_ENV = "MODEL_SPEND_ENFORCEMENT";
export const MODEL_SPEND_CEILING_ENV = "MODEL_SPEND_CEILING_USD";
export const MODEL_SPEND_PERIOD_ENV = "MODEL_SPEND_PERIOD_DAYS";

export const MODEL_SPEND_CEILING_VERSION = "model-spend-ceiling-v1" as const;

/**
 * OBSERVE UNTIL PROVEN, which is how credit enforcement was introduced here.
 *
 * A ceiling that refuses on its first day, computed from a meter that has never
 * run in production, would take the one working product down to fix a bill
 * nobody has yet received. `observe` reports the verdict and permits the call;
 * `enforce` acts on it.
 */
export type SpendEnforcementMode = "observe" | "enforce";

export type EnvReader = (key: string) => string | undefined;

export function resolveSpendEnforcement(read?: EnvReader): SpendEnforcementMode {
  const r = read ?? ((k: string) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
    .Deno?.env.get(k));
  // FAIL CLOSED (launch hardening, 2026-09-28): only the exact word `observe`
  // disarms the ceiling. Unset, or a typo, enforces it — and an enforced
  // ceiling that was never configured refuses (`ceiling_misconfigured`), so a
  // deploy must set MODEL_SPEND_CEILING_USD and MODEL_SPEND_PERIOD_DAYS.
  return String(r(MODEL_SPEND_ENFORCEMENT_ENV) ?? "").trim().toLowerCase() === "observe"
    ? "observe"
    : "enforce";
}

/**
 * Default ceiling, per workspace, per period.
 *
 * This workspace has spent $0.65 on models across its entire history, and the
 * heaviest single lineage — 149 companies, fourteen generations — cost $0.34.
 * $25 a day is therefore roughly seventy of the largest runs this product has
 * ever done: high enough that no honest use meets it, low enough that a runaway
 * loop is caught the same day rather than at the end of the month.
 *
 * It is a BOUND, not a budget. Nothing should ever be tuned against it.
 */
export const DEFAULT_CEILING_USD = 25;
export const DEFAULT_PERIOD_DAYS = 1;

function positiveNumber(raw: string | undefined): number | null {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface CeilingConfig {
  ceiling_usd: number;
  period_days: number;
  /**
   * Null when both values were configured and valid. Otherwise which one was
   * missing or unusable — and the numbers above are the defaults, which
   * `observe` may use and `enforce` must NOT (see `authorizeModelSpend`).
   */
  config_error: string | null;
}

/**
 * THE CONFIGURED BOUND, and whether it really was configured.
 *
 * A missing or unusable value used to fall back to the default silently. For
 * `observe` that is still right: it only reports. For `enforce` it is not — a
 * typo in the ceiling would quietly become $25 a day, a bound nobody chose. So
 * the fallback is reported as `config_error`, and enforcement refuses on it.
 */
export function resolveCeiling(read?: EnvReader): CeilingConfig {
  const r = read ?? ((k: string) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
    .Deno?.env.get(k));
  const ceiling = positiveNumber(r(MODEL_SPEND_CEILING_ENV));
  const period = positiveNumber(r(MODEL_SPEND_PERIOD_ENV));
  const problems = [
    ceiling === null ? `${MODEL_SPEND_CEILING_ENV} missing or not a positive number` : null,
    period === null ? `${MODEL_SPEND_PERIOD_ENV} missing or not a positive number` : null,
  ].filter(Boolean);
  return {
    ceiling_usd: ceiling ?? DEFAULT_CEILING_USD,
    period_days: period ?? DEFAULT_PERIOD_DAYS,
    config_error: problems.length ? problems.join("; ") : null,
  };
}

export interface SpendVerdict {
  /** May the call proceed? In `observe` this is true even when over. */
  allowed: boolean;
  /** Is the workspace actually over? The honest answer, both modes. */
  over_ceiling: boolean;
  mode: SpendEnforcementMode;
  spent_usd: number;
  ceiling_usd: number;
  period_days: number;
  /**
   * Calls in the period whose cost could not be priced.
   *
   * NOT ZERO-COST. `MODEL_PRICES` covers the `gpt-5.6-*` family and nothing
   * else, so a `claude-haiku-4-5` or `gpt-5-mini` call prices as `unknown` and
   * contributes nothing to `spent_usd`. Surfaced separately so the gap is
   * visible in the log line rather than showing up as a clean bill.
   */
  unpriced_calls: number;
  /** Machine-readable, never prose. */
  reason: "under_ceiling" | "over_ceiling" | "query_failed" | "no_workspace" | "ceiling_misconfigured";
  detail: string | null;
}

/** The smallest surface of the database this needs. Injected in tests. */
export interface SpendDb {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        gte(col: string, val: unknown): Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
}

/**
 * Sum the period's model spend and say whether another call is allowed.
 *
 * NEVER THROWS. A ceiling that can fail a run by being unreachable is a new
 * outage surface, so every failure becomes a verdict with a reason, never an
 * exception.
 *
 * ── ENFORCE FAILS CLOSED ─────────────────────────────────────────────────────
 *
 * `observe` permits whatever it cannot measure; that is what it is for. `enforce`
 * used to permit it too — an unreadable meter, a call with no workspace, a
 * ceiling that fell back to a default — on the theory that the Apify and
 * Firecrawl credit reservations still bounded the expensive half of the bill.
 * But "enforced" has to mean the bound holds when something is wrong, and those
 * are exactly the moments it did not. So in `enforce`:
 *
 *   meter query fails ............ refuse   (reason: query_failed)
 *   no workspace to meter ........ refuse   (reason: no_workspace)
 *   ceiling/period not configured  refuse   (reason: ceiling_misconfigured)
 *
 * Every caller already requires a workspace before it gets here, so the
 * no-workspace refusal only ever catches spend that nothing could attribute.
 */
export async function authorizeModelSpend(i: {
  db: SpendDb;
  workspace_id: string | null | undefined;
  mode: SpendEnforcementMode;
  ceiling_usd?: number;
  period_days?: number;
  /** From `resolveCeiling`: non-null when the ceiling was not really configured. */
  config_error?: string | null;
  now?: number;
}): Promise<SpendVerdict> {
  const ceiling_usd = i.ceiling_usd ?? DEFAULT_CEILING_USD;
  const period_days = i.period_days ?? DEFAULT_PERIOD_DAYS;
  const enforce = i.mode === "enforce";
  const base = {
    mode: i.mode, ceiling_usd, period_days, spent_usd: 0, unpriced_calls: 0,
  };

  // A bound nobody configured is not a bound. Checked first: nothing about the
  // meter matters if the number it is compared against was never chosen.
  if (i.config_error) {
    return {
      ...base, allowed: !enforce, over_ceiling: false, reason: "ceiling_misconfigured",
      detail: i.config_error.slice(0, 200),
    };
  }

  // A call with no workspace cannot be attributed, so it cannot be metered.
  if (!i.workspace_id) {
    return { ...base, allowed: !enforce, over_ceiling: false, reason: "no_workspace", detail: null };
  }

  const since = new Date((i.now ?? Date.now()) - period_days * 86_400_000).toISOString();
  let rows: Array<Record<string, unknown>>;
  try {
    const { data, error } = await i.db
      .from("lead_model_calls")
      .select("estimated_cost_usd, actual_cost_usd, cost_source")
      .eq("workspace_id", i.workspace_id)
      .gte("started_at", since);
    if (error) {
      return {
        ...base, allowed: !enforce, over_ceiling: false, reason: "query_failed",
        detail: String((error as { message?: unknown })?.message ?? error).slice(0, 200),
      };
    }
    rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
  } catch (e) {
    return {
      ...base, allowed: !enforce, over_ceiling: false, reason: "query_failed",
      detail: String(e).slice(0, 200),
    };
  }

  let spent = 0;
  let unpriced = 0;
  for (const r of rows) {
    // ACTUAL BEFORE ESTIMATED, and an unpriced call is counted, not assumed
    // free — the same distinction `priceModelCall` draws and for the same
    // reason: during a provider outage every row reports no usage, and reading
    // that as $0 would show an untouched bill while nothing worked.
    //
    // NULL IS ABSENT, NOT ZERO. `Number(null)` is 0, which is finite — so a row
    // with no reported charge read as a reported charge of $0 and its estimate
    // was never consulted. Every model row is like that (the database refuses
    // `actual_cost_usd` from anything but `provider_reported`, and no provider
    // reports one), so the meter summed $0 for all of them. Measured in
    // production, 2026-09-11: 269 rows in 30 days, estimates $0.687354, meter $0.
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
    const actual = num(r["actual_cost_usd"]);
    const est = num(r["estimated_cost_usd"]);
    const v = Number.isFinite(actual) ? actual : Number.isFinite(est) ? est : null;
    if (v === null || r["cost_source"] === "unknown") unpriced++;
    if (v !== null) spent += v;
  }
  spent = Math.round(spent * 1e6) / 1e6;

  const over = spent >= ceiling_usd;
  return {
    ...base,
    spent_usd: spent,
    unpriced_calls: unpriced,
    over_ceiling: over,
    // The whole point of `observe`: the verdict is computed and reported, and
    // the call proceeds anyway.
    allowed: over ? i.mode === "observe" : true,
    reason: over ? "over_ceiling" : "under_ceiling",
    detail: null,
  };
}

/**
 * What a refused caller tells the user. Says WHY: "you reached your ceiling"
 * for a meter that could not be read would be a false statement about spend.
 */
export function spendRefusalMessage(v: SpendVerdict): string {
  switch (v.reason) {
    case "over_ceiling":
      return `This workspace has reached its model spend ceiling of $${v.ceiling_usd} over ` +
        `${v.period_days} day(s). Spent so far: $${v.spent_usd.toFixed(4)}.`;
    case "query_failed":
      return "Model spend could not be verified against this workspace's ceiling, so the " +
        "request was refused rather than run unmetered. Try again shortly.";
    case "no_workspace":
      return "Model spend with no workspace cannot be metered, so it was refused.";
    case "ceiling_misconfigured":
      return "The model spend ceiling is not configured correctly, so model spend is refused " +
        "until it is fixed.";
    default:
      return "Model spend was refused.";
  }
}

/** What a caller should log. Never includes a prompt or a key. */
export function describeSpend(v: SpendVerdict): Record<string, unknown> {
  return {
    version: MODEL_SPEND_CEILING_VERSION,
    mode: v.mode,
    allowed: v.allowed,
    over_ceiling: v.over_ceiling,
    spent_usd: v.spent_usd,
    ceiling_usd: v.ceiling_usd,
    period_days: v.period_days,
    unpriced_calls: v.unpriced_calls,
    reason: v.reason,
    detail: v.detail,
  };
}

/**
 * LAYER 2 LIMITS, from configuration, for UNPRICED calls.
 *
 * Returns null unless `MODEL_RUN_MAX_CALLS` is set, so the default is exactly
 * today's behaviour and turning the bound on is a config change rather than a
 * deploy. The other three fall back to generous multiples of it only when it is
 * present — a half-configured budget that silently bounded tokens at zero would
 * be an outage dressed as a safety feature.
 *
 * The numbers are deliberately NOT defaulted to a guess. Real observed usage:
 * the heaviest run made 95 model calls and 688,303 tokens, and a chat turn
 * makes one to four. A limit is a decision about which of those to allow, and
 * it belongs in configuration where it can be read, not in a constant here.
 */
export const RUN_MAX_CALLS_ENV = "MODEL_RUN_MAX_CALLS";
export const RUN_MAX_ALL_CALLS_ENV = "MODEL_RUN_MAX_ALL_CALLS";
export const RUN_MAX_INPUT_ENV = "MODEL_RUN_MAX_INPUT_TOKENS";
export const RUN_MAX_OUTPUT_ENV = "MODEL_RUN_MAX_OUTPUT_TOKENS";
export const RUN_MAX_TOTAL_ENV = "MODEL_RUN_MAX_TOTAL_TOKENS";

export function resolveRunBudget(read?: EnvReader): {
  max_calls: number; max_input_tokens: number;
  max_output_tokens: number; max_total_tokens: number;
  max_all_calls?: number; require_priced?: boolean;
} | null {
  const r = read ?? ((k: string) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
    .Deno?.env.get(k));
  const allRaw = r(RUN_MAX_ALL_CALLS_ENV);
  const all = allRaw === undefined ? undefined : Number(allRaw.trim());
  const max_all_calls = all === undefined ? undefined : Number.isSafeInteger(all) && all >= 0 && allRaw?.trim() !== "" ? all : 0;
  const pricedRaw = r("MODEL_RUN_REQUIRE_PRICED");
  const require_priced = pricedRaw !== undefined && pricedRaw !== "false";
  const legacy = Number(String(r(RUN_MAX_CALLS_ENV) ?? "").trim());
  if ((!Number.isFinite(legacy) || legacy <= 0) && max_all_calls === undefined && !require_priced) return null;
  const calls = Number.isFinite(legacy) && legacy > 0 ? legacy : max_all_calls ?? Number.MAX_SAFE_INTEGER;
  const n = (key: string, fallback: number) => {
    const v = Number(String(r(key) ?? "").trim());
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const input = n(RUN_MAX_INPUT_ENV, calls * 40_000);
  const output = n(RUN_MAX_OUTPUT_ENV, calls * 4_000);
  return {
    max_calls: calls,
    max_input_tokens: input,
    max_output_tokens: output,
    max_total_tokens: n(RUN_MAX_TOTAL_ENV, input + output),
    ...(max_all_calls === undefined ? {} : { max_all_calls }),
    ...(require_priced ? { require_priced } : {}),
  };
}

/** The error a refused call surfaces. */
export const MODEL_SPEND_REFUSED = "model_spend_ceiling_reached" as const;
