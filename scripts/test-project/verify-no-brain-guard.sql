-- READ ONLY, administrator on the independently confirmed isolated TEST project.
-- Run before seeding/authorization, in addition to discovery-smoke-preflight.sql.
\set ON_ERROR_STOP on
begin read only;
do $$ begin
  if not exists(select 1 from pg_trigger where tgrelid='public.company_brain'::regclass
      and tgname='discovery_test_no_company_brain' and tgenabled='A'
      and tgfoid=to_regprocedure('public.discovery_test_refuse_company_brain()'))
     or not exists(select 1 from pg_trigger where tgrelid='public.discovery_smoke_authorizations'::regclass
      and tgname='discovery_test_no_brain_authorization' and tgenabled='A'
      and tgfoid=to_regprocedure('public.discovery_test_check_no_brain_authorization()')) then
    raise exception 'isolated test no-Brain guard not installed and ALWAYS enabled';
  end if;
  if exists(select 1 from public.company_brain) then
    raise exception 'isolated test project contains a Company Brain';
  end if;
end $$;
rollback;
