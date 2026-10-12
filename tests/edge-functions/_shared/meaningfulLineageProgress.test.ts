// A SLICE IS PRODUCTIVE ONLY WHEN IT ADVANCES A CANDIDATE.
//
// Query B d22d9ee6 (2026-10-12): qualified stayed 1, in band stayed 4, and
// `barren_slices` stayed 0 for six slices — because `claimProgressCount` counted
// every resolved hard check across EVERY lead, and each new out-of-band
// employer the re-plans found brought a failed size check with it. A
// 1,000-person company failing "11–50" is not progress on this mission.
//
// Counted: a candidate admitted past discovery, a hard claim resolved on an
// admitted candidate (pass or fail), a verifier route answered.
// Not counted: a company the discovery gate screened out, however many.
//
// PURE.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimProgressCount, decideAutoContinuation, foldSlice, readLineageProgress, type LineageProgress,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

type Lead = { bucket: string; hard_check_details: Array<{ result: string }> };
const screened = (n: number): Lead[] => Array.from({ length: n }, () => ({
  bucket: "screened_out", hard_check_details: [{ result: "fail" }, { result: "pass" }, { result: "pass" }],
}));
const pending = (passes = 3): Lead => ({
  bucket: "pending", hard_check_details: [...Array(passes).fill({ result: "pass" }), { result: "unknown" }],
});
const qualifiedLead: Lead = { bucket: "strong_opportunity", hard_check_details: Array(4).fill({ result: "pass" }) };

function slice(prior: LineageProgress, leads: Lead[], routes: number[] = [], qualified = 0, investigated = 4) {
  return foldSlice(prior, {
    qualifiedInPool: qualified, uniqueCompaniesInvestigatedInPool: investigated, authorisationsInPool: investigated,
    costUnitsInLineage: 1, brainDecidedInPool: investigated,
    claimProgressInPool: claimProgressCount({ leads, attemptedRoutesPerCompany: routes }),
  });
}
const base = () => slice(readLineageProgress({}), [qualifiedLead, pending(), pending(), pending(), ...screened(40)], [1, 1, 1], 1);

Deno.test("1. twenty new out-of-range employers and nothing else → the slice is barren", () => {
  const p0 = base();
  const p1 = slice(p0, [qualifiedLead, pending(), pending(), pending(), ...screened(60)], [1, 1, 1], 1);
  assertEquals(p1.barren_slices, p0.barren_slices + 1);
});

Deno.test("2. one new admitted in-band candidate → productive", () => {
  const p0 = base();
  const p1 = slice(p0, [qualifiedLead, pending(), pending(), pending(), { bucket: "investigating", hard_check_details: [] }, ...screened(40)], [1, 1, 1], 1);
  assertEquals(p1.barren_slices, 0);
});

Deno.test("3. an existing pending candidate gets one hard claim proven → productive", () => {
  const p0 = base();
  const p1 = slice(p0, [qualifiedLead, pending(4), pending(), pending(), ...screened(40)], [1, 1, 1], 1);
  assertEquals(p1.barren_slices, 0);
});

Deno.test("4. a verifier resolves a real gap to fail → productive", () => {
  const p0 = base();
  const ineligible: Lead = { bucket: "ineligible", hard_check_details: [{ result: "pass" }, { result: "pass" }, { result: "pass" }, { result: "fail" }] };
  const p1 = slice(p0, [qualifiedLead, ineligible, pending(), pending(), ...screened(40)], [2, 1, 1], 1);
  assertEquals(p1.barren_slices, 0);
});

Deno.test("5. the same rejected company found again → not productive", () => {
  const p0 = base();
  const p1 = slice(p0, [qualifiedLead, pending(), pending(), pending(), ...screened(40)], [1, 1, 1], 1);
  assertEquals(p1.barren_slices, p0.barren_slices + 1);
});

Deno.test("6. two consecutive truly barren slices → the no-progress guard ends the lineage", () => {
  let p = base();
  for (let i = 0; i < 2; i++) p = slice(p, [qualifiedLead, pending(), pending(), pending(), ...screened(40 + 20 * (i + 1))], [1, 1, 1], 1);
  assertEquals(p.barren_slices, 2);
  const d = decideAutoContinuation({
    cancelled: false, qualified: 1, requestedCount: 3, frontierRemaining: 0, continuationsUsed: p.continuations_used,
    maxContinuations: 10, costUnitsUsed: 3, maxCostUnits: 40, barrenSlices: p.barren_slices, providerFailed: false,
    pendingRuns: 0, verificationRoutesRemain: 0, discoveryRoutesRemain: true,
  } as never);
  assertEquals([d.continue, d.reason], [false, "no_progress"]);
});

Deno.test("screened-out leads contribute nothing to the count; admitted ones contribute their admission and checks", () => {
  assertEquals(claimProgressCount({ leads: screened(100), attemptedRoutesPerCompany: [] }), 0);
  assert(claimProgressCount({ leads: [{ bucket: "investigating", hard_check_details: [] }], attemptedRoutesPerCompany: [] }) > 0);
});
