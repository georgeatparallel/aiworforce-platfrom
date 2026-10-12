// LEAD V2 REPLAY LAB — QUERY B (a9a6791a) SLICE BY SLICE.
//
// The production lineage, replayed with its own recorded model outputs:
//
//   slice 1  page 1 → route control "deepen" (re-asks page 1: adopted, nothing
//            new) → route control "change_query" with FOUR titles (the actor
//            accepts three) → compile failure → stop_reason schema_failure
//   slice 2  replenishment: page 2 of the job search
//   slice 3  replenishment: page 3 — a row-for-row replay of page 2
//
// Everything between the recorded model outputs and the fixture provider is
// the production engine.

import { loadFixture } from "./fixture.ts";
import { type EngineFixture, type EngineSlice, replayEngineSlice } from "./engine.ts";

export type QueryBFixture = EngineFixture & {
  engine: EngineFixture["engine"] & {
    model_responses: EngineFixture["engine"]["model_responses"] & {
      plan_discovery_slice2: Array<{ actor_key: string; input: Record<string, unknown> }>;
      route_control_replan_4_titles: Record<string, unknown>;
    };
  };
  variants: { page_3_fresh: Record<string, unknown>[] };
};

export const JOB_SEARCH = "apify_linkedin_job_search";

export function queryBFixture(): QueryBFixture {
  return loadFixture("queryBa9a6791a.job-first") as QueryBFixture;
}

/** Production's two route-control answers, in order: deepen, then the four-title change_query. */
export function recordedRouteControl(fx: QueryBFixture) {
  let n = 0;
  return (i: { summary: { routes?: Array<{ route_id: string }>; low_yield_routes?: string[] } }) => {
    n++;
    const rid = i.summary.routes?.[0]?.route_id;
    if (n === 1) return Promise.resolve({ action: "deepen", route_id: rid, trigger: "insufficient_candidates", rationale: "replay a9a6791a wave 1" });
    return Promise.resolve({
      action: "change_query", route_id: i.summary.low_yield_routes?.[0] ?? rid,
      input: structuredClone(fx.engine.model_responses.route_control_replan_4_titles),
      trigger: "route_low_yield", rationale: "replay a9a6791a wave 2",
    });
  };
}

/** The discovery the chain plans when its first step carries `input`. */
export function selectingInput(fx: QueryBFixture, input: Record<string, unknown>) {
  const plan = structuredClone(fx.engine.model_responses.plan_execution) as { steps: Array<{ input: unknown }> };
  plan.steps[0].input = structuredClone(input);
  return {
    planExecution: () => Promise.resolve(structuredClone(plan)),
    planDiscovery: () => Promise.resolve([{ actor_key: JOB_SEARCH, role: "primary", input: structuredClone(input), rationale: "replay" }]),
  };
}

export const jobSearchCalls = (s: EngineSlice) => s.provider.calls.filter((c) => c.actor === JOB_SEARCH && !c.input.company);

export type DiscoveryState = {
  exhausted: boolean; stop_reason: string; pages_taken: Record<string, number>;
  page_fingerprints?: Record<string, string>;
};
export const discoveryState = (s: EngineSlice) => s.state.discovery_source_state as DiscoveryState;

/** What run-agent carries into the next slice from the checkpoint's discovery state. */
export function carried(s: EngineSlice) {
  const d = discoveryState(s);
  return {
    resume: { state: s.state, records: s.resume_records },
    replenish: d.pages_taken,
    ...(d.page_fingerprints ? { replenishExtra: { page_fingerprints: d.page_fingerprints } } : {}),
  };
}

export async function replayLineage(fx: QueryBFixture, o: { withRouteControl?: boolean } = {}) {
  const s1 = await replayEngineSlice(fx, o.withRouteControl === false ? {} : { deps: { controlRoutes: recordedRouteControl(fx) } });
  const s2 = await replayEngineSlice(fx, carried(s1));
  const s3 = await replayEngineSlice(fx, carried(s2));
  return { s1, s2, s3 };
}

export const qualifiedNames = (s: EngineSlice) =>
  s.companies.filter((c) => c.mission_evaluation?.decision === "qualified").map((c) => c.company.company_name).sort();
