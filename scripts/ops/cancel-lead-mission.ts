// CANCEL ONE LEAD V2 MISSION AND FINALIZE IT — the supported path.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
//     deno run --allow-net --allow-env scripts/ops/cancel-lead-mission.ts \
//       --queue <queue uuid> --workspace <workspace uuid> [--reason <text>] [--apply]
//
// DRY RUN BY DEFAULT: prints the queue row's status and what would happen.
// With --apply it calls `cancel_lead_mission` and, for a mission no worker
// holds, reconciles the task, lineage and plan at once (`cancelAndFinalizeMission`)
// — the same canonical reconcile the worker's cancel sweep applies. A mission a
// worker is running is only flagged; its worker stops on the next heartbeat and
// reconciles at release. One mission per call; nothing else is touched. No
// credential is ever printed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cancelAndFinalizeMission, type CancelMissionDb } from "../../supabase/functions/_shared/leadMissionCancellation.ts";

function arg(name: string): string | null {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] && !Deno.args[i + 1].startsWith("--") ? Deno.args[i + 1] : null;
}
const queueId = arg("queue");
const workspaceId = arg("workspace");
const reason = arg("reason");
const apply = Deno.args.includes("--apply");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!queueId || !workspaceId || !UUID.test(queueId) || !UUID.test(workspaceId)) {
  console.error("usage: --queue <uuid> --workspace <uuid> [--reason <text>] [--apply]");
  Deno.exit(2);
}
const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"); Deno.exit(2); }
const db = createClient(url, key);

const store: CancelMissionDb = {
  readQueueRow: async (id) => {
    const { data } = await db.from("lead_mission_queue")
      .select("id, workspace_id, status, claimed_by, task_id, lineage_id, plan_id:request->>plan_id").eq("id", id).maybeSingle();
    return (data ?? null) as never;
  },
  cancelQueueRow: async (id, ws) => {
    const { data, error } = await db.rpc("cancel_lead_mission", { p_queue_id: id, p_workspace_id: ws });
    if (error) throw new Error(`cancel_lead_mission failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return { cancelled: row?.cancelled === true, reason: String(row?.reason ?? "unknown") };
  },
  readTask: async (id) => (await db.from("tasks").select("status, result").eq("id", id).maybeSingle()).data as never,
  readLineage: async (id) => (await db.from("lead_lineages").select("status").eq("lineage_id", id).maybeSingle()).data as never,
  readPlan: async (id) => (await db.from("task_plans").select("status").eq("id", id).maybeSingle()).data as never,
  writeTask: async (id, patch) => { const { error } = await db.from("tasks").update(patch).eq("id", id); if (error) throw error; },
  writeLineage: async (id, patch) => { const { error } = await db.from("lead_lineages").update(patch).eq("lineage_id", id); if (error) throw error; },
  writePlan: async (id, patch) => { const { error } = await db.from("task_plans").update(patch).eq("id", id); if (error) throw error; },
};

const row = await store.readQueueRow(queueId);
if (!row || row.workspace_id !== workspaceId) { console.error("no such queue row in that workspace"); Deno.exit(1); }
console.log({ queue: row.id, status: row.status, claimed: !!row.claimed_by, task: row.task_id, plan: row.plan_id ?? null });
if (!apply) {
  console.log(row.status === "complete" || row.status === "failed"
    ? "DRY RUN: already terminal — nothing would change."
    : row.claimed_by
    ? "DRY RUN: would cancel; a worker holds it, so it stops at its next heartbeat and finalizes at release."
    : "DRY RUN: would cancel and finalize the task, lineage and plan now. Re-run with --apply.");
  Deno.exit(0);
}
const r = await cancelAndFinalizeMission(store, { queueId, workspaceId, nowIso: new Date().toISOString(), reason });
console.log({ cancelled: r.cancelled, already: r.already, finalized: r.finalized,
  written: r.reconcile?.written ?? [], remaining: r.reconcile?.remaining ?? [] });
