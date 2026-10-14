// Provider-ledger recovery and spend accounting against real PostgREST: the
// production ledger writer, the D2 prior-purchase read, the durable spend floor
// and the credit reservation RPCs — what a later slice relies on to never buy
// the same thing twice and to never forget what was spent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildStartedRow, createLedgerWriter, type LedgerDb } from "../../supabase/functions/_shared/executionLedger.ts";
import { readPriorPurchases } from "../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
import { readLineageSpendFloor, spendFloorFromRows } from "../../supabase/functions/_shared/missionSpendCap.ts";
import { authorizeProviderCall, settleProviderCall } from "../../supabase/functions/_shared/creditAuthorization.ts";
import { seedTask, seedWorkspace, serviceClient, sql, uuid } from "./lib/harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

/** A spec-governed provider call, as the transport records it. */
function startedRow(ws: string, task: string, key: string, over: { estimate?: number; resumeRunId?: string; logical?: string } = {}) {
  return buildStartedRow({
    workspace_id: ws, task_id: task, stage: "verification", reason: "claim_verification",
    provider_id: "apify", actor_id: "atomus~funding", logical_call_key: over.logical ?? `${task}:${key}`,
    request_input: {
      selected_actor_key: "apify_funding_atomus",
      ...(over.resumeRunId ? { resume_run_id: over.resumeRunId } : {}),
      provider_call_spec: { provider_call_id: `pc-${key}`, idempotency_key: key, cost: { estimate_usd: over.estimate ?? 0.01 } },
    },
  } as never);
}

Deno.test("ledger writer: a started row lands with its spec identity; a same-key retry is a later attempt, not lost", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const task = await seedTask(ws);
  const w = createLedgerWriter(db as unknown as LedgerDb);
  const a = startedRow(ws, task, "k-attempt");
  const b = startedRow(ws, task, "k-attempt");
  await w.insert(a);
  await w.insert(b);
  const rows = await sql`select attempt_number, idempotency_key, provider_call_id, status from public.lead_execution_calls where task_id = ${task} order by attempt_number`;
  assertEquals(rows.map((r) => r.attempt_number), [1, 2], "the attempt_uniq collision escalates instead of dropping the row");
  assertEquals(rows[0].idempotency_key, "k-attempt");
  assertEquals(rows[0].provider_call_id, "pc-k-attempt");
  assertEquals(rows[0].status, "started");

  await w.finalize(a.id!, { status: "succeeded", provider_run_id: "run-A", finished_at: new Date().toISOString() });
  const [done] = await sql`select status, provider_run_id from public.lead_execution_calls where id = ${a.id!}`;
  assertEquals(done, { status: "succeeded", provider_run_id: "run-A" });
});

Deno.test("D2 recovery read: adopt by run id, uncertain without one, scoped to the task, workspace and provider calls", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const other = await seedWorkspace();
  const task = await seedTask(ws);
  const w = createLedgerWriter(db as unknown as LedgerDb);
  const paid = startedRow(ws, task, "k-paid");
  await w.insert(paid);
  await w.finalize(paid.id!, { status: "succeeded", provider_run_id: "run-paid" });
  const running = startedRow(ws, task, "k-running");
  await w.insert(running);
  await w.finalize(running.id!, { provider_run_id: "run-running" });  // still `started`, id attached
  await w.insert(startedRow(ws, task, "k-uncertain"));                // started, no id
  const timedOut = startedRow(ws, task, "k-timeout");
  await w.insert(timedOut);
  await w.finalize(timedOut.id!, { status: "failed", failure_code: "provider_timeout" });
  const refused = startedRow(ws, task, "k-refused");
  await w.insert(refused);
  await w.finalize(refused.id!, { status: "failed", failure_code: "http_400" });
  // Another workspace's row under the same task id and key must be invisible.
  const foreign = { ...startedRow(other, task, "k-foreign"), workspace_id: other };
  await w.insert(foreign);
  await w.finalize(foreign.id!, { status: "succeeded", provider_run_id: "run-foreign" });
  // A stage_result row is never a purchase, even left `started` (which a purchase would read as uncertain).
  await w.insert({ ...startedRow(ws, task, "k-stage"), record_kind: "stage_result" } as never);
  assertEquals((await sql`select count(*)::int as n from public.lead_execution_calls where idempotency_key = 'k-stage'`)[0].n, 1);

  const prior = await readPriorPurchases(db as never, { table: "lead_execution_calls", parentTaskId: task, workspaceId: ws });
  assertEquals(prior.lookup("k-paid"), { kind: "adopt", run_id: "run-paid", status: "succeeded" });
  assertEquals(prior.lookup("k-running"), { kind: "adopt", run_id: "run-running", status: "started" });
  assertEquals(prior.lookup("k-uncertain")?.kind, "uncertain");
  assertEquals(prior.lookup("k-timeout")?.kind, "uncertain", "a timeout may have started a run");
  assertEquals(prior.lookup("k-refused"), null, "a refusal before any run existed is not a purchase");
  assertEquals(prior.lookup("k-foreign"), null);
  assertEquals(prior.lookup("k-stage"), null);
});

Deno.test("spend floor: the lineage's committed spend, re-reads excluded, read through the production query", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  const root = uuid();
  const task = await seedTask(ws);
  const w = createLedgerWriter(db as unknown as LedgerDb);
  const settled = startedRow(ws, task, "f1", { estimate: 0.05, logical: `${root}:a` });
  await w.insert(settled);
  await w.finalize(settled.id!, {
    status: "succeeded", provider_run_id: "r1", actual_cost_usd: 0.045, cost_source: "provider_reported",
    settled_usd: 0.04, settlement_source: "provider_receipt",
  } as never);
  await w.insert(startedRow(ws, task, "f2", { estimate: 0.02, logical: `${root}:b` }));            // in flight: its estimate
  const reread = startedRow(ws, task, "f3", { estimate: 0.02, logical: `${root}:c`, resumeRunId: "r1" });
  await w.insert(reread);
  await w.finalize(reread.id!, { status: "timed_out", provider_run_id: "r1" });                     // a re-read: not a purchase
  await w.insert(startedRow(ws, task, "f4", { estimate: 9, logical: `${uuid()}:other-lineage` }));   // another lineage

  const floor = await readLineageSpendFloor(db as never, root);
  assertEquals(floor, { committed_usd: 0.06, paid_calls: 2, source: "lead_execution_calls" });
  // The projection is exactly what the pure rule needs (numeric arrives as a string).
  const { data } = await db.from("lead_execution_calls")
    .select("status,provider_call_id,settled_usd,actual_cost_usd,estimate_usd:request_input->provider_call_spec->cost->>estimate_usd,resumed_from:request_input->>resume_run_id")
    .like("logical_call_key", `${root}:%`);
  assertEquals(spendFloorFromRows(data as never), floor);
});

Deno.test("credits: one reservation per idempotency key, a replay never reserves twice, settlement charges once", opts, async () => {
  const db = await serviceClient();
  const ws = await seedWorkspace();
  await sql`insert into public.workspace_credit_balances (workspace_id, balance_credits) values (${ws}, 3)
            on conflict (workspace_id) do update set balance_credits = 3, reserved_credits = 0`;
  const key = `credit-${uuid()}`;
  const first = await authorizeProviderCall({ db: db as never, workspace_id: ws, logical_call_key: key, mode: "enforce" });
  assertEquals([first.allowed, first.reserved, first.reason], [true, true, "reserved"]);
  const again = await authorizeProviderCall({ db: db as never, workspace_id: ws, logical_call_key: key, mode: "enforce" });
  assertEquals([again.allowed, again.reason, again.transaction_id], [true, "replayed", first.transaction_id]);
  const [bal] = await sql`select balance_credits, reserved_credits from public.workspace_credit_balances where workspace_id = ${ws}`;
  assertEquals(bal, { balance_credits: 2, reserved_credits: 1 }, "the replay reserved nothing more");

  const settled = await settleProviderCall({ db: db as never, transaction_id: first.transaction_id, started: true });
  assert(settled.settled, JSON.stringify(settled));
  const [after] = await sql`select balance_credits, reserved_credits from public.workspace_credit_balances where workspace_id = ${ws}`;
  assertEquals(after, { balance_credits: 2, reserved_credits: 0 });

  // Not started: the reservation is returned, nothing charged.
  const k2 = `credit-${uuid()}`;
  const r2 = await authorizeProviderCall({ db: db as never, workspace_id: ws, logical_call_key: k2, mode: "enforce" });
  await settleProviderCall({ db: db as never, transaction_id: r2.transaction_id, started: false });
  const [back] = await sql`select balance_credits, reserved_credits from public.workspace_credit_balances where workspace_id = ${ws}`;
  assertEquals(back, { balance_credits: 2, reserved_credits: 0 });

  // Exhausted: refused in enforce mode.
  await sql`update public.workspace_credit_balances set balance_credits = 0 where workspace_id = ${ws}`;
  const none = await authorizeProviderCall({ db: db as never, workspace_id: ws, logical_call_key: `credit-${uuid()}`, mode: "enforce" });
  assertEquals([none.allowed, none.reserved, none.reason], [false, false, "insufficient_credits"]);
});
