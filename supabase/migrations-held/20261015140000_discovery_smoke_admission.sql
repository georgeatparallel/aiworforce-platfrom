-- ============================================================================
-- HELD — NOT APPLIED, NOT APPROVED FOR ANY HOSTED PROJECT.
-- Durable admission for ONE controlled Discovery smoke mission ($0.25 total).
-- ============================================================================
--
-- Derived from Codex's reviewed proposal
-- (`docs/launch/proposals/smoke-budget/0001.up.sql` on
-- `codex/smoke-durable-admission-proposal`): same two tables, same RPC names,
-- same hard caps and the same no-refund rule. What changed, and why, is listed
-- in docs/launch/discovery-smoke-admission.md ("Changes from the proposal").
-- The three that matter:
--
--   * The authorization is keyed on the QUEUE ROW, not the lineage. A V2
--     lineage's id is the root task id, which the handler creates during the
--     first slice — so a lineage-keyed authorization could never exist before
--     the first paid call. The queue row exists at enqueue, and
--     `bind_lead_mission_execution` ties exactly one task to it for life.
--   * A leased lineage is `running` (acquire_lineage_lease sets it), so the
--     ownership check accepts `active` or `running` with this task as the
--     unexpired lease holder.
--   * The authorization row is locked FIRST, then the queue, task and lineage
--     rows FOR SHARE, in the heartbeat's own order, held through commit
--     (Codex review R8): ownership cannot change between the check and the
--     commit, and no existing RPC locks these rows in another order.
--
-- ── WHAT IT GUARANTEES ─────────────────────────────────────────────────────
--
-- Every billable transport (model attempt, provider purchase, status/dataset
-- poll) needs one committed `admitted` answer from `admit_discovery_smoke`
-- before it is sent. All operations of a mission serialize on its one
-- authorization row. Each admission is checked, in that one transaction,
-- against everything already admitted: committed USD (model, provider,
-- combined), purchase / model-attempt / per-actor / discovery-page / poll
-- counts, the absolute deadline (database clock, read AFTER the lock), the
-- queue claim, the task generation, the lineage lease and cancellation.
--
-- NOTHING IS REFUNDED. An admitted operation keeps its committed maximum and
-- its slot whatever happens next: a failure, a timeout, a crash before or
-- after the POST, a lost checkpoint or a credit refund. That is what makes a
-- restart, a re-enqueue or a lost telemetry drain unable to buy more.
--
-- WORKERS CANNOT WIDEN IT. `service_role` (the worker's credential) may only
-- SELECT these tables and EXECUTE admit / record / stop. It cannot insert,
-- update or delete a row, and cannot call `authorize_discovery_smoke`. A new
-- queue row has no authorization, so it can buy nothing. Database owners and
-- administrators remain trusted.
--
-- WHAT IT CANNOT GUARANTEE (see the doc): that a vendor bills no more than
-- the approved maximum, that a run stops at the deadline vendor-side, or that
-- a process which received `admitted` does not stall before sending.
--
-- Depends on the held Lead V2 chain (`lead_mission_queue`). Rollback:
-- rollback/20261015140000_discovery_smoke_admission.down.sql. Apply in ONE
-- transaction (`psql --single-transaction`), as every held file is.

-- USD is integer micro-dollars: 250000 = $0.25. The CHECKs are the hard
-- ceiling: even an administrator cannot authorize more without a migration.
create table public.discovery_smoke_authorizations (
  id                 uuid primary key default gen_random_uuid(),
  queue_id           uuid not null unique references public.lead_mission_queue(id),
  workspace_id       uuid not null references public.workspaces(id),
  -- sha256 of the queue row's request as authorized. A request edited after
  -- approval is a different mission and admits nothing.
  criteria_hash      text not null check (criteria_hash ~ '^[0-9a-f]{64}$'),
  pricing_version    text not null check (length(trim(pricing_version)) > 0),
  approved_quotes    jsonb not null check (jsonb_typeof(approved_quotes) = 'object' and approved_quotes <> '{}'::jsonb),
  actor_limits       jsonb not null check (jsonb_typeof(actor_limits) = 'object'),
  authorized_at      timestamptz not null default clock_timestamp(),
  deadline_at        timestamptz not null,
  status             text not null default 'active' check (status in ('active', 'stopped')),
  stop_reason        text,
  total_microusd     bigint  not null default 250000 check (total_microusd between 0 and 250000),
  provider_microusd  bigint  not null default 200000 check (provider_microusd between 0 and 200000),
  model_microusd     bigint  not null default 50000  check (model_microusd between 0 and 50000),
  provider_purchases integer not null default 5 check (provider_purchases between 0 and 5),
  model_attempts     integer not null default 4 check (model_attempts between 0 and 4),
  discovery_pages    integer not null default 1 check (discovery_pages between 0 and 1),
  provider_polls     integer not null default 5 check (provider_polls between 0 and 5),
  -- One absolute deadline, at most five minutes after approval.
  check (deadline_at > authorized_at and deadline_at <= authorized_at + interval '300 seconds'),
  check ((status = 'stopped') = (stop_reason is not null))
);

create table public.discovery_smoke_operations (
  authorization_id    uuid not null references public.discovery_smoke_authorizations(id),
  operation_key       text not null check (length(trim(operation_key)) > 0),
  reservation_token   uuid not null default gen_random_uuid(),
  task_id             uuid not null,
  generation          integer not null,
  kind                text not null check (kind in ('provider', 'model', 'poll')),
  actor               text not null check (length(trim(actor)) > 0),
  template_id         text not null,
  payload_hash        text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  parent_key          text,
  committed_microusd  bigint not null check (committed_microusd >= 0),
  discovery_page      boolean not null default false,
  admitted_at         timestamptz not null default clock_timestamp(),
  provider_run_id     text,
  provider_dataset_id text,
  -- The largest charge a vendor ever reported for this operation; evidence,
  -- never a refund. Above the committed maximum it stops the authorization.
  reported_microusd   bigint check (reported_microusd >= 0),
  report_source       text,
  primary key (authorization_id, operation_key),
  foreign key (authorization_id, parent_key)
    references public.discovery_smoke_operations(authorization_id, operation_key),
  check ((kind = 'poll') = (parent_key is not null))
);
-- A new key for the same actor and payload is not a new purchase permission.
create unique index discovery_smoke_provider_payload on public.discovery_smoke_operations
  (authorization_id, actor, payload_hash) where kind = 'provider';
create unique index discovery_smoke_run_id on public.discovery_smoke_operations
  (authorization_id, provider_run_id) where provider_run_id is not null;
create unique index discovery_smoke_dataset_id on public.discovery_smoke_operations
  (authorization_id, provider_dataset_id) where provider_dataset_id is not null;

-- ── RECONCILIATION: THE VENDOR'S OWN FIGURE, RECORDED BY A PERSON ─────────
--
-- Every provider purchase is LIABILITY, carried at its committed maximum,
-- until an administrator records the vendor's own figure here — the final run
-- whose receipt the five-read plan deferred, a run left pending, an uncertain
-- start, and a "settled" receipt too: `report_source` is written by the worker
-- (record_discovery_smoke_receipt), so no label it chooses can stand in for
-- this record (Codex review, PR #96). Immutable, and it never changes a
-- commitment. Until every purchase of every earlier smoke is reconciled, no
-- new smoke can be authorized and no other authorization may spend.
create table public.discovery_smoke_reconciliations (
  authorization_id uuid not null,
  operation_key    text not null,
  vendor_microusd  bigint not null check (vendor_microusd >= 0),
  vendor_ref       text not null check (length(trim(vendor_ref)) > 0),
  reconciled_at    timestamptz not null default clock_timestamp(),
  reconciled_by    name not null default current_user,
  primary key (authorization_id, operation_key),
  foreign key (authorization_id, operation_key)
    references public.discovery_smoke_operations(authorization_id, operation_key)
);

alter table public.discovery_smoke_authorizations enable row level security;
alter table public.discovery_smoke_operations enable row level security;
alter table public.discovery_smoke_reconciliations enable row level security;
revoke all on public.discovery_smoke_authorizations, public.discovery_smoke_operations,
  public.discovery_smoke_reconciliations
  from public, anon, authenticated, service_role;
grant select on public.discovery_smoke_authorizations, public.discovery_smoke_operations,
  public.discovery_smoke_reconciliations to service_role;

-- ── ADMINISTRATIVE APPROVAL. Never granted to the worker. ─────────────────
--
-- Run once, by a person, right after the reviewed enqueue. The deadline is the
-- queue row's own `created_at` plus the window (the same instant Codex's
-- runtime wall clock reads), so approving late never extends it. A second call
-- for the same queue row returns the original id unchanged, or refuses if
-- anything differs; nothing can replace or renew an authorization.
create function public.authorize_discovery_smoke(
  p_queue uuid, p_pricing_version text, p_approved_quotes jsonb, p_actor_limits jsonb,
  p_window_seconds integer default 300
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  q public.lead_mission_queue%rowtype;
  a public.discovery_smoke_authorizations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_hash text; v_t jsonb; v_id text; v_obs timestamptz; v_k text; v_open bigint;
begin
  select * into q from public.lead_mission_queue where id = p_queue for update;
  if not found then raise exception 'authorize_discovery_smoke: no such queue row'; end if;
  v_hash := encode(sha256(convert_to(q.request::text, 'UTF8')), 'hex');

  select * into a from public.discovery_smoke_authorizations where queue_id = p_queue;
  if found then
    if a.criteria_hash is distinct from v_hash or a.pricing_version is distinct from p_pricing_version
       or a.approved_quotes is distinct from p_approved_quotes or a.actor_limits is distinct from p_actor_limits
       or a.deadline_at is distinct from q.created_at + make_interval(secs => p_window_seconds) then
      raise exception 'authorize_discovery_smoke: an authorization exists and cannot be replaced';
    end if;
    return a.id;
  end if;

  -- NO NEW SMOKE OVER UNRECONCILED LIABILITY. Any earlier provider purchase
  -- without a reconciliation may still be billed up to its maximum; another
  -- mission would spend on top of an unknown. Serialized with every paid
  -- admission and reconciliation by one transaction-scoped lock.
  perform pg_advisory_xact_lock(hashtext('agentory.discovery_smoke.liability'));
  select count(*) into v_open from public.discovery_smoke_operations o
   where o.kind = 'provider'
     and not exists (select 1 from public.discovery_smoke_reconciliations r
                      where r.authorization_id = o.authorization_id and r.operation_key = o.operation_key);
  if v_open > 0 then
    raise exception 'authorize_discovery_smoke: % earlier provider purchase(s) are unreconciled; reconcile them first', v_open;
  end if;

  if q.status not in ('queued', 'running', 'resumable') then
    raise exception 'authorize_discovery_smoke: queue row is %', q.status;
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 300 then
    raise exception 'authorize_discovery_smoke: window must be 1-300 seconds';
  end if;
  if q.created_at + make_interval(secs => p_window_seconds) <= v_now then
    raise exception 'authorize_discovery_smoke: the queue row''s window has already passed';
  end if;
  if p_pricing_version is null or length(trim(p_pricing_version)) = 0 then
    raise exception 'authorize_discovery_smoke: pricing version required';
  end if;
  if p_actor_limits is null or jsonb_typeof(p_actor_limits) <> 'object' then
    raise exception 'authorize_discovery_smoke: actor limits must be an object';
  end if;
  for v_k in select jsonb_object_keys(p_actor_limits) loop
    if jsonb_typeof(p_actor_limits -> v_k) <> 'number' or (p_actor_limits ->> v_k) !~ '^[0-9]+$' then
      raise exception 'authorize_discovery_smoke: actor limit % must be a non-negative integer', v_k;
    end if;
  end loop;
  -- Every template is a reviewed MAXIMUM with its evidence. Unknown or
  -- unbounded prices have no template, and an operation without one is refused.
  if p_approved_quotes is null or jsonb_typeof(p_approved_quotes) <> 'object' or p_approved_quotes = '{}'::jsonb then
    raise exception 'authorize_discovery_smoke: approved quotes required';
  end if;
  for v_id, v_t in select key, value from jsonb_each(p_approved_quotes) loop
    if jsonb_typeof(v_t) <> 'object'
       or jsonb_typeof(v_t -> 'allowed_kinds') <> 'array' or jsonb_array_length(v_t -> 'allowed_kinds') = 0
       or exists (select 1 from jsonb_array_elements_text(v_t -> 'allowed_kinds') k where k not in ('provider', 'model', 'poll'))
       or jsonb_typeof(v_t -> 'allowed_actors') <> 'array' or jsonb_array_length(v_t -> 'allowed_actors') = 0
       or jsonb_typeof(v_t -> 'maximum_microusd') <> 'number' or (v_t ->> 'maximum_microusd') !~ '^[0-9]+$'
       or (v_t ->> 'maximum_microusd')::numeric > 250000
       or coalesce(length(trim(v_t ->> 'source')), 0) = 0
       or coalesce(length(trim(v_t ->> 'liability_bound_ref')), 0) = 0
       or jsonb_typeof(v_t -> 'request_limits') is distinct from 'object'
       or ((v_t -> 'request_limits') ? 'max_reads_per_actor'
           and (jsonb_typeof(v_t -> 'request_limits' -> 'max_reads_per_actor') <> 'object'
                or exists (select 1 from jsonb_each(v_t -> 'request_limits' -> 'max_reads_per_actor') r
                            where jsonb_typeof(r.value) <> 'number' or r.value::text !~ '^[0-9]+$')))
       or (v_t ? 'discovery_page' and jsonb_typeof(v_t -> 'discovery_page') <> 'boolean') then
      raise exception 'authorize_discovery_smoke: template % is malformed', v_id;
    end if;
    begin v_obs := (v_t ->> 'observed_at')::timestamptz;
    exception when others then raise exception 'authorize_discovery_smoke: template % observed_at is not a time', v_id; end;
    if v_obs is null or not isfinite(v_obs) or v_obs > v_now or v_obs < v_now - interval '24 hours' then
      raise exception 'authorize_discovery_smoke: template % price observation is stale or in the future', v_id;
    end if;
  end loop;

  insert into public.discovery_smoke_authorizations
    (queue_id, workspace_id, criteria_hash, pricing_version, approved_quotes, actor_limits, authorized_at, deadline_at)
  values (p_queue, q.workspace_id, v_hash, p_pricing_version, p_approved_quotes, p_actor_limits,
          v_now, q.created_at + make_interval(secs => p_window_seconds))
  returning * into a;
  return a.id;
end $$;

-- ── THE ONE DOOR TO A BILLABLE TRANSPORT ──────────────────────────────────
--
-- Only `admitted` permits exactly one physical request. `adopt` names a run
-- that already exists (read it, never buy again); `uncertain` means this
-- purchase may already exist with no run id, so it is never sent again.
-- Every other decision is a refusal.
create function public.admit_discovery_smoke(
  p_queue uuid, p_worker uuid, p_task uuid, p_generation integer,
  p_key text, p_kind text, p_actor text, p_template text, p_payload_hash text,
  p_parent_key text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  a public.discovery_smoke_authorizations%rowtype;
  q public.lead_mission_queue%rowtype;
  t public.tasks%rowtype;
  l public.lead_lineages%rowtype;
  o public.discovery_smoke_operations%rowtype;
  p public.discovery_smoke_operations%rowtype;
  v_tpl jsonb; v_cost bigint; v_page boolean; v_paid boolean; v_now timestamptz; v_obs timestamptz;
  v_total bigint; v_provider bigint; v_model bigint;
  n_paid integer; n_model integer; n_page integer; n_poll integer; n_actor integer; n_actor_poll integer;
begin
  if p_queue is null or p_worker is null or p_task is null or p_generation is null
     or p_key is null or length(trim(p_key)) = 0 or p_kind is null or p_kind not in ('provider', 'model', 'poll')
     or p_actor is null or length(trim(p_actor)) = 0 or p_template is null
     or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
     or ((p_kind = 'poll') <> (p_parent_key is not null)) then
    return jsonb_build_object('decision', 'invalid_operation');
  end if;

  -- THE SERIALIZATION POINT for every kind, actor, task and worker.
  select * into a from public.discovery_smoke_authorizations where queue_id = p_queue for update;
  if not found then return jsonb_build_object('decision', 'not_authorized'); end if;

  -- Ownership, FENCED THROUGH COMMIT (Codex review R8). The rows are held FOR
  -- SHARE until this transaction ends, so a cancellation, a generation bump or
  -- a lease change cannot commit between this check and this admission's
  -- commit: it waits, and an admission is either ordered before it or refused
  -- by it. Order queue -> task -> lineage, the heartbeat's own order; claims,
  -- fences, cancellation and lease RPCs each lock a single one of these rows
  -- and none of them touches the authorization, so no cycle can form.
  select * into q from public.lead_mission_queue where id = p_queue for share;
  select * into t from public.tasks where id = p_task for share;
  select * into l from public.lead_lineages where lineage_id = q.lineage_id for share;
  v_now := clock_timestamp();  -- after the lock wait; now() is transaction start

  if a.status <> 'active' or a.deadline_at <= v_now
     or q.status is distinct from 'running' or l.status in ('terminal', 'cancelled') then
    return jsonb_build_object('decision', 'stopped', 'deadline_at', a.deadline_at);
  end if;
  if q.workspace_id is distinct from a.workspace_id
     or encode(sha256(convert_to(q.request::text, 'UTF8')), 'hex') is distinct from a.criteria_hash then
    return jsonb_build_object('decision', 'identity_mismatch');
  end if;
  if q.claimed_by is distinct from p_worker or q.lease_expires_at is null or q.lease_expires_at <= v_now
     or q.task_id is distinct from p_task
     or l.lineage_id is null or l.workspace_id is distinct from a.workspace_id
     or l.status not in ('active', 'running')
     or l.lease_holder is distinct from p_task or l.lease_expires_at is null or l.lease_expires_at <= v_now then
    return jsonb_build_object('decision', 'lost_ownership');
  end if;
  -- `ready` is the slice's own stage-boundary checkpoint (run-agent writes the
  -- row status with every checkpoint, projectStatus("continuation_required")),
  -- not a release: the same generation and both leases above still hold. A
  -- re-claim bumps the generation; a finished or failed task is refused.
  if t.id is null or t.workspace_id is distinct from a.workspace_id or t.status is null
     or t.status not in ('running', 'ready')
     or t.checkpoint_version is distinct from p_generation then
    return jsonb_build_object('decision', 'stale_generation');
  end if;

  -- A replay recovers what exists; it never earns a second dispatch.
  select * into o from public.discovery_smoke_operations
   where authorization_id = a.id
     and (operation_key = p_key
          or (p_kind = 'provider' and kind = 'provider' and actor = p_actor and payload_hash = p_payload_hash))
   limit 1;
  if found then
    if o.kind is distinct from p_kind or o.actor is distinct from p_actor or o.template_id is distinct from p_template
       or o.payload_hash is distinct from p_payload_hash or o.parent_key is distinct from p_parent_key then
      return jsonb_build_object('decision', 'operation_mismatch');
    end if;
    return jsonb_build_object('decision', case when o.provider_run_id is not null then 'adopt' else 'uncertain' end,
      'operation_key', o.operation_key, 'provider_run_id', o.provider_run_id,
      'provider_dataset_id', o.provider_dataset_id);
  end if;

  -- NOR MAY AN EARLIER AUTHORIZATION SPEND OVER IT (Codex review, PR #96). A
  -- smoke authorized before another one bought anything would otherwise pass
  -- the authorization check and spend on top of the other's open liability.
  -- Rechecked at every paid admission, under the same lock as authorization
  -- and reconciliation, so a purchase committing elsewhere is seen. Reads of
  -- this mission's own runs are not spending and are not blocked.
  if p_kind in ('provider', 'model') then
    perform pg_advisory_xact_lock(hashtext('agentory.discovery_smoke.liability'));
    if exists (select 1 from public.discovery_smoke_operations x
                where x.kind = 'provider' and x.authorization_id <> a.id
                  and not exists (select 1 from public.discovery_smoke_reconciliations r
                                   where r.authorization_id = x.authorization_id and r.operation_key = x.operation_key)) then
      return jsonb_build_object('decision', 'prior_liability_unreconciled');
    end if;
  end if;

  -- The price is the APPROVED template's maximum; the worker names a template,
  -- it never states a price.
  v_tpl := a.approved_quotes -> p_template;
  if v_tpl is null or not ((v_tpl -> 'allowed_kinds') ? p_kind) or not ((v_tpl -> 'allowed_actors') ? p_actor) then
    return jsonb_build_object('decision', 'unknown_quote');
  end if;
  v_obs := (v_tpl ->> 'observed_at')::timestamptz;
  if v_obs < v_now - interval '24 hours' then
    return jsonb_build_object('decision', 'stale_quote');
  end if;
  v_cost := (v_tpl ->> 'maximum_microusd')::bigint;
  v_page := p_kind = 'provider' and coalesce((v_tpl ->> 'discovery_page')::boolean, false);

  if p_kind = 'poll' then
    select * into p from public.discovery_smoke_operations
     where authorization_id = a.id and operation_key = p_parent_key;
    if not found or p.kind <> 'provider' or p.actor <> p_actor then
      return jsonb_build_object('decision', 'missing_parent');
    end if;
  end if;
  if p_kind <> 'model' and not (a.actor_limits ? p_actor) then
    return jsonb_build_object('decision', 'actor_limit');
  end if;

  -- Every admission ever made counts: pending, uncertain, failed and finished.
  v_paid := p_kind = 'provider' or (p_kind = 'poll' and v_cost > 0);
  select coalesce(sum(committed_microusd), 0),
         coalesce(sum(committed_microusd) filter (where kind <> 'model'), 0),
         coalesce(sum(committed_microusd) filter (where kind = 'model'), 0),
         count(*) filter (where kind = 'provider' or (kind = 'poll' and committed_microusd > 0)),
         count(*) filter (where kind = 'model'),
         count(*) filter (where discovery_page),
         count(*) filter (where kind = 'poll'),
         count(*) filter (where actor = p_actor and (kind = 'provider' or (kind = 'poll' and committed_microusd > 0))),
         count(*) filter (where kind = 'poll' and actor = p_actor)
    into v_total, v_provider, v_model, n_paid, n_model, n_page, n_poll, n_actor, n_actor_poll
    from public.discovery_smoke_operations where authorization_id = a.id;

  if v_total + v_cost > a.total_microusd
     or (p_kind = 'model' and v_model + v_cost > a.model_microusd)
     or (p_kind <> 'model' and v_provider + v_cost > a.provider_microusd) then
    return jsonb_build_object('decision', 'usd_limit');
  end if;
  if v_paid and n_paid >= a.provider_purchases then
    return jsonb_build_object('decision', 'purchase_limit');
  end if;
  if p_kind = 'model' and n_model >= a.model_attempts then
    return jsonb_build_object('decision', 'model_attempt_limit');
  end if;
  if v_paid and n_actor >= (a.actor_limits ->> p_actor)::integer then
    return jsonb_build_object('decision', 'actor_limit');
  end if;
  if v_page and n_page >= a.discovery_pages then
    return jsonb_build_object('decision', 'page_limit');
  end if;
  if p_kind = 'poll' and n_poll >= a.provider_polls then
    return jsonb_build_object('decision', 'poll_limit');
  end if;
  -- THE READ ALLOCATION (optional, per actor, inside the shared cap): a reads
  -- template may give each actor its share of the polls, so one slow run
  -- cannot spend the reads a later approved run needs (independent review,
  -- PR #96: job search 3, company details 2). Counted from the same rows.
  if p_kind = 'poll' and (v_tpl -> 'request_limits' -> 'max_reads_per_actor') ? p_actor
     and n_actor_poll >= (v_tpl -> 'request_limits' -> 'max_reads_per_actor' ->> p_actor)::integer then
    return jsonb_build_object('decision', 'read_allocation');
  end if;

  insert into public.discovery_smoke_operations
    (authorization_id, operation_key, task_id, generation, kind, actor, template_id, payload_hash,
     parent_key, committed_microusd, discovery_page)
  values (a.id, p_key, p_task, p_generation, p_kind, p_actor, p_template, p_payload_hash,
          p_parent_key, v_cost, v_page)
  returning * into o;
  return jsonb_build_object('decision', 'admitted', 'operation_key', o.operation_key,
    'reservation_token', o.reservation_token, 'committed_microusd', o.committed_microusd,
    'deadline_at', a.deadline_at);
end $$;

-- ── EVIDENCE AFTER THE FACT ───────────────────────────────────────────────
--
-- Attaches a provider run/dataset id once (immutable) and the largest charge a
-- vendor reported. Allowed after the deadline, cancellation or a lost
-- generation, because reconciliation must still land. It can never release a
-- commitment, change a price or admit anything. A reported charge above the
-- committed maximum stops the authorization: the bound was wrong.
create function public.record_discovery_smoke_receipt(
  p_queue uuid, p_key text, p_token uuid,
  p_run_id text default null, p_dataset_id text default null,
  p_reported_microusd bigint default null, p_source text default null
) returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.discovery_smoke_authorizations%rowtype; o public.discovery_smoke_operations%rowtype;
begin
  select * into a from public.discovery_smoke_authorizations where queue_id = p_queue for update;
  if not found then return false; end if;
  select * into o from public.discovery_smoke_operations
   where authorization_id = a.id and operation_key = p_key for update;
  if not found or o.reservation_token is distinct from p_token then return false; end if;
  if (p_run_id is not null or p_dataset_id is not null) and o.kind <> 'provider' then return false; end if;
  -- Immutable once set: a different id for the same operation is refused.
  if (p_run_id is not null and (length(trim(p_run_id)) = 0 or o.provider_run_id <> p_run_id))
     or (p_dataset_id is not null and (length(trim(p_dataset_id)) = 0 or o.provider_dataset_id <> p_dataset_id)) then
    return false;
  end if;
  if p_reported_microusd is not null and (p_reported_microusd < 0 or coalesce(length(trim(p_source)), 0) = 0) then
    return false;
  end if;
  update public.discovery_smoke_operations
     set provider_run_id     = coalesce(provider_run_id, p_run_id),
         provider_dataset_id = coalesce(provider_dataset_id, p_dataset_id),
         reported_microusd   = greatest(reported_microusd, p_reported_microusd),
         report_source       = case when p_reported_microusd is not null
                                      and p_reported_microusd >= coalesce(reported_microusd, -1)
                                    then p_source else report_source end
   where authorization_id = a.id and operation_key = p_key;
  if p_reported_microusd > o.committed_microusd and a.status = 'active' then
    update public.discovery_smoke_authorizations
       set status = 'stopped', stop_reason = 'reported_charge_exceeded_quote:' || p_key
     where id = a.id;
  end if;
  return true;
end $$;

-- ── RECONCILE ONE PURCHASE. Administrators only, never the worker. ────────
--
-- Records the vendor's final figure for a provider purchase (any purchase:
-- a worker-written receipt is evidence, not settlement). Never edits the operation, never lowers a commitment. A
-- second call for the same operation returns the first record unchanged, or
-- refuses if it differs. A figure above the committed maximum is recorded AND
-- stops the authorization (if still active): the bound was wrong, and the
-- report says so (`exceeded`).
create function public.reconcile_discovery_smoke_operation(
  p_queue uuid, p_key text, p_vendor_microusd bigint, p_vendor_ref text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.discovery_smoke_authorizations%rowtype; o public.discovery_smoke_operations%rowtype;
        r public.discovery_smoke_reconciliations%rowtype;
begin
  if p_vendor_microusd is null or p_vendor_microusd < 0 or coalesce(length(trim(p_vendor_ref)), 0) = 0 then
    raise exception 'reconcile_discovery_smoke_operation: a vendor figure and its reference are required';
  end if;
  select * into a from public.discovery_smoke_authorizations where queue_id = p_queue for update;
  if not found then raise exception 'reconcile_discovery_smoke_operation: no authorization for this queue row'; end if;
  perform pg_advisory_xact_lock(hashtext('agentory.discovery_smoke.liability'));
  select * into o from public.discovery_smoke_operations where authorization_id = a.id and operation_key = p_key;
  if not found or o.kind <> 'provider' then
    raise exception 'reconcile_discovery_smoke_operation: % is not a provider purchase of this authorization', p_key;
  end if;
  select * into r from public.discovery_smoke_reconciliations where authorization_id = a.id and operation_key = p_key;
  if found then
    if r.vendor_microusd is distinct from p_vendor_microusd or r.vendor_ref is distinct from p_vendor_ref then
      raise exception 'reconcile_discovery_smoke_operation: % is already reconciled differently', p_key;
    end if;
  else
    insert into public.discovery_smoke_reconciliations (authorization_id, operation_key, vendor_microusd, vendor_ref)
    values (a.id, p_key, p_vendor_microusd, trim(p_vendor_ref)) returning * into r;
    if p_vendor_microusd > o.committed_microusd and a.status = 'active' then
      update public.discovery_smoke_authorizations
         set status = 'stopped', stop_reason = 'reconciled_charge_exceeded_quote:' || p_key
       where id = a.id;
    end if;
  end if;
  return jsonb_build_object('operation_key', p_key, 'vendor_microusd', r.vendor_microusd,
    'committed_microusd', o.committed_microusd, 'exceeded', r.vendor_microusd > o.committed_microusd);
end $$;

-- One-way. There is no restart or reset.
create function public.stop_discovery_smoke(p_queue uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.discovery_smoke_authorizations
     set status = 'stopped', stop_reason = coalesce(nullif(trim(p_reason), ''), 'stopped')
   where queue_id = p_queue and status = 'active';
  return found;
end $$;

revoke all on function public.authorize_discovery_smoke(uuid, text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.reconcile_discovery_smoke_operation(uuid, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.admit_discovery_smoke(uuid, uuid, uuid, integer, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_discovery_smoke_receipt(uuid, text, uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.stop_discovery_smoke(uuid, text) from public, anon, authenticated;
grant execute on function public.admit_discovery_smoke(uuid, uuid, uuid, integer, text, text, text, text, text, text) to service_role;
grant execute on function public.record_discovery_smoke_receipt(uuid, text, uuid, text, text, bigint, text) to service_role;
grant execute on function public.stop_discovery_smoke(uuid, text) to service_role;
