// A RUN THAT STARTED IS NOT A FAILURE.
//
// TEST task 80501967-8267-4e2d-a99a-1b7db0ad46e7 sent a byte-correct memo23
// payload, Apify accepted it, and run rWikfnKgnp5DazDYr reached RUNNING. The 90s
// poll window then closed, the invoker threw a bare string, and the run was
// recorded as `outcome: "error", cost_units: 0`. The run existed, was billed,
// produced dataset KmurtcXfCOhGcBmH4 — and nothing ever read it.
//
// Worse, the SolidCode fallback then failed to compile for want of team-size
// bands, and that made the whole capability report
// `provider_input_validation_failed` — about a provider whose input had been
// perfectly valid.
//
// ZERO network, ZERO Actor runs, ZERO model calls, ZERO database writes.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import {
  runCapabilityPlan, type CapabilityEngineDeps,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import type { CompiledActorCall } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { stubDiscoverySelector } from "./discoverySelectorFixture.ts";

const CANONICAL =
  "Find founders of SaaS startups hiring Sales Operations in the United States. Return 5 qualified leads.";
const mission = () => parseLeadMissionDeterministic(CANONICAL);
const BRAIN = {
  employee_min: 10, employee_max: 150,
  positive_industries: ["b2b saas"], excluded_industries: [] as string[],
  required_geography: null,
};

/** The real identifiers from the abandoned run. */
const RUN_ID = "rWikfnKgnp5DazDYr";
const DATASET_ID = "KmurtcXfCOhGcBmH4";

/** An invoker error shaped exactly as run-agent's now throws it. */
function runningError() {
  const e = new Error("apify_run_running") as Error & { toolResult?: unknown };
  e.toolResult = {
    run_id: RUN_ID, dataset_id: DATASET_ID, status: "RUNNING",
    pending: true, resumable: true, build_id: "bLd123",
  };
  return e;
}

/** run-agent's own readPendingRun contract, mirrored. */
const readPendingRun: CapabilityEngineDeps["readPendingRun"] = (e) => {
  const d = (e as { toolResult?: Record<string, unknown> } | null)?.toolResult;
  if (!d || typeof d !== "object") return null;
  const runId = typeof d.run_id === "string" ? d.run_id : "";
  if (!runId || d.pending !== true) return null;
  return {
    run_id: runId,
    dataset_id: typeof d.dataset_id === "string" ? d.dataset_id : null,
    actor_build_id: typeof d.build_id === "string" ? d.build_id : null,
  };
};

const BANDS = ["2-10", "11-50", "51-200"];

// ══════════════════════════════════════ 1. RUNNING is pending, not error ══

Deno.test("1. a RUNNING Actor is persisted as pending, with its run and dataset", async () => {
  const m = mission();
  const run = await runCapabilityPlan({
      planDiscovery: stubDiscoverySelector(),
    invoke: () => Promise.reject(runningError()),
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan: buildCapabilityGraph(m), brain: BRAIN, solidcodeTeamSizes: BANDS });

  const attempt = run.state.provider_attempts.find((a) => a.provider === "apify_yc_companies_memo23");
  assert(attempt, "the attempt must be recorded");
  assertEquals(attempt!.outcome, "pending", "RUNNING must not be an error");

  assertEquals(run.state.pending_runs.length, 1);
  assertEquals(run.state.pending_runs[0].run_id, RUN_ID);
  assertEquals(run.state.pending_runs[0].dataset_id, DATASET_ID);
  assertEquals(run.state.pending_runs[0].actor_build_id, "bLd123");
  assertEquals(run.state.pending_runs[0].provider, "apify_yc_companies_memo23");

  assertEquals(run.state.terminal_reason, "provider_run_pending");
  // Explicitly NOT the misleading reason the failed task reported.
  assertFalse(run.state.terminal_reason === "provider_input_validation_failed");
});

Deno.test("2. the pending run's cost is recorded, not zeroed", async () => {
  const m = mission();
  const run = await runCapabilityPlan({
      planDiscovery: stubDiscoverySelector(),
    invoke: () => Promise.reject(runningError()),
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan: buildCapabilityGraph(m), brain: BRAIN, solidcodeTeamSizes: BANDS });

  const attempt = run.state.provider_attempts.find((a) => a.outcome === "pending");
  assert(attempt);
  assert(attempt!.cost_units > 0, "a started run is billed and must not cost 0");
  assert(run.state.accumulated_cost_units > 0,
    "the run existed and was charged; recording 0 understates real spend");
});

Deno.test("3. the capability stays pending and is never completed", async () => {
  const m = mission();
  const run = await runCapabilityPlan({
      planDiscovery: stubDiscoverySelector(),
    invoke: () => Promise.reject(runningError()),
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan: buildCapabilityGraph(m), brain: BRAIN, solidcodeTeamSizes: BANDS });

  assertFalse(run.state.completed_capabilities.includes("startup_company_discovery"),
    "no usable dataset row exists yet");
  assert(run.state.pending_capabilities.includes("startup_company_discovery"));
  const outcome = run.capability_outcomes.find((o) => o.capability === "startup_company_discovery");
  assertEquals(outcome?.status, "incomplete");
  assertEquals(outcome?.evidence_satisfied, false);
});

// ═══════════════════════════ 4. no fallback while the primary is pending ══

Deno.test("4. the fallback does NOT run while the primary run is pending", async () => {
  const m = mission();
  const calls: string[] = [];
  const run = await runCapabilityPlan({
      planDiscovery: stubDiscoverySelector(),
    invoke: (c: CompiledActorCall<unknown>) => {
      calls.push(c.actorKey);
      if (c.actorKey === "apify_yc_companies_memo23") return Promise.reject(runningError());
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan: buildCapabilityGraph(m), brain: BRAIN, solidcodeTeamSizes: BANDS });

  assertEquals(calls, ["apify_yc_companies_memo23"],
    "solidcode must not spend against a question already in flight");
  assertFalse(calls.includes("apify_yc_companies_solidcode"));
  assertEquals(run.state.pending_runs.length, 1);
});

// ══════════════════════════════════ 5/6. resume reuses the same run ══

Deno.test("5/6. resume adopts the same run id and starts no second Actor", async () => {
  const m = mission();
  const plan = buildCapabilityGraph(m);

  // First pass leaves the run pending.
  const first = await runCapabilityPlan({
      planDiscovery: stubDiscoverySelector(),
    invoke: () => Promise.reject(runningError()),
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan, brain: BRAIN, solidcodeTeamSizes: BANDS });
  assertEquals(first.state.pending_runs[0].run_id, RUN_ID);

  // Resume: the run has now finished, so the SAME run is read and its dataset consumed.
  const resumeIds: Array<string | undefined> = [];
  const starts: string[] = [];
  const second = await runCapabilityPlan({
      planDiscovery: stubDiscoverySelector(),
    invoke: (c: CompiledActorCall<unknown>) => {
      const rid = (c as { resumeRunId?: string }).resumeRunId;
      resumeIds.push(rid);
      if (!rid) starts.push(c.actorKey);
      if (c.actorKey === "apify_yc_companies_memo23") {
        return Promise.resolve([
          { id: "sortly", name: "Sortly", website: "https://sortly.com" },
          { id: "clay", name: "Clay", website: "https://clay.com" },
        ]);
      }
      return Promise.resolve([]);
    },
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan, brain: BRAIN, state: first.state, solidcodeTeamSizes: BANDS });

  assertEquals(resumeIds[0], RUN_ID, "the resume must adopt the existing run id");
  assertFalse(starts.includes("apify_yc_companies_memo23"),
    "no duplicate paid Actor start");
  // The completed dataset is consumed.
  assertEquals(second.state.company_keys.length, 2);
  assert(second.state.completed_capabilities.includes("startup_company_discovery"),
    "a resumed run with usable rows completes the capability");
});

// ═════════════════════ 7. an unconfigured fallback is not a schema error ══

Deno.test("7. SolidCode missing configuration does not fake a schema failure", async () => {
  const m = mission();
  const run = await runCapabilityPlan({
    // A fallback role is a STRATEGY choice, so the strategy states it. This
    // used to arrive via the production default, which is deleted.
    planDiscovery: stubDiscoverySelector([
      { actor_key: "apify_yc_companies_memo23", role: "primary", input: { mode: "companies" } },
      { actor_key: "apify_yc_companies_solidcode", role: "fallback", input: {} },
    ]),
    invoke: () => Promise.resolve([]),          // memo23 succeeds but returns nothing
    verifyEmployer: () => ({ verified: false, outcome: "no" }),
    readPendingRun,
  }, { mission: m, plan: buildCapabilityGraph(m), brain: BRAIN /* no bands */ });

  const sc = run.state.provider_attempts.find((a) => a.provider === "apify_yc_companies_solidcode");
  assert(sc, "the skip must still be recorded");
  assertEquals(sc!.outcome, "skipped_not_configured");
  assertFalse(sc!.outcome === "compile_failed");

  // And the capability must NOT claim memo23's input was invalid.
  assertFalse(run.state.terminal_reason === "provider_input_validation_failed",
    "memo23's input was valid; reporting a validation failure blames the wrong thing");
  const outcome = run.capability_outcomes.find((o) => o.capability === "startup_company_discovery");
  assertFalse((outcome?.reason ?? "").includes("provider_input_validation_failed"));
});

Deno.test("7b. run-agent configures the bands and forwards a resume id", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(src.includes('solidcodeTeamSizes: ["2-10", "11-50", "51-200"]'),
    "the fallback must be configured with VALID bands");
  assertFalse(src.includes('"1-10"'), "1-10 is not a SolidCode band");
  // ── RESUME AND FAILURE-EVIDENCE MOVED TO THE SHARED SEAM ────────────────
  //
  // Both were written out twice in run-agent. They are now built once, and a
  // monitoring caller inherits them rather than reimplementing them.
  const seam = await Deno.readTextFile(new URL("../../../supabase/functions/_shared/capabilityExecution.ts", import.meta.url));
  assert(seam.includes("resume_run_id: resumeRunId"),
    "an in-flight run id must reach runTool");
  assert(seam.includes("err.toolResult = rr.data"),
    "the failure payload must travel with the error so run_id survives");
});

Deno.test("7c. toolRegistry resumes instead of starting, and reports pending", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/_shared/toolRegistry.ts", import.meta.url));
  assert(src.includes("const resumeRunId ="), "resume must be an explicit branch");
  // The smoke's read plan may add `waitForFinish=…&` (a long-polled read).
  assert(/`\/actor-runs\/\$\{resumeRunId\}\?[^\n]*token=/.test(src),
    "a resume READS the run; it must not POST a new one");
  assert(src.includes('const pending = status === "RUNNING" || status === "READY";'),
    "RUNNING/READY must be classified as pending");
  assert(src.includes("build_id") && src.includes("build_number"),
    "the Actor build must be recorded for reproducibility");
});
