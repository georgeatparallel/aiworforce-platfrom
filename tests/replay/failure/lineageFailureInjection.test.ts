// FAILURE INJECTION — A WHOLE LINEAGE, INTERRUPTED WHERE PRODUCTION HAS BEEN.
//
// Query B d22d9ee6 (and a9a6791a) replayed through the production queue,
// worker, continuation claim, lineage lease, checkpoint writes and execution
// ledger (lib/chaos.ts), with one fault — or a seeded schedule of several —
// injected where production has failed:
//
//   lost checkpoint writes      eb0d520f: the slice-result write ran ~161 s and was lost
//   a worker that dies          after the engine bought, before anything was written
//   a worker that stalls        past its lease, while another worker takes over
//   a claim release that fails  d22d9ee6 slice 5: 57014, the claim stayed held, slice 6 got 409
//   a lineage release that fails
//   a provider run still executing at the end of a slice
//
// What must hold whatever happens (`assertSettledConsistently`):
//   no question is bought twice; the queue settles; no claim or lease is left
//   held; the task and lineage agree with the queue; the retry budget bounds
//   the attempts; the durable spend floor equals what was bought.
//
// Defects this lab reproduces are tested twice: a `[failure] … DEFECT` test pins
// what happens today, and a `[known-gap]` test (ignored) states what must
// happen. Fixing one turns the first red and the second green.
//
// ZERO network, ZERO provider spend, ZERO production writes.

import { assert, assertEquals, assertFalse, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { ChaosLab, type Fault } from "../lib/chaos.ts";
import { type LineageFixture, replayLineage } from "../lib/lineage.ts";
import { queryBFixture, recordedRouteControl } from "../lib/queryB.ts";
import { inputFingerprint } from "../../../supabase/functions/_shared/leadResumeState.ts";
import { spendFloorFromRows } from "../../../supabase/functions/_shared/missionSpendCap.ts";
import { V2_MAX_ATTEMPTS } from "../../../supabase/functions/_shared/leadMissionTerminal.ts";

const D22 = () => loadFixture("queryBd22d9ee6.loop") as LineageFixture;
const CONTINUUM = "Continuum AI";

interface Settled {
  lab: ChaosLab;
  queue: { status: string; attempts: number; continuations?: number; claimed_by: string | null };
  task: { status: string | null; result: Record<string, unknown> | null } | null;
  lineage: Record<string, unknown> | null;
  claimHeld: boolean;
  lastQualified: string[];
  terminal: unknown;
}

async function settle(lab: ChaosLab): Promise<Settled> {
  await lab.runToSettle();
  const task = await lab.taskRow();
  return {
    lab, queue: await lab.lab.row(lab.queueId), task, lineage: await lab.lineageRow(), claimHeld: await lab.claimHeld(),
    lastQualified: [...lab.runs].reverse().find((r) => r.qualified)?.qualified ?? [],
    terminal: task?.result?.terminal_status,
  };
}

/** One lab per scenario, run once, asserted on by as many tests as need it. */
const cache = new Map<string, Promise<Settled>>();
function scenario(name: string, open: () => Promise<ChaosLab>): Promise<Settled> {
  if (!cache.has(name)) cache.set(name, open().then(settle));
  return cache.get(name)!;
}
/** `pending`: the provenance prefix of a recorded provider answer still RUNNING when first asked. */
const d22 = (faults: Fault[] = [], pending?: string) =>
  scenario(`d22:${JSON.stringify(faults)}:${pending ?? ""}`, () => {
    const fx = D22();
    if (pending) {
      (fx.provider_responses.find((r) => r.provenance.startsWith(pending))! as { pending_once?: boolean }).pending_once = true;
    }
    return ChaosLab.open(fx, faults);
  });
const a9 = (faults: Fault[] = []) => scenario(`a9:${JSON.stringify(faults)}`, () => {
  const fx = queryBFixture();
  return ChaosLab.open(fx as unknown as LineageFixture, faults, { deps: { controlRoutes: recordedRouteControl(fx) } });
});

/** What may never break, whatever the faults. */
function assertSettledConsistently(s: Settled, label: string) {
  const { lab } = s;
  assertEquals(lab.duplicatePurchases(), [], `${label}: a question was bought twice`);
  assert(["complete", "failed"].includes(s.queue.status), `${label}: the queue did not settle (${s.queue.status})`);
  assertEquals(s.queue.claimed_by, null, `${label}: the queue row is still claimed`);
  assertFalse(s.claimHeld, `${label}: a continuation claim was left held`);
  assertEquals(s.lineage?.lease_holder ?? null, null, `${label}: the lineage lease was left held`);
  assertEquals(s.lineage?.status, "terminal", `${label}: the lineage is not terminal`);
  if (s.queue.status === "complete") {
    assertEquals(s.task?.status, "complete", `${label}: queue complete, task ${s.task?.status}`);
    assertNotEquals(s.terminal, "continuation_required", `${label}: a finished mission still reads as continuing`);
  } else {
    assertEquals(s.task?.status, "failed", `${label}: queue failed, task ${s.task?.status}`);
  }
  assert(lab.reconciled.every((r) => r.remaining.length === 0), `${label}: terminal reconciliation left disagreements`);
  assert(s.queue.attempts <= V2_MAX_ATTEMPTS, `${label}: ${s.queue.attempts} attempts`);
  // ACCOUNTING: the durable spend floor (production `spendFloorFromRows`) is exactly what was bought.
  const floor = spendFloorFromRows(lab.ledger.map((r) => ({
    status: r.status ?? null,
    provider_call_id: ((r.request_input as { provider_call_spec?: { provider_call_id?: string } } | null)?.provider_call_spec?.provider_call_id) ?? null,
    settled_usd: null, actual_cost_usd: null, estimate_usd: r.estimate_usd,
  })));
  const bought = lab.ledger.filter((r) => !r.reused);
  assertEquals(floor.paid_calls, bought.length, `${label}: the floor counts ${floor.paid_calls} paid calls, ${bought.length} were bought`);
  const usd = Math.round(bought.reduce((n, r) => n + (r.estimate_usd ?? 0), 0) * 10000) / 10000;
  assertEquals(floor.committed_usd, usd, `${label}: the floor's committed spend`);
}

/** The questions the L replay (no queue, no faults) buys for d22d9ee6. */
let baselineKeys: Promise<string[]> | null = null;
function lReplayPurchases(): Promise<string[]> {
  baselineKeys ??= (async () => {
    const keys: string[] = [];
    await replayLineage(D22(), {
      maxSlices: 6,
      onSlice: (_n, s) => {
        for (const c of s.provider.calls) if (!c.adopted) keys.push(`${c.actor}:${inputFingerprint(c.input)}`);
      },
    });
    return keys.sort();
  })();
  return baselineKeys;
}
const purchaseKeys = (s: Settled) => s.lab.purchases().map((p) => p.key).sort();

/**
 * THE SAME QUESTIONS, MODULO THE MODEL. A re-planned query is the model's
 * answer, and the lab answers a re-run slice as a live model would — with the
 * NEXT recorded answer ("Sales Rep 3" becomes "Sales Rep 4"). So a re-plan is
 * compared by count; every other question by its exact fingerprint.
 */
const REPLAN = /Sales Rep \d+/;
const questionKey = (actor: string, input: unknown) =>
  REPLAN.test(JSON.stringify(input)) ? `${actor}:<re-plan>` : `${actor}:${inputFingerprint(input as Record<string, unknown>)}`;
const questionsOf = (s: Settled) => s.lab.ledger.filter((r) => !r.reused && r.status !== "failed")
  .map((r) => questionKey(String(r.capability), (r.request_input as { input?: unknown } | null)?.input ?? {})).sort();
let baselineQuestions: Promise<string[]> | null = null;
function lReplayQuestions(): Promise<string[]> {
  baselineQuestions ??= (async () => {
    const keys: string[] = [];
    await replayLineage(D22(), {
      maxSlices: 6,
      onSlice: (_n, s) => {
        for (const c of s.provider.calls) if (!c.adopted) keys.push(questionKey(c.actor, c.input));
      },
    });
    return keys.sort();
  })();
  return baselineQuestions;
}

const runsOf = (s: Settled) => s.lab.runs.map((r) => r.http === 200 ? String(r.decision) : `${r.http}:${r.reason}`);

// ══════════════════════════════════════════════════════════════ baseline ══

Deno.test("[failure] BASELINE: d22d9ee6 through the queue, claim, lease, checkpoint and ledger ends exactly as the L replay", async () => {
  const s = await d22();
  assertSettledConsistently(s, "clean");
  assertEquals(s.lab.runs.length, 3);
  assertEquals(s.terminal, "search_exhausted");
  assertEquals(s.lastQualified, [CONTINUUM]);
  assertEquals(purchaseKeys(s), await lReplayPurchases(), "the same questions bought, each once");
  assertEquals([s.queue.status, s.queue.attempts, s.queue.continuations], ["complete", 1, 2], "two clean continuations, no retry");
  assertEquals(s.lab.ledger.filter((r) => r.reused).length, 0);
});

// ═════════════════════════════════════════════ 1. checkpoint write failures ══

for (const at of [1, 2]) {
  Deno.test(`[failure] 1 the END-OF-SLICE WRITE of slice ${at} is lost: the next slice resumes from the last stage write — nothing bought twice, same lead, same ending`, async () => {
    const s = await d22([{ kind: "end_write_lost", attempt: at }]);
    assertSettledConsistently(s, `end_write_lost@${at}`);
    assertEquals(s.terminal, "search_exhausted");
    assertEquals(s.lastQualified, [CONTINUUM]);
    assertEquals(purchaseKeys(s), await lReplayPurchases());
  });
}

Deno.test("[failure] 1 EVERY WRITE of slice 2 is lost: the next slice resumes from slice 1 and ADOPTS slice 2's purchases from the ledger — re-read, never re-bought", async () => {
  const s = await d22([{ kind: "stage_writes_lost", attempt: 2 }, { kind: "end_write_lost", attempt: 2 }]);
  assertSettledConsistently(s, "all writes lost @2");
  assertEquals(s.terminal, "search_exhausted");
  assertEquals(s.lastQualified, [CONTINUUM]);
  // The lost slice's model re-plan is asked again (a repeated MODEL call, not
  // a repeated purchase): the re-run slice re-plans with the next answer.
  assertEquals(questionsOf(s), await lReplayQuestions(), "the same questions, each bought once");
  const reused = s.lab.ledger.filter((r) => r.reused);
  assertEquals(reused.length, 2, "slice 2's two job searches re-read by run id (production `recoverCompletedRuns`)");
  assert(reused.every((r) => r.attempt === 3));
});

Deno.test("[failure] 1 EVERY WRITE of the FIRST slice is lost: nothing can resume (409 no_checkpoint), and the mission ends FAILED — consistently, with its paid calls stranded (reliability gap)", async () => {
  const s = await d22([{ kind: "stage_writes_lost", attempt: 1 }, { kind: "end_write_lost", attempt: 1 }]);
  assertSettledConsistently(s, "all writes lost @1");
  assertEquals(runsOf(s), ["replenishment_required", "409:no_checkpoint", "409:no_checkpoint", "409:no_checkpoint", "409:no_checkpoint"]);
  assertEquals([s.queue.status, s.task?.status, s.terminal], ["failed", "failed", "continuation_attempts_exhausted"]);
  // THE GAP: the ledger names all three runs, but a resume with no checkpoint is
  // refused before the recovery that could adopt them. Honest, not silent.
  assertEquals(s.lab.purchases().length, 3);
});

// D4 (fixed): the last slice released its lineage `terminal`, but its result
// write was lost, so the task row still read the previous slice's
// `continuation_required`. The worker used to release the queue `resumable`
// from that row, and `claim_next_lead_mission` never claims a row whose
// lineage is terminal: the queue, task and plan were stranded for ever. The
// worker now asks the lineage row, which decides, as it does for the claim.
Deno.test("[failure] 1 D4 the LAST slice's result write is lost: the terminal lineage ends the mission — queue, task and lineage settle on the slice's own verdict", async () => {
  const s = await d22([{ kind: "end_write_lost", attempt: 3 }]);
  assertSettledConsistently(s, "end_write_lost@3");
  assertEquals(s.terminal, "search_exhausted", "the lineage's verdict, not the stale row's");
  assertEquals(s.lab.runs.length, 3, "no extra slice: nothing re-ran, nothing was re-bought");
  assertEquals(purchaseKeys(s), await lReplayPurchases());
  assertEquals([s.queue.status, s.queue.attempts, s.queue.continuations], ["complete", 1, 2]);
  // The worker's terminal reconciliation repaired the task row from the queue's ending.
  const fix = s.lab.reconciled.at(-1)!;
  assert(fix.violations.includes("task.terminal_status=continuation_required"), fix.violations.join(", "));
  assertEquals(fix.remaining, []);
});

// ═══════════════════════════════════════ 2–3. worker death, lease expiry, reclaim ══

for (const at of [1, 2]) {
  Deno.test(`[failure] 2 the WORKER DIES in slice ${at} after the engine bought, before any write or release: its lease expires, another claim takes over, nothing is bought twice`, async () => {
    const s = await d22([{ kind: "worker_dies_after_engine", attempt: at }]);
    assertSettledConsistently(s, `worker_dies@${at}`);
    assertEquals(s.terminal, "search_exhausted");
    assertEquals(s.lastQualified, [CONTINUUM]);
    assertEquals(purchaseKeys(s), await lReplayPurchases());
    assertEquals(s.lab.invocations, s.lab.runs.length + 1, "the dead slice never answered");
    assertEquals(s.lab.releases.length, s.lab.runs.length, "and released nothing: its lease had to expire");
    if (at === 2) {
      // Slice 2 held the continuation claim when it died: the reclaiming slice
      // is refused until the claim's own lease expires, then proceeds.
      assertEquals(runsOf(s), ["replenishment_required", "409:already_claimed", "frontier_exhausted"]);
    }
  });
}

Deno.test("[failure] 3 a STALLED worker loses its lease mid-slice: another worker reclaims and finishes the mission — no question bought twice, the stalled worker's releases are refused", async () => {
  const s = await stalledTakeover();
  assertEquals(s.lab.duplicatePurchases(), []);
  assertEquals([s.queue.status, s.lineage?.status, s.lineage?.lease_holder ?? null, s.claimHeld], ["complete", "terminal", null, false]);
  const stalled = s.lab.events.filter((e) => e.attempt === 2);
  assertEquals(stalled.find((e) => e.at === "claim_release")?.detail?.released, false, "its claim had been superseded");
  assertEquals(stalled.find((e) => e.at === "lineage_release")?.detail?.reason, "not_lease_holder");
});

// D1. The stale write is unfenced: it lands over the finished mission's
// result. Since D4 the stale worker's own (refused) queue release reads the
// terminal lineage and its terminal reconciliation puts the STATUS back — but
// the result it wrote is slice 2's, not the finished slice's.
Deno.test("[failure] 3 D1 DEFECT REPRODUCED — the stalled worker wakes after the mission finished and its end-of-slice write OVERWRITES the finished result with its stale slice", async () => {
  const s = await stalledTakeover();
  assertEquals([s.queue.status, s.lineage?.status], ["complete", "terminal"]);
  // The status is repaired (D4: the lineage decides, the reconciliation writes) …
  assertEquals(s.terminal, "search_exhausted");
  // … but the finished slice's execution state was replaced by the stale slice's.
  const attempts = (r: Record<string, unknown> | null | undefined) =>
    ((r?.capability_execution_state ?? {}) as { provider_attempts?: unknown[] }).provider_attempts?.length ?? 0;
  assert(attempts(s.task?.result) < attempts(finishedResult),
    `today: the stale write lands (${attempts(s.task?.result)} < ${attempts(finishedResult)} provider attempts) — ` +
    "if this fails, D1 is fixed: enable the [known-gap] test below and delete this one");
});

Deno.test({
  name: "[known-gap] D1 a stale generation's end-of-slice write never lands over a finished mission's result",
  ignore: true,
  fn: async () => {
    const s = await stalledTakeover();
    assertSettledConsistently(s, "stalled takeover");
    assertEquals(s.task?.result?.capability_execution_state, finishedResult?.capability_execution_state);
  },
});

let stalled: Promise<Settled> | null = null;
/** The task result as the mission finished, before the stalled worker woke. */
let finishedResult: Record<string, unknown> | null | undefined;
function stalledTakeover(): Promise<Settled> {
  stalled ??= (async () => {
    const lab = await ChaosLab.open(D22());
    await lab.tick();                       // slice 1, clean
    await lab.advance(130);                 // its continuation backoff passes
    const a = await lab.stalledWorker();    // worker A: slice 2 computed, end write pending
    await lab.advance(400);                 // A's queue lease, lineage lease and claim all expire
    await lab.runToSettle();                // worker B reclaims and finishes the mission
    finishedResult = (await lab.taskRow())?.result;
    await a.resume();                       // A wakes and completes its slice
    const task = await lab.taskRow();
    return {
      lab, queue: await lab.lab.row(lab.queueId), task, lineage: await lab.lineageRow(), claimHeld: await lab.claimHeld(),
      lastQualified: [], terminal: task?.result?.terminal_status,
    };
  })();
  return stalled;
}

// ═══════════════════════════════════════════════ 4–5. claim release and 409s ══

Deno.test("[failure] 4 the CLAIM RELEASE fails (all three retries): the next slice is refused 409 already_claimed until the claim expires, then the mission completes", async () => {
  const s = await d22([{ kind: "claim_release_fails", attempt: 2 }]);
  assertSettledConsistently(s, "claim_release_fails@2");
  const release = s.lab.events.find((e) => e.attempt === 2 && e.at === "claim_release")!;
  assertEquals([release.detail?.released, release.detail?.attempts], [false, 3], "retried, exactly as run-agent");
  assertEquals(runsOf(s), ["replenishment_required", "replenishment_required", "409:already_claimed", "409:already_claimed", "frontier_exhausted"]);
  assertEquals(s.terminal, "search_exhausted");
  assertEquals(s.lastQualified, [CONTINUUM]);
});

Deno.test("[failure] 5 a 409 CONFLICT is a no-op retry: it folds no slice, never moves the lineage counter, costs exactly one attempt, and stays inside the retry budget", async () => {
  const clean = await d22();
  const s = await d22([{ kind: "claim_release_fails", attempt: 2 }]);
  const conflicts = s.lab.runs.filter((r) => r.http === 409).length;
  assertEquals(conflicts, 2);
  assertEquals(s.queue.continuations, clean.queue.continuations, "no 409 counted as a continuation");
  assertEquals(s.queue.attempts, clean.queue.attempts + conflicts, "each 409 cost one attempt");
  const progress = (r: Settled) => (r.task?.result?.lead_lineage_progress as { continuations_used: number }).continuations_used;
  assertEquals(progress(s), progress(clean), "the lineage counter only counts slices that ran");
  assert(s.queue.attempts <= V2_MAX_ATTEMPTS);
});

Deno.test("[failure] 4 the LINEAGE RELEASE fails (all three retries): the next slice re-enters its own lease and the mission completes unchanged", async () => {
  const s = await d22([{ kind: "lineage_release_fails", attempt: 2 }]);
  assertSettledConsistently(s, "lineage_release_fails@2");
  assertEquals(s.lab.events.find((e) => e.attempt === 2 && e.at === "lineage_release")?.detail?.reason, "release_unavailable");
  assertEquals(purchaseKeys(s), await lReplayPurchases());
  assertEquals(s.terminal, "search_exhausted");
});

// ═══════════════════════════════════════ 6. provider runs pending across slices ══

Deno.test("[failure] 6 the FIRST PAGE is still running when slice 1 ends: the next slice adopts it by run id — paid once, then the lineage proceeds", async () => {
  const s = await d22([], "page 1");
  assertSettledConsistently(s, "page 1 pending");
  assertEquals(runsOf(s)[0], "awaiting_provider_run");
  const p1 = s.lab.ledger.filter((r) => r.capability === "apify_linkedin_job_search" &&
    (r.request_input as { input: { page?: number } }).input.page === undefined && r.attempt <= 2);
  assertEquals(p1.filter((r) => r.reused).length, 1, "adopted once");
  assertEquals(s.lab.ledger.filter((r) => r.status === "started").length, 0, "no run left unread");
  assertEquals(s.terminal, "search_exhausted");
});

Deno.test("[failure] 6 a COMPANY-DETAILS read still running at slice end is adopted next slice — never bought twice", async () => {
  const s = await d22([], "declared bands");
  assertSettledConsistently(s, "company details pending");
  assert(s.lab.ledger.some((r) => r.reused && r.capability === "apify_linkedin_company_details"));
  assertEquals(s.lab.ledger.filter((r) => r.status === "started").length, 0);
  assertEquals(s.lastQualified, [CONTINUUM]);
});

Deno.test("[failure] 6 D3 DEFECT REPRODUCED — a REPLENISHMENT PAGE still running at slice end is never adopted: the lineage waits on it until the continuation ceiling and ends without its lead", async () => {
  const s = await d22([], "page 2");
  const runs = runsOf(s);
  assertEquals(runs.slice(0, 2), ["replenishment_required", "awaiting_provider_run"]);
  assertEquals(runs.at(-1), "continuation_ceiling");
  assert(runs.slice(1, -1).every((r) => r === "awaiting_provider_run"), runs.join(","));
  // The paid page is never read: its ledger row is still `started` at the end.
  assertEquals(s.lab.ledger.filter((r) => r.status === "started").length, 1);
  assertEquals([s.queue.status, s.terminal, s.lastQualified], ["complete", "budget_exhausted", []],
    "today — if this fails, D3 is fixed: enable the [known-gap] test below and delete this one");
  // Nothing is bought twice even so.
  assertEquals(s.lab.duplicatePurchases(), []);
});

Deno.test({
  name: "[known-gap] D3 a replenishment page still running at slice end is adopted by the next slice and the lineage finds its lead",
  ignore: true,
  fn: async () => {
    const s = await d22([], "page 2");
    assertSettledConsistently(s, "page 2 pending");
    assertEquals(s.lab.ledger.filter((r) => r.status === "started").length, 0);
    assertEquals(s.lastQualified, [CONTINUUM]);
  },
});

// ═══════════════════════════════ 7–8. seeded fault schedules: the invariants hold ══

/** mulberry32 — a fixed seed gives a fixed schedule. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const KINDS: Fault["kind"][] = ["end_write_lost", "stage_writes_lost", "worker_dies_after_engine", "claim_release_fails", "lineage_release_fails"];
export function schedule(seed: number): Fault[] {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 3);
  const out: Fault[] = [];
  for (let i = 0; i < n; i++) {
    const kind = KINDS[Math.floor(r() * KINDS.length)];
    // A first slice that loses EVERY write cannot resume at all — its own test above.
    const attempt = kind === "stage_writes_lost" ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 4);
    out.push({ kind, attempt });
  }
  return out;
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const faults = schedule(seed);
  Deno.test(`[failure] 7–8 seeded schedule ${seed} ${JSON.stringify(faults.map((f) => `${f.kind}@${f.attempt}`))}: nothing bought twice; queue, task, lineage, claim and ledger agree`, async () => {
    const s = await d22(faults);
    assertSettledConsistently(s, `seed ${seed}`);
    if (s.queue.status === "complete") {
      assertEquals(s.terminal, "search_exhausted");
      assertEquals(s.lastQualified, [CONTINUUM], "the valid lead survives the faults");
      assertEquals(questionsOf(s), await lReplayQuestions(), "the same questions, each bought once");
    }
  });
}

// ══════════════════════════════════════ a9a6791a: the outcome does not depend on the faults ══

Deno.test("[failure] a9a6791a: under each single fault the lineage ends exactly as its clean run — same questions bought once, same ending", async () => {
  const clean = await a9();
  assertSettledConsistently(clean, "a9a6791a clean");
  const surface = (s: Settled) => ({ terminal: s.terminal, purchases: purchaseKeys(s), qualified: s.lastQualified });
  for (const faults of [
    [{ kind: "end_write_lost", attempt: 1 }],
    [{ kind: "worker_dies_after_engine", attempt: 2 }],
    [{ kind: "stage_writes_lost", attempt: 2 }, { kind: "end_write_lost", attempt: 2 }],
    [{ kind: "claim_release_fails", attempt: 2 }],
    [{ kind: "lineage_release_fails", attempt: 1 }],
  ] as Fault[][]) {
    const s = await a9(faults);
    assertSettledConsistently(s, `a9a6791a ${JSON.stringify(faults)}`);
    assertEquals(surface(s), surface(clean), JSON.stringify(faults));
  }
});
