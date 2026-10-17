// Codex P1 on PR #94: the smoke's execution-planner request was 53,922 bytes
// against the 32,768-byte Luna template, so the gate refused it
// (request_too_large) before the mission's first purchase. In the smoke the
// planner now sees only the approved actors, in unindented JSON. This measures
// the request body gptStructured actually sends for the smoke's own mission.
// Outside the smoke the prompt is byte-identical. The bound is the proposed
// catalog's (30,720 since Luna input is priced at its cache-write rate).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { buildExecutionPlannerPayload } from "../../../supabase/functions/_shared/leadExecutionPlan.ts";
import {
  makeGptExecutionPlanner,
} from "../../../supabase/functions/_shared/gptExecutionPlanner.ts";
import {
  ADMISSION_GATE_MARK,
  SMOKE_APPROVED_ACTORS_MARK,
} from "../../../supabase/functions/_shared/smokeAdmissionRefusal.ts";

const JOB_SEARCH = "apify:harvestapi~linkedin-job-search";
const DETAILS = "apify:harvestapi~linkedin-company";

const proposal = {
  requested_opportunity_count: 1,
  requested_contact_ready_count: null,
  company_types: ["B2B software"],
  geographies: ["United States"],
  geography_is_hard: true,
  employee_range: { min: 11, max: 50 },
  decision_maker_roles: [],
  hard_constraints: [],
  soft_preferences: [],
  preferred_signals: ["hiring Account Executive"],
  required_signal_terms: ["Account Executive"],
  adjacent_signals: [],
  excluded_signals: [],
  allowed_broadening: {
    role_families: [],
    company_types: [],
    geographies: [],
    employee_range: { min: null, max: null },
  },
  disallowed_broadening: [],
  required_evidence: [],
  required_capabilities: ["job_discovery"],
  preferred_source_strategy: [],
  evaluation_instructions: "",
  founder_unlock_recommended: false,
  confidence: 0.85,
  unknowns: [],
};
const QUERY =
  "Find 1 US B2B software company with a current declared 11–50 employee band and an open Account Executive posting dated within 30 days.";
const MISSION =
  compileLeadMission({ originalUserQuery: QUERY, proposal }).final_mission;
const GRAPH = buildCapabilityGraph(MISSION, { executability: "enforce" });
const PAYLOAD = buildExecutionPlannerPayload(MISSION, GRAPH, {
  brain: null,
}) as Record<string, unknown>;

/** The bytes the planner sends, with the gate (or nothing) installed as the process fetch. */
async function sentBytes(
  gate: Record<symbol, unknown> | null,
  brain: Record<string, unknown> | null = null,
): Promise<{ bytes: number; body: Record<string, unknown> }> {
  let sent = "";
  const real = globalThis.fetch;
  if (gate) {
    globalThis.fetch = Object.assign(
      ((() =>
        Promise.reject(new Error("no network"))) as unknown) as typeof fetch,
      gate,
    );
  }
  try {
    const plan = makeGptExecutionPlanner({
      readEnv: (k) => (k === "OPENAI_API_KEY" ? "sk-test" : undefined),
      fetch: (_url, init) => {
        sent = String(init.body);
        return Promise.resolve(
          {
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(JSON.stringify({
                choices: [{
                  message: {
                    content: JSON.stringify({ reasoning: "r", steps: [] }),
                  },
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              })),
          } as never,
        );
      },
    }, { brain, playbookSubset: true, requestedCount: 1 });
    await plan({ payload: PAYLOAD, mission_hash: "h" }).catch(() => null);
  } finally {
    globalThis.fetch = real;
  }
  return {
    bytes: new TextEncoder().encode(sent).length,
    body: JSON.parse(sent),
  };
}

const smokeGate = (approved: readonly string[]) => ({
  [ADMISSION_GATE_MARK]: true,
  [SMOKE_APPROVED_ACTORS_MARK]: () => Promise.resolve(approved),
});

import {
  boundRequest,
  classifyRequest,
} from "../../../supabase/functions/_shared/smokeAdmission.ts";
Deno.test("independent: full Brain planner request exceeds the template and is refused before transport", async () => {
  const brain = {
    positive_industries: Array.from(
      { length: 30 },
      (_, i) => "Business software for a specific enterprise sector " + i,
    ),
    disqualifiers: Array.from(
      { length: 30 },
      (_, i) =>
        "Exclude companies without verified enterprise buyers in sector " + i,
    ),
    business_models: ["B2B SaaS"],
    employee_min: 11,
    employee_max: 50,
    excluded_industries: [],
    required_geography: null,
  };
  const sent = await sentBytes(smokeGate([JOB_SEARCH, DETAILS]), brain);
  const req = {
    method: "POST",
    url: new URL("https://api.openai.com/v1/chat/completions"),
    body: JSON.stringify(sent.body),
  };
  const cls = classifyRequest(req, null);
  assert(cls.kind === "model");
  const b = boundRequest(req, cls, {
    max_request_bytes: 30720,
    max_output_tokens: 4000,
  }, 12480);
  assert(sent.bytes > 30720);
  assertEquals(b, { ok: false, reason: "request_too_large" });
  console.log(
    "BRAIN_BOUND",
    JSON.stringify({ bytes: sent.bytes, bound: 30720, refusal: b }),
  );
});
