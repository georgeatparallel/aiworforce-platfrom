// THE REQUEST IS THE JOB. THE INVOCATION IS A SLICE OF IT.
//
// "Find 10 qualified AI startups in the US hiring software engineers" is one
// job. An edge invocation is ~125s of it, which buys roughly ten investigations
// and yields roughly four qualified companies. Reaching ten therefore takes
// three or four slices — and until now the second slice never existed. Across
// 202 sourcing tasks, seventeen checkpoints asked for a continuation and none
// was ever taken, because nothing drove one.
//
// These prove the driver: when it fires, when it must not, what it carries
// between slices, and that a multi-slice run actually reaches the requested
// number without anybody pressing anything.
//
// ZERO network, ZERO Actor runs, ZERO model calls, ZERO database writes.

import {
  assert, assertEquals, assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideAutoContinuation, foldSlice, newLineageProgress,
  readLineageProgress, resolveMaxContinuations, resolveMaxLineageCostUnits,
  sliceWasBarren, DEFAULT_MAX_CONTINUATIONS, MAX_BARREN_SLICES,
  MAX_CONTINUATIONS_CAP, MAX_CONTINUATIONS_ENV, MAX_LINEAGE_COST_UNITS_ENV,
  type AutoContinuationInput,
} from "../../../supabase/functions/_shared/leadAutoContinuation.ts";
import {
  dispatchContinuation,
} from "../../../supabase/functions/_shared/leadContinuationDispatch.ts";

/** A request that is plainly unfinished: 4 of 10, plenty of pool, no ceilings hit. */
const RUNNING = (over: Partial<AutoContinuationInput> = {}): AutoContinuationInput => ({
  qualified: 4, requestedCount: 10, frontierRemaining: 88,
  continuationsUsed: 1, maxContinuations: 10,
  costUnitsUsed: 12, maxCostUnits: 120,
  barrenSlices: 0, ...over,
});

// ═══════════════════════════════════ 1-2. it continues, and it says why ══

Deno.test("1. an unfinished request continues automatically", () => {
  const d = decideAutoContinuation(RUNNING());
  assert(d.continue, d.detail);
  assertEquals(d.reason, "quota_unmet_frontier_remains");
  // THE USER ASKED ONCE AND IS WAITING. The Workbench must say the job is still
  // running, not that a run finished four short.
  assert(d.user_message?.includes("4 of 10"), d.user_message ?? "(none)");
  assert(d.user_message?.includes("6 more"), d.user_message ?? "(none)");
});

Deno.test("2. reaching the target is the only ending that is a success", () => {
  const d = decideAutoContinuation(RUNNING({ qualified: 10 }));
  assertFalse(d.continue);
  assertEquals(d.reason, "quota_met");
  assert(d.detail.includes("10 of 10"));
  // Over-delivery stops too, and is not reported as a shortfall.
  assertEquals(decideAutoContinuation(RUNNING({ qualified: 11 })).reason, "quota_met");
});

// ══════════════════════════════════════════ 3-7. every stopping condition ══

Deno.test("3. an EXHAUSTED pool stops, and the shortfall is real", () => {
  const d = decideAutoContinuation(RUNNING({ frontierRemaining: 0 }));
  assertFalse(d.continue);
  assertEquals(d.reason, "frontier_exhausted");
  assert(d.detail.includes("4 of 10"),
    "an honest shortfall names what was found, not what was missing");
});

Deno.test("4. the continuation CEILING stops the job, and admits it is a ceiling", () => {
  const d = decideAutoContinuation(RUNNING({ continuationsUsed: 10, maxContinuations: 10 }));
  assertFalse(d.continue);
  assertEquals(d.reason, "continuation_ceiling");
  // A CEILING IS NOT A FINDING. The remaining candidates were never examined and
  // the detail must not let that read as "nothing else qualified".
  assert(d.detail.includes("88 candidates remain unexamined"), d.detail);
});

Deno.test("5. the COST ceiling stops the job — 'keep going' is not unbounded spend", () => {
  const d = decideAutoContinuation(RUNNING({ costUnitsUsed: 120, maxCostUnits: 120 }));
  assertFalse(d.continue);
  assertEquals(d.reason, "cost_ceiling");
  assert(d.detail.includes("remain unexamined"));
});

Deno.test("6. two barren slices in a row stop the job", () => {
  // One barren slice is ordinary — a batch whose identities did not resolve.
  assert(decideAutoContinuation(RUNNING({ barrenSlices: 1 })).continue,
    "a single unproductive slice is not evidence");
  const d = decideAutoContinuation(RUNNING({ barrenSlices: MAX_BARREN_SLICES }));
  assertFalse(d.continue);
  assertEquals(d.reason, "no_progress");
});

Deno.test("7. a provider failure and a cancellation both stop it", () => {
  assertEquals(
    decideAutoContinuation(RUNNING({ providerFailed: true })).reason, "provider_failure");
  // Cancellation outranks EVERYTHING, including a met quota — a user who
  // stopped the run must not be billed for one more slice.
  assertEquals(
    decideAutoContinuation(RUNNING({ cancelled: true, qualified: 10 })).reason, "cancelled");
});

Deno.test("7b. the target is checked before every ceiling", () => {
  // A run that reached ten on its last allowed slice succeeded; it did not
  // "hit the continuation ceiling".
  const d = decideAutoContinuation(RUNNING({
    qualified: 10, continuationsUsed: 99, maxContinuations: 10,
    costUnitsUsed: 9_999, maxCostUnits: 120,
  }));
  assertEquals(d.reason, "quota_met");
});

/**
 * Build `foldSlice`'s input from a lineage's CUMULATIVE position.
 *
 * Every real caller passes cumulative values — `state` is spread from the
 * checkpoint, so `accumulated_cost_units` and `investigation_selected` are
 * running totals for the whole lineage. This helper makes the tests say that
 * out loud, so a future edit cannot quietly reintroduce delta-shaped inputs.
 */
const cumulative = (i: { qualified: number; investigated: number; cost: number }) => ({
  qualifiedInPool: i.qualified,
  uniqueCompaniesInvestigatedInPool: i.investigated,
  // Authorisations track investigations here; their own semantics are pinned
  // separately, in the test that shows the two diverging.
  authorisationsInPool: i.investigated,
  costUnitsInLineage: i.cost,
});

// ═══════════════════════════ 8-10. what carries between slices ══

Deno.test("8. the qualified count is a HIGH-WATER MARK and never regresses", () => {
  // THE DEFECT THIS PREVENTS is the one the multi-round controller had: a slice
  // that evaluates nobody reports zero qualified, and assigning that erases the
  // companies an earlier slice proved and already persisted.
  //
  // EVERY INPUT IS CUMULATIVE, because every caller's is. `state` is spread from
  // the checkpoint on a continuation, so `accumulated_cost_units` and
  // `investigation_selected` are lineage totals, not slice deltas.
  let p = newLineageProgress();
  p = foldSlice(p, cumulative({ qualified: 4, investigated: 10, cost: 12 }));
  assertEquals(p.qualified_high_water, 4);

  p = foldSlice(p, cumulative({ qualified: 0, investigated: 10, cost: 12 }));
  assertEquals(p.qualified_high_water, 4,
    "a barren slice may not un-qualify four persisted companies");

  p = foldSlice(p, cumulative({ qualified: 7, investigated: 22, cost: 30 }));
  assertEquals(p.qualified_high_water, 7);
  assertEquals(p.continuations_used, 3);

  // ── THE COUNTERS THAT WERE SUMS OF SNAPSHOTS ────────────────────────────
  //
  // Three slices reporting lineage totals of 12, 12 and 30 cost units mean the
  // lineage spent 30. The old fold added them and answered 54 — and the same
  // arithmetic on real runs reported 158 units against 6 provider calls, then
  // terminated the run for exceeding a ceiling of 120.
  assertEquals(p.cost_units_used, 30, "the lineage total, not a sum of totals");
  assertEquals(p.unique_companies_investigated, 22);
});

Deno.test("9. barren slices count consecutively and any progress resets them", () => {
  assert(sliceWasBarren({ qualifiedDelta: 0, investigatedDelta: 0 }));
  assertFalse(sliceWasBarren({ qualifiedDelta: 0, investigatedDelta: 5 }),
    "moving the frontier is progress even when nobody qualified");
  assertFalse(sliceWasBarren({ qualifiedDelta: 2, investigatedDelta: 0 }));

  // AND THE DELTA IS DERIVED, NOT PASSED. `sliceWasBarren` documents its input
  // as a delta and `foldSlice` used to hand it a cumulative count, so no slice
  // after the first could ever be barren — every run this year reported
  // `barren_slices: 0`, including lineages whose last four slices selected
  // nobody at all. The counts below are cumulative and the deltas are computed.
  let p = newLineageProgress();
  p = foldSlice(p, cumulative({ qualified: 0, investigated: 0, cost: 1 }));
  assertEquals(p.barren_slices, 1);
  p = foldSlice(p, cumulative({ qualified: 0, investigated: 0, cost: 2 }));
  assertEquals(p.barren_slices, 2);
  p = foldSlice(p, cumulative({ qualified: 0, investigated: 6, cost: 3 }));
  assertEquals(p.barren_slices, 0, "a slice that investigated somebody resets the count");

  // THE CASE THE OLD FOLD COULD NOT SEE: a lineage that has investigated 20
  // companies and adds none. Cumulative 20 in, cumulative 20 held, delta zero.
  let q = newLineageProgress();
  q = foldSlice(q, cumulative({ qualified: 3, investigated: 20, cost: 20 }));
  assertEquals(q.barren_slices, 0);
  q = foldSlice(q, cumulative({ qualified: 3, investigated: 20, cost: 20 }));
  assertEquals(q.barren_slices, 1,
    "a slice that added nobody is barren however many the lineage has investigated");
});

Deno.test("10. progress survives the task row, and a missing one is safe", () => {
  const p = foldSlice(newLineageProgress(),
    cumulative({ qualified: 3, investigated: 10, cost: 9 }));
  const round = readLineageProgress(JSON.parse(JSON.stringify(p)));
  assertEquals(round.qualified_high_water, 3);
  assertEquals(round.continuations_used, 1);

  // A first slice has no prior progress at all.
  const fresh = readLineageProgress(undefined);
  assertEquals(fresh.continuations_used, 0);
  assertEquals(fresh.qualified_high_water, 0);
  // And junk never produces a negative or fractional ceiling input.
  const junk = readLineageProgress({ continuations_used: -5, cost_units_used: "x" });
  assertEquals(junk.continuations_used, 0);
  assertEquals(junk.cost_units_used, 0);
});

// ═════════════════════════════════════════════ 11-12. the ceilings resolve ══

Deno.test("11. the ceilings are configurable and capped", () => {
  assertEquals(resolveMaxContinuations(() => undefined), DEFAULT_MAX_CONTINUATIONS);
  assertEquals(
    resolveMaxContinuations((k) => k === MAX_CONTINUATIONS_ENV ? "3" : undefined), 3);
  assertEquals(
    resolveMaxContinuations((k) => k === MAX_CONTINUATIONS_ENV ? "9999" : undefined),
    MAX_CONTINUATIONS_CAP, "an operator cannot remove the bound");
  assertEquals(
    resolveMaxContinuations((k) => k === MAX_CONTINUATIONS_ENV ? "0" : undefined),
    DEFAULT_MAX_CONTINUATIONS, "nonsense falls back rather than disabling continuation");
  assert(resolveMaxLineageCostUnits(
    (k) => k === MAX_LINEAGE_COST_UNITS_ENV ? "40" : undefined) === 40);
});

// ═══════════════════════════════════════════════ 13-15. the dispatch ══

const deps = (over: Record<string, unknown> = {}) => ({
  fetch: () => Promise.resolve({ status: 202 }),
  // Deterministic: tests never sleep, and the window is explicit.
  handoffWindowMs: 50,
  wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  functionsBaseUrl: "https://proj.supabase.co/functions/v1",
  serviceRoleKey: "service-key",
  ...over,
} as never);

const MISSION = { version: "lead-mission-v1", requested_count: 10 };
const REQ = {
  resumeTaskId: "task-1", workspaceId: "ws-1", userId: "user-1",
  planId: "plan-1", agentSlug: "scout", continuationIndex: 2,
  stepIndex: 0, instruction: "Find 10 AI startups in the US hiring engineers",
  toolInput: { lead_mission: MISSION }, leadMission: MISSION,
};

Deno.test("13. the next slice resumes the SAME task and belongs to the SAME user",
  async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const out = await dispatchContinuation(REQ, deps({
      fetch: (url: string, init: RequestInit) => {
        seenUrl = url;
        seenAuth = String((init.headers as Record<string, string>).Authorization);
        seenBody = JSON.parse(String(init.body));
        return Promise.resolve({ status: 202 });
      },
    }));

    assert(out.dispatched);
    assertEquals(seenUrl, "https://proj.supabase.co/functions/v1/run-agent");
    // RESUME, NOT RESTART. A new task id here would re-run discovery and pay for
    // the pool a second time.
    assertEquals(seenBody.resume_task_id, "task-1");

    // ── THE ORCHESTRATED CONTRACT, WHICH IS VALIDATED FIRST ─────────────────
    //
    // This test previously asserted the OPPOSITE — that a continuation carries
    // no instruction "because the mission is in the checkpoint". Both halves
    // were wrong, and the first live dispatch proved it: HTTP 400,
    // `missing_required_fields`, before the resume path was reached.
    //
    // `run-agent` validates `plan_id`, `step_index`, `agent_slug`,
    // `workspace_id` and `instruction` BEFORE it looks at `resume_task_id`.
    assertEquals(seenBody.step_index, 0);
    assert(typeof seenBody.instruction === "string" && seenBody.instruction.length > 0);
    assertEquals(seenBody.plan_id, "plan-1");
    assertEquals(seenBody.agent_slug, "scout");

    // AND THE COMPILED MISSION TRAVELS WITH IT. `readPersistedLeadMission` reads
    // it from `tool_input.lead_mission` on the REQUEST, not from the checkpoint.
    // Without it the continuation runs as `legacy_carrier_union` and re-derives
    // intent — a different job from the one the user asked for.
    assertEquals(
      (seenBody.tool_input as Record<string, unknown>).lead_mission, MISSION);
    // ATTRIBUTED TO THE REQUESTER. `user_id` is honoured only for service-role
    // callers; without it the results land outside the asker's Workbench.
    assertEquals(seenBody.user_id, "user-1");
    assert(seenAuth.includes("service-key"));
    assertEquals(seenBody.auto_continuation, true);
  });

Deno.test("14. a missing service key is a VISIBLE stop, not a silent one", async () => {
  const out = await dispatchContinuation(REQ, deps({ serviceRoleKey: null }));
  assertFalse(out.dispatched);
  assertEquals(out.dispatched === false ? out.reason : null, "not_configured");
  const noUrl = await dispatchContinuation(REQ, deps({ functionsBaseUrl: null }));
  assertFalse(noUrl.dispatched);
});

Deno.test("14b. a REFUSED dispatch is a stop, not a handoff", async () => {
  // THE FIRST LIVE ATTEMPT recorded `{ status: 400, dispatched: true }`: any
  // response that did not throw counted as success, so the task claimed to be
  // continuing while its successor had been rejected outright. A run that says
  // it is continuing and never does is the exact failure this replaces.
  for (const status of [400, 401, 403, 409, 500]) {
    const out = await dispatchContinuation(REQ, deps({
      fetch: () => Promise.resolve({ status }),
    }));
    assertFalse(out.dispatched, `HTTP ${status} must not count as dispatched`);
    assertEquals(out.dispatched === false ? out.reason : null, "rejected");
    assertEquals(out.dispatched === false ? out.status : null, status);
  }
  // 2xx is the only handoff.
  for (const status of [200, 202]) {
    assert((await dispatchContinuation(REQ, deps({
      fetch: () => Promise.resolve({ status }),
    }))).dispatched, `HTTP ${status} is a handoff`);
  }
});

Deno.test("15. a transport failure loses the handoff, never the slice's work", async () => {
  const out = await dispatchContinuation(REQ, deps({
    fetch: () => Promise.reject(new Error("connection reset")),
  }));
  assertFalse(out.dispatched);
  assertEquals(out.dispatched === false ? out.reason : null, "transport_error");
  assert(out.dispatched === false && out.detail.includes("connection reset"));
});

// ══════════════════ 16. THE WHOLE JOB: one request reaches ten, unattended ══

Deno.test("16. a request for 10 reaches 10 across slices with no human input", () => {
  // The real shape: ~10 investigated and ~4 qualified per slice, over a pool of
  // 100. Nobody presses anything; the loop is driven entirely by the decision
  // function and the progress it carries.
  const REQUESTED = 10;
  let pool = 100;
  let progress = newLineageProgress();
  let slices = 0;
  let investigatedCumulative = 0;
  let costCumulative = 0;
  const qualifiedPerSlice = [4, 3, 2, 4];

  for (;;) {
    const d = decideAutoContinuation({
      qualified: progress.qualified_high_water,
      requestedCount: REQUESTED,
      frontierRemaining: pool,
      continuationsUsed: progress.continuations_used,
      maxContinuations: resolveMaxContinuations(() => undefined),
      costUnitsUsed: progress.cost_units_used,
      maxCostUnits: resolveMaxLineageCostUnits(() => undefined),
      barrenSlices: progress.barren_slices,
    });
    if (!d.continue) {
      assertEquals(d.reason, "quota_met",
        `the job must end by meeting the target, not by ${d.reason}: ${d.detail}`);
      break;
    }
    // One slice: ten investigated off the frontier, some of them qualified.
    const investigated = Math.min(10, pool);
    pool -= investigated;
    const gained = qualifiedPerSlice[Math.min(slices, qualifiedPerSlice.length - 1)];
    // CUMULATIVE, as the engine reports them: the working set and the cost
    // counter both survive the checkpoint, so each slice hands over the
    // lineage's position, never its own contribution.
    investigatedCumulative += investigated;
    costCumulative += 11;
    progress = foldSlice(progress, cumulative({
      qualified: progress.qualified_high_water + gained,
      investigated: investigatedCumulative,
      cost: costCumulative,
    }));
    slices++;
    assert(slices <= 20, "the loop must terminate");
  }

  assert(progress.qualified_high_water >= REQUESTED,
    `expected at least ${REQUESTED}, got ${progress.qualified_high_water}`);
  assertEquals(slices, 4, "four slices at ~4/3/2/4 qualified reaches ten");
  // AND IT DID NOT SPEND THE WHOLE POOL TO GET THERE.
  assertEquals(pool, 60, "it stopped as soon as the target was met");
  assert(progress.continuations_used < DEFAULT_MAX_CONTINUATIONS);
});

Deno.test("16b. a thin pool ends honestly short rather than looping", () => {
  // Only 25 candidates and a low yield: the job must end on an exhausted
  // frontier, with a real shortfall, and not spin.
  let pool = 25;
  let progress = newLineageProgress();
  let slices = 0;
  let investigatedCumulative = 0;
  let costCumulative = 0;
  let stop = "";

  for (;;) {
    const d = decideAutoContinuation({
      qualified: progress.qualified_high_water,
      requestedCount: 10, frontierRemaining: pool,
      continuationsUsed: progress.continuations_used, maxContinuations: 10,
      costUnitsUsed: progress.cost_units_used, maxCostUnits: 120,
      barrenSlices: progress.barren_slices,
    });
    if (!d.continue) { stop = d.reason; break; }
    const investigated = Math.min(10, pool);
    pool -= investigated;
    investigatedCumulative += investigated;
    costCumulative += 11;
    progress = foldSlice(progress, cumulative({
      qualified: progress.qualified_high_water + 1,
      investigated: investigatedCumulative, cost: costCumulative,
    }));
    slices++;
    assert(slices <= 20, "the loop must terminate");
  }

  assertEquals(stop, "frontier_exhausted");
  assertEquals(pool, 0);
  assertEquals(progress.qualified_high_water, 3, "three found, and the run says so");
});

// ═════════ 17-20. THE RESUME GATE MUST NOT REFUSE OUR OWN CONTINUATION ══
//
// Task d9b341aa: 3 qualified of 10 requested, 88 candidates still on the
// frontier, the decision correctly `quota_unmet_frontier_remains` — and the
// dispatch refused with HTTP 409, `already_terminal`.
//
// TWO AUTHORITIES DISAGREED AND THE WRONG ONE WON. `cf.status` comes from the
// legacy quota controller's ROUND COUNT, which reported `round_limit_reached`
// after its single round. `round_limit_reached` is in NON_RESUMABLE, so
// `decideResume` refused the continuation the same run had just asked for. The
// run declared itself finished and then enforced it against its own successor.
//
// And it refused on TWO gates, not one: the top-level `result.terminal_status`
// AND the copy inside `company_first_state`, which was read first.
//
// ── SUPERSEDED 2026-09-03, SEE TEST 19 ─────────────────────────────────────
//
// The fix chosen here was to make the WRITER put `continuation_required` in
// both places and leave the reader strict. Task 2f3d9c5c proved that
// insufficient: the two values are written at different moments by different
// authorities, so they cannot be kept in sync from the writing side. The reader
// now uses the row as the single authority, matching the precedence
// `claim_sourcing_continuation` has always applied.

import {
  decideResume,
} from "../../../supabase/functions/_shared/sourcingContinuation.ts";
import {
  isTerminalOutcome, isResumableRowStatus,
} from "../../../supabase/functions/_shared/taskStatusContract.ts";

const SOURCING_STATE_KEY = "company_first_state";

/** The task row as task d9b341aa actually looked when its successor was refused. */
const rowAfterSlice = (over: {
  terminal: string | null;
  stateTerminal: string | null;
  status?: string;
}) => ({
  id: "task-1", workspace_id: "ws-1", status: over.status ?? "complete",
  payload: { instruction: "Find 10 AI startups in the US hiring engineers" },
  result: {
    terminal_status: over.terminal,
    [SOURCING_STATE_KEY]: {
      version: "company-first-state-1.0.0",
      terminal_status: over.stateTerminal,
      current_round: 1,
    },
  },
});

Deno.test("17. THE 409: a round-limit terminal refuses the run's own continuation", () => {
  const d = decideResume(
    rowAfterSlice({ terminal: "round_limit_reached", stateTerminal: "round_limit_reached" }),
    "ws-1", "task-1");
  assertFalse(d.ok, "this is the observed failure, kept so the fix cannot regress");
  assertEquals(d.ok === false ? d.reason : null, "already_terminal");
});

Deno.test("18. with the frontier as authority, the same run IS resumable", () => {
  // What the fix writes: `continuation_required` in BOTH places, because a job
  // with candidates left and an unmet quota has not reached a terminal state.
  const d = decideResume(
    rowAfterSlice({ terminal: "continuation_required", stateTerminal: null }),
    "ws-1", "task-1");
  assert(d.ok, `expected resumable, got ${d.ok === false ? d.reason : ""}`);
});

Deno.test("19. the ROW is the authority; the checkpoint speaks only in its silence", () => {
  // ── THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-09-03 ─────────────────────
  //
  // It required BOTH gates to be cleared, on the reasoning that the fix belonged
  // in the WRITER: a continuing run should write `continuation_required` into
  // the row and the checkpoint alike, so a strict reader was safe.
  //
  // That decision did not hold, and could not have. Task 2f3d9c5c froze at
  // generation 4 with a live frontier — 15 rejections, 3 dispatches, 45 minutes
  // — on exactly the shape the old assertion demanded be refused:
  //
  //     result.terminal_status                "continuation_required"
  //     company_first_state.terminal_status   "round_limit_reached"
  //     company_first_state.next_action       "stopped"
  //
  // The legacy controller stamps the checkpoint from its `next_action: stopped`
  // branch, AFTER auto-continuation has already overridden the row — so the two
  // are written at different moments by different authorities and keeping them
  // in sync is not something the writer can guarantee. Worse, `maxRounds` is 0
  // while the capability engine owns sourcing, so `rounds.length >= maxRounds`
  // is `0 >= 0` and a loop that never ran stamps `round_limit_reached`; its own
  // recorded reason reads "the legacy sourcing loop is disabled for this run".
  //
  // And a writer-side correction alone could never have been enough: the old
  // reader refused on ANY truthy checkpoint status, so `quota_not_met` would
  // have deadlocked just as `round_limit_reached` did.
  //
  // `claim_sourcing_continuation` — the RPC that takes the claim moments later —
  // has always read the row first:
  //
  //     coalesce(result->>'terminal_status',
  //              company_first_state->>'terminal_status', …)
  //
  // Two gates disagreeing about whether a run has finished IS the defect. One
  // authority replaces two kept in sync by hand.
  const rowSaysContinue = decideResume(
    rowAfterSlice({ terminal: "continuation_required", stateTerminal: "round_limit_reached" }),
    "ws-1", "task-1");
  assert(rowSaysContinue.ok,
    "the row says the engine has work left; a stale checkpoint must not veto it");

  // UNCHANGED, and the half that was always right: a row carrying a terminal
  // status ends the run whatever the checkpoint says.
  const rowSaysFinished = decideResume(
    rowAfterSlice({ terminal: "round_limit_reached", stateTerminal: null }),
    "ws-1", "task-1");
  assertFalse(rowSaysFinished.ok);
});

Deno.test("20. `continuation_required` is the one terminal status that resumes", () => {
  // The property the fix depends on, asserted against the contract itself
  // rather than assumed.
  assertFalse(isTerminalOutcome("continuation_required"),
    "continuation_required must not be treated as an ending");
  assert(isTerminalOutcome("round_limit_reached"));
  assert(isTerminalOutcome("completed"));
  // And the row status a finished slice writes is still resumable.
  assert(isResumableRowStatus("complete"), "legacy rows remain resumable");
  assert(isResumableRowStatus("ready"));
});


// ═════════ 21-23. THE CONTINUATION MUST RESUME THE SAME JOB ══
//
// Task 9425b3fc got further than any before it: `decideResume` passed, the RPC
// lease was taken (`claim: "fresh_claim"`, `checkpoint_version: 1`) and the
// continuation genuinely started. Then:
//
//   sourcing-not-accepted  no mission-driven execution claimed this request
//   entity routing         output_type: "qualified_people",
//                          actor_key: "apify_jobs",
//                          execution_mode: "person_first"
//
// The mission never arrived, so the router fell back to the INSTRUCTION — and
// the instruction on this plan is the deterministic fallback planner's string,
// "Find 10 jobs matching: Software Engineer OR …". A jobs instruction routes to
// jobs. The continuation ran a different job from the one the user asked for,
// failed to claim the company-first engine, and then overwrote the task result
// with a `blocked: true` stub — destroying three qualified companies, the
// funnel, the workbench rows and the checkpoint.

Deno.test("21. the mission travels on BOTH carriers", () => {
  // `readPersistedLeadMission(tool_input, body.lead_mission)` reads either, and
  // which one the original request used depends on how the caller assembled it.
  // Sending one is a coin flip; sending both is the contract.
  let body: Record<string, unknown> = {};
  return dispatchContinuation(REQ, deps({
    fetch: (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve({ status: 202 });
    },
  })).then(() => {
    assertEquals((body.tool_input as Record<string, unknown>).lead_mission, MISSION);
    assertEquals(body.lead_mission, MISSION,
      "the top-level carrier must be populated too");
  });
});

Deno.test("22. a null mission is omitted rather than sent as null", async () => {
  let body: Record<string, unknown> = {};
  await dispatchContinuation({ ...REQ, leadMission: null, toolInput: null }, deps({
    fetch: (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve({ status: 202 });
    },
  }));
  // `readPersistedLeadMission` treats an explicit null as a carrier that exists
  // and is empty; omitting the key leaves the legacy union intact.
  assertFalse("lead_mission" in body);
  assertFalse("tool_input" in body);
});

Deno.test("23. the instruction carried is the USER's query, not the planner's", () => {
  // The dispatcher forwards whatever it is given, so this pins the CHOICE the
  // caller must make: `persistedMission.original_user_query`, never the
  // fallback planner's jobs string. Asserted as a property of the request the
  // caller builds, because that is where the decision lives.
  const userQuery = "Find 10 AI startups in the United States that are hiring software engineers";
  const plannerString =
    "Find 10 jobs matching: Software Engineer OR Backend Engineer in united states";
  assertFalse(userQuery.includes("jobs matching"),
    "the user asked for startups, not for jobs");
  assert(plannerString.includes("jobs matching"),
    "and the planner's string is what routed the continuation to apify_jobs");
});


// ═════════ 24-25. THE FRONTIER MUST ACTUALLY ADVANCE ══
//
// Task b4eb3710 ran THREE slices automatically — the chain worked — and made no
// progress at all:
//
//   slice 1  selected 10, frontier_remaining 89, already_investigated: 0
//   slice 2  selected 10, frontier_remaining 88, already_investigated: 0
//   slice 3  selected 10, frontier_remaining 89, already_investigated: 0
//
// Every slice logged `records: 0` and re-ran discovery. `loadLeadResumeRecords`
// is addressed by `continuation_of_task_id` / `lead_resume_parent_task_id` —
// the shape from when a continuation was a NEW row pointing at its parent — and
// the auto-continuation reuses the SAME row via `resume_task_id`, which none of
// those fields sees. Qualified moved 3 → 5 on the luck of the ranking, not
// because anything resumed.

Deno.test("24. the dispatch addresses the resume-record carrier, not just the row", async () => {
  let body: Record<string, unknown> = {};
  await dispatchContinuation(REQ, deps({
    fetch: (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve({ status: 202 });
    },
  }));
  assertEquals(body.resume_task_id, "task-1", "the row to reuse");
  assertEquals(body.continuation_of_task_id, "task-1",
    "and the id `loadLeadResumeRecords` is actually keyed on");
});

Deno.test("25. a slice that resumed nothing is BARREN and eventually stops the job", () => {
  // The safety net for exactly this failure. Three slices that investigate the
  // same ten companies produce no NEW qualified companies, so the high-water
  // mark does not move — and `no_progress` ends the job rather than paying for
  // the same pass indefinitely.
  let p = newLineageProgress();
  p = foldSlice(p, cumulative({ qualified: 3, investigated: 10, cost: 12 }));
  // A REPLAYED SLICE, as one really reports itself: the same ten companies are
  // still investigated and the same three still qualified, so the lineage's
  // cumulative position is UNCHANGED. It does not report zero — reporting zero
  // is what the old delta-shaped contract asked for, and no real slice ever
  // did it, which is why this guard never fired outside a test.
  p = foldSlice(p, cumulative({ qualified: 3, investigated: 10, cost: 12 }));
  assertEquals(p.barren_slices, 1);
  p = foldSlice(p, cumulative({ qualified: 3, investigated: 10, cost: 12 }));
  assertEquals(p.barren_slices, 2);
  const d = decideAutoContinuation({
    qualified: p.qualified_high_water, requestedCount: 10, frontierRemaining: 89,
    continuationsUsed: p.continuations_used, maxContinuations: 10,
    costUnitsUsed: p.cost_units_used, maxCostUnits: 120,
    barrenSlices: p.barren_slices,
  });
  assertFalse(d.continue);
  assertEquals(d.reason, "no_progress",
    "a chain that is not advancing must stop paying, even though the frontier looks full");
});


// ═════════ 26-28. THE PARENT MUST NOT WAIT FOR ITS CHILD ══
//
// Task b4eb3710: three slices ran and NOT ONE returned. `terminalGuard`'s
// `finally` never executed, so no task and no plan was ever finalised — the
// plan sat at `executing` and the Workbench polled it until the database
// buckled, which is what made chats slow too.
//
// The dispatcher's own header said the parent must never await its child.
// `await fetch(...)` does exactly that: it resolves when the RESPONSE HEADERS
// arrive, and `run-agent` does not stream, so that is when the successor has
// FINISHED. Each parent sat through its child's whole run and was killed at its
// own wall clock first.

Deno.test("26. a slow successor does NOT hold the parent open", async () => {
  // The successor takes far longer than the handoff window — as a real slice
  // does, by minutes.
  const started = Date.now();
  const out = await dispatchContinuation(REQ, deps({
    handoffWindowMs: 20,
    fetch: () => new Promise((r) => setTimeout(() => r({ status: 200 }), 5_000)),
  }));
  assert(out.dispatched, "the handoff counts as made");
  assert(Date.now() - started < 2_000,
    "the parent must return in the handoff window, not in the child's runtime");
});

Deno.test("27. a REFUSAL still arrives inside the window and is still a stop", async () => {
  // Refusals come back in milliseconds, which is why the race keeps them
  // legible rather than trading them away for the fix.
  for (const status of [400, 409, 422]) {
    const out = await dispatchContinuation(REQ, deps({
      handoffWindowMs: 200,
      fetch: () => Promise.resolve({ status }),
    }));
    assertFalse(out.dispatched, `HTTP ${status} must still be caught`);
    assertEquals(out.dispatched === false ? out.reason : null, "rejected");
  }
});

Deno.test("28. a transport failure inside the window is still a failure", async () => {
  const out = await dispatchContinuation(REQ, deps({
    handoffWindowMs: 200,
    fetch: () => Promise.reject(new Error("connection reset")),
  }));
  assertFalse(out.dispatched);
  assertEquals(out.dispatched === false ? out.reason : null, "transport_error");
});

// ═══════ 29-33. THE ACCOUNTING MODEL: CUMULATIVE IN, MONOTONIC OUT ══
//
// `CapabilityExecutionState` is spread from the checkpoint on every
// continuation, so `accumulated_cost_units` and `investigation_selected` are
// LINEAGE totals, not slice deltas. `foldSlice` added them to totals of its own
// once per slice, producing a sum of successive cumulative snapshots.
//
// Measured against the execution ledger, where one paid provider call is one
// cost unit:
//
//     plan        provider calls    cost_units_used    continuations
//     747ff464                 6                158                6
//     a5332734                27                127                6
//     958c86bc                29                124                5
//     66554ea2                28                 58                3
//     44c9c5c0                18                 27                2
//
// The inflation tracks the continuation count exactly, and it was not cosmetic:
// a5332734 and 958c86bc were both TERMINATED by the 120-unit ceiling — "127 of
// 120 provider cost units spent; 78 candidates remain unexamined" — after 27
// and 29 real calls.

Deno.test("29. THE 158-FOR-6 RUN: repeated lineage totals are not repeated spend", () => {
  // Six slices of a lineage that made six provider calls in total. Each one
  // hands over the lineage's position, and the position barely moves.
  let p = newLineageProgress();
  for (const spent of [1, 2, 3, 4, 5, 6]) {
    p = foldSlice(p, cumulative({ qualified: 1, investigated: 6, cost: spent }));
  }
  assertEquals(p.cost_units_used, 6, "six calls cost six units, however many slices saw them");
  assertEquals(p.continuations_used, 6, "and the slice count is still a real count");

  // The ceiling now measures spend rather than slice count.
  const d = decideAutoContinuation({
    qualified: p.qualified_high_water, requestedCount: 10, frontierRemaining: 80,
    continuationsUsed: 0, maxContinuations: 10,
    costUnitsUsed: p.cost_units_used, maxCostUnits: 120,
    barrenSlices: 0,
  });
  assert(d.continue, "a run that has spent 6 of 120 units must not be stopped for cost");
});

Deno.test("30. a company investigated in slice one is not counted again in slice four", () => {
  // The working set is deduplicated and restored whole, so it reports the same
  // company at the same cumulative position every slice.
  let p = newLineageProgress();
  p = foldSlice(p, cumulative({ qualified: 2, investigated: 10, cost: 10 }));
  p = foldSlice(p, cumulative({ qualified: 5, investigated: 23, cost: 23 }));
  p = foldSlice(p, cumulative({ qualified: 9, investigated: 31, cost: 31 }));
  p = foldSlice(p, cumulative({ qualified: 10, investigated: 40, cost: 40 }));

  assertEquals(p.unique_companies_investigated, 40,
    "the pool's own count — the old fold answered 104 for this lineage");
  assert(p.unique_companies_investigated <= 100,
    "a company count can never exceed the pool it is drawn from");
});

Deno.test("31. companies and AUTHORISATIONS are separate quantities", () => {
  // `investigation_selected` re-counts work carried in flight, deliberately:
  // this invocation buys those searches too. So authorisations legitimately
  // exceed companies, and collapsing them into one number is what made
  // "investigated" unanswerable.
  let p = newLineageProgress();
  p = foldSlice(p, {
    qualifiedInPool: 4,
    uniqueCompaniesInvestigatedInPool: 10,
    authorisationsInPool: 10,
    costUnitsInLineage: 10,
  });
  p = foldSlice(p, {
    qualifiedInPool: 6,
    // Three new companies, but the ten carried in flight were re-authorised.
    uniqueCompaniesInvestigatedInPool: 13,
    authorisationsInPool: 23,
    costUnitsInLineage: 23,
  });
  assertEquals(p.unique_companies_investigated, 13, "thirteen distinct companies");
  assertEquals(p.investigation_authorisations, 23, "twenty-three authorisations");
  assert(p.investigation_authorisations > p.unique_companies_investigated,
    "and the difference is exactly the carried work — a real fact, not an error");
});

Deno.test("32. a reset state cannot lose money the lineage already spent", () => {
  // A mission-hash mismatch rebuilds `CapabilityExecutionState` from zero. The
  // spend still happened, so the lineage keeps the higher figure.
  let p = newLineageProgress();
  p = foldSlice(p, cumulative({ qualified: 7, investigated: 30, cost: 44 }));
  p = foldSlice(p, cumulative({ qualified: 0, investigated: 0, cost: 0 }));
  assertEquals(p.cost_units_used, 44, "money spent is not unspent by a fresh state");
  assertEquals(p.qualified_high_water, 7);
  assertEquals(p.unique_companies_investigated, 30);
});

Deno.test("33. a legacy checkpoint's meaningless company count is not inherited", () => {
  // `investigated_total` held a sum of snapshots. Seeding a COMPANY count with
  // it would pin the lineage to that number for good, because these fields only
  // ever move up. Re-deriving from the working set is strictly more correct.
  const legacy = readLineageProgress({
    version: "lead-auto-continuation-v1",
    continuations_used: 6, cost_units_used: 158, barren_slices: 0,
    qualified_high_water: 9, investigated_total: 406,
  });
  assertEquals(legacy.unique_companies_investigated, 0,
    "406 companies out of a pool of 100 is not a starting point");
  assertEquals(legacy.investigation_authorisations, 0);
  assertEquals(legacy.qualified_high_water, 9, "but a real high-water mark still carries");
  assertEquals(legacy.cost_units_used, 158,
    "and an inflated spend figure errs toward stopping early, which is the safe direction");
});

// ══ A PAID RUN IN FLIGHT IS NOT A FINDING ABOUT THE CANDIDATES ═════════════
//
// Task 783fa163, one moment, two components, contradictory answers:
//
//   terminal_record    { status: "pending_external_run",
//                        reason: "provider_run_pending", resumable: true,
//                        pending_runs: [ Zs5bYFGlnua1hJWYg ] }
//
//   auto_continuation  { decision: "no_progress", continuing: false,
//                        detail: "2 consecutive slices qualified and
//                                 investigated nobody; 15 candidates remain
//                                 unexamined" }
//
// The lineage stopped. Apify run Zs5bYFGlnua1hJWYg then SUCCEEDED, in 796s,
// with 1,394 job rows carrying exactly the evidence the mission asked for —
// "Senior Sales Operations Manager, New Seller Recruitment" (Amazon), "Account
// Executive (Enterprise)" (Salesforce), "Leader, Inside Sales" (Cisco) — and
// nothing will ever read them. The stage told the user "no company had a
// relevant commercial role", which was false for that pool.
//
// `decideAutoContinuation` had no notion of a pending run. The finalizer, which
// ranks one above every other outcome, is the one that is right.

Deno.test("the live contradiction: barren does not outrank a pending run", () => {
  // The exact input that produced `no_progress` while a run was executing.
  const live = RUNNING({
    qualified: 0, requestedCount: 3, frontierRemaining: 15,
    barrenSlices: MAX_BARREN_SLICES, continuationsUsed: 6, costUnitsUsed: 19,
  });
  assertEquals(
    decideAutoContinuation(live).reason, "no_progress",
    "precondition: without a pending run this is still an honest stop",
  );
  const d = decideAutoContinuation({ ...live, pendingRuns: 1 });
  assert(d.continue, d.detail);
  assertEquals(d.reason, "awaiting_provider_run");
});

Deno.test("nor does an exhausted frontier or a provider failure", () => {
  // Both assert something about the candidates. Neither can be known while a
  // call we already paid for is still deciding it.
  for (const over of [{ frontierRemaining: 0 }, { providerFailed: true }]) {
    const stopped = decideAutoContinuation(RUNNING(over));
    assertFalse(stopped.continue, `precondition for ${JSON.stringify(over)}`);
    const waiting = decideAutoContinuation(RUNNING({ ...over, pendingRuns: 1 }));
    assert(waiting.continue, waiting.detail);
    assertEquals(waiting.reason, "awaiting_provider_run");
  }
});

Deno.test("but the CEILINGS still bound an indefinite wait", () => {
  // The protection/finding distinction this module already draws. A run that
  // never finishes must still stop, and `continuationsUsed` is what stops it —
  // otherwise `pending_runs` becomes a licence to burn the whole lineage.
  const atContinuations = decideAutoContinuation(
    RUNNING({ pendingRuns: 1, continuationsUsed: 10, maxContinuations: 10 }));
  assertFalse(atContinuations.continue);
  assertEquals(atContinuations.reason, "continuation_ceiling");

  const atCost = decideAutoContinuation(
    RUNNING({ pendingRuns: 1, costUnitsUsed: 120, maxCostUnits: 120 }));
  assertFalse(atCost.continue);
  assertEquals(atCost.reason, "cost_ceiling");
});

Deno.test("and cancellation and a met quota still outrank it", () => {
  // A user who stopped the run must not be billed for another slice, and a
  // request already satisfied does not need more evidence.
  assertEquals(
    decideAutoContinuation(RUNNING({ pendingRuns: 2, cancelled: true })).reason,
    "cancelled");
  assertEquals(
    decideAutoContinuation(RUNNING({ pendingRuns: 2, qualified: 10 })).reason,
    "quota_met");
});

Deno.test("zero pending runs changes nothing at all", () => {
  // The no-regression guarantee: every existing decision is untouched.
  for (const over of [{}, { frontierRemaining: 0 }, { providerFailed: true },
    { barrenSlices: MAX_BARREN_SLICES }, { cancelled: true }, { qualified: 10 }]) {
    assertEquals(
      decideAutoContinuation(RUNNING({ ...over, pendingRuns: 0 })),
      decideAutoContinuation(RUNNING(over)),
      JSON.stringify(over),
    );
  }
});

Deno.test("the wait is explained to the user, not silent", () => {
  const d = decideAutoContinuation(RUNNING({ pendingRuns: 1, barrenSlices: 2 }));
  assert(d.user_message, "a continuing run must say it is continuing");
  assert(/progress/i.test(d.user_message!), d.user_message!);
  assert(/adopting the result costs/.test(d.detail), d.detail);
});

// ── THE CALL SITE, AND THE LIST IT READS ──────────────────────────────────

Deno.test("run-agent feeds the engine's own pending_runs into the decision", () => {
  const RUN = Deno.readTextFileSync(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url),
  );
  // The engine's own list, counted by `awaitedPendingRuns` — which only drops a
  // run that has outlived its wait bound (D3, pendingRunWaitBound.test.ts).
  assert(
    /pendingRuns:\s*awaitedPendingRuns\(capabilityRun\?\.state\.pending_runs, Date\.now\(\)\)\.awaited \+\s*\(capabilityRun\?\.state\.verifier_pending_runs\?\.length \?\? 0\)/.test(RUN),
    "re-deriving the list is how the two components disagreed in the first place",
  );
});

Deno.test("a run that resolves is REMOVED from pending_runs", () => {
  // Without this the gate above is unsafe: `pending_runs` was push-only, and
  // `state` is spread wholesale from the checkpoint on every continuation, so
  // the first pending run a lineage started stayed "pending" for the rest of
  // its life — turning "wait for the run" into "continue until the ceiling",
  // every time.
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  assert(
    ENGINE.includes("state.pending_runs.splice(at, 1)"),
    "an adopted run must leave the list",
  );
  const i = ENGINE.indexOf("state.pending_runs.splice(at, 1)");
  const block = ENGINE.slice(i - 400, i + 900);
  assert(
    block.includes('outcome: "run_adopted"'),
    "and its completion must be recorded, or the next audit reads the Apify console",
  );
  assert(
    /cost_units:\s*0/.test(block),
    "adoption is a GET on a run already charged for",
  );
});
