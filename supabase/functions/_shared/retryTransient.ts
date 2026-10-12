// A SMALL, BOUNDED RETRY FOR THE WRITES THAT END A SLICE.
//
// Query B d22d9ee6 (2026-10-12), end of slice 5: the continuation-claim release
// and the run-outcome write hit Postgres statement timeouts (57014) and the
// lineage release came back `release_unavailable`. The claim stayed held, so
// slice 6's claim was refused (409) and a slice was spent doing nothing. These
// releases are idempotent (a claim id or a version compare-and-swap decides),
// so a transient failure is retried — a few times, briefly, and never past the
// slice's own deadline. A permanent answer (not the holder, a version
// conflict) is returned at once.

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  /** Wait before attempt k+1 (k = 0-based retry index); the last value repeats. */
  delaysMs: readonly number[];
  /** Milliseconds still available to this slice; no retry starts without its wait fitting. */
  remainingMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function retryTransient<T>(
  op: () => Promise<T>, isTransient: (result: T) => boolean, o: RetryOptions,
): Promise<{ result: T; attempts: number }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let result = await op();
  let attempts = 1;
  while (attempts < Math.max(1, o.attempts) && isTransient(result)) {
    const wait = o.delaysMs[Math.min(attempts - 1, o.delaysMs.length - 1)] ?? 0;
    if (o.remainingMs && o.remainingMs() <= wait) break;
    await sleep(wait);
    result = await op();
    attempts++;
  }
  return { result, attempts };
}
