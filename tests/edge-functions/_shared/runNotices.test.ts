// A STALE CHECKPOINT MUST NEVER OUTLIVE THE LINEAGE IT DESCRIBED.
//
// Canary 11 (plan 76194e61, 2026-09-25) left this conversation behind:
//
//   "This run reached its time limit partway through…"   PARTIALLY_SATISFIED   (34 s in, a save point)
//   "I opened the results in Workbench — 0 of 1…"        continuation_required (slice 1's end)
//   — the lineage then finished search_exhausted, and nothing said so.
//
// These tests drive the whole notice lifecycle through an in-memory message
// store: slice pause, continuation, completion after continuation, a real
// timeout / failure, a budget stop, a terminal failure — plus the stored
// canary-11 rows. PURE.

import { assert, assertEquals, assertFalse, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  continuingCheckpointContent, continuingResultsContent, noticeIsOpen, publishResultsNotice,
  resolvePlanNoticesForQueueEnd, runEndingOf, RUN_NOTICE_VERSION,
  type NoticeDb, type NoticeMessage, type RunEnding,
} from "../../../supabase/functions/_shared/runNotices.ts";
import { sweepCancelledMissions, type CancelSweepDb } from "../../../supabase/functions/_shared/leadMissionCancellation.ts";

const PLAN = "plan-1", CONV = "conv-1", TASK = "task-1";
const NOW = "2026-09-28T10:00:00.000Z";
/** Words that describe a failure or a stop. None may survive a successful lineage. */
const FAILURE_WORDS = /time limit|partway|timed out|couldn't|can't pick|stopped|failed|interrupted/i;

/** An in-memory `messages` table, with the realtime-visible history Pilot reads. */
function store(seed: NoticeMessage[] = []) {
  const rows: NoticeMessage[] = seed.map((r) => structuredClone(r));
  let n = rows.length;
  const writes: string[] = [];
  const db: NoticeDb = {
    listPlanMessages: (planId) => Promise.resolve(rows.filter((r) => (r.metadata ?? {}).plan_id === planId).map((r) => structuredClone(r))),
    insertMessage: (row) => {
      rows.push({ id: `m${++n}`, conversation_id: row.conversation_id, content: row.content, metadata: row.metadata, created_at: NOW });
      writes.push("insert");
      return Promise.resolve();
    },
    updateMessage: (id, patch) => {
      const r = rows.find((x) => x.id === id)!;
      r.content = patch.content; r.metadata = patch.metadata;
      writes.push(`update:${id}`);
      return Promise.resolve();
    },
  };
  const kind = (m: NoticeMessage) => (m.metadata?.kind as string) ?? ((m.metadata?.ui_panel as { kind?: string })?.kind ?? "other");
  return {
    db, rows, writes,
    checkpoint: () => rows.find((r) => kind(r) === "run_checkpoint")!,
    results: () => rows.filter((r) => kind(r) === "lead_results"),
    /** What Pilot loads as conversation history (`role, content`). */
    history: () => rows.map((r) => r.content).join("\n"),
  };
}

const planMessage = (): NoticeMessage => ({ id: "m0", conversation_id: CONV, content: "I created a 1-step plan: Scout will execute the approved mission.",
  metadata: { plan_id: PLAN, kind: "execution_plan" } });

/** What run-agent's `onCheckpoint` writes at a stage boundary (queue-owned). */
const checkpointRow = (): NoticeMessage => ({ id: "cp", conversation_id: CONV,
  content: continuingCheckpointContent({ queueOwned: true, resumable: false, cannotResume: "", summary: "4 companies found, 2 shortlisted", spendClause: "4 credits across 5 provider calls." }),
  metadata: { plan_id: PLAN, task_id: TASK, kind: "run_checkpoint", continuation_owner: "v2_queue", resumable: false,
    checkpoint_summary: "4 companies found, 2 shortlisted", notice_version: RUN_NOTICE_VERSION, notice_lifecycle: "continuing" } });

const panel = (terminal: string) => ({ ui_panel: { kind: "lead_results", plan_id: PLAN }, plan_id: PLAN, task_id: TASK, terminal_status: terminal });

/** A slice ending, exactly as `persistLeadResultsPanel` publishes it. */
function sliceEnd(db: NoticeDb, terminal: string, taskStatus: string | null, delivered: string, finalContent: string) {
  const continuing = terminal === "continuation_required";
  return publishResultsNotice(db, {
    planId: PLAN, conversationId: CONV, nowIso: NOW,
    content: continuing ? continuingResultsContent(delivered) : finalContent,
    lifecycle: continuing ? "continuing" : "final",
    ending: continuing ? null : runEndingOf({ terminalStatus: terminal, taskStatus }),
    metadata: panel(terminal),
  });
}

// ════════════════════════════════════════════════════════ slice pause ══

Deno.test("SLICE PAUSE: a stage-boundary save is a neutral 'continuing' notice — no time limit, no outcome, no terminal status", () => {
  const cp = checkpointRow();
  assertFalse(FAILURE_WORDS.test(cp.content), cp.content);
  assertMatch(cp.content, /Still working — progress is saved as it goes — 4 companies found, 2 shortlisted\./);
  assertMatch(cp.content, /carries this on automatically; there is nothing to click/);
  assertEquals([cp.metadata!.outcome, cp.metadata!.terminal_status], [undefined, undefined]);
  assert(noticeIsOpen(cp));
});

Deno.test("SLICE PAUSE, legacy edge run: still neutral; Continue is described as what to do IF it stops", () => {
  const resumable = continuingCheckpointContent({ queueOwned: false, resumable: true, cannotResume: "", summary: "3 companies found, 1 shortlisted", spendClause: "" });
  assertMatch(resumable, /^Progress saved — 3 companies found, 1 shortlisted\. If this run stops before it finishes, Continue below/);
  assertFalse(/time limit/.test(resumable));
  const not = continuingCheckpointContent({ queueOwned: false, resumable: false, cannotResume: "the search itself had not finished", summary: null, spendClause: "" });
  assertMatch(not, /If this run stops before it finishes, it can't be picked up where it left off: the search itself had not finished\./);
});

// ═══════════════════════════════════════════════════════ continuation ══

Deno.test("CONTINUATION: slice 1 opens ONE results message as 'results so far'; slice 2 corrects it in place — never a second one", async () => {
  const s = store([planMessage(), checkpointRow()]);
  const a = await sliceEnd(s.db, "continuation_required", "partial", "0 of 1 qualified company", "");
  assertEquals(a.action, "inserted");
  const b = await sliceEnd(s.db, "continuation_required", "partial", "1 of 2 qualified companies", "");
  assertEquals(b.action, "updated");
  assertEquals(s.results().length, 1);
  assertEquals(s.results()[0].content, continuingResultsContent("1 of 2 qualified companies"));
  assertEquals(s.results()[0].metadata!.notice_lifecycle, "continuing");
  assert(noticeIsOpen(s.checkpoint()), "the checkpoint stays open while the lineage continues");
  assertFalse(FAILURE_WORDS.test(s.history()), s.history());
});

// ═══════════════════════════════════════ successful completion after continuation ══

Deno.test("COMPLETION AFTER CONTINUATION: the last slice makes the ONE results message final and resolves the checkpoint — nothing left says partial", async () => {
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "continuation_required", "partial", "0 of 1 qualified company", "");
  await sliceEnd(s.db, "continuation_required", "partial", "0 of 1 qualified company", "");
  const done = await sliceEnd(s.db, "completed", "completed", "1 of 1 qualified company",
    "I opened the results in Workbench — 1 of 1 qualified company. 1 company passed every check. Nothing was sent.");
  assertEquals([done.action, done.checkpoints_resolved], ["updated", 1]);

  const r = s.results();
  assertEquals(r.length, 1, "one panel per plan, as ChatView expects");
  assertEquals(r[0].metadata!.notice_lifecycle, "final");
  assertEquals(r[0].metadata!.terminal_status, "completed", "the Workbench's ui_panel now carries the final status");
  assertMatch(r[0].content, /1 of 1 qualified company/);

  const cp = s.checkpoint();
  assertEquals([cp.metadata!.notice_lifecycle, cp.metadata!.resolved_as, cp.metadata!.resumable], ["resolved", "completed", false]);
  assertEquals(cp.content, "Progress was saved here — 4 companies found, 2 shortlisted, and the run carried on from this point. " +
    "It has since finished — the final result is reported below.");
  assertEquals([cp.metadata!.outcome, cp.metadata!.terminal_status], [undefined, undefined]);
  // Pilot reads `content` as history: no sentence in it says the run failed or stopped.
  assertFalse(FAILURE_WORDS.test(s.history()), s.history());
});

Deno.test("FINAL IS FINAL: a late continuing publish after the lineage ended changes nothing", async () => {
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "completed", "completed", "1 of 1", "I opened the results in Workbench — 1 of 1 qualified company. Nothing was sent.");
  const before = structuredClone(s.rows);
  const late = await sliceEnd(s.db, "continuation_required", "partial", "0 of 1", "");
  assertEquals(late.action, "skipped_final_exists");
  assertEquals(s.rows, before);
});

Deno.test("THE WORKER AFTER A NORMAL FINISH WRITES NOTHING: resolution is idempotent", async () => {
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "continuation_required", "partial", "0 of 1", "");
  await sliceEnd(s.db, "completed", "completed", "1 of 1", "I opened the results in Workbench — 1 of 1 qualified company. Nothing was sent.");
  const writes = s.writes.length;
  const q = await resolvePlanNoticesForQueueEnd(s.db, { planId: PLAN, queueStatus: "complete", reason: "completed", nowIso: NOW });
  assertEquals([q.results, q.checkpoints_resolved, s.writes.length], ["already_final", 0, writes]);
});

// ═════════════════════════════════════════════════ actual timeout / failure ══

Deno.test("ACTUAL TIMEOUT: a slice killed at the ceiling changes no notice (the queue retries it); retries exhausted → FAILED everywhere", async () => {
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "continuation_required", "partial", "0 of 1 qualified company", "");
  // The aborted attempt releases `resumable`: not terminal, so the worker resolves nothing.
  assertEquals(runEndingOf({ terminalStatus: "continuation_required", queueStatus: "resumable" }), null);
  assert(noticeIsOpen(s.results()[0]) && noticeIsOpen(s.checkpoint()));

  const q = await resolvePlanNoticesForQueueEnd(s.db, { planId: PLAN, queueStatus: "failed", reason: "retry_budget_exhausted", nowIso: NOW });
  assertEquals([q.results, q.checkpoints_resolved], ["finalized", 1]);
  const r = s.results()[0];
  assertEquals(r.content, "This search stopped before it could finish — it was interrupted on every retry the worker allows. " +
    "What it found so far is in Workbench. Nothing was sent.");
  assertEquals([r.metadata!.notice_lifecycle, r.metadata!.terminal_status, (r.metadata!.outcome as { state: string }).state],
    ["final", "retry_budget_exhausted", "FAILED"]);
  assertEquals(s.checkpoint().metadata!.resolved_as, "failed");
  assertMatch(s.checkpoint().content, /It has since stopped before finishing — the final status is reported below\.$/);
});

Deno.test("KILLED BEFORE ANY SLICE ENDED: the chat heard only 'still working' — a final message is written so it never ends there", async () => {
  const s = store([planMessage(), checkpointRow()]);
  const q = await resolvePlanNoticesForQueueEnd(s.db, { planId: PLAN, queueStatus: "failed", reason: "retry_budget_exhausted", nowIso: NOW });
  assertEquals(q.results, "inserted");
  const last = s.rows[s.rows.length - 1];
  assertEquals([last.metadata!.kind, last.metadata!.notice_lifecycle, last.metadata!.plan_id], ["run_final", "final", PLAN]);
  assertFalse(noticeIsOpen(s.checkpoint()));
});

Deno.test("ATTEMPTS SPENT ON CLEAN SLICES is a limit, not a failure (the queue row reads `failed`, the chat must not)", async () => {
  assertEquals(runEndingOf({ terminalStatus: "continuation_attempts_exhausted", queueStatus: "failed", taskStatus: "failed" }), "limit_reached");
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "continuation_required", "partial", "0 of 1", "");
  await resolvePlanNoticesForQueueEnd(s.db, { planId: PLAN, queueStatus: "failed", reason: "continuation_attempts_exhausted", nowIso: NOW });
  assertMatch(s.results()[0].content, /^This search used every round it was allowed without finishing\./);
  assertEquals((s.results()[0].metadata!.outcome as { state: string }).state, "PARTIALLY_SATISFIED");
});

// ═══════════════════════════════════════════════════════════ budget stop ══

Deno.test("BUDGET STOP: the last slice's own result is final; the checkpoint says it stopped at its budget", async () => {
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "continuation_required", "partial", "0 of 2", "");
  const r = await sliceEnd(s.db, "budget_exhausted", "partial", "1 of 2",
    "I opened the results in Workbench — 1 of 2 qualified companies. Nothing was sent.");
  assertEquals([r.action, r.checkpoints_resolved], ["updated", 1]);
  assertEquals(s.checkpoint().metadata!.resolved_as, "budget_stopped");
  assertMatch(s.checkpoint().content, /It has since stopped at its budget/);
  assertEquals(s.results()[0].metadata!.terminal_status, "budget_exhausted");
});

// ═══════════════════════════════════════════════════════ terminal failure ══

Deno.test("TERMINAL FAILURE: a provider failure ends the lineage FAILED; a refused-early run publishes a final failure too", async () => {
  assertEquals(runEndingOf({ terminalStatus: "provider_failure", taskStatus: "failed" }), "failed");
  const s = store([planMessage(), checkpointRow()]);
  await sliceEnd(s.db, "provider_failure", "failed", "0 of 1", "I couldn't run the search, so I have nothing to report about your market.");
  assertEquals(s.checkpoint().metadata!.resolved_as, "failed");
  assertEquals(s.results()[0].metadata!.notice_lifecycle, "final");
});

Deno.test("CANCELLED with no release to follow: the cancel sweep resolves the chat along with the rows", async () => {
  const s = store([planMessage(), checkpointRow()]);
  const calls: string[] = [];
  const db: CancelSweepDb = {
    readTask: () => Promise.resolve({ status: "ready", result: { terminal_status: "continuation_required" } }),
    readLineage: () => Promise.resolve({ status: "active" }),
    readPlan: () => Promise.resolve({ status: "partial" }),
    writeTask: () => { calls.push("task"); return Promise.resolve(); },
    writeLineage: () => { calls.push("lineage"); return Promise.resolve(); },
    writePlan: () => { calls.push("plan"); return Promise.resolve(); },
    listCancelled: () => Promise.resolve([{ id: "q1", task_id: TASK, lineage_id: TASK, plan_id: PLAN }]),
    resolveNotices: async (planId, queueStatus, reason) => {
      calls.push("notices");
      await resolvePlanNoticesForQueueEnd(s.db, { planId, queueStatus, reason, nowIso: NOW });
    },
  };
  await sweepCancelledMissions(db, NOW);
  assert(calls.includes("notices") && calls.includes("task"), calls.join(","));
  assertEquals(s.checkpoint().metadata!.resolved_as, "cancelled");
});

// ═══════════════════════════════════════════════ the stored canary-11 rows ══

Deno.test("CANARY 11 REPLAY: the stored 'time limit' notice and the slice-1 results message are resolved when the lineage ends", async () => {
  const stored = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/canary-11-notices/plan_messages.json", import.meta.url))) as NoticeMessage[];
  const plan = String(stored[0].metadata!.plan_id);
  const s = store(stored);
  // Written before this change: no lifecycle stamp, and still read as open.
  assertMatch(s.checkpoint().content, /reached its time limit/);
  assert(noticeIsOpen(s.checkpoint()) && noticeIsOpen(s.results()[0]));

  const q = await resolvePlanNoticesForQueueEnd(s.db, { planId: plan, queueStatus: "complete", reason: "search_exhausted", nowIso: NOW });
  assertEquals([q.results, q.checkpoints_resolved], ["finalized", 1]);
  // The stored summary is the FIRST save point's ("0 shortlisted"): the old
  // in-place correction rewrote the text but never this field. True of that
  // save point, and the new correction path refreshes it.
  assertEquals(s.checkpoint().content, "Progress was saved here — 4 companies found, 0 shortlisted, and the run carried on from this point. " +
    "It has since finished — the final result is reported below.");
  assertEquals(s.checkpoint().metadata!.outcome, undefined, "the PARTIALLY_SATISFIED stamp is gone");
  assertEquals(s.results()[0].metadata!.terminal_status, "search_exhausted");
  assertFalse(/time limit/.test(s.history()));
});

// ═══════════════════════════════════════════════════════════ the ending map ══

Deno.test("THE ENDING MAP: every terminal status, and continuation_required is never an ending on its own", () => {
  const cases: Array<[Parameters<typeof runEndingOf>[0], RunEnding | null]> = [
    [{ terminalStatus: "continuation_required" }, null],
    [{ terminalStatus: "continuation_required", queueStatus: "resumable" }, null],
    [{ terminalStatus: "completed", taskStatus: "completed" }, "completed"],
    [{ terminalStatus: "search_exhausted", taskStatus: "completed" }, "completed"],
    [{ terminalStatus: "search_exhausted", taskStatus: "partial" }, "finished_short"],
    [{ terminalStatus: "quota_not_met" }, "finished_short"],
    [{ terminalStatus: "budget_exhausted" }, "budget_stopped"],
    [{ terminalStatus: "round_limit_reached" }, "limit_reached"],
    [{ terminalStatus: "provider_failure" }, "failed"],
    [{ terminalStatus: "invalid_request" }, "failed"],
    [{ terminalStatus: "source_transition_failed" }, "failed"],
    [{ terminalStatus: "retry_budget_exhausted", queueStatus: "failed" }, "failed"],
    [{ terminalStatus: "cancelled", queueStatus: "cancelled" }, "cancelled"],
  ];
  for (const [input, want] of cases) assertEquals(runEndingOf(input), want, JSON.stringify(input));
});

// ═══════════════════════════════════════════════════════════════ wiring ══

Deno.test("WIRED: run-agent writes no time-limit notice, publishes results through the lifecycle, and the worker resolves at every terminal release", () => {
  const ra = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assertFalse(/`This run (reached|hit) its time limit/.test(ra), "no notice claims a time limit");
  assertFalse(/state: "PARTIALLY_SATISFIED",\s*reason: "execution_deadline_checkpoint"/.test(ra), "a save point states no outcome");
  assert(ra.includes("await publishResultsNotice(noticeDb, {"), "results go through publishResultsNotice");
  assertFalse(ra.includes(`.filter("metadata->ui_panel->>kind", "eq", "lead_results")
      .limit(1).maybeSingle();
    if (existing) return;`), "the one-per-plan early return is gone");
  assert(ra.includes(`lineageContinuing: effectiveTerminal === "continuation_required",`));
  assert(ra.includes("continuation_owner: inProcess.continuationOwner ??"), "the checkpoint write records who continues it");
  const worker = Deno.readTextFileSync(new URL("../../../worker/main.ts", import.meta.url));
  assert(worker.includes("if (planId) await resolveNotices(planId, finalStatus, reason);"));
  assert(worker.includes("rowsDb.resolveNotices = resolveNotices;"));
});
