// Explicit fresh-project lane: run.sh --cached-only tests/reviews/discoveryTestNoBrain.ts
// Kept out of the shared contract lane: installation intentionally REFUSES any
// database with a pre-existing workspace. Uses real SQL and service-role API.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { serviceClient, sql, uuid } from "../db-contract/lib/harness.ts";
import {
  authorizeSmoke,
  seedSmokeMission,
  syntheticQuotes,
} from "../db-contract/lib/smokeMission.ts";
const guard = Deno.readTextFileSync(
  new URL(
    "../../scripts/test-project/sql/20261017120000_discovery_test_no_company_brain.sql",
    import.meta.url,
  ),
);
await sql.begin(async (tx) => {
  await tx.unsafe(guard);
});
const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test(
  "no-Brain test project: clean workspace authorizes, service-role INSERT/UPSERT cannot create Brain",
  opts,
  async () => {
    const m = await seedSmokeMission();
    assert(m.authorizationId);
    const client = await serviceClient();
    for (
      const write of [() =>
        client.from("company_brain").insert({
          workspace_id: m.ws,
          profile: {},
        }), () =>
        client.from("company_brain").upsert(
          { workspace_id: m.ws, profile: {} },
          { onConflict: "workspace_id" },
        )]
    ) {
      const { error } = await write();
      assert(error);
      assertEquals(error.code, "23514");
      assert(error.message.includes("Company Brain writes are forbidden"));
    }
    const [{ n }] = await sql`select count(*)::int n from public.company_brain`;
    assertEquals(n, 0);
  },
);

Deno.test(
  "no-Brain test project: concurrent Brain attempts and authorization, including repeatable-read snapshot, cannot race",
  opts,
  async () => {
    const m = await seedSmokeMission({ authorize: false });
    // Take the snapshot BEFORE authorization, reproducing the case that can
    // defeat a cross-table advisory-lock + SELECT-only implementation.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oldSnapshot = sql.begin(
      "isolation level repeatable read",
      async (tx) => {
        await tx`select count(*) from public.discovery_smoke_authorizations`;
        started.resolve();
        await release.promise;
        await tx`insert into public.company_brain(workspace_id,profile) values(${m.ws},'{}')`;
      },
    );
    const oldResult = assertRejects(
      () => oldSnapshot,
      Error,
      "Company Brain writes are forbidden",
    );
    await started.promise;
    try {
      await authorizeSmoke(m.queueId);
    } finally {
      release.resolve();
    }
    await oldResult;
    const writes = await Promise.allSettled(
      Array.from(
        { length: 4 },
        () =>
          sql`insert into public.company_brain(workspace_id,profile) values(${m.ws},'{}')`,
      ),
    );
    assertEquals(
      writes.map((x) => x.status),
      Array(4).fill("rejected"),
    );
    const [{ n }] =
      await sql`select count(*)::int n from public.company_brain where workspace_id=${m.ws}`;
    assertEquals(n, 0);
  },
);

Deno.test(
  "no-Brain test project: missing/disabled write guard blocks new authorization",
  opts,
  async () => {
    const m = await seedSmokeMission({ authorize: false });
    await assertRejects(
      () =>
        sql.begin(async (tx) => {
          await tx`alter table public.company_brain disable trigger discovery_test_no_company_brain`;
          await tx`select public.authorize_discovery_smoke(${m.queueId},'synthetic',${
            tx.json(syntheticQuotes() as never)
          }::jsonb,'{}'::jsonb,300)`;
        }),
      Error,
      "no-Brain guard missing, disabled",
    );
  },
);

Deno.test(
  "no-Brain test project: populated workspace blocks authorization even if owner bypassed insertion guard",
  opts,
  async () => {
    const m = await seedSmokeMission({ authorize: false });
    await assertRejects(
      () =>
        sql.begin(async (tx) => {
          await tx`alter table public.company_brain disable trigger discovery_test_no_company_brain`;
          await tx`insert into public.company_brain(workspace_id,profile) values(${m.ws},'{}')`;
          await tx`alter table public.company_brain enable always trigger discovery_test_no_company_brain`;
          await tx`select public.authorize_discovery_smoke(${m.queueId},'synthetic',${
            tx.json(syntheticQuotes() as never)
          }::jsonb,'{}'::jsonb,300)`;
        }),
      Error,
      "workspace has a Company Brain",
    );
  },
);

Deno.test(
  "no-Brain test project: UPDATE/reassignment and replica-mode insertion are blocked; stop does not unlock",
  opts,
  async () => {
    const m = await seedSmokeMission();
    await sql`select public.stop_discovery_smoke(${m.queueId},'test stop')`;
    await assertRejects(
      () =>
        sql`insert into public.company_brain(workspace_id,profile) values(${m.ws},'{}')`,
      Error,
      "Company Brain writes are forbidden",
    );
    await assertRejects(
      () =>
        sql.begin(async (tx) => {
          await tx`set local session_replication_role=replica`;
          await tx`insert into public.company_brain(workspace_id,profile) values(${m.ws},'{}')`;
        }),
      Error,
      "Company Brain writes are forbidden",
    );
    await assertRejects(
      () =>
        sql.begin(async (tx) => {
          await tx`alter table public.company_brain disable trigger discovery_test_no_company_brain`;
          const id = uuid();
          await tx`insert into public.company_brain(id,workspace_id,profile) values(${id},${m.ws},'{}')`;
          await tx`alter table public.company_brain enable always trigger discovery_test_no_company_brain`;
          await tx`update public.company_brain set workspace_id=${m.ws},profile='{"changed":true}' where id=${id}`;
        }),
      Error,
      "Company Brain writes are forbidden",
    );
  },
);

Deno.test(
  "no-Brain test project: worker cannot call guard functions or alter administrative records",
  opts,
  async () => {
    const [p] =
      await sql`select has_function_privilege('service_role','public.discovery_test_refuse_company_brain()','execute') as write_fn,
 has_function_privilege('service_role','public.discovery_test_check_no_brain_authorization()','execute') as auth_fn,
 has_function_privilege('service_role','public.authorize_discovery_smoke(uuid,text,jsonb,jsonb,integer)','execute') as authorize,
 has_function_privilege('service_role','public.reconcile_discovery_smoke_operation(uuid,text,bigint,text,text)','execute') as reconcile,
 has_table_privilege('service_role','public.discovery_smoke_authorizations','insert') as insert_auth`;
    await assertRejects(
      () =>
        sql.begin(async (tx) => {
          await tx`set local role service_role`;
          await tx`alter table public.company_brain disable trigger discovery_test_no_company_brain`;
        }),
      Error,
      "must be owner",
    );
    assertEquals(p, {
      write_fn: false,
      auth_fn: false,
      authorize: false,
      reconcile: false,
      insert_auth: false,
    });
  },
);
Deno.test(
  "no-Brain test project: installer SQL refuses reuse on any populated project",
  opts,
  async () => {
    await assertRejects(
      () =>
        sql.begin(async (tx) => {
          await tx.unsafe(guard);
        }),
      Error,
      "fresh empty test project",
    );
  },
);
