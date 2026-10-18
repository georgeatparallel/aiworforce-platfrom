// A MARKET IS A TOPIC, AND A CAPABILITY IS A QUESTION YOU ASK.
//
// ── TWO DEFECTS, ONE SURFACE ───────────────────────────────────────────────
//
// The vocabulary had no word for a topic. "What's happening in AI recruiting?"
// names no company and no page, so it had nowhere to land but the lead
// pipeline — which would read the topic words as a description of companies to
// go and find, buying a discovery run for a question that asked for none.
//
// And availability was INFERRED. pilot-chat decided this surface was degraded by
// testing `!decision.selected_actor_key` — a field the classifier deliberately
// leaves unset so `validateAgainstCapabilities` can fill or clear it. Three
// components had to agree on the meaning of one null for the user to be told the
// truth, and the question underneath was never semantic: is web search
// configured in this deployment?

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  planMarketResearch, webSearchAvailable, SEARCH_WEB_UNAVAILABLE,
} from "../../../supabase/functions/_shared/marketResearchSurface.ts";
import { routeRequest } from "../../../supabase/functions/_shared/objectiveRouter.ts";
import { bindRoute } from "../../../supabase/functions/_shared/chatBrainBinding.ts";
import {
  REQUEST_V1_VERSION, REQUEST_ENTITIES,
  type RequestV1, type RequestEntity, type RequestObjective,
} from "../../../supabase/functions/_shared/requestV1.ts";
import { SUBJECT_TYPES } from "../../../supabase/functions/_shared/signalSubject.ts";

const req = (
  entity: RequestEntity, objective: RequestObjective = "research",
  utterance = "What's happening in AI recruiting?",
): RequestV1 => ({
  version: REQUEST_V1_VERSION, utterance, objective,
  parts: [{
    id: "p1", objective,
    subject: { entity, references: [] },
    output: { shape: "answer", count: null },
  }],
  ambiguity: [],
  authority: { may_spend: false, max_cost_units: null, requires_confirmation: true },
  provenance: {}, confidence: 0.9,
});

const env = (vars: Record<string, string>) => (k: string) => vars[k];

// ══ 1. THE VOCABULARY ALIGNS WITH THE ONE ALREADY PERSISTED ════════════════

Deno.test("1. market is an entity, and it matches signal_events' own word", () => {
  assert(REQUEST_ENTITIES.includes("market"));
  // Not invented here: the persisted subject vocabulary already had it.
  assert(SUBJECT_TYPES.includes("market"),
    "the semantic vocabulary should describe what the schema already stores");
});

Deno.test("2. a topic routes to market research, not to a lead mission", () => {
  const route = routeRequest(req("market"), { spendAllowed: true });
  assertEquals(route.kind, "market_research");
  assertEquals(route.lead, undefined,
    "a topic has no company profile and must not become a discovery run");
  assertEquals(bindRoute(route).kind, "market_research");
});

Deno.test("3. a named company is still company research", () => {
  const route = routeRequest(req("company"), { spendAllowed: true });
  assertFalse(route.kind === "market_research");
});

Deno.test("4. the topic is the user's own words", () => {
  // A market has no identifier to resolve and no registry to look it up in.
  // Narrowing to keywords here would answer a smaller question than was asked.
  const r = req("market", "research", "How is the RevOps tooling market moving?");
  assertEquals(planMarketResearch(r).topic, "How is the RevOps tooling market moving?");

  const named = req("market");
  named.parts[0].subject.references = [{ kind: "named", value: "AI recruiting" }];
  assertEquals(planMarketResearch(named).topic, "AI recruiting");
});

Deno.test("5. only research on a market — a read about one is not a search", () => {
  assertEquals(planMarketResearch(req("market", "read")).topic, null);
  assertEquals(routeRequest(req("market", "read"), { spendAllowed: true }).may_spend, false);
});

// ══ 2. THE CAPABILITY IS ASKED ═════════════════════════════════════════════

Deno.test("6. availability is read from the deployment, not from a null field", () => {
  assert(webSearchAvailable(env({})), "anonymous search needs no key");
  assert(webSearchAvailable(env({ ENABLE_SEARCH_WEB: "true" })));
  assert(webSearchAvailable(env({ ENABLE_SEARCH_WEB: "1" })));
  assertFalse(webSearchAvailable(env({ SEARCH_WEB_API_KEY: "sk-x" })), "preserve configured backend");
  assertFalse(webSearchAvailable(env({ ENABLE_SEARCH_WEB: "false" })));
  assert(webSearchAvailable(env({ SEARCH_WEB_API_KEY: "   " })),
    "a blank key leaves the installation unconfigured");
});

Deno.test("7. one definition of the rule, and one sentence explaining it", async () => {
  // `capabilityValidator` kept a second copy of the rule while pilot-chat
  // inferred the answer from whether that validator had cleared a field. Both
  // are deleted; `marketResearchSurface` is the only definition left.

  const pilot = await Deno.readTextFile(
    new URL("../../../supabase/functions/pilot-chat/index.ts", import.meta.url));
  assertEquals([...pilot.matchAll(/Broad live web search isn't configured/g)].length, 0,
    "the sentence lives with the surface, not inline in the handler");
  assertEquals([...pilot.matchAll(/SEARCH_WEB_UNAVAILABLE/g)].length >= 2, true,
    "and is reached from both the route and the legacy branch");
});

Deno.test("8. no branch infers degradation from a cleared field any more", async () => {
  // It tested `!decision.selected_actor_key` — a field the classifier leaves
  // unset so the validator can fill or clear it, so three components had to
  // agree on one null before the user was told the truth. That branch is
  // deleted; the route asks `webSearchAvailable` directly.
  const pilot = await Deno.readTextFile(
    new URL("../../../supabase/functions/pilot-chat/index.ts", import.meta.url));
  assertFalse(pilot.includes('workflow_category === "market_research"'),
    "the classifier branch must be gone");
  assert(pilot.includes("webSearchAvailable("),
    "and the capability asked directly");
});

Deno.test("9. an unconfigured deployment refuses honestly and offers what works", () => {
  assert(/isn't configured/i.test(SEARCH_WEB_UNAVAILABLE));
  // A refusal that names no alternative leaves the user with nothing to do.
  assert(/Firecrawl/.test(SEARCH_WEB_UNAVAILABLE) && /Apify/.test(SEARCH_WEB_UNAVAILABLE));
});
