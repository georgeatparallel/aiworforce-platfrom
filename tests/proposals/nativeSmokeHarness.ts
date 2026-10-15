// Optional REAL multi-session proof on an existing, explicitly supplied scratch
// contract database. Never provisions a server, loads repo migrations or uses a
// hosted URL. PGlite's serialized-request proof cannot replace these tests.
import postgres from "npm:postgres@3.4.5";
import {
  APPROVED_QUOTES,
  args,
  HASH,
  LINEAGE,
  PRELUDE,
  type Request,
  UP,
  WS,
} from "./smokeBudgetHarness.ts";
export const nativeUrl = Deno.env.get("SMOKE_PROPOSAL_PG_URL");
if (nativeUrl) {
  const u = new URL(nativeUrl);
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
export async function openNative(sql = UP) {
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
    connection: { statement_timeout: 5000 },
    idle_timeout: 2,
  };
  const admin = postgres(nativeUrl!, options);
  const a = postgres(nativeUrl!, {
    ...options,
    connection: { statement_timeout: 5000, application_name: schema + "_a" },
  });
  const b = postgres(nativeUrl!, {
    ...options,
    connection: { statement_timeout: 5000, application_name: schema + "_b" },
  });
  await admin.unsafe(`create schema ${schema}`);
  try {
    // Reuse the contract lane roles; never create cluster-global roles here.
    await admin.unsafe(
      rewrite(PRELUDE.slice(PRELUDE.indexOf("create table public.workspaces"))),
    );
    await admin.unsafe(rewrite(sql));
  } catch (e) {
    await admin.unsafe("rollback");
    await admin.unsafe(`drop schema ${schema} cascade`);
    await Promise.all([admin.end(), a.end(), b.end()]);
    throw e;
  }
  let row: postgres.Row;
  try {
    [row] = await admin.unsafe(
      `select ${schema}.authorize_discovery_smoke($1,$2,$3,$4,$5) as id`,
      [WS, LINEAGE, HASH, "synthetic-v1", admin.json(APPROVED_QUOTES)],
    );
  } catch (e) {
    await admin.unsafe(`drop schema ${schema} cascade`);
    await Promise.all([admin.end(), a.end(), b.end()]);
    throw e;
  }
  const params = (r: Request) =>
    args(r).map((v) =>
      v !== null && typeof v === "object"
        ? admin.json(v as postgres.JSONValue)
        : v
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
