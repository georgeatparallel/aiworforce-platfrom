// THE EXACT CRASH, END TO END.
//
//   provider started → worker dies → durable checkpoint + run id survive
//   → later claim → same run adopted → working set restored → workflow continues
//
// Every stage below is a real defect this system shipped:
//
//   83d544a5  first slice POSTed a job search, killed mid-poll, wrote NO
//             checkpoint. `claim_sourcing_continuation` refused it —
//             correctly — and 44 paid job rows were stranded for ever.
//   8f59170d  a checkpoint written from `state` alone claimed discovery,
//             identity and enrichment complete while holding ZERO companies.
//             The resume skipped discovery, found nobody to investigate, and
//             burned all ten continuations on four-second barren slices.
//   528c2266  the same divergence from the other side: 100 `company_keys` on
//             the state, 0 companies in the checkpoint, an 83-company frontier
//             destroyed.
//
// Every Actor is a mock. ZERO network, ZERO Actor runs, ZERO model calls.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseLeadMissionDeterministic, type LeadMissionV1,
} from "../../../supabase/functions/_shared/leadMission.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import {
  runCapabilityPlan, checkpointSnapshot,
  type CapabilityEngineDeps, type CheckpointSnapshot,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import type { CompiledActorCall } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { stubMissionEvaluator } from "./missionEvaluatorFixture.ts";
import { stubDiscoverySelector } from "./discoverySelectorFixture.ts";

/**
 * The LinkedIn company search, asked the way the live run asks it.
 *
 * The default stub selects the YC scraper, which `validateDiscoveryStrategy`
 * correctly refuses for a mission that does not target the YC cohort — so this
 * test must name its own source, exactly as production does.
 */
const linkedinDiscovery = () => stubDiscoverySelector([{
  actor_key: "apify_linkedin_company_search",
  role: "primary",
  input: { industryIds: ["4"], companySize: ["11-50"], scraperMode: "full" },
  rationale: "the live general-company discovery source",
}]);
import { recoverPendingRuns } from "../../../supabase/functions/_shared/pendingRunRecovery.ts";
import {
  eligibleForAutoResume, type StalledTaskRow,
} from "../../../supabase/functions/_shared/stalledLeadResume.ts";
import { decideAutoContinuation } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

// THE LIVE REQUEST. General company discovery via LinkedIn, which answers no
// hiring question — so `hiring_verification` must make the paid call, which is
// the call that goes pending and strands a run. A YC mission cannot reproduce
// this: memo23 returns `openJobs`, the free assessment settles the question,
// and no paid search is ever issued.
const CANONICAL =
  "Find 3 companies matching my ICP that are actively hiring sales roles.";
const mission = (): LeadMissionV1 => parseLeadMissionDeterministic(CANONICAL);
const BRAIN = {
  employee_min: 10, employee_max: 150,
  positive_industries: ["b2b saas"], excluded_industries: [] as string[],
  required_geography: null,
};
/** One linkedin-company-search row — discovery AND identity. */
const SEARCH_ROW = {
  id: "sortly", name: "Sortly",
  linkedinUrl: "https://www.linkedin.com/company/sortly",
  website: "https://sortly.com",
  description: "Sortly is a B2B SaaS platform sold on subscription.",
  location: { linkedinText: "San Francisco, CA" },
  employeeCount: 42, pageType: "COMPANY",
  employeeCountRange: { start: 11, end: 50 },
};
/** Its enrichment row. 42 employees — inside the Brain's 10-150. */
const ENRICH_ROW = {
  id: "sortly", name: "Sortly",
  linkedinUrl: "https://www.linkedin.com/company/sortly",
  website: "https://sortly.com", employeeCount: 42,
  description: "Sortly is a B2B SaaS platform sold on subscription.",
  industries: [{ id: "4", name: "B2B SaaS", hierarchy: "Technology" }],
  locations: [{ linkedinText: "United States" }],
};
const RUN = { run_id: "IVEeRct6RMDMq5PbJ", dataset_id: "VCax2NgkEJct0fjkx", cost_units: 1 };
class PendingError extends Error {}

const base = (over: Partial<CapabilityEngineDeps> = {}): CapabilityEngineDeps => ({
  invoke: () => Promise.resolve([]),
  verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
  evaluateMission: stubMissionEvaluator(),
  ...over,
});

/**
 * SLICE ONE. Discovery succeeds; the hiring search is POSTed and never returns.
 * The isolate is torn down, so only what was written mid-flight survives.
 */
async function sliceOneCrashes(): Promise<{
  checkpoints: CheckpointSnapshot[];
  ledgerRow: Record<string, unknown>;
}> {
  const checkpoints: CheckpointSnapshot[] = [];
  const m = mission();
  await runCapabilityPlan({
    planDiscovery: linkedinDiscovery(),
    ...base({
      invoke: (c: CompiledActorCall<unknown>) => {
        if (c.actorKey === "apify_linkedin_company_search") return Promise.resolve([SEARCH_ROW]);
        if (c.actorKey === "apify_linkedin_company_details") return Promise.resolve([ENRICH_ROW]);
        if (c.actorKey === "apify_linkedin_job_search") {
          return Promise.reject(new PendingError("run started"));
        }
        return Promise.resolve([]);
      },
      readPendingRun: (e) => e instanceof PendingError ? RUN : null,
      // The durable write. Only coherent snapshots are kept, exactly as
      // run-agent persists only coherent ones.
      onCheckpoint: (snap) => { if (snap.coherent) checkpoints.push(structuredClone(snap)); },
    }),
  }, { mission: m, plan: buildCapabilityGraph(m), brain: BRAIN });

  return {
    checkpoints,
    // Persist-on-start: the run id reached the ledger the instant it existed.
    ledgerRow: {
      capability: "apify_linkedin_job_search", provider_id: "apify",
      provider_run_id: RUN.run_id, dataset_id: RUN.dataset_id, status: "started",
      request_input: { input: { company: ["https://www.linkedin.com/company/sortly"] } },
      started_at: "2026-08-26T18:03:04.934Z",
    },
  };
}

// ══ 1. THE CHECKPOINT SURVIVES, AND IT IS TRUE ═════════════════════════════

Deno.test("1. a crash leaves a durable checkpoint carrying the working set", async () => {
  const { checkpoints } = await sliceOneCrashes();
  assert(checkpoints.length > 0, "the crash must leave something behind");
  const last = checkpoints[checkpoints.length - 1];

  // THE INVARIANT. Never claim a capability is complete without its data.
  assert(last.state.completed_capabilities.length > 0, "work was done");
  assert(last.resume_records.length > 0, "and the companies it produced are here");
  assertEquals(
    last.state.company_keys, last.resume_records.map((r) => r.company_key),
    "the keys are a PROJECTION of the working set, never carried separately",
  );
});

Deno.test("2. an incoherent checkpoint is REFUSED, not written", async () => {
  // Run 8f59170d's exact shape: capabilities complete, working set empty.
  const { checkpoints } = await sliceOneCrashes();
  const real = checkpoints[checkpoints.length - 1];
  const lying = checkpointSnapshot(
    { ...real.state, completed_capabilities: ["general_company_discovery"] }, []);
  assertEquals(lying.coherent, false);
  assert(/empty working set/.test(lying.incoherence ?? ""), lying.incoherence ?? "");
  assertEquals(lying.resume_records, []);
});

Deno.test("3. a capability that may legitimately yield nothing is still coherent", async () => {
  // Qualification and persistence can complete having produced nobody — a pool
  // where nobody qualifies is a real answer, not a broken checkpoint.
  const { checkpoints } = await sliceOneCrashes();
  const s = checkpoints[checkpoints.length - 1].state;
  const ok = checkpointSnapshot(
    { ...s, completed_capabilities: ["company_brain_qualification", "persistence"] }, []);
  assertEquals(ok.coherent, true, ok.incoherence ?? "");
});

// ══ 2. THE RUN ID SURVIVES, AND THE TASK IS CLAIMABLE ══════════════════════

Deno.test("4. the run id survives in the ledger and rebuilds a pending run", async () => {
  const { ledgerRow } = await sliceOneCrashes();
  const [r] = recoverPendingRuns([ledgerRow]);
  assert(r, "persist-on-start must make the run recoverable");
  assertEquals(r.run_id, RUN.run_id);
  assertEquals(r.recovered_from_ledger, true);
});

Deno.test("5. the surviving row is claimable by the sweeper", async () => {
  const { checkpoints } = await sliceOneCrashes();
  const snap = checkpoints[checkpoints.length - 1];
  const NOW = Date.parse("2026-08-26T18:20:00.000Z");
  const row: StalledTaskRow = {
    id: "8f59170d", workspace_id: "ws-1", user_id: "user-1", plan_id: "p",
    agent_slug: "scout", step_index: 0, status: "ready",
    updated_at: new Date(NOW - 10 * 60_000).toISOString(),
    created_at: new Date(NOW - 20 * 60_000).toISOString(),
    continuation_claim_expires_at: null,
    result: {
      terminal_status: "continuation_required",
      company_first_state: { next_action: "start_round" },
      lead_mission: { original_user_query: CANONICAL },
      capability_execution_state: snap.state,
    },
  };
  const v = eligibleForAutoResume(row, NOW, { hasStartedProviderRun: true });
  assertEquals(v.eligible, true, JSON.stringify(v));
  assertEquals(v.evidence, "pending_provider_run");
});

// ══ 3. THE RESUME ADOPTS THE SAME RUN AND CONTINUES ════════════════════════

Deno.test("6. the resumed slice adopts the SAME run and restores the pool", async () => {
  const { checkpoints } = await sliceOneCrashes();
  const prior = checkpoints[checkpoints.length - 1];
  assert(prior.resume_records.length > 0);

  const resumeIds: Array<string | undefined> = [];
  const adopted: string[] = [];
  const posted: string[] = [];
  const m = mission();
  const run = await runCapabilityPlan({
    planDiscovery: linkedinDiscovery(),
    ...base({
      invoke: (c: CompiledActorCall<unknown>) => {
        const id = (c as unknown as { resumeRunId?: string }).resumeRunId;
        resumeIds.push(id);
        if (!id) posted.push(c.actorKey);
        if (c.actorKey === "apify_linkedin_company_search") return Promise.resolve([SEARCH_ROW]);
        if (c.actorKey === "apify_linkedin_company_details") return Promise.resolve([ENRICH_ROW]);
        if (c.actorKey === "apify_linkedin_job_search") {
          return Promise.resolve([{
            id: "j1", title: "Revenue Operations Manager",
            company: { name: "Sortly", linkedinUrl: "https://www.linkedin.com/company/sortly" },
            postedDate: "2026-08-20",
          }]);
        }
        return Promise.resolve([]);
      },
      readPendingRun: () => null,
      onRunAdopted: (i) => { adopted.push(i.run_id); },
    }),
  }, {
    mission: m, plan: buildCapabilityGraph(m), brain: BRAIN,
    state: prior.state,
    resume: {
      workspace_id: "ws-1", lineage_root_task_id: "root",
      records: prior.resume_records,
    },
  });

  // THE SAME RUN, ADOPTED — not a second POST.
  assert(resumeIds.includes(RUN.run_id), "the pending run must be adopted by id");
  assertEquals(adopted, [RUN.run_id], "and reported so its ledger row can settle");
  assertEquals(
    posted.includes("apify_linkedin_job_search"), false,
    "no second POST for work already paid for",
  );

  // THE WORKING SET CAME BACK.
  assert(run.companies.length > 0, "the resumed slice must hold the restored pool");
  assertEquals(
    run.state.company_keys, run.companies.map((c) => c.key),
    "and its keys still project from it",
  );

  // AND IT COST NOTHING NEW.
  //
  // The carried state still holds slice one's `pending` attempt, which DID
  // cost a unit — the POST was real spend. What must be free is everything
  // this slice added: the adoption and the `ok` it records for the same call.
  const added = run.state.provider_attempts
    .filter((a) => a.provider === "apify_linkedin_job_search")
    .filter((a) => a.outcome === "run_adopted" || a.outcome === "ok");
  assert(added.some((a) => a.outcome === "run_adopted"), "the adoption is recorded");
  assertEquals(
    added.reduce((n, a) => n + a.cost_units, 0), 0,
    "adopting a paid run is a re-read, not a purchase",
  );
  assertEquals(
    run.state.accumulated_cost_units, prior.state.accumulated_cost_units,
    "the lineage total must not move for a run it had already paid for",
  );
});

Deno.test("7. discovery is NOT re-bought on the resume", async () => {
  const { checkpoints } = await sliceOneCrashes();
  const prior = checkpoints[checkpoints.length - 1];
  const posted: string[] = [];
  const m = mission();
  await runCapabilityPlan({
    planDiscovery: linkedinDiscovery(),
    ...base({
      invoke: (c: CompiledActorCall<unknown>) => {
        if (!(c as unknown as { resumeRunId?: string }).resumeRunId) posted.push(c.actorKey);
        return Promise.resolve([]);
      },
      readPendingRun: () => null,
    }),
  }, {
    mission: m, plan: buildCapabilityGraph(m), brain: BRAIN,
    state: prior.state,
    resume: { workspace_id: "ws-1", lineage_root_task_id: "root", records: prior.resume_records },
  });
  assertEquals(
    posted.includes("apify_linkedin_company_search"), false,
    "a completed discovery carried with its companies must not be paid for twice",
  );
});

// ══ 4. WAITING IS NOT SPINNING ═════════════════════════════════════════════

Deno.test("8. a run awaiting a provider defers to the sweeper", async () => {
  // Run 8f59170d: ten four-second slices in ~40s, stopped by
  // `continuation_ceiling` with the provider run still executing.
  const d = decideAutoContinuation({
    qualified: 0, requestedCount: 3, frontierRemaining: 5,
    continuationsUsed: 1, maxContinuations: 10,
    costUnitsUsed: 2, maxCostUnits: 120,
    barrenSlices: 2, pendingRuns: 1,
  });
  assertEquals(d.continue, true);
  assertEquals(d.reason, "awaiting_provider_run");
  assertEquals(d.dispatch_mode, "deferred", "waiting is not work; the tick is the backoff");
});

Deno.test("9. a run with candidates to investigate still dispatches immediately", async () => {
  const d = decideAutoContinuation({
    qualified: 0, requestedCount: 3, frontierRemaining: 5,
    continuationsUsed: 1, maxContinuations: 10,
    costUnitsUsed: 2, maxCostUnits: 120, barrenSlices: 0,
  });
  assertEquals(d.reason, "quota_unmet_frontier_remains");
  assertEquals(d.dispatch_mode, "immediate", "the user is watching; get on with it");
});

Deno.test("10. run-agent honours the deferral", async () => {
  const SRC = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url),
  );
  assert(SRC.includes('autoDecision.dispatch_mode === "deferred"'));
  // ASSERTS THE INTENT, NOT THE WHOLE CONDITION. The guard gained a second term
  // (`!singleGeneration`, the acceptance-run flag that defaults off); pinning the
  // literal made this fail on a change that cannot affect what it protects.
  // What must hold is that `deferToSweeper` still gates the dispatch.
  assert(/if \(autoDecision\.continue && !deferToSweeper(?: && !\w+)*\) \{/.test(SRC),
    "a deferred decision must not self-dispatch");
});

Deno.test("11. run-agent refuses to persist an incoherent checkpoint", async () => {
  const SRC = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url),
  );
  const i = SRC.indexOf("onCheckpoint: async (snap) => {");
  assert(i > 0, "the checkpoint writer must be wired");
  // ANCHORED ON THE WRITE, NOT ON A BYTE DISTANCE: the block runs to the row
  // status the checkpoint write ends with. A fixed 3600-character window broke
  // on the first line added to the write (`continuation_owner`, 2026-09-28).
  const end = SRC.indexOf('status: projectStatus("continuation_required").rowStatus', i);
  assert(end > i, "the checkpoint write must set the row status");
  const block = SRC.slice(i, end);
  assert(block.includes("if (!snap.coherent)"), "refuse rather than write a lie");
  assert(block.includes("[CHECKPOINT_RESULT_KEY]: buildCheckpoint({"),
    "the working set must be persisted, not just the state");
  assert(block.includes("companies: snap.resume_records"));
  assert(block.includes("capability_execution_state: snap.state"));
});
