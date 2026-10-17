// Codex P1 on PR #94: the smoke's execution-planner request was 53,922 bytes
// against the 32,768-byte Luna template, so the gate refused it
// (request_too_large) before the mission's first purchase. In the smoke the
// planner now sees only the approved actors, in unindented JSON. This measures
// the request body gptStructured actually sends for the smoke's own mission.
// Outside the smoke the prompt is byte-identical.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { buildExecutionPlannerPayload } from "../../../supabase/functions/_shared/leadExecutionPlan.ts";
import {
  authorisedActorKeys, makeGptExecutionPlanner, smokePlannerPayload,
} from "../../../supabase/functions/_shared/gptExecutionPlanner.ts";
import {
  ADMISSION_GATE_MARK, SMOKE_APPROVED_ACTORS_MARK,
} from "../../../supabase/functions/_shared/smokeAdmissionRefusal.ts";

/** The Luna template's byte bound in the first-smoke catalog (#93). */
const LUNA_MAX_REQUEST_BYTES = 32_768;
const JOB_SEARCH = "apify:harvestapi~linkedin-job-search";

const proposal = {
  requested_opportunity_count: 1, requested_contact_ready_count: null, company_types: ["B2B software"],
  geographies: ["United States"], geography_is_hard: true, employee_range: { min: 11, max: 50 },
  decision_maker_roles: [], hard_constraints: [], soft_preferences: [],
  preferred_signals: ["hiring Account Executive"], required_signal_terms: ["Account Executive"],
  adjacent_signals: [], excluded_signals: [],
  allowed_broadening: { role_families: [], company_types: [], geographies: [], employee_range: { min: null, max: null } },
  disallowed_broadening: [], required_evidence: [], required_capabilities: ["job_discovery"],
  preferred_source_strategy: [], evaluation_instructions: "", founder_unlock_recommended: false, confidence: 0.85, unknowns: [],
};
const QUERY = "Find 1 US B2B software company with a current declared 11–50 employee band and an open Account Executive posting dated within 30 days.";
const MISSION = compileLeadMission({ originalUserQuery: QUERY, proposal }).final_mission;
const GRAPH = buildCapabilityGraph(MISSION, { executability: "enforce" });
const PAYLOAD = buildExecutionPlannerPayload(MISSION, GRAPH, { brain: null }) as Record<string, unknown>;

/** The bytes the planner sends, with the gate (or nothing) installed as the process fetch. */
async function sentBytes(gate: Record<symbol, unknown> | null): Promise<{ bytes: number; body: Record<string, unknown> }> {
  let sent = "";
  const real = globalThis.fetch;
  if (gate) globalThis.fetch = Object.assign(((() => Promise.reject(new Error("no network"))) as unknown) as typeof fetch, gate);
  try {
    const plan = makeGptExecutionPlanner({
      readEnv: (k) => (k === "OPENAI_API_KEY" ? "sk-test" : undefined),
      fetch: (_url, init) => {
        sent = String(init.body);
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ reasoning: "r", steps: [] }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })) } as never);
      },
    }, { brain: null, playbookSubset: true, requestedCount: 1 });
    await plan({ payload: PAYLOAD, mission_hash: "h" }).catch(() => null);
  } finally {
    globalThis.fetch = real;
  }
  return { bytes: new TextEncoder().encode(sent).length, body: JSON.parse(sent) };
}

const smokeGate = (approved: readonly string[]) => ({
  [ADMISSION_GATE_MARK]: true,
  [SMOKE_APPROVED_ACTORS_MARK]: () => Promise.resolve(approved),
});

Deno.test("smoke planner: the execution-planner request for the smoke's mission fits the Luna template", async () => {
  const full = await sentBytes(null);
  const smoke = await sentBytes(smokeGate([JOB_SEARCH]));
  console.log(`execution-planner request: ${full.bytes} bytes outside the smoke, ${smoke.bytes} in it (bound ${LUNA_MAX_REQUEST_BYTES})`);
  assert(full.bytes > LUNA_MAX_REQUEST_BYTES, "outside the smoke the request is the unchanged, larger one");
  assert(smoke.bytes <= LUNA_MAX_REQUEST_BYTES, `smoke request ${smoke.bytes} bytes exceeds ${LUNA_MAX_REQUEST_BYTES}`);
});

Deno.test("smoke planner: only approved actors are offered, and capabilities with none are dropped", () => {
  const filtered = smokePlannerPayload(PAYLOAD, [JOB_SEARCH]);
  assertEquals(authorisedActorKeys(filtered), ["apify_linkedin_job_search"]);
  assert(authorisedActorKeys(PAYLOAD).length > 1, "the unfiltered graph offers more");
  const caps = filtered.authorised_capabilities as Array<{ actors: unknown[] }>;
  assert(caps.length > 0 && caps.every((c) => c.actors.length > 0));
  assertEquals(authorisedActorKeys(smokePlannerPayload(PAYLOAD, [])), [], "nothing approved, nothing offered");
});

Deno.test("smoke planner: outside the smoke the request is byte-identical (pretty JSON, every authorised actor)", async () => {
  const { body } = await sentBytes(null);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assertEquals(messages.find((m) => m.role === "user")?.content, JSON.stringify(PAYLOAD, null, 2));
});
