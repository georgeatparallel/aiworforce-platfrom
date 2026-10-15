// THE LEDGER KNEW; RECOVERY DID NOT ASK THE RIGHT QUESTION.
//
// Three gaps between what `lead_execution_calls` records and what a resumed
// slice recovers from it (Lead V2, launch/hardening fec34976):
//
//   1  an Apify start whose ANSWER was lost — our own 20 s abort, a dropped
//      connection, a 5xx, a 2xx naming no run — was recorded
//      `apify_start_failed` / `apify_missing_run_id`, which D2 reads as
//      "nothing was bought": the verification was bought again. It is now
//      `apify_start_uncertain:<status>` and D2 holds it as UNCERTAIN. The
//      run-id progress write that would have named the run is retried.
//   2  a run whose poll window closed cleanly is finalized `timed_out` WITH its
//      run id and `metadata.resumable: true`. Pending-run recovery read only
//      `started` rows and counted every `timed_out` row as resolved, so a lost
//      checkpoint lost the run and the question was bought again.
//   3  a run ADOPTED in one slice is settled `reused`; completed-run recovery
//      read only `succeeded`/`empty`, so a lost checkpoint after an adoption
//      made the next slice buy the question again.
//
// What did NOT change: when credits are charged or refunded (the settle path
// keys on a run id, and an uncertain start still has none), the engine's
// spend-ledger floor for a failed call, the ledger row's status (`failed`).
//
// ZERO network (fetch is mocked), ZERO database, ZERO provider spend.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  APIFY_START_UNCERTAIN, priorPurchasesFrom, type VerifierLedgerRow,
} from "../../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import { outcomeFromToolResultForTest, runTool } from "../../../supabase/functions/_shared/toolRegistry.ts";
import { hashInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import {
  type ExecutionCallSpec, type ExecutionLedgerRow, type LedgerWriter, PROGRESS_WRITE_RETRY, withExecutionAudit,
} from "../../../supabase/functions/_shared/executionLedger.ts";
import {
  COMPLETED_RUN_STATUSES, isResumableTimeout, type LedgerReadDb, type LedgerReadQuery, type LedgerStartedRow,
  mergePendingRuns, readResumableTimeoutRows, recoverCompletedRuns, recoverPendingRuns, resolvedRunIdsFrom,
} from "../../../supabase/functions/_shared/pendingRunRecovery.ts";
import { refusedBeforeAnyRun } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { awaitedPendingRuns, PENDING_RUN_MAX_WAIT_MS } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import { spendFloorFromRows } from "../../../supabase/functions/_shared/missionSpendCap.ts";

Deno.env.set("LEAD_CREDIT_ENFORCEMENT", "observe");
Deno.env.set("MODEL_SPEND_ENFORCEMENT", "observe");
Deno.env.set("APIFY_API_TOKEN", "test-token-not-a-real-credential");

const src = (rel: string) => Deno.readTextFileSync(new URL(`../../../${rel}`, import.meta.url));

// ═════════════════════════════════════════ 1. a start whose answer was lost ══

function noopQuery(): unknown {
  const q: Record<string, unknown> = {};
  const ret = () => q;
  for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "in", "is", "not", "order", "limit", "match",
    "filter", "single", "maybeSingle", "range"]) q[m] = ret;
  (q as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return q;
}
const YC_INPUT = {
  mode: "companies", queries: [], topCompany: false, isHiring: true, nonprofit: false, batch: ["All Batches"],
  industries: ["B2B"], regions: ["United States of America"], minEmployeeSize: "10+", maxEmployeeSize: "500",
  scrapeFounderDetails: false, scrapeOpenJobs: true, enrichEmails: false, maxItems: 50,
};
const ENVELOPE = {
  selected_actor_key: "apify_yc_companies_memo23", actor_id: "memo23/y-combinator-scraper", compiled_actor_input: true,
  capability_key: "apify_yc_companies_memo23", input: YC_INPUT,
  compiled_input_hash: hashInput(YC_INPUT, "apify_yc_companies_memo23"),
};
const CTX = {
  workspace_id: "00000000-0000-0000-0000-000000000001", agent_slug: "scout", agent_id: null,
  admin: { from: () => noopQuery() },
};

/** Apify answers the start (POST /runs or GET /actor-runs) with `answer`; records every request. */
async function startWith(
  answer: () => Promise<Response>, envelope: Record<string, unknown> = ENVELOPE,
): Promise<{ r: Awaited<ReturnType<typeof runTool>>; seen: Array<{ method: string; url: string }> }> {
  const seen: Array<{ method: string; url: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: String(init?.method ?? "GET"), url: String(input instanceof Request ? input.url : input) });
    return answer();
  }) as typeof globalThis.fetch;
  try {
    return { r: await runTool("source_with_apify", envelope, CTX as never), seen };
  } finally {
    globalThis.fetch = real;
  }
}
const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

Deno.test("1 the start POST aborted or dropped (status 0) is UNCERTAIN, not a refusal — and is not retried", async () => {
  const { r, seen } = await startWith(() => Promise.reject(new TypeError("error sending request: connection reset")));
  assertFalse(r.ok);
  assertEquals(r.error, `${APIFY_START_UNCERTAIN}:0`);
  assertEquals(seen.filter((x) => x.method === "POST").length, 1, "one start, never a second one");
});

Deno.test("1 an Apify 5xx on the start is UNCERTAIN: the run may have been created before the error", async () => {
  for (const status of [500, 502, 503, 504]) {
    const { r, seen } = await startWith(json(status, { error: { message: "upstream" } }));
    assertEquals(r.error, `${APIFY_START_UNCERTAIN}:${status}`);
    assertEquals(seen.filter((x) => x.method === "POST").length, 1);
  }
});

Deno.test("1 a 2xx start that names no run is UNCERTAIN (was apify_missing_run_id)", async () => {
  const { r } = await startWith(json(201, { data: { status: "READY" } }));
  assertEquals(r.error, `${APIFY_START_UNCERTAIN}:missing_run_id`);
});

Deno.test("1 a DEFINITE refusal keeps its meaning: a 4xx is still apify_start_failed (no run exists)", async () => {
  for (const status of [404, 409, 429]) {
    const { r } = await startWith(json(status, { error: { message: "refused" } }));
    assertEquals(r.error, `apify_start_failed:${status}`);
  }
  assertEquals((await startWith(json(400, { error: { message: "bad input" } }))).r.error, "apify_input_schema_error");
  assertEquals((await startWith(json(402, {}))).r.error, "apify_insufficient_credits");
  assertEquals((await startWith(json(403, {}))).r.error, "apify_unauthorized");
});

Deno.test("1 a RESUME (GET on a run that exists) that fails is not a purchase: its codes are unchanged", async () => {
  const resume = { ...ENVELOPE, resume_run_id: "RUN-EXISTS" };
  const failed = await startWith(json(503, {}), resume);
  assertEquals(failed.r.error, "apify_start_failed:503");
  assertEquals(failed.seen.filter((x) => x.method === "POST").length, 0, "a resume never POSTs");
  assertEquals((await startWith(() => Promise.reject(new TypeError("reset")), resume)).r.error, "apify_start_failed:0");
  assertEquals((await startWith(json(200, { data: {} }), resume)).r.error, "apify_missing_run_id");
});

Deno.test("1 the ledger outcome of an uncertain start equals the old one but for its failure code — status, run id, cost, metadata", () => {
  const input = { ...ENVELOPE };
  for (const [now, before] of [
    [`${APIFY_START_UNCERTAIN}:0`, "apify_start_failed:0"],
    [`${APIFY_START_UNCERTAIN}:502`, "apify_start_failed:502"],
    [`${APIFY_START_UNCERTAIN}:missing_run_id`, "apify_missing_run_id"],
  ]) {
    const a = outcomeFromToolResultForTest({ ok: false, error: now }, input);
    const b = outcomeFromToolResultForTest({ ok: false, error: before }, input);
    assertEquals(a.status, "failed", "still a failed call — never `timed_out`");
    assertEquals([a.status, a.provider_run_id, a.dataset_id, a.cost, a.metadata],
      [b.status, b.provider_run_id, b.dataset_id, b.cost, b.metadata]);
    assertEquals(a.failure_code, APIFY_START_UNCERTAIN);
    assertEquals(a.failure_message, now);
  }
});

Deno.test("1 the engine treats an uncertain start exactly as before: not refused-before-any-run, so its reservation floor stands", () => {
  for (const code of [`${APIFY_START_UNCERTAIN}:0`, `${APIFY_START_UNCERTAIN}:503`, `${APIFY_START_UNCERTAIN}:missing_run_id`]) {
    assertFalse(refusedBeforeAnyRun(new Error(code)));
  }
  assertFalse(refusedBeforeAnyRun(new Error("apify_start_failed:0")), "unchanged reference");
});

const vrow = (over: Partial<VerifierLedgerRow>): VerifierLedgerRow => ({
  idempotency_key: "k1", provider_run_id: null, status: "failed", started_at: "2026-10-14T10:00:00.000Z",
  record_kind: "provider_call", ...over,
});

Deno.test("1 D2: a failed row whose start was UNCERTAIN may have bought a run — never bought again", () => {
  for (const error of [`${APIFY_START_UNCERTAIN}:0`, `${APIFY_START_UNCERTAIN}:503`, `${APIFY_START_UNCERTAIN}:missing_run_id`]) {
    // The failure code exactly as the transport writes it.
    const failure_code = outcomeFromToolResultForTest({ ok: false, error }, {}).failure_code;
    assertEquals(priorPurchasesFrom([vrow({ failure_code })]).lookup("k1")?.kind, "uncertain", error);
  }
});

Deno.test("1 D2: a DEFINITE refusal is no purchase — bought again, as before", () => {
  for (const error of ["apify_start_failed:404", "apify_start_failed:429", "apify_input_schema_error",
    "apify_unauthorized", "apify_insufficient_credits", "credit_refused"]) {
    const failure_code = outcomeFromToolResultForTest({ ok: false, error }, {}).failure_code;
    assertEquals(priorPurchasesFrom([vrow({ failure_code })]).lookup("k1"), null, error);
  }
});

// ═════════════════════════════════════════════ 1. the run-id progress write ══

function spec(): ExecutionCallSpec {
  return {
    workspace_id: "w", task_id: "t", plan_id: null, execution_owner: "company_first_v1", planner_owner: null,
    stage: "company_discovery", capability: "apify_yc_companies_memo23", reason: "initial_discovery",
    provider_id: "apify", actor_id: "memo23/y-combinator-scraper", request_input: { input: {} },
    logical_call_key: "t:cap:hash",
  } as ExecutionCallSpec;
}
/** A writer whose progress writes (`provider_run_id` patches) answer from `answers` in turn. */
function flakyWriter(answers: Array<"ok" | "error" | "throw">) {
  const progressCalls: Array<Partial<ExecutionLedgerRow>> = [];
  const finals: Array<Partial<ExecutionLedgerRow>> = [];
  const writer: LedgerWriter = {
    insert: () => Promise.resolve(),
    finalize: (_id, patch) => {
      if (!("status" in patch)) {
        progressCalls.push(patch);
        const a = answers[progressCalls.length - 1] ?? "ok";
        if (a === "throw") return Promise.reject(new Error("57014 canceling statement due to statement timeout"));
        return Promise.resolve(a === "ok");
      }
      finals.push(patch);
      return Promise.resolve(true);
    },
  };
  return { writer, progressCalls, finals };
}
const callThatStartsRun = () => async (progress: (p: Partial<ExecutionLedgerRow>) => Promise<void>) => {
  await progress({ provider_run_id: "RUN-1", dataset_id: "DS-1" });
  return { result: "rows", outcome: { status: "succeeded" as const, provider_run_id: "RUN-1" } };
};

Deno.test("1 the run-id progress write is RETRIED on a failed write, then lands", async () => {
  const { writer, progressCalls, finals } = flakyWriter(["error", "ok"]);
  assertEquals(await withExecutionAudit(writer, spec(), callThatStartsRun()), "rows");
  assertEquals(progressCalls.length, 2, "one failure, one retry");
  assertEquals(progressCalls.map((p) => p.provider_run_id), ["RUN-1", "RUN-1"], "the same idempotent patch");
  assertEquals(finals.length, 1);
});

Deno.test("1 a progress write that THROWS (transport) is retried too, and never fails the call", async () => {
  const { writer, progressCalls } = flakyWriter(["throw", "throw", "ok"]);
  assertEquals(await withExecutionAudit(writer, spec(), callThatStartsRun()), "rows");
  assertEquals(progressCalls.length, 3);
});

Deno.test("1 the retry is BOUNDED: a write that never lands is tried PROGRESS_WRITE_RETRY.attempts times, and the call still returns", async () => {
  const { writer, progressCalls, finals } = flakyWriter(["error", "error", "error", "error", "error"]);
  assertEquals(await withExecutionAudit(writer, spec(), callThatStartsRun()), "rows");
  assertEquals(progressCalls.length, PROGRESS_WRITE_RETRY.attempts);
  assert(PROGRESS_WRITE_RETRY.attempts <= 3 && PROGRESS_WRITE_RETRY.delaysMs.every((d) => d <= 1_000), "small and bounded");
  assertEquals(finals.length, 1, "the row is still finalized");
});

Deno.test("1 a landed write is not repeated, and a writer that reports nothing is read as written (as before)", async () => {
  const once = flakyWriter(["ok"]);
  await withExecutionAudit(once.writer, spec(), callThatStartsRun());
  assertEquals(once.progressCalls.length, 1);
  let calls = 0;
  const legacy: LedgerWriter = {
    insert: () => Promise.resolve(),
    finalize: (_id, patch) => { if (!("status" in patch)) calls++; return Promise.resolve(); },
  };
  await withExecutionAudit(legacy, spec(), callThatStartsRun());
  assertEquals(calls, 1);
});

Deno.test("1 the production writer reports a failed write, so the retry can see it", () => {
  const ledger = src("supabase/functions/_shared/executionLedger.ts");
  const i = ledger.indexOf("async finalize(id, patch) {");
  const block = ledger.slice(i, i + 500);
  assert(block.includes("return false;") && block.includes("return true;"));
  assert(ledger.includes("retryTransient(write, (ok) => !ok, PROGRESS_WRITE_RETRY)"));
  // And it is the run-id write the registry routes through it.
  const reg = src("supabase/functions/_shared/toolRegistry.ts");
  assert(reg.includes("await progress({ provider_run_id: run_id, dataset_id });"));
});

// ═══════════════════════════════ 2. a resumable timeout is still a pending run ══

const T = (s: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, s)).toISOString();
const ledgerRow = (over: Partial<LedgerStartedRow>): LedgerStartedRow => ({
  capability: "apify_linkedin_job_search", provider_id: "apify", provider_run_id: "RUN-T", dataset_id: "DS-T",
  status: "timed_out", request_input: { input: { jobTitles: ["sales"], maxItems: 40 } }, started_at: T(0),
  created_at: null, metadata: { resumable: true, status: "RUNNING" }, ...over,
});

Deno.test("2 the transport writes a closed poll window as timed_out WITH the run id and resumable: true", () => {
  const o = outcomeFromToolResultForTest({
    ok: false, error: "apify_run_running",
    data: { run_id: "RUN-T", dataset_id: "DS-T", status: "RUNNING", pending: true, resumable: true },
  }, {});
  assertEquals([o.status, o.provider_run_id, o.metadata], ["timed_out", "RUN-T", { resumable: true, status: "RUNNING" }]);
  assert(isResumableTimeout({ status: o.status, metadata: o.metadata as Record<string, unknown> }));
  // A run Apify itself timed out has ended.
  const ended = outcomeFromToolResultForTest({
    ok: false, error: "apify_run_timed-out", data: { run_id: "RUN-X", status: "TIMED-OUT", pending: false, resumable: false },
  }, {});
  assertEquals(ended.status, "timed_out");
  assertFalse(isResumableTimeout({ status: ended.status, metadata: ended.metadata as Record<string, unknown> }));
});

Deno.test("2 a RESUMABLE timed_out row is recovered as pending — adopted later, never bought again", () => {
  const out = recoverPendingRuns([ledgerRow({})]);
  assertEquals(out.map((r) => [r.run_id, r.provider, r.capability, r.dataset_id, r.started_at]),
    [["RUN-T", "apify_linkedin_job_search", null, "DS-T", T(0)]]);
});

Deno.test("2 a timed_out row that is NOT resumable (the run ended) is not pending", () => {
  assertEquals(recoverPendingRuns([ledgerRow({ metadata: { resumable: false, status: "TIMED-OUT" } })]), []);
  assertEquals(recoverPendingRuns([ledgerRow({ metadata: null })]), []);
  assertEquals(recoverPendingRuns([ledgerRow({ status: "failed" })]), []);
});

Deno.test("2 a resumable timeout does not RESOLVE its run; every other terminal row still does", () => {
  const rows = [
    ledgerRow({ provider_run_id: "A" }),                                              // still executing
    ledgerRow({ provider_run_id: "B", metadata: { resumable: false } }),              // ended
    ledgerRow({ provider_run_id: "C", status: "reused", metadata: null }),
    ledgerRow({ provider_run_id: "D", status: "succeeded", metadata: null }),
    ledgerRow({ provider_run_id: "E", status: "failed", metadata: null }),
    ledgerRow({ provider_run_id: "F", status: "started", metadata: null }),           // not a resolving status
  ];
  assertEquals([...resolvedRunIdsFrom(rows)].sort(), ["B", "C", "D", "E"]);
  // A re-read that found the run still executing AND a later adoption: the adoption resolves it.
  assertEquals([...resolvedRunIdsFrom([ledgerRow({}), ledgerRow({ status: "reused", metadata: null })])], ["RUN-T"]);
});

Deno.test("2 the same run on several rows (the POST, then a re-read still executing) is ONE pending run, timed from the purchase", () => {
  const out = recoverPendingRuns([
    ledgerRow({ started_at: T(30), request_input: { input: { jobTitles: ["sales"], maxItems: 40 }, resume_run_id: "RUN-T" } }),
    ledgerRow({ status: "started", metadata: null, started_at: T(0) }),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].started_at, T(0), "the wait bound counts from the purchase, not the latest re-read");
});

Deno.test("2 the WAIT stays bounded: a recovered timed-out run older than the bound no longer holds the lineage", () => {
  const [run] = recoverPendingRuns([ledgerRow({})]);
  const born = Date.parse(run.started_at);
  assertEquals(awaitedPendingRuns([run], born + 60_000), { awaited: 1, overdue: 0 });
  assertEquals(awaitedPendingRuns([run], born + PENDING_RUN_MAX_WAIT_MS + 1), { awaited: 0, overdue: 1 });
});

Deno.test("2 the SPEND FLOOR still skips re-reads: a re-read that found the run still executing is no second purchase", () => {
  const floor = spendFloorFromRows([
    { status: "timed_out", provider_call_id: "pc-1", settled_usd: null, actual_cost_usd: null, estimate_usd: 0.1 },
    { status: "timed_out", provider_call_id: "pc-1", settled_usd: null, actual_cost_usd: null, estimate_usd: 0.1, resumed_from: "RUN-T" },
    { status: "reused", provider_call_id: "pc-1", settled_usd: null, actual_cost_usd: null, estimate_usd: 0.1, resumed_from: "RUN-T" },
  ]);
  assertEquals([floor.paid_calls, floor.committed_usd], [1, 0.1]);
});

Deno.test("2 the checkpoint merge keeps a recovered timed-out run that the checkpoint lost", () => {
  const recovered = recoverPendingRuns([ledgerRow({})]);
  assertEquals(mergePendingRuns([], recovered, resolvedRunIdsFrom([ledgerRow({})])).map((r) => r.run_id), ["RUN-T"]);
});

/** A recording PostgREST fake for `readResumableTimeoutRows`. */
function fakeDb(answer: () => Promise<{ data: unknown[] | null; error: unknown }>) {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: LedgerReadQuery = {
    select: (c) => { calls.push(["select", c]); return q; },
    eq: (c, v) => { calls.push(["eq", c, v]); return q; },
    not: (c, o, v) => { calls.push(["not", c, o, v]); return q; },
    order: (c, o) => { calls.push(["order", c, o]); return q; },
    limit: (n) => { calls.push(["limit", n]); return answer(); },
  };
  const db: LedgerReadDb = { from: (t) => { calls.push(["from", t]); return q; } };
  return { db, calls };
}
const SCOPE = { table: "lead_execution_calls", parentTaskId: "task-parent", workspaceId: "ws-1" };

Deno.test("2 the timed-out read is gated on the paying lineage and keeps only the runs still executing", async () => {
  const { db, calls } = fakeDb(() => Promise.resolve({
    data: [ledgerRow({ provider_run_id: "LIVE" }), ledgerRow({ provider_run_id: "ENDED", metadata: { resumable: false } })],
    error: null,
  }));
  const rows = await readResumableTimeoutRows(db, SCOPE);
  assertEquals(rows.map((r) => r.provider_run_id), ["LIVE"]);
  assertEquals(calls.filter((c) => c[0] === "eq"), [
    ["eq", "task_id", "task-parent"], ["eq", "workspace_id", "ws-1"], ["eq", "status", "timed_out"],
  ]);
  assert(String(calls.find((c) => c[0] === "select")?.[1]).includes("metadata"));
  assert(calls.some((c) => c[0] === "not" && c[1] === "provider_run_id"));
});

Deno.test("2 the timed-out read is best effort: no parent reads nothing; an error or a throw recovers nothing more", async () => {
  const { db, calls } = fakeDb(() => Promise.resolve({ data: [ledgerRow({})], error: null }));
  assertEquals(await readResumableTimeoutRows(db, { ...SCOPE, parentTaskId: null }), []);
  assertEquals(calls.length, 0);
  const failed: string[] = [];
  assertEquals(await readResumableTimeoutRows(fakeDb(() => Promise.resolve({ data: null, error: { code: "57014" } })).db,
    SCOPE, (m) => failed.push(m)), []);
  assertEquals(await readResumableTimeoutRows(fakeDb(() => Promise.reject(new Error("reset"))).db,
    SCOPE, (m) => failed.push(m)), []);
  assertEquals(failed.length, 2);
});

Deno.test("2 run-agent reads resumable timed_out rows beside the started ones, and resolves with resolvedRunIdsFrom", () => {
  const run = src("supabase/functions/run-agent/index.ts");
  const i = run.indexOf("const startedRunRows");
  const block = run.slice(i, run.indexOf("const resolvedRunIds", i));
  assert(block.includes('.eq("status", "started")'), "the started rows, on their own window");
  assert(block.includes("await readResumableTimeoutRows(supabase as never, {"), "and the timed-out rows, on theirs");
  assert(block.includes("parentTaskId: leadResumeParentTaskId, workspaceId: workspace_id"), "same lineage + workspace gate");
  assert(block.includes("return [...(data ?? []), ...resumable];"), "both feed recovery");
  const j = run.indexOf("const resolvedRunIds");
  const resolved = run.slice(j, run.indexOf("recoverPendingRuns(startedRunRows, resolvedRunIds)", j));
  assert(resolved.includes('.select("provider_run_id, status, metadata")'));
  assert(resolved.includes("return resolvedRunIdsFrom(data ?? []);"));
});

// ═══════════════════════════════════════ 3. an adopted run is a completed run ══

Deno.test("3 a REUSED row (an adoption that read the finished run) is recovered as a completed run — re-read, never re-bought", () => {
  assert(COMPLETED_RUN_STATUSES.includes("reused"));
  const out = recoverCompletedRuns([
    ledgerRow({ provider_run_id: "RUN-ADOPTED", status: "reused", metadata: null }),
  ]);
  assertEquals(out.map((r) => [r.provider, r.run_id, r.dataset_id]), [["apify_linkedin_job_search", "RUN-ADOPTED", "DS-T"]]);
});

Deno.test("3 a completed run and its adoption are ONE completed run (dedupe by run and by question)", () => {
  const out = recoverCompletedRuns([
    ledgerRow({ provider_run_id: "RUN-1", status: "succeeded", metadata: null }),
    ledgerRow({ provider_run_id: "RUN-1", status: "reused", metadata: null }),
    ledgerRow({ provider_run_id: "RUN-2", status: "reused", metadata: null }),
  ]);
  assertEquals(out.map((r) => r.run_id), ["RUN-1"]);
});

Deno.test("3 still not completed: started, failed, a timeout", () => {
  for (const status of ["started", "failed", "timed_out"]) {
    assertEquals(recoverCompletedRuns([ledgerRow({ status })]), [], status);
  }
});

Deno.test("3 run-agent asks the ledger for reused rows among the completed ones", () => {
  const run = src("supabase/functions/run-agent/index.ts");
  const i = run.indexOf("const completedRunRows");
  const block = run.slice(i, run.indexOf("recoverCompletedRuns(completedRunRows)", i));
  assert(block.includes(".in(\"status\", [...COMPLETED_RUN_STATUSES])"));
  assert(block.includes('.eq("workspace_id", workspace_id)') && block.includes('.eq("task_id", leadResumeParentTaskId)'));
});

// ═════════════════════════════════════════════ what deliberately did not change ══

Deno.test("recovered pending runs carry NO rebuilt D3 selection and no guessed capability (unsafe — see RecoveredPendingRun)", () => {
  const spec = { purpose: "discovery", capability: "job_discovery", actor: "apify_linkedin_job_search" };
  const [r] = recoverPendingRuns([ledgerRow({ request_input: { input: { jobTitles: ["sales"] }, provider_call_spec: spec } })]);
  assertEquals(r.capability, null);
  assertFalse("selection" in r);
});

/** runTool with a credit ledger that records every credit RPC it receives. */
async function creditCallsFor(answer: () => Promise<Response>): Promise<Array<{ fn: string; args: Record<string, unknown> }>> {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    from: () => noopQuery(),
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "credits_reserve") return Promise.resolve({ data: { ok: true, replayed: false, transaction_id: "txn-1", balance_after: 4 }, error: null });
      if (fn === "credits_finalize") return Promise.resolve({ data: { ok: true, actual_credits: args.p_actual }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  const real = globalThis.fetch;
  globalThis.fetch = (() => answer()) as typeof globalThis.fetch;
  try {
    await runTool("source_with_apify", ENVELOPE, { ...CTX, admin } as never);
  } finally {
    globalThis.fetch = real;
  }
  return calls.filter((c) => c.fn.startsWith("credits_"));
}

Deno.test("credits: through runTool, an uncertain start keeps its reservation; a definite 4xx refusal is refunded", async () => {
  for (const answer of [() => Promise.reject(new TypeError("connection reset")), json(503, {}), json(201, { data: {} })]) {
    const calls = await creditCallsFor(answer);
    assertEquals(calls.map((c) => c.fn), ["credits_reserve"], "reserved, and then neither charged nor refunded: held");
  }
  const refused = await creditCallsFor(json(409, { error: { message: "refused" } }));
  assertEquals(refused.map((c) => c.fn), ["credits_reserve", "credits_finalize"]);
  assertEquals([refused[1].args.p_actual, refused[1].args.p_status], [0, "not_charged"], "no run exists: refunded whole");
});

Deno.test("credits: an uncertain start's reservation is HELD, never refunded as if nothing was bought", () => {
  // Billing decision (2026-10-14): hold until the outcome is known or the
  // explicit policy applies (credits_release_stale at 30 minutes).
  const reg = src("supabase/functions/_shared/toolRegistry.ts");
  const i = reg.indexOf("const settlement = creditSettlementFor(result);");
  assert(i > 0, "the settle path decides through creditSettlementFor");
  const block = reg.slice(i, reg.indexOf('console.log("[credits][settlement]"', i));
  assert(block.indexOf('settlement.action === "hold"') < block.indexOf("settleProviderCall("),
    "a hold is decided before, and instead of, any settle");
  assertFalse(reg.includes("const started = result.ok ||"), "no second, unguarded settle decision");
  const u = reg.indexOf("A START WHOSE OUTCOME IS UNKNOWN IS NOT A REFUSAL");
  const ublock = reg.slice(u, reg.indexOf("// ── PERSIST BEFORE WAITING", u));
  assertFalse(ublock.includes("data:"), "the uncertain result carries no run id, so only the hold keeps it from a refund");
});

// ── THE SPEND LEDGER COUNTS AN UNCERTAIN START ──────────────────────────────
// Review follow-up: `ledgerBoundCall` released the reservation of a start whose
// answer was lost, so the mission's ceilings forgot a run that may have been
// billed — and the same slice could have bought it again. It now stays executed.
import { ledgerBoundCall as lbc, type VerifierCall as VC } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { DEFAULT_CEILINGS as DC, newSpendLedger as nsl } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { verifierSpecCompiler as vsc } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import { criteriaExecutionPolicy as cep } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { guardedInvoker as gi } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { hiringActorCard as hac } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { parseLeadMissionDeterministic as plm } from "../../../supabase/functions/_shared/leadMission.ts";
import { readinessPolicy as rp } from "../../../supabase/functions/_shared/routeReadiness.ts";

function spendHarness(error: string) {
  const readiness = rp({ allow_experimental: ["apify_funding_pvalyou|funding_verification"] });
  const ledger = nsl({ ...DC });
  const sent: unknown[] = [];
  const call = lbc({
    ledger,
    spec: vsc({ scope: { workspace_id: "ws", lineage_id: "ln" }, mission_hash: "mh",
      policy: cep(plm("Find seed-stage B2B SaaS companies")), ceilings: () => ledger.ceilings, readiness }),
    actorIdFor: (k) => hac(k)?.actor_id ?? null,
    // The transport's error, as run-agent's invoker throws it.
    invoke: gi(null, (c: unknown) => { sent.push(c); return Promise.reject(new Error(error)); }, undefined, readiness),
    hash: () => "h",
  });
  const vc: VC = { actor_key: "apify_funding_pvalyou", capability: "funding_verification", input: { tier: "basic", companies: ["a.com"] },
    candidate_keys: ["a.com"], purpose: "funding_evidence" };
  return { ledger, sent, call: () => call(vc) };
}

Deno.test("1 an UNCERTAIN start keeps its reservation: the mission's ceilings count it, and this slice never buys it again", async () => {
  const h = spendHarness(`${APIFY_START_UNCERTAIN}:0`);
  assertEquals((await h.call()).status, "failed");
  assertEquals(h.ledger.reservations.map((r) => r.status), ["executed"], "possibly paid: counted");
  assertEquals((await h.call()).status, "failed");
  assertEquals(h.sent.length, 1, "the second ask is an idempotent skip, not a second start");
});

Deno.test("1 a DEFINITE refusal (4xx) still releases its reservation: nothing was bought", async () => {
  const h = spendHarness("apify_start_failed:400");
  assertEquals((await h.call()).status, "failed");
  assertEquals(h.ledger.reservations.map((r) => r.status), ["released"]);
});
