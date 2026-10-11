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
import {
  prepareV2LeadCount, mapRefusal, mapTaskOutcome, withResume, type TaskOutcomeRow,
} from "../supabase/functions/_shared/leadMissionV2Request.ts";

export interface LeadMissionRunner {
  /** The worker claims nothing unless this is true. */
  ready: boolean;
  run: (mission: ClaimedMission, ctl: MissionRunControl) => Promise<MissionOutcome>;
}

export interface LeadMissionRunnerDeps {
  handler: (req: Request, inProcess: RunAgentRunOptions) => Promise<Response>;
  /** Sent as the bearer: the handler's service-role path, as orchestrate and the sweeper use. */
  serviceRoleKey: string;
  /** Only used to build the Request URL; nothing is fetched over the network. */
  functionsBaseUrl: string;
  createDeadline: (budgetMs: number) => ExecutionDeadline;
  bind: (queueId: string, taskId: string, lineageId: string) => Promise<boolean>;
  readTaskOutcome: (taskId: string) => Promise<TaskOutcomeRow | null>;
  log?: (msg: string, meta?: unknown) => void;
}

export function createLeadMissionRunner(d: LeadMissionRunnerDeps): LeadMissionRunner {
  return {
    ready: true,
    async run(mission, ctl) {
      const body = withResume(prepareV2LeadCount(mission.request), mission.taskId);
      const deadline = revocableDeadline(d.createDeadline(ctl.executionBudgetMs));
      const onAbort = () => deadline.revoke("worker_lost_ownership_or_cancelled");
      if (ctl.signal.aborted) onAbort();
      else ctl.signal.addEventListener("abort", onAbort, { once: true });

      let taskId: string | null = mission.taskId;
      let res: Response;
      try {
        res = await d.handler(
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
            onExecutionBound: async ({ taskId: t, lineageId }) => {
              taskId = t;
              const bound = await d.bind(mission.queueId, t, lineageId);
              // A refused bind means another task already belongs to this
              // mission, or this worker no longer owns it. Start nothing paid.
              if (!bound) deadline.revoke("bind_refused");
            },
          },
        );
      } finally {
        ctl.signal.removeEventListener("abort", onAbort);
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
      const outcome = mapTaskOutcome(row);
      // The lineage's own slice counter, so the release can tell a slice that
      // ran from a run that only re-read a checkpoint (a 409, a refusal).
      const lineageSlices = typeof row?.lineage_slices === "number" ? row.lineage_slices : null;
      d.log?.("[worker][runner] run ended", {
        queue: mission.queueId, task: taskId, http: res.status, ...outcome,
        lineage_slices: lineageSlices,
        revoked: deadline.revokedReason,
      });
      return { ...outcome, taskId, ...(lineageSlices !== null ? { lineageSlices } : {}) };
    },
  };
}
