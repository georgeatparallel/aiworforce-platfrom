// FAILURE INJECTION — A VERIFICATION PURCHASE WHOSE SLICE NEVER WROTE.
//
// Canary 8 (production 2026-10-04, task c01d28d8), from its slice-1 checkpoint,
// through the production verification phase (lib/verification.ts).
//
// Verification runs AFTER the engine, so nothing it buys reaches a checkpoint
// until the end-of-slice write. The verifier's only dedupe
// (`ledgerBoundCall`) is the checkpointed `spend_ledger`: a reservation already
// `executed` under the same idempotency key is skipped. When that write is
// lost (eb0d520f: a 2.15 MB write ran 161 s and never landed), or the worker
// dies between the purchase and the write, the next slice restores the
// checkpoint from BEFORE the purchase and buys the same question again.
//
// The ledger rows for that purchase exist (the transport writes
// `lead_execution_calls` as it calls), but run-agent's resume recovery reads
// them only for the ENGINE's completed and pending runs; the verifier's spend
// ledger is never rebuilt from them, and the provider transport does not
// consult them before calling.
//
// D2 (fixed): `ledgerBoundCall` now asks the durable execution ledger too
// (`verifierPurchaseRecovery.ts`): a run it names is adopted by id; a call that
// may have started a run it cannot name is never bought again.
//
// ZERO network, ZERO provider spend, ZERO production writes.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { replayVerificationAt } from "../lib/verification.ts";
import { ledgerBoundCall } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { HIRING_ROUTE_ACTOR } from "../../../supabase/functions/_shared/hiringClaimVerifier.ts";
import {
  priorPurchasesFrom, UNCERTAIN_PURCHASE_SETTLE_MS, unreadablePriorPurchases, type VerifierLedgerRow,
} from "../../../supabase/functions/_shared/verifierPurchaseRecovery.ts";

const fx = loadFixture("canary8.hiring-affordability");
const S1 = "before_hiring_verification:slice1";
const LLAMA = "https://www.linkedin.com/company/llamaindex";

/** Slice A runs verification; what it would have checkpointed is `ledger`, what the checkpoint held is `ledgerBefore`. */
async function sliceA() {
  const a = await replayVerificationAt(fx, S1, { verifiers: "hiring" });
  assertEquals(a.provider.calls.length, 1, "slice A buys LlamaIndex's job search");
  const bought = a.provider.calls[0];
  assertEquals([bought.actor, bought.candidate_keys], [HIRING_ROUTE_ACTOR, [LLAMA]]);
  assert(bought.idempotency_key, "the purchase carries its idempotency key");
  const call = a.preflights.find((p) => p.call.candidate_keys.includes(LLAMA))!.call;
  return { a, bought, call };
}

Deno.test("[failure] D2 control: while the verifier's spend ledger SURVIVES, the same verification is never bought twice", async () => {
  const { a, call } = await sliceA();
  // The very call again, against the ledger slice A ends with.
  const again = await ledgerBoundCall(a.deps)(call);
  assertEquals(again.status, "failed");
  assert(again.status === "failed" && again.reason.startsWith("already_executed"));
  assertEquals(a.provider.calls.length, 1, "skipped by idempotency key, nothing re-bought");
});

// ── D2, FIXED: THE DURABLE LEDGER DECIDES ─────────────────────────────────
//
// Slice B is handed what the execution ledger holds for this lineage (as
// run-agent's `verifierPriorPurchases` reads `lead_execution_calls`). The row
// below is the one the transport wrote for slice A's purchase: started, its
// run id attached when the start POST returned, finalized `succeeded`.

const T0 = Date.parse("2026-10-04T12:00:00Z");
function durableRowOf(a: Awaited<ReturnType<typeof sliceA>>["a"], key: string, over: Partial<VerifierLedgerRow> = {}): VerifierLedgerRow {
  const r = a.ledger.reservations.find((x) => x.idempotency_key === key)!;
  assert(r.provider_run_id, "slice A's run id reached its reservation (onProviderRun)");
  return {
    idempotency_key: key, provider_run_id: r.provider_run_id, status: "succeeded",
    started_at: new Date(T0).toISOString(), record_kind: "provider_call", ...over,
  };
}
const sliceB = (prior: ReturnType<typeof priorPurchasesFrom>, nowMs = T0 + 60_000) =>
  replayVerificationAt(fx, S1, { verifiers: "hiring", prior, now: () => nowMs });
const adoptedTrace = (b: Awaited<ReturnType<typeof sliceB>>) =>
  b.trace.find((e) => e.type === "call_adopted" && e.source === "execution_ledger");

Deno.test("[failure] D2 slice A's write is lost after the verifier bought: slice B ADOPTS the run by id from the execution ledger — read again, never bought again", async () => {
  const { a, bought } = await sliceA();
  const b = await sliceB(priorPurchasesFrom([durableRowOf(a, bought.idempotency_key!)]));
  assertEquals(b.provider.calls.filter((c) => !c.adopted).length, 0, "nothing bought");
  assertEquals(b.provider.calls.length, 1, "one re-read");
  assertEquals(b.provider.calls[0].idempotency_key, bought.idempotency_key, "the same question, by its own key");
  assertEquals(adoptedTrace(b)?.run_id, a.ledger.reservations.find((r) => r.idempotency_key === bought.idempotency_key)!.provider_run_id);
  // The same answer as slice A's purchase …
  assertEquals(b.phase.ran.map((r) => r.findings), a.phase.ran.map((r) => r.findings));
  assertEquals(b.phase.changed, a.phase.changed);
  // … and no new spend: an adoption makes no reservation (as the engine's adoption of a recovered run makes none).
  assertEquals(b.ledger.reservations.length, b.ledgerBefore.reservations.length);
});

Deno.test("[failure] D2 a run the ledger still shows IN FLIGHT (run id attached, never finalized) is adopted by id, not bought again", async () => {
  const { a, bought } = await sliceA();
  for (const status of ["started", "timed_out", "failed"]) {
    const b = await sliceB(priorPurchasesFrom([durableRowOf(a, bought.idempotency_key!, { status })]));
    assertEquals(b.provider.calls.filter((c) => !c.adopted).length, 0, `${status}: nothing bought`);
    assertEquals(adoptedTrace(b)?.ledger_status, status);
  }
});

Deno.test("[failure] D2 UNCERTAIN: a call that may have started a run whose id was never recorded is NEVER bought again — deferred while a live holder could still attach it, then held unresolved", async () => {
  const { bought } = await sliceA();
  const uncertain = priorPurchasesFrom([{
    idempotency_key: bought.idempotency_key, provider_run_id: null, status: "started",
    started_at: new Date(T0).toISOString(), record_kind: "provider_call",
  }]);
  for (const [nowMs, held] of [[T0 + 60_000, "deferred"], [T0 + UNCERTAIN_PURCHASE_SETTLE_MS + 1, "unresolved"]] as const) {
    const b = await sliceB(uncertain, nowMs);
    assertEquals(b.provider.calls.length, 0, `${held}: nothing bought, nothing read`);
    const skip = b.trace.find((e) => e.type === "call_idempotent_skip" && e.reason === "uncertain_prior_purchase");
    assertEquals(skip?.held, held);
    // Not answered either way: the claim stays open, never failed on a guess.
    assertEquals(b.phase.changed, 0);
    assertEquals(b.ledger.reservations.length, b.ledgerBefore.reservations.length, "no spend recorded or released");
  }
});

Deno.test("[failure] D2 an UNREADABLE execution ledger rules nothing out: the purchase is deferred, never made blind", async () => {
  await sliceA();
  const b = await sliceB(unreadablePriorPurchases("execution ledger read failed"));
  assertEquals(b.provider.calls.length, 0);
  assertEquals(b.trace.find((e) => e.type === "call_idempotent_skip")?.reason, "execution_ledger_unreadable");
});

Deno.test("[failure] D2 a call that failed BEFORE any run existed (a refusal, no run id) was never bought: slice B buys it as before", async () => {
  const { bought } = await sliceA();
  const b = await sliceB(priorPurchasesFrom([{
    idempotency_key: bought.idempotency_key, provider_run_id: null, status: "failed", failure_code: "http_400",
    started_at: new Date(T0).toISOString(), record_kind: "provider_call",
  }]));
  assertEquals(b.provider.calls.filter((c) => !c.adopted).length, 1);
});

Deno.test("[failure] D2 nothing known (a first slice, or another lineage's key): verification buys exactly as before", async () => {
  const { bought } = await sliceA();
  const b = await sliceB(priorPurchasesFrom([{
    idempotency_key: "some-other-key", provider_run_id: "run-x", status: "succeeded",
    started_at: new Date(T0).toISOString(), record_kind: "provider_call",
  }]));
  assertEquals(b.provider.calls.length, 1);
  assertEquals(b.provider.calls[0].idempotency_key, bought.idempotency_key);
  assertFalse(b.provider.calls[0].adopted);
});
