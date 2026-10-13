// LEAD V2 — EACH VERIFIER, WHEN ITS SLICE STOPS.
//
// A stop (deadline, cancellation, lost lease) reaches a verifier two ways: a
// call it makes is answered `deferred` without being sent, or `deps.stop` says
// no before work that is not a call (a page collection, a model re-grounding).
// Whatever it defers must stay OPEN (no route marked answered), must keep what
// was already bought, and must not be bought twice by the next slice.
//
// Scripted providers; no network.

import { assert, assertEquals, assertFalse, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  PendingVerifierRun, VerificationTarget, VerifierCall, VerifierCallOutcome, VerifierDeps,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import {
  HIRING_CLAIM_VERIFIER_KEY, HIRING_PENDING_STAGE, HIRING_ROUTE_ACTOR, hiringClaimVerifier,
} from "../../../supabase/functions/_shared/hiringClaimVerifier.ts";
import {
  DEFERRED_PVALYOU_RECENCY_STAGE, fundingStageVerifier,
} from "../../../supabase/functions/_shared/fundingStageVerifier.ts";
import {
  BUSINESS_MODEL_GROUND_OP, BUSINESS_MODEL_ROUTE_ACTOR, businessModelVerifier, type PageCollection,
} from "../../../supabase/functions/_shared/businessModelVerifier.ts";
import { buildCompanyEvidenceGraph } from "../../../supabase/functions/_shared/evidenceGraph.ts";

globalThis.fetch = () => { throw new Error("these tests must not reach the network"); };

const NOW = new Date("2026-09-24T16:00:00.000Z");
type Row = Record<string, unknown>;
const STOP = { reason: "deadline", detail: "checkpoint reserve reached" };

function deps(call: (c: VerifierCall) => VerifierCallOutcome, stop: VerifierDeps["stop"] = () => null) {
  const calls: VerifierCall[] = [];
  const d: VerifierDeps = {
    call: (c) => { calls.push(c); return Promise.resolve(call(c)); },
    ready: () => true, now: () => NOW.toISOString(), log: () => {}, stop,
  };
  return { d, calls };
}

// ═════════════════════════════════════════════════════════ open-role (hiring) ══

const HIRING_CRITERION = { criterion_id: "hiring:sales", dimension: "hiring", value: null, window_days: 30 };
const hTarget = (slug: string): VerificationTarget => ({
  company_key: `k_${slug}`, name: slug, domain: `${slug}.com`, linkedin_url: `https://www.linkedin.com/company/${slug}`,
  criterion: HIRING_CRITERION, graph: buildCompanyEvidenceGraph(`k_${slug}`, [], { now: NOW }),
});
const posting = (slug: string): Row => ({
  id: `job-${slug}`, title: "Account Executive", postedDate: "2026-09-20T10:00:00.000Z",
  linkedinUrl: `https://www.linkedin.com/jobs/view/job-${slug}/`,
  company: { linkedinUrl: `https://www.linkedin.com/company/${slug}`, name: slug },
});
const hiring = () => hiringClaimVerifier({
  titles: ["Account Executive"], role_families: ["gtm_sales"], window_days: 30,
  matchesRole: (t) => /account executive/i.test(t), now: () => NOW,
});

Deno.test("HIRING: a job search still running is CARRIED by run id — not dropped, not marked answered", async () => {
  const { d } = deps(() => ({ status: "running", run_id: "apify-run-1", provider_call_id: "pc1" }));
  const r = await hiring().verify([hTarget("acme")], d, { mission_id: "m", pending: [] });
  assertEquals(r.findings, [], "no answer yet: the route stays open");
  assertEquals(r.pending.length, 1);
  const p = r.pending[0];
  assertEquals([p.verifier, p.stage, p.actor_key, p.run_id], [HIRING_CLAIM_VERIFIER_KEY, HIRING_PENDING_STAGE, HIRING_ROUTE_ACTOR, "apify-run-1"]);
  assertEquals(p.candidate_keys, ["k_acme"]);
  assertEquals(p.carry, { asked: [{ company_key: "k_acme", url: "https://www.linkedin.com/company/acme" }] });
});

Deno.test("HIRING: the next slice ADOPTS the carried run — same input, its run id, nothing new bought — and answers", async () => {
  const first = await hiring().verify([hTarget("acme")], deps(() => ({ status: "running", run_id: "apify-run-1", provider_call_id: "pc1" })).d,
    { mission_id: "m", pending: [] });
  const sentFirst = first.pending[0].input;
  const { d, calls } = deps((c) => c.resume_run_id === "apify-run-1"
    ? { status: "ok", rows: [posting("acme")], provider_call_id: "pc1" }
    : { status: "failed", reason: "a NEW purchase was attempted" });
  const r = await hiring().verify([], d, { mission_id: "m", pending: first.pending });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].resume_run_id, "apify-run-1", "adopted by run id");
  assertEquals(calls[0].input, sentFirst, "the SAME input — so the same spec and idempotency key");
  assertEquals(r.pending, []);
  assertEquals(r.findings.length, 1);
  assert(r.findings[0].answered);
  assertEquals(r.findings[0].detail.verdict, "open_role_proven");
});

Deno.test("HIRING: an adoption the stop defers carries the SAME pending run, unchanged", async () => {
  const carried: PendingVerifierRun = {
    verifier: HIRING_CLAIM_VERIFIER_KEY, stage: HIRING_PENDING_STAGE, actor_key: HIRING_ROUTE_ACTOR, run_id: "apify-run-9",
    input: { company: ["https://www.linkedin.com/company/acme"] }, candidate_keys: ["k_acme"], started_at: "t0",
    carry: { asked: [{ company_key: "k_acme", url: "https://www.linkedin.com/company/acme" }] },
  };
  const { d } = deps(() => ({ status: "deferred", reason: "deadline" }));
  const r = await hiring().verify([], d, { mission_id: "m", pending: [carried] });
  assertStrictEquals(r.pending[0], carried);
  assertEquals(r.findings, []);
});

Deno.test("HIRING: a fresh search the stop defers buys nothing, marks nothing, carries nothing", async () => {
  const { d, calls } = deps(() => ({ status: "deferred", reason: "deadline" }));
  const r = await hiring().verify([hTarget("acme")], d, { mission_id: "m", pending: [] });
  assertEquals(calls.length, 1, "asked — and answered deferred by the phase, never sent");
  assertEquals([r.findings, r.pending], [[], []]);
});

// ═══════════════════════════════════════════════════ funding (Atomus → Pvalyou) ══

const ATOMUS = "apify_funding_atomus", PVALYOU = "apify_funding_pvalyou";
const FUNDING_CRITERION = { criterion_id: "funding:recent", dimension: "funding",
  value: { event: "funding", subject: "company", qualifier: {} }, window_days: 365 };
const fTarget = (slug: string): VerificationTarget => ({
  company_key: `https://www.linkedin.com/company/${slug}`, name: slug, domain: `${slug}.com`,
  linkedin_url: `https://www.linkedin.com/company/${slug}`, criterion: FUNDING_CRITERION,
  graph: buildCompanyEvidenceGraph(`https://www.linkedin.com/company/${slug}`, [], { now: NOW }),
});
/** Atomus FOUND the company and holds no funding: recency stays open → the Pvalyou fallback is due. */
const atomusEmpty = (slug: string): Row => ({ input: `https://www.linkedin.com/company/${slug}`, status: "success",
  summary: { name: slug, linkedin_url: `https://www.linkedin.com/company/${slug}`, domain: `${slug}.com` }, company: { financial: {} } });
const pvalyouRow = (domain: string): Row => ({ query: domain, status: "active", domain, record_as_of: "2026-09-24T10:00:00Z",
  record: { funding: { rounds_count: 1, last_round_date: "2026-05-01", rounds: [{
    round_index: 1, round_type: "Seed", round_title: "Seed", round_date: "2026-05-01", round_date_precision: "day", round_amount_m_usd: 2,
    is_non_equity: false, source_urls: [`https://news.example.com/${domain}-seed`], investors: [{ name: "Fund" }] }] } } });

Deno.test("FUNDING: stopped after Atomus — the Atomus read is KEPT, the claim stays open, the Pvalyou step is carried", async () => {
  const { d, calls } = deps((c) => c.actor_key === ATOMUS
    ? { status: "ok", rows: [atomusEmpty("acme"), atomusEmpty("bolt")], provider_call_id: "pc_atomus" }
    : { status: "deferred", reason: "deadline: checkpoint reserve reached" });
  const r = await fundingStageVerifier().verify([fTarget("acme"), fTarget("bolt")], d, { mission_id: "m", pending: [] });
  assertEquals(calls.map((c) => c.actor_key), [ATOMUS, PVALYOU], "Atomus bought; Pvalyou asked once and deferred");
  assertEquals(r.findings.length, 2, "one record per company Atomus read");
  assert(r.findings.every((f) => !f.answered), "no route marked answered");
  assert(r.findings.every((f) => f.item?.source.actor === ATOMUS), "the Atomus record it bought is recorded as evidence");
  assertEquals(r.pending.length, 1);
  const p = r.pending[0];
  assertEquals([p.stage, p.deferred, p.run_id], [DEFERRED_PVALYOU_RECENCY_STAGE, true, ""], "not a provider run");
  assertEquals(p.candidate_keys.sort(), [fTarget("acme").company_key, fTarget("bolt").company_key].sort());
});

Deno.test("FUNDING: the next slice resumes the deferred step — Pvalyou only, Atomus NEVER bought twice — and answers", async () => {
  const first = await fundingStageVerifier().verify([fTarget("acme")], deps((c) => c.actor_key === ATOMUS
    ? { status: "ok", rows: [atomusEmpty("acme")], provider_call_id: "pc_atomus" }
    : { status: "deferred", reason: "deadline" }).d, { mission_id: "m", pending: [] });
  const { d, calls } = deps((c) => c.actor_key === PVALYOU
    ? { status: "ok", rows: [pvalyouRow("acme.com")], provider_call_id: "pc_pv" }
    : { status: "failed", reason: "Atomus re-bought" });
  const r = await fundingStageVerifier().verify([], d, { mission_id: "m", pending: first.pending });
  assertEquals(calls.map((c) => c.actor_key), [PVALYOU]);
  assertEquals(r.pending, []);
  assertEquals(r.findings.length, 1);
  assert(r.findings[0].answered, "answered now, exactly as an uninterrupted slice would have");
  assertEquals(r.findings[0].attempted_actors, [PVALYOU]);
});

Deno.test("FUNDING: stopped BEFORE Atomus — nothing bought, nothing answered, nothing carried", async () => {
  const { d, calls } = deps(() => ({ status: "deferred", reason: "deadline" }));
  const r = await fundingStageVerifier().verify([fTarget("acme")], d, { mission_id: "m", pending: [] });
  assertEquals(calls.map((c) => c.actor_key), [ATOMUS]);
  assertEquals([r.findings, r.pending], [[], []]);
});

Deno.test("FUNDING: a running Pvalyou run whose adoption is deferred is carried as the same object", async () => {
  const running: PendingVerifierRun = {
    verifier: "funding_stage_atomus_pvalyou", stage: "pvalyou_recency", actor_key: PVALYOU, run_id: "pv-run-1",
    input: { tier: "basic", companies: ["acme.com"] }, candidate_keys: [fTarget("acme").company_key], started_at: "t0",
    carry: { targets: [fTarget("acme")], atomus: {}, inputs: { [fTarget("acme").company_key]: "acme.com" }, atomus_call_id: null },
  };
  const verifier = fundingStageVerifier();
  running.verifier = verifier.key;
  const { d } = deps(() => ({ status: "deferred", reason: "lease_lost" }));
  const r = await verifier.verify([], d, { mission_id: "m", pending: [running] });
  assertStrictEquals(r.pending[0], running);
  assertEquals(r.findings, []);
});

// ═════════════════════════════════════════════════ business model (pages + model) ══

const BM_CRITERION = { criterion_id: "bm:saas", dimension: "business_model", value: "B2B SaaS", window_days: null };
const bTarget = (slug: string, domain: string | null = `${slug}.com`): VerificationTarget => ({
  company_key: `k_${slug}`, name: slug, domain, linkedin_url: null, criterion: BM_CRITERION,
  graph: buildCompanyEvidenceGraph(`k_${slug}`, [], { now: NOW }),
});
function bm(collect: (keys: string[]) => Record<string, PageCollection>) {
  const io = { collected: 0, regrounded: [] as string[] };
  const v = businessModelVerifier({
    collect: (targets) => { io.collected++; return Promise.resolve(collect(targets.map((t) => t.company_key))); },
    reground: (k) => { io.regrounded.push(k); return Promise.resolve({ status: "proven", decision: "pass", skipped: null }); },
  });
  return { v, io };
}
const bmDeps = (stop: VerifierDeps["stop"]) => deps(() => ({ status: "failed", reason: "unused" }), stop).d;

Deno.test("BUSINESS MODEL: stopped before collection — no map, no page, no model call, nothing marked", async () => {
  const { v, io } = bm(() => ({}));
  const r = await v.verify([bTarget("acme")], bmDeps(() => STOP), { mission_id: "m", pending: [] });
  assertEquals([io.collected, io.regrounded.length], [0, 0]);
  assertEquals(r.findings, []);
});

Deno.test("BUSINESS MODEL: a collection cut short is NOT an answer, and the model call is not made", async () => {
  let stopped = false;
  const { v, io } = bm((keys) => { stopped = true; return Object.fromEntries(keys.map((k) => [k, { pages_ok: 1, outcome: "stopped" }])); });
  const r = await v.verify([bTarget("acme")], bmDeps(() => stopped ? STOP : null), { mission_id: "m", pending: [] });
  assertEquals(io.regrounded, []);
  assertEquals(r.findings.length, 1);
  assertFalse(r.findings[0].answered, "the claim stays open for the next slice");
  assertEquals(r.findings[0].detail.deferred, true);
});

Deno.test("BUSINESS MODEL: pages collected but no room for the re-grounding model call — deferred, unanswered", async () => {
  const asked: Array<string | null | undefined> = [];
  const { v, io } = bm((keys) => Object.fromEntries(keys.map((k) => [k, { pages_ok: 2, outcome: "collected" }])));
  const r = await v.verify([bTarget("acme")], bmDeps((op) => { asked.push(op); return op === BUSINESS_MODEL_GROUND_OP ? STOP : null; }),
    { mission_id: "m", pending: [] });
  assert(asked.includes(BUSINESS_MODEL_GROUND_OP), "the model call asked with its own latency key");
  assertEquals(io.regrounded, []);
  assertFalse(r.findings[0].answered);
});

Deno.test("BUSINESS MODEL: a company the collection never reached because of the stop is `stopped`, not `no_pages_planned`", async () => {
  let stopped = false;
  const { v } = bm(() => { stopped = true; return {}; });
  const r = await v.verify([bTarget("acme")], bmDeps(() => stopped ? STOP : null), { mission_id: "m", pending: [] });
  assertFalse(r.findings[0].answered);
  assertEquals(r.findings[0].detail.collection, "stopped");
});

Deno.test("BUSINESS MODEL: with no stop, exactly the previous behaviour — re-grounded and answered", async () => {
  const { v, io } = bm((keys) => Object.fromEntries(keys.map((k) => [k, { pages_ok: 2, outcome: "collected" }])));
  const r = await v.verify([bTarget("acme"), bTarget("nodomain", null)], bmDeps(() => null), { mission_id: "m", pending: [] });
  assertEquals(io.regrounded, ["k_acme"]);
  assertEquals(r.findings.map((f) => [f.company_key, f.answered, f.detail.collection]),
    [["k_acme", true, "collected"], ["k_nodomain", true, "no_domain"]]);
  assertEquals(BUSINESS_MODEL_ROUTE_ACTOR, "firecrawl");
});
