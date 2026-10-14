// LEAD V2 P6 — THE FUNDING-STAGE VERIFIER, AND THE CLAIM-VERIFIER CONTRACT IT RUNS ON.
//
// Rule under test (never weakened to make a verdict appear):
//
//   PASS Seed  ⇐ latest trustworthy round = Seed
//              AND the history is complete enough to rule out a later round
//              AND a source CITES the decisive round
//   FAIL Seed  ⇐ a trustworthy Series A+ round
//   PENDING    ⇐ incomplete, conflicting or missing
//
// Corroboration is tested on the REAL payloads the two providers returned on
// 2026-09-19 (`tests/fixtures/lead-v2/p6-funding-probes.json`); the verifier and
// the ledger with injected calls. No network.

import { assert, assertEquals, assertFalse, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  atomusSettles, corroborateFunding, decideCorroboratedFundingStage,
  normalizeAtomusFunding, normalizePvalyouFunding,
} from "../../../supabase/functions/_shared/fundingCorroboration.ts";
import { decideFundingStage, type FundingRecordFact } from "../../../supabase/functions/_shared/fundingStageClaim.ts";
import {
  atomusInput, FUNDING_STAGE_VERIFIER_KEY, fundingStageVerifier,
} from "../../../supabase/functions/_shared/fundingStageVerifier.ts";
import {
  attemptedRoutes, ledgerBoundCall, verificationTargets, verifyOpKey,
  type VerificationTarget, type VerifierCall, type VerifierCallOutcome, type VerifierDeps,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import { newSpendLedger, DEFAULT_CEILINGS, estimateCallUsd } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { tightenCeilings } from "../../../supabase/functions/_shared/runBudget.ts";
import { verifierSpecCompiler } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { guardedInvoker } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { specIdentityColumns } from "../../../supabase/functions/_shared/executionLedger.ts";
import type { ProviderCallSpec } from "../../../supabase/functions/_shared/providerCallSpec.ts";
import { CLAIM_REGISTRY, evidenceGapsFor, type ClaimDefinition } from "../../../supabase/functions/_shared/evidenceGapRouter.ts";
import { buildCompanyEvidenceGraph } from "../../../supabase/functions/_shared/evidenceGraph.ts";
import type { EvidenceItem } from "../../../supabase/functions/_shared/candidateObservation.ts";
import { applyVerifierFinding, missionCandidatesFrom } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { checkCriterion } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { fundingVerifierReady } from "../../../supabase/functions/_shared/missionCriteria.ts";
import type { MissionCriterion } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { PRODUCTION_READINESS, readinessPolicy } from "../../../supabase/functions/_shared/routeReadiness.ts";

globalThis.fetch = () => { throw new Error("P6 verifier tests must not reach the network"); };

const FX = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/lead-v2/p6-funding-probes.json", import.meta.url)));
const ATOMUS = (FX.atomus as Record<string, unknown>[]).map(normalizeAtomusFunding);
const PVALYOU = (FX.pvalyou as Record<string, unknown>[]).map(normalizePvalyouFunding);
const at = (slug: string) => ATOMUS.find((r) => r.input === slug)!.record;
const pv = (domain: string) => PVALYOU.find((r) => r.input === domain)!.record;

// ═══════════════════════════════════════════ corroboration, on real payloads ══

Deno.test("Wordware: atomus complete (3/3, latest Seed) + pvalyou cites that Seed round → PASS", () => {
  const { decision, corroboration } = decideCorroboratedFundingStage({ required_stage: "seed", atomus: at("wordware"), pvalyou: pv("wordware.ai") });
  assertEquals([decision.verdict, decision.reasons], ["pass", ["required_stage_verified_and_latest"]]);
  assertEquals(corroboration.corroborated_rounds, 1);
  assertEquals(corroboration.conflicts, []);
  assert(decision.carrier_rounds[0].source_urls.includes("https://blog.wordware.ai/seed-round"), "cites the company's own announcement");
});

Deno.test("Stripe and Cal.com: a verified later round settles FAIL from atomus alone", () => {
  assertEquals(atomusSettles("seed", at("stripe"))?.verdict, "fail");
  assertEquals(atomusSettles("seed", at("cal-com"))?.reasons, ["later_round_verified"]);
});

Deno.test("no rounds, or no record, is PENDING — absence is never a verdict", () => {
  for (const slug of ["dioptra", "37signals"]) {
    assertEquals(decideCorroboratedFundingStage({ required_stage: "seed", atomus: at(slug), pvalyou: null }).decision.verdict, "pending", slug);
  }
  assertEquals(ATOMUS.find((r) => r.input === "plausible-insights")!.record, null, "not_found is no record at all");
  assertEquals(decideCorroboratedFundingStage({ required_stage: "seed", atomus: null, pvalyou: null }).decision.verdict, "pending");
});

Deno.test("PASS MUST CITE: atomus alone, complete and latest Seed, is PENDING — the default rule is unchanged", () => {
  const strict = decideFundingStage({ required_stage: "seed", record: at("wordware"), pass_requires_source_url: true });
  assertEquals([strict.verdict, strict.reasons], ["pending", ["required_stage_uncorroborated"]]);
  // Every existing caller (no flag) keeps its behaviour: a dated round verifies.
  assertEquals(decideFundingStage({ required_stage: "seed", record: at("wordware") }).verdict, "pass");
});

Deno.test("pvalyou alone can never PASS: its round count is only what it holds", () => {
  // The normalizer's contract: stripe.com HOLDS 7 rounds of ~23, so no count is ever taken from it.
  assertEquals(pv("stripe.com")!.reported_round_count, null);
  assertEquals(pv("wordware.ai")!.reported_round_count, null);
  const d = decideCorroboratedFundingStage({ required_stage: "seed", atomus: null, pvalyou: pv("wordware.ai") }).decision;
  assertEquals([d.verdict, d.reasons], ["pending", ["history_incomplete"]]);
});

const round = (type: string, date: string, urls: string[] = []) => ({
  round_type: type, announced_date: date, amount_usd: null, investors: [], source_urls: urls, method: "provider_field" as const,
});
const rec = (actor: string, rounds: ReturnType<typeof round>[], reported: number | null): FundingRecordFact => ({
  provider: "apify", actor, rounds, reported_round_count: reported, history_complete: null, observed_at: null, source_url: null,
});

Deno.test("atomus is weeks stale: a CITED later round pvalyou holds and atomus lacks FAILS the claim", () => {
  const atomus = rec("apify_funding_atomus", [round("SEED_ROUND", "2025-03-01")], 1);
  const pvalyou = rec("apify_funding_pvalyou", [
    round("Seed", "2025-03-01", ["https://acme.com/seed"]), round("Series A", "2026-08-20", ["https://techcrunch.com/acme-a"]),
  ], null);
  const { decision, corroboration } = decideCorroboratedFundingStage({ required_stage: "seed", atomus, pvalyou });
  assertEquals(decision.verdict, "fail");
  assertEquals(corroboration.conflicts, ["round_not_in_atomus:series-a@2026-08-20"]);
});

Deno.test("sources that disagree on a rung withdraw completeness: PENDING, never a guessed PASS", () => {
  const atomus = rec("apify_funding_atomus", [round("SEED_ROUND", "2025-03-01")], 1);
  const pvalyou = rec("apify_funding_pvalyou", [round("Pre-Seed", "2025-03-10", ["https://x.com/a"])], null);
  const { decision, corroboration } = decideCorroboratedFundingStage({ required_stage: "seed", atomus, pvalyou });
  assertEquals(corroboration.record?.reported_round_count, null);
  assertEquals(corroboration.conflicts[0].startsWith("rung_mismatch:seed_vs_pre-seed"), true);
  assertEquals(decision.verdict, "pending");
});

Deno.test("a match needs the same rung within the date window; non-ordinal rounds neither confirm nor contradict", () => {
  const atomus = rec("apify_funding_atomus", [round("SEED_ROUND", "2025-03-01")], 1);
  const far = corroborateFunding({ atomus, pvalyou: rec("p", [round("Seed", "2024-01-01", ["u"])], null) });
  assertEquals(far.corroborated_rounds, 0, "same rung, 14 months apart, is another round");
  const grant = corroborateFunding({ atomus, pvalyou: rec("p", [round("Grant", "2025-03-01", ["u"]), round("Accelerator", "2024-07-01", ["u"])], null) });
  assertEquals([grant.conflicts, grant.record?.reported_round_count], [[], 1]);
});

// ══════════════════════════════════════════════════════════ the verifier ══

type Row = Record<string, unknown>;
function fakeDeps(o: {
  atomus?: (input: Record<string, unknown>) => VerifierCallOutcome;
  pvalyou?: (input: Record<string, unknown>, resume: string | null) => VerifierCallOutcome;
  ready?: (k: string) => boolean;
}) {
  const calls: VerifierCall[] = [];
  const deps: VerifierDeps = {
    call: (c) => {
      calls.push(c);
      if (c.actor_key === "apify_funding_atomus") return Promise.resolve(o.atomus ? o.atomus(c.input) : { status: "failed", reason: "no atomus" });
      return Promise.resolve(o.pvalyou ? o.pvalyou(c.input, c.resume_run_id ?? null) : { status: "failed", reason: "no pvalyou" });
    },
    ready: o.ready ?? (() => true),
    now: () => "2026-09-19T12:00:00.000Z",
    log: () => {},
  };
  return { deps, calls };
}
const ok = (rows: Row[], id = "pc_x"): VerifierCallOutcome => ({ status: "ok", rows, provider_call_id: id });
const atomusRow = (slug: string) => (FX.atomus as Row[]).find((r) => r.input === slug)!;
const pvRow = (domain: string) => (FX.pvalyou as Row[]).find((r) => r.query === domain)!;
const target = (key: string, li: string | null, domain: string | null, evidence: EvidenceItem[] = []): VerificationTarget => ({
  company_key: key, name: key, domain, linkedin_url: li,
  criterion: { criterion_id: "company_stage:seed", dimension: "company_stage", value: "seed" },
  graph: buildCompanyEvidenceGraph(key, evidence),
});
/** atomus echoes the input it was sent; the fixture rows were read by slug. */
const echo = (row: Row, sent: string): Row => ({ ...row, input: sent });

Deno.test("cheapest first: atomus settles Stripe's FAIL; only Wordware goes on to pvalyou, and PASSES", async () => {
  const stripe = target("stripe", "https://www.linkedin.com/company/stripe", "stripe.com");
  const wordware = target("wordware", "https://www.linkedin.com/company/wordware", "wordware.ai");
  const { deps, calls } = fakeDeps({
    atomus: (input) => ok((input.companies as string[]).map((u) =>
      echo(atomusRow(u.endsWith("/stripe") ? "stripe" : "wordware"), u)), "pc_atomus"),
    pvalyou: () => ok([pvRow("wordware.ai")], "pc_pv"),
  });
  const r = await fundingStageVerifier().verify([stripe, wordware], deps, { mission_id: "t", pending: [] });
  assertEquals(calls.map((c) => [c.actor_key, (c.input.companies as string[]).length]),
    [["apify_funding_atomus", 2], ["apify_funding_pvalyou", 1]], "one atomus batch; pvalyou only for the unsettled company");
  const by = (k: string) => r.findings.find((f) => f.company_key === k)!;
  assertEquals([by("stripe").detail.verdict, by("stripe").item?.status], ["fail", "disproven"]);
  assertEquals([by("wordware").detail.verdict, by("wordware").item?.status], ["pass", "proven"]);
  assertEquals(by("wordware").item?.source.url, "https://blog.wordware.ai/seed-round");
  assert(r.findings.every((f) => f.answered));
});

Deno.test("a pvalyou cold read outlives the slice: the run is carried, adopted by id next slice, never re-bought", async () => {
  const wordware = target("wordware", "https://www.linkedin.com/company/wordware", "wordware.ai");
  let started = 0;
  const first = fakeDeps({
    atomus: (input) => ok([echo(atomusRow("wordware"), (input.companies as string[])[0])]),
    pvalyou: (_i, resume) => { if (!resume) started++; return { status: "running", run_id: "run_pv_1", provider_call_id: "pc_pv" }; },
  });
  const r1 = await fundingStageVerifier().verify([wordware], first.deps, { mission_id: "t", pending: [] });
  assertEquals(r1.findings, [], "no verdict while the citation is still being read");
  assertEquals(r1.pending.map((p) => [p.verifier, p.stage, p.run_id]), [[FUNDING_STAGE_VERIFIER_KEY, "pvalyou", "run_pv_1"]]);

  // Next slice: the router still routes Wordware here, but it is in flight — adopt, do not restart.
  const second = fakeDeps({
    atomus: () => { throw new Error("atomus must not be bought again"); },
    pvalyou: (_i, resume) => { assertEquals(resume, "run_pv_1"); return ok([pvRow("wordware.ai")]); },
  });
  const r2 = await fundingStageVerifier().verify([wordware], second.deps, { mission_id: "t", pending: r1.pending });
  assertEquals(second.calls.map((c) => [c.actor_key, c.resume_run_id]), [["apify_funding_pvalyou", "run_pv_1"]]);
  assertEquals(r2.findings.map((f) => f.detail.verdict), ["pass"]);
  assertEquals(r2.pending, []);
  assertEquals(started, 1);
});

Deno.test("no citation available (pvalyou refused or not READY): atomus decides alone — PENDING at best, and answered", async () => {
  const wordware = target("wordware", "https://www.linkedin.com/company/wordware", "wordware.ai");
  const refused = fakeDeps({
    atomus: (input) => ok([echo(atomusRow("wordware"), (input.companies as string[])[0])]),
    pvalyou: () => ({ status: "refused", reason: "429 insufficient credit" }),
  });
  const r = await fundingStageVerifier().verify([wordware], refused.deps, { mission_id: "t", pending: [] });
  assertEquals([r.findings[0].detail.verdict, r.findings[0].item, r.findings[0].answered], ["pending", null, true]);

  const notReady = fakeDeps({
    atomus: (input) => ok([echo(atomusRow("wordware"), (input.companies as string[])[0])]),
    ready: (k) => k === "apify_funding_atomus",
  });
  const r2 = await fundingStageVerifier().verify([wordware], notReady.deps, { mission_id: "t", pending: [] });
  assertEquals(notReady.calls.map((c) => c.actor_key), ["apify_funding_atomus"]);
  assertEquals(r2.findings[0].detail.reasons, ["required_stage_uncorroborated"]);
});

Deno.test("a company without a LinkedIn page skips atomus; pvalyou alone can FAIL or stay PENDING, never PASS", async () => {
  const noPage = target("wordware", null, "wordware.ai");
  const { deps, calls } = fakeDeps({ pvalyou: () => ok([pvRow("wordware.ai")]) });
  const r = await fundingStageVerifier().verify([noPage], deps, { mission_id: "t", pending: [] });
  assertEquals(calls.map((c) => c.actor_key), ["apify_funding_pvalyou"]);
  assertEquals([r.findings[0].detail.verdict, r.findings[0].detail.reasons], ["pending", ["history_incomplete"]]);
});

Deno.test("atomus is sent the canonical LinkedIn URL (bare domains are not supported)", () => {
  assertEquals(atomusInput("https://www.linkedin.com/company/Wordware/about/"), "https://www.linkedin.com/company/wordware");
  assertEquals(atomusInput("wordware.ai"), null);
});

// ═══════════════════════════════════════════════════ ledger-bound calls ══

/** The pair authorised, as a supervised canary would name it. */
const PAIR_ALLOWED_POLICY = readinessPolicy({ allow_experimental: [
  "apify_funding_atomus|funding_verification", "apify_funding_pvalyou|funding_verification",
] });
/**
 * The pair as it was before the 2026-09-23 spine canary earned READY: what a
 * mission sees whenever the table says the pair may not run. The gate these
 * tests pin is readiness, whatever the table says today.
 */
const PAIR_NOT_READY = readinessPolicy({ overrides: {
  "apify_funding_atomus|funding_verification": "EXPERIMENTAL",
  "apify_funding_pvalyou|funding_verification": "EXPERIMENTAL",
} });
const FUNDING_POLICY = criteriaExecutionPolicy(parseLeadMissionDeterministic("Find seed-stage B2B SaaS companies"));

type SentCall = { actorKey: string; capabilityId: string; input: Record<string, unknown>; providerCallSpec: ProviderCallSpec; resumeRunId?: string };
function ledgerHarness(
  invoke: (c: SentCall) => Promise<Record<string, unknown>[]>,
  readiness = PAIR_ALLOWED_POLICY,
) {
  const ledger = newSpendLedger(DEFAULT_CEILINGS);
  const refused: string[] = [];
  const sent: SentCall[] = [];
  const call = ledgerBoundCall({
    ledger,
    spec: verifierSpecCompiler({
      scope: { workspace_id: "ws", lineage_id: "ln" }, mission_hash: "mh", policy: FUNDING_POLICY,
      ceilings: () => ledger.ceilings, readiness,
    }),
    actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
    invoke: guardedInvoker(null, (c: SentCall) => { sent.push(c); return invoke(c); }, undefined, readiness),
    hash: () => "h", onRefused: (k) => refused.push(k),
  });
  return { ledger, call, refused, sent, invoked: () => sent.length };
}
const pvCall = (companies: string[], resume?: string): VerifierCall => ({
  actor_key: "apify_funding_pvalyou", capability: "funding_verification", input: { tier: "basic", companies },
  candidate_keys: companies, purpose: "funding_evidence",
  ...(resume ? { resume_run_id: resume } : {}),
});

Deno.test("an executed call is never bought twice; a running one is adopted by its run id", async () => {
  const h = ledgerHarness((c) => c.resumeRunId ? Promise.resolve([{ ok: 1 }]) : Promise.reject(Object.assign(new Error("apify_run_running"), { toolResult: { run_id: "r1", pending: true } })));
  const first = await h.call(pvCall(["a.com"]));
  assertEquals(first.status, "running");
  assertEquals((await h.call(pvCall(["a.com"]))).status, "failed", "the same call, not adopted, is refused rather than re-bought");
  assertEquals((await h.call(pvCall(["a.com"], "r1"))).status, "ok");
  assertEquals(h.invoked(), 2);
  const key = h.sent[0].providerCallSpec.idempotency_key;
  assertEquals(h.sent[1].providerCallSpec.idempotency_key, key, "the adopted call is the same purchase");
  assertEquals(h.ledger.reservations.filter((r) => r.idempotency_key === key).length, 1, "one reservation for the call");
});

Deno.test("SPINE: the spec is compiled, reserved under its own key, and travels in the envelope", async () => {
  const h = ledgerHarness(() => Promise.resolve([{ ok: 1 }]));
  const out = await h.call(pvCall(["wordware.ai"]));
  assertEquals(out.status, "ok");
  const [sent] = h.sent;
  const spec = sent.providerCallSpec;
  // What the ledger row reads (`specIdentityColumns`) is what the verifier was told.
  assertEquals((out as { provider_call_id: string }).provider_call_id, spec.provider_call_id);
  assertEquals(specIdentityColumns({ provider_call_spec: spec }).provider_call_id, spec.provider_call_id);
  assertEquals([spec.capability, spec.purpose, spec.status], ["funding_verification", "funding_evidence", "intended"]);
  assertEquals(sent.capabilityId, "funding_verification", "the guard is told the capability");
  // Sent exactly what was compiled.
  assertEquals(sent.input, spec.serialized_input);
  // The estimate is the card's price × billable units, and it is what was reserved.
  const card = hiringActorCard("apify_funding_pvalyou")!;
  assertEquals(spec.cost.estimate_usd, estimateCallUsd("apify_funding_pvalyou", card.cost_model, { tier: "basic", companies: ["x"] }));
  const r = h.ledger.reservations.find((x) => x.idempotency_key === spec.idempotency_key)!;
  assertEquals([r.provider_call_id, r.estimate_usd, r.status], [spec.provider_call_id, spec.cost.estimate_usd, "executed"]);
});

Deno.test("SPINE: a pair the mission may not run is refused at the spec — no reservation, no network", async () => {
  // A not-ready pair that nothing names.
  const h = ledgerHarness(() => Promise.resolve([{ ok: 1 }]), PAIR_NOT_READY);
  const r = await h.call(pvCall(["a.com"]));
  assertEquals(r.status, "refused");
  assert((r as { reason: string }).reason.startsWith("spec_refused_policy"), (r as { reason: string }).reason);
  assertEquals(h.invoked(), 0);
  assertEquals(h.ledger.reservations.length, 0);
});

Deno.test("SPINE: the guard refuses a plan-less verifier call its readiness does not allow", async () => {
  let reached = 0;
  const g = guardedInvoker(null, () => { reached++; return Promise.resolve([]); }, undefined, PAIR_NOT_READY);
  await assertRejects(() => g({ actorKey: "apify_funding_atomus", capabilityId: "funding_verification" } as never));
  assertEquals(reached, 0);
  // …and a plan-less call that is not a claim verifier is exactly as before.
  await g({ actorKey: "apify_funding_atomus", capabilityId: "something_else" } as never);
  assertEquals(reached, 1);
});

Deno.test("SPINE: an actor with no card price is unaffordable, never free", () => {
  const spec = verifierSpecCompiler({
    scope: { workspace_id: "ws", lineage_id: "ln" }, mission_hash: "mh", policy: FUNDING_POLICY,
    ceilings: () => DEFAULT_CEILINGS, readiness: readinessPolicy({ mode: "provider_probe", probe_routes: ["apify_unpriced|funding_verification"] }),
  })({ actor_key: "apify_unpriced", capability: "funding_verification", input: { companies: ["a"] }, candidate_keys: ["a"], purpose: "funding_evidence" });
  assertFalse(spec.status === "intended");
});

Deno.test("a deterministic refusal releases the reservation and is remembered for the mission", async () => {
  const h = ledgerHarness(() => Promise.reject(new Error("apify_actor_disabled_by_default")));
  assertEquals((await h.call(pvCall(["a.com"]))).status, "refused");
  assertEquals(h.refused, ["apify_funding_pvalyou"]);
  assertEquals(h.ledger.reservations.every((r) => r.status === "released"), true);
});

Deno.test("a call over the funding-evidence ceiling is refused at the spec, before any reservation or network", async () => {
  const h = ledgerHarness(() => Promise.resolve([]));
  const r = await h.call(pvCall(["a.com", "b.com", "c.com"]));
  assertEquals(r.status, "refused");
  assert((r as { reason: string }).reason.startsWith("spec_refused_budget"), (r as { reason: string }).reason);
  assertEquals(h.invoked(), 0);
  assertEquals(h.ledger.reservations.length, 0);
});

Deno.test("a run budget lowers the ceiling a verifier call is compiled against", async () => {
  const ledger = newSpendLedger(tightenCeilings(DEFAULT_CEILINGS, { provider_usd: 0.01, max_candidates: null }));
  const call = ledgerBoundCall({
    ledger,
    spec: verifierSpecCompiler({
      scope: { workspace_id: "ws", lineage_id: "ln" }, mission_hash: "mh", policy: FUNDING_POLICY,
      ceilings: () => ledger.ceilings, readiness: PAIR_ALLOWED_POLICY,
    }),
    actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
    invoke: () => Promise.resolve([{ ok: 1 }]), hash: () => "h",
  });
  // One basic pvalyou read is priced above a $0.01 budget; atomus is not.
  assertEquals((await call(pvCall(["a.com"]))).status, "refused");
  assertEquals((await call({ actor_key: "apify_funding_atomus", capability: "funding_verification",
    input: { companies: ["https://www.linkedin.com/company/a"] }, candidate_keys: ["a"], purpose: "funding_evidence" })).status, "ok");
});

Deno.test("TRACE: a verifier call leaves the same pre-execution trail as an engine call", async () => {
  const run = async (invoke: () => Promise<Record<string, unknown>[]>, budget: number | null, readiness = PAIR_ALLOWED_POLICY) => {
    const ledger = newSpendLedger(tightenCeilings(DEFAULT_CEILINGS, budget === null ? null : { provider_usd: budget, max_candidates: null }));
    const events: { type: string; detail: Record<string, unknown>; refs: { provider_call_id: string | null; idempotency_key: string | null } }[] = [];
    const call = ledgerBoundCall({
      ledger,
      spec: verifierSpecCompiler({
        scope: { workspace_id: "ws", lineage_id: "ln" }, mission_hash: "mh", policy: FUNDING_POLICY,
        ceilings: () => ledger.ceilings, readiness,
      }),
      actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
      invoke, hash: () => "h",
      trace: (type, detail, refs) => events.push({ type, detail, refs }),
    });
    const out = await call(pvCall(["a.com"]));
    return { out, events, types: events.map((e) => e.type) };
  };

  // Executed: compiled → reserved at the estimate → executed, all under one call id.
  const ok = await run(() => Promise.resolve([{ ok: 1 }]), null);
  assertEquals(ok.types, ["spec_compiled", "call_reserved", "call_executed"]);
  const pcid = (ok.out as { provider_call_id: string }).provider_call_id;
  assert(pcid, "the call has an id");
  for (const e of ok.events) {
    assertEquals(e.refs.provider_call_id, pcid, `${e.type} names the call`);
    assert(e.refs.idempotency_key, `${e.type} names the key`);
    assertEquals(e.detail.actor, "apify_funding_pvalyou");
  }
  assertEquals(ok.events[1].detail.estimate_usd, ok.events[0].detail.estimate_usd, "reserved what was estimated");

  // Over a run budget: compiled, then refused by the ledger — never executed.
  const over = await run(() => Promise.resolve([{ ok: 1 }]), 0.01);
  assertEquals(over.out.status, "refused");
  assert(!over.types.includes("call_executed"));
  assertEquals(over.types.at(-1), over.types.includes("spec_refused") ? "spec_refused" : "call_refused_budget");

  // Not permitted by readiness: refused at the spec, nothing after it.
  const gated = await run(() => Promise.resolve([{ ok: 1 }]), null, PAIR_NOT_READY);
  assertEquals(gated.types, ["spec_refused"]);

  // A provider failure after reservation releases or fails — it is never silent.
  const failed = await run(() => Promise.reject(new Error("boom")), null);
  assertEquals(failed.types.slice(0, 2), ["spec_compiled", "call_reserved"]);
  assert(["call_failed", "call_released"].includes(failed.types[2]), failed.types.join(","));
});

// ═════════════════════════════════════ targets, marks and the router ══

const NOW = new Date("2026-09-19T12:00:00.000Z");
const US = { evidence_id: "geo", company_key: "c", dimension: "geography" as const, value: "US", status: "proven" as const,
  source: { provider: "apify", actor: "linkedin", provider_call_id: null, url: null, excerpt: null },
  method: "provider_field" as const, observed_at: NOW.toISOString(), valid_until: null, confidence: "high" as const,
  derived_from: [], mission_id: "t", origin: "lead_mission" as const };
/** A registry whose funding route uses a READY actor, standing in for the proven pair. */
const READY: ClaimDefinition[] = CLAIM_REGISTRY.map((c) => c.claim !== "funding_stage" ? c : {
  ...c, routes: [{ ...c.routes[0], actor: "apify_linkedin_job_search", capability: "hiring_verification" }],
});
const cand = (key: string, over: Partial<Parameters<typeof verificationTargets>[1][number]> = {}) => ({
  company_key: key, name: key, domain: `${key}.com`, linkedin_url: null,
  graph: buildCompanyEvidenceGraph(key, [{ ...US, company_key: key }], { now: NOW }),
  eligibility: "pending" as const,
  hard_checks: [{ criterion_id: "company_stage:seed", dimension: "company_stage", result: "unknown", reason: "no funding" }],
  attempted_routes: [] as string[], ...over,
});
const verifier = { route_actor: "apify_linkedin_job_search", max_targets: 6 };

Deno.test("targets are ONLY pending companies whose hard gap routes to this verifier, not yet answered", () => {
  const picked = verificationTargets(verifier, [
    cand("a"),
    cand("b", { eligibility: "eligible" }),
    cand("c", { attempted_routes: ["apify_linkedin_job_search"] }),
    cand("d", { hard_checks: [{ criterion_id: "geography:us", dimension: "geography", result: "unknown", reason: "?" }] }),
  ], () => "seed", READY);
  assertEquals(picked.map((t) => [t.company_key, t.criterion.value]), [["a", "seed"]]);
  // A not-ready pair makes nobody a target; the READY production pair does.
  const pair = { route_actor: "apify_funding_atomus", max_targets: 6 };
  assertEquals(verificationTargets(pair, [cand("a")], () => "seed", undefined, PAIR_NOT_READY), []);
  assertEquals(verificationTargets(pair, [cand("a")], () => "seed").map((t) => t.company_key), ["a"]);
});

Deno.test("a verifier's answer survives into the next slice: evidence recorded, route marked, router blocked", () => {
  const company = {
    key: "wordware", company: { company_name: "Wordware", linkedin_company_url: "https://www.linkedin.com/company/wordware", canonical_domain: "wordware.ai", website: null, geography: null, external_source_id: "w" },
    observations: [], evidence_registry: null, hiring_jobs: [], hiring_assessment: null, first_in_function: null,
    enriched: null, identity: null, found_by: [], completed_operations: [] as string[], grounded: null,
    investigation_state: "investigated", verdict: null, brain: null, prequalified: null, shortlist_exclusion: null,
  };
  const { decision, corroboration } = decideCorroboratedFundingStage({ required_stage: "seed", atomus: at("wordware"), pvalyou: pv("wordware.ai") });
  const f = {
    company_key: "wordware", answered: true, detail: {},
    item: { evidence_id: "fnd_wordware_funding_stage", company_key: "wordware", dimension: "company_stage" as const,
      value: { claim: "funding_stage", required_stage: "seed", verdict: decision.verdict, latest_verified_stage: decision.highest_verified_stage,
        reasons: decision.reasons, explanation: decision.explanation, rounds_cited: [] },
      status: "proven" as const, source: { provider: "apify", actor: corroboration.record!.actor, provider_call_id: "pc", url: "https://blog.wordware.ai/seed-round", excerpt: null },
      method: "deterministic_derivation" as const, observed_at: NOW.toISOString(), valid_until: null, confidence: "high" as const,
      derived_from: [], mission_id: "t", origin: "lead_mission" as const },
  };
  assert(applyVerifierFinding(company as never, f, { key: "k", route_actor: "apify_funding_atomus" }));
  applyVerifierFinding(company as never, f, { key: "k", route_actor: "apify_funding_atomus" });
  assertEquals(company.completed_operations, [verifyOpKey("apify_funding_atomus")], "marked once");
  assertEquals(attemptedRoutes(company.completed_operations), ["apify_funding_atomus"]);
  const [c] = missionCandidatesFrom({ companies: [company as never] }, { missionId: "t", now: NOW });
  assertEquals(c.attempted_routes, ["apify_funding_atomus"]);
  const criterion = { id: "company_stage:seed", kind: "hard", dimension: "company_stage", value: "seed", label: "Stage: seed", source: "user_explicit", user_phrase: "seed", status: "ok" } as unknown as MissionCriterion;
  assertEquals(checkCriterion(criterion, c.graph).result, "pass", "the recorded claim decides the criterion");
  assertEquals(company.observations.length, 1, "a second write of the same answer replaces, never stacks");
  // The recorded claim carries the corroboration's actor, which is one of the
  // route's evidence actors: even without the mark, the route reads as tried.
  const gaps = evidenceGapsFor([{ criterion_id: "x", dimension: "company_stage", result: "unknown", reason: "?" }], c.graph, READY);
  assertEquals([gaps[0].next, gaps[0].considered[0].tried], ["blocked", true], "an answered route is not taken again");
});

Deno.test("a round stage is unprovable until the funding verifier may run — and provable once it may", async () => {
  // A not-ready pair is the "until" half; the READY production pair — and a
  // policy naming a not-ready one, a supervised canary — are "once it may".
  assertFalse(fundingVerifierReady(PAIR_NOT_READY), "not ready: the pair may not run");
  assert(fundingVerifierReady(), "production: the pair is READY");
  assert(fundingVerifierReady(PAIR_ALLOWED_POLICY), "named: the corroborating pair may run");
  const { compileLeadMission } = await import("../../../supabase/functions/_shared/leadMissionCompiler.ts");
  const { deriveMissionCriteria } = await import("../../../supabase/functions/_shared/missionCriteria.ts");
  const mission = compileLeadMission({
    originalUserQuery: "Find 1 seed-stage B2B SaaS startup in the US hiring its first growth marketer.",
    proposal: {
      requested_opportunity_count: 1, requested_contact_ready_count: null, company_types: ["B2B SaaS"],
      geographies: ["United States"], geography_is_hard: true, employee_range: { min: null, max: null },
      decision_maker_roles: [], hard_constraints: [], soft_preferences: [], preferred_signals: ["hiring growth marketer"],
      required_signal_terms: ["growth marketer"], adjacent_signals: [], excluded_signals: [],
      allowed_broadening: { role_families: [], company_types: [], geographies: [], employee_range: { min: null, max: null } },
      disallowed_broadening: [], required_evidence: [], required_capabilities: [], preferred_source_strategy: [],
      evaluation_instructions: "", founder_unlock_recommended: false, confidence: 0.85, unknowns: [],
    } as never,
  }).final_mission;
  const pending = deriveMissionCriteria(mission, PAIR_NOT_READY).find((c) => c.dimension === "company_stage" && c.value === "seed")!;
  assertEquals(pending.status, "unprovable_today", "no route can answer it, and the card must say so");
  const prod = deriveMissionCriteria(mission).find((c) => c.dimension === "company_stage" && c.value === "seed")!;
  assertEquals(prod.status, "ok", "production: the READY pair can answer it");
  const now = deriveMissionCriteria(mission, PAIR_ALLOWED_POLICY).find((c) => c.dimension === "company_stage" && c.value === "seed")!;
  assertEquals(now.status, "ok", "the pair can answer it, so it is not disclosed as unprovable");
});

Deno.test("run-agent runs the verifiers on canonical gaps, before the view, bound to the ledger, with a kill switch", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  const block = src.indexOf("// ── CLAIM VERIFIERS: CANONICAL GAPS → VERIFIER → PURCHASE");
  const view = src.indexOf("const p5View = (p2Specs && capabilityRun && persistedMission)");
  assert(block > 0 && view > block, "verifiers run before the canonical view is built");
  for (const wired of [
    `readEnvSafe("LEAD_V2_CLAIM_VERIFIERS")`,
    "const phase = await runClaimVerificationPhase({",
    // The open-role verifier joins only for a HARD hiring claim (hiringClaimVerifier.ts).
    "verifiers: [fundingStageVerifier(), businessModel, ...(hiringVerifier ? [hiringVerifier] : [])],",
    "readiness: leadReadiness,",
    // ONE verifier spine, shared by the verification phase and the funding
    // screen: both calls are `ledgerBoundCall` under the same spec compiler.
    // The phase builds that compiler once and hands it to the purchase and
    // to its affordability gate (`hiringAffordabilityCompiledEstimate.test.ts`).
    ") => ledgerBoundCall({",
    "spec: spec ?? await verifierSpecFor(vState),",
    "call: await verifierCallFor(vState, vSpec),",
    "const call = await verifierCallFor(state);",
    // The verifier path is the spine: spec, guard, readiness-aware criteria, settlement.
    "const verifierSpecFor = async (vState: CapabilityExecutionState) => verifierSpecCompiler({",
    "invoke: guardedInvoker(null, (call) => capabilityInvoke(call),",
    "const vCriteria = deriveMissionCriteria(vMission, leadReadiness);",
    `console.log("[run-agent][p2-spine][claim-verifier]"`,
    "return company ? applyVerifierFinding(company, f, verifier) : false;",
    "engineRun.resume_records = engineRun.companies.map(toResumeRecord)",
    "awaitedPendingRuns(capabilityRun?.state.verifier_pending_runs?.filter((p) => !p.deferred), Date.now()).awaited",
  ]) assert(src.includes(wired), `run-agent must carry: ${wired}`);
});

Deno.test("atomus and pvalyou rows are company-shaped to the transport check (no false shape violation)", async () => {
  const { structuredRowsLookIntact } = await import("../../../supabase/functions/_shared/capabilityExecution.ts");
  // The canary f9b5ad8e logged `provider_response_shape_violation` for atomus:
  // its identity is nested under summary/company, and the check looked only
  // at the top level. The real rows, from the live probes:
  for (const row of FX.atomus as Row[]) assert(structuredRowsLookIntact([row]).intact, `atomus ${row.input}`);
  for (const row of FX.pvalyou as Row[]) assert(structuredRowsLookIntact([row]).intact, `pvalyou ${row.query}`);
  // A not-found lookup still names what it was asked about.
  assert(structuredRowsLookIntact([{ input: "https://www.linkedin.com/company/nobody", status: "not_found" }]).intact);
  // …and a job-shaped row is still a violation.
  assertFalse(structuredRowsLookIntact([{ title: "Account Executive", location: "NYC" }]).intact);
});
