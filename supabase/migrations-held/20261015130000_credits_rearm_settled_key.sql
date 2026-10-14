-- HELD. Not applied anywhere except the disposable database-contract lane
-- (tests/db-contract/bootstrap.sh). Billing change: needs explicit approval
-- before it is applied to any hosted project. See supabase/migrations-held/README.md.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
--
-- `credits_reserve` replays ANY existing transaction for a key. A reservation
-- that was REFUNDED is replayed too:
--
--   * settled `not_charged`: the call did not start (refused before dispatch,
--     a 4xx, a stop gate), so the credit went back;
--   * `released` by `credits_release_stale`: nobody settled it in 30 minutes.
--
-- A later attempt under the same key, the same logical call retried, then got
-- `ok: true` with NO balance check (an enforce-mode workspace at 0 credits was
-- waved through), and `credits_finalize` on the refunded row replayed it and
-- charged 0. A real purchase went uncharged.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
--
-- A refunded key is RE-ARMED, in place:
--   * the same conditional debit as a new reservation, so an insufficient
--     balance refuses and leaves the refunded row exactly as it was;
--   * the row returns to `reserved` with this attempt's amount;
--   * `rearmed_at` and `rearm_count` record it.
-- The row is locked (`FOR UPDATE`) first, so concurrent attempts re-arm once and
-- the rest replay the re-armed row.
--
-- Unchanged: a key that is `reserved` (in flight), `charged` or `partial`
-- (money taken) or `granted` is still a replay. The same purchase is never
-- charged twice. `credits_finalize` is untouched.
--
-- The stale reaper's 30-minute window runs from the re-arm (`rearmed_at`), not
-- from the row's first reservation; otherwise a re-armed row created long ago
-- would be refunded under the call that is running now.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
--
-- * Concurrent purchases of one key by two generations stay the
--   provider-purchase-claims proposal's job (20261015120000, separate, held).
-- * `monitoring_spend_in_period` still windows on `created_at`. A re-armed
--   monitoring charge counts in its key's first period. Monitoring keys are
--   per-pass, so this is not expected to occur; noted rather than widened.
-- * The first refund's amounts are overwritten when the row is re-armed (the
--   table keeps one row per key). `reason`, `rearmed_at` and `rearm_count`
--   say that it happened.
--
-- Rollback: rollback/20261015130000_credits_rearm_settled_key.down.sql restores
-- both functions verbatim from the baseline, then drops the two columns.

alter table public.credit_transactions
  add column if not exists rearmed_at timestamptz,
  add column if not exists rearm_count integer not null default 0;

create or replace function public.credits_reserve(
  p_workspace uuid, p_amount integer, p_idempotency_key text, p_kind text,
  p_task_id uuid default null::uuid, p_company_key text default null::text
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_existing public.credit_transactions%rowtype;
  v_balance  integer;
  v_txn_id   uuid;
begin
  if p_amount is null or p_amount < 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'missing_idempotency_key');
  end if;

  select * into v_existing from public.credit_transactions
   where workspace_id = p_workspace and idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing.status not in ('not_charged', 'released') then
      return jsonb_build_object(
        'ok', true, 'replayed', true,
        'transaction_id', v_existing.id, 'status', v_existing.status,
        'reserved_credits', v_existing.reserved_credits);
    end if;

    -- RE-ARM a refunded key: the same conditional debit as a new reservation.
    if p_amount > 0 then
      update public.workspace_credit_balances
         set balance_credits  = balance_credits  - p_amount,
             reserved_credits = reserved_credits + p_amount,
             updated_at = now()
       where workspace_id = p_workspace
         and balance_credits >= p_amount
      returning balance_credits into v_balance;

      if not found then
        select balance_credits into v_balance
          from public.workspace_credit_balances where workspace_id = p_workspace;
        return jsonb_build_object('ok', false, 'error', 'insufficient_credits',
          'balance', coalesce(v_balance, 0), 'needed', p_amount);
      end if;
    else
      select balance_credits into v_balance
        from public.workspace_credit_balances where workspace_id = p_workspace;
    end if;

    update public.credit_transactions
       set status = 'reserved',
           estimated_credits = p_amount,
           reserved_credits = p_amount,
           actual_credits = 0,
           refunded_credits = 0,
           finalized_at = null,
           task_id = coalesce(p_task_id, task_id),
           reason = 're-armed after ' || v_existing.status,
           rearmed_at = now(),
           rearm_count = v_existing.rearm_count + 1
     where id = v_existing.id;

    return jsonb_build_object('ok', true, 'replayed', false, 'rearmed', true,
      'transaction_id', v_existing.id, 'balance_after', coalesce(v_balance, 0));
  end if;

  if p_amount > 0 then
    update public.workspace_credit_balances
       set balance_credits  = balance_credits  - p_amount,
           reserved_credits = reserved_credits + p_amount,
           updated_at = now()
     where workspace_id = p_workspace
       and balance_credits >= p_amount
    returning balance_credits into v_balance;

    if not found then
      select balance_credits into v_balance
        from public.workspace_credit_balances where workspace_id = p_workspace;
      return jsonb_build_object('ok', false, 'error', 'insufficient_credits',
        'balance', coalesce(v_balance, 0), 'needed', p_amount);
    end if;
  else
    select balance_credits into v_balance
      from public.workspace_credit_balances where workspace_id = p_workspace;
  end if;

  begin
    insert into public.credit_transactions(
      workspace_id, idempotency_key, kind, status,
      estimated_credits, reserved_credits, task_id, company_key)
    values (p_workspace, p_idempotency_key, p_kind, 'reserved',
      p_amount, p_amount, p_task_id, p_company_key)
    returning id into v_txn_id;
  exception when unique_violation then
    if p_amount > 0 then
      update public.workspace_credit_balances
         set balance_credits  = balance_credits  + p_amount,
             reserved_credits = reserved_credits - p_amount,
             updated_at = now()
       where workspace_id = p_workspace;
    end if;
    select * into v_existing from public.credit_transactions
     where workspace_id = p_workspace and idempotency_key = p_idempotency_key;
    return jsonb_build_object('ok', true, 'replayed', true,
      'transaction_id', v_existing.id, 'status', v_existing.status,
      'reserved_credits', v_existing.reserved_credits);
  end;

  return jsonb_build_object('ok', true, 'replayed', false,
    'transaction_id', v_txn_id, 'balance_after', coalesce(v_balance, 0));
end;
$$;

create or replace function public.credits_release_stale(
  p_older_than interval default '00:30:00'::interval
) returns integer
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_txn public.credit_transactions%rowtype;
  v_n   integer := 0;
begin
  for v_txn in
    select * from public.credit_transactions
     where status = 'reserved'
       and coalesce(rearmed_at, created_at) < now() - p_older_than
     for update skip locked
  loop
    perform public.credits_finalize(
      v_txn.id, 0, 'released', 'stale reservation released by reaper');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- `create or replace` keeps existing grants; restated so this file alone
-- leaves the lock-down (20260929120000) in force.
revoke execute on function public.credits_reserve(uuid, integer, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.credits_release_stale(interval) from public, anon, authenticated;
grant execute on function public.credits_reserve(uuid, integer, text, text, uuid, text) to service_role;
grant execute on function public.credits_release_stale(interval) to service_role;
