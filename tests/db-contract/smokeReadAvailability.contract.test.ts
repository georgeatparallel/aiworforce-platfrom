// Real admission RPCs/PostgREST; only the count query and vendor are injected.
// This runner grants network to localhost only. Prices are synthetic controls.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { serviceClient, sql } from "./lib/harness.ts";
import { seedSmokeMission } from "./lib/smokeMission.ts";
import {
  type AdmissionDb,
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
const JOBS = "apify:harvestapi~linkedin-job-search";
const opts = { sanitizeOps: false, sanitizeResources: false };
type Failure = "error" | "throw" | "malformed" | "not_awaitable";

async function fixture(failure?: Failure, actorOnly = false) {
  const quotes = structuredClone(proposal.approved_quotes);
  quotes.details.maximum_microusd = 5000;
  for (const q of Object.values(quotes) as Record<string, unknown>[]) {
    Object.assign(q, {
      source: "synthetic local control",
      liability_bound_ref: "fake price, not live approval",
      observed_at: new Date(Date.now() - 1000).toISOString(),
    });
  }
  const m = await seedSmokeMission({
    quotes,
    actorLimits: proposal.actor_limits,
  });
  const real = await serviceClient();
  let admissions = 0;
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === "admit_discovery_smoke") admissions++;
      return real.rpc(fn, args);
    },
    from: (table: string) => ({
      select: (cols: string) => {
        if (
          !failure || table !== "discovery_smoke_operations" ||
          cols !== "operation_key"
        ) return real.from(table).select(cols);
        let actor = false;
        const query = {
          eq: (col: string) => {
            if (col === "actor") actor = true;
            return query;
          },
          then: failure === "not_awaitable" ? undefined : (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => {
            if (actorOnly && !actor) {
              return Promise.resolve({ data: [], error: null }).then(
                resolve,
                reject,
              );
            }
            if (failure === "throw") {
              return Promise.reject(new Error("injected count failure")).then(
                resolve,
                reject,
              );
            }
            return Promise.resolve({
              data: null,
              error: failure === "error"
                ? { message: "injected count failure" }
                : null,
            }).then(resolve, reject);
          },
        };
        return query;
      },
    }),
  } as unknown as AdmissionDb;
  const seen: string[] = [];
  const gate = createAdmissionFetch({
    db,
    ownApi: null,
    log: () => {},
    baseFetch: (u) => {
      seen.push(String(u));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: "fake-run",
              defaultDatasetId: "fake-dataset",
              status: "RUNNING",
            },
          }),
          { status: 201 },
        ),
      );
    },
  });
  const send = () =>
    missionAdmission.run({
      queueId: m.queueId,
      workerId: m.workerId,
      taskId: m.taskId,
      generation: m.generation,
    }, () =>
      gate(
        "https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/runs",
        {
          method: "POST",
          body: JSON.stringify({
            jobTitles: ["Account Executive"],
            locations: ["United States"],
            maxItems: 3,
          }),
        },
      ));
  const operations = () =>
    sql`select * from public.discovery_smoke_operations where authorization_id=${m.authorizationId}`;
  return { send, seen, operations, admissions: () => admissions, m };
}

for (
  const failure of ["error", "throw", "malformed", "not_awaitable"] as const
) {
  Deno.test(
    `read availability: ${failure} refuses a new start before admission or transport`,
    opts,
    async () => {
      const f = await fixture(failure);
      const response = await f.send();
      assertEquals(response.status, 503);
      const { error } = await response.json();
      assertEquals([error.decision, error.detail, error.purchase_may_exist], [
        "read_plan",
        "read_state_unknown",
        true,
      ]);
      assertEquals([
        f.seen.length,
        f.admissions(),
        (await f.operations()).length,
      ], [0, 0, 0]);
    },
  );
}
Deno.test(
  "read availability: actor-specific count failure also refuses with shared count available",
  opts,
  async () => {
    const f = await fixture("error", true);
    const r = await f.send();
    assertEquals(r.status, 503);
    assertEquals(
      [f.seen.length, f.admissions(), (await f.operations()).length],
      [0, 0, 0],
    );
  },
);
Deno.test(
  "read availability: concurrent failed-count attempts buy nothing",
  opts,
  async () => {
    const f = await fixture("error");
    const r = await Promise.all([f.send(), f.send(), f.send()]);
    assertEquals(r.map((x) => x.status), [503, 503, 503]);
    assertEquals(
      [f.seen.length, f.admissions(), (await f.operations()).length],
      [0, 0, 0],
    );
  },
);
Deno.test(
  "read availability: normal concurrent duplicate starts buy exactly once and retain allocation",
  opts,
  async () => {
    const f = await fixture();
    const r = await Promise.all([f.send(), f.send()]);
    assertEquals(r.map((x) => x.status).sort(), [201, 503]);
    assertEquals(f.seen.length, 1);
    const operations = await f.operations();
    assertEquals(operations.length, 1);
    assertEquals([operations[0].actor, operations[0].committed_microusd], [
      JOBS,
      "5000",
    ]);
    const [a] =
      await sql`select provider_polls,approved_quotes->'reads'->'request_limits'->'max_reads_per_actor' as allocation from public.discovery_smoke_authorizations where id=${f.m.authorizationId}`;
    assertEquals(a.provider_polls, 5);
    assertEquals(
      a.allocation,
      proposal.approved_quotes.reads.request_limits.max_reads_per_actor,
    );
  },
);
