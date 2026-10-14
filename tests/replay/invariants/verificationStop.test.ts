// LEAD V2 INVARIANTS 29–32 — VERIFICATION STOPS WITH ITS SLICE, AND LOSES NOTHING.
//
// Replayed from production canary 8 (c01d28d8, slice 1: LlamaIndex owes a hard
// hiring claim and its job search is affordable) through the production
// verification phase, ledger, spec compiler and guarded invoker. The only
// substitutions: the provider (recorded rows) and the slice's stop.
//
// ZERO network, ZERO provider spend.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { canonicalView, replayVerificationAt } from "../lib/verification.ts";
import { HIRING_ROUTE_ACTOR } from "../../../supabase/functions/_shared/hiringClaimVerifier.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { revocableDeadline } from "../../../supabase/functions/_shared/revocableDeadline.ts";
import { verificationStopGate } from "../../../supabase/functions/_shared/verificationStop.ts";
import {
  decideAutoContinuation, foldSlice, readLineageProgress,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

const fx = loadFixture("canary8.hiring-affordability");
const S1 = "before_hiring_verification:slice1";
const LLAMA = "https://www.linkedin.com/company/llamaindex";
const expired = () => verificationStopGate(createExecutionDeadline({ budgetMs: 1 }));
const revoked = (reason: string) => {
  const d = revocableDeadline(createExecutionDeadline({ budgetMs: 600_000 }));
  d.revoke(reason);
  return verificationStopGate(d);
};
const hiringOps = (companies: Array<{ key: string; completed_operations: string[] }>) =>
  companies.find((c) => c.key === LLAMA)!.completed_operations.filter((o) => o.includes(HIRING_ROUTE_ACTOR));
const executed = (r: { ledger: { reservations: Array<{ idempotency_key: string; status: string }> } }) =>
  r.ledger.reservations.filter((x) => x.status === "executed" || x.status === "settled").map((x) => x.idempotency_key);

Deno.test("[invariant] 29 an exhausted deadline starts no paid verification; the claim stays open and the next slice buys it exactly once", async () => {
  const baseline = await replayVerificationAt(fx, S1, { verifiers: "hiring" });
  assertEquals(baseline.provider.calls.length, 1, "uninterrupted, the slice buys LlamaIndex's job search");

  const stopped = await replayVerificationAt(fx, S1, { verifiers: "hiring", stop: expired() });
  assertEquals(stopped.provider.calls.length, 0, "nothing sent");
  assertEquals(stopped.ledger, stopped.ledgerBefore, "nothing reserved, nothing settled — the ledger is untouched");
  assertEquals(stopped.phase.stopped_by?.reason, "deadline");
  assertEquals(hiringOps(stopped.companies), [], "the route is NOT marked answered");
  const view = canonicalView({ companies: stopped.companies }, stopped.mission, fx.provenance.task_id);
  assert(view.evidence_gaps.with_executable_route > 0, "continuation still sees verification to do");

  const next = await replayVerificationAt(fx, S1, {
    verifiers: "hiring", resume: { companies: stopped.companies, ledger: stopped.ledger, pending: stopped.phase.pending },
  });
  assertEquals(next.provider.calls.map((c) => c.idempotency_key), baseline.provider.calls.map((c) => c.idempotency_key),
    "the next slice buys exactly what the stopped one deferred — the same call, the same key");
  assertEquals(executed(next), executed(baseline), "one purchase in the lineage, as if never interrupted");
  assertEquals(hiringOps(next.companies), hiringOps(baseline.companies));
});

Deno.test("[invariant] 30 a cancellation or a lost lease starts no paid verification", async () => {
  for (const [reason, kind] of [["worker:mission_cancelled", "cancelled"], ["worker:ownership_lost", "lease_lost"]] as const) {
    const r = await replayVerificationAt(fx, S1, { verifiers: "hiring", stop: revoked(reason) });
    assertEquals(r.provider.calls.length, 0, reason);
    assertEquals(r.ledger, r.ledgerBefore, reason);
    assertEquals(r.phase.stopped_by?.reason, kind);
  }
});

Deno.test("[invariant] 31 a verification run still executing when the slice stops is carried by run id and adopted next slice — paid once", async () => {
  const responses = structuredClone(fx.provider_responses)
    .map((x) => x.actor === HIRING_ROUTE_ACTOR ? { ...x, pending_once: true } : x);
  // Slice 1: the job search starts and is still running at the slice's end.
  const s1 = await replayVerificationAt(fx, S1, { verifiers: "hiring", responses });
  assertEquals(s1.provider.calls.length, 1);
  assert(s1.provider.calls[0].pending);
  assertEquals(s1.phase.pending.length, 1, "carried — it used to be dropped and never read");
  const run_id = s1.phase.pending[0].run_id;
  assertEquals(hiringOps(s1.companies), [], "not answered while running");

  // Slice 2 stops before verification: the run is carried UNCHANGED, nothing is polled or bought.
  const s2 = await replayVerificationAt(fx, S1, {
    verifiers: "hiring", responses, stop: expired(),
    resume: { companies: s1.companies, ledger: s1.ledger, pending: s1.phase.pending },
  });
  assertEquals(s2.provider.calls.length, 0);
  assertEquals(s2.phase.pending, s1.phase.pending);

  // Slice 3 adopts it: one adoption, no new purchase, the claim answered.
  const s3 = await replayVerificationAt(fx, S1, {
    verifiers: "hiring", responses, resume: { companies: s2.companies, ledger: s2.ledger, pending: s2.phase.pending },
  });
  assertEquals(s3.provider.calls.length, 1);
  assert(s3.provider.calls[0].adopted, "a status read of the same run, not a second search");
  assertEquals(s3.provider.calls[0].idempotency_key, s1.provider.calls[0].idempotency_key);
  assertEquals(s3.phase.pending, []);
  assertEquals(new Set(executed(s3)).size, executed(s3).length, "no key executed twice");
  assertEquals(executed(s3).length, executed(s1).length, "the lineage paid for ONE job search");
  assert(hiringOps(s3.companies).length > 0, "answered once the run is read");
  assertEquals(run_id.startsWith("replay-pending-"), true);
});

Deno.test("[invariant] 32 a slice the stop cut short is not barren — continuation still verifies, within the same ceilings", async () => {
  const stopped = await replayVerificationAt(fx, S1, { verifiers: "hiring", stop: expired() });
  assert(stopped.phase.stopped_by, "the phase reports it withheld work");
  const view = canonicalView({ companies: stopped.companies }, stopped.mission, fx.provenance.task_id);
  const prior = { ...readLineageProgress({ continuations_used: 2 }), barren_slices: 1 };
  const folded = foldSlice(prior, {
    qualifiedInPool: 0, uniqueCompaniesInvestigatedInPool: 0, authorisationsInPool: 0, costUnitsInLineage: 0,
    deferredByStop: !!stopped.phase.stopped_by,
  });
  assertEquals(folded.barren_slices, 1, "one step from no_progress before, still one step after");
  assertEquals(folded.continuations_used, 3, "and the slice still counts against the continuation ceiling");
  const d = decideAutoContinuation({
    qualified: 0, requestedCount: 1, frontierRemaining: 0, continuationsUsed: folded.continuations_used, maxContinuations: 10,
    costUnitsUsed: 2, maxCostUnits: 40, barrenSlices: folded.barren_slices, discoveryRoutesRemain: true,
    verificationRoutesRemain: view.evidence_gaps.with_executable_route,
  });
  assertEquals(d.reason, "verification_required");
  // Without the stop flag the same slice would have been the second barren one.
  assertFalse(foldSlice(prior, { qualifiedInPool: 0, uniqueCompaniesInvestigatedInPool: 0, authorisationsInPool: 0, costUnitsInLineage: 0 })
    .barren_slices < 2);
});
