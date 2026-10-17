-- THE SMOKE'S RECONCILIATION LIST: every provider purchase of this mission
-- that is still open liability. Read-only. Run against the TEST project
-- after the mission and before anything else runs
-- (docs/launch/discovery-smoke-readiness.md, §7.E):
--
--   psql "$TEST_DB_URL" -v queue_id='<queue uuid>' -f scripts/test-project/smoke-reconciliation.sql
--
-- A row here is NOT a charge; it is a purchase carried at its committed
-- maximum until an administrator records the vendor's own figure (Apify's run
-- history: the run's terminal status and its final `usageTotalUsd`):
--
--   select public.reconcile_discovery_smoke_operation(
--     '<queue uuid>', '<operation_key>', <vendor micro-USD>, '<vendor run URL or export reference>',
--     '<SUCCEEDED | FAILED | ABORTED | TIMED-OUT | NO_RUN>');
--
-- Only once the authorization is no longer live (stopped, or past its
-- deadline) and the run is terminal. `NO_RUN` (figure 0) is for a start with no
-- run id that the vendor's history shows never ran.
--
-- `state` is `open` (not reconciled) or `held_above_quote`: the vendor's
-- figure exceeded the committed maximum, so the approved bound was wrong. A
-- held purchase is not closed by reconciliation; it blocks every later smoke
-- until the database owner reviews the catalog and decides.
--
-- `receipt` says how much work that is: `unsettled` (the final run whose
-- receipt the five-read plan deferred, a run left pending, a receipt read the
-- plan could not make, an answer lost) needs the figure looked up; `settled`
-- carries the worker's settled receipt, which is evidence to confirm, not a
-- reconciliation — the worker writes `report_source`, so no label it records
-- closes a purchase.
--
-- Until every purchase of every smoke is closed, `authorize_discovery_smoke`
-- refuses any new smoke and no other authorization may spend. An empty result
-- means this mission's purchases are all closed. Exits 0 either way; the
-- operator reads the rows.
select o.operation_key,
       case when r.operation_key is null then 'open' else 'held_above_quote' end as state,
       o.actor,
       o.provider_run_id,
       o.committed_microusd,
       o.reported_microusd,
       r.vendor_microusd,
       coalesce(o.report_source, 'none') as report_source,
       case when o.report_source = 'apify_run(settled).receipt' then 'settled' else 'unsettled' end as receipt,
       o.admitted_at
  from public.discovery_smoke_operations o
  join public.discovery_smoke_authorizations a on a.id = o.authorization_id
  left join public.discovery_smoke_reconciliations r
    on r.authorization_id = o.authorization_id and r.operation_key = o.operation_key
 where a.queue_id = :'queue_id'::uuid
   and o.kind = 'provider'
   and (r.operation_key is null or r.vendor_microusd > o.committed_microusd)
 order by o.admitted_at;
