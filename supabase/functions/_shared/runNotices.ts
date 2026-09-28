// THE CHAT'S ACCOUNT OF A RUN FOLLOWS THE LINEAGE, NOT THE FIRST SLICE.
//
// Canary 11 (plan 76194e61, 2026-09-25), as the conversation read afterwards:
//
//   14:26:08  "This run reached its time limit partway through…"   PARTIALLY_SATISFIED
//   14:30:07  "I opened the results in Workbench — 0 of 1…"        continuation_required
//   14:38:48  (the lineage ends search_exhausted — nothing is written)
//
// Nothing had timed out. The first notice was written at the first STAGE
// BOUNDARY (`onCheckpoint` saves progress at every one), 34 seconds in; the
// second by the first slice, which ended at a designed slice boundary. The
// results message is one-per-plan, so the slice that actually finished found it
// already there and said nothing. Chat showed a failure, Pilot read one from the
// history, and the Workbench — whose run status comes from that message's
// `ui_panel` snapshot — stayed on "Round complete".
//
// THE RULE:
//
//   a stage boundary or a slice boundary  → a NEUTRAL "continuing" notice
//   a continuation                        → the same notices, updated in place
//   the lineage ends                      → the results message becomes FINAL,
//                                           and the checkpoint notice is resolved
//                                           into a neutral historical line
//
// A final notice is never reopened, and no notice ever states an outcome the
// lineage has not reached. The canonical status stays on the task, the lineage
// and the plan; these messages only report it.
//
// Pure decisions, plus I/O through `NoticeDb` so the whole lifecycle is testable
// without a database.

export const RUN_NOTICE_VERSION = "run-notice-v1" as const;

/** `metadata.notice_lifecycle`. Absent on rows written before this module. */
export type NoticeLifecycle = "continuing" | "final" | "resolved";

/** How a lineage ended, in the terms the notices speak. */
export type RunEnding =
  | "completed"        // delivered what was asked
  | "finished_short"   // ended normally, short of the ask (search exhausted, quota not met)
  | "budget_stopped"   // stopped at its spending limit
  | "limit_reached"    // used every round or attempt it was allowed
  | "failed"           // could not finish: a failure, or interrupted on every retry
  | "cancelled";

const FAILED_TERMINALS = new Set([
  "provider_failure", "invalid_request", "source_transition_failed", "retry_budget_exhausted",
]);
const LIMIT_TERMINALS = new Set(["round_limit_reached", "continuation_attempts_exhausted"]);

/**
 * The ending, or null while the lineage is still continuing.
 *
 * `continuation_required` is never an ending on its own: it is the designed
 * pause between slices. It becomes one only when the QUEUE has ended the
 * mission (its attempts were spent, or it was cancelled).
 */
export function runEndingOf(i: {
  terminalStatus: string | null | undefined;
  taskStatus?: string | null;
  queueStatus?: string | null;
}): RunEnding | null {
  const t = i.terminalStatus ?? null;
  if (i.queueStatus === "cancelled") return "cancelled";
  const queueEnded = i.queueStatus === "complete" || i.queueStatus === "failed";
  if (t === "continuation_required" && !queueEnded) return null;
  if (t && FAILED_TERMINALS.has(t)) return "failed";
  // BEFORE the queue's own status: attempts spent on clean slices release the
  // queue row `failed`, but that is a limit, not a reliability failure
  // (`CONTINUATION_ATTEMPTS_EXHAUSTED` in leadMissionTerminal.ts).
  if (t && LIMIT_TERMINALS.has(t)) return "limit_reached";
  if (t === "budget_exhausted") return "budget_stopped";
  if (i.queueStatus === "failed" || i.taskStatus === "failed") return "failed";
  if (t === "continuation_required") return "limit_reached";
  if (i.taskStatus === "completed" || t === "completed") return "completed";
  if (!t) return null;
  return "finished_short";
}

// ─────────────────────────────────────────────────────── wording ──

const foundClause = (summary: string | null | undefined) => (summary ? ` — ${summary}` : "");

/**
 * THE STAGE-BOUNDARY NOTICE. Written while the run is still working: a durable
 * save point, not a pause and not a time limit. True whether the run goes on to
 * finish, pauses, or is stopped later.
 */
export function continuingCheckpointContent(i: {
  queueOwned: boolean;
  resumable: boolean;
  cannotResume: string;
  summary: string | null;
  spendClause: string;
}): string {
  const found = foundClause(i.summary);
  const spend = i.spendClause ? ` ${i.spendClause}` : "";
  if (i.queueOwned) {
    return `Still working — progress is saved as it goes${found}.${spend} ` +
      `The Lead V2 worker carries this on automatically; there is nothing to click.`;
  }
  return i.resumable
    ? `Progress saved${found}.${spend} If this run stops before it finishes, Continue below ` +
      `picks it up from here — it reuses the work already paid for instead of searching again.`
    : `Progress saved${found}.${spend} If this run stops before it finishes, it can't be ` +
      `picked up where it left off: ${i.cannotResume}.`;
}

const ENDING_TAIL: Record<RunEnding, string> = {
  completed: "It has since finished — the final result is reported below.",
  finished_short: "It has since finished — the final result is reported below.",
  budget_stopped: "It has since stopped at its budget — the final result is reported below.",
  limit_reached: "It has since used every round it was allowed — the final result is reported below.",
  failed: "It has since stopped before finishing — the final status is reported below.",
  cancelled: "It was later cancelled — the final status is reported below.",
};

/** The checkpoint notice once the lineage has ended: history, not a verdict. */
export function resolvedCheckpointContent(ending: RunEnding, summary: string | null | undefined): string {
  return `Progress was saved here${foundClause(summary)}, and the run carried on from this point. ${ENDING_TAIL[ending]}`;
}

/** The results message while the lineage continues under the V2 queue. */
export function continuingResultsContent(delivered: string): string {
  return `I opened Workbench with the results so far — ${delivered} so far. The Lead V2 worker is ` +
    `still working on this, and this message is updated when it finishes. Nothing was sent.`;
}

const QUEUE_STOP_SENTENCE: Record<RunEnding, string> = {
  completed: "This search has finished.",
  finished_short: "This search has finished.",
  budget_stopped: "This search stopped at its budget before it could finish.",
  limit_reached: "This search used every round it was allowed without finishing.",
  failed: "This search stopped before it could finish — it was interrupted on every retry the worker allows.",
  cancelled: "This search was cancelled.",
};

const QUEUE_STOP_OUTCOME: Record<RunEnding, "SATISFIED" | "PARTIALLY_SATISFIED" | "FAILED"> = {
  completed: "SATISFIED",
  finished_short: "PARTIALLY_SATISFIED",
  budget_stopped: "PARTIALLY_SATISFIED",
  limit_reached: "PARTIALLY_SATISFIED",
  failed: "FAILED",
  cancelled: "PARTIALLY_SATISFIED",
};

/**
 * The final results line for an ending the QUEUE decided (run-agent never got
 * to write one): retries exhausted, attempts exhausted, a cancellation.
 */
export function queueStopContent(ending: RunEnding): string {
  return `${QUEUE_STOP_SENTENCE[ending]} What it found so far is in Workbench. Nothing was sent.`;
}

// ─────────────────────────────────────────────── message classification ──

export interface NoticeMessage {
  id: string;
  conversation_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at?: string | null;
}

const meta = (m: NoticeMessage) => (m.metadata ?? {}) as Record<string, unknown>;

export function isCheckpointNotice(m: NoticeMessage): boolean {
  return meta(m).kind === "run_checkpoint";
}

export function isResultsNotice(m: NoticeMessage): boolean {
  const panel = meta(m).ui_panel as { kind?: unknown } | undefined;
  return panel?.kind === "lead_results";
}

/**
 * Still describing a run in progress. Rows written before `notice_lifecycle`
 * existed are read from what they carry: every old checkpoint notice, and a
 * results message stamped `continuation_required`.
 */
export function noticeIsOpen(m: NoticeMessage): boolean {
  const lc = meta(m).notice_lifecycle;
  if (lc === "final" || lc === "resolved") return false;
  if (lc === "continuing") return true;
  if (isCheckpointNotice(m)) return true;
  return isResultsNotice(m) && meta(m).terminal_status === "continuation_required";
}

// ─────────────────────────────────────────────────────────────── I/O ──

export interface NoticeDb {
  /** Every message stamped with this plan id, oldest first. */
  listPlanMessages: (planId: string) => Promise<NoticeMessage[]>;
  insertMessage: (row: {
    conversation_id: string; role: "assistant"; content: string; agent_slug: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  updateMessage: (id: string, patch: { content: string; metadata: Record<string, unknown> }) => Promise<void>;
}

/** The checkpoint notice, resolved: same row, neutral history, no outcome. */
export function resolveCheckpointPatch(m: NoticeMessage, ending: RunEnding, nowIso: string) {
  const { outcome: _o, terminal_status: _t, ...rest } = meta(m);
  const summary = typeof rest.checkpoint_summary === "string" ? rest.checkpoint_summary : null;
  return {
    content: resolvedCheckpointContent(ending, summary),
    metadata: {
      ...rest,
      notice_version: RUN_NOTICE_VERSION,
      notice_lifecycle: "resolved" as const,
      resolved_as: ending,
      resolved_at: nowIso,
      // No Continue on a notice whose lineage is over.
      resumable: false,
    },
  };
}

export interface PublishResultsInput {
  planId: string;
  /** The conversation, when the caller already knows it; else read from the plan's messages. */
  conversationId?: string | null;
  content: string;
  metadata: Record<string, unknown>;
  /** `continuing` while the lineage continues; `final` once it has ended. */
  lifecycle: "continuing" | "final";
  /** Required with `final`: how the lineage ended, for the checkpoint notice. */
  ending?: RunEnding | null;
  nowIso: string;
}

export interface PublishResult {
  action: "inserted" | "updated" | "skipped_final_exists" | "skipped_no_conversation";
  checkpoints_resolved: number;
}

/**
 * ONE RESULTS MESSAGE PER PLAN, CORRECTED UNTIL IT IS FINAL.
 *
 *   none yet           → inserted
 *   an open one        → updated in place (a later slice, or the final one)
 *   a final one        → left alone: a finished run is never reopened
 *
 * Publishing a FINAL result also resolves the plan's checkpoint notice.
 */
export async function publishResultsNotice(db: NoticeDb, i: PublishResultsInput): Promise<PublishResult> {
  const msgs = await db.listPlanMessages(i.planId);
  const conversationId = i.conversationId ?? msgs[0]?.conversation_id ?? null;
  if (!conversationId) return { action: "skipped_no_conversation", checkpoints_resolved: 0 };
  const metadata = { ...i.metadata, notice_version: RUN_NOTICE_VERSION, notice_lifecycle: i.lifecycle };

  const existing = msgs.filter(isResultsNotice);
  const open = existing.find(noticeIsOpen) ?? null;
  let action: PublishResult["action"];
  if (existing.length > 0 && !open) {
    action = "skipped_final_exists";
  } else if (open) {
    await db.updateMessage(open.id, { content: i.content, metadata });
    action = "updated";
  } else {
    await db.insertMessage({ conversation_id: conversationId, role: "assistant", content: i.content, agent_slug: "pilot", metadata });
    action = "inserted";
  }
  let resolved = 0;
  if (i.lifecycle === "final" && i.ending) {
    for (const m of msgs.filter((x) => isCheckpointNotice(x) && noticeIsOpen(x))) {
      await db.updateMessage(m.id, resolveCheckpointPatch(m, i.ending, i.nowIso));
      resolved++;
    }
  }
  return { action, checkpoints_resolved: resolved };
}

export interface QueueResolution {
  checkpoints_resolved: number;
  results: "finalized" | "inserted" | "already_final" | "none";
}

/**
 * THE QUEUE ENDED THE LINEAGE. Called by the worker after every terminal
 * release — idempotent, so the normal path (run-agent already wrote the final
 * result) writes nothing.
 *
 * An open results message is finalized with the queue's reason; when there is
 * none at all, one is written so the conversation never ends on "still working".
 * Every open checkpoint notice is resolved.
 */
export async function resolvePlanNoticesForQueueEnd(db: NoticeDb, i: {
  planId: string;
  queueStatus: "complete" | "failed" | "cancelled";
  reason: string;
  taskStatus?: string | null;
  nowIso: string;
}): Promise<QueueResolution> {
  const msgs = await db.listPlanMessages(i.planId);
  if (msgs.length === 0) return { checkpoints_resolved: 0, results: "none" };
  const ending = runEndingOf({ terminalStatus: i.reason, taskStatus: i.taskStatus, queueStatus: i.queueStatus })
    ?? (i.queueStatus === "complete" ? "finished_short" : "failed");

  const results = msgs.filter(isResultsNotice);
  const open = results.find(noticeIsOpen) ?? null;
  const openCheckpoints = msgs.filter((x) => isCheckpointNotice(x) && noticeIsOpen(x));
  let outcome: QueueResolution["results"] = "already_final";
  const finalMeta = (base: Record<string, unknown>) => ({
    ...base,
    notice_version: RUN_NOTICE_VERSION,
    notice_lifecycle: "final" as const,
    terminal_status: i.reason,
    queue_status: i.queueStatus,
    outcome: { version: "outcome-v1", state: QUEUE_STOP_OUTCOME[ending], reason: i.reason, gaps: [] },
  });
  if (open) {
    await db.updateMessage(open.id, { content: queueStopContent(ending), metadata: finalMeta(open.metadata ?? {}) });
    outcome = "finalized";
  } else if (results.length === 0 && (openCheckpoints.length > 0 || ending === "failed" || ending === "cancelled")) {
    // A lineage the chat heard "still working" about, or one that failed, is
    // never left without a final word.
    await db.insertMessage({
      conversation_id: msgs[0].conversation_id, role: "assistant", content: queueStopContent(ending),
      agent_slug: "pilot",
      metadata: finalMeta({ plan_id: i.planId, agent_id: "pilot", kind: "run_final" }),
    });
    outcome = "inserted";
  } else if (results.length === 0) {
    outcome = "none";
  }
  for (const m of openCheckpoints) await db.updateMessage(m.id, resolveCheckpointPatch(m, ending, i.nowIso));
  return { checkpoints_resolved: openCheckpoints.length, results: outcome };
}

/** The Supabase implementation. Plan messages are keyed on `metadata->>plan_id`. */
// deno-lint-ignore no-explicit-any
export function supabaseNoticeDb(client: any): NoticeDb {
  return {
    listPlanMessages: async (planId) => {
      const { data, error } = await client.from("messages")
        .select("id, conversation_id, content, metadata, created_at")
        .filter("metadata->>plan_id", "eq", planId)
        .order("created_at", { ascending: true });
      if (error) throw new Error(`plan messages read failed: ${error.message}`);
      return (data ?? []) as NoticeMessage[];
    },
    insertMessage: async (row) => {
      const { error } = await client.from("messages").insert(row);
      if (error) throw new Error(`notice insert failed: ${error.message}`);
    },
    updateMessage: async (id, patch) => {
      const { error } = await client.from("messages").update(patch).eq("id", id);
      if (error) throw new Error(`notice update failed: ${error.message}`);
    },
  };
}
