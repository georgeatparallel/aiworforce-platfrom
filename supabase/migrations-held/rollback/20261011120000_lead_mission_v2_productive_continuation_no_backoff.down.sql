-- ROLLBACK for 20261011120000_lead_mission_v2_productive_continuation_no_backoff.sql
--
-- Restores `release_lead_mission` VERBATIM from
-- 20261003120000_lead_mission_v2_continuations_not_retries.sql (a test asserts
-- the definitions are byte-identical): every resumable release is held for 2
-- minutes again. The worker needs no rollback — against this function the
-- `dispatch` key it states is stored in `last_outcome` and ignored.
--
-- No row is rewritten. A row released under the new rule with `not_before`
-- null is simply claimable; it was a productive slice.

begin;

create or replace function public.release_lead_mission(
  p_queue_id uuid,
  p_worker_id uuid,
  p_status text,
  p_outcome jsonb default null,
  -- `lead_lineage_progress.continuations_used` after a CLEAN continuation;
  -- null for anything else. See the header.
  p_lineage_slices integer default null
)
returns table(
  released boolean, final_status text, reason text, attempts integer, continuations integer
)
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_q        public.lead_mission_queue%rowtype;
  v_final    text;
  v_reason   text := null;
  v_slice    boolean;
  v_attempts integer;
  v_cont     integer;
begin
  if p_status not in ('complete', 'resumable', 'failed', 'cancelled') then
    raise exception 'invalid lead mission release status: %', p_status;
  end if;

  select * into v_q from public.lead_mission_queue where id = p_queue_id for update;
  if not found or v_q.claimed_by is distinct from p_worker_id then
    return query select false, null::text, null::text, null::integer, null::integer; return;
  end if;

  -- A NEW slice, provably: the lineage's own counter moved past what the queue
  -- has already seen. Equal or lower — a no-op run — refunds nothing.
  v_slice := p_status = 'resumable'
             and p_lineage_slices is not null
             and p_lineage_slices > v_q.continuations;
  v_attempts := case when v_slice then greatest(v_q.attempts - 1, 0) else v_q.attempts end;
  v_cont     := case when v_slice then p_lineage_slices else v_q.continuations end;

  v_final := case
    -- A cancellation that landed mid-run is never overwritten.
    when v_q.status = 'cancelled' then 'cancelled'
    -- Every ceiling the lineage has should have ended it before this.
    when p_status = 'resumable' and v_cont >= 25 then 'failed'
    -- Out of retries: stop, visibly, rather than retry for ever.
    when p_status = 'resumable' and v_attempts >= 5 then 'failed'
    else p_status
  end;
  if v_final = 'failed' and p_status = 'resumable' and v_q.status <> 'cancelled' then
    v_reason := case when v_cont >= 25 then 'slices_exhausted' else 'attempts_exhausted' end;
  end if;

  update public.lead_mission_queue
     set status           = v_final,
         claimed_by       = null,
         lease_expires_at = null,
         attempts         = v_attempts,
         continuations    = v_cont,
         not_before       = case when v_final = 'resumable' then now() + interval '2 minutes' else null end,
         last_outcome     = p_outcome,
         updated_at       = now()
   where id = p_queue_id;

  return query select true, v_final, v_reason, v_attempts, v_cont;
end;
$function$;

revoke all on function public.release_lead_mission(uuid, uuid, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.release_lead_mission(uuid, uuid, text, jsonb, integer) to service_role;

commit;
