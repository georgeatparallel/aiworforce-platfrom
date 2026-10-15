// A PAID RUN THE LEDGER REMEMBERS AND THE CHECKPOINT FORGOT.
//
// ── THE FAILURE ────────────────────────────────────────────────────────────
//
// Run fafd9912, 2026-08-26. Slice 2 enriched eleven companies, POSTed
// `harvestapi/linkedin-job-search` as run `ub2qunSMAKTNf5AKv` at 16:12:14, and
// was hard-killed mid-poll. The task row still held slice 1's state:
//
//     tasks.updated_at                       16:11:17   (slice 1)
//     lead_execution_calls  ub2qunSMAKTNf5AKv 16:12:14   status "started"
//     capability_execution_state.pending_runs []
//
// Apify ran the job to completion. Nothing would ever read it, and a resumed
// slice would have POSTed the same three companies again — a second charge for
// an answer already bought.
//
// ── WHY THE TWO RECORDS DISAGREED ──────────────────────────────────────────
//
// Persist-on-start writes the run id to `lead_execution_calls` the instant the
// run exists. `pending_runs` is written somewhere else and much later: only
// when the poll gives up GRACEFULLY and `readPendingRun` turns the timeout into
// a checkpoint entry. A hard kill runs no catch block, so the ledger knows and
// the checkpoint does not.
//
// Run 783fa163 survived precisely because its poll timed out cleanly. That is
// not a property a resume should depend on.
//
// ── THE RECOVERY ───────────────────────────────────────────────────────────
//
// The ledger already holds every field adoption needs. A row that is still
// `started` and names a `provider_run_id` is, by definition, a run we paid to
// start and never observed finish. Rebuilding `pending_runs` from those rows
// makes the checkpoint's omission irrelevant.
//
// THE FINGERPRINT IS RECOMPUTED, NOT STORED. `inputFingerprint` sorts keys and
// drops nulls, so a JSONB round trip cannot change it, and `redactProviderInput`
// is identity for the inputs this pipeline sends (URLs, titles, integers — no
// tokens, no string over 2000 chars, no array over 200 items). Verified against
// production: recomputing from `request_input.input` for run Zs5bYFGlnua1hJWYg
// yields `80666f95`, the exact fingerprint that run's checkpoint had persisted.
// `redactionIsIdentityFor` pins that property so a future redaction rule cannot
// silently break adoption and start double-charging.
//
// ADOPTION IS A `GET` on a run that already exists, so recovery can only ever
// REPLACE a POST — it can never add a charge. The worst case is re-reading a
// run that had in fact finished, which costs nothing.
//
// Pure. No network, no database, no clock — except `readResumableTimeoutRows`,
// the one read, against an injected builder.

import { inputFingerprint } from "./leadResumeState.ts";
import { redactProviderInput } from "./executionLedger.ts";

export const PENDING_RUN_RECOVERY_VERSION = "pending-run-recovery-v1" as const;

/** The `lead_execution_calls` columns recovery reads. */
export interface LedgerStartedRow {
  capability?: string | null;
  provider_id?: string | null;
  provider_run_id?: string | null;
  dataset_id?: string | null;
  status?: string | null;
  request_input?: Record<string, unknown> | null;
  started_at?: string | null;
  created_at?: string | null;
  /**
   * The finalization metadata (`outcomeFromToolResult`). Read only to tell a
   * RESUMABLE timeout — the poll window closed on a run still RUNNING, so
   * `metadata.resumable` is true — from a run that genuinely ended.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * A `timed_out` row whose run is still executing. The transport finalizes a
 * poll window that closed on a RUNNING/READY Apify run — and a D3 re-read that
 * found it still running — as `timed_out` with the run id and
 * `metadata.resumable: true` (`outcomeFromToolResult`). That run is billed and
 * unread: pending, exactly like a `started` row. A run Apify itself timed out
 * or aborted is `timed_out` with `resumable: false`, and has ended.
 */
export function isResumableTimeout(r: Pick<LedgerStartedRow, "status" | "metadata">): boolean {
  return r.status === "timed_out" && r.metadata?.["resumable"] === true;
}

/** A row that names a run still owed a read: `started`, or a resumable timeout. */
export function isPendingLedgerRow(r: Pick<LedgerStartedRow, "status" | "metadata">): boolean {
  return r.status === "started" || isResumableTimeout(r);
}

/**
 * The statuses whose rows MAY account for a run (run-agent's `resolvedRunIds`
 * read). A `timed_out` row among them resolves its run only when it is not
 * resumable — see {@link resolvedRunIdsFrom}.
 */
export const RESOLVING_STATUSES: readonly string[] = ["reused", "succeeded", "failed", "timed_out"];

/**
 * Which runs the ledger has already accounted for.
 *
 * A RESUMABLE `timed_out` row does not resolve its run: the run was still
 * executing when that row was finalized — the first poll window closing, or a
 * later re-read that found it still running. Counting it as resolved dropped a
 * run that was paid for and never read, and the next slice could buy the same
 * question again.
 */
export function resolvedRunIdsFrom(
  rows: ReadonlyArray<Pick<LedgerStartedRow, "provider_run_id" | "status" | "metadata">>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const id = typeof r.provider_run_id === "string" ? r.provider_run_id.trim() : "";
    if (!id) continue;
    if (!RESOLVING_STATUSES.includes(String(r.status ?? ""))) continue;
    if (isResumableTimeout(r)) continue;
    out.add(id);
  }
  return out;
}

/** The slice of the PostgREST builder `readResumableTimeoutRows` uses — a fake in tests. */
export interface LedgerReadQuery {
  select(columns: string): LedgerReadQuery;
  eq(column: string, value: unknown): LedgerReadQuery;
  not(column: string, operator: string, value: unknown): LedgerReadQuery;
  order(column: string, o: { ascending: boolean }): LedgerReadQuery;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}
export interface LedgerReadDb {
  from(table: string): LedgerReadQuery;
}

/** One lineage's timed-out runs worth reading: newest first, bounded like the `started` read. */
export const RESUMABLE_TIMEOUT_READ_LIMIT = 50;

/**
 * THE ONE READ IN THIS FILE: the lineage's `timed_out` rows that still name a
 * run executing (`isResumableTimeout`), for `recoverPendingRuns`.
 *
 * Scoped to the PARENT task and the WORKSPACE — the ownership gate the
 * `started` read uses — so a run is only ever adopted by the lineage that paid
 * for it. Its own window, newest first, so terminal timeouts never push a
 * `started` row out of that read's. Best effort: no parent, an error or a
 * throw is "nothing more to recover", never a failed run.
 */
export async function readResumableTimeoutRows(
  db: LedgerReadDb,
  scope: { table: string; parentTaskId: string | null; workspaceId: string },
  log: (msg: string, meta?: unknown) => void = () => {},
): Promise<LedgerStartedRow[]> {
  if (!scope.parentTaskId) return [];
  try {
    const { data, error } = await db.from(scope.table)
      .select("capability, provider_id, provider_run_id, dataset_id, " +
        "status, request_input, started_at, created_at, metadata")
      .eq("task_id", scope.parentTaskId)
      .eq("workspace_id", scope.workspaceId)
      .eq("status", "timed_out")
      .not("provider_run_id", "is", null)
      .order("started_at", { ascending: false })
      .limit(RESUMABLE_TIMEOUT_READ_LIMIT);
    if (error) {
      log("[pending-run-recovery] timed-out read failed", error);
      return [];
    }
    return ((data ?? []) as LedgerStartedRow[]).filter(isResumableTimeout);
  } catch (e) {
    log("[pending-run-recovery] timed-out read threw", String(e));
    return [];
  }
}

/**
 * A rebuilt `pending_runs` entry.
 *
 * `capability` is deliberately NULL. The ledger's own `capability` column holds
 * the ACTOR key — `apify_linkedin_job_search` — not the `CapabilityId` the
 * checkpoint records, and the mapping is genuinely ambiguous:
 * `apify_linkedin_company_search` serves both `general_company_discovery` and
 * `company_identity_resolution` in the same run. Guessing would be worse than
 * abstaining, so a recovered entry says it does not know, and adoption treats a
 * null capability as "any" — see `leadCapabilityEngine`. The
 * `input_fingerprint` is what actually identifies the question, and it is
 * strictly stronger than the capability: the same input to the same provider is
 * the same purchase whichever stage asked for it.
 *
 * ── AND IT CARRIES NO D3 `selection`, ON PURPOSE ───────────────────────────
 *
 * Rebuilding one from the row (`provider_call_spec.capability` + the sent
 * `input`) was tried and is UNSAFE in this engine (chaos lab, Query B
 * d22d9ee6). The D3 re-ask dedupes owed questions against the slice's own
 * strategy by the PRE-compile selection input; the ledger holds only the
 * POST-compile payload, so the two never match. When the slice re-proposes the
 * same page, the owed re-ask adopts the run first and the slice's own,
 * identical question then finds nothing pending and BUYS IT AGAIN (pending
 * page 2 / page 3 with the slice's writes lost: one question bought twice).
 * And a re-planned query is compiled against the RESTORED retrieval plan,
 * which predates the amendment that proposed it, so the re-ask compiles to a
 * different input and adoption-only refuses it — safe, but nothing adopted.
 * Such a run stays listed (adopted if asked again, never bought) until
 * `awaitedPendingRuns` stops it holding the lineage.
 */
export interface RecoveredPendingRun {
  capability: null;
  provider: string;
  run_id: string;
  dataset_id: string | null;
  actor_build_id: null;
  started_at: string;
  input_fingerprint: string;
  /** Marks the entry as rebuilt from the ledger rather than checkpointed. */
  recovered_from_ledger: true;
}

/**
 * Is `redactProviderInput` a no-op for this input?
 *
 * The whole recovery rests on it. Exported so the property is tested against
 * the real payloads rather than assumed.
 */
export function redactionIsIdentityFor(input: unknown): boolean {
  return JSON.stringify(redactProviderInput(input)) === JSON.stringify(input);
}

/**
 * Rebuild the pending runs a hard-killed slice never checkpointed.
 *
 * A row qualifies only when it is still `started` — or `timed_out` on a run
 * still executing (`isResumableTimeout`) — AND names a run; anything else
 * either finished (and has its answer recorded) or never reached the provider
 * (and cost nothing).
 */
export function recoverPendingRuns(
  rows: readonly LedgerStartedRow[],
  /**
   * Runs the ledger already has an OUTCOME for, whatever their `started` row
   * still says.
   *
   * ── WHY A STARTED ROW IS NOT PROOF A RUN IS PENDING ──────────────────────
   *
   * Adoption settles the started row by updating it in place. Task e01ad74f
   * shows what happens when that write fails: run sYUy3Er8siHqMDocB was
   * adopted at 08:06 — 26 rows read, spliced out of `pending_runs` correctly —
   * and its settle UPDATE was rejected by a CHECK constraint. The row stayed
   * `started`, so this function resurrected it on every later slice, undoing
   * the removal each time. `decideAutoContinuation` reads a non-empty
   * `pending_runs` as `awaiting_provider_run` and defers, so the lineage spent
   * five continuations and three barren slices waiting for a run that had
   * already been read.
   *
   * The constraint violation is fixed. This is the guard that makes the NEXT
   * settle failure cost a stale ledger row instead of a parked lineage: a run
   * with any terminal row — `reused`, `succeeded`, `failed`, a `timed_out`
   * that is not resumable — has been accounted for, and re-queueing it can
   * only mislead. Built by {@link resolvedRunIdsFrom}.
   *
   * Absent or empty preserves the previous behaviour exactly.
   */
  resolvedRunIds: ReadonlySet<string> = new Set(),
): RecoveredPendingRun[] {
  const out: RecoveredPendingRun[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // A resumable `timed_out` row is as pending as a `started` one: the poll
    // window closed on a run still executing (`isResumableTimeout`).
    if (!isPendingLedgerRow(r)) continue;
    const runId = typeof r.provider_run_id === "string" ? r.provider_run_id.trim() : "";
    if (runId && seen.has(runId)) {
      // THE WAIT IS BOUNDED FROM THE PURCHASE. A later re-read of the same run
      // (D3, still executing) must not restart `awaitedPendingRuns`' clock.
      const first = out.find((x) => x.run_id === runId);
      const at = r.started_at ?? r.created_at ?? null;
      if (first && at && at < first.started_at) first.started_at = at;
      continue;
    }
    if (!runId) continue;
    // AN OUTCOME ELSEWHERE OUTRANKS A STALE `started`.
    if (resolvedRunIds.has(runId)) continue;
    // The ACTOR key is what `pending_runs.provider` holds. `provider_id` is the
    // vendor ("apify"), which is not specific enough to match a call.
    const provider = typeof r.capability === "string" ? r.capability.trim() : "";
    if (!provider) continue;
    const actorInput = (r.request_input ?? {})["input"];
    // NO INPUT, NO ADOPTION. Without a fingerprint the entry could be matched
    // to the wrong call — a batch of one inheriting a batch of ten's run id,
    // which is the defect the fingerprint was added to prevent.
    if (actorInput === undefined || actorInput === null) continue;
    seen.add(runId);
    out.push({
      capability: null,
      provider,
      run_id: runId,
      dataset_id: typeof r.dataset_id === "string" && r.dataset_id ? r.dataset_id : null,
      actor_build_id: null,
      started_at: r.started_at ?? r.created_at ?? new Date(0).toISOString(),
      input_fingerprint: inputFingerprint(actorInput),
      // WHO THE RUN WAS ASKED ABOUT, straight out of the input it was started
      // with. Adoption matches the whole compiled input, so a later slice can
      // only adopt this run by asking about the same companies in the same
      // order — and it can only do that if it knows which they were. See
      // `pending_runs[].company_keys`.
      ...(Array.isArray((actorInput as { company?: unknown }).company)
        ? {
          company_keys: ((actorInput as { company: unknown[] }).company)
            .filter((c): c is string => typeof c === "string" && !!c),
        }
        : {}),
      recovered_from_ledger: true,
    });
  }
  return out;
}

/**
 * Merge recovered runs into whatever the checkpoint did manage to save.
 *
 * The CHECKPOINT WINS on a run id both records name: it carries the real
 * `capability`, so keeping it makes adoption strictly more precise. Recovery
 * only ever ADDS the entries that were lost.
 */
export function mergePendingRuns<T extends { run_id: string }>(
  checkpointed: readonly T[],
  recovered: readonly RecoveredPendingRun[],
  /**
   * Runs the ledger has already accounted for — dropped from BOTH sides.
   *
   * ── WHY THE CHECKPOINT NEEDS THE SAME FILTER AS THE LEDGER ──────────────
   *
   * `recoverPendingRuns` stops a settled run being resurrected from the ledger.
   * That is only half of it: a run resurrected on an EARLIER slice was then
   * checkpointed, and the checkpoint is read back here. Task e01ad74f is the
   * proof — after the ledger guard shipped, its recovery correctly logged
   * `skipped already-resolved`, and the lineage stayed parked anyway, because
   * the same entry was sitting in `restored.pending_runs`.
   *
   * It cannot clear itself. The engine only splices an entry out when it ADOPTS
   * the run, and adoption requires a call whose input fingerprint matches; by
   * the time the pool has moved on, no call ever will. So the entry outlives
   * every slice, `decideAutoContinuation` keeps reading a non-empty list as
   * `awaiting_provider_run`, and the lineage defers for ever.
   *
   * Empty or absent preserves the previous behaviour exactly.
   */
  resolvedRunIds: ReadonlySet<string> = new Set(),
): Array<T | RecoveredPendingRun> {
  const live = checkpointed.filter((r) => !resolvedRunIds.has(r.run_id));
  const have = new Set(live.map((r) => r.run_id));
  return [
    ...live,
    ...recovered.filter((r) => !have.has(r.run_id) && !resolvedRunIds.has(r.run_id)),
  ];
}

// ── COMPLETED RUNS: RE-READ, NEVER RE-BOUGHT ─────────────────────────────────
//
// `recoverPendingRuns` rebuilds runs that STARTED and never settled. A run that
// settled was invisible to the next slice, so a resumed slice asking the same
// question bought it again: Lead V2 run 4250f181 paid for the identical
// memo23 discovery input twice (run dTKjqhRdrXbraA7Ur, then poa6rBspq8ChD8flC —
// the ledger even recorded it as `attempt_number: 2` of one logical call).
//
// These are offered to the engine for ADOPTION by exact provider + input
// fingerprint: the engine re-reads the finished run's dataset — a GET on a run
// already paid for — instead of starting a second one.

export interface RecoveredCompletedRun {
  provider: string;
  run_id: string;
  dataset_id: string | null;
  input_fingerprint: string;
}

/**
 * A run whose dataset is complete and paid for. `reused` is one too: an
 * adoption is recorded `reused` only when the run FINISHED and its rows were
 * read (`outcomeFromToolResult`; run-agent's `onRunAdopted` settles the started
 * row the same way). Leaving it out meant a run adopted in slice N whose
 * checkpoint write was then lost was known to no later slice — not pending (it
 * is settled), not completed — and slice N+1 bought the question again.
 */
export const COMPLETED_RUN_STATUSES: readonly string[] = ["succeeded", "empty", "reused"];
const COMPLETED_STATUSES = new Set(COMPLETED_RUN_STATUSES);

export function recoverCompletedRuns(rows: readonly LedgerStartedRow[]): RecoveredCompletedRun[] {
  const out: RecoveredCompletedRun[] = [];
  const seenRuns = new Set<string>();
  const seenFingerprints = new Set<string>();
  for (const r of rows) {
    if (!COMPLETED_STATUSES.has(String(r.status ?? ""))) continue;
    const runId = typeof r.provider_run_id === "string" ? r.provider_run_id.trim() : "";
    if (!runId || seenRuns.has(runId)) continue;
    const provider = typeof r.capability === "string" ? r.capability.trim() : "";
    if (!provider) continue;
    const actorInput = (r.request_input ?? {})["input"];
    if (actorInput === undefined || actorInput === null) continue;
    const fingerprint = inputFingerprint(actorInput);
    const key = `${provider}:${fingerprint}`;
    if (seenFingerprints.has(key)) continue;
    seenRuns.add(runId);
    seenFingerprints.add(key);
    out.push({
      provider, run_id: runId,
      dataset_id: typeof r.dataset_id === "string" && r.dataset_id ? r.dataset_id : null,
      input_fingerprint: fingerprint,
    });
  }
  return out;
}
