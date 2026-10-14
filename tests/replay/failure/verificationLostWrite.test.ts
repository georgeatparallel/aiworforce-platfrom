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
// D2 is pinned twice: the `DEFECT` test states what happens today; the
// `[known-gap]` test (ignored) states what must happen.
//
// ZERO network, ZERO provider spend, ZERO production writes.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { replayVerificationAt } from "../lib/verification.ts";
import { ledgerBoundCall } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { HIRING_ROUTE_ACTOR } from "../../../supabase/functions/_shared/hiringClaimVerifier.ts";

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

Deno.test("[failure] D2 DEFECT REPRODUCED — slice A's write is lost (or its worker dies) after the verifier bought: slice B restores the earlier checkpoint and BUYS THE SAME VERIFICATION AGAIN, under the same idempotency key", async () => {
  const { bought } = await sliceA();
  // Slice B: a fresh process resumes the checkpoint slice A never replaced.
  const b = await replayVerificationAt(fx, S1, { verifiers: "hiring" });
  assertEquals(b.provider.calls.length, 1,
    "today — if this fails, D2 is fixed: enable the [known-gap] test below and delete this one");
  assertEquals(b.provider.calls[0].idempotency_key, bought.idempotency_key, "the same question, by its own key");
  assertEquals(b.provider.calls[0].candidate_keys, [LLAMA]);
  // Paid twice: each slice's ledger records it as its own executed reservation.
  const reservation = b.ledger.reservations.find((r) => r.idempotency_key === bought.idempotency_key);
  assertEquals(reservation?.status, "executed");
});

Deno.test({
  name: "[known-gap] D2 a verification bought by a slice whose write was lost is adopted from the execution ledger, never bought again",
  ignore: true,
  fn: async () => {
    await sliceA();
    const b = await replayVerificationAt(fx, S1, { verifiers: "hiring" });
    assertEquals(b.provider.calls.filter((c) => !c.adopted).length, 0);
  },
});
