-- Rollback of the PROPOSED 20261015120000_provider_purchase_claims.sql.
-- Nothing reads these objects until the runtime is wired to them; dropping them
-- returns every caller to today's behaviour (PGRST202 / 42883 → fallback).
drop function if exists public.settle_provider_purchase(uuid, text, text);
drop function if exists public.attach_purchase_run(uuid, text, text);
drop function if exists public.claim_provider_purchase(uuid, text, uuid, integer);
drop table if exists public.provider_purchase_claims;
