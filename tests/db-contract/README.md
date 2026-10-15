# Database contract lane

A real Postgres, a real PostgREST and the repository's real Supabase client
(`https://esm.sh/@supabase/supabase-js@2`, the exact specifier run-agent and
the worker import), exercising the production query modules. It exists
because the offline fakes accept queries PostgREST rejects: the first D1
version (`fencedTaskUpdate` asking for `select=id` beside an `or` filter) passed
every offline test and failed against PostgREST with 42703 on every open-row
write (PR #73, fixed in `b9fa8516`).

CI: `.github/workflows/db-contract.yml`, **advisory** (its own workflow, not a
required check).

## What it covers

| File | What |
|---|---|
| `fencedWrite.contract.test.ts` | D1: `fencedTaskUpdate` own/stale generation, finalized rows, unknown generation, follow-ups, errors vs refusals, `resolveSliceGeneration`, and end to end with `claim_sourcing_continuation` advancing the generation. Documents the 42703 itself. |
| `lineageQueue.contract.test.ts` | Lineage lease acquire / refuse / release / version conflict / terminal (`lineageLease.ts`); the worker's D4 lineage read, verbatim from `worker/main.ts`, through `mapTaskOutcome`; continuation claims refused on cancelled/terminal lineages and released (`continuationClaim.ts`); the V2 queue: claim, heartbeat, bind, a stranger's heartbeat refused, lease-expiry reclaim, a stale release refused, a clean continuation refunded (`releaseQueuedMission`), a terminal release never reclaimed. |
| `ledgerSpend.contract.test.ts` | The ledger writer (spec identity columns, same-key attempt escalation, finalize); D2's `readPriorPurchases` (adopt by run id, uncertain, refusals, workspace / record-kind scoping); the durable spend floor (`readLineageSpendFloor`, re-reads excluded); `credits_reserve` / `credits_finalize` through `creditAuthorization.ts` (one reservation per key, replay, settle, refund, refusal). |
| `creditRearm.contract.test.ts` | Credit keys through `creditAuthorization.ts`: a key refunded (`not_charged`) or reaper-`released` and then really bought is re-armed, balance-checked and charged; a refused re-arm leaves the row as it was; concurrent re-arms hold once; the reaper's window runs from the re-arm; charged and in-flight keys still replay. Needs the held billing fix (step 5 below). |
| `schemaCompat.contract.test.ts` | Every literal `.from(…).select(…)` in run-agent, the worker and `_shared/` — projection, filter columns and `or` filters — executed against the migrated schema; every literal `.rpc(…, {…})` checked against the function's real arguments; the Lead V2 RPC signatures pinned. Non-literal selects are listed, not silently skipped. Includes a self-test that the sweep catches a bad column. |
| `mutation.sh` | Two proofs. (1) Copies `mutants/fencedTaskWrite.pre-d1-fix.ts` (the pre-fix module, verbatim) over the real one and **requires** the fenced-write contract to fail on the write itself. (2) Builds the database without the held billing fix (`DB_CONTRACT_OMIT_HELD`) and **requires** the credit re-arm test to fail on the uncharged purchase. |

## Running it

```sh
PG_ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/postgres \
POSTGREST_BIN=/path/to/postgrest \
tests/db-contract/run.sh            # or a single file as the argument
tests/db-contract/mutation.sh
```

`run.sh` creates `contract_<random>` on that server, builds it with
`bootstrap.sh`, generates an `authenticator` password and a JWT secret, starts
PostgREST on a free localhost port, runs the tests and drops the database.
Both scripts refuse a non-localhost URL.

## The database it builds (`bootstrap.sh`)

1. `sql/00_supabase_shim.sql` — the Supabase platform objects a plain Postgres
   lacks (below).
2. `supabase/migrations-held/20260816120000_baseline_schema.sql`.
3. Every file in `supabase/migrations/`, in order.
4. The held Lead V2 queue chain: `20260910140000_lead_mission_v2_claim`,
   `20260915120000_sweep_skips_v2_queue_tasks`,
   `20261003120000_lead_mission_v2_continuations_not_retries`,
   `20261011120000_lead_mission_v2_productive_continuation_no_backoff`.
   **Applied to this disposable database only.** They are not approved for
   production (`supabase/migrations-held/README.md`).
5. The held billing fix `20261015130000_credits_rearm_settled_key`, which
   re-arms refunded credit keys. Same rule: this database only. It needs billing
   sign-off before any hosted project.

## Shims (explicit, and the only ones)

| Shim | Stands in for | Behaviour here |
|---|---|---|
| roles `anon`, `authenticated`, `service_role` (BYPASSRLS), `authenticator` | Supabase's roles | Same names and grant shape; PostgREST switches to the JWT's role. |
| `auth.users`, `auth.uid()`, `auth.role()`, `auth.jwt()` | GoTrue's schema | Read `request.jwt.claims` like Supabase's definitions. No users are created. |
| `extensions` schema with `pgcrypto`, `uuid-ossp` | Supabase's extension schema | Real extensions. |
| `storage.buckets`, `storage.objects`, `storage.foldername()` | Supabase Storage | Tables only; no files. |
| `cron.job`, `cron.schedule()`, `cron.unschedule()` | pg_cron | Records jobs, never runs them. |
| `net.http_post()` | pg_net | **Raises** if called. Only appears in cron command text. |
| `vault.decrypted_secrets` | Supabase Vault | Empty view. |
| publication `supabase_realtime` | Realtime | Empty publication. |

The contract tests depend on none of these beyond the roles and the schemas
existing.

## Versions

| | This lane | Production |
|---|---|---|
| Postgres | CI `postgres:17.6`; verified locally on 17.11 | **Not recorded in the repository.** The baseline was dumped by `pg_dump` 17 (it sets `transaction_timeout`, a 17-only setting), so a 17 server is the likely match. Confirm in the Supabase dashboard (Settings → Infrastructure). |
| PostgREST | v12.2.3 (static x64, sha256 pinned) | **Not recorded.** Supabase manages it per project; confirm in the dashboard and update `POSTGREST_VERSION` / `POSTGREST_SHA256`. |
| supabase-js | `esm.sh/@supabase/supabase-js@2`, the runtime's own (unpinned minor) specifier | Same specifier. |
| PostgREST settings | `db-max-rows=1000`, `db-extra-search-path=public,extensions` (Supabase's hosted defaults) | Supabase defaults; confirm under API settings if changed. |

## Limits

- It proves query and RPC compatibility with the schema the migrations build,
  not with production's actual schema: drift between the two needs a separate
  read-only schema diff.
- It runs as `service_role` (RLS bypassed), as the runtime does. RLS policies
  for user-facing reads are not exercised here, and neither are the
  per-role `statement_timeout`s Supabase sets for `anon` / `authenticated`.
- No Supabase gateway (Kong) or GoTrue sits in front: the client's `/rest/v1`
  path is rewritten straight to PostgREST, and the key is a locally minted
  service-role JWT.
- The worker's queries that live inline in `worker/main.ts` are tested from
  their source text (the sweep, and verbatim string checks), not by importing
  the worker, which starts a process when imported as main.
