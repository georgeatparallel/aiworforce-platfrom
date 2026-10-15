-- ============================================================================
-- PROPOSED — NOT APPLIED, NOT WIRED, NOT APPROVED FOR PRODUCTION.
-- Provider purchase claims: ONE buyer per idempotency key, decided in the
-- database before any paid provider call is sent.
-- ============================================================================
--
-- WHY. Nothing today stops two LIVE holders buying the same provider call:
--
--   * `lead_execution_calls`' idempotency index is deliberately NOT unique
--     (production already holds duplicate keys, and the ledger writer escalates
--     `attempt_number` on a collision rather than refusing);
--   * `credits_reserve` REPLAYS a repeated key — it protects credits, not the
--     provider dollars, and the call still goes out;
--   * the lineage lease's holder is the task id, which every generation of a
--     V2 mission shares, so it cannot tell a stale worker from the live one.
--
-- So a worker whose event loop stalls past its claim (A), and the worker that
-- reclaims the mission (B), can both POST the same Actor run: two provider runs,
-- one credit. D1 fences their RESULT writes; nothing fences their PURCHASES.
--
-- WHAT THIS ADDS. A row per (workspace, idempotency key), claimed in one
-- statement right before the start POST, under the generation token D1 already
-- fences writes on (`tasks.checkpoint_version`):
--
--   claim_provider_purchase(ws, key, task, generation)
--     'stale_generation'  the claimant's generation no longer owns the task
--                         row: a stalled worker — it must not buy.
--     'buy'               nobody holds the key (or the last holder failed
--                         before any run existed): this caller buys.
--     'adopt'             a run id is recorded: re-read it, never buy.
--     'uncertain'         another holder claimed it and recorded no run (yet):
--                         never buy — the D2 rule (defer, then hold unresolved).
--     'settled'           finished without a run id to re-read (a synchronous
--                         call): never buy again.
--     'held_by_self'      the same task AND generation already holds it: the
--                         caller's own retry; it decides from its own state.
--   attach_purchase_run(ws, key, run_id)        the start POST returned an id.
--   settle_provider_purchase(ws, key, status)   'settled' or
--                                               'failed_before_start' (no run
--                                               could exist: a 4xx refusal).
--
-- WIRING (not in this migration): `ledgerBoundCall` (claimVerifier.ts) and the
-- engine's `callProvider` ask `claim_provider_purchase` after the spend-ledger
-- reservation and before the guarded invoker; `onRunStarted` / `onProviderRun`
-- call `attach_purchase_run`; the ledger finalizer calls
-- `settle_provider_purchase`. A database without this migration answers
-- PGRST202 / 42883, and the caller falls back to today's behaviour.
--
-- Tested against real Postgres (PGlite) in tests/infra/providerPurchaseClaims.test.ts.
-- Rollback: rollback/20261015120000_provider_purchase_claims.down.sql.

create table if not exists public.provider_purchase_claims (
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  idempotency_key  text not null,
  task_id          uuid not null,
  generation       integer not null,
  status           text not null default 'claimed'
                   check (status in ('claimed', 'started', 'settled', 'failed_before_start')),
  provider_run_id  text,
  claimed_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);

-- Service role only: no policy grants anon or authenticated anything.
alter table public.provider_purchase_claims enable row level security;
revoke all on public.provider_purchase_claims from anon, authenticated;

create or replace function public.claim_provider_purchase(
  p_workspace_id uuid, p_idempotency_key text, p_task_id uuid, p_generation integer
) returns table (decision text, provider_run_id text, holder_task_id uuid, holder_generation integer)
language plpgsql security definer set search_path = public as $$
declare
  v_version integer;
  v_row public.provider_purchase_claims%rowtype;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 or p_generation is null then
    raise exception 'claim_provider_purchase: key and generation are required';
  end if;
  -- THE GENERATION FENCE (D1's token), held for the rest of the transaction so
  -- a reclaim cannot advance it between this check and the insert.
  select t.checkpoint_version into v_version from public.tasks t where t.id = p_task_id for share;
  if v_version is distinct from p_generation then
    return query select 'stale_generation'::text, null::text, null::uuid, v_version;
    return;
  end if;

  insert into public.provider_purchase_claims (workspace_id, idempotency_key, task_id, generation)
  values (p_workspace_id, p_idempotency_key, p_task_id, p_generation)
  on conflict (workspace_id, idempotency_key) do nothing;
  if found then
    return query select 'buy'::text, null::text, p_task_id, p_generation;
    return;
  end if;

  select * into v_row from public.provider_purchase_claims c
   where c.workspace_id = p_workspace_id and c.idempotency_key = p_idempotency_key
   for update;

  if v_row.provider_run_id is not null then
    return query select 'adopt'::text, v_row.provider_run_id, v_row.task_id, v_row.generation;
  elsif v_row.status = 'failed_before_start' then
    update public.provider_purchase_claims c
       set task_id = p_task_id, generation = p_generation, status = 'claimed', claimed_at = now(), updated_at = now()
     where c.workspace_id = p_workspace_id and c.idempotency_key = p_idempotency_key;
    return query select 'buy'::text, null::text, p_task_id, p_generation;
  elsif v_row.status = 'settled' then
    return query select 'settled'::text, null::text, v_row.task_id, v_row.generation;
  elsif v_row.task_id = p_task_id and v_row.generation = p_generation then
    return query select 'held_by_self'::text, null::text, v_row.task_id, v_row.generation;
  else
    return query select 'uncertain'::text, null::text, v_row.task_id, v_row.generation;
  end if;
end $$;

create or replace function public.attach_purchase_run(
  p_workspace_id uuid, p_idempotency_key text, p_provider_run_id text
) returns boolean
language sql security definer set search_path = public as $$
  with u as (
    update public.provider_purchase_claims c
       set provider_run_id = p_provider_run_id, status = 'started', updated_at = now()
     where c.workspace_id = p_workspace_id and c.idempotency_key = p_idempotency_key
       and (c.provider_run_id is null or c.provider_run_id = p_provider_run_id)
    returning 1)
  select exists (select 1 from u)
$$;

create or replace function public.settle_provider_purchase(
  p_workspace_id uuid, p_idempotency_key text, p_status text
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('settled', 'failed_before_start') then
    raise exception 'settle_provider_purchase: invalid status %', p_status;
  end if;
  -- A run id, once recorded, is never discarded: a run that started is never
  -- "failed before start".
  update public.provider_purchase_claims c
     set status = case when p_status = 'failed_before_start' and c.provider_run_id is not null then 'settled' else p_status end,
         updated_at = now()
   where c.workspace_id = p_workspace_id and c.idempotency_key = p_idempotency_key;
  return found;
end $$;

revoke all on function public.claim_provider_purchase(uuid, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.attach_purchase_run(uuid, text, text) from public, anon, authenticated;
revoke all on function public.settle_provider_purchase(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_provider_purchase(uuid, text, uuid, integer) to service_role;
grant execute on function public.attach_purchase_run(uuid, text, text) to service_role;
grant execute on function public.settle_provider_purchase(uuid, text, text) to service_role;
