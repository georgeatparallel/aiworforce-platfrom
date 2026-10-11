// A ROUTE THAT CAN ONLY REPLAY WHAT IT ALREADY READ IS NOT A ROUTE.
//
// Production Query B (task d72bc1ce, 2026-10-11): requested 3, 1 qualified.
// The job search had read its page limit (3 of 3) and the adaptive reserve was
// spent. Slices 7 and 8 each reopened discovery, re-asked the same question
// (replayed for free, the same 34 companies), had their re-plan refused with
// `adaptive_reserve_exhausted`, and investigated nobody — because discovery
// recorded `exhausted: false, stop_reason: "amendment_refused"`, which
// `run-agent` reads as "discovery routes remain". Only the barren-slice guard
// ended the mission, two slices (~8 minutes) late.
//
// The rule: on a replenishment slice that leaves no page unread — none could
// be proposed, OR the last one was read this slice (Query B rerun 255c333f,
// slice 8 → barren slice 9) — and no approved route still unattempted, a
// re-plan refused because the adaptive reserve is spent leaves nothing that
// could widen the pool. A refusal that can clear (the continuation holding its
// plan while candidates remain) is not that.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discoveryCannotWiden } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import {
  type AutoContinuationInput, decideAutoContinuation, settleV2Terminal,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

// The production state at the end of slice 7: replenishing, no page proposed
// (job search at 3 of 3), re-plan refused because the reserve was $0.
const QUERY_B_SLICE_7 = {
  replenishing: true, unread_pages_remaining: 0, unattempted_routes: 0, amendment_refusal: "adaptive_reserve_exhausted",
};
// Query B rerun (255c333f) slice 8: page 3 of 3 PROPOSED AND READ this slice,
// re-plan refused for the same reason. After the commit, no page is unread.
const QUERY_B_RERUN_SLICE_8 = { ...QUERY_B_SLICE_7 };

Deno.test("production Query B: page limit reached + reserve spent → discovery cannot widen", () => {
  assert(discoveryCannotWiden(QUERY_B_SLICE_7));
});

Deno.test("rerun slice 8: the LAST page read this slice + reserve spent → discovery cannot widen, now", () => {
  assert(discoveryCannotWiden(QUERY_B_RERUN_SLICE_8));
});

Deno.test("1. a page still unread after this slice → discovery may continue", () => {
  assertFalse(discoveryCannotWiden({ ...QUERY_B_SLICE_7, unread_pages_remaining: 1 }));
});

Deno.test("2. an approved route not yet attempted (an alternate route) → discovery may continue", () => {
  assertFalse(discoveryCannotWiden({ ...QUERY_B_SLICE_7, unattempted_routes: 1 }));
});

Deno.test("3. an amendment the reserve could still pay for → discovery may continue", () => {
  assertFalse(discoveryCannotWiden({ ...QUERY_B_SLICE_7, amendment_refusal: null }));
  // The continuation holding its plan while candidates remain clears later.
  assertFalse(discoveryCannotWiden({ ...QUERY_B_SLICE_7, amendment_refusal: "continuation_holds_plan" }));
  // Refusals this fix does not reason about stay conservative (routes remain).
  assertFalse(discoveryCannotWiden({ ...QUERY_B_SLICE_7, amendment_refusal: "validation_failed" }));
});

Deno.test("a first discovery slice is never judged spent by this rule", () => {
  assertFalse(discoveryCannotWiden({ ...QUERY_B_SLICE_7, replenishing: false }));
});

// ── what the continuation then decides ───────────────────────────────────────

const AFTER_SLICE: AutoContinuationInput = {
  qualified: 1, requestedCount: 3, frontierRemaining: 0,
  continuationsUsed: 6, maxContinuations: 10, costUnitsUsed: 12, maxCostUnits: 120, barrenSlices: 0,
};

Deno.test("5. production: a replay-only route ends the mission now, not two barren slices later", () => {
  // BEFORE: discovery recorded exhausted:false, so routes "remained".
  const before = decideAutoContinuation({ ...AFTER_SLICE, discoveryRoutesRemain: true });
  assert(before.continue);
  assertEquals(before.reason, "replenishment_required");
  // AFTER: discovery records it cannot widen, so `run-agent` passes false.
  const after = decideAutoContinuation({ ...AFTER_SLICE, discoveryRoutesRemain: !discoveryCannotWiden(QUERY_B_SLICE_7) });
  assertFalse(after.continue);
  assertEquals(after.reason, "frontier_exhausted");
  assertEquals(settleV2Terminal(after.reason, "completed"), "search_exhausted");
});

Deno.test("5b. rerun slice 8: last page + reserve 0 + empty frontier → search_exhausted after THIS slice", () => {
  const d = decideAutoContinuation({ ...AFTER_SLICE, discoveryRoutesRemain: !discoveryCannotWiden(QUERY_B_RERUN_SLICE_8) });
  assertFalse(d.continue);
  assertEquals(settleV2Terminal(d.reason, "completed"), "search_exhausted");
});

Deno.test("4b. last page read but candidates on the frontier → keep investigating them", () => {
  const d = decideAutoContinuation({ ...AFTER_SLICE, frontierRemaining: 3,
    discoveryRoutesRemain: !discoveryCannotWiden(QUERY_B_RERUN_SLICE_8) });
  assert(d.continue);
  assertEquals(d.reason, "quota_unmet_frontier_remains");
});

Deno.test("4. candidates still on the frontier → keep investigating", () => {
  const d = decideAutoContinuation({ ...AFTER_SLICE, frontierRemaining: 5, discoveryRoutesRemain: false });
  assert(d.continue);
  assertEquals(d.reason, "quota_unmet_frontier_remains");
});

Deno.test("6. the barren-slice guard still ends a route that reads open but widens nothing", () => {
  const d = decideAutoContinuation({ ...AFTER_SLICE, discoveryRoutesRemain: true, barrenSlices: 2 });
  assertFalse(d.continue);
  assertEquals(d.reason, "no_progress");
});
