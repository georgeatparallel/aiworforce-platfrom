import type { ExecutionDeadline } from "./leadExecutionFinalizer.ts";

/** Fixed authorization bound, reconstructed from the persisted queue timestamp. */
export const SMOKE_MISSION_RUNTIME_MS = 300_000;
/** Only omission or an explicit off disables this opt-in guard; typos enforce. */
export const missionWallClockEnabled = (raw: string | undefined): boolean =>
  raw !== undefined && raw !== "off";
/**
 * The queue timestamp is the database's clock and `now` is the worker's, so a
 * just-enqueued row can read as slightly in the future. Tolerated up to this
 * much; the expiry is still exactly `enqueuedAt + SMOKE_MISSION_RUNTIME_MS`.
 */
export const QUEUE_CLOCK_SKEW_MS = 30_000;
export function missionExpiry(enqueuedAt: unknown, now: number): number | null {
  const at = typeof enqueuedAt === "string" ? Date.parse(enqueuedAt) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now + QUEUE_CLOCK_SKEW_MS) return null;
  return at + SMOKE_MISSION_RUNTIME_MS;
}

/** Checkpoint/finalization can continue; neither revocation nor a new slice renews authorization. */
export function withMissionExpiry(
  base: ExecutionDeadline,
  expiresAt: number,
  now: () => number,
): ExecutionDeadline {
  return {
    get startedAt() {
      return base.startedAt;
    },
    get budgetMs() {
      return Math.min(base.budgetMs, Math.max(0, expiresAt - base.startedAt));
    },
    get slowestCallMs() {
      return base.slowestCallMs;
    },
    elapsedMs: () => base.elapsedMs(),
    remainingMs: () =>
      Math.max(0, Math.min(base.remainingMs(), expiresAt - now())),
    expired: (op) => now() >= expiresAt || base.expired(op),
    expiredForDurableStart: () =>
      now() >= expiresAt || base.expiredForDurableStart(),
    observeCall: (ms, op) => base.observeCall(ms, op),
    estimateFor: (op) => base.estimateFor(op),
  };
}
