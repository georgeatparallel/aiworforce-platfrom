// LEAD V2 — MAY VERIFICATION START ANOTHER EXTERNAL OPERATION?
//
// The capability engine asks its ExecutionDeadline before every paid call and
// stops at the checkpoint reserve. The verification phase that runs AFTER the
// engine — the claim verifiers (Apify job search, Atomus, Pvalyou), the
// business-model page collection (Firecrawl `/map` and pages) and the model
// re-grounding — asked nothing. A slice whose engine had used its budget, or
// whose worker had lost the lease, or whose mission had been cancelled, still
// started verification purchases until the phase ran out of targets. Query B
// d22d9ee6's slice 4 ran 6.5 minutes against a 300-second ceiling; eb0d520f's
// slice 2 ran 14.5.
//
// This is the one question every verification-phase operation asks first:
//
//   revoked (the worker lost ownership, or the mission/lineage was cancelled,
//            or the bind was refused)                         → stop
//   the checkpoint reserve is reached                         → stop
//   a SYNCHRONOUS call (a page, a map, a model call) that must
//   finish inside the slice cannot, by the deadline's own
//   per-operation estimate                                    → stop
//
// The answer is STICKY: once a slice stops, it stays stopped, so a phase never
// interleaves "stopped" and "started" for the same reason the clock moved.
//
// A stop is a clock or ownership decision, never a fact about a company. What
// it defers stays unanswered, resumable and unbought; what already ran keeps
// its run id, its evidence, its reservation and its idempotency key.
//
// Pure. No clock of its own, no network.

import type { DeadlineOperation, ExecutionDeadline } from "./leadExecutionFinalizer.ts";
import { CHECKPOINT_RESERVE_MS } from "./leadResumeState.ts";

export type VerificationStopReason = "deadline" | "cancelled" | "lease_lost" | "bind_refused" | "revoked";

export interface VerificationStop {
  reason: VerificationStopReason;
  /** The raw signal: the revocation string, or the remaining time. */
  detail: string;
}

export interface VerificationStopGate {
  /**
   * Non-null once no new external operation may start.
   *
   * Pass `op` (a deadline latency key) for a SYNCHRONOUS call that has to
   * finish inside the slice; without it only revocation and the checkpoint
   * reserve are asked — the rule for a durable start, whose run id is recorded
   * before anything waits on it.
   */
  check(op?: DeadlineOperation | null): VerificationStop | null;
  /** The first stop this gate returned, or null. */
  readonly stopped: VerificationStop | null;
}

/** A gate that never stops — the behaviour every caller had before. */
export const NEVER_STOP: VerificationStopGate = Object.freeze({
  check: () => null,
  stopped: null,
});

/**
 * What a revocation string means. The worker revokes with
 * `worker:<heartbeat reason>` (`ownership_lost`, `mission_cancelled`,
 * `lineage_cancelled`, `lineage_terminal`, `queue_not_found`,
 * `heartbeat_rpc_error`, `heartbeat_error:*`), or `bind_refused`.
 */
export function classifyRevocation(reason: string): VerificationStopReason {
  const r = reason.toLowerCase();
  if (r.includes("bind_refused")) return "bind_refused";
  if (r.includes("cancel") || r.includes("lineage_terminal")) return "cancelled";
  if (r.includes("ownership") || r.includes("queue_not_found") || r.includes("heartbeat") || r.includes("lease")) {
    return "lease_lost";
  }
  return "revoked";
}

/**
 * The gate for one slice's verification phase, over the run's own deadline
 * (the worker's revocable one, or the edge default) and, optionally, the
 * worker's abort signal.
 */
export function verificationStopGate(
  deadline: ExecutionDeadline | null | undefined,
  opts: { reserveMs?: number; signal?: AbortSignal | null } = {},
): VerificationStopGate {
  const reserveMs = opts.reserveMs ?? CHECKPOINT_RESERVE_MS;
  let stopped: VerificationStop | null = null;
  const decide = (op?: DeadlineOperation | null): VerificationStop | null => {
    const revoked = (deadline as { revokedReason?: string | null } | null | undefined)?.revokedReason ?? null;
    if (revoked) return { reason: classifyRevocation(revoked), detail: revoked };
    const signal = opts.signal ?? null;
    if (signal?.aborted) {
      const why = typeof signal.reason === "string" ? signal.reason : "aborted";
      return { reason: classifyRevocation(why), detail: why };
    }
    if (!deadline) return null;
    const remaining = deadline.remainingMs();
    if (remaining <= reserveMs) {
      return { reason: "deadline", detail: `checkpoint reserve reached (${remaining}ms left, reserve ${reserveMs}ms)` };
    }
    if (op && deadline.expired(op)) {
      return { reason: "deadline", detail: `no room for ${op} (${remaining}ms left, needs ${deadline.estimateFor(op)}ms)` };
    }
    return null;
  };
  return {
    check(op) {
      if (stopped) return stopped;
      stopped = decide(op);
      return stopped;
    },
    get stopped() { return stopped; },
  };
}

/** Deadline latency keys for the synchronous verification-phase operations. */
export const VERIFICATION_OPS = Object.freeze({
  page: "firecrawl_scrape",
  map: "firecrawl_map",
  model: "verification_model",
});
