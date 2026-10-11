-- LEAD MISSION V2 — A PRODUCTIVE CONTINUATION DOES NOT WAIT LIKE A RETRY.
--
-- HELD. NOT APPLIED. Must not be applied to production without a deliberate,
-- separate approval (see supabase/migrations-held/README.md).
--
-- ── THE COST ────────────────────────────────────────────────────────────────
--
-- Query B rerun (task 255c333f, production, 2026-10-10): 9 slices, 48.2 min,
-- of which 1,054 s (36%) was queue gap. `release_lead_mission` sets
-- `not_before = now() + 2 minutes` on EVERY resumable release, so a slice that
-- had just run cleanly and had candidates ready to investigate sat idle for two
-- minutes before any worker could claim it — eight times.
--
-- ── THE RULE ────────────────────────────────────────────────────────────────
--
-- The hold is lifted for ONE case, and both halves must hold:
--
--   v_slice     the lineage's own slice counter moved past what the queue has
--               seen — the same test (20261003120000) that refunds the claim,
--               so a 409, a refusal or any run that folded nothing is excluded;
--   immediate   the worker states, in the outcome document, that the run's own
--               continuation decision was `immediate` (`p_outcome->>'dispatch'`,
--               set by `continuationDispatch` in leadMissionTerminal.ts from
--               `IMMEDIATE_CONTINUATION_REASONS`).
--
-- Everything else keeps `now() + 2 minutes`, unchanged:
--   • a retry (fault, abort, error)   — not a clean continuation;
--   • a no-op run                     — the slice counter did not move;
--   • waiting on a provider run       — `awaiting_provider_run` is `deferred`:
--                                       the backoff IS its cadence (run 8f59170d
--                                       spun ten slices in 40 s without one);
--   • an unknown decision             — the worker states `deferred`.
-- Terminal releases (`complete` / `failed` / `cancelled`) still clear
-- `not_before`; claim, lease expiry and every counter are untouched.
--
-- ── COMPATIBILITY ───────────────────────────────────────────────────────────
--
--   • Same signature as 20261003120000; `create or replace` only. PostgREST,
--     the worker's 5- and 4-argument fallbacks and the grants are unchanged.
--   • An old worker states no `dispatch`: the 2-minute hold, exactly as today.
--   • A new worker against a database WITHOUT this migration: the extra key in
--     `p_outcome` is stored in `last_outcome` and otherwise ignored — the hold
--     stays. Either deploy order is safe.
--
-- Depends on 20260910140000 and 20261003120000.
-- Rollback: supabase/migrations-held/rollback/20261011120000_lead_mission_v2_productive_continuation_no_backoff.down.sql
-- Tested against real Postgres (PGlite):
--   tests/infra/leadMissionV2ProductiveContinuationNoBackoff.test.ts

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
  v_immediate boolean;
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
  -- PRODUCTIVE AND READY NOW: a new slice ran, and the worker states the run's
  -- own continuation decision was immediate. Anything else keeps the backoff.
  v_immediate := v_slice and coalesce(p_outcome->>'dispatch', '') = 'immediate';
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
         not_before       = case when v_final = 'resumable' and v_immediate then null
                                     when v_final = 'resumable' then now() + interval '2 minutes'
                                     else null end,
         last_outcome     = p_outcome,
         updated_at       = now()
   where id = p_queue_id;

  return query select true, v_final, v_reason, v_attempts, v_cont;
end;
$function$;

revoke all on function public.release_lead_mission(uuid, uuid, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.release_lead_mission(uuid, uuid, text, jsonb, integer) to service_role;
