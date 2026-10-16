// THE MISSION RUNNER — run-agent's own handler, in-process.
//
// For each claimed queue row it replays orchestrate's kickoff body into
// `handleRunAgent` with two in-process options:
//   • a REVOCABLE deadline with the worker's budget, revoked when the heartbeat
//     reports lost ownership or cancellation, so the engine stops starting paid
//     work and checkpoints through its existing reserve logic;
//   • `onExecutionBound`, which binds the task + lineage the handler just created
//     onto the queue row, so the heartbeat renews exactly what the run holds.
//
// Everything that decides what a company is, what may be bought and what gets
// delivered stays inside the handler, unchanged — lineage lease, checkpoints,
// finalizer, ownership ledger, spend ceiling. This file only decides WHEN.
//
// How the run ended is read from the task row afterwards, not inferred from the
// HTTP response: the row is what the rest of the system treats as the truth.

import type { RunAgentRunOptions } from "../supabase/functions/run-agent/index.ts";
import type {
  ClaimedMission, MissionOutcome, MissionRunControl,
} from "../supabase/functions/_shared/leadMissionWorkerCore.ts";
import type { ExecutionDeadline } from "../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { revocableDeadline } from "../supabase/functions/_shared/revocableDeadline.ts";
import { missionExpiry, withMissionExpiry } from "../supabase/functions/_shared/missionWallClock.ts";
import {
  type LineageOutcomeRow, prepareV2LeadCount, mapRefusal, mapTaskOutcome, withResume, type TaskOutcomeRow,
} from "../supabase/functions/_shared/leadMissionV2Request.ts";
import { missionAdmission, type MissionAdmissionContext } from "../supabase/functions/_shared/smokeAdmission.ts";

export interface LeadMissionRunner {
  /** The worker claims nothing unless this is true. */
  ready: boolean;
  run: (mission: ClaimedMission, ctl: MissionRunControl) => Promise<MissionOutcome>;
}

export interface LeadMissionRunnerDeps {
  enforceMissionWallClock?: boolean;
  now?: () => number;
  handler: (req: Request, inProcess: RunAgentRunOptions) => Promise<Response>;
  /** Sent as the bearer: the handler's service-role path, as orchestrate and the sweeper use. */
  serviceRoleKey: string;
  /** Only used to build the Request URL; nothing is fetched over the network. */
  functionsBaseUrl: string;
  createDeadline: (budgetMs: number) => ExecutionDeadline;
  bind: (queueId: string, taskId: string, lineageId: string) => Promise<boolean>;
  readTaskOutcome: (taskId: string) => Promise<TaskOutcomeRow | null>;
  /**
   * The lineage row, read only when the task row says the run did NOT end:
   * a terminal or cancelled lineage then ends the mission (`mapTaskOutcome`).
   * Absent, or null on a read error: the task row alone decides, as before.
   */
  readLineageOutcome?: (lineageId: string) => Promise<LineageOutcomeRow | null>;
  log?: (msg: string, meta?: unknown) => void;
  /**
   * Durable smoke admission (smokeAdmission.ts), when the worker enforces it.
   * Each mission's handler call then runs inside its own admission context, so
   * the transport gate can attribute every billable request to this queue row,
   * task and generation. Absent: no context is bound, exactly as before.
   */
  admission?: { workerId: string };
}

export function createLeadMissionRunner(d: LeadMissionRunnerDeps): LeadMissionRunner {
  return {
    ready: true,
    async run(mission, ctl) {
      const body = withResume(prepareV2LeadCount(mission.request), mission.taskId);
      const now = d.now ?? Date.now;
      const expiry = d.enforceMissionWallClock ? missionExpiry(mission.enqueuedAt, now()) : null;
      if (d.enforceMissionWallClock && (expiry === null || now() >= expiry)) {
        return { status: "failed", terminal: true, taskId: mission.taskId,
          error: expiry === null ? "mission_deadline_unreadable" : "mission_deadline_expired" };
      }
      const base = d.createDeadline(expiry === null ? ctl.executionBudgetMs : Math.min(ctl.executionBudgetMs, expiry - now()));
      const deadline = revocableDeadline(expiry === null ? base : withMissionExpiry(base, expiry, now));
      // `worker:<heartbeat reason>` — what `verificationStop.classifyRevocation`
      // reads to tell a cancellation from a lost lease.
      const onAbort = () => deadline.revoke(
        `worker:${typeof ctl.signal.reason === "string" ? ctl.signal.reason : "aborted"}`,
      );
      if (ctl.signal.aborted) onAbort();
      else ctl.signal.addEventListener("abort", onAbort, { once: true });

      let taskId: string | null = mission.taskId;
      let lineageId: string | null = mission.lineageId;
      // Task and generation are filled in when the handler binds; until then
      // the gate admits nothing.
      const admission: MissionAdmissionContext | null = d.admission
        ? { queueId: mission.queueId, workerId: d.admission.workerId, taskId: null, generation: null, signal: ctl.signal,
          remainingMs: () => deadline.remainingMs() }
        : null;
      const call = (fn: () => Promise<Response>) => admission ? missionAdmission.run(admission, fn) : fn();
      let res: Response;
      try {
        res = await call(() => d.handler(
          new Request(`${d.functionsBaseUrl.replace(/\/+$/, "")}/run-agent`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${d.serviceRoleKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
          {
            deadline,
            // The queue re-claims a resumable mission; the handler must never
            // self-dispatch a second executor over HTTP (run 4250f181: 401 ×5).
            continuationOwner: "v2_queue",
            // The floor for the lineage counter (`resolveLineageProgress`).
            queueContinuations: mission.continuations ?? null,
            onExecutionBound: async ({ taskId: t, lineageId: l, generation }) => {
              taskId = t;
              lineageId = l;
              const bound = await d.bind(mission.queueId, t, l);
              // A refused bind means another task already belongs to this
              // mission, or this worker no longer owns it. Start nothing paid.
              if (!bound) deadline.revoke("bind_refused");
              else if (admission) {
                admission.taskId = t;
                admission.generation = generation ?? null;
              }
            },
          },
        ));
      } finally {
        ctl.signal.removeEventListener("abort", onAbort);
        // Work the handler left running (a stray timer, an unawaited promise)
        // keeps this context; from here it is admitted nothing.
        if (admission) admission.closedReason = "mission_call_ended";
      }

      if (!taskId) {
        try {
          const j = await res.clone().json() as { task_id?: unknown };
          if (typeof j.task_id === "string" && j.task_id) taskId = j.task_id;
        } catch { /* not JSON — treated as a refusal below */ }
      }
      // Refused before any task existed: nothing ran, nothing was bought.
      if (!taskId) return { ...mapRefusal(res.status), error: `handler_status_${res.status}`, taskId: null };

      const row = await d.readTaskOutcome(taskId);
      const fromTask = mapTaskOutcome(row);
      // THE LINEAGE ROW IS THE AUTHORITY on whether the mission ended (D4):
      // asked only when the task row says it did not.
      const lineage = !fromTask.terminal && d.readLineageOutcome
        ? await d.readLineageOutcome(lineageId ?? taskId) : null;
      const outcome = mapTaskOutcome(row, lineage);
      if (outcome.terminal && !fromTask.terminal) {
        d.log?.("[worker][runner] the lineage ended the mission; the task row had not caught up", {
          queue: mission.queueId, task: taskId, task_outcome: fromTask.status,
          lineage_status: lineage?.status ?? null, outcome: outcome.status,
        });
      }
      // The lineage's own slice counter, so the release can tell a slice that
      // ran from a run that only re-read a checkpoint (a 409, a refusal).
      const lineageSlices = typeof row?.lineage_slices === "number" ? row.lineage_slices : null;
      // The run's own continuation decision, so the release can tell a slice
      // with work ready now from one that is only waiting on a provider.
      const continuationDecision = typeof row?.continuation_decision === "string" ? row.continuation_decision : null;
      d.log?.("[worker][runner] run ended", {
        queue: mission.queueId, task: taskId, http: res.status, ...outcome,
        lineage_slices: lineageSlices, continuation_decision: continuationDecision,
        revoked: deadline.revokedReason,
      });
      return {
        ...outcome, taskId,
        ...(lineageSlices !== null ? { lineageSlices } : {}),
        ...(continuationDecision !== null ? { continuationDecision } : {}),
      };
    },
  };
}
