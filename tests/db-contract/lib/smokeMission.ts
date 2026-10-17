// A bound, authorized smoke mission in the contract database: a queue row this
// worker holds, the one task bound to it at a known generation, the lineage
// leased to that task, and an administrator's authorization over all of it.
// Every price and limit here is a SYNTHETIC control, not a vendor quote.
import { seedLineage, seedTask, seedWorkspace, sql, uuid } from "./harness.ts";

export const JOBS = "apify:curious_coder~linkedin-jobs-scraper";
export const DETAILS = "apify:harvestapi~linkedin-company";
export const SCRAPE = "firecrawl:scrape";
export const MAP = "firecrawl:map";
export const GPT = "openai:gpt-4.1-mini";
export const CLAUDE = "anthropic:claude-sonnet-4-5";

const observed = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const evidence = { source: "synthetic contract control", liability_bound_ref: "tests/db-contract (not a vendor quote)" };

/** The synthetic catalog: maxima chosen so each cap is reachable in a test. */
export function syntheticQuotes(over: Record<string, unknown> = {}): Record<string, unknown> {
  const at = observed();
  return {
    apify_jobs: {
      allowed_kinds: ["provider"], allowed_actors: [JOBS], maximum_microusd: 60000, discovery_page: true,
      observed_at: at, ...evidence,
      request_limits: { max_request_bytes: 4096, pin_query: { timeout: "120", memory: "1024", maxItems: "50" } },
    },
    apify_details: {
      allowed_kinds: ["provider"], allowed_actors: [DETAILS], maximum_microusd: 40000,
      observed_at: at, ...evidence,
      request_limits: { max_request_bytes: 4096, pin_query: { timeout: "120", maxItems: "10" } },
    },
    fc_scrape: {
      allowed_kinds: ["provider"], allowed_actors: [SCRAPE], maximum_microusd: 10000, observed_at: at, ...evidence,
      request_limits: { max_request_bytes: 2048, pin_body: { proxy: "basic" }, allowed_values: { formats: ["markdown", "summary"] } },
    },
    fc_map: {
      allowed_kinds: ["provider"], allowed_actors: [MAP], maximum_microusd: 10000, observed_at: at, ...evidence,
      request_limits: { max_request_bytes: 1024, max_fields: { limit: 120 } },
    },
    polls: {
      allowed_kinds: ["poll"], allowed_actors: [JOBS, DETAILS, "firecrawl:crawl"], maximum_microusd: 0, observed_at: at, ...evidence,
      request_limits: {},
    },
    gpt: {
      allowed_kinds: ["model"], allowed_actors: [GPT], maximum_microusd: 12000, observed_at: at, ...evidence,
      request_limits: { max_request_bytes: 20000, max_output_tokens: 1000 },
    },
    claude: {
      allowed_kinds: ["model"], allowed_actors: [CLAUDE], maximum_microusd: 12000, observed_at: at, ...evidence,
      request_limits: { max_request_bytes: 20000, max_output_tokens: 1000 },
    },
    ...over,
  };
}

export const syntheticActorLimits = { [JOBS]: 2, [DETAILS]: 1, [SCRAPE]: 1, [MAP]: 1 };

export interface SmokeMission {
  ws: string; queueId: string; taskId: string; workerId: string; generation: number; authorizationId: string | null;
}

/** Seed the mission. `ageSeconds` backdates the queue row (the deadline runs from it). */
export async function seedSmokeMission(o: {
  ageSeconds?: number; windowSeconds?: number; authorize?: boolean; quotes?: Record<string, unknown>; keepPriorLiability?: boolean;
  actorLimits?: Record<string, number>; generation?: number;
} = {}): Promise<SmokeMission> {
  const ws = await seedWorkspace();
  const taskId = uuid();
  const workerId = uuid();
  const generation = o.generation ?? 3;
  await seedLineage(ws, { lineage_id: taskId, status: "running" });
  await seedTask(ws, { id: taskId, status: "running", checkpoint_version: generation, lineage_id: taskId });
  await sql`update public.lead_lineages set lease_holder = ${taskId}, lease_expires_at = now() + interval '3 minutes'
            where lineage_id = ${taskId}`;
  const queueId = uuid();
  await sql`insert into public.lead_mission_queue (id, workspace_id, request, status, claimed_by, lease_expires_at, task_id, lineage_id, created_at)
            values (${queueId}, ${ws}, ${sql.json({ agent_slug: "lead-sourcer", instruction: "smoke", lead_count: 3 })}, 'running',
                    ${workerId}, now() + interval '3 minutes', ${taskId}, ${taskId},
                    now() - make_interval(secs => ${o.ageSeconds ?? 0}))`;
  let authorizationId: string | null = null;
  if (o.authorize !== false) authorizationId = await authorizeSmoke(queueId, o);
  return { ws, queueId, taskId, workerId, generation, authorizationId };
}

/**
 * Phase 7, as the operator performs it: every earlier provider purchase is
 * reconciled against the vendor's record before another smoke may be
 * authorized (a worker-written receipt label settles nothing). These contract tests share one database, so the
 * helper does it for the tests that are not about it; the rule itself is
 * pinned in smokeAdmission.contract.test.ts ("reconciliation").
 */
export async function reconcilePriorLiability(): Promise<number> {
  const open = await sql`select a.queue_id, o.operation_key, o.committed_microusd
    from public.discovery_smoke_operations o
    join public.discovery_smoke_authorizations a on a.id = o.authorization_id
   where o.kind = 'provider'
     and not exists (select 1 from public.discovery_smoke_reconciliations r
                      where r.authorization_id = o.authorization_id and r.operation_key = o.operation_key)`;
  for (const o of open) {
    // A live authorization cannot be reconciled: the operator stops the finished mission first.
    await sql`select public.stop_discovery_smoke(${o.queue_id}, 'contract test: the mission is over')`;
    await sql`select public.reconcile_discovery_smoke_operation(${o.queue_id}, ${o.operation_key},
      ${o.committed_microusd}, 'synthetic contract control: vendor run history', 'SUCCEEDED')`;
  }
  return open.length;
}

/** The administrator's call (the superuser connection; never the worker's role). */
export async function authorizeSmoke(queueId: string, o: {
  quotes?: Record<string, unknown>; actorLimits?: Record<string, number>; windowSeconds?: number;
  /** Leave earlier liability unreconciled (the test of the refusal itself). */
  keepPriorLiability?: boolean;
} = {}): Promise<string> {
  if (!o.keepPriorLiability) await reconcilePriorLiability();
  const [r] = await sql`select public.authorize_discovery_smoke(${queueId}, 'synthetic-v1',
    ${sql.json((o.quotes ?? syntheticQuotes()) as never)}, ${sql.json((o.actorLimits ?? syntheticActorLimits) as never)},
    ${o.windowSeconds ?? 300}) as id`;
  return r.id as string;
}

export const hex = (c: string) => c.repeat(64).slice(0, 64);
