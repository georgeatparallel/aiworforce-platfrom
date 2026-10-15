// LEAD V2 — THE STOP REACHES VERIFICATION: WORKER → DEADLINE → GATE → CALLS.
//
//   worker heartbeat reason → AbortSignal.reason → `worker:<reason>` revocation
//   → run-agent's verification gate (the run's own deadline)
//   → the phase, every verifier call, the page runner, the Apify wait
//
// Pinned here because run-agent cannot be imported into a test with its
// network and database: the shape below is what makes the unit tests in
// verificationStop*.test.ts describe production. Plus the two pieces that run
// for real: the worker's reason hand-off, and `runTool`'s Apify wait.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createLeadMissionRunner } from "../../../worker/leadMissionRunner.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import {
  type ClaimedMission, DEFAULT_WORKER_CONFIG, type MissionRunControl, runClaimedMission,
} from "../../../supabase/functions/_shared/leadMissionWorkerCore.ts";
import type { RevocableDeadline } from "../../../supabase/functions/_shared/revocableDeadline.ts";
import { verificationStopGate } from "../../../supabase/functions/_shared/verificationStop.ts";
import { runTool } from "../../../supabase/functions/_shared/toolRegistry.ts";
import { hashInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";

const src = (p: string) => Deno.readTextFileSync(new URL(`../../../${p}`, import.meta.url));
const RUN_AGENT = src("supabase/functions/run-agent/index.ts");
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert(a >= 0, `missing: ${from}`);
  const b = s.indexOf(to, a);
  assert(b > a, `missing after it: ${to}`);
  return s.slice(a, b);
};

// ══════════════════════════════════════════════════════════════ run-agent ════

Deno.test("WIRING: one gate per verification phase, over the run's own (revocable) deadline", () => {
  const block = between(RUN_AGENT, "// ── CLAIM VERIFIERS: CANONICAL GAPS → VERIFIER → PURCHASE", "const phase = await runClaimVerificationPhase({");
  assert(block.includes("const verificationGate = verificationStopGate(terminalGuard.deadline);"));
  // terminalGuard.deadline IS the worker's revocable deadline when one is passed.
  assert(RUN_AGENT.includes("...(inProcess.deadline ? { deadline: inProcess.deadline } : {}),"));
});

Deno.test("WIRING: the phase, the page runner and the map memory all receive it", () => {
  const phase = between(RUN_AGENT, "const phase = await runClaimVerificationPhase({", "markPhase(\"claim_verification\"");
  assert(phase.includes("stop: verificationGate,"), "the phase asks before every verifier and every call");
  const pages = between(RUN_AGENT, "const debts = claimPageDebts(targets);", "readCache: async (domain: string) => {");
  assert(pages.includes("stop: (op) => verificationGate.check(op ?? null),"), "every map, page and model call asks");
  assert(pages.includes("mapMemory: recordMapMemory(engineRun.state.web_evidence_map_selections ??= {}),"));
});

Deno.test("WIRING: the Apify wait stops only while the verification phase runs — engine and funding screen untouched", () => {
  assert(RUN_AGENT.includes("stopWaiting: () => verificationWaitStop?.() ?? false,"), "baseCtx carries the hook");
  const armed = RUN_AGENT.indexOf("verificationWaitStop = () => verificationGate.check() !== null;");
  const phase = RUN_AGENT.indexOf("const phase = await runClaimVerificationPhase({");
  const disarmed = RUN_AGENT.indexOf("verificationWaitStop = null;", phase);
  assert(armed > 0 && armed < phase && disarmed > phase, "armed immediately before the phase, disarmed right after");
  assert(between(RUN_AGENT, "console.error(\"[run-agent][claim-verifier][failed]\"", "// ── THE SAME RESULT, ALSO INTO THE CANONICAL LEAD LIBRARY")
    .includes("} finally {\n                verificationWaitStop = null;"), "and disarmed if the phase throws");
  // The funding screen (inside the engine) keeps its own verifier deps and never
  // arms this WAIT hook; it asks its own stop gate before each call instead
  // (fundingScreenWiring.test.ts).
  assert(RUN_AGENT.includes("const call = await verifierCallFor(state);"));
  // Nothing else assigns the hook.
  assertEquals(RUN_AGENT.split("verificationWaitStop = ").length - 1, 3);
});

Deno.test("WIRING: a cut-short phase reaches the continuation fold, and a deferred step is never a run in flight", () => {
  assert(RUN_AGENT.includes("verificationStoppedBy = phase.stopped_by ?? null;"));
  const fold = between(RUN_AGENT, "const progress = foldSlice(priorProgress, {", "const autoDecision = decideAutoContinuation({");
  assert(fold.includes("deferredByStop: verificationStoppedBy !== null,"));
  // Runs in flight and deferred steps are stored apart, so the in-flight count
  // (pinned in autoContinuation.test.ts) only ever counts real provider runs…
  assert(RUN_AGENT.includes("vState.verifier_pending_runs = phase.pending;"));
  assert(RUN_AGENT.includes("vState.verifier_deferred_steps = phase.deferred_steps ?? [];"));
  // …and both are handed back to the next slice's phase.
  assert(RUN_AGENT.includes("pending: [...(vState.verifier_pending_runs ?? []), ...(vState.verifier_deferred_steps ?? [])],"));
});

// ═════════════════════════════════════════════════════════════════ worker ════

Deno.test("WORKER: the heartbeat's reason travels on the abort signal", async () => {
  const mission: ClaimedMission = {
    queueId: "q1", workspaceId: "ws", request: {}, taskId: null, lineageId: null, attempts: 1, isResume: false, heldUntil: null,
  };
  let seen: unknown = null;
  await runClaimedMission({
    workerId: "w", config: DEFAULT_WORKER_CONFIG,
    claim: () => Promise.resolve({ claimed: false, reason: "empty" } as never),
    heartbeatFor: () => ({ start: (onLost) => onLost("mission_cancelled"), stop: () => {} }),
    runMission: (_m, ctl: MissionRunControl) => { seen = ctl.signal.reason; return Promise.resolve({ status: "cancelled", terminal: true }); },
    release: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  }, mission);
  assertEquals(seen, "mission_cancelled");
});

for (const [reason, expected] of [["mission_cancelled", "cancelled"], ["ownership_lost", "lease_lost"]] as const) {
  Deno.test(`WORKER: an abort for ${reason} revokes the run's deadline as worker:${reason} → the gate says ${expected}`, async () => {
    const ac = new AbortController();
    let deadline: RevocableDeadline | null = null;
    const runner = createLeadMissionRunner({
      serviceRoleKey: "k", functionsBaseUrl: "https://fake.test/functions/v1/",
      createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs }),
      bind: () => Promise.resolve(true),
      readTaskOutcome: () => Promise.resolve({ status: "ready", terminal_status: "continuation_required" }),
      handler: (_req, opts) => {
        deadline = opts.deadline as RevocableDeadline;
        ac.abort(reason); // the heartbeat reports it mid-run
        return Promise.resolve(new Response(JSON.stringify({ task_id: "t1" }), { status: 200 }));
      },
    });
    await runner.run({
      queueId: "q1", workspaceId: "ws", request: { plan_id: "p", tool_input: {} }, taskId: null, lineageId: null,
      attempts: 1, isResume: false, heldUntil: null,
    }, { executionBudgetMs: 300_000, signal: ac.signal });
    assertEquals(deadline!.revokedReason, `worker:${reason}`);
    assertEquals(verificationStopGate(deadline!).check()?.reason, expected);
  });
}

// ═══════════════════════════════════════════════════ the Apify wait (runTool) ══

Deno.env.set("LEAD_CREDIT_ENFORCEMENT", "observe");
Deno.env.set("MODEL_SPEND_ENFORCEMENT", "observe");
Deno.env.set("APIFY_API_TOKEN", "test-token-not-a-real-credential");

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
const envelope = {
  selected_actor_key: "apify_yc_companies_memo23", actor_id: "memo23/y-combinator-scraper", compiled_actor_input: true,
  capability_key: "apify_yc_companies_memo23", input: YC_INPUT, compiled_input_hash: hashInput(YC_INPUT, "apify_yc_companies_memo23"),
};

/** Apify answers: the run started, and is still RUNNING on every poll. */
function apifyRunning() {
  const seen: Array<{ method: string; url: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ method: String(init?.method ?? "GET"), url });
    const run = { data: { id: "RUN-STILL-GOING", defaultDatasetId: "DS1", status: "RUNNING" } };
    return Promise.resolve(new Response(JSON.stringify(url.includes("/runs") || url.includes("/actor-runs/") ? run : []),
      { status: url.includes("/runs") && init?.method === "POST" ? 201 : 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof globalThis.fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

Deno.test("APIFY: once the slice must stop, a started run stops being WAITED on — it comes back pending, its id recorded first", async () => {
  const net = apifyRunning();
  try {
    const r = await runTool("source_with_apify", envelope, {
      workspace_id: "00000000-0000-0000-0000-000000000001", agent_slug: "scout", agent_id: null,
      admin: { from: () => noopQuery() },
      stopWaiting: () => true,
    } as never);
    assertFalse(r.ok);
    const data = r.data as { run_id?: string; pending?: boolean; resumable?: boolean };
    assertEquals([data.run_id, data.pending, data.resumable], ["RUN-STILL-GOING", true, true], "adoptable next slice");
    // The run id is persisted by runTool's own ledger writer the moment the run
    // exists — before the wait this test skips — which is what adoption reads.
    const registry = src("supabase/functions/_shared/toolRegistry.ts");
    assert(registry.indexOf("await ctx?.onRunStarted?.({ run_id") < registry.indexOf("if (ctx?.stopWaiting?.())"),
      "recorded before the first stop-waiting check");
    assert(registry.includes("r = await tool.execute(input, {\n        ...ctx,"), "runTool passes the caller's context (and its hook) through");
    assertEquals(net.seen.filter((x) => x.method === "POST").length, 1, "started once");
    assertEquals(net.seen.filter((x) => x.url.includes("/actor-runs/")).length, 0, "not polled: no 90-second wait");
    // The run itself is never aborted.
    assertFalse(net.seen.some((x) => x.url.includes("/abort")));
  } finally {
    net.restore();
  }
});
