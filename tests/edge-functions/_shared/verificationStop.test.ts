// LEAD V2 — THE VERIFICATION PHASE STOPS WITH ITS SLICE.
//
// The claim-verification phase runs after the capability engine and used to
// ask nothing before buying: a slice past its deadline, whose worker had lost
// the lease or whose mission was cancelled, still started job searches, Atomus
// and Pvalyou reads, Firecrawl pages and model calls (Query B d22d9ee6 slice 4:
// 6.5 minutes against a 300-second ceiling; eb0d520f slice 2: 14.5).
//
// These drive the gate (`verificationStop.ts`), the phase with scripted
// verifiers, and the continuation fold. A clock the test controls; no network.

import { assert, assertEquals, assertFalse, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyRevocation, NEVER_STOP, VERIFICATION_OPS, verificationStopGate,
} from "../../../supabase/functions/_shared/verificationStop.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { revocableDeadline } from "../../../supabase/functions/_shared/revocableDeadline.ts";
import { CHECKPOINT_RESERVE_MS } from "../../../supabase/functions/_shared/leadResumeState.ts";
import { runClaimVerificationPhase } from "../../../supabase/functions/_shared/claimVerificationPhase.ts";
import type {
  ClaimVerifier, PendingVerifierRun, VerifierCall, VerifierCallOutcome,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import { foldSlice, readLineageProgress } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

globalThis.fetch = () => { throw new Error("these tests must not reach the network"); };

/** A deadline on a clock the test moves. */
function clock(budgetMs = 300_000) {
  const t = { now: 0 };
  const deadline = revocableDeadline(createExecutionDeadline({ budgetMs, now: () => t.now }));
  return { t, deadline, gate: verificationStopGate(deadline) };
}

// ══════════════════════════════════════════════════════════════ the gate ════

Deno.test("GATE: every heartbeat reason the worker can revoke with is classified", () => {
  assertEquals(classifyRevocation("worker:mission_cancelled"), "cancelled");
  assertEquals(classifyRevocation("worker:lineage_cancelled"), "cancelled");
  assertEquals(classifyRevocation("worker:lineage_terminal"), "cancelled");
  assertEquals(classifyRevocation("worker:ownership_lost"), "lease_lost");
  assertEquals(classifyRevocation("worker:queue_not_found"), "lease_lost");
  assertEquals(classifyRevocation("worker:heartbeat_rpc_error"), "lease_lost");
  assertEquals(classifyRevocation("worker:heartbeat_error:TypeError"), "lease_lost");
  assertEquals(classifyRevocation("bind_refused"), "bind_refused");
  // The runner's fallback when the signal carries no reason: still a stop.
  assertEquals(classifyRevocation("worker:aborted"), "revoked");
  assertEquals(classifyRevocation("something_else"), "revoked");
});

Deno.test("GATE: room left → no stop; the checkpoint reserve → deadline", () => {
  const { t, gate } = clock(100_000);
  assertEquals(gate.check(), null);
  t.now = 100_000 - CHECKPOINT_RESERVE_MS - 1;
  assertEquals(gate.check(), null, "one millisecond above the reserve still starts work");
  t.now = 100_000 - CHECKPOINT_RESERVE_MS;
  assertEquals(gate.check()?.reason, "deadline");
});

Deno.test("GATE: a synchronous call that cannot finish stops, by the deadline's own per-operation estimate", () => {
  const { t, deadline, gate } = clock(100_000);
  deadline.observeCall(40_000, VERIFICATION_OPS.page); // pages here take 40s
  t.now = 50_000; // 50s left: above the reserve, below one page
  assertEquals(gate.check(), null, "a durable start (no op) still has room");
  assertEquals(gate.check(VERIFICATION_OPS.page), null, "50s left, 40s needed: room");
  t.now = 61_000; // 39s left
  assertEquals(gate.check(VERIFICATION_OPS.page)?.reason, "deadline");
});

Deno.test("GATE: sticky — once it says stop it keeps saying it, whatever is asked next", () => {
  const { t, gate } = clock(100_000);
  t.now = 99_000;
  const first = gate.check();
  assert(first);
  t.now = 0; // a clock can't go back, but the answer must not depend on it
  assertStrictEquals(gate.check(), first);
  assertStrictEquals(gate.stopped, first);
});

Deno.test("GATE: a revoked deadline stops at once, classified, with the raw reason kept", () => {
  const { deadline, gate } = clock();
  deadline.revoke("worker:mission_cancelled");
  assertEquals(gate.check(), { reason: "cancelled", detail: "worker:mission_cancelled" });
});

Deno.test("GATE: an aborted signal stops even with no deadline; NEVER_STOP and a missing deadline never stop", () => {
  const ac = new AbortController();
  const g = verificationStopGate(null, { signal: ac.signal });
  assertEquals(g.check(), null);
  ac.abort("ownership_lost");
  assertEquals(g.check()?.reason, "lease_lost");
  assertEquals(verificationStopGate(undefined).check(VERIFICATION_OPS.page), null);
  assertEquals(NEVER_STOP.check(), null);
});

// ═══════════════════════════════════════════════ the phase, scripted ════════

interface Script { calls: VerifierCall[]; underlying: number }

/**
 * A verifier that makes `n` sequential calls (a first read, a fallback, a
 * retry…) and reports what each call answered. `onCall` lets a test move the
 * clock or revoke mid-verifier.
 */
function fakeVerifier(key: string, n: number, s: Script, onCall?: (i: number) => void): ClaimVerifier {
  return {
    key, claim: "open_role", route_actor: `fake_${key}`, max_targets: 5,
    async verify(_targets, deps, ctx) {
      const outcomes: string[] = [];
      for (let i = 0; i < n; i++) {
        const out = await deps.call({ actor_key: `fake_${key}`, capability: "x", input: { i }, candidate_keys: ["c"], purpose: "hiring_evidence" });
        outcomes.push(out.status);
        onCall?.(i);
      }
      // Its own runs are carried back when any call was deferred, as the real verifiers do.
      const pending: PendingVerifierRun[] = outcomes.includes("deferred") ? [...ctx.pending] : [];
      return { findings: [{ company_key: "c", item: null, answered: !outcomes.includes("deferred"), detail: { outcomes } }], pending };
    },
  };
}

const run = (s: Script, verifiers: ClaimVerifier[], pending: PendingVerifierRun[], stop?: ReturnType<typeof verificationStopGate>) =>
  runClaimVerificationPhase({
    mission_id: "m", requested_count: 3, candidates: () => [], qualified: () => 0, criteriaValue: () => null,
    verifiers, pending,
    deps: {
      call: (c: VerifierCall): Promise<VerifierCallOutcome> => {
        s.calls.push(c);
        s.underlying++;
        return Promise.resolve({ status: "ok", rows: [], provider_call_id: `pc${s.underlying}` });
      },
      now: () => "2026-10-13T00:00:00Z", log: () => {},
    },
    apply: () => true,
    ...(stop ? { stop } : {}),
  });

const pendingFor = (verifier: string, run_id: string): PendingVerifierRun => ({
  verifier, stage: "s", actor_key: `fake_${verifier}`, run_id, input: { run_id }, candidate_keys: ["c"], started_at: "t0",
});

Deno.test("PHASE: deadline expired BEFORE verification — no call, every in-flight run carried unchanged, reason recorded", async () => {
  const { t, gate } = clock(100_000);
  t.now = 95_000;
  const s: Script = { calls: [], underlying: 0 };
  const pa = pendingFor("a", "run-a"), pb = pendingFor("b", "run-b");
  const r = await run(s, [fakeVerifier("a", 2, s), fakeVerifier("b", 2, s)], [pa, pb], gate);
  assertEquals(s.underlying, 0, "nothing reserved, sent or adopted");
  assertEquals(r.ran, []);
  assertEquals(r.changed, 0, "no finding: nothing answered, nothing marked");
  assertStrictEquals(r.pending[0], pa, "the SAME run object — run id, input, carry untouched");
  assertStrictEquals(r.pending[1], pb);
  assertEquals(r.stopped_by?.reason, "deadline");
  assertEquals(r.deferred, ["a", "b"]);
});

Deno.test("PHASE: deadline DURING verification — the next verifier does not start; its run is carried", async () => {
  const { t, gate } = clock(100_000);
  const s: Script = { calls: [], underlying: 0 };
  const pb = pendingFor("b", "run-b");
  const r = await run(s, [
    fakeVerifier("a", 1, s, () => { t.now = 90_000; }), // the clock passes the reserve during "a"
    fakeVerifier("b", 2, s),
  ], [pendingFor("a", "run-a"), pb], gate);
  assertEquals(s.underlying, 1, "only a's call went out");
  assertEquals(r.ran.map((x) => x.verifier), ["a"]);
  assertStrictEquals(r.pending.at(-1), pb);
  assertEquals(r.deferred, ["b"]);
  assertEquals(r.stopped_by?.reason, "deadline");
});

Deno.test("PHASE: nested calls inside one verifier — a fallback and a retry after the stop are never sent", async () => {
  const { t, gate } = clock(100_000);
  const s: Script = { calls: [], underlying: 0 };
  let seen: string[] = [];
  const v = fakeVerifier("a", 3, s, (i) => { if (i === 0) t.now = 90_000; });
  const inner = v.verify.bind(v);
  v.verify = async (targets, deps, ctx) => {
    const res = await inner(targets, deps, ctx);
    seen = res.findings[0].detail.outcomes as string[];
    return res;
  };
  const r = await run(s, [v], [pendingFor("a", "run-a")], gate);
  assertEquals(s.underlying, 1, "the first read only");
  assertEquals(seen, ["ok", "deferred", "deferred"], "every later call is answered `deferred` without being sent");
  assertEquals(r.deferred, ["a"], "the verifier is reported cut short");
  assertEquals(r.stopped_by?.reason, "deadline");
});

Deno.test("PHASE: a cancellation mid-phase stops the rest — reason `cancelled`", async () => {
  const { deadline, gate } = clock();
  const s: Script = { calls: [], underlying: 0 };
  const r = await run(s, [
    fakeVerifier("a", 1, s, () => deadline.revoke("worker:mission_cancelled")),
    fakeVerifier("b", 1, s),
  ], [pendingFor("a", "run-a"), pendingFor("b", "run-b")], gate);
  assertEquals(s.underlying, 1);
  assertEquals(r.stopped_by?.reason, "cancelled");
  assertEquals(r.deferred, ["b"]);
});

Deno.test("PHASE: a lost lease mid-phase stops the rest — reason `lease_lost`", async () => {
  const { deadline, gate } = clock();
  const s: Script = { calls: [], underlying: 0 };
  const r = await run(s, [
    fakeVerifier("a", 2, s, (i) => { if (i === 0) deadline.revoke("worker:ownership_lost"); }),
  ], [pendingFor("a", "run-a")], gate);
  assertEquals(s.underlying, 1);
  assertEquals(r.stopped_by?.reason, "lease_lost");
});

Deno.test("PHASE: with room left the gate changes nothing — same calls, same report", async () => {
  const s1: Script = { calls: [], underlying: 0 }, s2: Script = { calls: [], underlying: 0 };
  const mk = (s: Script) => [fakeVerifier("a", 2, s), fakeVerifier("b", 1, s)];
  const pend = () => [pendingFor("a", "run-a"), pendingFor("b", "run-b")];
  const without = await run(s1, mk(s1), pend());
  const withGate = await run(s2, mk(s2), pend(), clock().gate);
  assertEquals(s2.calls, s1.calls);
  assertEquals(withGate, without);
  assertEquals(withGate.stopped_by, null);
  assertEquals(withGate.deferred, []);
});

Deno.test("PHASE: a stop with NOTHING to withhold is not reported as a cut-short slice", async () => {
  const { t, gate } = clock(100_000);
  t.now = 95_000;
  const s: Script = { calls: [], underlying: 0 };
  // No pending runs and no candidates: neither verifier had work.
  const r = await run(s, [fakeVerifier("a", 1, s)], [], gate);
  assertEquals(s.underlying, 0);
  assertEquals(r.stopped_by, null, "nothing was deferred, so the slice is not 'cut short'");
  assertEquals(r.deferred, []);
});

// ═════════════════════════════════════════════════ continuation fold ════════

const barrenSlice = { qualifiedInPool: 0, uniqueCompaniesInvestigatedInPool: 0, authorisationsInPool: 0, costUnitsInLineage: 0 };

Deno.test("FOLD: a barren slice the stop cut short neither moves toward no_progress nor resets the count", () => {
  const prior = { ...readLineageProgress({}), barren_slices: 1 };
  assertEquals(foldSlice(prior, { ...barrenSlice, deferredByStop: true }).barren_slices, 1);
  assertEquals(foldSlice(prior, barrenSlice).barren_slices, 2, "without the stop: exactly the old rule");
  assertEquals(foldSlice(prior, { ...barrenSlice, deferredByStop: false }).barren_slices, 2);
});

Deno.test("FOLD: a PRODUCTIVE slice resets the count whether or not it was cut short", () => {
  const prior = { ...readLineageProgress({}), barren_slices: 1 };
  const productive = { ...barrenSlice, qualifiedInPool: 1 };
  assertEquals(foldSlice(prior, { ...productive, deferredByStop: true }).barren_slices, 0);
  assertEquals(foldSlice(prior, productive).barren_slices, 0);
});

Deno.test("FOLD: the stop never changes the continuation count — every slice is still bounded by the ceiling", () => {
  const prior = readLineageProgress({ continuations_used: 3 });
  assertEquals(foldSlice(prior, { ...barrenSlice, deferredByStop: true }).continuations_used, 4);
  assertFalse(foldSlice(prior, { ...barrenSlice, deferredByStop: true }).barren_slices > prior.barren_slices);
});

Deno.test("PHASE: a deferred STEP (no provider run) is reported apart from runs in flight, and both are handed back", async () => {
  const { t, gate } = clock(100_000);
  const s: Script = { calls: [], underlying: 0 };
  const running = pendingFor("a", "run-a");
  const step: PendingVerifierRun = { ...pendingFor("a", ""), stage: "pvalyou_deferred", deferred: true };
  const v: ClaimVerifier = {
    key: "a", claim: "funding_stage", route_actor: "fake_a", max_targets: 5,
    async verify(_t, deps, ctx) {
      await deps.call({ actor_key: "fake_a", capability: "x", input: {}, candidate_keys: ["c"], purpose: "funding_evidence" });
      t.now = 95_000; // the reserve passes after the first purchase
      const out = await deps.call({ actor_key: "fake_a", capability: "x", input: { second: true }, candidate_keys: ["c"], purpose: "funding_evidence" });
      assertEquals(out.status, "deferred");
      return { findings: [], pending: [...ctx.pending, step] };
    },
  };
  const r = await run(s, [v], [running], gate);
  assertEquals(r.pending, [running], "only the provider run — what continuation waits on");
  assertEquals(r.deferred_steps, [step], "the deferred step travels apart");
  // The next slice is handed both, and the in-flight hold covers both.
  const next = await run({ calls: [], underlying: 0 }, [fakeVerifier("a", 0, s)], [...r.pending, ...r.deferred_steps!], verificationStopGate(null));
  assertEquals(next.pending.length + (next.deferred_steps?.length ?? 0), 0, "adopted/resumed by the verifier");
});

Deno.test("PHASE: once the request is met a deferred step is carried, never resumed — it would be a NEW purchase", async () => {
  const s: Script = { calls: [], underlying: 0 };
  const running = pendingFor("a", "run-a");
  const step: PendingVerifierRun = { ...pendingFor("a", ""), stage: "pvalyou_deferred", deferred: true };
  let handed: PendingVerifierRun[] = [];
  const v: ClaimVerifier = {
    key: "a", claim: "funding_stage", route_actor: "fake_a", max_targets: 5,
    verify(_t, _deps, ctx) { handed = [...ctx.pending]; return Promise.resolve({ findings: [], pending: [] }); },
  };
  const r = await runClaimVerificationPhase({
    mission_id: "m", requested_count: 1, candidates: () => [], qualified: () => 1, criteriaValue: () => null,
    verifiers: [v], pending: [running, step],
    deps: { call: () => { s.underlying++; return Promise.resolve({ status: "ok", rows: [], provider_call_id: "p" }); }, now: () => "t", log: () => {} },
    apply: () => true,
  });
  assertEquals(r.stopped, "quota_met");
  assertEquals(handed, [running], "the paid run is still adopted");
  assertEquals(r.deferred_steps, [step], "the step is carried, not bought");
});
