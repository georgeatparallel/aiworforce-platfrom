// HISTORICAL G — QUERY B a9a6791a (production 2026-10-12): THE LATEST JOB-FIRST LINEAGE.
//
// "Find 3 US software companies with 11–50 employees that are currently hiring
// sales." 3 slices, 11m17s, $0.1838, 2 of 3 qualified, search_exhausted via
// the barren-slice guard. As it ran:
//
//   slice 1  page 1: 21 employers, 15 rejected on a disjoint declared band at
//            discovery, 6 admitted; route control re-asked page 1 ("deepen",
//            adopted — nothing new), then proposed FOUR titles to an actor that
//            accepts three → compile_failed → stop_reason schema_failure
//   slice 2  page 2 bought — and stop_reason schema_failure AGAIN: slice 1's
//            compile failure was read from the lineage's attempt history
//   slice 3  page 3 bought — a replay of page 2 (same counts, no new employer)
//            — still schema_failure, and still "not exhausted"
//
// The slice-2 selector also searched "account manager" for a sales mission.
// Each fix is asserted against the corrected behaviour; the anchors pin the
// production funnel first so a drifted reconstruction fails before them.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { replayEngineSlice } from "../lib/engine.ts";
import {
  carried, discoveryState, JOB_SEARCH, jobSearchCalls, qualifiedNames, queryBFixture,
  recordedRouteControl, replayLineage, selectingInput,
} from "../lib/queryB.ts";
import { decideAutoContinuation, settleV2Outcome } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import * as actorInputs from "../../../supabase/functions/_shared/hiringActorInputs.ts";

const fx = queryBFixture();
const SALES = { role_families: ["gtm_sales"], window_days: null };
const titlesSent = (calls: Array<{ input: Record<string, unknown> }>) =>
  calls.flatMap((c) => (c.input.jobTitles as string[]) ?? []).join(" | ").toLowerCase();

// ══════════ ANCHORS: the production funnel, reproduced ═════════════════════

Deno.test("[historical] G anchors: page 1 → 21 employers, 15 disjoint-band rejects, 6 admitted, Perfect Venue + Shipday", async () => {
  const s1 = await replayEngineSlice(fx);
  assertEquals(s1.companies.length, 21);
  const early = s1.companies.filter((c) => c.prequalified?.size_exclusion_basis === "disjoint_declared_band_at_discovery");
  assertEquals(early.length, 15);
  assertEquals(s1.companies.filter((c) => c.prequalified?.eligible).length, 6);
  assertEquals(qualifiedNames(s1), ["Perfect Venue", "Shipday"]);
  assertEquals(s1.provider.calls.filter((c) => c.actor === "apify_linkedin_company_details").length, 1, "6 enriched in one call");
});

// ══════════ FIX 2 — the provider title limit holds before compile ═══════════

Deno.test("[historical] G FIX 2: route control's four titles reach the actor as at most three entries — no compile failure", async () => {
  const s1 = await replayEngineSlice(fx, { deps: { controlRoutes: recordedRouteControl(fx) } });
  const attempts = (s1.state.provider_attempts as Array<{ provider: string; outcome: string; reason: string | null }>);
  assertFalse(attempts.some((a) => a.outcome === "compile_failed"), attempts.map((a) => `${a.outcome}:${a.reason}`).join(" | "));
  for (const c of jobSearchCalls(s1)) {
    assert((c.input.jobTitles as string[]).length <= actorInputs.JOB_DISCOVERY_LIMITS.jobTitles, JSON.stringify(c.input.jobTitles));
  }
  const replan = jobSearchCalls(s1).find((c) => c.input.industryIds === undefined);
  assert(replan, "the replanned query was actually asked");
  const sent = titlesSent([replan]);
  for (const t of ["account executive", "sales development representative", "business development representative"]) {
    assert(sent.includes(t), `${t} is still searched (folded, not truncated): ${sent}`);
  }
  assert(discoveryState(s1).stop_reason !== "schema_failure");
});

Deno.test("[historical] G FIX 2: bounding is deterministic, dedupes before counting, and leaves a valid input untouched", () => {
  const bound = actorInputs.boundJobDiscoveryTitles;
  const four = ["Account Executive", "sales development representative", "account executive", "Business Development Representative", "Sales Manager"];
  const a = bound(four, SALES, 3);
  assertEquals(a, bound([...four], SALES, 3), "same input, same answer");
  assert(a.length <= 3);
  assertEquals(a.join(" ").toLowerCase().split("account executive").length - 1, 1, "the duplicate was removed before counting");
  const within = ['sales OR "account executive" OR "sales development representative"'];
  assertEquals(bound(within, SALES, 3), within, "an input already within the limit is sent verbatim (same input hash)");
});

// ══════════ FIX 3 — "account manager" is not a sales search term ═══════════

Deno.test("[historical] G FIX 3: the slice-2 query keeps every sales title and drops 'account manager'", async () => {
  const slice2Input = fx.engine.model_responses.plan_discovery_slice2[0].input;
  const s = await replayEngineSlice(fx, { deps: selectingInput(fx, slice2Input) });
  const sent = titlesSent(jobSearchCalls(s));
  assertFalse(sent.includes("account manager"), sent);
  for (const t of ["sales representative", "account executive", "sales development representative", "business development representative", "sales manager"]) {
    assert(sent.includes(t), `${t} kept: ${sent}`);
  }
});

Deno.test("[historical] G FIX 3: AE, Enterprise AE, SDR, BDR, Sales Manager and Sales Director all survive; Account Manager and CSM do not", () => {
  const out = actorInputs.boundJobDiscoveryTitles([
    'Account Executive OR "Enterprise Account Executive" OR SDR OR BDR',
    '"Sales Manager" OR "Sales Director" OR "Account Manager" OR "Customer Success Manager"',
  ], SALES, 3).join(" | ");
  for (const t of ["Account Executive", "Enterprise Account Executive", "SDR", "BDR", "Sales Manager", "Sales Director"]) {
    assert(out.includes(t), `${t}: ${out}`);
  }
  assertFalse(/account manager|customer success/i.test(out), out);
  // A customer-success mission keeps its own titles.
  assert(actorInputs.boundJobDiscoveryTitles(["Account Manager"], { role_families: ["customer_success"], window_days: null }, 3)
    .join(" ").includes("Account Manager"));
});

// ══════════ FIX 1 — a historical compile failure does not poison a slice ═══

Deno.test("[historical] G FIX 1: slice 1's compile failure is not slice 2's or slice 3's stop reason", async () => {
  // As production ran: slice 1 WITH its compile failure (state carried as-is).
  const s1 = await replayEngineSlice(fx, { deps: { controlRoutes: recordedRouteControl(fx) } });
  const state = structuredClone(s1.state) as { provider_attempts: Array<Record<string, unknown>> };
  if (!state.provider_attempts.some((a) => a.outcome === "compile_failed")) {
    // Fix 2 removed the failure; re-inject it so this test proves Fix 1 on its own.
    state.provider_attempts.push({ capability: "job_discovery", provider: JOB_SEARCH, attempt: 9, outcome: "compile_failed",
      rows: 0, cost_units: 0, reason: "jobTitles: 4 exceeds the verified limit of 3" });
  }
  const s2 = await replayEngineSlice(fx, { ...carried(s1), resume: { state, records: s1.resume_records } });
  assertEquals(jobSearchCalls(s2).map((c) => c.input.page), [2], "page 2 is bought");
  assert(discoveryState(s2).stop_reason !== "schema_failure", `slice 2: ${discoveryState(s2).stop_reason}`);
  const s3 = await replayEngineSlice(fx, carried(s2));
  assert(discoveryState(s3).stop_reason !== "schema_failure", `slice 3: ${discoveryState(s3).stop_reason}`);
});

Deno.test("[historical] G FIX 1: a compile failure in THIS slice still stops discovery", async () => {
  const bad = { ...(fx.engine.model_responses.plan_discovery[0] as { input: Record<string, unknown> }).input, postedLimit: "decade" };
  const s = await replayEngineSlice(fx, { deps: selectingInput(fx, bad) });
  assertEquals(jobSearchCalls(s).length, 0, "nothing is bought on an invalid input");
  assertEquals(s.state.terminal_reason, "provider_input_validation_failed");
  assertEquals(discoveryState(s).stop_reason, "schema_failure");
});

Deno.test("[historical] G FIX 1 (unmasked): with no stale stop, slice 1 is not 'exhausted' while pages 2–3 are unread", async () => {
  const s1 = await replayEngineSlice(fx, { deps: { controlRoutes: recordedRouteControl(fx) } });
  assertFalse(discoveryState(s1).exhausted, JSON.stringify(discoveryState(s1)));
});

Deno.test("[historical] G FIX 1 (unmasked): a replenishment slice buys its page and never re-asks page 1", async () => {
  const { s2 } = await replayLineage(fx);
  assertEquals(jobSearchCalls(s2).map((c) => c.input.page), [2], JSON.stringify(jobSearchCalls(s2).map((c) => c.input)));
});

// ══════════ FIX 4 — a replayed page exhausts the route ══════════════════════

Deno.test("[historical] G FIX 4: page 3 replays page 2 row for row — the route is exhausted, no further continuation", async () => {
  const { s2, s3 } = await replayLineage(fx);
  assertEquals(jobSearchCalls(s2).map((c) => c.input.page), [2]);
  assertEquals(jobSearchCalls(s3).map((c) => c.input.page), [3]);
  const d = discoveryState(s3);
  assertEquals([d.exhausted, d.stop_reason], [true, "duplicate_page"]);
  const decision = decideAutoContinuation({
    cancelled: false, qualified: qualifiedNames(s3).length, requestedCount: 3, frontierRemaining: 0,
    continuationsUsed: 2, maxContinuations: 10, costUnitsUsed: 6, maxCostUnits: 40, barrenSlices: 1,
    providerFailed: false, pendingRuns: 0, verificationRoutesRemain: 0, discoveryRoutesRemain: !d.exhausted,
  });
  assertFalse(decision.continue, "no useless fourth slice");
  const out = settleV2Outcome({ continuing: false, stopReason: decision.reason, legacyStatus: "completed", legacyQuota: {},
    canonicalQualified: qualifiedNames(s3).length, requestedCount: 3, companyIsDeliverable: true } as never);
  assertEquals([out.terminal, out.delivered, out.requested], ["search_exhausted", 2, 3], "short at 2/3, never 'completed', never 'requested 2'");
});

Deno.test("[historical] G FIX 4: the same row count with different records is NOT a duplicate", async () => {
  const variant = structuredClone(fx);
  variant.provider_responses.find((r) => r.input_match?.page === 3)!.rows = structuredClone(fx.variants.page_3_fresh);
  const { s3 } = await replayLineage(variant);
  assertFalse(discoveryState(s3).stop_reason === "duplicate_page");
});

Deno.test("[historical] G FIX 4: the page fingerprint is carried in the checkpoint's discovery state", async () => {
  const { s2 } = await replayLineage(fx);
  assert(discoveryState(s2).page_fingerprints?.[JOB_SEARCH], JSON.stringify(discoveryState(s2)));
});
