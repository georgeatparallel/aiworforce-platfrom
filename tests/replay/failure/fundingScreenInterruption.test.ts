// FAILURE INJECTION — THE FUNDING SCREEN INTERRUPTED (Codex PR #74, G5).
//
// The funding screen's ONE priced Atomus read, driven through the production
// verifier spine: `fundingStageVerifier` → `ledgerBoundCall` (spec compiler,
// spend-ledger reservation, guarded invoker) → the D2 durable-ledger lookup.
// Each test injects one interruption and asserts the paid read is never bought
// twice, never mistaken for an answer, and adopted when it can be.
//
// Synthetic provider rows only (no fixture, no network). The engine side — the
// screen holding admission while it waits, its bound — is pinned in
// tests/edge-functions/_shared/fundingPoolScreen.test.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ATOMUS_PENDING_STAGE, fundingStageVerifier,
} from "../../../supabase/functions/_shared/fundingStageVerifier.ts";
import {
  ledgerBoundCall, type PendingVerifierRun, type VerificationTarget,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import { DEFAULT_CEILINGS, newSpendLedger, type SpendLedger } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { verifierSpecCompiler } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { guardedInvoker } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { PRODUCTION_READINESS } from "../../../supabase/functions/_shared/routeReadiness.ts";
import {
  NO_PRIOR_PURCHASES, priorPurchasesFrom, type PriorPurchases, UNCERTAIN_PURCHASE_SETTLE_MS,
} from "../../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import type { ProviderCallSpec } from "../../../supabase/functions/_shared/providerCallSpec.ts";

globalThis.fetch = () => { throw new Error("the failure lab must not reach the network"); };

const T0 = Date.parse("2026-10-14T10:00:00.000Z");
const ATOMUS = "apify_funding_atomus";
const POLICY = criteriaExecutionPolicy(parseLeadMissionDeterministic("Find B2B SaaS companies that raised funding in the last year"));
const page = (slug: string) => `https://www.linkedin.com/company/${slug}`;
const daysAgo = (d: number) => new Date(T0 - d * 86_400_000).toISOString().slice(0, 10);
const atomusRow = (slug: string, dates: string[]) => ({
  input: page(slug), status: "success", summary: { name: slug, linkedin_url: page(slug), domain: `${slug}.com` },
  company: { financial: dates.length
    ? { funding: { type: "SEED", num_funding_rounds: dates.length, rounds: dates.map((d) => ({ announced_at: d, raised_amount: 1_000_000, type: "SEED_ROUND" })), date: dates[0] } }
    : {} },
});
const SAYS: Record<string, string[]> = { alpha: [daysAgo(90)], bravo: [] };
const target = (slug: string): VerificationTarget => ({
  company_key: page(slug), name: slug, domain: `${slug}.com`, linkedin_url: page(slug), graph: null as never,
  criterion: { criterion_id: "funding", dimension: "funding", value: null, window_days: 365 },
});
const TARGETS = [target("alpha"), target("bravo")];

type Script = "start_pending" | "rows" | "crash_after_start";
type Sent = { actorKey: string; resumeRunId?: string; providerCallSpec: ProviderCallSpec; input: Record<string, unknown> };

/** One slice of the screen: a ledger (restored, or lost), the durable ledger's rows (D2), and what the provider does. */
function slice(o: { ledger?: SpendLedger; prior?: PriorPurchases; script: Script; now?: number }) {
  const ledger = o.ledger ?? newSpendLedger({ ...DEFAULT_CEILINGS });
  const sent: Sent[] = [];
  const spec = verifierSpecCompiler({
    scope: { workspace_id: "ws", lineage_id: "lineage-screen" }, mission_hash: "mh", policy: POLICY,
    ceilings: () => ledger.ceilings, readiness: PRODUCTION_READINESS,
  });
  const invoke = (c: Sent & { onProviderRun?: (r: { run_id: string; dataset_id: string | null }) => void }) => {
    sent.push(c);
    if (o.script === "rows" || c.resumeRunId) {
      if (o.script === "start_pending" && c.resumeRunId) {
        // An adoption that finds the run STILL executing.
        throw Object.assign(new Error("run still running"), { toolResult: { run_id: c.resumeRunId, pending: true } });
      }
      const companies = (c.input.companies as string[]) ?? [];
      return Promise.resolve(companies.map((u) => atomusRow(u.split("/company/")[1], SAYS[u.split("/company/")[1]] ?? [])));
    }
    // The run STARTED: its id is recorded the moment the start POST returns.
    c.onProviderRun?.({ run_id: "run-A", dataset_id: null });
    if (o.script === "crash_after_start") throw new Error("worker process killed");
    throw Object.assign(new Error("wait ended before the run finished"), { toolResult: { run_id: "run-A", pending: true } });
  };
  const call = ledgerBoundCall({
    ledger, spec, actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
    invoke: guardedInvoker(null, invoke as never, undefined, PRODUCTION_READINESS),
    hash: () => "h", prior: o.prior ?? NO_PRIOR_PURCHASES, now: () => o.now ?? T0 + 60_000,
  });
  const screen = (pending: PendingVerifierRun[]) => fundingStageVerifier({ fallback: false }).verify(TARGETS, {
    call, now: () => new Date(o.now ?? T0).toISOString(), log: () => {}, ready: () => true,
  }, { mission_id: "m", pending });
  const keyOf = () => spec({
    actor_key: ATOMUS, capability: "funding_verification", purpose: "funding_evidence",
    input: { companies: TARGETS.map((t) => t.linkedin_url) }, candidate_keys: TARGETS.map((t) => t.company_key),
  }).idempotency_key;
  return { ledger, sent, screen, keyOf };
}
const starts = (sent: Sent[]) => sent.filter((s) => !s.resumeRunId).length;
const durableRow = (key: string, over: Record<string, unknown>) =>
  ({ idempotency_key: key, provider_run_id: null, status: "started", started_at: new Date(T0).toISOString(), record_kind: "provider_call", ...over });

Deno.test("[failure] SCREEN INTERRUPTION — provider still running at slice end: carried with its run id, adopted next slice, original spend kept", async () => {
  const s1 = slice({ script: "start_pending" });
  const r1 = await s1.screen([]);
  assertEquals(starts(s1.sent), 1);
  assertEquals(r1.findings, [], "NEVER an answer before the paid read has one");
  assertEquals(r1.pending.map((p) => [p.stage, p.run_id, p.candidate_keys]), [[ATOMUS_PENDING_STAGE, "run-A", TARGETS.map((t) => t.company_key)]]);
  assertEquals(s1.ledger.reservations.map((r) => r.status), ["executed"], "paid: the reservation is executed");

  // Next slice, checkpoint intact: the same ledger, the carried run.
  const s2 = slice({ ledger: s1.ledger, script: "rows" });
  const r2 = await s2.screen(r1.pending);
  assertEquals(s2.sent.map((s) => s.resumeRunId), ["run-A"], "ADOPTED by run id: a re-read, never a second start");
  assertEquals(s2.sent[0].providerCallSpec.idempotency_key, s1.sent[0].providerCallSpec.idempotency_key, "the original idempotency key");
  assertEquals(s2.ledger.reservations.length, 1, "no new reservation: the spend is the original one");
  assertEquals(r2.pending, []);
  const alpha = r2.findings.find((f) => f.company_key === page("alpha"))!;
  assertEquals([alpha.answered, alpha.detail.verdict_after], [true, "pass"], "the paid answer is read and used");
  assert(alpha.item, "with its cited funding record");
});

Deno.test("[failure] SCREEN INTERRUPTION — checkpoint write FAILED after the read started: the durable ledger's run id is adopted, never re-bought", async () => {
  const s1 = slice({ script: "start_pending" });
  await s1.screen([]);
  const key = s1.keyOf();
  assertEquals(s1.sent[0].providerCallSpec.idempotency_key, key);
  // Lost write: the next slice restores NEITHER the reservation NOR the carried run.
  // What survives is the execution-ledger row the transport wrote at the start POST.
  const s2 = slice({ script: "rows", prior: priorPurchasesFrom([durableRow(key, { provider_run_id: "run-A" })]) });
  const r2 = await s2.screen([]);
  assertEquals(s2.sent.map((s) => s.resumeRunId), ["run-A"], "the screen asks again with the same pages → same key → D2 adopts");
  assertEquals(s2.ledger.reservations, [], "no reservation: the earlier slice paid");
  assertEquals(r2.findings.length, 2);
});

Deno.test("[failure] SCREEN INTERRUPTION — worker crashed mid-screen after the run started: the next slice adopts by run id", async () => {
  const s1 = slice({ script: "crash_after_start" });
  const r1 = await s1.screen([]);
  // The crash surfaces as a failure of THIS process; nothing it returned is checkpointed.
  assertEquals(r1.pending, []);
  const key = s1.keyOf();
  // Still running when the next slice asks: carried again — adopted, not bought.
  const s2 = slice({ script: "start_pending", prior: priorPurchasesFrom([durableRow(key, { provider_run_id: "run-A" })]) });
  const r2 = await s2.screen([]);
  assertEquals(starts(s2.sent), 0, "never a second start");
  assertEquals(s2.sent.map((s) => s.resumeRunId), ["run-A"]);
  assertEquals(r2.findings, []);
  assertEquals(r2.pending.map((p) => p.run_id), ["run-A"], "carried for the slice after");
});

Deno.test("[failure] SCREEN INTERRUPTION — timed out after starting, run id never recorded: never bought again — deferred, then held unresolved", async () => {
  const key = slice({ script: "rows" }).keyOf();
  for (const row of [durableRow(key, {}), durableRow(key, { status: "failed", failure_code: "provider_timeout" })]) {
    const early = slice({ script: "rows", prior: priorPurchasesFrom([row]), now: T0 + 60_000 });
    const r1 = await early.screen([]);
    assertEquals(early.sent, [], "inside the settle window: nothing is bought");
    assertEquals([r1.findings, r1.pending], [[], []], "and nothing is answered: the screen keeps waiting");
    const late = slice({ script: "rows", prior: priorPurchasesFrom([row]), now: T0 + UNCERTAIN_PURCHASE_SETTLE_MS + 1 });
    const r2 = await late.screen([]);
    assertEquals(late.sent, [], "past it: still not bought — held unresolved");
    assertEquals(r2.findings.map((f) => [f.answered, f.item, f.detail.verdict_after]),
      [[true, null, "pending"], [true, null, "pending"]], "PENDING with no evidence: nothing fabricated");
  }
});

Deno.test("[failure] SCREEN INTERRUPTION — the slice's stop defers an adoption: the run is carried unchanged, not dropped", async () => {
  const s1 = slice({ script: "start_pending" });
  const r1 = await s1.screen([]);
  // A stopped slice (deadline / cancellation / lost lease) answers `deferred` for every call.
  const stopped = await fundingStageVerifier({ fallback: false }).verify(TARGETS, {
    call: () => Promise.resolve({ status: "deferred", reason: "deadline: checkpoint reserve reached" }),
    now: () => new Date(T0).toISOString(), log: () => {}, ready: () => true,
  }, { mission_id: "m", pending: r1.pending });
  assertEquals(stopped.findings, []);
  assertEquals(stopped.pending, r1.pending, "the same run, same input, same start time — still owed");
});
