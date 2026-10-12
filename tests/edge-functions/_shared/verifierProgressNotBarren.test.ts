// A VERIFIER THAT ANSWERED IS PROGRESS — canary 9230df70 (production, 2026-10-03).
//
// After PR #14 the run widened correctly (page 1 → replenishment → page 2,
// 19 companies), then spent two slices verifying page 2's companies — Atomus,
// Pvalyou, Firecrawl, and adopting the Pvalyou runs those slices started. Both
// were counted BARREN: progress was read only from qualified / investigated /
// "decided" (qualified + pending + ineligible), and a company verified from
// pending to ineligible is still decided. `barren_slices` hit 2 and the lineage
// stopped `no_progress` → `search_exhausted` before page 3, with discovery open.
//
// The logged sequence, slice by slice (worker logs, auto-continuation):
//
//   slice 1  page 1, enrichment, Atomus + Pvalyou started   barren 0  awaiting_provider_run
//   slice 2  Pvalyou adopted, Atomus/Firecrawl/job search    barren 1  replenishment_required
//   slice 3  page 2 (+9 companies), enrichment, verifiers    barren 0  awaiting_provider_run
//   slice 4  Atomus/Pvalyou/Firecrawl on page 2              barren 1  awaiting_provider_run
//   slice 5  last Pvalyou run adopted                        barren 2  no_progress   ← the stop
//
// Replayed here through the real `foldSlice` and `decideAutoContinuation`.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimProgressCount, decideAutoContinuation, foldSlice, readLineageProgress, sliceWasBarren,
  MAX_BARREN_SLICES, type LineageProgress,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

const START: LineageProgress = readLineageProgress({});

interface Slice {
  label: string;
  /** Cumulative, as run-agent passes them. */
  investigated: number;
  decided: number;
  costUnits: number;
  /** Canonical claim progress after the slice (resolved hard checks + answered verifier routes). */
  claimProgress: number;
  pendingRuns: number;
  /** Pending candidates with an executable route (`with_executable_route`). */
  verifiable: number;
}

// The canary's slices. Claim progress grows exactly when a verifier answered:
// size + country resolved for 10, then 19 companies; funding answered or failed;
// first-party pages read; routes closed.
const CANARY: Slice[] = [
  { label: "1: page 1",              investigated: 10, decided: 10, costUnits: 2, claimProgress: 22, pendingRuns: 2, verifiable: 0 },
  { label: "2: verify page 1",       investigated: 10, decided: 10, costUnits: 2, claimProgress: 34, pendingRuns: 0, verifiable: 0 },
  { label: "3: page 2",              investigated: 19, decided: 19, costUnits: 4, claimProgress: 58, pendingRuns: 3, verifiable: 0 },
  { label: "4: verify page 2",       investigated: 19, decided: 19, costUnits: 4, claimProgress: 69, pendingRuns: 1, verifiable: 0 },
  { label: "5: adopt last Pvalyou",  investigated: 19, decided: 19, costUnits: 4, claimProgress: 71, pendingRuns: 0, verifiable: 0 },
];

function replay(slices: Slice[], o: { withClaimProgress: boolean; discoveryRoutesRemain?: boolean }) {
  let progress = START;
  const out: Array<{ label: string; barren: number; decision: string; continue: boolean }> = [];
  for (const s of slices) {
    progress = foldSlice(progress, {
      qualifiedInPool: 0,
      uniqueCompaniesInvestigatedInPool: s.investigated,
      authorisationsInPool: s.investigated,
      costUnitsInLineage: s.costUnits,
      brainDecidedInPool: s.decided,
      ...(o.withClaimProgress ? { claimProgressInPool: s.claimProgress } : {}),
    });
    const d = decideAutoContinuation({
      cancelled: false, qualified: 0, requestedCount: 1, frontierRemaining: 0,
      continuationsUsed: progress.continuations_used, maxContinuations: 8,
      costUnitsUsed: progress.cost_units_used, maxCostUnits: 50,
      barrenSlices: progress.barren_slices, providerFailed: false,
      pendingRuns: s.pendingRuns, verificationRoutesRemain: s.verifiable,
      // Discovery still had 18 pages: `discovery_source_state.exhausted: false`.
      discoveryRoutesRemain: o.discoveryRoutesRemain ?? true,
    } as never);
    out.push({ label: s.label, barren: progress.barren_slices, decision: String(d.reason), continue: d.continue });
    if (!d.continue) break;
  }
  return out;
}

// ── the canary ─────────────────────────────────────────────────────────────

Deno.test("CANARY 9230df70 AS IT RAN: without claim progress, slices 2, 4 and 5 are barren and the lineage stops before page 3", () => {
  const r = replay(CANARY, { withClaimProgress: false });
  assertEquals(r.map((x) => x.barren), [0, 1, 0, 1, 2]);
  assertEquals(r.map((x) => x.decision),
    ["awaiting_provider_run", "replenishment_required", "awaiting_provider_run", "awaiting_provider_run", "no_progress"]);
  assertFalse(r.at(-1)!.continue, "the production stop: no_progress with discovery open");
});

Deno.test("CANARY 9230df70 FIXED: verifier slices are progress, and slice 5 asks for page 3 instead of stopping", () => {
  const r = replay(CANARY, { withClaimProgress: true });
  assertEquals(r.map((x) => x.barren), [0, 0, 0, 0, 0], "every slice answered a verifier");
  assertEquals(r.at(-1)!.decision, "replenishment_required", "the pool is unworkable and discovery is open: widen again");
  assert(r.at(-1)!.continue);
});

// ── genuine no-progress still stops ────────────────────────────────────────

Deno.test("GENUINE NO PROGRESS: two slices that change no claim, adopt nothing and add no company still end no_progress", () => {
  const stuck: Slice[] = [
    ...CANARY,
    { label: "6: page 3 returned nothing new", investigated: 19, decided: 19, costUnits: 5, claimProgress: 71, pendingRuns: 0, verifiable: 0 },
    { label: "7: still nothing",               investigated: 19, decided: 19, costUnits: 5, claimProgress: 71, pendingRuns: 0, verifiable: 0 },
  ];
  const r = replay(stuck, { withClaimProgress: true });
  assertEquals(r.map((x) => x.barren), [0, 0, 0, 0, 0, 1, 2]);
  assertEquals(r.at(-1)!.decision, "no_progress");
  assertFalse(r.at(-1)!.continue);
  assertEquals(MAX_BARREN_SLICES, 2, "the threshold itself is unchanged");
});

Deno.test("GENUINE EXHAUSTION: with discovery exhausted and nothing workable, the lineage ends frontier_exhausted", () => {
  const r = replay(CANARY, { withClaimProgress: true, discoveryRoutesRemain: false });
  const last = r.at(-1)!;
  assertFalse(last.continue);
  assertEquals(last.decision, "frontier_exhausted");
});

Deno.test("WORKABLE CANDIDATES: verification comes before widening, exactly as before", () => {
  const r = replay([{ ...CANARY[1], verifiable: 3 }], { withClaimProgress: true });
  assertEquals(r[0].decision, "verification_required");
});

// ── the counting itself ────────────────────────────────────────────────────

Deno.test("claimProgressCount: resolved hard checks (pass or fail) plus answered verifier routes; unknown counts nothing", () => {
  const leads = [
    { hard_check_details: [{ result: "pass" }, { result: "pass" }, { result: "unknown" }, { result: "fail" }] },
    { hard_check_details: [{ result: "unknown" }, { result: "unknown" }] },
    { hard_check_details: null },
  ];
  // Each admitted (not screened-out) lead also counts once for its admission
  // (Query B d22d9ee6 — see meaningfulLineageProgress.test.ts): 3 leads → +3.
  assertEquals(claimProgressCount({ leads, attemptedRoutesPerCompany: [2, 0, 1] }), 3 + 3 + 3);
  // A verifier answering inconclusively still closes a route — that is progress.
  assertEquals(claimProgressCount({ leads, attemptedRoutesPerCompany: [2, 1, 1] }), 3 + 3 + 4);
});

Deno.test("sliceWasBarren: claim progress alone prevents a barren slice; absent, the old rule is unchanged", () => {
  assertFalse(sliceWasBarren({ qualifiedDelta: 0, investigatedDelta: 0, brainDecidedDelta: 0, claimProgressDelta: 1 }));
  assert(sliceWasBarren({ qualifiedDelta: 0, investigatedDelta: 0, brainDecidedDelta: 0, claimProgressDelta: 0 }));
  assert(sliceWasBarren({ qualifiedDelta: 0, investigatedDelta: 0, brainDecidedDelta: 0 }), "old callers: old behaviour");
});

Deno.test("claim_progress survives a resume; an older checkpoint without it reads 0 (first slice counts as progress — the safe direction)", () => {
  const after = foldSlice(START, {
    qualifiedInPool: 0, uniqueCompaniesInvestigatedInPool: 10, authorisationsInPool: 10, costUnitsInLineage: 2,
    brainDecidedInPool: 10, claimProgressInPool: 22,
  });
  assertEquals(readLineageProgress(JSON.parse(JSON.stringify(after))).claim_progress, 22);
  const legacy = readLineageProgress({ continuations_used: 3, barren_slices: 1, brain_decided: 19 });
  assertEquals(legacy.claim_progress, 0);
  const next = foldSlice(legacy, {
    qualifiedInPool: 0, uniqueCompaniesInvestigatedInPool: 0, authorisationsInPool: 0, costUnitsInLineage: 0,
    brainDecidedInPool: 19, claimProgressInPool: 40,
  });
  assertEquals(next.barren_slices, 0);
});

Deno.test("run-agent feeds claim progress into the fold, from the canonical view and the answered routes", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  const at = src.indexOf("const progress = foldSlice(priorProgress, {");
  assert(at > 0);
  const call = src.slice(at, src.indexOf("const autoDecision = decideAutoContinuation(", at));
  assert(call.includes("claimProgressInPool: claimProgressCount({"), "the fold receives claim progress");
  assert(call.includes("leads: p5View.leads"), "resolved checks come from the canonical view");
  assert(call.includes("attemptedRoutes(c.completed_operations)"), "answered routes come from the working set");
});
