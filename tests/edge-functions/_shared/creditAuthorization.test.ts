// PAID PROVIDER WORK NEEDS AUTHORISATION, AND A UI WARNING IS NOT ONE.
//
// ── WHAT THE AUDIT FOUND ────────────────────────────────────────────────────
//
// The credit ledger was never missing. `credits_reserve` / `credits_finalize` /
// `credits_release_stale` / `credits_grant` have existed since 2026-08-07 and
// are correct — idempotency checked before money moves, a conditional
// `UPDATE ... WHERE balance_credits >= p_amount` as the concurrency control,
// finalize row-locked and unable to charge more than was reserved.
//
// Exactly one edge function calls any of it: `unlock-founders`. The lead path
// never touches it, and `src/lib/credits/ledger.ts` is consumed only by React
// components — it displays, it does not enforce. That is why the sidebar can
// read "0 credits left" while a run spends real money, why
// `credit_transactions` holds zero rows, and why `workspace_credit_balances`
// holds none at all.
//
// So none of this designs a credit system. It routes provider execution
// through the one that already exists, at the physical call, beside the ledger
// write — because a future path that reaches a provider without knowing about
// credits is the failure being designed out, and the only defence is that the
// money boundary and the call boundary are the same line.
//
// ZERO network, ZERO Actor runs, ZERO real database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeProviderCall, settleProviderCall, resolveCreditEnforcement, creditSettlementFor,
  describeRpcError, CREDITS_PER_PROVIDER_CALL, CREDIT_ENFORCEMENT_ENV,
  CREDIT_REFUSED_ERROR, type CreditDb,
} from "../../../supabase/functions/_shared/creditAuthorization.ts";

/** A fake ledger that behaves like the real RPCs, including their refusals. */
function fakeLedger(opts: {
  balance?: number;
  rpcError?: unknown;
  throwOn?: string;
} = {}) {
  let balance = opts.balance ?? 0;
  let reserved = 0;
  const txns = new Map<string, { id: string; key: string; amount: number; status: string }>();
  const byKey = new Map<string, string>();
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let n = 0;

  const db: CreditDb = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (opts.throwOn === fn) return Promise.reject(new Error("connection reset"));
      if (opts.rpcError) return Promise.resolve({ data: null, error: opts.rpcError });

      if (fn === "credits_reserve") {
        const key = String(args.p_idempotency_key);
        const amount = Number(args.p_amount);
        // IDEMPOTENCY BEFORE MONEY, as the real function does it.
        const existing = byKey.get(key);
        if (existing) {
          return Promise.resolve({
            data: { ok: true, replayed: true, transaction_id: existing, status: "reserved" },
            error: null,
          });
        }
        if (balance < amount) {
          return Promise.resolve({
            data: { ok: false, error: "insufficient_credits", balance, needed: amount },
            error: null,
          });
        }
        balance -= amount; reserved += amount;
        const id = `txn-${++n}`;
        txns.set(id, { id, key, amount, status: "reserved" });
        byKey.set(key, id);
        return Promise.resolve({
          data: { ok: true, replayed: false, transaction_id: id, balance_after: balance },
          error: null,
        });
      }

      if (fn === "credits_finalize") {
        const t = txns.get(String(args.p_transaction_id));
        if (!t) return Promise.resolve({ data: { ok: false, error: "unknown_transaction" }, error: null });
        if (t.status !== "reserved") {
          return Promise.resolve({
            data: { ok: true, replayed: true, actual_credits: 0 }, error: null,
          });
        }
        const actual = Number(args.p_actual);
        reserved -= t.amount; balance += t.amount - actual;
        t.status = String(args.p_status);
        return Promise.resolve({
          data: { ok: true, replayed: false, actual_credits: actual, refunded_credits: t.amount - actual },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
    },
  };
  return {
    db, calls,
    get balance() { return balance; },
    get reserved() { return reserved; },
  };
}

const AUTH = {
  workspace_id: "ws-1", logical_call_key: "task-1:identity:abc123",
  task_id: "task-1", capability: "apify_linkedin_company_search",
};

// ═══ 1. THE MODE, AND WHY THE DEFAULT IS WHAT IT IS ════════════════════════

// FAIL CLOSED since launch hardening (2026-09-28): with open signup, an unset
// variable meant any new account spent without limit. Credits now go to
// approved beta workspaces, so the guard is on unless deliberately disarmed.
Deno.test("1. enforcement is ON by default, and only one word turns it off", () => {
  assertEquals(resolveCreditEnforcement(() => undefined), "enforce");
  assertEquals(resolveCreditEnforcement(() => ""), "enforce");
  assertEquals(resolveCreditEnforcement(() => "false"), "enforce",
    "a falsy-looking value is not the word; guessing here spends money");
  assertEquals(resolveCreditEnforcement(() => "obsrve"), "enforce", "a typo cannot disarm it");
  assertEquals(resolveCreditEnforcement(() => "observe"), "observe");
  assertEquals(resolveCreditEnforcement(() => " OBSERVE "), "observe");
  assertEquals(resolveCreditEnforcement(() => "enforce"), "enforce");
  assertEquals(CREDIT_ENFORCEMENT_ENV, "LEAD_CREDIT_ENFORCEMENT");
});

// ═══ 2. OBSERVE AND ENFORCE DIFFER IN EXACTLY ONE PLACE ════════════════════

Deno.test("2. an empty balance: observe permits, enforce refuses", () => {
  return (async () => {
    // The live state today — `workspace_credit_balances` has no row at all,
    // which the RPC reports the same way as an insufficient one.
    const observed = await authorizeProviderCall({
      ...AUTH, db: fakeLedger({ balance: 0 }).db, mode: "observe",
    });
    assertEquals(observed.allowed, true, "observe must not stop the run");
    assertEquals(observed.reserved, false, "and must not pretend it reserved anything");
    assertEquals(observed.reason, "insufficient_credits");

    const enforced = await authorizeProviderCall({
      ...AUTH, db: fakeLedger({ balance: 0 }).db, mode: "enforce",
    });
    assertEquals(enforced.allowed, false);
    assertEquals(enforced.reserved, false);
    assertEquals(enforced.reason, "insufficient_credits");
  })();
});

Deno.test("3. observe RESERVES for real when the balance is there", async () => {
  // The point of observe-only: it is the real path with the last step
  // disarmed, so what it proves is what enforce will do.
  const led = fakeLedger({ balance: 5 });
  const a = await authorizeProviderCall({ ...AUTH, db: led.db, mode: "observe" });
  assertEquals(a.allowed, true);
  assertEquals(a.reserved, true);
  assertEquals(a.reason, "reserved");
  assertEquals(led.balance, 4, "money really moved");
  assertEquals(led.reserved, CREDITS_PER_PROVIDER_CALL);
});

// ═══ 3. IDEMPOTENCY — THE THING CONTINUATION AND RETRY DEPEND ON ═══════════

Deno.test("4. the same logical call reserves ONCE, however many times it is asked", async () => {
  const led = fakeLedger({ balance: 5 });
  const first = await authorizeProviderCall({ ...AUTH, db: led.db, mode: "enforce" });
  const replay = await authorizeProviderCall({ ...AUTH, db: led.db, mode: "enforce" });

  assertEquals(first.reason, "reserved");
  assertEquals(replay.reason, "replayed", "a retry is not a second purchase");
  assertEquals(replay.transaction_id, first.transaction_id);
  assertEquals(led.balance, 4, "one credit gone, not two");
});

Deno.test("5. two DIFFERENT calls are two reservations", async () => {
  const led = fakeLedger({ balance: 5 });
  await authorizeProviderCall({ ...AUTH, db: led.db, mode: "enforce" });
  await authorizeProviderCall({
    ...AUTH, logical_call_key: "task-1:enrichment:zzz", db: led.db, mode: "enforce",
  });
  assertEquals(led.balance, 3);
});

// ═══ 4. CONCURRENCY: THE LAST CREDIT GOES TO ONE CALLER ════════════════════

Deno.test("6. four workers racing one credit — exactly one wins", async () => {
  const led = fakeLedger({ balance: 1 });
  const results = await Promise.all([1, 2, 3, 4].map((i) =>
    authorizeProviderCall({
      ...AUTH, logical_call_key: `task-1:identity:worker-${i}`,
      db: led.db, mode: "enforce",
    })
  ));
  assertEquals(results.filter((r) => r.allowed).length, 1,
    "the conditional UPDATE in credits_reserve is what makes this true in Postgres");
  assertEquals(results.filter((r) => r.reason === "insufficient_credits").length, 3);
  assertEquals(led.balance, 0);
});

// ═══ 5. SETTLEMENT — A CALL THAT NEVER RAN IS NEVER CHARGED ════════════════

Deno.test("7. a started call is charged; an unstarted one is refunded whole", async () => {
  const led = fakeLedger({ balance: 10 });
  const a = await authorizeProviderCall({ ...AUTH, db: led.db, mode: "enforce" });
  assertEquals(led.balance, 9);

  const consumed = await settleProviderCall({
    db: led.db, transaction_id: a.transaction_id, started: true,
  });
  assertEquals(consumed.charged, 1);
  assertEquals(led.balance, 9, "spent, so nothing comes back");
  assertEquals(led.reserved, 0, "and the reservation is closed either way");

  const b = await authorizeProviderCall({
    ...AUTH, logical_call_key: "k2", db: led.db, mode: "enforce",
  });
  const released = await settleProviderCall({
    db: led.db, transaction_id: b.transaction_id, started: false,
  });
  assertEquals(released.charged, 0);
  assertEquals(led.balance, 9, "a call that never reached the provider costs nothing");
});

Deno.test("8. settling twice does not refund twice", async () => {
  const led = fakeLedger({ balance: 10 });
  const a = await authorizeProviderCall({ ...AUTH, db: led.db, mode: "enforce" });
  await settleProviderCall({ db: led.db, transaction_id: a.transaction_id, started: false });
  const before = led.balance;
  await settleProviderCall({ db: led.db, transaction_id: a.transaction_id, started: false });
  assertEquals(led.balance, before, "the real RPC returns replayed:true and moves nothing");
});

Deno.test("9. settling without a reservation is a no-op, not a crash", async () => {
  const led = fakeLedger({ balance: 10 });
  const out = await settleProviderCall({ db: led.db, transaction_id: null, started: true });
  assertEquals(out.settled, false);
  assertEquals(out.charged, 0);
  assertEquals(led.calls.length, 0, "no RPC is made for a reservation that does not exist");
});

// ═══ 6. AN UNREACHABLE LEDGER MUST NOT BE A NEW OUTAGE ═════════════════════

Deno.test("10. an RPC error refuses under enforce and permits under observe", async () => {
  const broken = { code: "PGRST301", message: "JWT expired" };
  const enforced = await authorizeProviderCall({
    ...AUTH, db: fakeLedger({ rpcError: broken }).db, mode: "enforce",
  });
  assertEquals(enforced.allowed, false,
    "refusing is the safe direction when 'may we spend?' cannot be answered");
  assertEquals(enforced.reason, "rpc_error");
  assert(enforced.detail!.includes("PGRST301"), enforced.detail!);
  assert(!enforced.detail!.includes("[object Object]"),
    "the defect that kept lead_execution_calls empty must not recur here");

  const observed = await authorizeProviderCall({
    ...AUTH, db: fakeLedger({ rpcError: broken }).db, mode: "observe",
  });
  assertEquals(observed.allowed, true);
});

Deno.test("11. a thrown RPC never throws out of this module", async () => {
  const a = await authorizeProviderCall({
    ...AUTH, db: fakeLedger({ throwOn: "credits_reserve" }).db, mode: "enforce",
  });
  assertEquals(a.allowed, false);
  assertEquals(a.reason, "rpc_error");
  assert(a.detail!.includes("connection reset"));

  const led = fakeLedger({ throwOn: "credits_finalize", balance: 5 });
  const ok = await authorizeProviderCall({ ...AUTH, db: led.db, mode: "enforce" });
  const s = await settleProviderCall({
    db: led.db, transaction_id: ok.transaction_id, started: true,
  });
  assertEquals(s.settled, false, "credits_release_stale is the backstop for this");
});

Deno.test("12. a call with no workspace is never authorised silently", async () => {
  const led = fakeLedger({ balance: 10 });
  const a = await authorizeProviderCall({
    ...AUTH, workspace_id: "", db: led.db, mode: "enforce",
  });
  assertEquals(a.allowed, false);
  assertEquals(a.reason, "not_attempted");
  assertEquals(led.calls.length, 0);
});

// ═══ 7. THE ERROR THE ENGINE BRANCHES ON ══════════════════════════════════

Deno.test("13. the refusal has its own code, distinct from a provider fault", () => {
  assertEquals(CREDIT_REFUSED_ERROR, "credit_authorization_refused");
  // The engine matches on this to take the DEADLINE path — block the company as
  // deferred, checkpoint, spend nothing — rather than recording `provider_error`,
  // which would attach a verdict to a company nobody looked at.
  const src = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url));
  assert(src.includes("CREDIT_REFUSED_ERROR"), "the engine must branch on the code");
  assert(src.includes("credit_exhausted_checkpoint"), "and set a checkpoint reason");
  assert(src.includes('reason: "deferred"'), "reusing the deadline path's own shape");
});

Deno.test("14. describeRpcError never yields [object Object]", () => {
  assert(describeRpcError({ code: "23514", message: "check violation" })
    .includes("23514"));
  assert(!describeRpcError({ weird: true }).includes("[object Object]"));
  assertEquals(describeRpcError("plain"), "plain");
});

Deno.test("15. settlement: an uncertain Apify start is HELD; everything else settles on whether a run exists", () => {
  assertEquals(creditSettlementFor({ ok: true }), { action: "settle", started: true });
  assertEquals(creditSettlementFor({ ok: false, error: "apify_run_failed", data: { run_id: "R1" } }), { action: "settle", started: true });
  assertEquals(creditSettlementFor({ ok: false, error: "apify_start_failed:409" }), { action: "settle", started: false });
  assertEquals(creditSettlementFor({ ok: false, error: CREDIT_REFUSED_ERROR }), { action: "settle", started: false });
  for (const e of ["apify_start_uncertain:0", "apify_start_uncertain:503", "apify_start_uncertain:missing_run_id"]) {
    assertEquals(creditSettlementFor({ ok: false, error: e }), { action: "hold", reason: e });
  }
  // A run id settles it, uncertain or not: the run exists and is charged.
  assertEquals(creditSettlementFor({ ok: false, error: "apify_start_uncertain:503", data: { run_id: "R2" } }), { action: "settle", started: true });
});
