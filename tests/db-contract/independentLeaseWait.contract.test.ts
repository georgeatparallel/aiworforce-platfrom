import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { serviceClient, sql } from "./lib/harness.ts";
import { seedSmokeMission } from "./lib/smokeMission.ts";
import {
  createAdmissionFetch,
  missionAdmission,
} from "../../supabase/functions/_shared/smokeAdmission.ts";
const proposal = JSON.parse(
  Deno.readTextFileSync(
    new URL(
      "../../docs/launch/proposals/smoke-catalog-two-actor.json",
      import.meta.url,
    ),
  ),
);
for (const kind of ["model", "provider"]) {
  Deno.test({
    name:
      `independent: ${kind} transport must be fenced when leases expire during global liability lock wait`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const quotes = structuredClone(proposal.approved_quotes);
      delete quotes.details;
      for (const q of Object.values(quotes) as Array<Record<string, unknown>>) {
        q.observed_at = new Date(Date.now() - 1000).toISOString();
        q.source = "synthetic offline independent control";
        q.liability_bound_ref = "offline only, no vendor traffic";
      }
      const m = await seedSmokeMission({
        quotes,
        actorLimits: proposal.actor_limits,
      });
      const db = await serviceClient();
      const [expires] =
        await sql`with c as (select clock_timestamp()+interval '2 seconds' as expiry), q as (update public.lead_mission_queue set lease_expires_at=c.expiry from c where id=${m.queueId}) update public.lead_lineages set lease_expires_at=c.expiry from c where lineage_id=${m.taskId} returning c.expiry`;
      let transport = 0;
      let sentAt: number | null = null;
      let response: Promise<Response> | null = null;
      const gate = createAdmissionFetch({
        db: db as never,
        ownApi: null,
        baseFetch: () => {
          transport++;
          sentAt = Date.now();
          return Promise.resolve(
            new Response(
              JSON.stringify(
                kind === "provider"
                  ? {
                    data: {
                      id: "offline-expired-lease-run",
                      status: "RUNNING",
                    },
                  }
                  : {},
              ),
              { status: kind === "provider" ? 201 : 200 },
            ),
          );
        },
        log: () => {},
      });
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('agentory.discovery_smoke.liability'))`;
        const url = kind === "model"
          ? "https://api.openai.com/v1/chat/completions"
          : "https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/runs";
        const body = kind === "model"
          ? {
            model: "gpt-5.6-luna",
            messages: [{ role: "user", content: "bounded" }],
            max_completion_tokens: 16,
          }
          : {
            maxItems: 3,
            jobTitles: ["Account Executive"],
            locations: ["United States"],
          };
        response = missionAdmission.run({
          queueId: m.queueId,
          workerId: m.workerId,
          taskId: m.taskId,
          generation: m.generation,
        }, () => gate(url, { method: "POST", body: JSON.stringify(body) }));
        let blocked = false;
        for (let i = 0; i < 150; i++) {
          await tx`select pg_stat_clear_snapshot()`;
          const r =
            await tx`select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory'`;
          if (r.length) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        assert(blocked, "admission reached global lock with live leases");
        await tx`select pg_sleep(greatest(0,extract(epoch from ${expires.expiry}::timestamptz-clock_timestamp()))::double precision+0.1)`;
      });
      const res = await response!;
      const result = await res.json();
      const ops =
        await sql`select kind,committed_microusd from public.discovery_smoke_operations where authorization_id=${m.authorizationId}`;
      console.log(
        "LEASE_WAIT_REPRO",
        JSON.stringify({
          kind,
          lease_expiry: expires.expiry,
          sent_at: sentAt === null ? null : new Date(sentAt).toISOString(),
          http_status: res.status,
          transport,
          result,
          operations: ops,
        }),
      );
      assertEquals(
        transport,
        0,
        "lease expiry during the global lock wait must not send",
      );
    },
  });
}
