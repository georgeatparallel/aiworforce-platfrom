// FAILURE INJECTION — A PAID RUN KNOWN ONLY TO THE LEDGER.
//
// Query B d22d9ee6 through the chaos lab (lib/chaos.ts), with every write of a
// slice lost, so the run that slice bought is recorded in `lead_execution_calls`
// and nowhere else. What a resumed slice recovers from that row decides whether
// the run is read — or bought a second time.
//
//   timed_out   the poll window closed cleanly on a run still RUNNING: the
//               transport finalizes `timed_out` WITH the run id and
//               `metadata.resumable: true`. Recovery read only `started` rows
//               and counted every `timed_out` row as resolved.
//   reused      the run was then ADOPTED, and that slice's writes were lost too:
//               run-agent settles the row `reused`, which completed-run
//               recovery did not read.
//   re-planned  a pending re-planned query, the writes lost: recovered, never
//               bought again — and, a known limit, not adopted (see
//               `RecoveredPendingRun`: the restored retrieval plan predates the
//               amendment that proposed it).
//
// ZERO network, ZERO provider spend, ZERO production writes.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { ChaosLab, type Fault } from "../lib/chaos.ts";
import type { LineageFixture } from "../lib/lineage.ts";
import { spendFloorFromRows } from "../../../supabase/functions/_shared/missionSpendCap.ts";

const D22 = () => loadFixture("queryBd22d9ee6.loop") as LineageFixture;
const CONTINUUM = "Continuum AI";

/** Every write of slice `attempt` is lost: stage boundaries and the end of the slice. */
const allWritesLost = (...attempts: number[]): Fault[] =>
  attempts.flatMap((attempt) => [{ kind: "stage_writes_lost", attempt }, { kind: "end_write_lost", attempt }] as Fault[]);

async function run(pending: string, faults: Fault[], o: Parameters<typeof ChaosLab.open>[2] = {}) {
  const fx = D22();
  fx.provider_responses.find((x) => x.provenance.startsWith(pending))!.pending_once = true;
  const lab = await ChaosLab.open(fx, faults, o);
  try {
    await lab.runToSettle();
    const task = await lab.taskRow();
    return {
      lab, task, queue: await lab.lab.row(lab.queueId), lineage: await lab.lineageRow(), claimHeld: await lab.claimHeld(),
      lastQualified: [...lab.runs].reverse().find((r) => r.qualified)?.qualified ?? [],
      decisions: lab.runs.map((r) => r.http === 200 ? String(r.decision) : `${r.http}:${r.reason}`),
    };
  } finally {
    lab.close();
  }
}
type Run = Awaited<ReturnType<typeof run>>;

/** What may never break: nothing bought twice, and the lineage settles. */
function assertSettled(s: Run, label: string) {
  assertEquals(s.lab.duplicatePurchases(), [], `${label}: a question was bought twice`);
  assertEquals(s.queue.status, "complete", `${label}: the queue did not complete`);
  assertEquals(s.queue.claimed_by, null);
  assertFalse(s.claimHeld, `${label}: a continuation claim was left held`);
  assertEquals(s.lineage?.lease_holder ?? null, null, `${label}: the lineage lease was left held`);
  assertEquals(s.lineage?.status, "terminal");
}
const adoptionsOf = (s: Run, runId: string) => s.lab.ledger.filter((r) => r.reused && r.provider_run_id === runId);
const pendingPurchase = (s: Run) => s.lab.ledger.find((r) => !r.reused && /pending/.test(String(r.provider_run_id)))!;

Deno.test("[failure] LEDGER-ONLY PENDING RUN: a run whose poll window closed (timed_out, resumable) and whose slice lost EVERY write is recovered from the ledger and ADOPTED — paid once", async () => {
  const s = await run("page 2", allWritesLost(2), { pendingAs: "timed_out" });
  assertSettled(s, "page 2 timed_out, slice 2 writes lost");
  const bought = pendingPurchase(s);
  assertEquals([bought.attempt, bought.status, bought.metadata?.resumable], [2, "timed_out", true],
    "slice 2 bought it; the ledger is the only record (its checkpoint writes were lost)");
  assert(s.lab.events.some((e) => e.attempt === 2 && e.at === "end_write_lost"));
  const adopted = adoptionsOf(s, bought.provider_run_id!);
  assertEquals(adopted.map((r) => [r.attempt, r.status]), [[3, "reused"]], "slice 3 re-read it by run id");
  // The durable spend floor counts it once.
  const floor = spendFloorFromRows(s.lab.ledger.map((r) => ({
    status: r.status ?? null,
    provider_call_id: ((r.request_input as { provider_call_spec?: { provider_call_id?: string } } | null)
      ?.provider_call_spec?.provider_call_id) ?? null,
    settled_usd: null, actual_cost_usd: null, estimate_usd: r.estimate_usd,
    resumed_from: ((r.request_input as { resume_run_id?: string } | null)?.resume_run_id) ?? null,
  })));
  assertEquals(floor.paid_calls, s.lab.ledger.filter((r) => !r.reused).length);
  assertEquals([s.task?.result?.terminal_status, s.lastQualified], ["search_exhausted", [CONTINUUM]]);
});

Deno.test("[failure] ADOPTED, THEN LOST: a run adopted in slice 3 (settled `reused`) whose slice lost every write is re-read from the ledger as a COMPLETED run — never bought again", async () => {
  const s = await run("page 2", allWritesLost(2, 3), { settleAdoptedAs: "reused" });
  assertSettled(s, "page 2 pending, slices 2 and 3 lost");
  const bought = pendingPurchase(s);
  assertEquals([bought.attempt, bought.status], [2, "reused"], "slice 2 bought it; slice 3's adoption settled it reused");
  const reads = adoptionsOf(s, bought.provider_run_id!).map((r) => r.attempt);
  assertEquals(reads, [3, 4], "adopted in slice 3, re-read (free) in slice 4 after slice 3's writes were lost");
  assertEquals([s.task?.result?.terminal_status, s.lastQualified], ["search_exhausted", [CONTINUUM]]);
});

Deno.test("[failure] LEDGER-ONLY RE-PLANNED QUERY: recovered and never bought again; not adopted (the restored plan predates it), held only within the wait bound", async () => {
  const s = await run("re-plan query 3", allWritesLost(3));
  assertSettled(s, "re-plan query 3 pending, slice 3 lost");
  const bought = pendingPurchase(s);
  assertEquals(bought.attempt, 3);
  assertEquals(adoptionsOf(s, bought.provider_run_id!), [], "known limit: not adopted");
  const left = (s.task?.result?.capability_execution_state as { pending_runs: Array<{ run_id: string; recovered_from_ledger?: boolean }> })
    .pending_runs;
  assert(left.some((r) => r.run_id === bought.provider_run_id && r.recovered_from_ledger),
    "still listed: a later slice asking its question adopts it");
  assertFalse(s.decisions.includes("continuation_ceiling"), "the wait is bounded, not run to the ceiling");
});
