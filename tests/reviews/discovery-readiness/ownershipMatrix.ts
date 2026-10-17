// Explicit review runner; never contacts a paid provider.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fixture, lock, options, seed, sql, waitForLock } from "./fixture.ts";
for (const which of ["queue", "lineage"] as const) {
  for (const kind of ["model", "provider"] as const) {
    Deno.test(
      `independent ownership: ${kind}, ${which} alone expires during final lock wait`,
      options,
      async () => {
        const m = await seed();
        const f = await fixture(m);
        const [r] = which === "queue"
          ? await sql`update public.lead_mission_queue set lease_expires_at=clock_timestamp()+interval '2 seconds' where id=${m.queueId} returning lease_expires_at as expiry`
          : await sql`update public.lead_lineages set lease_expires_at=clock_timestamp()+interval '2 seconds' where lineage_id=${m.taskId} returning lease_expires_at as expiry`;
        let pending: Promise<Response>;
        await sql.begin(async (tx) => {
          await lock(tx as typeof sql);
          pending = f.send(kind);
          await waitForLock(tx as typeof sql);
          await tx`select pg_sleep(greatest(0, extract(epoch from ${r.expiry}::timestamptz-clock_timestamp()))::double precision+0.1)`;
        });
        const response = await pending!;
        const body = await response.json();
        assertEquals(body.error.decision, "lost_ownership");
        assertEquals(f.seen.length, 0);
        assertEquals((await f.operations()).length, 0);
      },
    );
  }
}
Deno.test(
  "independent ownership: valid concurrent paid admissions and duplicate deliveries retain every cap",
  options,
  async () => {
    const m = await seed();
    const f = await fixture(m);
    let pending: Promise<Response>[] = [];
    await sql.begin(async (tx) => {
      await lock(tx as typeof sql);
      pending = [
        ...Array.from({ length: 6 }, () => f.send("model")),
        ...Array.from({ length: 3 }, () => f.send("provider")),
      ];
      await waitForLock(tx as typeof sql);
    });
    const responses = await Promise.all(pending);
    await Promise.all(responses.map((r) => r.body?.cancel()));
    const ops = await f.operations();
    const models = ops.filter((o) => o.kind === "model"),
      providers = ops.filter((o) => o.kind === "provider");
    assertEquals(models.length, 4);
    assertEquals(providers.length, 1);
    assertEquals(f.seen.length, 5);
    assertEquals(
      models.reduce((n, o) => n + Number(o.committed_microusd), 0),
      49920,
    );
    assertEquals(providers[0].committed_microusd, "5000");
  },
);
Deno.test(
  "independent ownership: concurrent expired owners dispatch zero paid requests",
  options,
  async () => {
    const a = await seed(), b = await seed();
    const fs = await Promise.all([fixture(a), fixture(b)]);
    for (const m of [a, b]) {
      await sql`update public.lead_mission_queue set lease_expires_at=clock_timestamp()+interval '2 seconds' where id=${m.queueId}`;
      await sql`update public.lead_lineages set lease_expires_at=clock_timestamp()+interval '2 seconds' where lineage_id=${m.taskId}`;
    }
    let pending: Promise<Response>[] = [];
    await sql.begin(async (tx) => {
      await lock(tx as typeof sql);
      pending = fs.flatMap((f) => [f.send("model"), f.send("provider")]);
      await waitForLock(tx as typeof sql);
      await tx`select pg_sleep(2.2)`;
    });
    for (const response of await Promise.all(pending)) {
      const body = await response.json();
      assertEquals(body.error.decision, "lost_ownership");
    }
    for (const f of fs) {
      assertEquals(f.seen.length, 0);
      assertEquals((await f.operations()).length, 0);
    }
  },
);
for (const kind of ["model", "provider"] as const) {
  Deno.test(
    `independent ownership: cancellation signal during ${kind} admission prevents transport`,
    options,
    async () => {
      const m = await seed();
      const f = await fixture(m);
      const ctl = new AbortController();
      let pending: Promise<Response>;
      await sql.begin(async (tx) => {
        await lock(tx as typeof sql);
        pending = f.send(kind, ctl.signal);
        await waitForLock(tx as typeof sql);
        ctl.abort("cancelled");
      });
      const response = await pending!;
      const body = await response.json();
      assertEquals(body.error.decision, "revoked_after_admission");
      assertEquals(f.seen.length, 0);
      const ops = await f.operations();
      assertEquals(
        ops.length,
        1,
        "a committed admission is never refunded by cancellation",
      );
    },
  );
}
for (const why of ["cancelled", "expired"] as const) {
  for (const kind of ["model", "provider"] as const) {
    Deno.test(
      `independent ownership: ${why} mission sends no ${kind}`,
      options,
      async () => {
        const m = await seed();
        const f = await fixture(m);
        if (
          why === "cancelled"
        ) {
          await sql`update public.lead_mission_queue set status='cancelled' where id=${m.queueId}`;
        } else {
          await sql`with c as (select clock_timestamp() as t) update public.discovery_smoke_authorizations set authorized_at=c.t-interval '301 seconds', deadline_at=c.t-interval '1 second' from c where id=${m.authorizationId}`;
        }
        const response = await f.send(kind);
        assert(response.status !== 200);
        await response.body?.cancel();
        assertEquals(f.seen.length, 0);
        assertEquals((await f.operations()).length, 0);
      },
    );
  }
}
for (const which of ["queue", "lineage", "generation"] as const) {
  Deno.test(
    `independent ownership: ${which} ownership cannot change during global-lock wait; later dispatch refuses`,
    options,
    async () => {
      const m = await seed();
      const f = await fixture(m);
      let pending: Promise<Response>;
      const change = which === "queue"
        ? `update public.lead_mission_queue set claimed_by=gen_random_uuid() where id='${m.queueId}'`
        : which === "lineage"
        ? `update public.lead_lineages set lease_holder=gen_random_uuid() where lineage_id='${m.taskId}'`
        : `update public.tasks set checkpoint_version=checkpoint_version+1 where id='${m.taskId}'`;
      await sql.begin(async (tx) => {
        await lock(tx as typeof sql);
        pending = f.send("model");
        await waitForLock(tx as typeof sql);
        // The second direct connection must wait on the admission's shared row lock.
        await assertRejects(
          () =>
            sql.begin(async (mutation) => {
              await mutation`set local lock_timeout='200ms'`;
              await mutation.unsafe(change);
            }),
          Error,
          "lock timeout",
        );
      });
      const first = await pending!;
      assertEquals(first.status, 200);
      await first.body?.cancel();
      assertEquals(f.seen.length, 1);
      await sql.unsafe(change);
      const second = await f.send("model");
      const body = await second.json();
      assertEquals(
        body.error.decision,
        which === "generation" ? "stale_generation" : "lost_ownership",
      );
      assertEquals(f.seen.length, 1);
      assertEquals((await f.operations()).length, 1);
    },
  );
}
