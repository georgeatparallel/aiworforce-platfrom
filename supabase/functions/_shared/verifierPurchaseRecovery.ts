// D2 — A VERIFICATION AN EARLIER SLICE BOUGHT IS READ AGAIN, NEVER BOUGHT AGAIN.
//
// A claim verifier's purchase (`ledgerBoundCall`) was deduplicated only by the
// checkpointed spend ledger: an `executed` reservation under the same
// idempotency key is skipped. Verification runs after the last stage write, so
// when the end-of-slice write is lost — or the worker dies between the purchase
// and the write — the next slice restores a ledger from BEFORE the purchase and
// buys the same verification again, under the same key (chaos lab,
// tests/replay/failure/verificationLostWrite.test.ts; canary 8 LlamaIndex).
//
// The durable record exists: the transport writes a `lead_execution_calls` row
// when a call starts, attaches the provider run id as soon as the start POST
// returns it (`LedgerProgress`), and finalizes it in a `finally`. The
// idempotency index on that table is deliberately NOT unique, so the database
// cannot refuse the second purchase; this reads the rows instead, before any
// reservation or network.
//
//   a row WITH a run id      the run exists and was paid for: ADOPT it by run id
//                            (`resume_run_id` — a GET, recorded `reused`, never
//                            a second start), whatever the row's status says
//   a row that may have      `started` (the process died mid-call) or a timeout /
//   started a run, no id     abort before the run id came back: UNCERTAIN. Never
//                            bought again. Deferred while a live holder could
//                            still be attaching the id; then held unresolved
//   rows that cannot start   a provider refusal or error before any run: nothing
//                            was bought — buy as before
//   ledger unreadable        nothing can be ruled out: deferred, never bought
//
// Pure. run-agent reads the rows once per resumed slice, scoped to the task and
// workspace exactly as its completed/pending-run recovery is.

/** The `lead_execution_calls` columns this reads. */
export interface VerifierLedgerRow {
  idempotency_key: string | null;
  provider_run_id: string | null;
  status: string | null;
  started_at: string | null;
  failure_code?: string | null;
  /** Only `provider_call` rows are purchases; a `stage_result` row never is. */
  record_kind?: string | null;
}

export type PriorPurchase =
  /** A paid run this lineage can re-read by id. `status` is the ledger's, for the trace. */
  | { kind: "adopt"; run_id: string; status: string }
  /** A call that may have started a paid run whose id was never recorded. */
  | { kind: "uncertain"; started_at: string | null; status: string }
  /** The ledger could not be read: no purchase can be ruled out. */
  | { kind: "unknown"; reason: string };

export interface PriorPurchases {
  /** What the durable ledger knows about this idempotency key; null = nothing was bought under it. */
  lookup(idempotencyKey: string): PriorPurchase | null;
}

/**
 * How long an UNCERTAIN purchase is waited on before it is held unresolved.
 *
 * A row with no run id can still gain one only while the process that started
 * the call is alive — a stalled worker whose lease has lapsed (D1). That
 * process is bounded by the worker's lease and mission ceiling (180 s / 300 s);
 * a quarter of an hour is comfortably past both.
 */
export const UNCERTAIN_PURCHASE_SETTLE_MS = 15 * 60_000;

/** No purchases known: a first slice, or no rows. */
export const NO_PRIOR_PURCHASES: PriorPurchases = { lookup: () => null };

/** A ledger that could not be read rules nothing out. */
export function unreadablePriorPurchases(reason: string): PriorPurchases {
  return { lookup: () => ({ kind: "unknown", reason }) };
}

/** A failure before any run could exist is not a purchase; a timeout or abort might be. */
const MAY_HAVE_STARTED = /abort|time[d_ -]*out|timeout|network|fetch|connection|reset|socket|unfinished/i;

const FINISHED = new Set(["succeeded", "empty", "reused"]);
const IN_FLIGHT = new Set(["started", "timed_out"]);

function rank(status: string): number {
  if (FINISHED.has(status)) return 0;
  if (IN_FLIGHT.has(status)) return 1;
  return 2;
}

export function priorPurchasesFrom(rows: readonly VerifierLedgerRow[]): PriorPurchases {
  const byKey = new Map<string, PriorPurchase>();
  const better = (a: PriorPurchase, b: PriorPurchase): boolean => {
    // Any run id beats none; among run ids, a finished run beats one in flight beats a failed one.
    if (a.kind === "adopt" && b.kind !== "adopt") return true;
    if (a.kind !== "adopt" || b.kind !== "adopt") return false;
    return rank(a.status) < rank(b.status);
  };
  for (const r of rows) {
    if ((r.record_kind ?? "provider_call") !== "provider_call") continue;
    const key = typeof r.idempotency_key === "string" ? r.idempotency_key.trim() : "";
    if (!key) continue;
    const status = String(r.status ?? "");
    const runId = typeof r.provider_run_id === "string" ? r.provider_run_id.trim() : "";
    let p: PriorPurchase | null = null;
    if (runId) p = { kind: "adopt", run_id: runId, status };
    else if (status === "started" || status === "timed_out" ||
      (status === "failed" && MAY_HAVE_STARTED.test(String(r.failure_code ?? "")))) {
      p = { kind: "uncertain", started_at: r.started_at ?? null, status };
    }
    if (!p) continue;
    const cur = byKey.get(key);
    if (!cur || better(p, cur)) byKey.set(key, p);
    else if (cur.kind === "uncertain" && p.kind === "uncertain" &&
      String(p.started_at ?? "") > String(cur.started_at ?? "")) byKey.set(key, p);
  }
  return { lookup: (k) => byKey.get(k) ?? null };
}

/** Is an uncertain purchase still inside the window a live holder could attach its run id in? */
export function uncertainStillSettling(p: { started_at: string | null }, nowMs: number): boolean {
  const t = p.started_at ? Date.parse(p.started_at) : NaN;
  if (!Number.isFinite(t)) return false;
  return nowMs - t < UNCERTAIN_PURCHASE_SETTLE_MS;
}

// ── THE READ ────────────────────────────────────────────────────────────────

/** The slice of the PostgREST builder the read uses — a fake in tests. */
export interface VerifierLedgerQuery {
  select(columns: string): VerifierLedgerQuery;
  eq(column: string, value: unknown): VerifierLedgerQuery;
  not(column: string, operator: string, value: unknown): VerifierLedgerQuery;
  order(column: string, o: { ascending: boolean }): VerifierLedgerQuery;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}
export interface VerifierLedgerDb {
  from(table: string): VerifierLedgerQuery;
}

/** Newest first, bounded: a lineage's verifier purchases are a handful, never this many. */
export const VERIFIER_LEDGER_READ_LIMIT = 1000;

/**
 * What the execution ledger holds for this lineage's purchases. Scoped to the
 * PARENT task and the WORKSPACE — the ownership gate run-agent's completed-
 * and pending-run recovery use — so a run can only be adopted by the lineage
 * that paid for it. No parent (a first slice): nothing to know, nothing read.
 * A failed read rules nothing out.
 */
export async function readPriorPurchases(
  db: VerifierLedgerDb,
  scope: { table: string; parentTaskId: string | null; workspaceId: string },
  log: (msg: string, meta?: unknown) => void = () => {},
): Promise<PriorPurchases> {
  if (!scope.parentTaskId) return NO_PRIOR_PURCHASES;
  try {
    const { data, error } = await db.from(scope.table)
      .select("idempotency_key, provider_run_id, status, started_at, failure_code, record_kind")
      .eq("task_id", scope.parentTaskId)
      .eq("workspace_id", scope.workspaceId)
      .eq("record_kind", "provider_call")
      .not("idempotency_key", "is", null)
      .order("started_at", { ascending: false })
      .limit(VERIFIER_LEDGER_READ_LIMIT);
    if (error) {
      log("[verifier-purchase-recovery] read failed", String((error as { message?: unknown })?.message ?? error));
      return unreadablePriorPurchases("execution ledger read failed");
    }
    return priorPurchasesFrom((data ?? []) as VerifierLedgerRow[]);
  } catch (e) {
    log("[verifier-purchase-recovery] read threw", String(e));
    return unreadablePriorPurchases("execution ledger read threw");
  }
}
