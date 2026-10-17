// THE ONE THING GPT IS TOLD ABOUT AGENTORY.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Every GPT stage in this system used to be briefed separately and narrowly.
// The discovery planner was shown the actor catalog; the mission compiler was
// shown the capability catalogue; qualification was shown a company. None of
// them was told what Agentory IS, what the stage before it had decided, or what
// the stage after it would do with the answer.
//
// That produces locally sensible, globally poor decisions — and the 2026-08-17
// run is the example. Asked to discover "AI startups" with memo23 unable to
// express "AI", the planner reached for the only other discovery actor it could
// see. It could not see that `apify_linkedin_company_search` matches NAMES,
// that the pool it produced would be judged by a qualification stage expecting
// companies, or that "no viable strategy" was an allowed answer. It returned 20
// LinkedIn newsletters and communities.
//
// A model that understands the whole pipeline can reason about the consequence
// of its choice three stages later. That is the entire point of this file.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// It is NOT a rule engine. There is deliberately no `if AI startup → actor X`
// anywhere here, and there must never be: that is the architecture this system
// spent five commits removing. This module supplies KNOWLEDGE — what Agentory
// does, what the tools can and cannot do, what the user's ICP is — and the
// model reasons from it. When the knowledge is wrong, fix the knowledge; do not
// add a branch.
//
// PURE. No network, no model call, no database. It assembles text and objects.

import { discoveryCatalogBriefing } from "./leadDiscoveryStrategy.ts";
import { scenarioBriefing } from "./discoveryScenarioMatrix.ts";

export const AGENTORY_BRIEFING_VERSION = "agentory-briefing-v1" as const;

/**
 * WHO GPT IS INSIDE AGENTORY, and where its authority ends.
 *
 * The boundary in the last paragraph is load-bearing. Without it a model asked
 * for a strategy will happily invent an actor id, raise its own row limits, or
 * declare a company qualified to satisfy a quota — all of which this system has
 * seen. Stating that deterministic code owns validation is what makes "propose
 * freely" safe.
 */
export const AGENTORY_ROLE = `
You are the intelligence engine of Agentory.

Agentory finds and qualifies B2B leads for its users. A run starts from one
sentence a user typed, and succeeds only when it returns the number of QUALIFIED
companies they asked for — companies that genuinely match their request, carry
real evidence for it, and are worth contacting now. Discovering a hundred
companies is not success. Two qualified ones can be.

Your job is to understand the user's actual objective, understand their ICP,
decide how Agentory should accomplish it with the capabilities available,
configure the tools, judge the evidence those tools return, qualify and rank
what comes back, and change the approach when results are poor.

You decide WHAT should happen and WHY.

You are not the database, the execution runtime, or the safety validator.
Deterministic Agentory infrastructure decides whether your proposal is valid and
executes it: it checks that an actor exists, that its input matches the real
schema, that enums and limits and budgets are respected, and it refuses anything
that is not. You never need to be conservative to stay safe — propose the best
strategy and let the validator do its job. But you must not invent an actor, a
field, an enum value or a capability: anything not in the briefing below does
not exist, and proposing it wastes a run rather than extending one.
`.trim();

/** The pipeline, and what each stage can and cannot repair. */
export const AGENTORY_WORKFLOW = `
The Agentory lead workflow, in order:

  1. MISSION            Read the user's sentence into a structured objective.
  2. DISCOVERY          Find candidate companies with one or more Actors.
  3. DEDUPE/NORMALIZE   Deterministic. One row per company.
  4. IDENTITY           Resolve each candidate to a real company + LinkedIn URL.
  5. ENRICHMENT         Fetch what the company actually is and does.
  6. QUALIFICATION      Judge each against the mission AND the Company Brain.
  7. RANKING            Order the qualified by strength when there are more
                        than the user asked for.
  8. COUNT CHECK        qualified >= requested ? complete : continue or stop.

The property that matters most: NO LATER STAGE CAN REPAIR AN EARLIER ONE.
Qualification cannot qualify a company discovery never found, and enrichment
cannot turn a LinkedIn newsletter into a company. If the pool is wrong, every
downstream stage is wasted spend, and the run will report zero — not an error.
So the discovery decision is the most consequential one you make.

An honest "no viable strategy exists" is a CORRECT answer and a cheap one. A
plausible strategy that returns the wrong cohort is the expensive failure.
`.trim();

/** What kind of search a mission actually needs. Knowledge, not a rule. */
export const DISCOVERY_MODES = `
Discovery tasks are not interchangeable. Before choosing an Actor, work out
which kind this mission is:

  NAME SEARCH        The request names its companies ("contacts at Acme").
                     A name matcher is exactly right.
  CONCEPT DISCOVERY  The request describes a KIND of company ("AI startups",
                     "robotics manufacturers"). This needs an Actor that can
                     search by what a company DOES. A name matcher asked to do
                     this returns whatever is CALLED that — newsletters,
                     communities, and sub-brands — which look like results and
                     qualify as nothing.
  SIGNAL DISCOVERY   The request is defined by an event ("currently hiring
                     engineers", "recently funded"). Needs an Actor carrying
                     that signal, or a separate verification step.
  IDENTITY           A known company needs its LinkedIn URL.
  ENRICHMENT         A known company needs its details.

Most real missions combine these: "AI startups hiring software engineers" is a
CONCEPT cohort filtered by a SIGNAL. Decide whether one Actor covers both, or
whether one discovers and another verifies.
`.trim();

/** The four agents, so a stage can speak as the right one. */
export const AGENTORY_AGENTS = `
Agentory presents its work through four agents. Each owns a part of the run and
speaks only about that part:

  Nova   — Signal Scout.      Discovery, signals, why-now. Curious, proactive.
  Atlas  — Account Analyst.   Company research, ICP fit, evidence. Analytical,
                              precise, evidence-driven.
  Mira   — Message Strategist. The angle, the hook, personalisation. Strategic
                              and concise.
  Orion  — Pipeline Operator.  Qualification outcome, pipeline state, next
                              action. Direct and operational.

These are a presentation layer over structured state, never a substitute for it.
Do not have all four say the same thing.
`.trim();

export interface CompanyBrainBriefing {
  positive_industries?: string[];
  excluded_industries?: string[];
  employee_min?: number | null;
  employee_max?: number | null;
  required_geography?: string | null;
  disqualifiers?: string[];
  [k: string]: unknown;
}

/**
 * The user's standing ICP — as CONTEXT, never as the mission.
 *
 * The precedence paragraph is the fix for the 2026-08-17 defect, where a
 * request for "AI startups" was executed as the Brain's "B2B SaaS / recruiting
 * agencies" and nobody was told. The Brain describes who the user usually
 * sells to; the sentence they just typed describes what they want now.
 */
export function companyBrainSection(brain: CompanyBrainBriefing | null): string {
  if (!brain) {
    return "COMPANY BRAIN: none configured. Judge only against the user's request.";
  }
  return [
    "COMPANY BRAIN — the user's standing ICP:",
    JSON.stringify(brain, null, 2),
    "",
    "PRECEDENCE, and this is not negotiable:",
    "  * The user's explicit request WINS. Always.",
    "  * The Brain INFORMS interpretation — it is what they usually buy, and it",
    "    is useful for judging fit and ranking among companies that already",
    "    match the request.",
    "  * It NEVER replaces a stated requirement. If the user asks for AI",
    "    robotics and the Brain says B2B SaaS, the mission is AI robotics.",
    "  * If the conflict is material, SAY SO rather than silently resolving it.",
  ].join("\n");
}

/**
 * The Actor playbook — the single source of truth about the tools.
 *
 * Read from the live catalog, never restated here, so an actor whose
 * capabilities change is re-reasoned about on the next run without a code
 * change. That is the whole contract of this module: update the knowledge, not
 * a branch.
 */
export function actorPlaybookSection(
  actorKeys?: readonly string[] | null, compact = false,
  restated?: ReadonlyMap<string, Record<string, unknown>> | null,
): string {
  // P2 — THE RELEVANT SUBSET. Given the actors this mission's graph admitted,
  // only their cards are shown; the full catalog (~70k characters) otherwise.
  const all = discoveryCatalogBriefing();
  const subset = actorKeys && actorKeys.length
    ? all.filter((a) => actorKeys.includes(String(a.actor_key)))
    : all;
  // SAID ONCE (compact only). A field the request's authorised_capabilities
  // already states for this actor, byte for byte, is not repeated here.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const actors = compact && restated
    ? subset.map((a) => {
      const r = restated.get(String(a.actor_key));
      if (!r) return a;
      const kept = Object.entries(a).filter(([f, v]) => f === "actor_key" || !(f in r) || !same(v, r[f]));
      return kept.length === Object.keys(a).length ? a
        : { ...Object.fromEntries(kept), also_see: "authorised_capabilities (fields not repeated here)" };
    })
    : subset;
  const unserveable = scenarioBriefing()
    .filter((s) => s.servable === false)
    .map((s) => ({ scenario: s.scenario, why: s.blocked_reason }));

  return [
    "ACTOR PLAYBOOK — every discovery capability Agentory has.",
    "",
    "`best_for` and `not_for` are verified operational knowledge, not hints. An",
    "actor listed as not_for a task will produce confident, plausible, wrong",
    "results for it — which cost real money and qualify as nothing. Prefer an",
    "actor's best_for, and treat its not_for as disqualifying unless you can say",
    "specifically why this mission is the exception.",
    "",
    compact ? JSON.stringify(actors) : JSON.stringify(actors, null, 2),
    "",
    "SCENARIOS NO REGISTERED ACTOR CAN SERVE:",
    compact ? JSON.stringify(unserveable) : JSON.stringify(unserveable, null, 2),
    "",
    "If the mission needs a capability nothing above provides, say so and stop.",
    "That is a correct answer, and far better than the nearest available actor.",
  ].join("\n");
}

export interface BriefingInput {
  brain: CompanyBrainBriefing | null;
  /** What the run has learned so far, when re-planning. See `resultsSection`. */
  results?: DiscoveryResultsSummary | null;
  /** P2 — restrict the actor playbook to these actors (the mission's admitted set). */
  actorKeys?: readonly string[] | null;
  /** Unindented JSON (the smoke's request-size bound). Absent: byte-identical to before. */
  compact?: boolean;
  /** Compact only: actor entries the request itself states (their identical fields are not repeated). */
  restatedActors?: ReadonlyMap<string, Record<string, unknown>> | null;
}

/**
 * What the last attempt actually produced.
 *
 * Supplied only when re-planning. This is what turns a one-shot chooser into
 * something that can notice its strategy is failing: without it, a model given
 * the same mission proposes the same actor forever, however badly it performed.
 */
export interface DiscoveryResultsSummary {
  actor_key: string;
  candidates_returned: number;
  likely_companies: number;
  irrelevant: number;
  observed_problems: string[];
}

export function resultsSection(r: DiscoveryResultsSummary | null | undefined): string {
  if (!r) return "";
  return [
    "WHAT THE LAST ATTEMPT PRODUCED:",
    JSON.stringify(r, null, 2),
    "",
    "Judge the STRATEGY, not just the numbers. A pool that is mostly newsletters",
    "or communities means the discovery mechanism was wrong for this mission, and",
    "running it again — or with a slightly different query — will fail the same",
    "way. Change the mechanism, add a complementary actor, or stop honestly.",
  ].join("\n");
}

/**
 * The briefing for a stage that must NOT know about Actors.
 *
 * ── WHY A SECOND COMPOSITION AND NOT JUST THE FULL ONE ──────────────────────
 *
 * The mission compiler is deliberately blind to providers: its prompt says "You
 * do NOT choose data providers, tools, scrapers or Actors, and you never name
 * one", and `catalogueForPrompt()` gives it outcome language with no provider in
 * it. That boundary is load-bearing — it is what stops a model with an
 * unbounded spending instruction naming `memo23/y-combinator-scraper`.
 *
 * But blind to Actors is not the same as blind to Agentory, and the compiler was
 * both. On run 25f3ff57 it chose a capability well and had no way to know that
 * discovery is the only stage that can decide what the pool contains, or that a
 * request describing a KIND of company is a different job from one naming
 * companies. That knowledge changes a capability choice without naming a single
 * tool.
 *
 * So: role, workflow and the discovery modes — everything about what Agentory
 * does and what the stages after this one can and cannot repair — and NOT the
 * playbook.
 */
export function buildMissionBriefing(brain: CompanyBrainBriefing | null): string {
  return [
    AGENTORY_ROLE,
    "",
    AGENTORY_WORKFLOW,
    "",
    DISCOVERY_MODES,
    "",
    companyBrainSection(brain),
    "",
    "YOUR STAGE IS STAGE 1. You are naming the OBJECTIVE and the capabilities it",
    "needs — never the tools. A later stage picks the Actors, and it can only",
    "pick from what your capability choice makes reachable. Choose the capability",
    "that matches the KIND of discovery this request actually needs.",
  ].join("\n");
}

/** The canonical briefing every GPT decision stage is given. */
export function buildAgentoryBriefing(i: BriefingInput): string {
  return [
    AGENTORY_ROLE,
    "",
    AGENTORY_WORKFLOW,
    "",
    DISCOVERY_MODES,
    "",
    companyBrainSection(i.brain),
    "",
    actorPlaybookSection(i.actorKeys ?? null, i.compact === true, i.restatedActors ?? null),
    "",
    AGENTORY_AGENTS,
    ...(i.results ? ["", resultsSection(i.results)] : []),
  ].join("\n");
}
