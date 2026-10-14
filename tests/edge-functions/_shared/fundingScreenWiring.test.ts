// The funding screen's run-agent wiring (Codex PR #74, G5): the screen resumes
// its own owed reads, every call asks the slice's stop gate first, and an
// awaited screen read holds the lineage — bounded — as any pending run does.
// Source pins: run-agent cannot be imported without its environment.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
const screen = SRC.slice(SRC.indexOf("screen: async (targets, state, pending) => {"), SRC.indexOf("screen: async (targets, state, pending) => {") + 2000);

Deno.test("funding screen wiring: the engine's owed reads are passed in, and the owed ones handed back", () => {
  assert(screen.length > 100, "run-agent no longer builds the funding screen the way this pin expects");
  assert(/\{ mission_id: String\(task\.id\), pending \}\)/.test(screen), "the screen resumes `funding_screen.pending`");
  assert(screen.includes("return { findings: r.findings, pending: r.pending };"), "and returns what is still owed");
  assert(!/pending: \[\] \}\)\)\.findings/.test(SRC), "the old wiring dropped every pending read");
});

Deno.test("funding screen wiring: deadline, cancellation and a lost lease stop a screen purchase or adoption", () => {
  assert(screen.includes("verificationStopGate(terminalGuard.deadline)"));
  assert(/const stop = gate\.check\(\);\s*return stop\s*\? Promise\.resolve\(\{ status: "deferred"/.test(screen));
});

Deno.test("funding screen wiring: an awaited screen read holds the lineage, bounded like every pending run", () => {
  const i = SRC.indexOf("pendingRuns: awaitedPendingRuns(");
  const expr = SRC.slice(i, i + 900);
  assert(expr.includes("awaitedPendingRuns(capabilityRun?.state.funding_screen?.pending"), "the screen's run is counted");
  assert(expr.includes("awaitedPendingRuns(capabilityRun?.state.verifier_pending_runs"), "verifier runs are bounded too");
  assert(expr.includes("funding_screen.waits ?? 0) > 0"), "a stop-deferred screen is still owed");
});
