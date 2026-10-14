// LEAD V2 REPLAY LAB — ONE ENGINE SLICE, OFFLINE.
//
// Runs the production `runCapabilityPlan` (discovery, identity, enrichment,
// triage, qualification, persistence records) with:
//
//   provider calls  → FixtureProvider (strict; recorded answers only)
//   model calls     → the fixture's recorded model outputs (planner, discovery
//                     selector, mission evaluator) — deterministic
//
// Everything else is the engine as production runs it, including the P2 spec
// spine (`specMode: "enforce"`) that compiles every provider call and reserves
// it against the ledger before the provider is reached.

import { runCapabilityPlan, type EngineCompany } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import type { LeadMissionV1 } from "../../../supabase/functions/_shared/leadMission.ts";
import { PRODUCTION_READINESS, readinessPolicy, type ReadinessPolicy } from "../../../supabase/functions/_shared/routeReadiness.ts";
import { stubMissionEvaluator } from "../../edge-functions/_shared/missionEvaluatorFixture.ts";
import type { ReplayFixture } from "./fixture.ts";
import { FixtureProvider, noNetwork } from "./provider.ts";
import { readPendingRun } from "../../../supabase/functions/_shared/capabilityExecution.ts";

export interface EngineFixture extends ReplayFixture {
  /** A mission stored elsewhere in the repo (e.g. tests/fixtures/lead-v2/…), relative to the repo root. */
  mission_ref?: string;
  engine: {
    readiness: "production" | { probe_routes: string[] };
    max_candidates: number;
    remaining_leads?: number;
    model_responses: {
      plan_execution: { reasoning: string; steps: unknown[] };
      plan_discovery: unknown[];
      evaluate_mission?: { mission_fit: "pass" | "fail" | "review" };
    };
  };
}

export interface EngineSlice {
  companies: EngineCompany[];
  state: Record<string, unknown>;
  resume_records: unknown[];
  provider: FixtureProvider;
  mission: LeadMissionV1;
  readiness: ReadinessPolicy;
}

const ROOT = new URL("../../../", import.meta.url);

export function missionOf(fx: EngineFixture): LeadMissionV1 {
  if (fx.mission_ref) return JSON.parse(Deno.readTextFileSync(new URL(fx.mission_ref, ROOT))) as LeadMissionV1;
  return fx.mission as unknown as LeadMissionV1;
}

export function readinessOf(fx: EngineFixture): ReadinessPolicy {
  const r = fx.engine.readiness;
  return r === "production" ? PRODUCTION_READINESS : readinessPolicy({ mode: "provider_probe", probe_routes: r.probe_routes });
}

export async function replayEngineSlice(fx: EngineFixture, o: {
  resume?: { state: Record<string, unknown>; records: unknown[] };
  replenish?: Record<string, number>;
  /** Extra recorded-model dependencies for this slice (e.g. a later slice's discovery selector, route control). */
  deps?: Record<string, unknown>;
  /** Carried replenishment fields beyond pages (e.g. `page_fingerprints`), as run-agent reads them from the checkpoint. */
  replenishExtra?: Record<string, unknown>;
  /** The provider for this slice (a ledger-writing wrapper, unique run ids). Default: a fresh strict FixtureProvider. */
  provider?: FixtureProvider;
} = {}): Promise<EngineSlice> {
  noNetwork();
  const mission = missionOf(fx);
  const readiness = readinessOf(fx);
  const provider = o.provider ?? new FixtureProvider(fx.provider_responses);
  const m = fx.engine.model_responses;
  const lineage = `lineage-${fx.provenance.task_id}`;
  const result = await runCapabilityPlan({
    invoke: provider.invoke,
    // HOW A RUN STILL EXECUTING IS RECOGNISED — run-agent always passes the
    // production reader. Without it a `pending_once` row read as a provider
    // failure, and the engine moved past a run it should have been waiting on.
    readPendingRun,
    verifyEmployer: () => ({ verified: true, outcome: "ok" }),
    evaluateMission: stubMissionEvaluator({ mission_fit: m.evaluate_mission?.mission_fit ?? "pass" }),
    planExecution: () => Promise.resolve(structuredClone(m.plan_execution)),
    planDiscovery: () => Promise.resolve(structuredClone(m.plan_discovery)),
    ...(o.deps ?? {}),
  } as never, {
    mission, plan: buildCapabilityGraph(mission, { executability: "enforce", readiness }),
    maxCandidates: fx.engine.max_candidates, remainingLeads: fx.engine.remaining_leads ?? 1, readEnv: () => undefined,
    identity: { workspace_id: "<workspace>", task_id: fx.provenance.task_id },
    specMode: "enforce", specScope: { workspace_id: "<workspace>", lineage_id: lineage },
    readiness,
    ...(o.replenish ? {
      discoveryReplenishment: {
        reason: "replenishment_required", pages_taken: o.replenish, sources_attempted: Object.keys(o.replenish),
        ...(o.replenishExtra ?? {}),
      },
    } : {}),
    ...(o.resume ? {
      state: o.resume.state,
      resume: { workspace_id: "<workspace>", lineage_root_task_id: lineage, records: o.resume.records },
    } : {}),
  } as never);
  const run = result as unknown as { companies: EngineCompany[]; state: Record<string, unknown>; resume_records: unknown[] };
  return { ...run, provider, mission, readiness };
}
