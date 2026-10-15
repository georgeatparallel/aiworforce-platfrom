import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type postgres from "npm:postgres@3.4.5";
import { ADMIT, quote, request, UP } from "./smokeBudgetHarness.ts";
import { nativeUrl, openNative } from "./nativeSmokeHarness.ts";
async function dollarRace(sql: string) {
  const h = await openNative(sql);
  let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
  try {
    await h.a.begin(async (tx) => {
      await tx.unsafe(
        `select id from ${h.schema}.discovery_smoke_authorizations where id=$1 for update`,
        [h.id],
      );
      pending = h.b.unsafe(
        h.rewrite(ADMIT),
        h.params(
          request(h.id, "b", {
            kind: "model",
            actor: "model",
            amount: 30000,
            quote: quote(30000),
          }),
        ),
      ).then((rows) => rows);
      await h.blocked();
      assertEquals(
        (await tx.unsafe(
          h.rewrite(ADMIT),
          h.params(
            request(h.id, "a", {
              kind: "model",
              actor: "model",
              amount: 30000,
              quote: quote(30000),
            }),
          ),
        ))[0].result.decision,
        "admitted",
      );
    });
    assertEquals((await pending!)[0].result.decision, "usd_limit");
  } finally {
    if (pending) await pending.catch(() => {});
    await h.cleanup();
  }
}
async function deadlineRace(sql: string) {
  const h = await openNative(sql);
  let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
  try {
    await h.a.begin(async (tx) => {
      await tx.unsafe(
        `with c as(select clock_timestamp() as t) update ${h.schema}.discovery_smoke_authorizations
        set authorized_at=c.t-interval '299 seconds',deadline_at=c.t+interval '1 second' from c where id=$1`,
        [h.id],
      );
      pending = h.b.unsafe(h.rewrite(ADMIT), h.params(request(h.id, "late")))
        .then((rows) => rows);
      await h.blocked();
      await tx.unsafe(
        `select pg_sleep(greatest(0,extract(epoch from deadline_at-clock_timestamp()))::double precision+0.02)
        from ${h.schema}.discovery_smoke_authorizations where id=$1`,
        [h.id],
      );
    });
    assertEquals((await pending!)[0].result.decision, "stopped");
  } finally {
    if (pending) await pending.catch(() => {});
    await h.cleanup();
  }
}
Deno.test({
  name:
    "native mutation killed: removing admission row lock breaks real contention invariant",
  ignore: !nativeUrl,
  fn: async () => {
    const anchor = "where id = p_authorization for update;";
    assert(UP.includes(anchor));
    await dollarRace(UP);
    await assertRejects(
      () => dollarRace(UP.replace(anchor, "where id = p_authorization;")),
      Error,
      "Values are not equal",
    );
  },
});
Deno.test({
  name:
    "native mutation killed: transaction-start now() admits work after lock-wait deadline",
  ignore: !nativeUrl,
  fn: async () => {
    const anchor = "v_now := clock_timestamp();";
    assert(UP.includes(anchor));
    await deadlineRace(UP);
    await assertRejects(
      () => deadlineRace(UP.replace(anchor, "v_now := now();")),
      Error,
      "Values are not equal",
    );
  },
});
