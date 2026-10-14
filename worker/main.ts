// LEAD MISSION V2 WORKER — long-running Deno process (NOT an edge function).
//
// Run: deno run --allow-env --allow-net --allow-read worker/main.ts
//
// It claims one V2 queue row at a time, replays its kickoff body into run-agent's
// own handler IN-PROCESS with a longer (revocable) deadline, keeps the queue
// lease — and, once bound, the task and lineage lease — alive with a concurrent
// heartbeat, and releases. State lives entirely in Supabase.
//
// ENVIRONMENT: the same secrets as the run-agent edge function (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY and every provider/model key it
// reads), plus the worker's own: LEAD_V2_WORKER_WORKSPACES, LEAD_WORKER_ID,
// LEAD_WORKER_MAX_RUNTIME_MS (capped at 20 min), LEAD_WORKER_LEASE_SECONDS,
// LEAD_WORKER_HEARTBEAT_MS, LEAD_WORKER_IDLE_POLL_MS.
//
// DISABLED BY DEFAULT. It claims nothing unless a workspace is allowlisted; with
// the allowlist empty it connects, logs "disabled", and idles.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  runWorkerLoop, makeHeartbeatController, DEFAULT_WORKER_CONFIG,
  type WorkerDeps, type WorkerConfig, type ClaimOutcome, type ClaimedMission, type ReleaseOutcome,
} from "../supabase/functions/_shared/leadMissionWorkerCore.ts";
import {
  v2Enabled, clampWorkerCeilingMs, LEAD_WORKER_MAX_RUNTIME_ENV,
} from "../supabase/functions/_shared/leadExecutionEngine.ts";
import { createExecutionDeadline } from "../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { terminalStatusOf } from "../supabase/functions/_shared/leadMissionV2Request.ts";
import {
  isTerminalQueueStatus, releaseQueuedMission,
} from "../supabase/functions/_shared/leadMissionTerminal.ts";
import {
  CANCEL_SWEEP_LIMIT, CANCELLED_REASON, reconcileTerminalRows, sweepCancelledMissions,
  type CancelSweepDb, type TerminalIds,
} from "../supabase/functions/_shared/leadMissionCancellation.ts";
import { resolvePlanNoticesForQueueEnd, supabaseNoticeDb } from "../supabase/functions/_shared/runNotices.ts";
import { createLeadMissionRunner } from "./leadMissionRunner.ts";
import { installTimestampedConsole } from "./logTimestamps.ts";
import { newStatus, healthView, startHealthServer } from "./health.ts";
import { buildInfo } from "../supabase/functions/_shared/buildStamp.ts";
import { mountApi } from "./api/server.ts";
import { sealFunctionListeners } from "./api/routes.ts";

// EVERY LINE CARRIES ITS TIME — the worker's and run-agent's (in-process) alike.
// Query B d22d9ee6 had a 5.5-minute stretch no log line could place.
installTimestampedConsole();

const env = (k: string) => Deno.env.get(k);
const num = (k: string, d: number) => { const v = Number(env(k)); return Number.isFinite(v) && v > 0 ? v : d; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WHAT THIS PROCESS IS FOR.
 *
 *   worker  claim missions from the queue (the default, and what every existing
 *           deployment does today — a container that sets nothing is unchanged
 *           by the API's existence)
 *   api     serve the HTTP routes and claim nothing
 *   both    one container doing both
 *
 * `both` is the recommended shape while the API is small: the two roles share a
 * container, a deploy and one set of secrets, and the work they do is almost
 * entirely waiting on somebody else's network. Splitting them later is this
 * variable and a second Railway service — not a code change — which is the
 * reason the choice is a variable at all.
 */
export type WorkerRole = "worker" | "api" | "both";

export function resolveRole(read: (k: string) => string | undefined): WorkerRole {
  const raw = (read("AGENTORY_ROLE") ?? "").trim().toLowerCase();
  return raw === "api" || raw === "both" || raw === "worker" ? raw : "worker";
}

function config(): WorkerConfig {
  return {
    leaseSeconds: num("LEAD_WORKER_LEASE_SECONDS", DEFAULT_WORKER_CONFIG.leaseSeconds),
    heartbeatIntervalMs: num("LEAD_WORKER_HEARTBEAT_MS", DEFAULT_WORKER_CONFIG.heartbeatIntervalMs),
    missionCeilingMs: clampWorkerCeilingMs(env(LEAD_WORKER_MAX_RUNTIME_ENV)),
    idlePollMs: num("LEAD_WORKER_IDLE_POLL_MS", DEFAULT_WORKER_CONFIG.idlePollMs),
    cancelSweepIntervalMs: num("LEAD_WORKER_CANCEL_SWEEP_MS", DEFAULT_WORKER_CONFIG.cancelSweepIntervalMs),
  };
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

/**
 * THE TASK COLUMNS A TERMINAL DECISION READS — and not `result` itself.
 *
 * `terminalStatusOf` reads `terminal_status`, then `company_first_state
 * .terminal_status`, then `company_first.status`; `terminalViolations` reads
 * `terminal_status` and `task_status`. Projected server-side, that is a few
 * hundred bytes instead of the engine's whole resume state.
 */
const TASK_TERMINAL_COLUMNS =
  "status," +
  "r_terminal_status:result->terminal_status," +
  "r_task_status:result->task_status," +
  "r_cf_status:result->company_first->status," +
  "r_cfs_terminal:result->company_first_state->terminal_status";

/**
 * What the runner reads after a run: the terminal columns plus the lineage's
 * own slice counter, which tells the release whether a slice actually ran.
 */
const TASK_OUTCOME_COLUMNS =
  TASK_TERMINAL_COLUMNS + ",r_lineage_slices:result->lead_lineage_progress->continuations_used" +
  ",r_continuation_decision:result->auto_continuation->>decision";

interface TaskTerminalRow {
  status?: string | null;
  r_terminal_status?: unknown;
  r_task_status?: unknown;
  r_cf_status?: unknown;
  r_cfs_terminal?: unknown;
}

/** The projected keys back into the `result` shape the pure deciders read. */
export function terminalResultOf(row: TaskTerminalRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (row.r_terminal_status != null) out.terminal_status = row.r_terminal_status;
  if (row.r_task_status != null) out.task_status = row.r_task_status;
  if (row.r_cf_status != null) out.company_first = { status: row.r_cf_status };
  if (row.r_cfs_terminal != null) out.company_first_state = { terminal_status: row.r_cfs_terminal };
  return out;
}
const firstRow = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

async function main() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) { console.error("[worker] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required"); Deno.exit(1); }

  // BEFORE the import: no function module may start an HTTP server in this
  // process. The worker only needs run-agent sealed; the API may import three
  // more, so all four flags are set here, once, before anything is loaded.
  sealFunctionListeners();
  const { handleRunAgent } = await import("../supabase/functions/run-agent/index.ts");

  const db = createClient(url, key, { auth: { persistSession: false } });
  const idEnv = env("LEAD_WORKER_ID");
  const workerId = idEnv && UUID.test(idEnv) ? idEnv : crypto.randomUUID();
  const cfg = config();
  const log = (msg: string, meta?: unknown) => console.log(msg, meta ?? "");

  const runner = createLeadMissionRunner({
    handler: handleRunAgent,
    serviceRoleKey: key,
    functionsBaseUrl: `${url.replace(/\/+$/, "")}/functions/v1`,
    createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs }),
    bind: async (queueId, taskId, lineageId) => {
      const { data, error } = await db.rpc("bind_lead_mission_execution", {
        p_queue_id: queueId, p_worker_id: workerId, p_task_id: taskId, p_lineage_id: lineageId,
      });
      if (error) { log("[worker] bind error", error.message); return false; }
      return firstRow(data)?.bound === true;
    },
    readTaskOutcome: async (taskId) => {
      const { data } = await db.from("tasks").select(TASK_OUTCOME_COLUMNS).eq("id", taskId).maybeSingle();
      if (!data) return null;
      const row = data as TaskTerminalRow & { r_lineage_slices?: unknown; r_continuation_decision?: unknown };
      const slices = Number(row.r_lineage_slices);
      return {
        status: row.status ?? null,
        terminal_status: terminalStatusOf(terminalResultOf(row)),
        lineage_slices: row.r_lineage_slices != null && Number.isInteger(slices) ? slices : null,
        continuation_decision: typeof row.r_continuation_decision === "string" ? row.r_continuation_decision : null,
      };
    },
    // Three short fields: never the lineage's state document itself.
    readLineageOutcome: async (lineageId) => {
      const { data, error } = await db.from("lead_lineages")
        .select("status, terminal_reason, r_terminal_status:current_state->>terminal_status")
        .eq("lineage_id", lineageId).maybeSingle();
      if (error) { log("[worker] lineage outcome read failed", error.message); return null; }
      if (!data) return null;
      const l = data as { status?: unknown; terminal_reason?: unknown; r_terminal_status?: unknown };
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      return { status: str(l.status), terminal_reason: str(l.terminal_reason), terminal_status: str(l.r_terminal_status) };
    },
    log,
  });

  const role = resolveRole(env);
  // The gate. No DB claim unless V2 is enabled for at least one workspace — and
  // an api-only process claims nothing whatever the allowlist says.
  const gated = role !== "api" && v2Enabled(env) && runner.ready;

  // OBSERVABILITY ONLY. Counters are recorded around the existing claim; the
  // claim itself, and every queue semantic, is untouched.
  const status = newStatus();
  let working = false;

  const claim = async (wid: string, lease: number): Promise<ClaimOutcome> => {
    status.polls++;
    status.lastPollAt = Date.now();
    if (!gated) {
      status.lastPollReason = "v2_disabled";
      return { claimed: false, reason: "v2_disabled" };
    }
    const { data, error } = await db.rpc("claim_next_lead_mission", { p_worker_id: wid, p_lease_seconds: lease });
    if (error) {
      log("[worker] claim error", error.message);
      status.lastErrorAt = Date.now();
      status.lastError = `claim_error: ${error.message}`;
      status.lastPollReason = "claim_error";
      return { claimed: false, reason: "claim_error" };
    }
    const row = firstRow(data);
    if (!row || row.claimed !== true) {
      status.lastPollReason = String(row?.reason ?? "no_eligible_mission");
      return { claimed: false, reason: String(row?.reason ?? "no_eligible_mission") };
    }
    status.claims++;
    status.lastClaimAt = Date.now();
    status.lastPollReason = "claimed";
    const mission: ClaimedMission = {
      queueId: String(row.queue_id),
      workspaceId: String(row.workspace_id),
      request: (row.request ?? {}) as Record<string, unknown>,
      taskId: (row.task_id as string | null) ?? null,
      lineageId: (row.lineage_id as string | null) ?? null,
      attempts: Number(row.attempts ?? 0),
      isResume: !!row.task_id,
      heldUntil: (row.held_until as string | null) ?? null,
    };
    // THE QUEUE'S OWN SLICE COUNT, read beside the claim (the claim RPC does
    // not return it). A floor for the lineage counter: a resumed slice whose
    // task row lost `lead_lineage_progress` must not restart it (Query B
    // d22d9ee6). Best effort — an unreadable count simply sets no floor.
    try {
      const { data: q } = await db.from("lead_mission_queue").select("continuations").eq("id", mission.queueId).maybeSingle();
      const n = Number((q as { continuations?: unknown } | null)?.continuations);
      mission.continuations = Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      mission.continuations = null;
    }
    return { claimed: true, mission };
  };

  const heartbeatFor = (mission: ClaimedMission) => makeHeartbeatController({
    mission, workerId, leaseSeconds: cfg.leaseSeconds, intervalMs: cfg.heartbeatIntervalMs, sleep, log,
    heartbeat: async (queueId, wid, lease) => {
      const { data, error } = await db.rpc("heartbeat_lead_mission", {
        p_queue_id: queueId, p_worker_id: wid, p_lease_seconds: lease,
      });
      if (error) return { ok: false, reason: "heartbeat_rpc_error" };
      const row = firstRow(data);
      return { ok: row?.ok === true, reason: String(row?.reason ?? "unknown") };
    },
  });

  // ── ONE TERMINAL TRANSITION ──────────────────────────────────────────────
  //
  // When the queue ends a mission, the task, the lineage and the plan end with
  // it. Run 4250f181 finished `queue failed / task ready / lineage active /
  // plan partial` because the queue decided alone. The rule lives in
  // leadMissionTerminal.ts and the row I/O in leadMissionCancellation.ts, which
  // a test can drive without a database — this file cannot be imported.
  const rowsDb: CancelSweepDb = {
    // THE CHECK: three short strings, projected server-side. This is what the
    // sweep reads on every pass; the 150-500 kB result below is read only when
    // a write is actually required.
    readTaskTerminalFields: async (taskId) => {
      const { data } = await db.from("tasks").select(TASK_TERMINAL_COLUMNS).eq("id", taskId).maybeSingle();
      if (!data) return null;
      const row = data as TaskTerminalRow;
      return { status: row.status ?? null, result: terminalResultOf(row) };
    },
    // THE MERGE: the patch writes `{ ...result, … }`, so the write path — and
    // only the write path — needs the whole column.
    readTask: async (taskId) => {
      const { data } = await db.from("tasks").select("status, result").eq("id", taskId).maybeSingle();
      return (data ?? null) as { status: string | null; result: Record<string, unknown> | null } | null;
    },
    readLineage: async (lineageId) => {
      const { data } = await db.from("lead_lineages").select("status").eq("lineage_id", lineageId).maybeSingle();
      return (data ?? null) as { status: string | null } | null;
    },
    readPlan: async (planId) => {
      const { data } = await db.from("task_plans").select("status").eq("id", planId).maybeSingle();
      return (data ?? null) as { status: string | null } | null;
    },
    writeTask: async (taskId, patch) => {
      const { error } = await db.from("tasks").update(patch).eq("id", taskId);
      if (error) log("[worker] terminal reconcile: task write failed", error.message);
    },
    writeLineage: async (lineageId, patch) => {
      const { error } = await db.from("lead_lineages").update(patch).eq("lineage_id", lineageId);
      if (error) log("[worker] terminal reconcile: lineage write failed", error.message);
    },
    writePlan: async (planId, patch) => {
      const { error } = await db.from("task_plans").update(patch).eq("id", planId);
      if (error) log("[worker] terminal reconcile: plan write failed", error.message);
    },
    // CANCELLED ONLY, and only the recent ones: a cancellation no release will
    // ever follow (the row was unclaimed when it was cancelled). Terminal
    // `complete` and `failed` rows are not visited, so nothing successful is
    // rewritten by a sweep.
    listCancelled: async (limit) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // `request` is a whole mission; the sweep reads ONE field of it.
      const { data, error } = await db.from("lead_mission_queue")
        .select("id, task_id, lineage_id, plan_id:request->>plan_id")
        .eq("status", "cancelled").gte("updated_at", since)
        .order("updated_at", { ascending: false }).limit(limit);
      if (error) { log("[worker] cancel sweep read failed", error.message); return []; }
      return (data ?? []) as Array<{ id: string; task_id: string | null; lineage_id: string | null; plan_id: string | null }>;
    },
  };

  const reconcileTerminal = async (
    queueStatus: "complete" | "failed" | "cancelled", reason: string, ids: TerminalIds,
  ) => {
    const r = await reconcileTerminalRows(rowsDb, queueStatus, reason, ids, new Date().toISOString());
    if (r.violations.length === 0) return;
    log("[worker] terminal state reconciled", {
      queue_status: queueStatus, reason, before: r.violations, written: r.written, after: r.remaining,
    });
  };

  // ── THE CONVERSATION ENDS WHERE THE LINEAGE ENDS ─────────────────────────
  //
  // Idempotent: on the normal path run-agent's last slice already wrote the
  // final result and resolved the checkpoint notice, and this writes nothing.
  // It speaks for the endings run-agent never reaches — retries exhausted,
  // attempts exhausted, a cancellation — which left the chat on its last
  // mid-run notice.
  const noticeDb = supabaseNoticeDb(db);
  const resolveNotices = async (
    planId: string, queueStatus: "complete" | "failed" | "cancelled", reason: string,
  ) => {
    try {
      const r = await resolvePlanNoticesForQueueEnd(noticeDb, {
        planId, queueStatus, reason, nowIso: new Date().toISOString(),
      });
      if (r.checkpoints_resolved > 0 || r.results === "finalized" || r.results === "inserted") {
        log("[worker] plan notices resolved", { plan_id: planId, queue_status: queueStatus, reason, ...r });
      }
    } catch (e) {
      // A chat line must never fail a release.
      log("[worker] plan notice resolution failed", String((e as Error)?.message ?? e));
    }
  };
  rowsDb.resolveNotices = resolveNotices;

  const release = async (mission: ClaimedMission, outcome: ReleaseOutcome) => {
    // A CONTINUATION IS NOT A RETRY. The stated status, the lineage slice count
    // a clean continuation carries, and the 4-argument fallback all live in
    // `releaseQueuedMission`, which the canary replay drives against real SQL.
    const r = await releaseQueuedMission((fn, args) => db.rpc(fn, args), {
      queueId: mission.queueId, workerId, attempts: mission.attempts, outcome,
      outcomeDoc: {
        status: outcome.status, terminal: outcome.terminal, error: outcome.error ?? null,
        aborted: outcome.aborted, abort_reason: outcome.abortReason, worker_id: workerId,
        ceiling_ms: cfg.missionCeilingMs, lineage_slices: outcome.lineageSlices ?? null,
        continuation_decision: outcome.continuationDecision ?? null,
      },
    });
    if (r.fallback) log("[worker] release: 4-argument fallback", { queue: mission.queueId });
    if (r.error) { log("[worker] release error", r.error); return; }
    log("[worker] queue counters", {
      queue: mission.queueId, final_status: r.finalStatus, released: r.released,
      lineage_slices: r.lineageSlices, attempts: r.attempts, continuations: r.continuations,
    });
    const finalStatus = r.finalStatus;
    if (isTerminalQueueStatus(finalStatus)) {
      const taskId = outcome.taskId ?? mission.taskId;
      const planId = typeof mission.request.plan_id === "string" ? mission.request.plan_id : null;
      const reason = r.terminalReason ?? finalStatus;
      try {
        await reconcileTerminal(finalStatus, reason, {
          taskId,
          lineageId: mission.lineageId ?? taskId,
          planId,
        });
      } catch (e) {
        log("[worker] terminal reconcile failed", String((e as Error)?.message ?? e));
      }
      if (planId) await resolveNotices(planId, finalStatus, reason);
    }
  };

  // A claimed mission legitimately stops polling for as long as it runs, so the
  // health view is told — otherwise a healthy 5-minute run reports `stalled`.
  const runMission: WorkerDeps["runMission"] = async (...args) => {
    working = true;
    try { return await runner.run(...args); } finally { working = false; }
  };

  const deps: WorkerDeps = {
    workerId, config: cfg, claim, heartbeatFor, runMission, release, sleep, log,
    // The cancellation the worker never sees: cancelled while unclaimed, so no
    // release follows it. See leadMissionCancellation.ts.
    sweepCancelled: async () => {
      const r = await sweepCancelledMissions(rowsDb, new Date().toISOString(), CANCEL_SWEEP_LIMIT);
      for (const d of r.details) {
        log("[worker] cancelled mission reconciled", {
          queue: d.queue_id, reason: CANCELLED_REASON, before: d.violations, written: d.written, after: d.remaining,
        });
      }
      return { scanned: r.scanned, reconciled: r.reconciled };
    },
  };

  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        // DRAIN, NEVER ABORT. `runWorkerLoop` reads this between ticks, so a
        // mission already executing finishes and checkpoints on its own terms.
        // Being killed mid-mission would also be safe — the lease lapses and the
        // row is reclaimable — but it wastes work already paid for.
        log(`[worker] ${sig} — draining`);
        status.draining = true;
        stop = true;
      });
    } catch { /* unsupported platform */ }
  }

  // ── THE HTTP SURFACE, WHEN THIS PROCESS HAS ONE ──────────────────────────
  //
  // Mounted BEFORE the listener opens, so a route that fails to import takes
  // the process down at start-up rather than 500-ing the first real request.
  // A `worker` role mounts nothing and the listener is the health endpoint it
  // always was.
  const api = role === "worker" ? null : await mountApi(env, log);
  if (api) log("[worker] api role active", { role, routes: api.routes });

  // PORT is the platform's contract. Absent locally ⇒ no socket, no extra
  // permission, behaviour identical to before.
  const port = Number(env("PORT"));
  if (api && !(Number.isFinite(port) && port > 0)) {
    // An API with no port answers nothing, which is a misconfiguration worth
    // failing loudly rather than idling through.
    console.error("[worker] AGENTORY_ROLE requests the API but PORT is unset");
    Deno.exit(1);
  }
  const health = Number.isFinite(port) && port > 0
    ? startHealthServer(port, () => healthView({
      status, workerId, gated, idlePollMs: cfg.idlePollMs, working,
      build: { ...buildInfo(), deployment_id: Deno.env.get("RAILWAY_DEPLOYMENT_ID") ?? null },
      config: {
        lease_seconds: cfg.leaseSeconds,
        heartbeat_interval_ms: cfg.heartbeatIntervalMs,
        mission_ceiling_ms: cfg.missionCeilingMs,
        idle_poll_ms: cfg.idlePollMs,
      },
    }), log, api?.handle)
    : null;

  log("[worker] starting", { workerId, role, gated, config: cfg });
  if (!gated && role !== "api") {
    log("[worker] V2 disabled (no allowlisted workspace) — idling, will not claim any mission");
  }
  try {
    if (role === "api") {
      // SERVE ONLY. No claim loop at all — not a gated one — so an api process
      // cannot take a mission even if the allowlist is later widened.
      log("[worker] api-only: not claiming missions");
      while (!stop) await sleep(cfg.idlePollMs);
    } else {
      await runWorkerLoop(deps, () => stop);
    }
  } finally {
    await health?.close();
    log("[worker] stopped", { polls: status.polls, claims: status.claims });
  }
}

if (import.meta.main) await main();
