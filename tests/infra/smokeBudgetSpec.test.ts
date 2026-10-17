// The smoke budget specification (from Codex's codex/smoke-budget-spec,
// updated after PR #90) must agree with what actually enforces it: the held
// admission migration's hard caps and the inactive worker proposal's settings.
// It is an inert document: nothing reads it at runtime, and it unlocks nothing.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parse } from "https://deno.land/std@0.224.0/yaml/mod.ts";
import spec from "../../docs/launch/discovery-smoke-budget.spec.json" with { type: "json" };

const root = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const sql = read("supabase/migrations-held/20261015140000_discovery_smoke_admission.sql");
const proposal = parse(read("docs/launch/proposals/discovery-test-worker.workflow.yml")) as {
  jobs: { worker: { env: Record<string, string> } };
};

/** `<column> <type> not null default N check (<column> between 0 and N)` from the held migration. */
function hardCap(column: string): number {
  const m = new RegExp(`${column}\\s+\\w+\\s+not null default (\\d+)\\s+check \\(${column} between 0 and (\\d+)\\)`).exec(sql);
  assert(m, `no hard cap for ${column}`);
  assertEquals(m[1], m[2], `${column}: default equals the ceiling`);
  return Number(m[1]);
}

Deno.test("smoke spec: one $0.25 authorization, split $0.20 provider / $0.05 model, five purchases, four attempts, 300 s", () => {
  const l = spec.limits;
  assertEquals(l.total_authorized_usd, 0.25);
  assertEquals(l.provider_committed_max_usd, 0.2);
  assertEquals(l.model_committed_max_usd, 0.05);
  assertEquals(l.provider_committed_max_usd + l.model_committed_max_usd, l.total_authorized_usd);
  assertEquals([l.provider_purchases, l.model_attempts, l.runtime_ms], [5, 4, 300000]);
  assertEquals([l.discovery_pages, l.provider_polls, l.slices], [1, 5, 2]);
  assertEquals([l.workspaces, l.workers, l.other_actors], [1, 1, 0]);
});

Deno.test("smoke spec: every limit equals the held migration's hard cap", () => {
  const l = spec.limits;
  assertEquals(hardCap("total_microusd"), Math.round(l.total_authorized_usd * 1e6));
  assertEquals(hardCap("provider_microusd"), Math.round(l.provider_committed_max_usd * 1e6));
  assertEquals(hardCap("model_microusd"), Math.round(l.model_committed_max_usd * 1e6));
  assertEquals(hardCap("provider_purchases"), l.provider_purchases);
  assertEquals(hardCap("model_attempts"), l.model_attempts);
  assertEquals(hardCap("discovery_pages"), l.discovery_pages, "the page cap is its own counter");
  assertEquals(hardCap("provider_polls"), l.provider_polls, "polls are their own counter");
  assert(sql.includes("deadline_at <= authorized_at + interval '300 seconds'"), "the deadline is at most 300 s");
  const actorSum = Object.values(l.provider_actor_purchases).reduce((a, b) => a + b, 0);
  assert(actorSum <= l.provider_purchases, "actor allowances fit inside the purchase cap");
});

Deno.test("smoke spec: the inactive worker proposal sets exactly the candidate environment", () => {
  const env = proposal.jobs.worker.env;
  for (const [k, v] of Object.entries(spec.candidate_environment_spec_not_applied)) {
    assertEquals(env[k], v, `${k} in the worker proposal`);
  }
  assertEquals(Number(env.LEAD_V2_MISSION_PROVIDER_USD_CAP), spec.limits.provider_committed_max_usd);
  assertEquals(Number(env.LEAD_V2_MISSION_CREDIT_CAP), spec.limits.provider_purchases);
  assertEquals(Number(env.MODEL_SPEND_CEILING_USD), spec.limits.model_committed_max_usd);
  assertEquals(Number(env.MODEL_RUN_MAX_CALLS) * spec.limits.slices, spec.limits.model_attempts);
  assertEquals(Number(env.LEAD_MAX_AUTO_CONTINUATIONS) + 1, spec.limits.slices);
  assert(Number(env.LEAD_WORKER_MAX_RUNTIME_MS) * spec.limits.slices <= spec.limits.runtime_ms);
  assert(/secrets\.TEST_OPENAI_API_KEY/.test(env.OPENAI_API_KEY ?? ""), "gptProvider needs a TEST_ OpenAI key");
});

Deno.test("smoke spec: the first smoke omits Firecrawl; an unset rate would still refuse it", async () => {
  const env = proposal.jobs.worker.env;
  for (const k of ["FIRECRAWL_API_KEY", "FIRECRAWL_USD_PER_CREDIT", "FIRECRAWL_PRICE_TIER"]) assert(!(k in env), `${k} is not mapped`);
  const p = spec.first_smoke_profile;
  assert(!Object.keys(p.actor_limits).some((a) => a.startsWith("firecrawl:")), "no Firecrawl allowance");
  assert(p.omitted.includes("firecrawl:scrape") && p.omitted.includes("firecrawl:map"));
  assertEquals(spec.activation_gate.firecrawl_included, false);
  // Defence in depth: were a key ever mapped without a rate, a capped run refuses.
  const { webEvidenceCreditRate } = await import("../../supabase/functions/_shared/webEvidenceSpec.ts");
  for (const unset of ["", undefined, "0", "-1", "abc"]) {
    assertEquals(webEvidenceCreditRate(() => unset, { usd_capped: true }), { usd_per_credit: null, basis: "unpriced" }, String(unset));
  }
});

Deno.test("smoke spec: the smoke buys one job search (one title, one location, three rows) and one company-details lookup", () => {
  const p = spec.first_smoke_profile;
  assertEquals(p.actor_limits, { "apify:harvestapi~linkedin-job-search": 1, "apify:harvestapi~linkedin-company": 1 });
  assertEquals(p.job_search_request, { jobTitles: 1, locations: 1, geoIds: 0, maxItems: 3 });
  assertEquals(p.job_search_request.maxItems, spec.limits.discovery_rows);
  // The company-details actor bills per company looked up, by URL or by name.
  assertEquals(p.company_details_request, { companies: 1, searches: 0 });
  assertEquals(p.reads.total, spec.limits.provider_polls);
  assertEquals(Object.values(p.reads.allocation).reduce((a, b) => a + b, 0), spec.limits.provider_polls, "3 + 2 = the five");
  assertEquals(Object.keys(p.reads.allocation).sort(), Object.keys(p.actor_limits).sort(), "a share for each actor");
  for (const [a, n] of Object.entries(p.actor_limits)) {
    assert(n <= (spec.limits.provider_actor_purchases as Record<string, number>)[a], `${a} within its allowance`);
  }
  assertEquals(p.models.approved, ["openai:gpt-5.6-luna"]);
});

Deno.test("smoke spec: activation stays blocked until the target, prices and a separate approval exist", () => {
  assertEquals(spec.status, "BLOCKED");
  assertEquals(spec.authorizes_execution, false);
  const g = spec.activation_gate;
  assertEquals(g.ready, false);
  assert(g.separate_execution_approval_required);
  assert(g.worker_proposal_remains_inactive);
  for (const k of ["held_migration_applied_anywhere", "isolated_test_target_provisioned", "all_required_prices_verified",
    "approved_quote_catalog_reviewed", "live_receipts_and_credits_reconciled", "firecrawl_included"] as const) {
    assertEquals(g[k], false, k);
  }
  assert(spec.enforcement.actual_vendor_charge_maximum.startsWith("BLOCKED"));
});

Deno.test("smoke spec: an inert document; no workflow reads it or turns a smoke switch on", () => {
  for (const f of Deno.readDirSync(new URL(".github/workflows/", root))) {
    const text = read(`.github/workflows/${f.name}`);
    assert(!text.includes("discovery-smoke-budget.spec.json"), f.name);
    for (const k of ["LEAD_V2_SMOKE_WALL_CLOCK", "DISCOVERY_SMOKE_ADMISSION"]) assert(!text.includes(k), `${f.name}: ${k}`);
  }
  for (const f of ["railway.json", "worker/Dockerfile"]) {
    const text = read(f);
    for (const k of ["LEAD_V2_SMOKE_WALL_CLOCK", "DISCOVERY_SMOKE_ADMISSION"]) assert(!text.includes(k), `${f}: ${k}`);
  }
});
