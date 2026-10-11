// A REPORTED SIZE RANKS; THE COMPANY RECORD DECIDES. A SPENT ALLOWANCE PLANS NOTHING.
//
// Canary 87ecf153 (local, 2026-09-24): company search returned ByteByteGo and
// Psychology Today for an 11–50 mission. The pre-pass excluded both on their
// search-row `employeeCount` (86 and 2,135) — which is LinkedIn ASSOCIATED
// MEMBERS, not staff. Both companies DECLARE 11-50: the search's own
// `companySize: ["11-50"]` filter reads exactly that declared band, which is
// why they were returned at all (companySize.ts).
//
// Replayed here through the real engine with rows shaped like the canary's:
//
//   company search → plausible declared band 11-50 → ranked UP, not excluded
//   → enrichment (one batched company-details read) → PROVEN declared band
//   → size PASS (the member count is shown, never decides) → Atomus target
//
// a company whose record DECLARES a band outside the range still fails and
// buys no Atomus, and with the allowance spent, no discovery planning — this
// slice or the next.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { missionCandidatesFrom, runCapabilityPlan } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import { mergeCompanyBrainIntoMission, parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { readinessPolicy } from "../../../supabase/functions/_shared/routeReadiness.ts";
import { candidatePool, parseRunBudget } from "../../../supabase/functions/_shared/runBudget.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { verificationTargets } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { emptyDiscoverySelector } from "./discoverySelectorFixture.ts";

globalThis.fetch = () => { throw new Error("replay tests must not reach the network"); };

const PROBE = readinessPolicy({ mode: "provider_probe", probe_routes: ["apify_linkedin_company_search|general_company_discovery"] });
const QUERY = "Find 1 US company with 11-50 employees that raised funding in the last 6 months";
const MISSION = (() => {
  const m = parseLeadMissionDeterministic(QUERY);
  const stated = {
    ...m, company_profile: { ...m.company_profile, employee_range: { min: 11, max: 50 } },
    field_provenance: { ...m.field_provenance, "company_profile.employee_range": "explicit_user_request" as const },
  };
  return mergeCompanyBrainIntoMission(stated, { industries: ["b2b saas", "fintech"] } as never).mission;
})();

/**
 * Rows shaped like the canary's harvestapi company records (full mode):
 * `employeeCount` is LinkedIn associated members, `employeeCountRange` the
 * declared band (11-50 for every canary row — the search filtered on it).
 */
const row = (slug: string, name: string, employeeCount: number, band: [number, number] = [11, 50]) => ({
  id: slug, name, linkedinUrl: `https://www.linkedin.com/company/${slug}/`, website: `https://${slug}.com`,
  description: `${name} does something.`, employeeCount, employeeCountRange: { start: band[0], end: band[1] },
  industries: [{ id: 4, name: "Software Development" }],
  locations: [{ parsed: { text: "San Francisco, CA, United States", countryFull: "United States" }, country: "US", headquarter: true }],
});
const CANARY_ROWS = [row("bytebytego", "ByteByteGo", 86), row("psychology-today", "Psychology Today", 2135)];

type Triage = (i: { company_keys: string[] }) => Promise<unknown>;
/** `records`: what the company-details read returns, when it disagrees with the search rows. */
function harness(rows: Record<string, unknown>[], triage?: Triage, records: Record<string, unknown>[] = rows) {
  const sent: Array<{ actor: string; input: Record<string, unknown> }> = [];
  const calls = { planDiscovery: 0, controlRoutes: 0 };
  const byUrl = (u: string) => records.find((r) => String(r.linkedinUrl).replace(/\/$/, "") === u.replace(/\/$/, ""));
  const deps = {
    ...(triage ? { triageCompanies: triage } : {}),
    planDiscovery: (x: unknown) => { calls.planDiscovery++; return (emptyDiscoverySelector() as (y: unknown) => unknown)(x); },
    planExecution: () => Promise.resolve({ reasoning: "replay", steps: [
      { capability: "general_company_discovery", actor_key: "apify_linkedin_company_search", purpose: "profile discovery",
        input: { industryIds: ["4", "6", "43"], locations: ["United States"], companySize: ["11-50"], maxItems: 20, scraperMode: "full" }, depends_on: [] },
      { capability: "company_identity_resolution", actor_key: "apify_linkedin_company_search", purpose: "only without a page", input: { searchQuery: "{{name}}", maxItems: 5 }, depends_on: [1] },
      { capability: "company_enrichment", actor_key: "apify_linkedin_company_details", purpose: "details", input: { companies: ["{{url}}"] }, depends_on: [2] },
      { capability: "company_brain_qualification", actor_key: null, purpose: "qualify", input: {}, depends_on: [3] },
      { capability: "persistence", actor_key: null, purpose: "save", input: {}, depends_on: [4] },
    ] }),
    controlRoutes: () => { calls.controlRoutes++; return Promise.resolve({ action: "continue" }); },
    invoke: (call: { actorKey: string; input: Record<string, unknown>; onProviderRun?: (r: { run_id: string; dataset_id: null }) => void }) => {
      sent.push({ actor: call.actorKey, input: call.input });
      call.onProviderRun?.({ run_id: `run-${sent.length}`, dataset_id: null });
      if (call.actorKey === "apify_linkedin_company_search") {
        return Promise.resolve(call.input.searchQuery ? [] : rows.slice(0, Number(call.input.maxItems ?? 2)));
      }
      if (call.actorKey === "apify_linkedin_company_details") {
        return Promise.resolve(((call.input.companies as string[]) ?? []).map(byUrl).filter(Boolean));
      }
      throw new Error(`unexpected provider call: ${call.actorKey}`);
    },
    verifyEmployer: () => ({ verified: true, outcome: "verified_match" }),
  };
  const budget = parseRunBudget({ provider_usd: 0.04, max_candidates: 2 })!;
  const opts = {
    mission: MISSION, plan: buildCapabilityGraph(MISSION, { executability: "enforce", readiness: PROBE }),
    maxCandidates: candidatePool(1, budget), runBudget: budget, readiness: PROBE,
    readEnv: (k: string) => (k === "LEAD_INVESTIGATION_MAX_PASSES" ? "1" : undefined),
    specMode: "enforce", specScope: { workspace_id: "ws-replay", lineage_id: "ln-replay" },
  };
  return { deps, opts, sent, calls };
}
const CRITERIA = deriveMissionCriteria(MISSION, PROBE);
// deno-lint-ignore no-explicit-any
type Grounded = Record<string, any>;
const grounded = (result: unknown): Grounded[] => (missionCandidatesFrom(result as never, { missionId: "t" }) as Grounded[])
  .map((c): Grounded => {
    const e = evaluateEligibility(CRITERIA, c.graph);
    return { ...c, eligibility: e.eligibility, hard_checks: (e.checks ?? []).filter((x) => x.kind === "hard"), attempted_routes: c.attempted_routes ?? [] };
  });

const atomusTargets = (cands: Grounded[]) => verificationTargets({ route_actor: "apify_funding_atomus", max_targets: 6 },
  cands as never, (id) => CRITERIA.find((c) => c.id === id)?.value, undefined, PROBE);

Deno.test("CANARY 87ecf153 REPLAY: declared 11-50 with 86 / 2,135 members — enriched, size PASSES on the band, both reach Atomus", async () => {
  const h = harness(CANARY_ROWS);
  const result = await runCapabilityPlan(h.deps as never, h.opts as never) as unknown as { state: Record<string, any> };

  // Discovery ranks them IN on the declared band; the member count moved nothing.
  for (const p of result.state.prequalification.companies) {
    assertEquals([p.size_status, p.exclusion, p.eligible], ["in_range", null, true], p.name);
  }
  // Both reached enrichment, in one batched read.
  const details = h.sent.filter((s) => s.actor === "apify_linkedin_company_details");
  assertEquals(details.length, 1);
  assertEquals((details[0].input.companies as string[]).length, 2);

  // Size is decided on the enriched, PROVEN declared band — and passes.
  const cands = grounded(result);
  for (const c of cands) {
    const size = c.hard_checks.find((x: Grounded) => x.dimension === "company_size")!;
    assertEquals(size.result, "pass", c.name);
    const band = c.graph.claims.find((x: any) => x.dimension === "company_size_band").current;
    assertEquals([band.source.actor, band.status, band.authority?.rule],
      ["apify_linkedin_company_details", "proven", "li_record_declared_size_band"], c.name);
    // The member count is recorded, as members, and decided nothing.
    const members = c.graph.claims.find((x: any) => x.dimension === "linkedin_member_count")?.current;
    assert(members && members.value > 50, `${c.name}: member count kept for display`);
    assert(!c.graph.claims.some((x: any) => x.dimension === "headcount"), "no staff-count claim exists");
    assertEquals(c.eligibility, "pending", `${c.name}: funding is the open claim`);
  }
  // Viable on proven evidence, so both are handed to the funding verifier.
  assertEquals(atomusTargets(cands).map((t) => t.name).sort(), ["ByteByteGo", "Psychology Today"]);
});

Deno.test("OUT-OF-BAND AT DISCOVERY: a search row that DECLARES 201-500 on its own LinkedIn page is settled before enrichment", async () => {
  // Since 2026-10-11 (Query B, task 255c333f): the company's own declared band,
  // on a strong LinkedIn identity, clearly disjoint from 11-50, with nothing on
  // the candidate disagreeing — the company record would read the same band and
  // reach the same verdict, so neither it nor Atomus is bought.
  const h = harness([row("bigband", "Bigband Co", 40, [201, 500])]);
  const result = await runCapabilityPlan(h.deps as never, h.opts as never) as unknown as {
    state: Grounded; companies: Grounded[];
  };
  const [p] = result.state.prequalification.companies;
  assertEquals([p.size_status, p.exclusion, p.eligible, p.size_exclusion_basis],
    ["above_max", "employee_size", false, "disjoint_declared_band_at_discovery"]);
  assertEquals(result.state.prequalification.employee_size_excluded_at_discovery, 1);
  const [c] = result.companies;
  assertEquals([c.investigation_state, c.shortlist_exclusion],
    ["excluded_permanently", "mission_constraint:employee_size_disjoint_at_discovery"]);
  assert(!h.sent.some((s) => s.actor === "apify_linkedin_company_details"), "no company-details read");
  assert(!h.sent.some((s) => s.actor === "apify_funding_atomus"));
});

Deno.test("DISCOVERY/DETAIL DISAGREEMENT: the row says 11-50, the company record DECLARES 201-500 — not rejected early; the proven band fails it, no Atomus", async () => {
  // The fail path on the fact that decides it: the company record's declared
  // band, not the member count (here only 40), and not the discovery row.
  const h = harness([row("bigband", "Bigband Co", 40, [11, 50])], undefined,
    [row("bigband", "Bigband Co", 40, [201, 500])]);
  const result = await runCapabilityPlan(h.deps as never, h.opts as never) as unknown as { state: Grounded };
  const [p] = result.state.prequalification.companies;
  assertEquals([p.size_status, p.exclusion, p.eligible], ["in_range", null, true], "the discovery row cannot reject it");
  assert(h.sent.some((s) => s.actor === "apify_linkedin_company_details"), "the company record was read");
  const [c] = grounded(result);
  const size = c.hard_checks.find((x: Grounded) => x.dimension === "company_size")!;
  assertEquals(size.result, "fail");
  assertEquals(size.reason, "declared size band 201-500 is outside 11-50");
  assertEquals(c.eligibility, "ineligible");
  assertEquals(atomusTargets([c]), []);
  assert(!h.sent.some((s) => s.actor === "apify_funding_atomus"));
});

Deno.test("CANARY 87ecf153 REPLAY: an in-range candidate from the same search is viable, and so is the in-band canary row", async () => {
  const h = harness([row("inrange", "InRange Co", 30), ...CANARY_ROWS]);
  const result = await runCapabilityPlan(h.deps as never, h.opts as never);
  const cands = grounded(result);
  const viable = cands.find((c) => c.name === "InRange Co")!;
  assertEquals(viable.hard_checks.map((x: any) => [x.dimension, x.result]),
    [["geography", "pass"], ["company_size", "pass"], ["funding", "unknown"]]);
  // The pool is two candidates (run budget). ByteByteGo DECLARES 11-50 too, so
  // its 86 members no longer keep it from the verifier: both are viable.
  assertEquals(cands.length, 2);
  assertEquals(atomusTargets(cands).map((t) => t.name).sort(), ["ByteByteGo", "InRange Co"]);
});

Deno.test("SPENT ALLOWANCE: no discovery planning in this slice, and a forced replenishment slice plans and buys nothing", async () => {
  const h = harness(CANARY_ROWS);
  const first = await runCapabilityPlan(h.deps as never, h.opts as never) as unknown as { state: Record<string, any> };
  assertEquals(first.state.discovery_rows_bought, 2);
  assertEquals(first.state.discovery_source_state.stop_reason, "candidate_budget_spent");
  assertEquals(first.state.discovery_source_state.exhausted, true, "run-agent reads this as: no discovery route remains");
  assertEquals([h.calls.planDiscovery, h.calls.controlRoutes], [0, 0], "no model call plans a wave that cannot be bought");

  // The canary's worker scheduled a replenishment slice anyway; it must plan nothing.
  const before = h.sent.length;
  h.calls.planDiscovery = 0; h.calls.controlRoutes = 0;
  await runCapabilityPlan(h.deps as never, {
    ...h.opts, state: first.state,
    discoveryReplenishment: { reason: "replenishment_required", sources_attempted: ["apify_linkedin_company_search"], pages_taken: { apify_linkedin_company_search: 1 } },
  } as never);
  assertEquals(h.sent.length - before, 0, "no provider call");
  assertEquals([h.calls.planDiscovery, h.calls.controlRoutes], [0, 0], "no discovery-planning model call");
});

// ═══════════════════════════════ MISSION TRIAGE RANKS; IT NEVER REJECTS ══
//
// Canary 2978a5ba (local, 2026-09-24): the model triaged both candidates
// `irrelevant` — on a PLAUSIBLE self-reported headcount, on evidence nobody had
// bought yet, and on a soft Company Brain industry preference — and that
// verdict removed them before enrichment. AI decides what to investigate; code
// decides what is true.

/** The canary's own triage answer, reason for reason. */
const irrelevantBecause = (reasons: (key: string) => string[]): Triage => ({ company_keys }) => Promise.resolve({
  verdicts: company_keys.map((k) => ({
    company_key: k, relevance: "irrelevant", confidence: 0.99, signal_strength: 5, matched_roles: [], reasons: reasons(k),
  })),
});
const CANARY_2978_ROWS = [row("deadline-com", "Deadline Hollywood", 190), row("how-to-ai-guide", "How to AI", 100)];
const CANARY_2978_TRIAGE = irrelevantBecause((k) => [
  `Self-reported employee count is ${k.includes("deadline") ? 190 : 100}, clearly outside the mission's required range of 11–50.`,
  "No explicit United States location or recent funding evidence is provided.",
  "Entertainment news media does not align with the mission's stated B2B SaaS or fintech preferences.",
]);

Deno.test("CANARY 2978a5ba REPLAY: both triaged `irrelevant` still reach enrichment; size PASSES on the proven declared band", async () => {
  const h = harness(CANARY_2978_ROWS, CANARY_2978_TRIAGE);
  const result = await runCapabilityPlan(h.deps as never, h.opts as never) as unknown as {
    state: Record<string, any>; companies: Array<Record<string, any>>;
  };
  for (const c of result.companies) {
    assertEquals(c.triage?.relevance, "irrelevant", "the verdict is kept, as a ranking signal");
    assertEquals([c.shortlisted, c.shortlist_exclusion], [true, null], c.company.company_name);
    assert(c.investigation_state !== "excluded_permanently", c.company.company_name);
  }
  const details = h.sent.filter((s) => s.actor === "apify_linkedin_company_details");
  assertEquals((details[0]?.input.companies as string[] | undefined)?.length, 2, "both enriched");
  for (const c of grounded(result)) {
    const band = c.graph.claims.find((x: Grounded) => x.dimension === "company_size_band").current;
    assertEquals([band.status, band.authority?.rule], ["proven", "li_record_declared_size_band"], c.name);
    // Triage's "self-reported employee count is 190" was a member count; it decides nothing.
    assertEquals(c.hard_checks.find((x: Grounded) => x.dimension === "company_size")!.result, "pass", c.name);
    assertEquals(c.eligibility, "pending", c.name);
  }
  assertEquals(atomusTargets(grounded(result)).map((t) => t.name).sort(), ["Deadline Hollywood", "How to AI"],
    "viable on proven evidence, whatever triage said");
});

Deno.test("TRIAGE: missing evidence and a soft Brain industry never reject — an in-range company still reaches Atomus", async () => {
  // Triage calls it irrelevant for exactly the two reasons that may only rank.
  const h = harness([row("inrange", "InRange Co", 30)], irrelevantBecause(() => [
    "No explicit United States location or recent funding evidence is provided.",
    "Does not align with the mission's stated B2B SaaS or fintech preferences.",
  ]));
  const result = await runCapabilityPlan(h.deps as never, h.opts as never) as unknown as { companies: Array<Record<string, any>> };
  assertEquals(result.companies[0].triage?.relevance, "irrelevant");
  assert(h.sent.some((s) => s.actor === "apify_linkedin_company_details"), "enriched");
  const [c] = grounded(result);
  assertEquals(c.hard_checks.map((x: Grounded) => [x.dimension, x.result]),
    [["geography", "pass"], ["company_size", "pass"], ["funding", "unknown"]]);
  assertEquals(verificationTargets({ route_actor: "apify_funding_atomus", max_targets: 6 }, [c] as never,
    (id) => CRITERIA.find((x) => x.id === id)?.value, undefined, PROBE).map((t) => t.name), ["InRange Co"],
    "viable on proven evidence, so it may reach Atomus whatever triage said");
});

Deno.test("TRIAGE: no model-backed relevance field can close a candidate — the shortlist excludes only on a deterministic disqualifier", async () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/_shared/leadInvestigationBudget.ts", import.meta.url));
  const body = src.slice(src.indexOf("export function buildSmartShortlist"), src.indexOf("// ─", src.indexOf("export function buildSmartShortlist")));
  assert(!/relevance === "irrelevant"[\s\S]{0,200}excluded\.push/.test(body), "an irrelevant verdict never pushes an exclusion");
  const pushes = [...body.matchAll(/excluded\.push\(\{[^}]*reason: ([^,}]+)/g)].map((m) => m[1].trim());
  assert(pushes.every((r) => !/triage/.test(r)), JSON.stringify(pushes));
});
