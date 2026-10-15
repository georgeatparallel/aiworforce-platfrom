import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type postgres from "npm:postgres@3.4.5";
import { ADMIT, quote, request } from "./smokeBudgetHarness.ts";
import { nativeUrl, openNative } from "./nativeSmokeHarness.ts";
Deno.test({
  name:
    "proposal native Postgres: simultaneous sessions cannot share last model dollars",
  ignore: !nativeUrl,
  fn: async () => {
    const h = await openNative();
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
            request(h.id, "worker-b", {
              kind: "model",
              actor: "model",
              amount: 30000,
              quote: quote(30000),
            }),
          ),
        ).then((rows) => rows);
        await h.blocked();
        const [r] = await tx.unsafe(
          h.rewrite(ADMIT),
          h.params(
            request(h.id, "worker-a", {
              kind: "model",
              actor: "model",
              amount: 30000,
              quote: quote(30000),
            }),
          ),
        );
        assertEquals(r.result.decision, "admitted");
      });
      assertEquals((await pending!)[0].result.decision, "usd_limit");
    } finally {
      if (pending) await pending.catch(() => {});
      await h.cleanup();
    }
  },
});
Deno.test({
  name:
    "proposal native Postgres: duplicate concurrent purchase admits once, never held-by-self rebuy",
  ignore: !nativeUrl,
  fn: async () => {
    const h = await openNative();
    let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
    try {
      const r = request(h.id, "same-purchase");
      await h.a.begin(async (tx) => {
        assertEquals(
          (await tx.unsafe(h.rewrite(ADMIT), h.params(r)))[0].result.decision,
          "admitted",
        );
        pending = h.b.unsafe(h.rewrite(ADMIT), h.params(r)).then((rows) =>
          rows
        );
        await h.blocked();
      });
      assertEquals((await pending!)[0].result.decision, "uncertain");
      assertEquals(
        (await h.admin.unsafe(
          `select count(*)::int as n from ${h.schema}.discovery_smoke_operations`,
        ))[0].n,
        1,
      );
    } finally {
      if (pending) await pending.catch(() => {});
      await h.cleanup();
    }
  },
});
Deno.test({
  name:
    "proposal native Postgres: waiting admission uses deadline after lock wait, not transaction start",
  ignore: !nativeUrl,
  fn: async () => {
    const h = await openNative();
    let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
    try {
      await h.a.begin(async (tx) => {
        await tx.unsafe(
          `with c as (select clock_timestamp() as t) update ${h.schema}.discovery_smoke_authorizations
        set authorized_at=c.t-interval '299 seconds', deadline_at=c.t+interval '1 second' from c where id=$1`,
          [h.id],
        );
        pending = h.b.unsafe(
          h.rewrite(ADMIT),
          h.params(request(h.id, "late-worker")),
        ).then((rows) => rows);
        await h.blocked();
        // Wait on the DATABASE clock, still holding the authorization row.
        const [r] = await tx.unsafe(
          `select pg_sleep(greatest(0,extract(epoch from deadline_at-clock_timestamp()))::double precision+0.02)
        from ${h.schema}.discovery_smoke_authorizations where id=$1`,
          [h.id],
        );
        assert(r);
      });
      assertEquals((await pending!)[0].result.decision, "stopped");
    } finally {
      if (pending) await pending.catch(() => {});
      await h.cleanup();
    }
  },
});
