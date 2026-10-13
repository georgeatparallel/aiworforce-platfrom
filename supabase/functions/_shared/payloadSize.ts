// HOW BIG IS WHAT A SLICE WRITES — measured on every write, warned past a budget.
//
// Query B canaries d22d9ee6 and eb0d520f (2026-10-12/13): a task result past
// 2 MB was read and rewritten in full a dozen times a slice. Writes ran 30–160 s,
// hit the 120 s statement timeout, and one lost slice-result write made the
// queue count a real slice as a retry. Nothing reported the size until the
// writes failed.
//
// The budgets come from measurement. Offline (tests/replay/bench/payloadBench.ts),
// the Query B d22d9ee6 lineage replayed to 68 employers, 64 closed at
// discovery, after slimming:
//
//   checkpoint                                 645 KB  (1,061 KB before)
//   lineage state                              752 KB  (1,166 KB before)
//   Workbench view                             294 KB  (unchanged)
//   task result, engine-derived parts       1,054 KB continuing, 1,237 KB final
//                                                     (1,654 KB before)
//
// In production the same mission's writes began timing out at about 2 MB
// (canary eb0d520f, 2026-10-13). Each budget sits a little above the measured
// size, and the task-result budget at half the size that failed, so a
// canary-sized mission is reported as it approaches trouble, not after.
// They are warnings: nothing is refused, trimmed or retried because of them.
//
// PURE.

export const PAYLOAD_SIZE_VERSION = "payload-size-v1" as const;

export type PayloadKind = "task_result" | "checkpoint" | "lineage_state" | "canonical_view";

export const PAYLOAD_WARN_BYTES: Readonly<Record<PayloadKind, number>> = {
  task_result: 1_000_000,
  checkpoint: 750_000,
  lineage_state: 900_000,
  canonical_view: 400_000,
};

const encoder = new TextEncoder();

/** UTF-8 bytes of the JSON a write sends; null when it cannot be serialised. */
export function payloadBytes(v: unknown): number | null {
  try {
    return encoder.encode(JSON.stringify(v ?? null)).length;
  } catch {
    return null;
  }
}

/** The largest top-level fields of an object, by serialised bytes. */
export function largestFields(v: unknown, n = 5): Array<[string, number]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]): [string, number] => [k, payloadBytes(x) ?? 0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export interface PayloadSizeLine {
  version: typeof PAYLOAD_SIZE_VERSION;
  kind: PayloadKind;
  bytes: number | null;
  warn_at: number;
  over: boolean;
  /** Only when over the budget: where the bytes are. */
  largest?: Array<[string, number]>;
}

/** One measurement, and whether it is over its budget. */
export function measurePayload(kind: PayloadKind, value: unknown, bytes?: number | null): PayloadSizeLine {
  const b = bytes === undefined ? payloadBytes(value) : bytes;
  const warnAt = PAYLOAD_WARN_BYTES[kind];
  const over = b !== null && b > warnAt;
  return {
    version: PAYLOAD_SIZE_VERSION, kind, bytes: b, warn_at: warnAt, over,
    ...(over ? { largest: largestFields(value) } : {}),
  };
}
