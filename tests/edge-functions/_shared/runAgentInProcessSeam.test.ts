// THE IN-PROCESS SEAM ON run-agent — and proof it changes nothing for V1.
//
// The LeadMission V2 worker runs run-agent's own handler inside a long-lived Deno
// process instead of through the edge runtime. That needs exactly three things
// from run-agent, and each is inert unless an in-process caller supplies it:
//   1. the handler is exported and the server start is env-guarded (pilot-chat's
//      production pattern);
//   2. an optional deadline replaces the terminal guard's edge default;
//   3. an optional callback learns the task + lineage once the lease is taken.
//
// ZERO network, ZERO database, ZERO model calls.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set BEFORE import, exactly as tests/edge-functions/_helpers/pilotTurn.ts does,
// so `Deno.serve` never starts in the test process.
for (const [k, v] of Object.entries({
  RUN_AGENT_IMPORT_ONLY: "1",
  SUPABASE_URL: "https://fake.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
})) Deno.env.set(k, v);

const SRC = await Deno.readTextFile(
  new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url),
);
const { handleRunAgent } = await import("../../../supabase/functions/run-agent/index.ts");

Deno.test("the handler is exported and callable in-process", async () => {
  assertEquals(typeof handleRunAgent, "function");
  // OPTIONS returns before any client is built — proves the in-process call path
  // works without a server, a database or a network.
  const res = await handleRunAgent(
    new Request("https://fake.supabase.test/functions/v1/run-agent", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

Deno.test("the edge entry point starts only when not import-only, and passes the request ONLY", () => {
  assert(
    // The build stamp wraps the server (x-agentory-build); the handler still gets the request and nothing else.
    SRC.includes('if (!Deno.env.get("RUN_AGENT_IMPORT_ONLY")) Deno.serve(withBuildStamp((req) => handleRunAgent(req)));'),
    "the edge server must pass no in-process options, so V1 behaviour is unchanged",
  );
  // Exactly one server start.
  assertEquals(SRC.split("Deno.serve(").length - 1, 1);
});

Deno.test("the terminal guard receives a deadline ONLY when an in-process caller supplies one", () => {
  const guardCall = SRC.slice(SRC.indexOf("const terminalGuard = createRunTerminalGuard({"));
  const opts = guardCall.slice(0, guardCall.indexOf("const bindGuard"));
  assert(
    opts.includes("...(inProcess.deadline ? { deadline: inProcess.deadline } : {}),"),
    "absent deadline must leave the guard's own edge default in force",
  );
});

Deno.test("onExecutionBound fires after the lease gate + lineage link, before any engine, and cannot throw into the run", () => {
  const gate = SRC.indexOf("if (!leaseGate.proceed) {");
  const link = SRC.indexOf(".update({ lineage_id: lineageRootId }).eq(\"id\", task.id);");
  const call = SRC.indexOf("await inProcess.onExecutionBound({ taskId: task.id, lineageId: lineageRootId, holdsLease, generation: sliceFence.generation });");
  const engine = SRC.indexOf("await runCapabilityPlan({");
  const legacy = SRC.indexOf("executeCompanyFirstRoute({");
  assert(gate > 0 && link > 0 && call > 0 && engine > 0 && legacy > 0, "all landmarks must exist");
  assert(gate < call && link < call, "the callback must see only a lease this run actually holds");
  assert(call < engine && call < legacy, "and it must run before either engine can spend");
  // Wrapped: a failing callback costs the heartbeat target, never the run.
  const around = SRC.slice(call - 200, call);
  assert(around.includes("try {"), "the callback must be inside a try");
});
