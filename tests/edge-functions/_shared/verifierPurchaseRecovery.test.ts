// D2 — A VERIFICATION AN EARLIER SLICE BOUGHT IS READ AGAIN, NEVER BOUGHT AGAIN.
//
// `ledgerBoundCall` deduplicated only against the checkpointed spend ledger; a
// lost end-of-slice write made the next slice buy the same verification under
// the same idempotency key (chaos lab, tests/replay/failure). It now also asks
// what the durable execution ledger knows (`verifierPurchaseRecovery.ts`).
// ZERO network, ZERO database.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  NO_PRIOR_PURCHASES, priorPurchasesFrom, readPriorPurchases, UNCERTAIN_PURCHASE_SETTLE_MS, uncertainStillSettling,
  unreadablePriorPurchases, type VerifierLedgerQuery, type VerifierLedgerRow,
} from "../../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import { ledgerBoundCall, type VerifierCall } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { DEFAULT_CEILINGS, newSpendLedger } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import { verifierSpecCompiler } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { guardedInvoker } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { readinessPolicy } from "../../../supabase/functions/_shared/routeReadiness.ts";
import type { ProviderCallSpec } from "../../../supabase/functions/_shared/providerCallSpec.ts";

const T0 = "2026-10-14T10:00:00.000Z";
const row = (over: Partial<VerifierLedgerRow>): VerifierLedgerRow => ({
  idempotency_key: "k1", provider_run_id: null, status: "succeeded", started_at: T0, record_kind: "provider_call", ...over,
});

// ── WHAT THE LEDGER SAYS ────────────────────────────────────────────────────

Deno.test("D2 a row with a run id is a purchase to ADOPT, whatever its status — a finished run preferred over one in flight over a failed one", () => {
  for (const status of ["succeeded", "empty", "reused", "started", "timed_out", "failed"]) {
    assertEquals(priorPurchasesFrom([row({ status, provider_run_id: "r1" })]).lookup("k1"), { kind: "adopt", run_id: "r1", status });
  }
  const p = priorPurchasesFrom([
    row({ status: "failed", provider_run_id: "r-failed" }),
    row({ status: "timed_out", provider_run_id: "r-flight" }),
    row({ status: "succeeded", provider_run_id: "r-done" }),
  ]);
  assertEquals(p.lookup("k1"), { kind: "adopt", run_id: "r-done", status: "succeeded" });
  assertEquals(priorPurchasesFrom([row({ status: "failed", provider_run_id: "a" }), row({ status: "started", provider_run_id: "b" })]).lookup("k1"),
    { kind: "adopt", run_id: "b", status: "started" });
});

Deno.test("D2 a call that may have started a run it never named is UNCERTAIN — a run id anywhere wins over it", () => {
  for (const r of [row({ status: "started" }), row({ status: "timed_out" }), row({ status: "failed", failure_code: "AbortError" }),
    row({ status: "failed", failure_code: "network_error" })]) {
    assertEquals(priorPurchasesFrom([r]).lookup("k1")?.kind, "uncertain", JSON.stringify(r));
  }
  assertEquals(priorPurchasesFrom([row({ status: "started" }), row({ status: "succeeded", provider_run_id: "r1" })]).lookup("k1")?.kind, "adopt");
  // The latest uncertain start is the one reported.
  assertEquals(priorPurchasesFrom([row({ status: "started", started_at: "2026-10-14T09:00:00Z" }), row({ status: "started", started_at: "2026-10-14T09:30:00Z" })])
    .lookup("k1"), { kind: "uncertain", started_at: "2026-10-14T09:30:00Z", status: "started" });
});

Deno.test("D2 nothing was bought: a failure before any run, another key, a stage row, a row with no key", () => {
  assertEquals(priorPurchasesFrom([row({ status: "failed", failure_code: "http_400" })]).lookup("k1"), null);
  assertEquals(priorPurchasesFrom([row({ provider_run_id: "r1" })]).lookup("other"), null);
  assertEquals(priorPurchasesFrom([row({ status: "started", record_kind: "stage_result" })]).lookup("k1"), null);
  assertEquals(priorPurchasesFrom([row({ idempotency_key: null, provider_run_id: "r1" })]).lookup("k1"), null);
  assertEquals(NO_PRIOR_PURCHASES.lookup("k1"), null);
  assertEquals(unreadablePriorPurchases("x").lookup("k1"), { kind: "unknown", reason: "x" });
});

Deno.test("D2 the uncertain window: a live holder could still attach the run id for a bounded time, then it is held unresolved", () => {
  const t = Date.parse(T0);
  assert(uncertainStillSettling({ started_at: T0 }, t + 60_000));
  assertFalse(uncertainStillSettling({ started_at: T0 }, t + UNCERTAIN_PURCHASE_SETTLE_MS));
  assertFalse(uncertainStillSettling({ started_at: null }, t), "an undated start is not waited on for ever");
  assert(UNCERTAIN_PURCHASE_SETTLE_MS > 300_000 + 180_000, "past the worker's lease and mission ceiling");
});

// ── WHAT `ledgerBoundCall` DOES WITH IT ─────────────────────────────────────

const PAIR = readinessPolicy({ allow_experimental: ["apify_funding_pvalyou|funding_verification"] });
const POLICY = criteriaExecutionPolicy(parseLeadMissionDeterministic("Find seed-stage B2B SaaS companies"));
type Sent = { actorKey: string; providerCallSpec: ProviderCallSpec; resumeRunId?: string };
const pvCall = (resume?: string): VerifierCall => ({
  actor_key: "apify_funding_pvalyou", capability: "funding_verification", input: { tier: "basic", companies: ["a.com"] },
  candidate_keys: ["a.com"], purpose: "funding_evidence", ...(resume ? { resume_run_id: resume } : {}),
});
function harness(prior: ReturnType<typeof priorPurchasesFrom> | undefined, o: { credits?: number; now?: number } = {}) {
  const ledger = newSpendLedger({ ...DEFAULT_CEILINGS, ...(o.credits !== undefined ? { mission_credits: o.credits } : {}) });
  const sent: Sent[] = [];
  const refused: string[] = [];
  const traces: Array<{ type: string; detail: Record<string, unknown> }> = [];
  const spec = verifierSpecCompiler({
    scope: { workspace_id: "ws", lineage_id: "ln" }, mission_hash: "mh", policy: POLICY, ceilings: () => ledger.ceilings, readiness: PAIR,
  });
  const call = ledgerBoundCall({
    ledger, spec,
    actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
    invoke: guardedInvoker(null, (c: Sent) => { sent.push(c); return Promise.resolve([{ ok: 1 }]); }, undefined, PAIR),
    hash: () => "h", onRefused: (k) => refused.push(k),
    trace: (type, detail) => { traces.push({ type, detail }); },
    ...(prior ? { prior } : {}),
    now: () => o.now ?? Date.parse(T0) + 60_000,
  });
  const key = spec(pvCall()).idempotency_key;
  return { ledger, sent, refused, traces, call, key };
}

Deno.test("D2 ADOPT: the earlier run is re-read by its id under the same idempotency key — no reservation, no new spend", async () => {
  const probe = harness(undefined);
  const h = harness(priorPurchasesFrom([row({ idempotency_key: probe.key, provider_run_id: "run-A", status: "succeeded" })]));
  const out = await h.call(pvCall());
  assertEquals(out.status, "ok");
  assertEquals(h.sent.length, 1);
  assertEquals(h.sent[0].resumeRunId, "run-A", "a GET of the paid run, never a second start");
  assertEquals(h.sent[0].providerCallSpec.idempotency_key, h.key);
  assertEquals(h.ledger.reservations, [], "no reservation: the spend is the earlier slice's");
  assertEquals(h.traces.find((t) => t.type === "call_adopted")?.detail.source, "execution_ledger");
  assertEquals(h.refused, []);
});

Deno.test("D2 ADOPT is never refused on budget: the purchase was already paid", async () => {
  const probe = harness(undefined);
  const h = harness(priorPurchasesFrom([row({ idempotency_key: probe.key, provider_run_id: "run-A" })]), { credits: 0 });
  assertEquals((await h.call(pvCall())).status, "ok");
  // The same call with nothing to adopt IS refused by that ceiling: the budget still binds new purchases.
  const fresh = harness(NO_PRIOR_PURCHASES, { credits: 0 });
  const r = await fresh.call(pvCall());
  assertEquals(r.status, "refused");
  assertEquals(fresh.sent.length, 0);
});

Deno.test("D2 UNCERTAIN: never bought again — deferred inside the window, held unresolved after it; the provider is not marked unavailable", async () => {
  const probe = harness(undefined);
  const uncertain = priorPurchasesFrom([row({ idempotency_key: probe.key, status: "started" })]);
  const early = harness(uncertain);
  const r1 = await early.call(pvCall());
  assertEquals(r1.status, "deferred");
  const late = harness(uncertain, { now: Date.parse(T0) + UNCERTAIN_PURCHASE_SETTLE_MS + 1 });
  const r2 = await late.call(pvCall());
  assertEquals(r2.status, "refused");
  assert(r2.status === "refused" && r2.reason.startsWith("uncertain_prior_purchase"), JSON.stringify(r2));
  for (const h of [early, late]) {
    assertEquals(h.sent.length, 0);
    assertEquals(h.ledger.reservations, []);
    assertEquals(h.refused, [], "not a provider refusal");
    assertEquals(h.traces.find((t) => t.type === "call_idempotent_skip")?.detail.reason, "uncertain_prior_purchase");
  }
});

Deno.test("D2 UNREADABLE ledger: deferred, nothing sent", async () => {
  const h = harness(unreadablePriorPurchases("execution ledger read failed"));
  assertEquals((await h.call(pvCall())).status, "deferred");
  assertEquals(h.sent.length, 0);
});

Deno.test("D2 unchanged paths: the in-state ledger still decides first, an explicit adoption skips the lookup, and nothing known buys as before", async () => {
  // In-state: bought this slice → skipped, without asking the durable ledger.
  let asked = 0;
  const counting = { lookup: () => { asked++; return null; } };
  const h = harness(counting);
  assertEquals((await h.call(pvCall())).status, "ok");
  assertEquals(h.ledger.reservations[0].status, "executed");
  assertEquals((await h.call(pvCall())).status, "failed", "already_executed, from the spend ledger");
  assertEquals(asked, 1, "the durable ledger is asked only when the spend ledger knows nothing");
  // An explicit adoption (`resume_run_id`) is the caller's: no lookup.
  const h2 = harness(counting);
  asked = 0;
  await h2.call(pvCall("run-carried"));
  assertEquals([asked, h2.sent[0].resumeRunId], [0, "run-carried"]);
  // Nothing known: one purchase, reserved and executed as before.
  const h3 = harness(NO_PRIOR_PURCHASES);
  assertEquals((await h3.call(pvCall())).status, "ok");
  assertEquals([h3.sent.length, h3.sent[0].resumeRunId, h3.ledger.reservations[0].status], [1, undefined, "executed"]);
});

// ── THE READ: SCOPED TO THE LINEAGE THAT PAID ───────────────────────────────

function fakeDb(result: { data: unknown[] | null; error: unknown } | "throw") {
  const filters: Array<[string, unknown]> = [];
  let table = "";
  const q: VerifierLedgerQuery = {
    select: () => q,
    eq: (c, v) => { filters.push([c, v]); return q; },
    not: (c, _op, v) => { filters.push([`not:${c}`, v]); return q; },
    order: () => q,
    limit: () => result === "throw" ? Promise.reject(new Error("boom")) : Promise.resolve(result),
  };
  return { db: { from: (t: string) => { table = t; return q; } }, filters, table: () => table };
}

Deno.test("D2 the read is scoped to the PARENT task, the WORKSPACE and provider calls — another workspace's purchase can never be adopted", async () => {
  const f = fakeDb({ data: [row({ provider_run_id: "r1" })], error: null });
  const p = await readPriorPurchases(f.db, { table: "lead_execution_calls", parentTaskId: "task-1", workspaceId: "ws-1" });
  assertEquals(f.table(), "lead_execution_calls");
  assertEquals(f.filters, [["task_id", "task-1"], ["workspace_id", "ws-1"], ["record_kind", "provider_call"], ["not:idempotency_key", null]]);
  assertEquals(p.lookup("k1")?.kind, "adopt");
});

Deno.test("D2 the read: a first slice reads nothing; a failed or throwing read rules nothing out", async () => {
  const none = fakeDb({ data: [], error: null });
  assertEquals(await readPriorPurchases(none.db, { table: "t", parentTaskId: null, workspaceId: "ws" }), NO_PRIOR_PURCHASES);
  assertEquals(none.table(), "", "no parent: no query at all");
  const failed = await readPriorPurchases(fakeDb({ data: null, error: { message: "57014" } }).db, { table: "t", parentTaskId: "p", workspaceId: "ws" });
  assertEquals(failed.lookup("k1")?.kind, "unknown");
  const threw = await readPriorPurchases(fakeDb("throw").db, { table: "t", parentTaskId: "p", workspaceId: "ws" });
  assertEquals(threw.lookup("anything")?.kind, "unknown");
});

Deno.test("D2 run-agent reads the durable ledger through `readPriorPurchases`, once per slice, and hands it to every verifier call", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  const at = src.indexOf("const verifierPriorPurchases = ");
  assert(at > 0, "verifierPriorPurchases is gone");
  const block = src.slice(at, at + 400);
  for (const m of [
    "verifierPrior ??= readPriorPurchases(",
    "{ table: LEAD_EXECUTION_CALLS_TABLE, parentTaskId: leadResumeParentTaskId, workspaceId: String(workspace_id ?? \"\") }",
  ]) assert(block.includes(m), `missing: ${m}`);
  const call = src.slice(src.indexOf("const verifierCallFor = async ("), src.indexOf("const verifierCallFor = async (") + 400);
  assert(call.includes("prior: await verifierPriorPurchases(),"), "verifierCallFor does not pass the durable ledger");
});
