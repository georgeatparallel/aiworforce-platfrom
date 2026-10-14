// LEAD V2 REPLAY LAB — FAILURE INJECTION ACROSS A WHOLE LINEAGE.
//
// A production lineage replayed slice by slice through everything that stands
// between two slices, with faults injected where production has failed:
//
//   queue        PGlite running the production queue migrations; the production
//                worker runner (`createLeadMissionRunner`), worker core
//                (`workerTick` / `runClaimedMission`) and release
//                (`releaseQueuedMission`)
//   claim        `claim_sourcing_continuation` / `release_sourcing_continuation`,
//                the production SQL, through the production TS wrappers
//   lease        `acquire_lineage_lease` / `release_lineage_lease`, the same
//   checkpoint   `tasks.result` in that database, written at every stage
//                boundary and at slice end through the production progress
//                guard (`guardProgressWrite`), read back through
//                `readCheckpointCompanies`
//   ledger       `lead_execution_calls` as the transport writes it: one row per
//                provider call, started → run id → outcome, independent of the
//                checkpoint; on resume the production recovery
//                (`recoverCompletedRuns`, `recoverPendingRuns`,
//                `mergePendingRuns`) rebuilds what a lost checkpoint forgot
//   engine       the production capability engine on the fixture's recorded rows
//   decision     the production fold and continuation (`foldAndDecide`)
//
// THE ONE MIRROR. `ChaosLab.handle` is run-agent's V2 slice sequence — claim,
// lease, restore + ledger recovery, engine (stage-boundary writes), fold,
// end-of-slice write, claim release (retried), lineage release — written out
// because run-agent cannot be imported without its network and database. Each
// step calls the production function run-agent calls; the order is pinned to
// run-agent's source by tests/replay/failure/sourceOrder.test.ts.
//
// TIME is the database's: `advance(seconds)` moves every lease, claim and
// backoff in it, which is how a dead worker's lease expires.
//
// ZERO network, ZERO provider spend, ZERO production writes.

import {
  claimContinuationViaRpc, releaseContinuationViaRpc, type RpcDb,
} from "../../../supabase/functions/_shared/continuationClaim.ts";
import { acquireLineageLease, releaseLineageLease } from "../../../supabase/functions/_shared/lineageLease.ts";
import {
  type LedgerStartedRow, mergePendingRuns, recoverCompletedRuns, recoverPendingRuns,
} from "../../../supabase/functions/_shared/pendingRunRecovery.ts";
import { guardProgressWrite, resolveLineageProgress } from "../../../supabase/functions/_shared/lineageProgressGuard.ts";
import {
  LINEAGE_PROGRESS_KEY, type LineageProgress, lineageIsFinished,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import {
  buildCheckpoint, CHECKPOINT_RESULT_KEY, inputFingerprint, readCheckpointCompanies,
} from "../../../supabase/functions/_shared/leadResumeState.ts";
import { retryTransient } from "../../../supabase/functions/_shared/retryTransient.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import {
  type ClaimedMission, type ReleaseOutcome, type WorkerDeps, workerTick,
} from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";
import { isTerminalQueueStatus, releaseQueuedMission } from "../../../supabase/functions/_shared/leadMissionTerminal.ts";
import { reconcileTerminalRows, type TerminalRowsDb } from "../../../supabase/functions/_shared/leadMissionCancellation.ts";
import { terminalStatusOf } from "../../../supabase/functions/_shared/leadMissionV2Request.ts";
import type { CheckpointSnapshot } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { createLeadMissionRunner } from "../../../worker/leadMissionRunner.ts";
import type { RunAgentRunOptions } from "../../../supabase/functions/run-agent/index.ts";
import { FixtureProvider } from "./provider.ts";
import {
  type FencedTaskDb, type FencedTaskQuery, fencedTaskUpdate, OPEN_RESULT_FILTER, resolveSliceGeneration, type SliceFence,
} from "../../../supabase/functions/_shared/fencedTaskWrite.ts";
import { replayEngineSlice } from "./engine.ts";
import {
  applyRecordedWebsiteReread, foldAndDecide, type LineageFixture, recordedGrounder, recordedReplanner, replenishmentFrom,
} from "./lineage.ts";
import { QueueLab, REPLAY_WORKSPACE } from "./queue.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));

/** One `create function` block of a migration, verbatim, as `create or replace`. */
export function functionSql(file: string, name: string): string {
  const src = read(file);
  const start = src.search(new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${name}\\(`, "i"));
  if (start < 0) throw new Error(`${name} is not defined in ${file}`);
  const as = /\bas\s+(\$[a-z_]*\$)/i.exec(src.slice(start));
  if (!as) throw new Error(`${name}: no dollar-quoted body`);
  const tag = as[1];
  const bodyAt = start + as.index + as[0].length;
  const end = src.indexOf(tag, bodyAt);
  return src.slice(start, end + tag.length).replace(/^create\s+function/i, "create or replace function") + ";";
}

/** The columns the claim and lease functions read, over the queue lab's reduced tables. */
const CHAOS_COLUMNS = `
  alter table public.tasks
    add column workspace_id uuid, add column lineage_id uuid, add column result jsonb,
    add column checkpoint_version integer not null default 0, add column continuation_claimed_at timestamptz;
  alter table public.lead_lineages
    add column mission_hash text, add column state_version integer not null default 0, add column current_state jsonb,
    add column generation integer not null default 0, add column terminal_reason text, add column last_progress_at timestamptz;
`;

/** The production SQL each function comes from — the newest definition of each. */
export const CHAOS_FUNCTIONS: Array<[file: string, name: string]> = [
  ["supabase/migrations/20260904120000_claim_fences_on_lineage_status.sql", "claim_sourcing_continuation"],
  ["supabase/migrations-held/20260816120000_baseline_schema.sql", "release_sourcing_continuation"],
  ["supabase/migrations/20260903160000_cancellation_row_fence.sql", "acquire_lineage_lease"],
  ["supabase/migrations/20260903160000_cancellation_row_fence.sql", "release_lineage_lease"],
];

// ── FAULTS ──────────────────────────────────────────────────────────────────

/** Where a slice (one handler invocation, counted from 1) fails. */
export type Fault =
  /** Every stage-boundary checkpoint write of the slice is lost (statement timeout). */
  | { kind: "stage_writes_lost"; attempt: number }
  /** The end-of-slice task-result write is lost (eb0d520f: ~161 s, then gone). */
  | { kind: "end_write_lost"; attempt: number }
  /** The worker process dies right after the engine: no end write, no claim or lineage release, no queue release. */
  | { kind: "worker_dies_after_engine"; attempt: number }
  /** Every attempt (3) to release the continuation claim fails transiently (57014). */
  | { kind: "claim_release_fails"; attempt: number }
  /** The lineage-lease release fails transiently. */
  | { kind: "lineage_release_fails"; attempt: number };

/** `lead_execution_calls`, as the transport writes it. */
export interface LedgerRow extends LedgerStartedRow {
  task_id: string;
  idempotency_key: string | null;
  estimate_usd: number | null;
  attempt: number;
  /** A re-read of a run already paid for (an adoption): nothing bought. */
  reused: boolean;
}

export class WorkerKilled extends Error {
  constructor() { super("the worker process died"); this.name = "WorkerKilled"; }
}

const TRANSIENT = { error: { code: "57014", message: "canceling statement due to statement timeout" }, data: null };

export interface ChaosEvent { attempt: number; at: string; detail?: Record<string, unknown> }

export class ChaosLab {
  readonly ledger: LedgerRow[] = [];
  readonly events: ChaosEvent[] = [];
  readonly releases: Array<{ attempt: number; finalStatus: string; reason: string | null }> = [];
  /** Every handler invocation that answered, with what it returned (a killed worker's never does). */
  readonly runs: Array<{
    attempt: number; http: number; reason?: string; decision?: string; terminal?: string | null; qualified?: string[];
  }> = [];
  /** What the worker's terminal reconciliation found and wrote. */
  readonly reconciled: Array<{ violations: string[]; written: string[]; remaining: string[] }> = [];
  /** Every handler invocation, answered or not: the slice attempt number. */
  invocations = 0;
  private killed = false;
  /** Set by `stalledWorker`: the next slice to reach its end-of-slice write waits here. */
  private hold: { reached: () => void; gate: Promise<void> } | null = null;
  private readonly deps: Record<string, unknown>;
  readonly taskId: string;
  queueId = "";

  private constructor(
    readonly lab: QueueLab, readonly fx: LineageFixture, readonly faults: readonly Fault[], deps?: Record<string, unknown>,
  ) {
    const m = fx.engine.model_responses;
    // One recorded model per mission: a re-run slice is answered as a live model
    // would answer again — the next recorded answer, never a replay of the last.
    this.deps = deps ?? {
      ...(m.replan_queries ? { planDiscovery: recordedReplanner(m.replan_queries) } : {}),
      ...(m.proven_business_models ? { evaluateBatch: recordedGrounder(m.proven_business_models) } : {}),
    };
    this.taskId = fx.provenance.task_id;
  }

  /** `deps`: the mission's recorded model answers, when the fixture's own (re-planner, grounder) do not apply. */
  static async open(fx: LineageFixture, faults: readonly Fault[] = [], o: { deps?: Record<string, unknown> } = {}): Promise<ChaosLab> {
    const lab = await QueueLab.open({
      extraSql: [CHAOS_COLUMNS, ...CHAOS_FUNCTIONS.map(([f, n]) => functionSql(f, n))],
    });
    const c = new ChaosLab(lab, fx, faults, o.deps);
    c.queueId = await lab.enqueue({ plan_id: crypto.randomUUID(), tool_input: {} });
    return c;
  }

  private note(attempt: number, at: string, detail?: Record<string, unknown>) {
    this.events.push({ attempt, at, ...(detail ? { detail } : {}) });
  }
  private fault(attempt: number, kind: Fault["kind"]) {
    return this.faults.some((f) => f.attempt === attempt && f.kind === kind);
  }
  /**
   * The lab's RPC as the production wrappers take it — with PostgREST's rule
   * for a function returning a SCALAR (`release_sourcing_continuation` returns
   * boolean): `data` is the value itself, not a one-column row.
   */
  private async call(fn: string, args: Record<string, unknown>) {
    const r = await this.lab.rpc(fn, args);
    const rows = r.data as Array<Record<string, unknown>> | null;
    if (!r.error && Array.isArray(rows) && rows.length === 1) {
      const keys = Object.keys(rows[0]);
      if (keys.length === 1 && keys[0] === fn) return { data: rows[0][fn], error: null };
    }
    return r;
  }
  private get db(): RpcDb {
    return { rpc: (fn, args) => this.call(fn, args) };
  }
  private rpcFailing = (fail: () => boolean): RpcDb => ({
    rpc: (fn, args) => fail() ? Promise.resolve(TRANSIENT) : this.call(fn, args),
  });

  // ── THE DURABLE CLOCK ──────────────────────────────────────────────────────

  /** Time passes for the database: every lease, claim and backoff moves `seconds` closer. */
  async advance(seconds: number): Promise<void> {
    const s = `interval '${Math.trunc(seconds)} seconds'`;
    await this.lab.db.exec(`
      update public.lead_mission_queue set lease_expires_at = lease_expires_at - ${s}, not_before = not_before - ${s};
      update public.tasks set continuation_claim_expires_at = continuation_claim_expires_at - ${s};
      update public.lead_lineages set lease_expires_at = lease_expires_at - ${s};
    `);
  }

  // ── THE TRANSPORT'S LEDGER ─────────────────────────────────────────────────

  private providerFor(attempt: number): FixtureProvider {
    const p = new FixtureProvider(this.fx.provider_responses, { runIdPrefix: `a${attempt}-` });
    const invoke = p.invoke;
    p.invoke = async (call) => {
      const spec = call.providerCallSpec;
      const row: LedgerRow = {
        task_id: this.taskId, capability: call.actorKey, provider_id: call.actorKey, provider_run_id: null, dataset_id: null,
        status: "started", request_input: { input: call.input ?? {}, provider_call_spec: spec ?? null },
        idempotency_key: spec?.idempotency_key ?? null, estimate_usd: spec?.cost.estimate_usd ?? null,
        started_at: new Date(Date.UTC(2026, 9, 12, 0, 0, this.ledger.length)).toISOString(), created_at: null,
        attempt, reused: !!call.resumeRunId,
      };
      this.ledger.push(row);
      try {
        const rows = await invoke({ ...call, onProviderRun: (r) => { row.provider_run_id = r.run_id; call.onProviderRun?.(r); } });
        row.status = call.resumeRunId ? "reused" : rows.length > 0 ? "succeeded" : "empty";
        // ADOPTION SETTLES THE STARTED ROW IN PLACE (pendingRunRecovery: task e01ad74f).
        if (call.resumeRunId) {
          for (const r of this.ledger) {
            if (r !== row && r.provider_run_id === call.resumeRunId && r.status === "started") r.status = rows.length > 0 ? "succeeded" : "empty";
          }
        }
        return rows;
      } catch (e) {
        const pending = (e as { toolResult?: { pending?: unknown } }).toolResult?.pending === true;
        row.status = pending ? "started" : "failed";
        throw e;
      }
    };
    return p;
  }

  /** What run-agent reads back on resume (`completedRunRows`, `startedRunRows`, `resolvedRunIds`). */
  private recovery() {
    const mine = this.ledger.filter((r) => r.task_id === this.taskId);
    const completed = mine.filter((r) => (r.status === "succeeded" || r.status === "empty") && r.provider_run_id)
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    const started = mine.filter((r) => r.status === "started" && r.provider_run_id);
    const ids = new Set(started.map((r) => r.provider_run_id!));
    const resolved = new Set(mine.filter((r) => ids.has(r.provider_run_id ?? "") &&
      ["reused", "succeeded", "failed", "timed_out"].includes(String(r.status))).map((r) => r.provider_run_id!));
    return { completed: recoverCompletedRuns(completed), pending: recoverPendingRuns(started, resolved), resolved };
  }

  // ── THE TASK ROW ───────────────────────────────────────────────────────────

  async taskRow(): Promise<{ status: string | null; result: Record<string, unknown> | null } | null> {
    const r = await this.lab.db.query<{ status: string | null; result: Record<string, unknown> | null }>(
      `select status, result from public.tasks where id = $1`, [this.taskId]);
    return r.rows[0] ?? null;
  }

  /** Every task-result write goes through the production progress guard, as run-agent's do. */
  /**
   * Every task-result write goes through the production progress guard AND the
   * production fence (`fencedTaskUpdate`), as run-agent's do: one conditional
   * UPDATE on `checkpoint_version` (and, before the slice's verdict, an open row).
   */
  private async writeResult(
    path: string, next: (prior: Record<string, unknown>) => Record<string, unknown>, status: string,
    fence: SliceFence, requireOpen: boolean,
  ) {
    const prior = (await this.taskRow())?.result ?? {};
    const g = guardProgressWrite(path, prior, next(prior));
    return await fencedTaskUpdate(this.fencedDb, this.taskId, fence, { requireOpen }, { result: g.result, status });
  }

  /**
   * PostgREST's update builder over the lab database: exactly the filters
   * `fencedTaskUpdate` sends (`eq`, and the open-row `or`), as one statement.
   */
  private get fencedDb(): FencedTaskDb {
    const db = this.lab.db;
    return {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => {
          const where: string[] = [];
          const params: unknown[] = [];
          const set = Object.keys(patch).map((k) => {
            params.push(k === "result" ? JSON.stringify(patch[k]) : patch[k]);
            return `${k} = $${params.length}`;
          });
          const q: FencedTaskQuery = {
            eq: (column, value) => { params.push(value); where.push(`${column} = $${params.length}`); return q; },
            or: (filters) => {
              if (filters !== OPEN_RESULT_FILTER) throw new Error(`lab adapter: unsupported or(${filters})`);
              where.push(`(result->>'terminal_status' is null or result->>'terminal_status' = 'continuation_required')`);
              return q;
            },
            select: async () => {
              const r = await db.query<{ id: string }>(
                `update public.${table} set ${set.join(", ")}, updated_at = now() where ${where.join(" and ")} returning id`, params);
              return { data: r.rows, error: null };
            },
          };
          return q;
        },
      }),
    };
  }

  /** run-agent's `resolveSliceGeneration` read, over the lab database. */
  private get generationDb() {
    const db = this.lab.db;
    return {
      from: (_t: string) => ({
        select: (_c: string) => ({
          eq: (_k: string, v: unknown) => ({
            maybeSingle: async () => ({
              data: (await db.query(`select checkpoint_version from public.tasks where id = $1`, [v])).rows[0] ?? null,
              error: null,
            }),
          }),
        }),
      }),
    };
  }

  private checkpointResult(state: Record<string, unknown>, records: unknown[]) {
    return {
      capability_execution_state: state,
      [CHECKPOINT_RESULT_KEY]: buildCheckpoint({
        now: 0, deadlineAt: 0, remainingMs: 0, lastCompletedCapability: null, nextPendingCapability: null,
        companies: records as never, reason: "execution_deadline_checkpoint",
        discoverySourceState: (state.discovery_source_state ?? null) as never,
      }),
    };
  }

  // ── THE SLICE (run-agent's V2 sequence) ────────────────────────────────────

  handle = async (req: Request, opts: RunAgentRunOptions): Promise<Response> => {
    const body = await req.json() as Record<string, unknown>;
    const attempt = ++this.invocations;
    const respond = (http: number, payload: Record<string, unknown>, reason?: string) => {
      this.runs.push({
        attempt, http, ...(reason ? { reason } : {}),
        ...(typeof payload.decision === "string"
          ? { decision: payload.decision, terminal: (payload.terminal ?? null) as string | null, qualified: payload.qualified as string[] }
          : {}),
      });
      return new Response(JSON.stringify({ task_id: this.taskId, ...payload }), { status: http });
    };
    const resume = typeof body.resume_task_id === "string" ? body.resume_task_id : null;
    if (!resume) {
      await this.lab.db.query(
        `insert into public.tasks (id, workspace_id, lineage_id, status, result) values ($1, $2, $1, 'running', null) on conflict (id) do nothing`,
        [this.taskId, REPLAY_WORKSPACE]);
    }
    await opts.onExecutionBound?.({ taskId: this.taskId, lineageId: this.taskId, holdsLease: true });

    // 1. THE CONTINUATION CLAIM — a resumed slice only. Held by someone: 409.
    let claimId: string | null = null;
    let claimedVersion: number | null = null;
    if (resume) {
      claimId = crypto.randomUUID();
      const c = await claimContinuationViaRpc({ db: this.db, taskId: this.taskId, workspaceId: REPLAY_WORKSPACE, claimId });
      if (!c.available) throw new Error("claim_sourcing_continuation is missing from the lab database");
      if (!c.claimed) {
        this.note(attempt, "claim_refused", { reason: c.reason });
        return respond(409, { success: false, error: "continuation_refused", reason: c.reason }, c.reason);
      }
      claimedVersion = c.checkpointVersion;
    }
    // 2. THE LINEAGE LEASE.
    const lease = await acquireLineageLease({
      db: this.db, lineageId: this.taskId, workspaceId: REPLAY_WORKSPACE, holderTaskId: this.taskId,
    });
    if (!lease.acquired) {
      const reason = String(lease.reason);
      this.note(attempt, "lease_refused", { reason });
      if (claimId) {
        await releaseContinuationViaRpc({ db: this.db, taskId: this.taskId, workspaceId: REPLAY_WORKSPACE, claimId, rowStatus: "ready" });
      }
      return respond(409, { success: false, error: "lineage_busy", reason }, reason);
    }

    // THIS SLICE'S GENERATION (run-agent `sliceFence`, D1).
    const fence: SliceFence = { generation: await resolveSliceGeneration(this.generationDb as never, this.taskId, claimedVersion) };

    // 3. RESTORE: the checkpoint, plus what the ledger knows that it does not.
    const prior = (await this.taskRow())?.result ?? null;
    const restored = (prior?.capability_execution_state ?? null) as Record<string, unknown> | null;
    const records = prior ? readCheckpointCompanies(prior) as unknown[] : [];
    const rec = resume ? this.recovery() : null;
    const state = restored && rec
      ? {
        ...restored,
        ...(rec.completed.length > 0 ? { completed_runs: rec.completed } : {}),
        pending_runs: mergePendingRuns((restored.pending_runs ?? []) as Array<{ run_id: string }>, rec.pending, rec.resolved),
      }
      : restored;
    const progressBefore: LineageProgress = resolveLineageProgress({
      stored: prior?.[LINEAGE_PROGRESS_KEY], lineageState: lease.currentState,
      queueContinuations: opts.queueContinuations ?? null,
    }).progress;
    const lastDecision = ((prior?.auto_continuation as { decision?: string } | undefined)?.decision) ?? null;

    // 4. THE ENGINE, writing a checkpoint at every stage boundary.
    const stageWritesLost = this.fault(attempt, "stage_writes_lost");
    const s = await replayEngineSlice(this.fx, {
      provider: this.providerFor(attempt),
      deps: {
        ...this.deps,
        ...(opts.deadline ? { deadline: opts.deadline } : {}),
        onCheckpoint: async (snap: CheckpointSnapshot) => {
          if (!snap.coherent) return { written: false, reason: "incoherent" };
          const st = snap.state as unknown as { provider_attempts: unknown[]; pending_runs: unknown[] };
          if (st.provider_attempts.length === 0 && st.pending_runs.length === 0) return { written: false, reason: "nothing_bought_yet" };
          if (stageWritesLost) { this.note(attempt, "stage_write_lost"); return { written: false, reason: "57014" }; }
          // A FINALIZED VERDICT OWNS THE ROW: a late stage write never resurrects it (run-agent).
          const priorTerminal = (await this.taskRow())?.result?.terminal_status;
          if (typeof priorTerminal === "string" && priorTerminal !== "continuation_required") {
            this.note(attempt, "stage_write_refused", { prior_terminal: priorTerminal });
            return { written: false, reason: `prior_terminal:${priorTerminal}` };
          }
          const w = await this.writeResult("stage_boundary", (p) => ({
            ...p, task_status: "partial", terminal_status: "continuation_required", company_first_state: { terminal_status: null },
            ...this.checkpointResult(snap.state as unknown as Record<string, unknown>, snap.resume_records as unknown[]),
          }), "running", fence, true);
          if (w.fenced) {
            this.note(attempt, "stage_write_fenced", { generation: fence.generation });
            return { written: false, reason: "fenced_stale_generation" };
          }
          return { written: true };
        },
      },
      ...(state ? { resume: { state, records } } : {}),
      ...replenishmentFrom(restored, lastDecision),
    });
    if (this.fault(attempt, "worker_dies_after_engine")) {
      this.killed = true;
      this.note(attempt, "worker_died");
      throw new WorkerKilled();
    }
    applyRecordedWebsiteReread(this.fx, s);

    // 5. THE FOLD AND THE DECISION.
    const f = foldAndDecide(this.fx, s, progressBefore, this.taskId);
    const terminal = f.terminal;

    // A STALLED WORKER waits here, its slice computed and unwritten.
    if (this.hold) {
      const h = this.hold;
      this.hold = null;
      this.note(attempt, "stalled_before_end_write");
      h.reached();
      await h.gate;
    }
    // 6. THE END-OF-SLICE WRITE.
    if (this.fault(attempt, "end_write_lost")) {
      this.note(attempt, "end_write_lost");
    } else {
      const w = await this.writeResult("slice_end", (p) => ({
        ...p, ...this.checkpointResult(s.state, s.resume_records),
        [LINEAGE_PROGRESS_KEY]: f.progress,
        auto_continuation: { decision: String(f.decision.reason), continue: f.decision.continue },
        task_status: terminal ? "complete" : "partial",
        terminal_status: terminal ?? "continuation_required",
        company_first_state: { terminal_status: terminal },
      }), terminal ? "complete" : "ready", fence, true);
      if (w.fenced) this.note(attempt, "end_write_fenced", { generation: fence.generation });
    }

    // 7. RELEASE THE CLAIM — retried on a transient failure, exactly as run-agent.
    if (claimId) {
      const failing = this.fault(attempt, "claim_release_fails");
      const { result, attempts } = await retryTransient(
        () => releaseContinuationViaRpc({
          db: this.rpcFailing(() => failing), taskId: this.taskId, workspaceId: REPLAY_WORKSPACE, claimId: claimId!,
          rowStatus: terminal ? "complete" : "ready",
        }),
        (r) => !r.released && (r.category === "transport" || r.category === "database" || r.category === "unknown"),
        { attempts: 3, delaysMs: [0, 0] },
      );
      this.note(attempt, "claim_release", { released: result.released, attempts });
    }
    // 8. RELEASE THE LINEAGE — the completion barrier. Retried only on
    // `release_unavailable`; terminal only for an ending that leaves nothing to
    // resume (`lineageIsFinished`), exactly as run-agent.
    const failingLease = this.fault(attempt, "lineage_release_fails");
    const { result: rel } = await retryTransient(
      () => releaseLineageLease({
        db: this.rpcFailing(() => failingLease), lineageId: this.taskId, workspaceId: REPLAY_WORKSPACE,
        holderTaskId: this.taskId, expectedVersion: lease.stateVersion,
        nextState: { [LINEAGE_PROGRESS_KEY]: f.progress }, madeProgress: !f.progress.barren_slices,
        ...(lineageIsFinished(f.decision as never) ? { terminalReason: String(f.decision.reason) } : {}),
      }),
      (r) => !r.released && "reason" in r && r.reason === "release_unavailable",
      { attempts: 3, delaysMs: [0, 0] },
    );
    this.note(attempt, "lineage_release", { released: rel.released, ...("reason" in rel ? { reason: rel.reason } : {}) });
    const qualified = f.view.leads.filter((l) => l.label !== null).map((l) => String(l.company.name)).sort();
    return respond(200, { success: true, terminal, decision: String(f.decision.reason), qualified });
  };

  // ── THE WORKER ─────────────────────────────────────────────────────────────

  /** worker/main.ts's `rowsDb`, over the lab database. */
  private get rowsDb(): TerminalRowsDb {
    const db = this.lab.db;
    return {
      readTask: async (id) => (await db.query<{ status: string | null; result: Record<string, unknown> | null }>(
        `select status, result from public.tasks where id = $1`, [id])).rows[0] ?? null,
      readLineage: async (id) => (await db.query<{ status: string | null }>(
        `select status from public.lead_lineages where lineage_id = $1`, [id])).rows[0] ?? null,
      readPlan: () => Promise.resolve(null),
      writeTask: async (id, patch) => {
        await db.query(`update public.tasks set status = $2, result = $3 where id = $1`, [id, patch.status, JSON.stringify(patch.result)]);
      },
      writeLineage: async (id, patch) => {
        await db.query(`update public.lead_lineages set status = $2, terminal_reason = $3, lease_holder = null, lease_expires_at = null where lineage_id = $1`,
          [id, patch.status, patch.terminal_reason]);
      },
      writePlan: () => Promise.resolve(),
    };
  }

  workerDeps(): WorkerDeps {
    const workerId = crypto.randomUUID();
    const runner = createLeadMissionRunner({
      handler: this.handle, serviceRoleKey: "replay", functionsBaseUrl: "https://replay.invalid/functions/v1",
      createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs }),
      bind: async (queueId, taskId, lineageId) => {
        const { data } = await this.lab.rpc("bind_lead_mission_execution", {
          p_queue_id: queueId, p_worker_id: workerId, p_task_id: taskId, p_lineage_id: lineageId,
        });
        return (data as Array<{ bound?: boolean }> | null)?.[0]?.bound === true;
      },
      readTaskOutcome: async () => {
        const row = await this.taskRow();
        if (!row) return null;
        const result = row.result ?? {};
        const progress = result[LINEAGE_PROGRESS_KEY] as { continuations_used?: number } | undefined;
        return {
          status: row.status, terminal_status: terminalStatusOf(result),
          lineage_slices: typeof progress?.continuations_used === "number" ? progress.continuations_used : null,
          continuation_decision: (result.auto_continuation as { decision?: string } | undefined)?.decision ?? null,
        };
      },
    });
    return {
      workerId,
      config: { leaseSeconds: 180, heartbeatIntervalMs: 60_000, missionCeilingMs: 300_000, idlePollMs: 1, cancelSweepIntervalMs: 60_000 },
      claim: async (wid, leaseSeconds) => {
        const { data, error } = await this.lab.rpc("claim_next_lead_mission", { p_worker_id: wid, p_lease_seconds: leaseSeconds });
        const r = (data as Array<Record<string, unknown>> | null)?.[0];
        if (error || !r || r.claimed !== true) return { claimed: false, reason: String(r?.reason ?? "error") };
        // The worker reads the queue's continuation count beside the claim (worker/main.ts).
        const q = await this.lab.row(String(r.queue_id));
        const mission: ClaimedMission = {
          queueId: String(r.queue_id), workspaceId: String(r.workspace_id),
          request: (typeof r.request === "string" ? JSON.parse(r.request) : r.request) as Record<string, unknown>,
          taskId: (r.task_id as string | null) ?? null, lineageId: (r.lineage_id as string | null) ?? null,
          attempts: Number(r.attempts), isResume: !!r.task_id, heldUntil: null,
          continuations: Number.isInteger(q.continuations) ? q.continuations! : null,
        };
        return { claimed: true, mission };
      },
      heartbeatFor: () => ({ start() {}, stop() {} }),
      runMission: async (m, ctl) => {
        try { return await runner.run(m, ctl); } catch (e) {
          if (e instanceof WorkerKilled) return { status: "killed", terminal: false };
          throw e;
        }
      },
      release: async (m, outcome: ReleaseOutcome) => {
        // A DEAD PROCESS RELEASES NOTHING: its lease has to expire.
        if (this.killed) { this.killed = false; return; }
        const r = await releaseQueuedMission(this.lab.rpc, {
          queueId: m.queueId, workerId, attempts: m.attempts, outcome,
          outcomeDoc: {
            status: outcome.status, terminal: outcome.terminal, error: outcome.error ?? null,
            lineage_slices: outcome.lineageSlices ?? null, continuation_decision: outcome.continuationDecision ?? null,
          },
        });
        this.releases.push({ attempt: this.invocations, finalStatus: r.finalStatus, reason: r.terminalReason });
        // THE QUEUE'S END IS THE TASK'S AND THE LINEAGE'S (worker/main.ts `reconcileTerminal`).
        if (isTerminalQueueStatus(r.finalStatus)) {
          const taskId = outcome.taskId ?? m.taskId;
          this.reconciled.push(await reconcileTerminalRows(this.rowsDb, r.finalStatus, r.terminalReason ?? r.finalStatus,
            { taskId, lineageId: m.lineageId ?? taskId, planId: null }, new Date().toISOString()));
        }
      },
      sleep: async () => {},
    };
  }

  /** One worker tick: claim (if anything is claimable) and run one slice. */
  tick(): Promise<{ claimed: boolean; reason?: string }> {
    return workerTick(this.workerDeps());
  }

  /**
   * Run until the queue row settles. An idle tick lets `idleSeconds` pass, so a
   * dead worker's lease, a held claim and a backoff all expire on their own.
   */
  async runToSettle(o: { maxTicks?: number; idleSeconds?: number } = {}): Promise<{ queue: string; ticks: number }> {
    const max = o.maxTicks ?? 60;
    for (let i = 0; i < max; i++) {
      const row = await this.lab.row(this.queueId);
      if (["complete", "failed", "cancelled"].includes(row.status)) return { queue: row.status, ticks: i };
      const t = await this.tick();
      if (!t.claimed) await this.advance(o.idleSeconds ?? 60);
    }
    return { queue: (await this.lab.row(this.queueId)).status, ticks: max };
  }

  /**
   * A worker that STALLS mid-slice (a network partition: no heartbeat, still
   * running). It claims and runs one slice through the engine and the fold,
   * then waits before its end-of-slice write until `resume()`. Meanwhile its
   * lease can expire and another worker take the mission over.
   */
  async stalledWorker(): Promise<{ resume: () => Promise<void> }> {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let reached!: () => void;
    const atEnd = new Promise<void>((r) => { reached = r; });
    this.hold = { reached, gate };
    const done = this.tick();
    await Promise.race([atEnd, done.then(() => { throw new Error("the stalled worker never reached its end-of-slice write"); })]);
    return { resume: async () => { open(); await done; } };
  }

  // ── WHAT A TEST ASSERTS ON ─────────────────────────────────────────────────

  /** Provider work BOUGHT (not re-read), by the question asked: provider + input fingerprint. */
  purchases(): Array<{ key: string; idempotency_key: string | null; attempt: number; actor: string }> {
    return this.ledger.filter((r) => !r.reused && r.status !== "failed").map((r) => ({
      key: `${r.capability}:${inputFingerprint((r.request_input as { input?: unknown } | null)?.input ?? {})}`,
      idempotency_key: r.idempotency_key, attempt: r.attempt, actor: String(r.capability),
    }));
  }

  /** Questions bought more than once. Empty is the invariant. */
  duplicatePurchases(): string[] {
    const seen = new Map<string, number>();
    for (const p of this.purchases()) seen.set(p.key, (seen.get(p.key) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
  }

  async lineageRow() {
    return (await this.lab.db.query<Record<string, unknown>>(
      `select status, lease_holder, lease_expires_at, state_version, terminal_reason, current_state from public.lead_lineages where lineage_id = $1`,
      [this.taskId])).rows[0] ?? null;
  }

  async claimHeld(): Promise<boolean> {
    const r = await this.lab.db.query<{ continuation_claim_id: string | null }>(
      `select continuation_claim_id from public.tasks where id = $1`, [this.taskId]);
    return !!r.rows[0]?.continuation_claim_id;
  }

  close = () => this.lab.close();
}
