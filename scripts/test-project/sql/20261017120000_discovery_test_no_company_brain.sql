-- TEST PROJECT ONLY. Optional fresh-install guard, never a production migration.
-- Install after the held smoke admission, BEFORE creating any workspace.
-- This dedicated smoke project must never contain a Company Brain, including
-- after cancellation/expiry. Removing this guard requires administrator DDL
-- and a separate review; stopping an authorization does not unlock Brain writes.
-- No customer workspace or existing project is a valid installation target.
do $$ begin
  if to_regprocedure('public.authorize_discovery_smoke(uuid,text,jsonb,jsonb,integer)') is null then
    raise exception 'test no-Brain guard requires held smoke admission';
  end if;
  if exists(select 1 from public.workspaces) or exists(select 1 from public.company_brain) then
    raise exception 'test no-Brain guard requires a fresh empty test project, before any workspace';
  end if;
end $$;

create function public.discovery_test_refuse_company_brain()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='23514', message='isolated Discovery test: Company Brain writes are forbidden';
end $$;
revoke all on function public.discovery_test_refuse_company_brain() from public, anon, authenticated, service_role;

-- Unconditional refusal has no check/insert window or snapshot dependency.
-- Covers INSERT/COPY/UPSERT, UPDATE and workspace reassignment, including the
-- BYPASSRLS worker. ALWAYS also covers replica-mode writes; an owner can still
-- disable/drop a trigger and is outside the worker's privilege boundary.
create trigger discovery_test_no_company_brain
before insert or update on public.company_brain
for each row execute function public.discovery_test_refuse_company_brain();
alter table public.company_brain enable always trigger discovery_test_no_company_brain;

create function public.discovery_test_check_no_brain_authorization()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists(select 1 from pg_trigger
      where tgrelid='public.company_brain'::regclass
        and tgname='discovery_test_no_company_brain' and tgenabled='A'
        and tgfoid='public.discovery_test_refuse_company_brain()'::regprocedure)
     or exists(select 1 from public.company_brain where workspace_id=new.workspace_id) then
    raise exception 'isolated Discovery test: no-Brain guard missing, disabled, or workspace has a Company Brain';
  end if;
  return new;
end $$;
revoke all on function public.discovery_test_check_no_brain_authorization() from public, anon, authenticated, service_role;
create trigger discovery_test_no_brain_authorization
before insert on public.discovery_smoke_authorizations
for each row execute function public.discovery_test_check_no_brain_authorization();
alter table public.discovery_smoke_authorizations enable always trigger discovery_test_no_brain_authorization;
