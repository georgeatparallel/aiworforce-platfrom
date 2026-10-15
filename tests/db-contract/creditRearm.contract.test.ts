// Credit reservations against real PostgREST + real Postgres, through the
// production caller (`authorizeProviderCall` / `settleProviderCall`): a key
// whose reservation was REFUNDED — settled `not_charged` (the call did not
// start) or `released` by the stale reaper — must be RE-ARMED by a later
// attempt that really runs: balance-checked and charged. Before the held fix
// (supabase/migrations-held/20261015130000_credits_rearm_settled_key.sql) the
// RPC replayed the refunded row: the attempt was allowed with no balance check
// and settled at 0, so a real purchase went uncharged.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizeProviderCall, settleProviderCall } from "../../supabase/functions/_shared/creditAuthorization.ts";
import { seedWorkspace, serviceClient, sql, uuid } from "./lib/harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };

async function workspaceWith(balance: number): Promise<string> {
  const ws = await seedWorkspace();
  await sql`insert into public.workspace_credit_balances (workspace_id, balance_credits) values (${ws}, ${balance})`;
  return ws;
}
async function balances(ws: string) {
  const [b] = await sql`select balance_credits, reserved_credits from public.workspace_credit_balances where workspace_id = ${ws}`;
  return { balance: b.balance_credits as number, reserved: b.reserved_credits as number };
}
async function txn(ws: string, key: string) {
  const rows = await sql`select id, status, actual_credits from public.credit_transactions where workspace_id = ${ws} and idempotency_key = ${key}`;
  assertEquals(rows.length, 1, "one row per key: re-arming never inserts a second transaction");
  return rows[0];
}
const authorize = async (ws: string, key: string) =>
  authorizeProviderCall({ db: (await serviceClient()) as never, workspace_id: ws, logical_call_key: key, mode: "enforce" });
const settle = async (id: string | null, started: boolean) =>
  settleProviderCall({ db: (await serviceClient()) as never, transaction_id: id, started });

Deno.test("a key refunded once (not_charged) and then really bought is charged", opts, async () => {
  const ws = await workspaceWith(5);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  await settle(a1.transaction_id, false);                      // did not start: refunded
  assertEquals(await balances(ws), { balance: 5, reserved: 0 });

  const a2 = await authorize(ws, key);
  assertEquals(a2.reason, "reserved", "a refunded key is reserved again, not replayed");
  assertEquals(a2.transaction_id, a1.transaction_id, "the same transaction row is re-armed");
  assertEquals(await balances(ws), { balance: 4, reserved: 1 }, "the re-arm holds the credit like a new reservation");
  const s = await settle(a2.transaction_id, true);             // a real run
  assertEquals(s.charged, 1);
  assertEquals(await balances(ws), { balance: 4, reserved: 0 }, "the run that started is charged");
  assertEquals((await txn(ws, key)).status, "charged");
});

Deno.test("a reservation released by the stale reaper and then really bought is charged", opts, async () => {
  const ws = await workspaceWith(5);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  await sql`update public.credit_transactions set created_at = now() - interval '31 minutes' where id = ${a1.transaction_id!}`;
  const [{ n }] = await sql`select public.credits_release_stale(interval '30 minutes') as n`;
  assert(n >= 1, "the reaper released it");
  assertEquals((await txn(ws, key)).status, "released");
  assertEquals(await balances(ws), { balance: 5, reserved: 0 });

  const a2 = await authorize(ws, key);
  await settle(a2.transaction_id, true);
  assertEquals(await balances(ws), { balance: 4, reserved: 0 }, "the purchase after the release is charged");
});

Deno.test("enforcement: a refunded key is balance-checked again, never waved through", opts, async () => {
  const ws = await workspaceWith(1);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  await settle(a1.transaction_id, false);
  // The credit is spent elsewhere in the meantime.
  await sql`update public.workspace_credit_balances set balance_credits = 0 where workspace_id = ${ws}`;

  const a2 = await authorize(ws, key);
  assertEquals(a2.allowed, false, "enforce refuses: there is nothing to reserve");
  assertEquals(a2.reason, "insufficient_credits");
  assertEquals((await txn(ws, key)).status, "not_charged", "a refused re-arm leaves the refunded row as it was");
  assertEquals(await balances(ws), { balance: 0, reserved: 0 });
});

Deno.test("a charged key is still a replay: the same purchase is never charged twice", opts, async () => {
  const ws = await workspaceWith(5);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  await settle(a1.transaction_id, true);
  const a2 = await authorize(ws, key);
  assertEquals(a2.reason, "replayed");
  assertEquals(a2.transaction_id, a1.transaction_id);
  await settle(a2.transaction_id, true);
  assertEquals(await balances(ws), { balance: 4, reserved: 0 });
});

Deno.test("an in-flight reservation is still a replay: no second hold", opts, async () => {
  const ws = await workspaceWith(5);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  const a2 = await authorize(ws, key);
  assertEquals(a2.reason, "replayed");
  assertEquals(a2.transaction_id, a1.transaction_id);
  assertEquals(await balances(ws), { balance: 4, reserved: 1 });
});

Deno.test("concurrent re-arms of one refunded key hold the credit once", opts, async () => {
  const ws = await workspaceWith(5);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  await settle(a1.transaction_id, false);
  const all = await Promise.all(Array.from({ length: 6 }, () => authorize(ws, key)));
  assert(all.every((a) => a.allowed && a.transaction_id === a1.transaction_id), "every caller gets the one row");
  assertEquals(all.filter((a) => a.reason === "reserved").length, 1, "exactly one re-arm; the rest replay it");
  assertEquals(await balances(ws), { balance: 4, reserved: 1 });
});

Deno.test("a re-armed reservation is not reaped by its original age", opts, async () => {
  const ws = await workspaceWith(5);
  const key = `credit-${uuid()}`;
  const a1 = await authorize(ws, key);
  await settle(a1.transaction_id, false);
  await sql`update public.credit_transactions set created_at = now() - interval '2 hours' where id = ${a1.transaction_id!}`;
  await authorize(ws, key);                                     // re-armed just now
  await sql`select public.credits_release_stale(interval '30 minutes')`;
  assertEquals((await txn(ws, key)).status, "reserved", "the 30-minute window runs from the re-arm, not from the first reservation");
  assertEquals(await balances(ws), { balance: 4, reserved: 1 });
});
