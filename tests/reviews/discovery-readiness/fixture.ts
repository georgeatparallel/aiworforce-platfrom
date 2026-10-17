// Native local-only contract fixtures. Prices and transport responses are synthetic.
import { serviceClient, sql } from "../../db-contract/lib/harness.ts";
import {
  seedSmokeMission,
  type SmokeMission,
} from "../../db-contract/lib/smokeMission.ts";
import {
  type AdmissionDb,
  createAdmissionFetch,
  missionAdmission,
} from "../../../supabase/functions/_shared/smokeAdmission.ts";
export { seedSmokeMission, serviceClient, sql };
export type { SmokeMission };
export const JOBS = "apify:harvestapi~linkedin-job-search";
export const LUNA = "openai:gpt-5.6-luna";
const proposal = JSON.parse(
  Deno.readTextFileSync(
    new URL(
      "../../../docs/launch/proposals/smoke-catalog-two-actor.json",
      import.meta.url,
    ),
  ),
);
export const options = { sanitizeOps: false, sanitizeResources: false };
export const actorLimits = proposal.actor_limits;
export function catalog() {
  const quotes = structuredClone(proposal.approved_quotes);
  delete quotes.details;
  for (const q of Object.values(quotes) as Array<Record<string, unknown>>) {
    Object.assign(q, {
      observed_at: new Date(Date.now() - 1000).toISOString(),
      source: "independent offline control",
      liability_bound_ref: "synthetic local only",
    });
  }
  return quotes;
}
export async function seed(authorize = true) {
  return await seedSmokeMission({ quotes: catalog(), actorLimits, authorize });
}
export async function fixture(m: SmokeMission, db?: AdmissionDb) {
  const seen: Array<{ url: string; body: unknown }> = [];
  const gate = createAdmissionFetch({
    db: db ?? await serviceClient() as unknown as AdmissionDb,
    ownApi: null,
    log: () => {},
    baseFetch: (u, i) => {
      seen.push({ url: String(u), body: JSON.parse(String(i?.body)) });
      return Promise.resolve(
        new Response(
          JSON.stringify(
            String(u).includes("apify")
              ? {
                data: {
                  id: "offline-run",
                  defaultDatasetId: "offline-dataset",
                  status: "RUNNING",
                },
              }
              : {},
          ),
          { status: 200 },
        ),
      );
    },
  });
  const send = (kind: "model" | "provider", signal?: AbortSignal) =>
    missionAdmission.run(
      {
        queueId: m.queueId,
        workerId: m.workerId,
        taskId: m.taskId,
        generation: m.generation,
        signal,
      },
      () =>
        gate(
          kind === "model"
            ? "https://api.openai.com/v1/chat/completions"
            : "https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/runs",
          {
            method: "POST",
            body: JSON.stringify(
              kind === "model"
                ? {
                  model: "gpt-5.6-luna",
                  messages: [{ role: "user", content: "bounded" }],
                  max_completion_tokens: 16,
                }
                : {
                  jobTitles: ["Account Executive"],
                  locations: ["United States"],
                  maxItems: 3,
                },
            ),
          },
        ),
    );
  const operations = () =>
    sql`select * from public.discovery_smoke_operations where authorization_id=${m.authorizationId}`;
  return { gate, send, seen, operations };
}
export async function waitForLock(tx: typeof sql, minimum = 1) {
  for (let i = 0; i < 250; i++) {
    await tx`select pg_stat_clear_snapshot()`;
    const [{ count }] =
      await tx`select count(*)::int from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()`;
    if (count >= minimum) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("controlled admission did not reach its database lock");
}
export const lock = (tx: typeof sql) =>
  tx`select pg_advisory_xact_lock(hashtext('agentory.discovery_smoke.liability'))`;
