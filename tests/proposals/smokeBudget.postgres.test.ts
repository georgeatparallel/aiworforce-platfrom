// Optional REAL multi-session proof on an existing, explicitly supplied scratch
// contract database. Never provisions a server, loads repo migrations or uses a
// hosted URL. PGlite's serialized-request proof cannot replace these tests.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import postgres from "npm:postgres@3.4.5";
import {
  ADMIT,
  APPROVED_QUOTES,
  args,
  HASH,
  LINEAGE,
  PRELUDE,
  quote,
  type Request,
  request,
  UP,
  WS,
} from "./smokeBudgetHarness.ts";
const url = Deno.env.get("SMOKE_PROPOSAL_PG_URL");
if (url) {
  const u = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    !/^\/contract_[a-z0-9_]+$/.test(u.pathname)
  ) {
    throw new Error(
      "SMOKE_PROPOSAL_PG_URL must name an existing localhost contract_* scratch database",
    );
  }
}
async function open() {
  const schema = "smoke_" + crypto.randomUUID().replaceAll("-", "");
  const rewrite = (sql: string) =>
    sql.replaceAll("public.", schema + ".").replaceAll(
      "pg_catalog, public",
      `pg_catalog, ${schema}`,
    );
  const options = {
    max: 1,
    onnotice: () => {},
    connect_timeout: 3,
    idle_timeout: 2,
  };
  const admin = postgres(url!, options);
  const a = postgres(url!, {
    ...options,
    connection: { application_name: schema + "_a" },
  });
  const b = postgres(url!, {
    ...options,
    connection: { application_name: schema + "_b" },
  });
  await admin.unsafe(`create schema ${schema}`);
  try {
    // Reuse the contract lane roles; never create cluster-global roles here.
    await admin.unsafe(
      rewrite(PRELUDE.slice(PRELUDE.indexOf("create table public.workspaces"))),
    );
    await admin.unsafe(rewrite(UP));
  } catch (e) {
    await admin.unsafe("rollback");
    await admin.unsafe(`drop schema ${schema} cascade`);
    await Promise.all([admin.end(), a.end(), b.end()]);
    throw e;
  }
  const [row] = await admin.unsafe(
    `select ${schema}.authorize_discovery_smoke($1,$2,$3,$4,$5) as id`,
    [WS, LINEAGE, HASH, "synthetic-v1", JSON.stringify(APPROVED_QUOTES)],
  );
  const params = (r: Request) =>
    args(r).map((v) =>
      v !== null && typeof v === "object" ? JSON.stringify(v) : v
    );
  async function blocked() {
    const until = performance.now() + 3000;
    while (performance.now() < until) {
      const rows =
        await admin`select wait_event_type from pg_stat_activity where application_name=${
          schema + "_b"
        }`;
      if (rows.some((r) => r.wait_event_type === "Lock")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("second session did not block on the admission row lock");
  }
  const cleanup = async () => {
    await Promise.all([a.end(), b.end()]);
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
  };
  return {
    admin,
    a,
    b,
    schema,
    rewrite,
    params,
    blocked,
    cleanup,
    id: String(row.id),
  };
}
Deno.test({
  name:
    "proposal native Postgres: simultaneous sessions cannot share last model dollars",
  ignore: !url,
  fn: async () => {
    const h = await open();
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
  ignore: !url,
  fn: async () => {
    const h = await open();
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
  ignore: !url,
  fn: async () => {
    const h = await open();
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
