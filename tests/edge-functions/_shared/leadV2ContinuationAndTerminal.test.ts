// LEAD V2 RUN 4250f181 — CONTINUATION AUTH AND TERMINAL STATE, PINNED.
//
//   • Every continuation dispatch from the Railway worker to edge `run-agent`
//     ended in 401: the worker's service key is valid but is not the SAME STRING
//     the edge runtime was injected with, and run-agent compared strings.
//   • The V2 queue and run-agent's HTTP self-dispatch both claimed to own
//     continuation.
//   • The mission ended `queue failed / task ready / lineage active / plan
//     partial`.
//
// PURE — injected fetch, no network, no database.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isServiceRoleBearer, jwtRole, looksLikeServiceCredential, resetServiceAuthCache,
} from "../../../supabase/functions/_shared/serviceRoleAuth.ts";
import {
  applyTerminalPatch, CONTINUATION_ATTEMPTS_EXHAUSTED, finalQueueStatus, planTerminalReconciliation, RETRY_BUDGET_EXHAUSTED,
  terminalReasonFor, terminalViolations, V2_MAX_ATTEMPTS, type TerminalRows,
} from "../../../supabase/functions/_shared/leadMissionTerminal.ts";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;

const EDGE_KEY = jwt({ role: "service_role", ref: "proj", iat: 1 });
const RAILWAY_KEY = jwt({ role: "service_role", ref: "proj", iat: 2 }); // valid, different string
const ANON_KEY = jwt({ role: "anon", ref: "proj" });
const USER_JWT = jwt({ role: "authenticated", sub: "u1" });

function authServer(accept: Set<string>) {
  const calls: string[] = [];
  const fetch = (url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get("apikey") ?? "";
    calls.push(url);
    return Promise.resolve(new Response("{}", { status: accept.has(key) ? 200 : 401 }));
  };
  return { fetch, calls };
}
const deps = (fetch: (u: string, i: RequestInit) => Promise<Response>) => ({
  envServiceKey: EDGE_KEY, supabaseUrl: "https://proj.supabase.co", fetch,
});

// ═══ CONTINUATION AUTH ═════════════════════════════════════════════════════

Deno.test("our own key is a service caller with no network call", async () => {
  resetServiceAuthCache();
  const s = authServer(new Set());
  assert(await isServiceRoleBearer(EDGE_KEY, deps(s.fetch)));
  assertEquals(s.calls.length, 0);
});

Deno.test("the Railway worker's different-but-valid service key is accepted — verified by Supabase Auth", async () => {
  resetServiceAuthCache();
  const s = authServer(new Set([RAILWAY_KEY]));
  assert(await isServiceRoleBearer(RAILWAY_KEY, deps(s.fetch)));
  assertEquals(s.calls, ["https://proj.supabase.co/auth/v1/admin/users?page=1&per_page=1"]);
  // Cached: a continuation storm does not become an auth storm.
  assert(await isServiceRoleBearer(RAILWAY_KEY, deps(s.fetch)));
  assertEquals(s.calls.length, 1);
});

Deno.test("invalid continuation auth still fails", async () => {
  resetServiceAuthCache();
  const s = authServer(new Set());
  // A forged or foreign service_role JWT: asked, refused.
  assertFalse(await isServiceRoleBearer(jwt({ role: "service_role", ref: "other" }), deps(s.fetch)));
  // Not even claiming to be a service credential: refused offline.
  const before = s.calls.length;
  for (const bad of [ANON_KEY, USER_JWT, "junk", "", "Bearer x"]) {
    assertFalse(await isServiceRoleBearer(bad, deps(s.fetch)), bad);
  }
  assertEquals(s.calls.length, before, "anon/user/junk bearers never cost a network call");
  assertEquals(jwtRole(ANON_KEY), "anon");
  assert(looksLikeServiceCredential("sb_secret_abc"));
  assertFalse(looksLikeServiceCredential(ANON_KEY));
});

Deno.test("a transport failure refuses now and is not cached as a verdict", async () => {
  resetServiceAuthCache();
  let fail = true;
  const fetch = () => fail ? Promise.reject(new Error("down")) : Promise.resolve(new Response("{}", { status: 200 }));
  assertFalse(await isServiceRoleBearer(RAILWAY_KEY, deps(fetch)));
  fail = false;
  assert(await isServiceRoleBearer(RAILWAY_KEY, deps(fetch)), "asked again once the auth server is back");
});

Deno.test("run-agent and enqueue verify service callers instead of string-comparing", () => {
  const ra = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(ra.includes("bearerIsServiceRole = await isServiceRoleBearer(bearer"));
  assertFalse(/bearerIsServiceRole = !!bearer && bearer === serviceRoleKey/.test(ra));
  const eq = Deno.readTextFileSync(new URL("../../../supabase/functions/enqueue-lead-mission/index.ts", import.meta.url));
  assert(eq.includes("isServiceRoleBearer(token"));
  assertFalse(/token !== SERVICE_KEY/.test(eq));
});

Deno.test("inside the V2 worker the queue owns continuation — no HTTP self-dispatch", () => {
  const ra = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(ra.includes('const queueOwnsContinuation = inProcess.continuationOwner === "v2_queue";'));
  // …and when this slice was superseded (its verdict fenced): see sourceOrder.test.ts.
  assert(/!singleGeneration && !queueOwnsContinuation && !sliceSuperseded\) \{\s*dispatchOutcome = await dispatchContinuation/.test(ra),
    "the HTTP dispatch is skipped when the queue owns continuation");
  assert(ra.includes("(dispatchOutcome?.dispatched === true || queueOwnsContinuation)"),
    "and the lineage still reads as continuing");
  const runner = Deno.readTextFileSync(new URL("../../../worker/leadMissionRunner.ts", import.meta.url));
  assert(runner.includes('continuationOwner: "v2_queue"'));
});

// ═══ TERMINAL STATE ════════════════════════════════════════════════════════

/** Run 4250f181's final rows, verbatim in shape. */
const AUDITED: TerminalRows = {
  task: { status: "ready", result: { terminal_status: "continuation_required", auto_continuation: { continuing: false } } },
  lineage: { status: "active" },
  plan: { status: "partial" },
};

Deno.test("the attempt ceiling matches the queue SQL", () => {
  const sql = Deno.readTextFileSync(new URL(
    "../../../supabase/migrations-held/20260910140000_lead_mission_v2_claim.sql", import.meta.url));
  assert(sql.includes(`q.attempts < ${V2_MAX_ATTEMPTS}`));
  assert(sql.includes(`v_q.attempts >= ${V2_MAX_ATTEMPTS}`));
});

Deno.test("the worker states the final status itself on the last attempt", () => {
  const resumable = { status: "continuation_required", terminal: false };
  assertEquals(finalQueueStatus(resumable, 4), "resumable");
  assertEquals(finalQueueStatus(resumable, V2_MAX_ATTEMPTS), "failed");
  // A CLEAN last attempt that still asked to continue spent its allowance on
  // work, not on failures; only an errored or aborted one is a retry failure.
  assertEquals(terminalReasonFor(resumable, V2_MAX_ATTEMPTS), CONTINUATION_ATTEMPTS_EXHAUSTED);
  assertEquals(terminalReasonFor({ ...resumable, error: "timeout" }, V2_MAX_ATTEMPTS), RETRY_BUDGET_EXHAUSTED);
  assertEquals(finalQueueStatus({ status: "quota_met", terminal: true }, 1), "complete");
  assertEquals(finalQueueStatus({ status: "failed:provider_failure", terminal: true }, 2), "failed");
});

Deno.test("terminal FAILURE: the audited rows are reconciled to one answer", () => {
  assertEquals(terminalViolations("failed", AUDITED).length >= 3, true, "the audited state is invalid");
  const patch = planTerminalReconciliation("failed", RETRY_BUDGET_EXHAUSTED, AUDITED, "2026-09-14T00:00:00Z");
  assertEquals(patch.task!.status, "failed");
  assertEquals(patch.task!.result.terminal_status, RETRY_BUDGET_EXHAUSTED,
    "no longer continuation_required — the UI cannot offer Continue");
  assertEquals((patch.task!.result.auto_continuation as { continuing: boolean }).continuing, false);
  assertEquals(patch.lineage, { status: "terminal", terminal_reason: RETRY_BUDGET_EXHAUSTED });
  assertEquals(patch.plan!.status, "failed");
  assertEquals(terminalViolations("failed", applyTerminalPatch(AUDITED, patch)), []);
});

Deno.test("terminal SUCCESS: a quota-met mission leaves nothing live", () => {
  const rows: TerminalRows = {
    task: { status: "completed", result: { terminal_status: "quota_met" } },
    lineage: { status: "active" },
    plan: { status: "executing" },
  };
  const patch = planTerminalReconciliation("complete", "quota_met", rows, "2026-09-14T00:00:00Z");
  assertEquals(patch.task, undefined, "a finished task is left alone");
  assertEquals(patch.lineage!.status, "terminal");
  assertEquals(patch.plan!.status, "complete");
  assertEquals(terminalViolations("complete", applyTerminalPatch(rows, patch)), []);
});

Deno.test("a failed task that already says why keeps its own reason; consistent rows write nothing", () => {
  const rows: TerminalRows = {
    task: { status: "failed", result: { terminal_status: "provider_failure" } },
    lineage: { status: "active" }, plan: { status: "partial" },
  };
  const patch = planTerminalReconciliation("failed", "failed:provider_failure", rows, "t");
  assertEquals(patch.task, undefined);
  assertEquals(patch.plan!.status, "failed");
  const done = applyTerminalPatch(rows, patch);
  assertEquals(planTerminalReconciliation("failed", "x", done, "t"), { violations: [] }, "idempotent");
});

Deno.test("a cancelled mission cancels its lineage", () => {
  const patch = planTerminalReconciliation("cancelled", "cancelled", AUDITED, "t");
  assertEquals(patch.lineage!.status, "cancelled");
  assertEquals(patch.task!.status, "failed");
  assertEquals(patch.plan!.status, "failed");
});

Deno.test("the worker reconciles on every terminal release", () => {
  const main = Deno.readTextFileSync(new URL("../../../worker/main.ts", import.meta.url));
  // The stated status moved into `releaseQueuedMission` (20261003120000) so a
  // test can drive it against real SQL; the worker calls it.
  assert(main.includes("await releaseQueuedMission("));
  const terminal = Deno.readTextFileSync(new URL("../../../supabase/functions/_shared/leadMissionTerminal.ts", import.meta.url));
  assert(terminal.includes("const stated = finalQueueStatus(r.outcome, r.attempts);"));
  assert(main.includes("if (isTerminalQueueStatus(finalStatus))"));
  assert(main.includes("await reconcileTerminal(finalStatus"));
});
