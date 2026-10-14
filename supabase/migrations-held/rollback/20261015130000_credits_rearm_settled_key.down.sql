-- ROLLBACK for 20261015130000_credits_rearm_settled_key.sql
--
-- Restores `credits_reserve` and `credits_release_stale` VERBATIM from the
-- baseline (20260816120000_baseline_schema.sql; a test asserts the bodies are
-- byte-identical), restates the lock-down grants, then drops the two columns.
--
-- Rows are not rewritten. A transaction re-armed under the fix keeps its
-- current status: a re-armed `reserved` row settles or is reaped exactly as
-- before, and its `reason` still says it was re-armed.

CREATE OR REPLACE FUNCTION public.credits_reserve(p_workspace uuid, p_amount integer, p_idempotency_key text, p_kind text, p_task_id uuid DEFAULT NULL::uuid, p_company_key text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
   where workspace_id = p_workspace and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'transaction_id', v_existing.id, 'status', v_existing.status,
      'reserved_credits', v_existing.reserved_credits);
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

CREATE OR REPLACE FUNCTION public.credits_release_stale(p_older_than interval DEFAULT '00:30:00'::interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_txn public.credit_transactions%rowtype;
  v_n   integer := 0;
begin
  for v_txn in
    select * from public.credit_transactions
     where status = 'reserved' and created_at < now() - p_older_than
     for update skip locked
  loop
    perform public.credits_finalize(
      v_txn.id, 0, 'released', 'stale reservation released by reaper');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.credits_reserve(uuid, integer, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.credits_release_stale(interval) from public, anon, authenticated;
grant execute on function public.credits_reserve(uuid, integer, text, text, uuid, text) to service_role;
grant execute on function public.credits_release_stale(interval) to service_role;

alter table public.credit_transactions
  drop column if exists rearm_count,
  drop column if exists rearmed_at;
