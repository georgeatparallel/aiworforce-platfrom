// LEAD V2 REPLAY LAB — THE QUEUE, ON THE REAL SQL.
//
// PGlite (PostgreSQL 16 in WASM, in-process, nothing reachable) runs the V2
// queue migration and the continuations-not-retries fix verbatim; the worker
// side is the production worker core (`workerTick`) and the production release
// (`releaseQueuedMission`). Only the mission handler is supplied by the replay,
// and its decisions come from the production continuation functions.
//
// Adapted from tests/infra/leadMissionV2ContinuationsNotRetries.test.ts, which
// first replayed canary 53784493 this way.

import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  type ClaimedMission, type MissionOutcome, type WorkerDeps, workerTick,
} from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";
import { type QueueRpc, releaseQueuedMission } from "../../../supabase/functions/_shared/leadMissionTerminal.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));

/** The queue migrations production runs, in order. */
export const QUEUE_MIGRATIONS = [
  "supabase/migrations-held/20260910140000_lead_mission_v2_claim.sql",
  "supabase/migrations-held/20261003120000_lead_mission_v2_continuations_not_retries.sql",
];

// The tables the queue functions read, reduced to the columns they touch.
const PRELUDE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create table public.workspaces (id uuid primary key);
  create table public.lead_lineages (
    lineage_id uuid primary key, workspace_id uuid not null, status text not null default 'active',
    lease_holder uuid, lease_expires_at timestamptz, updated_at timestamptz default now()
  );
  create table public.tasks (
    id uuid primary key, status text, updated_at timestamptz default now(),
    continuation_claim_id uuid, continuation_claim_expires_at timestamptz
  );
`;

export const REPLAY_WORKSPACE = "00000000-0000-4000-8000-00000000a11a";

export interface QueueRow { id: string; status: string; attempts: number; continuations?: number; claimed_by: string | null }

export class QueueLab {
  private constructor(readonly db: PGlite) {}

  static async open(o: { migrations?: readonly string[]; extraSql?: readonly string[] } = {}): Promise<QueueLab> {
    const db = new PGlite();
    await db.exec(PRELUDE);
    for (const m of o.migrations ?? QUEUE_MIGRATIONS) await db.exec(read(m));
    // More production SQL over the same database (the continuation claim, the
    // lineage lease), with whatever columns those functions read.
    for (const sql of o.extraSql ?? []) await db.exec(sql);
    await db.query(`insert into public.workspaces (id) values ($1)`, [REPLAY_WORKSPACE]);
    return new QueueLab(db);
  }

  /** `db.rpc(fn, args)` as PostgREST performs it: named arguments; a missing function is PGRST202. */
  rpc: QueueRpc = async (fn, args) => {
    const keys = Object.keys(args);
    const vals = keys.map((k) => { const v = args[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
    const call = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    try {
      const r = await this.db.query(`select * from public.${fn}(${call})`, vals);
      return { data: r.rows, error: null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "42883") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  };

  async enqueue(request: Record<string, unknown> = { plan_id: crypto.randomUUID() }): Promise<string> {
    const r = await this.db.query<{ id: string }>(
      `insert into public.lead_mission_queue (workspace_id, request) values ($1, $2) returning id`,
      [REPLAY_WORKSPACE, JSON.stringify(request)],
    );
    return r.rows[0].id;
  }

  async row(id: string): Promise<QueueRow> {
    return (await this.db.query<QueueRow>(`select * from public.lead_mission_queue where id = $1`, [id])).rows[0];
  }

  /** The resumable backoff, elapsed. Test-only time travel. */
  backoffElapses = () => this.db.exec(`update public.lead_mission_queue set not_before = null`);

  /** The production worker core and release over this database, with the replay's handler. */
  worker(handler: (m: ClaimedMission) => Promise<MissionOutcome>) {
    const workerId = crypto.randomUUID();
    const releases: Array<{ finalStatus: string; reason: string | null; fallback: boolean }> = [];
    const deps: WorkerDeps = {
      workerId,
      config: { leaseSeconds: 180, heartbeatIntervalMs: 60_000, missionCeilingMs: 300_000, idlePollMs: 1, cancelSweepIntervalMs: 60_000 },
      claim: async (wid, lease) => {
        const { data, error } = await this.rpc("claim_next_lead_mission", { p_worker_id: wid, p_lease_seconds: lease });
        const r = (data as Array<Record<string, unknown>> | null)?.[0];
        if (error || !r || r.claimed !== true) return { claimed: false, reason: String(r?.reason ?? "error") };
        return {
          claimed: true,
          mission: {
            queueId: String(r.queue_id), workspaceId: String(r.workspace_id),
            request: (typeof r.request === "string" ? JSON.parse(r.request) : r.request) as Record<string, unknown>,
            taskId: (r.task_id as string | null) ?? null, lineageId: (r.lineage_id as string | null) ?? null,
            attempts: Number(r.attempts), isResume: !!r.task_id, heldUntil: null,
          },
        };
      },
      heartbeatFor: () => ({ start() {}, stop() {} }),
      runMission: (m) => handler(m),
      release: async (m, outcome) => {
        const r = await releaseQueuedMission(this.rpc, {
          queueId: m.queueId, workerId, attempts: m.attempts, outcome, outcomeDoc: { status: outcome.status },
        });
        releases.push({ finalStatus: r.finalStatus, reason: r.terminalReason, fallback: r.fallback });
      },
      sleep: async () => {},
    };
    return { releases, tick: () => workerTick(deps) };
  }

  close = () => this.db.close();
}
