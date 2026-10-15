-- Review artifact only: atomic even if a SQL client continues after an error.
begin;
-- PROPOSAL ONLY. Refuse destructive rollback while any authorization/audit exists.
-- Stop admissions/worker first; reconcile all possible liability and export the
-- immutable audit. Removing runtime wiring must fail closed, never bypass budget.
do $$ begin
  if exists (select 1 from public.discovery_smoke_authorizations)
     or exists (select 1 from public.discovery_smoke_operations) then
    raise exception 'smoke audit exists: retain schema; reconcile and approve archival before rollback';
  end if;
end $$;
drop function public.stop_discovery_smoke(uuid);
drop function public.record_discovery_smoke_receipt(uuid,text,uuid,text,jsonb);
drop function public.admit_discovery_smoke(uuid,uuid,uuid,integer,text,text,text,text,text,bigint,jsonb,text);
drop function public.authorize_discovery_smoke(uuid,uuid,text,text,jsonb);
drop table public.discovery_smoke_operations;
drop table public.discovery_smoke_authorizations;

commit;
