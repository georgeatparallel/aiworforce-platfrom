-- ============================================================================
-- SUPABASE PLATFORM SHIM — DISPOSABLE TEST DATABASES ONLY
-- ============================================================================
--
-- The repository's schema is a pg_dump of a Supabase project. Supabase creates
-- these objects BEFORE any migration runs; a plain `postgres` image does not
-- have them. This file creates the smallest faithful stand-in so the real
-- baseline and migrations apply unchanged. Every shim is listed here, and the
-- contract tests never depend on a shim's behaviour beyond what is noted.
--
--   roles     anon, authenticated, service_role (BYPASSRLS), authenticator
--             (the PostgREST login role). Same names and grant shape as
--             Supabase; PostgREST switches into the role named by the JWT.
--   auth      auth.users (id, email, metadata) and auth.uid() / auth.role() /
--             auth.jwt(), reading `request.jwt.claims` exactly as Supabase's
--             own definitions do.
--   extensions  pgcrypto and uuid-ossp installed into schema `extensions`,
--             where Supabase installs them.
--   storage   storage.buckets / storage.objects (the columns the migrations
--             touch) and storage.foldername(). No file storage behind them.
--   cron      cron.job plus cron.schedule()/cron.unschedule() that RECORD a
--             job and never run it. No scheduler exists in the test database.
--   net       net.http_post() RAISES if called. It only appears inside cron
--             command text, which nothing executes here.
--   vault     vault.decrypted_secrets: an empty view. No secret exists.
--   realtime  publication `supabase_realtime`, empty; the baseline adds tables
--             to it. Nothing subscribes in the test database.
--
-- Never apply this to a Supabase project: every object here already exists
-- there, with the real implementation.
-- ============================================================================

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create table if not exists auth.users (
  id uuid primary key default extensions.gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')), '')::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid,
  metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;

create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;

create schema if not exists net;
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint
language plpgsql as $$ begin
  raise exception 'net.http_post is a shim in the database-contract lane; nothing may call out';
end $$;

create schema if not exists vault;
create or replace view vault.decrypted_secrets as
  select null::uuid as id, null::text as name, null::text as decrypted_secret where false;

set client_min_messages = error;  -- "wal_level is insufficient": nothing replicates here
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
reset client_min_messages;
