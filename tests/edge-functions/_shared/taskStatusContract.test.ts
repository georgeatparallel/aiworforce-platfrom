// PART 3 + PART 4 — status separation and the durable claim path.
// ZERO network, ZERO provider calls, ZERO model calls, ZERO database writes.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  projectStatus, projectApprovalPending, readStatuses, isContinuable, isTerminalOutcome,
  isTerminalRowStatus, isResumableRowStatus,
  TASK_ROW_STATUSES, TASK_RESULT_STATUSES, TERMINAL_STATUSES,
} from "../../../supabase/functions/_shared/taskStatusContract.ts";
import { claimContinuationViaRpc, releaseContinuationViaRpc, classifyClaimError, CLAIM_REFUSAL_MESSAGE, type ClaimRefusal, type ClaimErrorCategory } from "../../../supabase/functions/_shared/continuationClaim.ts";

// ---- PART 3: the three vocabularies stay separate --------------------------

Deno.test("3.A the task ROW only ever holds database execution state", () => {
  for (const terminal of TERMINAL_STATUSES) {
    const p = projectStatus(terminal);
    assert((TASK_ROW_STATUSES as readonly string[]).includes(p.rowStatus),
      `${terminal} projected an out-of-vocabulary row status: ${p.rowStatus}`);
    // The sourcing vocabulary must NEVER reach the column.
    assertFalse(["partial", "completed", "continuation_required"].includes(p.rowStatus), terminal);
  }
});

Deno.test("1.A continuation_required writes tasks.status = ready", () => {
  const p = projectStatus("continuation_required");
  assertEquals(p, { rowStatus: "ready", taskStatus: "partial", terminalStatus: "continuation_required" });
  assertFalse(p.rowStatus === "complete", "a checkpoint must never be written as complete");
  assert((TASK_RESULT_STATUSES as readonly string[]).includes(p.taskStatus));
});

Deno.test("1.B every genuine terminal outcome writes complete (or failed)", () => {
  assertEquals(projectStatus("completed"), { rowStatus: "complete", taskStatus: "completed", terminalStatus: "completed" });
  assertEquals(projectStatus("search_exhausted"), { rowStatus: "complete", taskStatus: "completed", terminalStatus: "search_exhausted" });
  assertEquals(projectStatus("budget_exhausted"), { rowStatus: "complete", taskStatus: "completed", terminalStatus: "budget_exhausted" });
  assertEquals(projectStatus("round_limit_reached"), { rowStatus: "complete", taskStatus: "completed", terminalStatus: "round_limit_reached" });
  assertEquals(projectStatus("quota_not_met"), { rowStatus: "complete", taskStatus: "completed", terminalStatus: "quota_not_met" });
  assertEquals(projectStatus("provider_failure"), { rowStatus: "failed", taskStatus: "failed", terminalStatus: "provider_failure" });
});

Deno.test("1.C approval-pending is its own row state and is not terminal", () => {
  assertEquals(projectApprovalPending(), { rowStatus: "awaiting_approval", taskStatus: "partial" });
  assertFalse(isTerminalRowStatus("awaiting_approval"));
});

Deno.test("1.D ready is NOT terminal; complete and failed are", () => {
  assertFalse(isTerminalRowStatus("ready"), "a checkpoint is not the end of the lifecycle");
  assertFalse(isTerminalRowStatus("running"));
  assertFalse(isTerminalRowStatus("pending"));
  assert(isTerminalRowStatus("complete"));
  assert(isTerminalRowStatus("failed"));
  assert(isTerminalRowStatus("skipped"));
});

Deno.test("1.E ready is a resumable row state; complete is not (except as legacy)", () => {
  assert(isResumableRowStatus("ready"));
  // Legacy rows persisted before the lifecycle change stay continuable.
  for (const legacy of ["partial", "running", "complete"]) assert(isResumableRowStatus(legacy), legacy);
  for (const never of ["failed", "skipped", "awaiting_approval", "pending", null]) {
    assertFalse(isResumableRowStatus(never as string), String(never));
  }
});

Deno.test("3.C a write-boundary violation fails the task whatever sourcing said", () => {
  assertEquals(projectStatus("completed", "provider_side_write").rowStatus, "failed");
  assertEquals(projectStatus("continuation_required", "provider_side_write").rowStatus, "failed");
  assertEquals(projectStatus("invalid_request"), { rowStatus: "failed", taskStatus: "failed", terminalStatus: "invalid_request" });
});

Deno.test("3.D an unknown outcome degrades to invalid_request, not to success", () => {
  const p = projectStatus("something_new");
  assertEquals(p.terminalStatus, "invalid_request");
  assertEquals(p.rowStatus, "failed");
});

Deno.test("3.E continuation eligibility reads the terminal status only", () => {
  assert(isContinuable("continuation_required"));
  for (const t of ["completed", "search_exhausted", "budget_exhausted", "round_limit_reached", "provider_failure", "invalid_request"]) {
    assertFalse(isContinuable(t), t);
    assert(isTerminalOutcome(t), t);
  }
  assertFalse(isTerminalOutcome("continuation_required"));
});

// ---- PART 3: backward compatibility with already-persisted rows ------------

Deno.test("3.F1 the legacy `done` dialect present in TEST is readable", () => {
  const done = readStatuses({ status: "done", result: {} });
  assertEquals(done.taskStatus, "completed");
  assert(done.legacy);
});

Deno.test("3.F rows written BEFORE the split are still read correctly", () => {
  // The legacy shape: the sourcing outcome was written into the COLUMN.
  const legacy = readStatuses({ status: "partial", result: { company_first: { status: "continuation_required" } } });
  assertEquals(legacy.taskStatus, "partial");
  assertEquals(legacy.terminalStatus, "continuation_required");
  assert(legacy.legacy, "the adapter must flag a legacy read");

  const legacyDone = readStatuses({ status: "completed", result: { company_first: { status: "completed" } } });
  assertEquals(legacyDone.taskStatus, "completed");
  assertEquals(legacyDone.terminalStatus, "completed");
});

Deno.test("3.G rows written AFTER the split read from result and are not flagged legacy", () => {
  const modern = readStatuses({
    status: "complete",
    result: { task_status: "partial", terminal_status: "continuation_required" },
  });
  assertEquals(modern.rowStatus, "complete");
  assertEquals(modern.taskStatus, "partial");
  assertEquals(modern.terminalStatus, "continuation_required");
  assertFalse(modern.legacy);
});

Deno.test("3.H reading never rewrites — the adapter is pure", () => {
  const row = { status: "partial", result: { company_first: { status: "continuation_required" } } };
  const snapshot = JSON.stringify(row);
  readStatuses(row);
  assertEquals(JSON.stringify(row), snapshot, "a persisted record was mutated by a read");
});

Deno.test("3.I a non-sourcing task is read without inventing sourcing state", () => {
  const plain = readStatuses({ status: "complete", result: {} });
  assertEquals(plain.taskStatus, null);
  assertEquals(plain.terminalStatus, null);
  assertFalse(plain.legacy);
});

// ---- PART 4: the RPC claim path -------------------------------------------

function rpcDb(response: { data: unknown; error: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    db: { rpc: async (_fn: string, args: Record<string, unknown>) => { calls.push(args); return response; } },
  };
}

Deno.test("4.A a successful RPC claim reports the new checkpoint version", async () => {
  const { db, calls } = rpcDb({ data: [{ claimed: true, reason: "claimed", task_id: "t", checkpoint_version: 3, held_by: "c", held_until: "2026-07-26T12:05:00Z" }], error: null });
  const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
  assertEquals(r, { available: true, claimed: true, checkpointVersion: 3 });
  // Task AND workspace are both scoped in the call.
  assertEquals(calls[0].p_task_id, "t");
  assertEquals(calls[0].p_workspace_id, "ws");
  assertEquals(calls[0].p_claim_id, "c");
});

Deno.test("4.B every RPC refusal reason maps to a message", async () => {
  const reasons: ClaimRefusal[] = ["already_claimed", "task_not_found", "workspace_mismatch", "no_checkpoint", "already_terminal"];
  for (const reason of reasons) {
    const { db } = rpcDb({ data: [{ claimed: false, reason, task_id: "t", checkpoint_version: 1, held_by: null, held_until: null }], error: null });
    const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
    assert(r.available && !r.claimed, reason);
    assertEquals(r.available && !r.claimed && r.reason, reason);
    assert(CLAIM_REFUSAL_MESSAGE[reason].length > 0, reason);
  }
});

// ---- PART 3: the fallback runs ONLY for a genuinely missing function --------
//
// `available: false` is the ONLY value that permits the weaker compatibility
// claim. Every other outcome must keep `available: true`, so run-agent stops.

Deno.test("3.1 RPC succeeds → the fallback never runs", async () => {
  const { db } = rpcDb({ data: [{ claimed: true, reason: "claimed", task_id: "t", checkpoint_version: 1, held_by: "c", held_until: null }], error: null });
  const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
  assert(r.available, "a successful claim must not permit the fallback");
});

Deno.test("3.2-3.8 conflicts, permissions, RLS, database and validation failures never fall back", async () => {
  const cases: Array<[string, { data: unknown; error: unknown }, ClaimErrorCategory]> = [
    ["claim conflict", { data: [{ claimed: false, reason: "already_claimed", task_id: "t", checkpoint_version: 1, held_by: "x", held_until: null }], error: null }, "conflict"],
    ["workspace mismatch", { data: [{ claimed: false, reason: "workspace_mismatch", task_id: "t", checkpoint_version: null, held_by: null, held_until: null }], error: null }, "conflict"],
    ["invalid checkpoint", { data: [{ claimed: false, reason: "no_checkpoint", task_id: "t", checkpoint_version: null, held_by: null, held_until: null }], error: null }, "conflict"],
    ["terminal task", { data: [{ claimed: false, reason: "already_terminal", task_id: "t", checkpoint_version: 1, held_by: null, held_until: null }], error: null }, "conflict"],
    ["permission denied", { data: null, error: { code: "42501", message: "permission denied for table tasks" } }, "permission"],
    ["RLS refusal", { data: null, error: { code: "PGRST301", message: "row-level security policy" } }, "permission"],
    ["database timeout", { data: null, error: { code: "57014", message: "statement timeout" } }, "database"],
    ["connection failure", { data: null, error: { code: "08006", message: "connection failure" } }, "database"],
    ["validation failure", { data: null, error: { code: "22P02", message: "invalid input syntax for type uuid" } }, "validation"],
    ["unexpected response", { data: [{ nonsense: true }], error: null }, "unexpected_response"],
    ["unknown error", { data: null, error: { message: "something odd" } }, "unknown"],
  ];
  for (const [name, response, _category] of cases) {
    const { db } = rpcDb(response);
    const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
    assert(r.available, `${name} incorrectly permitted the compatibility fallback`);
    assert(!r.claimed, `${name} was treated as a successful claim`);
  }
});

Deno.test("3.9 ONLY a missing function permits the compatibility fallback", async () => {
  for (const error of [
    { code: "42883", message: "function claim_sourcing_continuation does not exist" },
    { code: "PGRST202", message: "Could not find the function in the schema cache" },
  ]) {
    const { db } = rpcDb({ data: null, error });
    const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
    assertEquals(r, { available: false, category: "missing_function" }, JSON.stringify(error));
  }
});

Deno.test("3.10 a transport failure fails CLOSED — it is not evidence of a missing RPC", async () => {
  const db = { rpc: async () => { throw new Error("network down"); } };
  const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
  assert(r.available, "a network failure must not downgrade to the weaker claim");
  assert(!r.claimed);
  assertEquals(r.available && !r.claimed && r.category, "transport");
});

Deno.test("3.x error classification never leaks raw database text to the user", async () => {
  const { db } = rpcDb({ data: null, error: { code: "42501", message: "permission denied for relation tasks OWNER=postgres" } });
  const r = await claimContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c" });
  assert(r.available && !r.claimed);
  const shown = CLAIM_REFUSAL_MESSAGE[(r.available && !r.claimed && r.reason) as ClaimRefusal];
  assertFalse(shown.includes("postgres"), "raw database text reached user-visible copy");
  assertFalse(shown.includes("permission denied for relation"));
  assertEquals(classifyClaimError({ code: "42501", message: "x" }), "permission");
});

// ---- wiring + migration proofs --------------------------------------------

Deno.test("WIRING: run-agent prefers the RPC and falls back only when it is absent", async () => {
  const src = await Deno.readTextFile(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assertStringIncludes(src, "claimContinuationViaRpc({");
  assertStringIncludes(src, "if (rpc.available && !rpc.claimed)");
  assertStringIncludes(src, "const cas = rpc.available");
  assertStringIncludes(src, 'claim_path: rpc.available ? "rpc" : "compatibility_fallback"');
  // Status separation is applied on the finishing write, and the CONTACT-only
  // quota travels with it — without that argument a terminal-but-unfilled run
  // (`search_exhausted` with 0 of 5) projects as `completed`, which is what
  // production plan 43fb7313 reported to the user.
  // PROJECTED FROM `effectiveTerminal`, NOT `cf.status`. The legacy quota
  // controller reports its ROUND COUNT — `round_limit_reached` after one round
  // — which is in NON_RESUMABLE, so projecting it made `decideResume` refuse
  // the run's own automatic continuation with 409 `already_terminal` while 88
  // candidates were still on the frontier. When work remains and the quota is
  // unmet the run is `continuation_required`; otherwise this IS `cf.status`.
  assertStringIncludes(src, "const statuses = projectStatus(");
  // Lead V2 reads its own settled outcome (the canonical qualified count when
  // the company is the deliverable); everything else keeps the CONTACT quota.
  assertStringIncludes(src, "effectiveTerminal, cf.writeBoundary.invariantViolation, v2Outcome ? v2Outcome.quota : {");
  assertStringIncludes(src, ": autoDecision.continue ? \"continuation_required\" : cf.status;");
  assertStringIncludes(src, "contactReady: cf.quota.eligible_leads,");
  assertStringIncludes(src, "requested: cf.quota.requested_leads,");
  assertStringIncludes(src, "status: statuses.rowStatus,");
  assertStringIncludes(src, "task_status: statuses.taskStatus,");
  assertStringIncludes(src, "terminal_status: statuses.terminalStatus,");
});

// NOTE: these are MIGRATION-CONTRACT tests over the SQL TEXT. They prove the
// file declares the required properties. They are NOT execution proof against a
// real Postgres — that is what the controlled TEST plan exists for.
Deno.test("MIGRATION CONTRACT: the claim RPC declares the required properties, and is NOT applied", async () => {
  const sql = await Deno.readTextFile(new URL("../../../supabase/migrations-archive/20260727090000_continuation_claim_lease.sql", import.meta.url));
  // The property the PostgREST version cannot provide.
  assertStringIncludes(sql, "for update");
  assertStringIncludes(sql, "create or replace function public.claim_sourcing_continuation");
  assertStringIncludes(sql, "create or replace function public.release_sourcing_continuation");
  // Tenant scope, terminal refusal, lease expiry, claim identity.
  assertStringIncludes(sql, "workspace_id is distinct from p_workspace_id");
  assertStringIncludes(sql, "already_terminal");
  assertStringIncludes(sql, "continuation_claim_expires_at > now()");
  assertStringIncludes(sql, "checkpoint_version            = public.tasks.checkpoint_version + 1");
  // Additive, reversible, documented rollback.
  assertStringIncludes(sql, "add column if not exists continuation_claim_id uuid");
  assertStringIncludes(sql, "-- ROLLBACK");
  assertStringIncludes(sql, "drop function public.claim_sourcing_continuation");
  // Release is claim-scoped so a straggler cannot clear a successor's lease.
  assertStringIncludes(sql, "and continuation_claim_id = p_claim_id");
  // Lifecycle: the normal claim is ready → running, and terminal rows are refused.
  assertStringIncludes(sql, "v_row.status is distinct from 'ready'");
  assertStringIncludes(sql, "v_row.status in ('complete', 'failed', 'skipped')");
  assertStringIncludes(sql, "not_resumable_state");
  // The row status the release writes stays inside the lifecycle vocabulary.
  assertStringIncludes(sql, "'pending', 'running', 'ready', 'awaiting_approval', 'complete', 'failed', 'skipped'");
  assertStringIncludes(sql, "p_row_status   text default 'ready'");
  // result is MERGED, never replaced, so a concurrent checkpoint is not lost.
  assertStringIncludes(sql, "coalesce(public.tasks.result, '{}'::jsonb) || jsonb_build_object(");
  assertStringIncludes(sql, "coalesce(public.tasks.result, '{}'::jsonb) - 'continuation_claim'");
  // Security posture.
  assertStringIncludes(sql, "set search_path = public, pg_temp");
  assertStringIncludes(sql, "revoke all on function public.claim_sourcing_continuation");
  assertStringIncludes(sql, "grant execute on function public.claim_sourcing_continuation(uuid, uuid, uuid, integer) to service_role");
  // Strip comments before checking: the header DISCUSSES security definer, it
  // must not USE it.
  const executable = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assertFalse(/security\s+definer/i.test(executable), "SECURITY DEFINER is not needed here");

  // NOT APPLIED: the file exists in the repo and nothing in this branch runs it.
  assertStringIncludes(sql, "NOT APPLIED");
});

// ---- PART 6: the durable lease is RELEASED when the round ends -------------
//
// REGRESSION. The RPC claim writes its lease into `tasks.continuation_claim_*`
// COLUMNS, but the finishing write only stripped the `result.continuation_claim`
// KEY — which is all the compatibility path ever wrote. The lease therefore
// survived the round and refused the next `Continue sourcing` with
// `already_claimed` until it expired. Invisible offline, because it only
// manifests once the migration is applied.

function releaseDb(response: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    db: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return response; } },
  };
}

Deno.test("6.A releasing calls the claim-scoped RPC with task, workspace and claim id", async () => {
  const { db, calls } = releaseDb({ data: true, error: null });
  const r = await releaseContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c", rowStatus: "ready" });
  assertEquals(r, { available: true, released: true, category: null, code: null });
  assertEquals(calls[0].fn, "release_sourcing_continuation");
  assertEquals(calls[0].args, { p_task_id: "t", p_workspace_id: "ws", p_claim_id: "c", p_row_status: "ready" });
});

Deno.test("6.B a superseded straggler is told it did NOT release", async () => {
  // The RPC returns false when continuation_claim_id no longer matches.
  const { db } = releaseDb({ data: false, error: null });
  const r = await releaseContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "stale", rowStatus: "ready" });
  assert(r.available);
  assertFalse(r.released, "a non-matching claim id must never report a successful release");
});

Deno.test("6.C release failures are reported, never thrown — the outcome is already committed", async () => {
  const db = { rpc: async () => { throw new Error("network down"); } };
  const r = await releaseContinuationViaRpc({ db, taskId: "t", workspaceId: "ws", claimId: "c", rowStatus: "complete" });
  assertFalse(r.released);
  assertEquals(r.category, "transport");

  const missing = releaseDb({ data: null, error: { code: "42883", message: "function release_sourcing_continuation does not exist" } });
  const m = await releaseContinuationViaRpc({ db: missing.db, taskId: "t", workspaceId: "ws", claimId: "c", rowStatus: "ready" });
  assertFalse(m.available, "a missing release RPC is the pre-migration state, not an error");
  assertFalse(m.released);
});

Deno.test("6.D every row status the projection can produce is accepted by the release RPC", async () => {
  const sql = await Deno.readTextFile(new URL("../../../supabase/migrations-archive/20260727090000_continuation_claim_lease.sql", import.meta.url));
  const allowed = /p_row_status not in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
  for (const terminal of TERMINAL_STATUSES) {
    const { rowStatus } = projectStatus(terminal);
    assertStringIncludes(allowed, `'${rowStatus}'`,
      `${terminal} projects rowStatus=${rowStatus}, which release_sourcing_continuation would reject`);
  }
});

Deno.test("6.E WIRING: run-agent releases the RPC lease on the finishing write", async () => {
  const src = await Deno.readTextFile(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assertStringIncludes(src, "releaseContinuationViaRpc({");
  // Released only on the path that actually took a column lease.
  assertStringIncludes(src, "if (heldClaim?.viaRpc)");
  assert(/heldClaim = \{\s*claimId, viaRpc: rpc\.available,/.test(src), "the claim records its path");
  // The release carries the same row status the projection just wrote.
  assertStringIncludes(src, "rowStatus: statuses.rowStatus,");
});

Deno.test("6.F MIGRATION CONTRACT: the documented rollback drops the real signature", async () => {
  const sql = await Deno.readTextFile(new URL("../../../supabase/migrations-archive/20260727090000_continuation_claim_lease.sql", import.meta.url));
  // release_sourcing_continuation is (uuid, uuid, uuid, text) — a 3-arg DROP fails.
  assertStringIncludes(sql, "drop function public.release_sourcing_continuation(uuid, uuid, uuid, text);");
});

Deno.test("WIRING: a refused continuation preserves the previous slice", async () => {
  // Task 9425b3fc: the continuation could not claim the mission architecture
  // and the `sourcing-not-accepted` path overwrote `result` wholesale with a
  // `blocked: true` stub and set the row to `failed`. On a first run that is
  // correct — nothing is lost. On a continuation the row already held three
  // qualified companies, the funnel, the workbench rows and the checkpoint, and
  // all of it went.
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  // The guard exists and is keyed on this being a continuation.
  assertStringIncludes(src, "[run-agent][continuation-not-accepted] prior slice preserved");
  assertStringIncludes(src, 'error: "continuation_not_accepted"');
  // It returns BEFORE the destructive write.
  const guardAt = src.indexOf("[run-agent][continuation-not-accepted] prior slice preserved");
  const wipeUpdateAt = src.indexOf('error_message: "sourcing_requires_mission_architecture"');
  assert(guardAt > 0, "the guard must exist");
  assert(guardAt < wipeUpdateAt,
    "the continuation guard must return before the result is overwritten");
  // And it hands the lease back, so the run stays resumable.
  assertStringIncludes(src, "rowStatus: RESUMABLE_ROW_STATUS,");
});

Deno.test("WIRING: a continuation that restored nothing refuses to overwrite", async () => {
  // ARCHITECTURE: results are monotonic; a company qualified by one slice
  // cannot be unqualified by a later one.
  //
  // Task 528c2266 broke both. The parent discovered 100 companies, qualified
  // one, and left 83 on the frontier. Its continuation loaded zero checkpoint
  // records, skipped discovery as already-complete, ran with an EMPTY working
  // set, finished in 0.3s, and wrote that emptiness over the parent —
  // `qualified` 1 → 0, funnel 100 → 0, and the checkpoint's own company list
  // 100 → 0, destroying the frontier that made the run resumable.
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assertStringIncludes(src, '"[run-agent][continuation-restore-empty] refusing to overwrite"');
  assertStringIncludes(src, 'error: "continuation_restore_empty"');
  // The contradiction it keys on: state says companies exist, checkpoint has none.
  assertStringIncludes(src, "priorState?.company_keys?.length ?? 0");
  assertStringIncludes(src, "if (resume_task_id && leadResumeRecords.length === 0)");
  // It returns BEFORE the engine runs, so nothing can be written.
  const guardAt = src.indexOf("continuation-restore-empty");
  const engineAt = src.indexOf("await runCapabilityPlan(");
  assert(guardAt > 0 && engineAt > 0 && guardAt < engineAt,
    "the guard must refuse before the engine executes");
  // And it hands the lease back so the run stays resumable.
  assertStringIncludes(src, "rowStatus: RESUMABLE_ROW_STATUS,");
});

Deno.test("WIRING: a refusal disarms the terminal guard so it writes nothing", async () => {
  // Task 7cd5cfb1. The restore-empty refusal worked — it stopped the ENGINE
  // overwriting a row holding five qualified companies. Then the terminal
  // guard's own `finally` wrote `completed / no_qualified_companies` over it
  // anyway, because from the guard's point of view the invocation had produced
  // no state. Returning early is not enough; the guard has to be told.
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assertStringIncludes(src, 'terminalGuard.disarm("continuation_restore_empty")');
  assertStringIncludes(src, 'terminalGuard.disarm("continuation_not_accepted")');

  // Both must disarm BEFORE returning, or the finally still fires.
  for (const reason of ["continuation_restore_empty", "continuation_not_accepted"]) {
    const disarmAt = src.indexOf(`terminalGuard.disarm("${reason}")`);
    const returnAt = src.indexOf(`error: "${reason}"`);
    assert(disarmAt > 0 && returnAt > 0 && disarmAt < returnAt,
      `${reason}: the guard must be disarmed before the refusal returns`);
  }

  // And the guard must actually honour it.
  const guard = await Deno.readTextFile(
    new URL("../../../supabase/functions/_shared/leadRunTerminalGuard.ts", import.meta.url));
  assertStringIncludes(guard, "disarm: (reason: string) => void;");
  assertStringIncludes(guard, "terminal_guard_disarmed");
  // The short-circuit sits at the TOP of the finally, ahead of every write.
  const finallyAt = guard.indexOf("} finally {");
  const shortCircuitAt = guard.indexOf("if (disarmed !== null)");
  const firstWriteAt = guard.indexOf("await db.writeTask(");
  assert(finallyAt < shortCircuitAt && shortCircuitAt < firstWriteAt,
    "the disarm check must precede any write the guard performs");
});
