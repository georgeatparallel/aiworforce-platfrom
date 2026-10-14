// D1 — A STALE GENERATION NEVER OVERWRITES A NEWER ONE'S RESULT.
//
// A worker that stalls past its lease (a partition: no heartbeat, still running)
// wakes after another worker has taken the mission over. Its claim and lineage
// releases were already refused — each is fenced in SQL — but its `tasks.result`
// writes were plain `update … where id = $1`: the end-of-slice write landed over
// the finished mission's result (chaos lab: the finished execution state, 12
// provider attempts, replaced by the stale slice's 8), and over a newer slice's
// checkpoint just the same. The stage writer's "a finalized verdict owns the
// row" check was a read, then a write — not a fence.
//
// THE FENCE IS IN THE WRITE ITSELF. `claim_sourcing_continuation` increments
// `tasks.checkpoint_version` on every claim and returns the new value to the
// claimant: a per-generation token on the row this writes. So every result
// write of a slice is a single conditional UPDATE:
//
//   where id = $task
//     and checkpoint_version = $generation        -- no newer claim since
//     [and (result->>terminal_status is null       -- and, before the slice's own
//          or result->>terminal_status = 'continuation_required')]  -- verdict:
//                                                   -- nothing finalized it
//
// Zero rows updated means another generation (or a cancellation) owns the row:
// the write is refused, said so, and nothing is retried. No migration, no new
// RPC: the column and its increment already exist.

/** The PostgREST filter "this row has not been finalized" (the stage writer's rule). */
export const OPEN_RESULT_FILTER =
  "result->>terminal_status.is.null,result->>terminal_status.eq.continuation_required";

/** The slice's generation: the `checkpoint_version` it claimed (or found, on a first slice). */
export interface SliceFence {
  /** Null when it could not be read: the write is then fenced on `requireOpen` alone. */
  generation: number | null;
}

/**
 * The slice of the PostgREST builder the fenced write uses — a fake in tests.
 *
 * COUNTED, NOT SELECTED. PostgREST applies a logical `or` filter to the
 * RETURNING projection: `?or=(result->>terminal_status…)&select=id` fails with
 * 42703 "column tasks.result does not exist" (verified against PostgREST
 * 12.2.3), which would have failed every open-row write. `count: "exact"` with
 * no representation returns the number of rows updated and no payload.
 */
export interface FencedTaskQuery extends PromiseLike<{ error: { message?: unknown; code?: unknown } | null; count: number | null }> {
  eq(column: string, value: unknown): FencedTaskQuery;
  or(filters: string): FencedTaskQuery;
}
export interface FencedTaskDb {
  from(table: string): { update(patch: Record<string, unknown>, opts: { count: "exact" }): FencedTaskQuery };
}

export type FencedWriteOutcome =
  | { written: true; fenced: false; error: null }
  /** Zero rows: a newer generation claimed the row, or (with `requireOpen`) it was finalized. */
  | { written: false; fenced: true; error: null }
  | { written: false; fenced: false; error: { message?: unknown; code?: unknown } };

export async function fencedTaskUpdate(
  db: FencedTaskDb,
  taskId: string,
  fence: SliceFence,
  opts: {
    /**
     * True for every write before the slice's own verdict lands: a row another
     * writer finalized (a takeover's ending, a cancellation) is never reopened.
     * False for the slice's follow-ups to its own verdict.
     */
    requireOpen: boolean;
  },
  patch: Record<string, unknown>,
): Promise<FencedWriteOutcome> {
  let q = db.from("tasks").update(patch, { count: "exact" }).eq("id", taskId);
  if (typeof fence.generation === "number") q = q.eq("checkpoint_version", fence.generation);
  if (opts.requireOpen) q = q.or(OPEN_RESULT_FILTER);
  const { error, count } = await q;
  if (error) return { written: false, fenced: false, error };
  // An absent count (never with `count: "exact"`) is read as written: the old,
  // unfenced behaviour, rather than a false refusal of a write that landed.
  return count === 0
    ? { written: false, fenced: true, error: null }
    : { written: true, fenced: false, error: null };
}

/** The slice's generation: the claim's `checkpoint_version`, else the row's own (a first slice). */
export async function resolveSliceGeneration(
  db: { from(table: string): { select(c: string): { eq(c: string, v: unknown): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> } } } },
  taskId: string,
  claimedVersion: number | null | undefined,
): Promise<number | null> {
  if (typeof claimedVersion === "number" && Number.isInteger(claimedVersion)) return claimedVersion;
  try {
    const { data, error } = await db.from("tasks").select("checkpoint_version").eq("id", taskId).maybeSingle();
    if (error) return null;
    const v = (data as { checkpoint_version?: unknown } | null)?.checkpoint_version;
    return typeof v === "number" && Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}
