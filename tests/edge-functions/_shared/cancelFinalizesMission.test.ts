// A SUPPORTED CANCELLATION LEAVES QUEUE, TASK, LINEAGE AND PLAN IN AGREEMENT.
//
// Query B d22d9ee6 (2026-10-12) was cancelled with `cancel_lead_mission`, which
// sets ONE row — the queue. The task stayed `ready` and the plan `partial`
// until a running worker's cancel sweep reconciled them a minute later; with
// no worker running they would have stayed that way. `cancelAndFinalizeMission`
// applies the same canonical reconcile at once for a mission nobody is
// running, and leaves a running one to its worker (which stops on the next
// heartbeat and reconciles at release). Results, leads and evidence are kept.
//
// PURE (an in-memory db).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cancelAndFinalizeMission, type CancelMissionDb } from "../../../supabase/functions/_shared/leadMissionCancellation.ts";

type Row = Record<string, unknown>;
function memDb(queueStatus: string, claimed = false) {
  const state = {
    queue: { id: "q1", workspace_id: "ws", status: queueStatus, claimed_by: claimed ? "w1" : null, task_id: "t1", lineage_id: "t1", plan_id: "p1" } as Row,
    task: { status: "ready", result: { terminal_status: "continuation_required", qualified_companies: ["Continuum AI"], lead_lineage_progress: { continuations_used: 3 } } } as Row,
    lineage: { status: "active" } as Row,
    plan: { status: "partial" } as Row,
    writes: [] as string[],
  };
  const db: CancelMissionDb = {
    readQueueRow: () => Promise.resolve(structuredClone(state.queue) as never),
    cancelQueueRow: () => {
      if (!["queued", "resumable", "running"].includes(String(state.queue.status))) return Promise.resolve({ cancelled: false, reason: "not_cancellable" });
      state.queue.status = "cancelled"; state.writes.push("queue");
      return Promise.resolve({ cancelled: true, reason: "cancelled" });
    },
    readTask: () => Promise.resolve(structuredClone(state.task) as never),
    readLineage: () => Promise.resolve(structuredClone(state.lineage) as never),
    readPlan: () => Promise.resolve(structuredClone(state.plan) as never),
    writeTask: (_id, p) => { state.task = { ...p }; state.writes.push("task"); return Promise.resolve(); },
    writeLineage: (_id, p) => { state.lineage = { ...p }; state.writes.push("lineage"); return Promise.resolve(); },
    writePlan: (_id, p) => { state.plan = { ...p }; state.writes.push("plan"); return Promise.resolve(); },
  };
  return { db, state };
}
const NOW = "2026-10-12T14:36:48.000Z";
const consistent = (s: ReturnType<typeof memDb>["state"]) =>
  s.queue.status === "cancelled" && s.task.status === "failed" &&
  (s.task.result as Row).terminal_status === "cancelled" && s.lineage.status === "cancelled" && s.plan.status === "failed";

for (const status of ["queued", "resumable"]) {
  Deno.test(`cancel a ${status} mission → queue, task, lineage and plan agree at once`, async () => {
    const { db, state } = memDb(status);
    const r = await cancelAndFinalizeMission(db, { queueId: "q1", workspaceId: "ws", nowIso: NOW });
    assert(r.cancelled);
    assert(consistent(state), JSON.stringify(state));
    assertEquals(r.finalized, true);
  });
}

Deno.test("cancel after partial results → the results, qualified leads and lineage progress are kept", async () => {
  const { db, state } = memDb("resumable");
  await cancelAndFinalizeMission(db, { queueId: "q1", workspaceId: "ws", nowIso: NOW, reason: "canary_stopped_for_forensic_audit" });
  const result = state.task.result as Row;
  assertEquals(result.qualified_companies, ["Continuum AI"]);
  assertEquals((result.lead_lineage_progress as Row).continuations_used, 3);
  assertEquals((result.v2_terminal as Row).detail, "canary_stopped_for_forensic_audit", "the operator's reason is kept, without a schema change");
});

Deno.test("cancel an already-terminal mission → nothing is written", async () => {
  const { db, state } = memDb("complete");
  const r = await cancelAndFinalizeMission(db, { queueId: "q1", workspaceId: "ws", nowIso: NOW });
  assertEquals([r.cancelled, r.already, state.writes.length], [false, "complete", 0]);
});

Deno.test("a repeated cancel is idempotent — the second writes nothing", async () => {
  const { db, state } = memDb("resumable");
  await cancelAndFinalizeMission(db, { queueId: "q1", workspaceId: "ws", nowIso: NOW });
  const n = state.writes.length;
  const r = await cancelAndFinalizeMission(db, { queueId: "q1", workspaceId: "ws", nowIso: NOW });
  assertEquals(state.writes.length, n);
  assertEquals(r.already, "cancelled");
  assert(consistent(state));
});

Deno.test("a mission a worker is running is flagged, not finalized under it — its worker reconciles at release", async () => {
  const { db, state } = memDb("running", true);
  const r = await cancelAndFinalizeMission(db, { queueId: "q1", workspaceId: "ws", nowIso: NOW });
  assertEquals([r.cancelled, r.finalized, state.queue.status, state.task.status], [true, false, "cancelled", "ready"]);
});

Deno.test("the operator script is dry-run unless --apply, and never prints a credential", async () => {
  const src = await Deno.readTextFile(new URL("../../../scripts/ops/cancel-lead-mission.ts", import.meta.url));
  assert(src.includes('Deno.args.includes("--apply")') && src.includes("if (!apply) {"));
  assert(!/console\.(log|error)\([^)]*\bkey\b/.test(src), "the service key is never logged");
  assert(src.includes("cancelAndFinalizeMission("));
});
