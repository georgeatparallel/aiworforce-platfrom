// D3 — HOW LONG A PENDING PROVIDER RUN MAY HOLD A LINEAGE.
//
// `awaiting_provider_run` used to be bounded only by the continuation ceiling:
// a paid run nobody asked again (Query B d22d9ee6's replenishment page, chaos
// lab tests/replay/failure) held the lineage for every continuation it had.
// ZERO network, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  awaitedPendingRuns, decideAutoContinuation, PENDING_RUN_MAX_POLLS, PENDING_RUN_MAX_WAIT_MS,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

Deno.test("D3 a pending run holds the lineage until it has been asked again PENDING_RUN_MAX_POLLS times", () => {
  for (let polls = 0; polls < PENDING_RUN_MAX_POLLS; polls++) {
    assertEquals(awaitedPendingRuns([{ polls, started_at: at(60_000) }], NOW), { awaited: 1, overdue: 0 }, String(polls));
  }
  assertEquals(awaitedPendingRuns([{ polls: PENDING_RUN_MAX_POLLS, started_at: at(60_000) }], NOW), { awaited: 0, overdue: 1 });
});

Deno.test("D3 …or until it is older than PENDING_RUN_MAX_WAIT_MS, whatever its polls — an undated run is judged by polls alone", () => {
  assertEquals(awaitedPendingRuns([{ started_at: at(PENDING_RUN_MAX_WAIT_MS + 1) }], NOW), { awaited: 0, overdue: 1 });
  assertEquals(awaitedPendingRuns([{ started_at: at(PENDING_RUN_MAX_WAIT_MS - 1) }], NOW), { awaited: 1, overdue: 0 });
  assertEquals(awaitedPendingRuns([{ started_at: null }, {}], NOW), { awaited: 2, overdue: 0 });
  assertEquals(awaitedPendingRuns(undefined, NOW), { awaited: 0, overdue: 0 });
  assert(PENDING_RUN_MAX_WAIT_MS >= 30 * 60_000, "long enough for a large Apify job search");
});

Deno.test("D3 an overdue run no longer suppresses the lineage's findings; an awaited one still does", () => {
  const base = {
    qualified: 0, requestedCount: 5, frontierRemaining: 0, continuationsUsed: 3, maxContinuations: 25,
    costUnitsUsed: 4, maxCostUnits: 100, barrenSlices: 2, discoveryRoutesRemain: false, verificationRoutesRemain: 0,
  };
  const awaited = awaitedPendingRuns([{ polls: 1, started_at: at(60_000) }], NOW).awaited;
  assertEquals(decideAutoContinuation({ ...base, pendingRuns: awaited } as never).reason, "awaiting_provider_run");
  const overdue = awaitedPendingRuns([{ polls: PENDING_RUN_MAX_POLLS, started_at: at(60_000) }], NOW).awaited;
  const d = decideAutoContinuation({ ...base, pendingRuns: overdue } as never);
  assert(d.reason !== "awaiting_provider_run", d.reason);
  assertEquals(d.continue, false, "the frontier finding can be stated");
});

Deno.test("D3 the engine records the question behind a pending discovery run, re-asks it adoption-only, and reads runs pending NOW", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url));
  for (const m of [
    // the selection is kept on the pending entry …
    "r.selection = structuredClone(sel);",
    // … a still-pending re-ask is counted …
    "if (stillPending) stillPending.polls = (stillPending.polls ?? 0) + 1;",
    // … discovery reopens DRAIN-ONLY to ask it …
    'log("discovery_reopened_to_adopt_pending_runs", {',
    "if (drainOnly) strategy.selections.length = 0;",
    "for (let pass = 2; !drainOnly && pass <= passLimit; pass++) {",
    // … and the re-ask may adopt its own run and nothing else.
    "if (adoptOnlyRun && !(inFlight && inFlight.run_id === adoptOnlyRun.run_id)) {",
    // pending NOW, not the attempt history
    "state.pending_runs.some(\n          (r) => r.provider === provider && (r.capability === cap || r.capability === null));",
  ]) assert(src.includes(m), `missing: ${m}`);
});

// ── THE SPEND FLOOR COUNTS PURCHASES, NOT RE-READS ──────────────────────────

import { spendFloorFromRows } from "../../../supabase/functions/_shared/missionSpendCap.ts";

Deno.test("D3 a re-read of a run still executing (`timed_out`, resume_run_id set) is not a paid call in the spend floor", () => {
  const bought = { status: "timed_out", provider_call_id: "pc-1", settled_usd: null, actual_cost_usd: null, estimate_usd: "0.05" };
  const polls = [1, 2, 3].map(() => ({ ...bought, resumed_from: "run-1" }));
  const adopted = { ...bought, status: "reused", resumed_from: "run-1" };
  assertEquals(spendFloorFromRows([bought, ...polls, adopted]), { committed_usd: 0.05, paid_calls: 1, source: "lead_execution_calls" });
  // A row read without the column keeps its old meaning: a timed-out purchase is paid.
  assertEquals(spendFloorFromRows([bought]).paid_calls, 1);
});
