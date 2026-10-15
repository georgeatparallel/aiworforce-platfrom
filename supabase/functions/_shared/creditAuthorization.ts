// PAID PROVIDER WORK NEEDS AUTHORIZATION, AND A WARNING IS NOT AUTHORIZATION.
//
// ── WHAT THE AUDIT FOUND ────────────────────────────────────────────────────
//
// The credit ledger is not missing. `credits_reserve`, `credits_finalize`,
// `credits_release_stale` and `credits_grant` have existed since 2026-08-07 and
// are correct: idempotency is checked BEFORE money moves, concurrency is
// controlled by a conditional `UPDATE ... WHERE balance_credits >= p_amount`
// whose own comment reads "there is no window in which both observe the same
// balance", finalize is row-locked and replay-safe and can never charge more
// than was reserved, and a reaper releases reservations orphaned by a crash.
//
// Exactly one edge function calls any of it: `unlock-founders`. The lead path —
// orchestrate → run-agent → the capability engine → Apify — never touches it.
// `src/lib/credits/ledger.ts` is consumed only by React components: it
// displays, it does not enforce. That is why the UI can say "0 credits left"
// while a run spends real money, and why `credit_transactions` holds zero rows
// and `workspace_credit_balances` holds none at all.
//
// So this module does not design a credit system. It routes provider execution
// through the one that already exists.
//
// ── WHERE THIS SITS, AND WHY THERE ──────────────────────────────────────────
//
// At the PHYSICAL call, in `runTool`, beside the ledger write — not at the
// planning layer. A future code path that reaches a provider without knowing
// about credits is the failure mode being designed out, and the only defence
// against it is that the money boundary and the call boundary are the same
// line of code.
//
// ── RESERVE, THEN SETTLE ────────────────────────────────────────────────────
//
// One credit per paid provider call, reserved before the call and settled
// after. Credits stay an INTERNAL unit — dollars live in the execution ledger
// with their own provenance, and the two are never converted into each other.
//
// Settling matters even at one credit: a call that never started refunds, so a
// run that is refused or dies before dispatch does not quietly consume the
// balance it never used.
//
// The idempotency key is `logical_call_key`, which the ledger already computes
// and already treats as the identity of a call. A retried or replayed call
// therefore reserves nothing further — the RPC returns the original
// transaction — which is what makes continuation and retry safe here.

import { APIFY_START_UNCERTAIN } from "./verifierPurchaseRecovery.ts";
import { FIRECRAWL_UNCERTAIN } from "./smokeAdmissionRefusal.ts";

export const CREDIT_AUTHORIZATION_VERSION = "credit-authorization-v1" as const;

/** The env var that decides whether a refusal stops the call. */
export const CREDIT_ENFORCEMENT_ENV = "LEAD_CREDIT_ENFORCEMENT";

/**
 * How a refusal is treated.
 *
 * `observe` RESERVES AND SETTLES EXACTLY AS `enforce` DOES. The only difference
 * is what happens when the reserve is refused: observe records it and lets the
 * call proceed. It is not a bypass switch bolted beside the real path — it is
 * the real path with the last step disarmed, so what is proved in observe mode
 * is the thing that will run in enforce mode.
 *
 * DEFAULT IS `enforce` — FAIL CLOSED (launch hardening, 2026-09-28).
 *
 * It was `observe`, because `workspace_credit_balances` was empty and flipping
 * it on would have refused every provider call. With open signup that default
 * meant any new account could spend without limit whenever the variable was
 * unset. Credits are now granted to approved beta workspaces
 * (`scripts/beta/grant-credits.ts`), so the safe default is to refuse: only the
 * exact word `observe` disarms it, and a typo cannot. The mode is recorded on
 * every decision, so "why did this spend?" is answerable without reading the
 * environment.
 */
export type CreditEnforcementMode = "observe" | "enforce";

export type EnvReader = (key: string) => string | undefined;

export function resolveCreditEnforcement(read?: EnvReader): CreditEnforcementMode {
  const get: EnvReader = read ?? ((k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  });
  return (get(CREDIT_ENFORCEMENT_ENV) ?? "").trim().toLowerCase() === "observe"
    ? "observe"
    : "enforce";
}

/** What one paid provider call costs in internal credits. */
export const CREDITS_PER_PROVIDER_CALL = 1;

/** The smallest surface of the database this module needs. Injected in tests. */
export interface CreditDb {
  rpc(
    fn: string, args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

export interface CreditAuthorization {
  /** May the call proceed? In `observe` this is true even when refused. */
  allowed: boolean;
  /** Did the ledger actually grant the reservation? The honest answer. */
  reserved: boolean;
  mode: CreditEnforcementMode;
  transaction_id: string | null;
  /** Machine-readable, never prose. */
  reason:
    | "reserved"
    | "replayed"
    | "insufficient_credits"
    | "rpc_error"
    | "not_attempted";
  balance_after: number | null;
  detail: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Reserve the credits for one provider call.
 *
 * NEVER THROWS. A credit system that can fail a run by being unreachable is a
 * new outage surface; an unreachable ledger degrades to `rpc_error`, which
 * `observe` permits and `enforce` refuses — and refusing is the safe direction
 * when the question "may we spend?" cannot be answered.
 */
export async function authorizeProviderCall(i: {
  db: CreditDb;
  workspace_id: string;
  logical_call_key: string;
  task_id?: string | null;
  capability?: string | null;
  mode: CreditEnforcementMode;
  amount?: number;
  /**
   * The authority this call spends under.
   *
   * Decides the LEDGER KIND, and nothing else. Unattended monitoring has a
   * period ceiling and a person clicking Scan does not, so a period total has
   * to be able to tell them apart — and `task_id IS NULL` cannot, because a
   * Radar scan is taskless too. The distinction is who decided to spend, which
   * the persistence authority already records.
   */
  persistence_authority?: string | null;
}): Promise<CreditAuthorization> {
  const mode = i.mode;
  const amount = i.amount ?? CREDITS_PER_PROVIDER_CALL;
  const refuse = (
    reason: CreditAuthorization["reason"], detail: string | null, balance: number | null,
  ): CreditAuthorization => ({
    // THE ONE LINE THAT DIFFERS BETWEEN THE MODES.
    allowed: mode === "observe",
    reserved: false,
    mode, transaction_id: null, reason, balance_after: balance, detail,
  });

  if (!i.workspace_id || !i.logical_call_key) {
    return refuse("not_attempted", "no workspace or call key to reserve against", null);
  }

  try {
    const { data, error } = await i.db.rpc("credits_reserve", {
      p_workspace: i.workspace_id,
      p_amount: amount,
      p_idempotency_key: i.logical_call_key,
      p_kind: i.persistence_authority === "monitoring_engine"
        ? "monitoring_call"
        : "provider_call",
      p_task_id: i.task_id ?? null,
      p_company_key: i.capability ?? null,
    });
    if (error) {
      return refuse("rpc_error", describeRpcError(error), null);
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok !== true) {
      const why = str(r.error) === "insufficient_credits"
        ? "insufficient_credits"
        : "rpc_error";
      return refuse(
        why,
        `${str(r.error) ?? "refused"}: balance ${num(r.balance) ?? 0}, needed ${num(r.needed) ?? amount}`,
        num(r.balance),
      );
    }
    return {
      allowed: true,
      reserved: true,
      mode,
      transaction_id: str(r.transaction_id),
      // A REPLAY IS NOT A SECOND RESERVATION. The RPC returns the original
      // transaction, so a retried call spends nothing further and this says so.
      reason: r.replayed === true ? "replayed" : "reserved",
      balance_after: num(r.balance_after),
      detail: null,
    };
  } catch (e) {
    return refuse("rpc_error", String(e).slice(0, 200), null);
  }
}

/**
 * Settle a reservation once the call is over.
 *
 * `started: false` refunds in full. A call refused before dispatch, or one that
 * adopted an already-paid run, consumed nothing and must not be charged — the
 * reserve/settle pair is what makes that expressible at all.
 *
 * Never throws, and a failure here is deliberately quiet: `credits_release_stale`
 * is the backstop for a reservation nobody settled, so an unsettled transaction
 * is recoverable while a thrown error mid-run is not.
 */
export async function settleProviderCall(i: {
  db: CreditDb;
  transaction_id: string | null;
  started: boolean;
  amount?: number;
  reason?: string | null;
}): Promise<{ settled: boolean; charged: number; detail: string | null }> {
  if (!i.transaction_id) return { settled: false, charged: 0, detail: "no reservation" };
  const charged = i.started ? (i.amount ?? CREDITS_PER_PROVIDER_CALL) : 0;
  try {
    const { data, error } = await i.db.rpc("credits_finalize", {
      p_transaction_id: i.transaction_id,
      p_actual: charged,
      // ── THE STATUS THE SCHEMA ACTUALLY ACCEPTS ──────────────────────────
      //
      // This read `"consumed"`, which `credit_transactions_status_check` has
      // never allowed. The permitted set is:
      //
      //     reserved · charged · partial · not_charged · released · granted
      //
      // So EVERY settle threw a constraint violation, was caught by the guard
      // below, and returned `settled: false`. Ninety reservations from two
      // radar scans sat `reserved` — 90 credits held, none charged, none
      // released — until the stale reaper would have freed them.
      //
      // SECOND TIME IN THIS FILE. `kind` had the identical defect: the code
      // sent `provider_call`, which the kind CHECK did not permit, and every
      // RESERVE threw. That one was found by running the RPC directly; this one
      // survived because the proof exercised `credits_finalize` with a VALID
      // status by hand and never checked what the caller actually sends.
      //
      // Proving an RPC works is not proving the code calls it correctly.
      p_status: i.started ? "charged" : "not_charged",
      p_reason: i.reason ?? null,
    });
    if (error) return { settled: false, charged: 0, detail: describeRpcError(error) };
    const r = (data ?? {}) as Record<string, unknown>;
    return r.ok === true
      ? { settled: true, charged: num(r.actual_credits) ?? charged, detail: null }
      : { settled: false, charged: 0, detail: str(r.error) };
  } catch (e) {
    return { settled: false, charged: 0, detail: String(e).slice(0, 200) };
  }
}

/**
 * What to do with a call's reservation once the call is over.
 *
 * `settle` with `started` is the normal case: a call that reached the provider
 * (it succeeded, or it failed with a run id) is charged; one that never did is
 * refunded whole.
 *
 * `hold` is for an UNCERTAIN START (`APIFY_START_UNCERTAIN`): the POST was
 * aborted or lost, Apify answered 5xx, or a 2xx named no run. The run may exist
 * and be billed, so refunding now would assert that nothing was bought, which
 * nobody knows. The reservation stays `reserved` instead. It resolves by the
 * explicit policy in force today: `credits_release_stale` releases it once it is
 * 30 minutes old (refund; the provider cost, if any, is absorbed). A
 * reconciler that finds the run could settle it as charged before then; none
 * exists yet. If the same key is ever really bought later, the held re-arm fix
 * (20261015130000) charges that purchase.
 *
 * A definite refusal (`apify_start_failed` on a 4xx) is not uncertain: no run
 * exists, and it is refunded as before.
 *
 * `FIRECRAWL_UNCERTAIN` is held the same way. It is produced ONLY under the
 * opt-in smoke admission (smokeAdmissionRefusal.ts), so outside the smoke the
 * Firecrawl settlement, and customer billing, are exactly as before.
 */
export type CreditSettlement =
  | { action: "settle"; started: boolean }
  | { action: "hold"; reason: string };

export function creditSettlementFor(
  result: { ok: boolean; error?: unknown; data?: unknown },
): CreditSettlement {
  const runId = (result.data as { run_id?: unknown } | null | undefined)?.run_id;
  const started = result.ok || typeof runId === "string";
  const error = typeof result.error === "string" ? result.error : "";
  if (!started && (error.startsWith(APIFY_START_UNCERTAIN) || error.startsWith(FIRECRAWL_UNCERTAIN))) {
    return { action: "hold", reason: error.slice(0, 80) };
  }
  return { action: "settle", started };
}

/**
 * Say what an RPC error was, rather than "[object Object]".
 *
 * The same defect that kept `lead_execution_calls` empty for its entire
 * existence — `String()` on a PostgREST error object — would keep every credit
 * refusal undiagnosable here.
 */
export function describeRpcError(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; details?: unknown } | null;
  if (!e || typeof e !== "object") return String(error);
  const parts = [
    typeof e.code === "string" && e.code ? `[${e.code}]` : null,
    typeof e.message === "string" ? e.message : null,
    typeof e.details === "string" && e.details ? `details: ${e.details}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length > 0) return parts.join(" ");
  try { return JSON.stringify(e).slice(0, 300); } catch { return String(error); }
}

/** The error a refused call reports, so callers can tell it from a provider fault. */
export const CREDIT_REFUSED_ERROR = "credit_authorization_refused" as const;
