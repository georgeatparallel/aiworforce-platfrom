// How a smoke-admission refusal looks to the transports (smokeAdmission.ts).
// Kept apart, with no imports, so the edge bundles that read it carry nothing
// of the worker-only gate.

export const SMOKE_ADMISSION_ENV = "DISCOVERY_SMOKE_ADMISSION";

/** Only omission or an explicit "off" disables it; any other value enforces. */
export function smokeAdmissionEnforced(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "" && raw.trim().toLowerCase() !== "off";
}

/** Carried by the gate function (smokeAdmission.ts `createAdmissionFetch`). */
export const ADMISSION_GATE_MARK = Symbol.for("agentory.smokeAdmissionGate");

/**
 * True when the process's `fetch` IS the admission gate — which the worker
 * installs only when DISCOVERY_SMOKE_ADMISSION is enforced. Read at call time.
 */
export function smokeAdmissionActive(): boolean {
  const f = globalThis.fetch as unknown as Record<symbol, unknown> | undefined;
  return f?.[ADMISSION_GATE_MARK] === true;
}

/**
 * A Firecrawl purchase whose outcome is unknown, IN SMOKE MODE ONLY: the POST
 * reached Firecrawl (or may have) and no document came back — a 5xx, a lost
 * connection, or a replay the gate refused as possibly already bought.
 * Settled like `apify_start_uncertain`: the credit is HELD, never refunded on
 * the strength of a missing answer (Codex review R2). Outside smoke mode the
 * error codes, and customer billing, are unchanged.
 */
export const FIRECRAWL_UNCERTAIN = "firecrawl_uncertain";

export const ADMISSION_REFUSED_STATUS = 409;
export const ADMISSION_REFUSED_TYPE = "mission_admission_refused";

/** True for a gate refusal as the transports read it back (`{ status, data }`). */
export function isAdmissionRefusal(r: { status?: number; data?: unknown } | null | undefined): boolean {
  const e = (r?.data as { error?: { type?: unknown } } | null | undefined)?.error;
  return r?.status === ADMISSION_REFUSED_STATUS && e?.type === ADMISSION_REFUSED_TYPE;
}

// ── THE SMOKE'S APIFY READ LIFECYCLE ─────────────────────────────────────────
//
// In the smoke, every status, dataset, resume and receipt GET is one admitted
// read, and the mission has five in all (`provider_polls`). One Apify run's
// complete lifecycle is three of them:
//
//   status   long-polled (`waitForFinish`, at most 60 s) until terminal
//   dataset  the rows the run produced (SUCCEEDED only)
//   receipt  a status read made ≥ 10 s after the run finished, the figure
//            Apify calls settled ("the first response after completion can
//            still show preliminary … costs"); skipped when the terminal
//            status read was itself already settled
//
// A read is only spent when the reads AND the time for everything after it
// are still there; otherwise the run is left pending, its id durable, and its
// receipt explicitly unsettled. Pure: the caller supplies the state.

export const SMOKE_READ_STATE_MARK = Symbol.for("agentory.smokeReadState");
/** What the mission has left: reads from the database, time from the slice, the wall clock and the authorization. */
export interface SmokeReadState { readsLeft: number | null; remainingMs: number | null }

/** The gate's view, at call time; null outside the smoke. */
export async function smokeReadState(): Promise<SmokeReadState | null> {
  const f = globalThis.fetch as unknown as Record<symbol, unknown> | undefined;
  const read = f?.[SMOKE_READ_STATE_MARK];
  return typeof read === "function" ? await (read as () => Promise<SmokeReadState>)() : null;
}

/** Apify's documented maximum for `waitForFinish` (actor-run-get, act-runs-post). */
export const APIFY_MAX_WAIT_S = 60;
/** Apify: wait about 10 s after completion for stable costs. */
export const APIFY_SETTLE_MS = 10_000;
/** Client timeout beyond the server-side wait. */
export const SMOKE_READ_SLACK_MS = 10_000;
/** The existing client timeouts of the start, the dataset read and a plain status read. */
export const APIFY_START_TIMEOUT_MS = 20_000;
export const APIFY_DATASET_TIMEOUT_MS = 20_000;
export const APIFY_RECEIPT_TIMEOUT_MS = 10_000;
/** A long poll shorter than this is not worth a read. */
export const SMOKE_MIN_WAIT_S = 5;
/** Reads one run still needs after a status read: its dataset and its receipt. */
export const SMOKE_READS_AFTER_STATUS = 2;
/** Time everything after a status read can take: dataset, settling, receipt. */
export const SMOKE_TAIL_MS = APIFY_DATASET_TIMEOUT_MS + APIFY_SETTLE_MS + APIFY_RECEIPT_TIMEOUT_MS;
/** The source a settled Apify figure is recorded under (`report_source`). */
export const APIFY_SETTLED_SOURCE = "apify_run(settled).receipt";

export type SmokeReadPlan = { ok: true; waitS: number; timeoutMs: number } | { ok: false; reason: string };

/**
 * May a new Apify run be STARTED? Not when its whole lifecycle (three reads
 * and the time for them) is known not to fit. Decided by the GATE, after it
 * knows whether this purchase may already exist, so a refused replay of an
 * uncertain start still reads as uncertain (its credit stays held). An unknown
 * count or clock does not refuse: the database bounds the purchase itself, and
 * an unknown never spends a read (`planSmokeStatusRead`, `planSmokeReceipt`).
 */
export function planSmokeStart(s: SmokeReadState): { ok: true } | { ok: false; reason: string } {
  if (s.readsLeft !== null && s.readsLeft < 1 + SMOKE_READS_AFTER_STATUS) return { ok: false, reason: "reads_exhausted" };
  if (s.remainingMs !== null &&
    s.remainingMs < APIFY_START_TIMEOUT_MS + SMOKE_MIN_WAIT_S * 1000 + SMOKE_READ_SLACK_MS + SMOKE_TAIL_MS) {
    return { ok: false, reason: "no_time" };
  }
  return { ok: true };
}

/** One long-polled status read, clamped so the dataset and the receipt still fit, in reads and in time. */
export function planSmokeStatusRead(s: SmokeReadState): SmokeReadPlan {
  if (s.readsLeft === null || s.remainingMs === null) return { ok: false, reason: "read_state_unknown" };
  if (s.readsLeft < 1 + SMOKE_READS_AFTER_STATUS) return { ok: false, reason: "reads_reserved" };
  const waitS = Math.min(APIFY_MAX_WAIT_S, Math.floor((s.remainingMs - SMOKE_TAIL_MS - SMOKE_READ_SLACK_MS) / 1000));
  if (!(waitS >= SMOKE_MIN_WAIT_S)) return { ok: false, reason: "no_time" };
  return { ok: true, waitS, timeoutMs: waitS * 1000 + SMOKE_READ_SLACK_MS };
}

/**
 * The receipt read after a terminal status: how long to wait first, or why it
 * cannot be made. `needDataset` keeps one read and its time for the dataset.
 */
export function planSmokeReceipt(
  s: SmokeReadState, o: { finishedAtMs: number | null; nowMs: number; needDataset: boolean },
): { ok: true; waitMs: number } | { ok: false; reason: string } {
  if (s.readsLeft === null || s.remainingMs === null) return { ok: false, reason: "read_state_unknown" };
  if (s.readsLeft < 1 + (o.needDataset ? 1 : 0)) return { ok: false, reason: "reads_exhausted" };
  const settledAt = (o.finishedAtMs ?? o.nowMs) + APIFY_SETTLE_MS;
  const waitMs = Math.max(0, settledAt - o.nowMs);
  if (s.remainingMs < waitMs + APIFY_RECEIPT_TIMEOUT_MS + (o.needDataset ? APIFY_DATASET_TIMEOUT_MS : 0)) {
    return { ok: false, reason: "no_time" };
  }
  return { ok: true, waitMs };
}

const APIFY_TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);
/** A run document whose figures Apify calls settled: terminal, and finished at least APIFY_SETTLE_MS ago. */
export function apifyRunSettled(run: Record<string, unknown> | null | undefined, nowMs: number): boolean {
  if (!run || !APIFY_TERMINAL.has(String(run.status))) return false;
  const finished = typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : NaN;
  return Number.isFinite(finished) && finished + APIFY_SETTLE_MS <= nowMs;
}

// ── THE SMOKE'S APPROVED PROVIDER ACTORS ────────────────────────────────────
//
// The gate refuses any provider actor the authorization's catalog does not
// approve. A planner shown every actor its graph allows writes a prompt the
// smoke cannot afford (Codex, PR #94: the execution planner's 53,922-byte
// request against a 32,768-byte model template) and may plan purchases the
// gate will refuse. In the smoke, planners are shown the approved ones only.

export const SMOKE_APPROVED_ACTORS_MARK = Symbol.for("agentory.smokeApprovedActors");

/** The gate actors (`apify:owner~name`, `firecrawl:scrape`, …) the authorization approves for purchase; null outside the smoke or when unknown. */
export async function smokeApprovedActors(): Promise<readonly string[] | null> {
  const f = globalThis.fetch as unknown as Record<symbol, unknown> | undefined;
  const read = f?.[SMOKE_APPROVED_ACTORS_MARK];
  return typeof read === "function" ? await (read as () => Promise<readonly string[] | null>)() : null;
}

/** The gate's actor id for an Apify implementation id (`owner/name` → `apify:owner~name`), as `classifyRequest` derives it. */
export const apifyGateActor = (implementationId: string): string => `apify:${implementationId.replace("/", "~")}`;

export const SMOKE_ORCHESTRATION_ENV = "LEAD_V2_SMOKE_ORCHESTRATION";

/**
 * The smoke's minimal orchestration: opt-in (`LEAD_V2_SMOKE_ORCHESTRATION=
 * minimal`) AND only while the admission gate is this process's fetch. Either
 * missing, the run is the customer path, unchanged. It drops the model calls
 * that cannot change what the one-search smoke buys or decides — route
 * control, triage, the discovery re-plan, the post-discovery plan amendment,
 * shadow pool ranking — and the terminal receipt re-reads the gate's settled
 * receipt already covers.
 */
export function smokeMinimalOrchestration(readEnv: (k: string) => string | undefined): boolean {
  return smokeAdmissionActive() &&
    String(readEnv(SMOKE_ORCHESTRATION_ENV) ?? "").trim().toLowerCase() === "minimal";
}
