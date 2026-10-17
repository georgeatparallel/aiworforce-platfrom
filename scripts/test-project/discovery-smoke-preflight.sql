-- READ ONLY. Run only against the operator-confirmed isolated TEST project:
-- psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v workspace_id='<UUID>' -f scripts/test-project/discovery-smoke-preflight.sql
-- This refuses failed prerequisites. It neither authorizes a mission nor locks
-- out future Brain edits. Keep the isolated workspace unchanged until testing ends.
\set ON_ERROR_STOP on
begin read only;
select set_config('agentory.preflight_workspace', :'workspace_id', true);
do $preflight$
declare
  ws uuid := current_setting('agentory.preflight_workspace')::uuid;
begin
  if not exists(select 1 from public.workspaces where id=ws) then
    raise exception 'smoke preflight: test workspace does not exist';
  end if;
  if exists(select 1 from public.company_brain where workspace_id=ws) then
    raise exception 'smoke preflight: Company Brain must be absent';
  end if;
  if exists(select 1 from public.discovery_smoke_operations o where o.kind='provider'
      and not exists(select 1 from public.discovery_smoke_reconciliations r
        where r.authorization_id=o.authorization_id and r.operation_key=o.operation_key
          and r.vendor_microusd<=o.committed_microusd)) then
    raise exception 'smoke preflight: unresolved provider liability';
  end if;
  if has_function_privilege('service_role','public.authorize_discovery_smoke(uuid,text,jsonb,jsonb,integer)','execute')
     or has_function_privilege('service_role','public.reconcile_discovery_smoke_operation(uuid,text,bigint,text,text)','execute')
     or has_table_privilege('service_role','public.discovery_smoke_authorizations','update')
     or has_table_privilege('service_role','public.discovery_smoke_operations','insert') then
    raise exception 'smoke preflight: worker has administrative smoke privileges';
  end if;
  if exists(select 1 from cron.job where command ilike '%net.http_post%' or command ilike '%supabase.co%') then
    raise exception 'smoke preflight: cron can call a hosted project';
  end if;
end $preflight$;
rollback;
