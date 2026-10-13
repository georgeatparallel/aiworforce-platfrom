// HOW BIG IS WHAT A SLICE WRITES — measured on every write, warned past a budget.
//
// Query B canaries d22d9ee6 and eb0d520f (2026-10-12/13): a task result past
// 2 MB was read and rewritten in full a dozen times a slice. Writes ran 30–160 s,
// hit the 120 s statement timeout, and one lost slice-result write made the
// queue count a real slice as a retry. Nothing reported the size until the
// writes failed.
//
// The budgets come from measurement, of the failed canary's own row
// (task 2fc157fb, eb0d520f: 83 companies, 74 closed at discovery) re-stored by
// this code, and of the d22d9ee6 replay (tests/replay/bench/payloadBench.ts):
//
//                     production row          re-stored     replay (68 companies)
//   checkpoint        1.86 MB                 661 KB        394 KB  (1,086 before)
//   lineage state     1.44 MB                 859 KB        504 KB  (1,194 before)
//   task result       2.64 MB                ~1.27 MB*      ~0.8 MB continuing
//   Workbench view    212 KB                  unchanged     301 KB
//   (* the checkpoint saving plus the research-fabric summary; not re-measured
//      as a whole row)
//
// Writes of this row began timing out at about 2 MB. Each budget is about
// 1.3x the re-stored production size, so a canary-sized mission stays under it
// and growth past what was measured is reported before writes fail. They are
// warnings: nothing is refused, trimmed or retried because of them.
//
// PURE.

export const PAYLOAD_SIZE_VERSION = "payload-size-v1" as const;

export type PayloadKind = "task_result" | "checkpoint" | "lineage_state" | "canonical_view";

export const PAYLOAD_WARN_BYTES: Readonly<Record<PayloadKind, number>> = {
  task_result: 1_600_000,
  checkpoint: 900_000,
  lineage_state: 1_200_000,
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
