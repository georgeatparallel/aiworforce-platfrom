// Synthetic SQL fixtures only. No production captures, credentials or provider calls.
export const ROOT = new URL("../../", import.meta.url);
export const UP = await Deno.readTextFile(
  new URL("docs/launch/proposals/smoke-budget/0001.up.sql", ROOT),
);
export const DOWN = await Deno.readTextFile(
  new URL("docs/launch/proposals/smoke-budget/0001.down.sql", ROOT),
);
export const WS = "11111111-1111-4111-8111-111111111111";
export const LINEAGE = "22222222-2222-4222-8222-222222222222";
export const TASK = "33333333-3333-4333-8333-333333333333";
export const HASH = "a".repeat(64);
export const ACTOR = "apify_linkedin_job_search";
export const PRELUDE = `
  do $$ begin
    if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  end $$;
  create table public.workspaces(id uuid primary key);
  create table public.lead_lineages(lineage_id uuid primary key, workspace_id uuid, mission_hash text,
    status text, lease_holder uuid, lease_expires_at timestamptz);
  create table public.tasks(id uuid primary key, workspace_id uuid, lineage_id uuid,
    checkpoint_version integer, status text);
  insert into public.workspaces values('${WS}');
  insert into public.lead_lineages values('${LINEAGE}','${WS}','${HASH}','active','${TASK}',clock_timestamp()+interval '1 hour');
  insert into public.tasks values('${TASK}','${WS}','${LINEAGE}',1,'running');
`;
// All entries below are synthetic controls, intentionally NOT real prices.
const OBSERVED = new Date(Date.now() - 1000).toISOString();
export function quote(amount: number, changes: Record<string, unknown> = {}) {
  return {
    currency: "USD",
    pricing_version: "synthetic-v1",
    basis: "verified_upper_bound",
    template_id: "control-" + amount,
    request_limits_hash: "b".repeat(64),
    source: "synthetic control; not a vendor quote",
    liability_bound_ref: "synthetic bound",
    maximum_microusd: String(amount),
    observed_at: OBSERVED,
    ...changes,
  };
}
export const APPROVED_QUOTES = Object.fromEntries(
  [0, 1, 10000, 10001, 20000, 30000, 50000, 50001, 200000, 200001].map(
    (amount) => {
      const q = quote(amount);
      return [q.template_id, {
        ...q,
        requires_page: false,
        allowed_kinds: ["provider", "model", "page", "poll"],
        allowed_actors: [
          ACTOR,
          "apify_linkedin_company_details",
          "firecrawl_map",
          "firecrawl_scrape",
          "model",
          "priced-model",
          "m",
        ],
      }];
    },
  ),
);
APPROVED_QUOTES["discovery-control"] = {
  ...APPROVED_QUOTES["control-10000"],
  requires_page: true,
};
export interface Request {
  authorization: string;
  workspace: string;
  task: string;
  generation: number;
  criteria: string;
  key: string;
  kind: string;
  actor: string;
  payload: string;
  amount: number | null;
  quote: Record<string, unknown> | null;
  parent: string | null;
}
export function request(
  authorization: string,
  key: string,
  over: Partial<Request> = {},
): Request {
  const hash = Array.from(new TextEncoder().encode(key)).reduce(
    (a, b) => (a * 31 + b) >>> 0,
    0,
  );
  return {
    authorization,
    workspace: WS,
    task: TASK,
    generation: 1,
    criteria: HASH,
    key,
    kind: "provider",
    actor: ACTOR,
    payload: hash.toString(16).padStart(64, "0"),
    amount: 10000,
    quote: quote(10000),
    parent: null,
    ...over,
  };
}
export const ADMIT =
  "select public.admit_discovery_smoke($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as result";
export const args = (
  r: Request,
) => [
  r.authorization,
  r.workspace,
  r.task,
  r.generation,
  r.criteria,
  r.key,
  r.kind,
  r.actor,
  r.payload,
  r.amount,
  r.quote,
  r.parent,
];
export interface Decision {
  decision: string;
  operation_key?: string;
  reservation_token?: string;
  provider_run_id?: string;
}
