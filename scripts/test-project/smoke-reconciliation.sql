-- THE SMOKE'S RECEIPT RECONCILIATION: every Apify purchase whose figure is not
-- settled. Read-only. Run against the TEST project after the mission and
-- before anything else runs (docs/launch/discovery-smoke-readiness.md, §7.E):
--
--   psql "$TEST_DB_URL" -v queue_id='<queue uuid>' -f scripts/test-project/smoke-reconciliation.sql
--
-- A row here is NOT a charge; it is a purchase whose charge the mission could
-- not read as settled (a run left pending, a receipt read the plan could not
-- make, an answer lost). Each one is closed only against the vendor's own
-- record: Apify's run history and its final `usageTotalUsd`. An empty result
-- means every Apify purchase carries a settled figure
-- (`apify_run(settled).receipt`, recorded by the gate). Exits 0 either way;
-- the operator reads the rows.
select o.operation_key,
       o.actor,
       o.provider_run_id,
       o.committed_microusd,
       o.reported_microusd,
       coalesce(o.report_source, 'none') as report_source,
       o.admitted_at
  from public.discovery_smoke_operations o
  join public.discovery_smoke_authorizations a on a.id = o.authorization_id
 where a.queue_id = :'queue_id'::uuid
   and o.kind = 'provider'
   and o.actor like 'apify:%'
   and o.report_source is distinct from 'apify_run(settled).receipt'
 order by o.admitted_at;
