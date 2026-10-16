// GPT PLANS THE WHOLE JOB, NOT ONE STAGE OF IT.
//
// `gptDiscoveryPlanner` asks "which Actors discover the pool". This asks the
// question that was never asked at all:
//
//     What does this request actually need to know, which Actors can prove each
//     part, in what order, and which steps are therefore unnecessary?
//
// The difference is worth stating precisely, because it is the difference
// between a system that picks tools and one that plans work. A discovery Actor
// carrying embedded hiring evidence makes a paid hiring-verification step
// redundant; one that does not makes it essential. Nothing could express that:
// `buildCapabilityGraph` decided the stage list from mission fields before any
// Actor had been chosen, so the decision was made by code that could not know
// what the pool would contain.
//
// ── AND WHY THIS IS SAFE TO LET A MODEL DO ───────────────────────────────────
//
// `validateExecutionPlan` holds every boundary the single-stage validator holds,
// plus two this shape makes possible: a step may only name a capability the
// MISSION authorised, and only an Actor that capability declares. So the model
// composes within the graph; it cannot extend it. People stages are refused
// outright — they are offered to the user, never planned.
//
// PURE apart from the injected model call.

import {
  gptStructured, isProviderFailure, type GptDeps, type GptFailureCode, type GptResult,
} from "./gptProvider.ts";
import { routeModel, type ModelRoute } from "./gptModelRouter.ts";
import {
  buildExecutionPlannerPayload, MAX_PLAN_STEPS,
  type ExecutionPlanOptions,
} from "./leadExecutionPlan.ts";
import {
  buildAgentoryBriefing, type CompanyBrainBriefing, type DiscoveryResultsSummary,
} from "./agentoryBriefing.ts";
import type { LeadMissionV1 } from "./leadMission.ts";
import type { CapabilityPlan } from "./leadCapabilityGraph.ts";
import { hiringActorCard } from "./hiringActorCatalog.ts";
import { apifyGateActor, smokeAdmissionActive, smokeApprovedActors } from "./smokeAdmissionRefusal.ts";

export const GPT_EXECUTION_PLANNER_VERSION = "gpt-execution-planner-v1" as const;

export const RESPONSE_SCHEMA = {
  name: "lead_execution_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["steps", "reasoning"],
    properties: {
      reasoning: {
        type: "string",
        description:
          "What this request needs to know, which steps prove which part, and " +
          "which steps you deliberately left out. Recorded, never acted on.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["capability", "actor_key", "purpose", "input_json", "depends_on"],
          properties: {
            capability: {
              type: "string",
              description:
                "EXACTLY one of authorised_capabilities[].capability.",
            },
            actor_key: {
              type: ["string", "null"],
              description:
                "One of THAT capability's actors. null when runs_an_actor is false.",
            },
            purpose: {
              type: "string",
              description:
                "What this step contributes that the steps before it did not.",
            },
            // ── A JSON STRING, NOT AN OPEN OBJECT ──────────────────────
            //
            // This was `{ type: "object", additionalProperties: true }`, which
            // OpenAI's strict structured-output mode REFUSES outright:
            //
            //   HTTP 400 — Invalid schema for response_format: in context
            //   ('properties','input'), 'additionalProperties' is required to
            //   be supplied and to be false.
            //
            // So every call this planner ever made failed, and the failure was
            // invisible because `gptStructured` reports `!r.ok` and the caller
            // treats that as "the model had nothing to say". Found by running
            // the thing against the real API; no unit test could see it,
            // because every test injects the model.
            //
            // Strict mode cannot express "an object with actor-specific keys",
            // and dropping strict to get one would trade a guaranteed shape for
            // a convenient field. The input travels as a JSON STRING and is
            // parsed here — the schema stays strict, and the actor input is
            // validated where it always was: against that actor's own
            // supported_filters and verified_enums.
            input_json: {
              type: "string",
              description:
                "A JSON OBJECT, serialised as a string. Use only that actor's " +
                "supported_filters and verified_enums. Send \"{}\" for a step " +
                "that needs no input.",
            },
            depends_on: {
              type: "array",
              items: { type: "integer" },
              description: "Earlier step numbers whose output this consumes.",
            },
          },
        },
      },
    },
  },
} as const;

const STAGE_RULES =
  `You are planning the ENTIRE execution for one lead-sourcing request.

Work in this order, and say so in your reasoning:

  1. What does this request need to KNOW before a company can be called
     qualified? List the facts, not the tools.
  2. Which authorised capability can establish each fact, and which of its
     actors actually PROVES it rather than merely returning rows?
  3. What is therefore unnecessary? A step whose fact is already established by
     an earlier step's actor is pure cost.

RULES, in order of importance:

1. Use ONLY capabilities from authorised_capabilities. A capability that is not
   listed was not authorised for this mission and cannot be added.
2. For each step use ONLY an actor listed under THAT capability. An actor listed
   under a different capability is rejected.
3. Read best_for, not_for, only_returns and known_defects. An actor listed as
   not_for a task will produce confident, plausible, wrong results for it.
4. Order matters. Discovery comes before anything that consumes companies. Use
   depends_on to say which earlier step a step reads.
5. Prefer the SHORTER chain. Every actor step is a paid call, and a fact proved
   twice costs twice and is worth the same.
6. If an actor's outputs already carry the evidence a later capability exists to
   fetch, do not plan that capability. Say in your reasoning that you skipped it
   and why.
7. A capability whose runs_an_actor is false takes actor_key: null. It is a
   stage of the run, not a purchase.
8. Facts listed under verified_after_eligibility are established per company
   by a verification phase that runs AFTER qualification. You do not plan them
   and cannot: do not propose a step for them, and do not treat them as facts
   this request is missing. Plan everything else the request needs.

If the authorised capabilities and their actors cannot establish what this
request needs, return an empty steps list and say what is missing. That is a
correct answer. A chain you expect to return the wrong population is not.`;

/**
 * The planner could not be REACHED. Distinct from a planner that answered badly.
 *
 * TEST run 9105aa67's continuation asked for a plan, got HTTP 429, and the
 * engine reported `plan_not_a_list` — "the planner returned no list of steps",
 * a statement about the shape of an answer that never arrived. It then spent
 * its one repair round re-sending the same 16k-token payload 291ms into a
 * 4.4-second rate limit, and blocked the run on the second 429.
 *
 * A repair round is a conversation with the model: here is what was wrong with
 * your plan, plan again. There is no conversation to have with a rate limit.
 * Throwing routes this straight to the engine's `execution_planner_failed`
 * branch, which stops the run WITHOUT a second call and reports the provider's
 * own words instead of a shape complaint.
 */
export class GptPlannerUnavailableError extends Error {
  readonly code: GptFailureCode;
  readonly retryable: boolean;
  constructor(code: GptFailureCode, detail: string, retryable: boolean) {
    super(`the execution planner could not be reached (${code}): ${detail}`);
    this.name = "GptPlannerUnavailableError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface GptPlanExecutionInput {
  mission: LeadMissionV1;
  graph: CapabilityPlan;
  options?: ExecutionPlanOptions;
  brain?: CompanyBrainBriefing | null;
  results?: DiscoveryResultsSummary | null;
}

function systemPromptFor(
  brain: CompanyBrainBriefing | null, results?: DiscoveryResultsSummary | null,
  actorKeys?: readonly string[] | null, compact = false,
  restatedActors?: ReadonlyMap<string, Record<string, unknown>> | null,
): string {
  return [buildAgentoryBriefing({
    brain, results, actorKeys, ...(compact ? { compact, restatedActors: restatedActors ?? null } : {}),
  }), "", STAGE_RULES].join("\n");
}

/** The first entry the payload gives each actor (what the playbook need not repeat). */
export function firstActorEntries(payload: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const caps = (payload.authorised_capabilities ?? []) as Array<{ actors?: Array<Record<string, unknown>> }>;
  for (const c of caps) {
    for (const a of c.actors ?? []) {
      const k = String(a.actor_key ?? "");
      if (k && !out.has(k) && !("same_as" in a)) out.set(k, a);
    }
  }
  return out;
}

/**
 * THE SMOKE'S PLANNER PAYLOAD: only the actors the authorization approves for
 * purchase, each capability left with at least one. Everything else is
 * unchanged. A planner that cannot be shown an approved actor for a capability
 * does not see that capability (the gate would refuse its purchase anyway).
 */
export function smokePlannerPayload(payload: Record<string, unknown>, approved: readonly string[]): Record<string, unknown> {
  const ok = (key: string) => {
    const card = hiringActorCard(key);
    return !!card && approved.includes(apifyGateActor(card.actor_id));
  };
  const caps = (payload.authorised_capabilities ?? []) as Array<Record<string, unknown> & { actors?: Array<{ actor_key?: string }> }>;
  // SAID ONCE. An actor offered under a second capability keeps only the
  // fields that differ there; the rest point at its first description.
  const first = new Map<string, { capability: string; entry: Record<string, unknown> }>();
  const once = (capability: string, a: Record<string, unknown>) => {
    const key = String(a.actor_key ?? "");
    const prior = first.get(key);
    if (!prior) {
      first.set(key, { capability, entry: a });
      return a;
    }
    const differs = Object.entries(a).filter(([f, v]) =>
      f !== "actor_key" && JSON.stringify(v) !== JSON.stringify(prior.entry[f]));
    return { actor_key: key, same_as: `the ${key} entry under ${prior.capability}`, ...Object.fromEntries(differs) };
  };
  return {
    ...payload,
    authorised_capabilities: caps
      .map((c) => ({ ...c, actors: (c.actors ?? []).filter((a) => ok(String(a.actor_key ?? ""))) }))
      .filter((c) => c.actors.length > 0)
      .map((c) => ({
        ...c,
        actors: c.actors.map((a) => once(String((c as Record<string, unknown>).capability ?? ""), a as Record<string, unknown>)),
      })),
  };
}

/** P2 — the actors a payload authorises, for the playbook subset. */
export function authorisedActorKeys(payload: Record<string, unknown>): string[] {
  const caps = (payload.authorised_capabilities ?? []) as Array<{ actors?: Array<{ actor_key?: string }> }>;
  return [...new Set(caps.flatMap((c) => (c.actors ?? []).map((a) => String(a.actor_key ?? ""))).filter(Boolean))];
}

/** Exported so a test can assert what the model is shown without a network call. */
export function buildExecutionPrompt(
  i: GptPlanExecutionInput,
): { system: string; user: string } {
  return {
    system: systemPromptFor(i.brain ?? null, i.results ?? null),
    user: JSON.stringify(
      buildExecutionPlannerPayload(i.mission, i.graph, i.options ?? {}), null, 2),
  };
}

export interface GptExecutionProposal {
  reasoning: string;
  steps: Array<{
    capability: string;
    actor_key: string | null;
    purpose: string;
    /** A JSON object serialised as a string. See the schema note. */
    input_json?: string;
    depends_on: number[];
  }>;
}

/**
 * Parse the model's serialised actor input.
 *
 * A malformed string is an EMPTY input, never a thrown plan: the step still has
 * a capability and an actor, both of which are validated, and an actor asked
 * with no filters is a defensible call rather than a broken run.
 */
export function parsePlannedInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? v as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Render a refusal as instructions the model can act on.
 *
 * Same contract as the discovery planner's: the model is told which step was
 * refused and why, and that the authorised set is the whole option space — so
 * the useful move is a DIFFERENT chain, not the same one renumbered.
 */
function feedbackSection(
  feedback: ReadonlyArray<{ code: string; message: string; actor_key?: string }>,
): string {
  if (feedback.length === 0) return "";
  return [
    "",
    "── YOUR PREVIOUS PLAN WAS REFUSED ──────────────────────────────────────",
    "",
    "The refusals are below, verbatim:",
    "",
    ...feedback.map((v) =>
      `  • ${v.actor_key ? `${v.actor_key}: ` : ""}${v.message} [${v.code}]`),
    "",
    "Plan again. A refused step cannot run, so repeating it produces nothing.",
    "If a capability you wanted is not in authorised_capabilities, the mission",
    "did not authorise it and no rewording will change that — solve the request",
    "with the stages you were given, or return an empty list and say what is",
    "missing.",
  ].join("\n");
}

export interface GptExecutionPlannerContext {
  brain?: CompanyBrainBriefing | null;
  /** P2 — show only the playbook cards of actors this payload authorises. */
  playbookSubset?: boolean;
  /** Leads the user asked for. Read only by the model router. */
  requestedCount?: number;
  /** Every routing decision, so the run can report which model ran what. */
  onRoute?: (route: ModelRoute) => void;
}

/** The `planExecution` dependency, ready to hand to `runCapabilityPlan`. */
export function makeGptExecutionPlanner(
  deps: GptDeps = {}, ctx: GptExecutionPlannerContext = {},
) {
  return async (i: {
    payload: Record<string, unknown>;
    mission_hash: string;
    validation_feedback?: Array<{ code: string; message: string; actor_key?: string }>;
    results?: DiscoveryResultsSummary | null;
  }): Promise<unknown> => {
    const feedback = i.validation_feedback ?? [];
    // THE SMOKE: approved actors only, unindented JSON, so the request fits the
    // model template's byte bound (smokeAdmissionRefusal.ts). Unchanged otherwise.
    const smoke = smokeAdmissionActive();
    const approved = smoke ? await smokeApprovedActors() : null;
    const payload = approved ? smokePlannerPayload(i.payload, approved) : i.payload;
    // THREE DISTINCT STAGES, because they answer different questions and a
    // trace that collapses them cannot show which one is going wrong: the first
    // plan, a plan repaired after refusal, and an amendment made once the pool
    // is a fact rather than a prediction.
    const route = routeModel(
      feedback.length > 0
        ? "execution_plan_repair"
        : i.results
        ? "execution_plan_amendment"
        : "execution_plan",
      { requested_count: ctx.requestedCount ?? undefined,
        pool_size: i.results?.candidates_returned ?? undefined },
    );
    ctx.onRoute?.(route);
    const r: GptResult<GptExecutionProposal> = await gptStructured<GptExecutionProposal>({
      purpose: route.stage,
      system: systemPromptFor(ctx.brain ?? null, i.results ?? null,
          ctx.playbookSubset || smoke ? authorisedActorKeys(payload) : null, smoke,
          smoke ? firstActorEntries(payload) : null) +
        feedbackSection(feedback),
      user: smoke ? JSON.stringify(payload) : JSON.stringify(payload, null, 2),
      schema: RESPONSE_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      maxTokens: 3000,
      // THE ROUTER'S MODEL, NOT A TIER LOOKUP. Luna on the first attempt;
      // the repair stage routes to Terra, and `feedback` is the real
      // validator's violations — `validateExecutionPlan` produced them.
      model: route.model,
      reasoningEffort: route.reasoning_effort,
      tier: route.tier,
      routing_reason: route.reason,
    }, deps);

    if (!r.ok) {
      (deps.log ?? (() => {}))("gpt_execution_planner_failed", {
        code: r.code, detail: r.detail, latency_ms: r.latency_ms,
        retryable: r.retryable, attempts: r.attempts,
      });
      // ── WHICH KIND OF FAILURE IS THIS? ────────────────────────────────
      //
      // THE PROVIDER DID NOT ANSWER (no key, HTTP error, transport fault).
      // There is nothing to say back to the model, so a repair round would be
      // a second identical call — which is exactly how a 4-second rate limit
      // killed run 9105aa67. Throw, and let the engine stop honestly.
      if (isProviderFailure(r.code)) {
        throw new GptPlannerUnavailableError(r.code, r.detail, r.retryable);
      }
      // THE MODEL ANSWERED BADLY (empty, unparseable, refused). That IS worth
      // a repair round, so it stays a null and the engine asks again with the
      // refusal attached.
      return null;
    }
    // The serialised input becomes a real object here, so `validateExecutionPlan`
    // and every caller downstream see the shape they always expected.
    return {
      reasoning: r.value.reasoning,
      steps: (r.value.steps ?? []).map((st) => ({
        ...st,
        input: parsePlannedInput(
          (st as { input_json?: unknown; input?: unknown }).input_json ??
          (st as { input?: unknown }).input),
      })),
    };
  };
}

export { MAX_PLAN_STEPS };
