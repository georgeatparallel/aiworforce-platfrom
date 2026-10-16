-- Rollback for 20261015140000_discovery_smoke_admission.sql. HELD, like it.
--
-- REFUSES while any authorization or operation exists, even a stopped one:
-- those rows are the only durable record of what a mission may have bought,
-- including uncertain purchases nobody has reconciled. Before rolling back
-- after use: stop the worker, cancel the queue row, reconcile every operation
-- against the vendors' own run history, export both tables, and get an
-- explicit archival decision. Keeping the inactive schema is the default.
--
-- Rolling back cannot reopen spending: the runtime gate refuses every billable
-- transport when these RPCs are missing (DISCOVERY_SMOKE_ADMISSION enforced).
-- One transaction, so a client that continues after an error changes nothing.
begin;
do $$ begin
  if exists (select 1 from public.discovery_smoke_authorizations)
     or exists (select 1 from public.discovery_smoke_operations) then
    raise exception 'discovery smoke audit rows exist: reconcile, export and approve archival before rollback';
  end if;
end $$;
drop function public.stop_discovery_smoke(uuid, text);
drop function public.reconcile_discovery_smoke_operation(uuid, text, bigint, text);
drop function public.record_discovery_smoke_receipt(uuid, text, uuid, text, text, bigint, text);
drop function public.admit_discovery_smoke(uuid, uuid, uuid, integer, text, text, text, text, text, text);
drop function public.authorize_discovery_smoke(uuid, text, jsonb, jsonb, integer);
drop table public.discovery_smoke_reconciliations;
drop table public.discovery_smoke_operations;
drop table public.discovery_smoke_authorizations;
commit;
