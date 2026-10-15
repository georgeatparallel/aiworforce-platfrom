-- PROPOSAL ONLY. Outside all migration/bootstrap directories; never auto-applied.
-- Fixed first-smoke authorization, not a new credit policy. USD uses integer micros.
-- Tests load this text only into disposable offline databases. Runtime is NOT wired.
create table public.discovery_smoke_authorizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  lineage_id uuid not null references public.lead_lineages(lineage_id),
  criteria_hash text not null,
  pricing_version text not null check (length(trim(pricing_version)) > 0),
  approved_quotes jsonb not null check (jsonb_typeof(approved_quotes) = 'object' and approved_quotes <> '{}'::jsonb),
  authorized_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null,
  status text not null default 'active' check (status in ('active','cancelled','closed')),
  total_microusd bigint not null default 250000 check (total_microusd between 0 and 250000),
  provider_microusd bigint not null default 200000 check (provider_microusd between 0 and 200000),
  model_microusd bigint not null default 50000 check (model_microusd between 0 and 50000),
  provider_purchases integer not null default 5 check (provider_purchases between 0 and 5),
  model_attempts integer not null default 4 check (model_attempts between 0 and 4),
  discovery_pages integer not null default 1 check (discovery_pages between 0 and 1),
  provider_polls integer not null default 5 check (provider_polls between 0 and 5),
  actor_limits jsonb not null default '{"apify_linkedin_job_search":2,"apify_linkedin_company_details":1,"firecrawl_map":1,"firecrawl_scrape":1}',
  unique (workspace_id, lineage_id),
  check (deadline_at = authorized_at + interval '5 minutes')
);

create table public.discovery_smoke_operations (
  authorization_id uuid not null references public.discovery_smoke_authorizations(id),
  operation_key text not null check (length(trim(operation_key)) > 0),
  reservation_token uuid not null default gen_random_uuid(),
  task_id uuid not null references public.tasks(id),
  generation integer not null,
  kind text not null check (kind in ('provider','model','page','poll')),
  actor text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  parent_key text,
  committed_microusd bigint not null check (committed_microusd >= 0),
  quote jsonb not null,
  admitted_at timestamptz not null default clock_timestamp(),
  provider_run_id text,
  actual_microusd bigint check (actual_microusd >= 0),
  receipt jsonb,
  primary key (authorization_id, operation_key),
  foreign key (authorization_id, parent_key)
    references public.discovery_smoke_operations(authorization_id, operation_key)
);
-- Re-keying an identical provider payload is not a fresh purchase permission.
create unique index discovery_smoke_provider_payload on public.discovery_smoke_operations
  (authorization_id, actor, payload_hash) where kind = 'provider';

alter table public.discovery_smoke_authorizations enable row level security;
alter table public.discovery_smoke_operations enable row level security;
revoke all on public.discovery_smoke_authorizations, public.discovery_smoke_operations
  from public, anon, authenticated, service_role;
grant select on public.discovery_smoke_authorizations, public.discovery_smoke_operations to service_role;

-- Administrative activation RPC: NEVER call automatically from a retry/enqueue.
-- Same lineage returns the original identity/deadline, even after cancellation.
create function public.authorize_discovery_smoke(
  p_workspace uuid, p_lineage uuid, p_criteria_hash text, p_pricing_version text, p_approved_quotes jsonb
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.discovery_smoke_authorizations%rowtype; l public.lead_lineages%rowtype; t timestamptz;
begin
  select * into l from public.lead_lineages where lineage_id = p_lineage for share;
  if not found or l.workspace_id is distinct from p_workspace
     or l.mission_hash is distinct from p_criteria_hash or l.status <> 'active'
     or p_criteria_hash is null or p_criteria_hash !~ '^[0-9a-f]{64}$'
     or p_pricing_version is null or length(trim(p_pricing_version)) = 0
     or p_approved_quotes is null or jsonb_typeof(p_approved_quotes) <> 'object' or p_approved_quotes = '{}'::jsonb then
    raise exception 'invalid smoke authorization identity';
  end if;
  t := clock_timestamp();
  insert into public.discovery_smoke_authorizations
    (workspace_id,lineage_id,criteria_hash,pricing_version,approved_quotes,authorized_at,deadline_at)
  values (p_workspace,p_lineage,p_criteria_hash,p_pricing_version,p_approved_quotes,t,t + interval '5 minutes')
  on conflict (workspace_id,lineage_id) do nothing;
  select * into a from public.discovery_smoke_authorizations
    where workspace_id = p_workspace and lineage_id = p_lineage;
  if a.criteria_hash is distinct from p_criteria_hash or a.pricing_version is distinct from p_pricing_version
     or a.approved_quotes is distinct from p_approved_quotes then
    raise exception 'authorization cannot be replaced';
  end if;
  return a.id;
end $$;

create function public.admit_discovery_smoke(
  p_authorization uuid, p_workspace uuid, p_task uuid, p_generation integer,
  p_criteria_hash text, p_key text, p_kind text, p_actor text, p_payload_hash text,
  p_committed_microusd bigint, p_quote jsonb, p_parent_key text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  a public.discovery_smoke_authorizations%rowtype;
  o public.discovery_smoke_operations%rowtype;
  t public.tasks%rowtype; l public.lead_lineages%rowtype;
  v_total numeric; v_provider numeric; v_model numeric;
  n_provider integer; n_model integer; n_page integer; n_poll integer; n_actor integer;
  v_paid boolean; v_now timestamptz; v_observed timestamptz; v_approved jsonb;
begin
  -- Lock order shared with the generation fence: task, lineage, authorization.
  select * into t from public.tasks where id = p_task for share;
  if not found or t.workspace_id is distinct from p_workspace
     or t.checkpoint_version is distinct from p_generation or t.status <> 'running' then
    return jsonb_build_object('decision','stale_generation');
  end if;
  select * into l from public.lead_lineages where lineage_id = t.lineage_id for share;
  if not found or l.workspace_id is distinct from p_workspace or l.status <> 'active'
     or l.lease_holder is distinct from p_task or l.lease_expires_at is null then
    return jsonb_build_object('decision','lost_ownership');
  end if;
  -- This row lock is the serialization point for ALL kinds, actors and workers.
  select * into a from public.discovery_smoke_authorizations where id = p_authorization for update;
  v_now := clock_timestamp(); -- after lock waits; now() would use transaction start
  if not found or a.workspace_id is distinct from p_workspace or a.lineage_id is distinct from t.lineage_id
     or a.criteria_hash is distinct from p_criteria_hash or l.mission_hash is distinct from p_criteria_hash then
    return jsonb_build_object('decision','identity_mismatch');
  end if;
  if a.status <> 'active' or a.deadline_at <= v_now or l.lease_expires_at <= v_now then
    return jsonb_build_object('decision','stopped');
  end if;
  if p_key is null or length(trim(p_key)) = 0 or p_kind is null
     or p_kind not in ('provider','model','page','poll') or p_actor is null
     or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('decision','invalid_operation');
  end if;
  -- Replays may recover an existing run, NEVER obtain another dispatch permission.
  select * into o from public.discovery_smoke_operations where authorization_id = a.id
    and (operation_key = p_key or (p_kind = 'provider' and kind = 'provider'
      and actor = p_actor and payload_hash = p_payload_hash)) limit 1;
  if found then
    if o.kind is distinct from p_kind or o.actor is distinct from p_actor
       or o.payload_hash is distinct from p_payload_hash or o.committed_microusd is distinct from p_committed_microusd
       or o.quote is distinct from p_quote or o.parent_key is distinct from p_parent_key then
      return jsonb_build_object('decision','operation_mismatch');
    end if;
    return jsonb_build_object('decision',case when o.provider_run_id is not null then 'adopt' else 'uncertain' end,
      'operation_key',o.operation_key,'provider_run_id',o.provider_run_id);
  end if;
  if p_kind <> 'model' and not (a.actor_limits ? p_actor) then
    return jsonb_build_object('decision','actor_limit');
  end if;
  -- The worker cannot invent a lower price or approve its own pricing template.
  -- An administrator pins this catalog once. Future transport wiring must prove
  -- the physical request satisfies the approved template's request limits.
  v_approved := a.approved_quotes -> (p_quote->>'template_id');
  if v_approved is null or not coalesce((v_approved->'allowed_kinds') ? p_kind,false)
     or not coalesce((v_approved->'allowed_actors') ? p_actor,false)
     or v_approved->>'maximum_microusd' is distinct from p_committed_microusd::text
     or v_approved->>'request_limits_hash' is distinct from p_quote->>'request_limits_hash'
     or v_approved->>'source' is distinct from p_quote->>'source'
     or v_approved->>'liability_bound_ref' is distinct from p_quote->>'liability_bound_ref'
     or v_approved->>'observed_at' is distinct from p_quote->>'observed_at' then
    return jsonb_build_object('decision','unknown_quote');
  end if;
  -- Fresh quote: a reviewed maximum, NOT an average or a token-table actual cost.
  if p_committed_microusd is null or p_committed_microusd < 0 or p_quote is null
     or jsonb_typeof(p_quote) <> 'object'
     or p_quote->>'pricing_version' is distinct from a.pricing_version
     or p_quote->>'currency' is distinct from 'USD'
     or p_quote->>'basis' is distinct from 'verified_upper_bound'
     or coalesce(length(trim(p_quote->>'source')),0) = 0
     or coalesce(length(trim(p_quote->>'liability_bound_ref')),0) = 0
     or p_quote->>'maximum_microusd' is distinct from p_committed_microusd::text then
    return jsonb_build_object('decision','unknown_quote');
  end if;
  begin v_observed := (p_quote->>'observed_at')::timestamptz;
  exception when others then return jsonb_build_object('decision','unknown_quote'); end;
  if v_observed is null or not isfinite(v_observed) or v_observed > v_now
     or v_observed < v_now - interval '24 hours' then
    return jsonb_build_object('decision','stale_quote');
  end if;
  if p_kind = 'page' and (p_committed_microusd <> 0 or p_actor <> 'apify_linkedin_job_search') then
    return jsonb_build_object('decision','invalid_page');
  end if;
  if p_kind = 'poll' and not exists (select 1 from public.discovery_smoke_operations
    where authorization_id = a.id and operation_key = p_parent_key and kind = 'provider' and actor = p_actor) then
    return jsonb_build_object('decision','missing_parent');
  end if;
  if p_kind <> 'poll' and p_parent_key is not null then
    return jsonb_build_object('decision','invalid_parent');
  end if;
  v_paid := p_kind = 'provider' or (p_kind = 'poll' and p_committed_microusd > 0);
  -- Never subtract completed/failed/refunded observations: all holds count.
  select coalesce(sum(committed_microusd),0),
    coalesce(sum(committed_microusd) filter (where kind <> 'model'),0),
    coalesce(sum(committed_microusd) filter (where kind = 'model'),0),
    count(*) filter (where kind = 'provider' or (kind = 'poll' and committed_microusd > 0)),
    count(*) filter (where kind = 'model'), count(*) filter (where kind = 'page'),
    count(*) filter (where kind = 'poll'),
    count(*) filter (where actor = p_actor and (kind = 'provider' or (kind = 'poll' and committed_microusd > 0)))
  into v_total,v_provider,v_model,n_provider,n_model,n_page,n_poll,n_actor
  from public.discovery_smoke_operations where authorization_id = a.id;
  if v_total + p_committed_microusd > a.total_microusd
     or (p_kind = 'model' and v_model + p_committed_microusd > a.model_microusd)
     or (p_kind <> 'model' and v_provider + p_committed_microusd > a.provider_microusd) then
    return jsonb_build_object('decision','usd_limit');
  end if;
  if (v_paid and n_provider >= a.provider_purchases) or (p_kind = 'model' and n_model >= a.model_attempts) then
    return jsonb_build_object('decision','purchase_limit');
  end if;
  if v_paid and n_actor >= (a.actor_limits->>p_actor)::integer then
    return jsonb_build_object('decision','actor_limit');
  end if;
  if (p_kind = 'page' and n_page >= a.discovery_pages) or (p_kind = 'poll' and n_poll >= a.provider_polls) then
    return jsonb_build_object('decision','transport_limit');
  end if;
  insert into public.discovery_smoke_operations
    (authorization_id,operation_key,task_id,generation,kind,actor,payload_hash,parent_key,committed_microusd,quote)
  values (a.id,p_key,p_task,p_generation,p_kind,p_actor,p_payload_hash,p_parent_key,p_committed_microusd,p_quote)
  returning * into o;
  return jsonb_build_object('decision','admitted','operation_key',o.operation_key,
    'reservation_token',o.reservation_token,'deadline_at',a.deadline_at);
end $$;

-- Reconciliation can finish after expiry/cancellation and from an old generation.
-- It cannot authorize transport, refund a hold, change a quote or replace a run ID.
create function public.record_discovery_smoke_receipt(
  p_authorization uuid, p_key text, p_token uuid, p_run_id text default null, p_receipt jsonb default null
) returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.discovery_smoke_authorizations%rowtype; o public.discovery_smoke_operations%rowtype; v_actual bigint;
begin
  select * into a from public.discovery_smoke_authorizations where id = p_authorization for update;
  if not found then return false; end if;
  select * into o from public.discovery_smoke_operations
    where authorization_id = a.id and operation_key = p_key for update;
  if not found or o.reservation_token is distinct from p_token
     or (p_run_id is not null and (length(trim(p_run_id)) = 0 or o.kind <> 'provider'))
     or (o.provider_run_id is not null and p_run_id is not null and o.provider_run_id <> p_run_id) then return false; end if;
  if p_receipt is not null then
    if p_receipt->>'kind' is distinct from 'actual_provider_receipt'
       or coalesce(length(trim(p_receipt->>'source')),0) = 0
       or coalesce(length(trim(p_receipt->>'receipt_id')),0) = 0
       or (p_receipt->>'amount_microusd') is null
       or (p_receipt->>'amount_microusd') !~ '^[0-9]+$' then return false; end if;
    v_actual := (p_receipt->>'amount_microusd')::bigint;
    if o.receipt is not null and o.receipt is distinct from p_receipt then return false; end if;
  end if;
  update public.discovery_smoke_operations set provider_run_id = coalesce(provider_run_id,p_run_id),
    actual_microusd = coalesce(actual_microusd,v_actual), receipt = coalesce(receipt,p_receipt)
    where authorization_id = a.id and operation_key = p_key;
  if v_actual > o.committed_microusd then
    update public.discovery_smoke_authorizations set status = 'cancelled' where id = a.id;
  end if;
  return true;
end $$;

create function public.stop_discovery_smoke(p_authorization uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.discovery_smoke_authorizations set status = 'cancelled' where id = p_authorization and status = 'active';
  return found;
end $$;

revoke all on function public.authorize_discovery_smoke(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
-- Do not grant the activation RPC to the worker's service_role. An approved
-- administrative step must create the authorization; workers can never mint one.
revoke all on function public.admit_discovery_smoke(uuid,uuid,uuid,integer,text,text,text,text,text,bigint,jsonb,text) from public,anon,authenticated;
revoke all on function public.record_discovery_smoke_receipt(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.stop_discovery_smoke(uuid) from public,anon,authenticated;
grant execute on function public.admit_discovery_smoke(uuid,uuid,uuid,integer,text,text,text,text,text,bigint,jsonb,text) to service_role;
grant execute on function public.record_discovery_smoke_receipt(uuid,text,uuid,text,jsonb) to service_role;
grant execute on function public.stop_discovery_smoke(uuid) to service_role;
