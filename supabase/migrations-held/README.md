# Held migrations — NOT applied, and never to be applied to production as-is

These files are kept out of `supabase/migrations/` on purpose. That directory
is synced to the production-connected repository (Lovable builds from its
`main`), and nothing here may be picked up and run against the live project
(`ohsdatpvfdjdemstoiuj`) by any tool.

Migrations are applied to production one at a time, deliberately — see
`docs/SUPABASE_TARGETING.md`.

## `20260816120000_baseline_schema.sql`

The schema baseline: a `pg_dump` of the live schema taken 2026-08-16 (111
tables, 271 policies). It is what a **fresh, empty** database needs, and it is
correct for that.

It must never run against production. Production already has this schema, and
later hardening migrations dropped permissive policies and revoked grants that
this dump still contains — replaying it could quietly restore them.

To build a fresh database (local or a new project), apply this file first, then
everything in `supabase/migrations/` in order.

## `20260910140000_lead_mission_v2_claim.sql`

The LeadMission V2 queue: `lead_mission_queue`, the atomic claim, the heartbeat
that renews what a run holds, bind/release/cancel, and `renew_lineage_lease`.

**Not approved for production.** LeadMission V2 is disabled (the
`LEAD_V2_WORKER_WORKSPACES` allowlist is empty) and this migration has never
been reviewed for the live project. `enqueue-lead-mission` and
`resume-stalled-leads` reference `lead_mission_queue`; both tolerate its
absence.

To enable V2: review this file, apply it to production deliberately, move it
back into `supabase/migrations/`, then follow the enablement steps (allowlist a
single internal workspace, deploy the worker, add the orchestrate diversion).

## `20260912160000_content_format_model.sql`

Generated columns `content_item.platform` and `content_item.content_format`,
derived from `metadata` (where Scribe's writer records the format it chose),
with CHECKs on their values and the post-vs-reply coherence rule.

**Additive and safe, but not yet applied.** No code writes these columns, so
the Content format model works identically with or without them; applying
this only adds queryable, constraint-checked columns. Apply it deliberately,
then move it back into `supabase/migrations/`.

## `20260915120000_sweep_skips_v2_queue_tasks.sql`

Lead V2 P0. Redefines `tasks_sweep_stuck_runs` so it never flips a task an
active `lead_mission_queue` row owns (`queued`/`running`/`resumable`) from
`running` to `ready` — the queue recovers those through its own lease expiry.
Nothing else in the function changes.

**Depends on `20260910140000_lead_mission_v2_claim.sql`** (the table it reads).
Apply only after that one, deliberately. Until then the live sweeper is
unchanged; the V2 heartbeat keeps `tasks.updated_at` fresh, which is what keeps
a live V2 run out of the sweeper today.

## `20261003120000_lead_mission_v2_continuations_not_retries.sql`

Lead V2: a clean continuation slice no longer spends a queue retry. Adds
`lead_mission_queue.continuations` (default 0; no row rewritten), gives
`release_lead_mission` a defaulted `p_lineage_slices` argument that refunds the
claim when the lineage's own slice counter moved, and adds a 25-slice backstop
to claim and release. Retries stay capped at 5 and keep counting errors,
aborts, crashes, lease expiries and runs that complete no slice. Canary
53784493 was stopped before page 3 by five clean slices spending the 5 retries.

**Depends on `20260910140000_lead_mission_v2_claim.sql`.** Either deploy order
works: an old worker against the new function gets the old behaviour (no slice
count, no refund); a new worker against the old function falls back to the
4-argument call. Rollback, verbatim to the original functions:
`rollback/20261003120000_lead_mission_v2_continuations_not_retries.down.sql`.
Replayed against real Postgres (PGlite) in
`tests/infra/leadMissionV2ContinuationsNotRetries.test.ts`.

## `20261011120000_lead_mission_v2_productive_continuation_no_backoff.sql`

Lead V2: a PRODUCTIVE continuation is released with no backoff. Redefines
`release_lead_mission` (same signature) so `not_before` is cleared — instead
of `now() + 2 minutes` — only when the lineage's slice counter moved (the
claim-refund test of 20261003120000) AND the worker states the run's own
continuation decision was immediate (`p_outcome->>'dispatch' = 'immediate'`).
Retries, no-op runs, runs waiting on a provider (`awaiting_provider_run`) and
unknown decisions keep the 2-minute hold. Query B rerun 255c333f spent 1,054 s
(36% of 48.2 min) in that hold between clean slices.

**HELD — NOT APPLIED, and not approved for production.** Depends on
`20260910140000` and `20261003120000`. Either deploy order is safe: an old
worker states no `dispatch` (hold kept); a new worker against a database
without this migration has its `dispatch` key stored in `last_outcome` and
ignored (hold kept). Rollback, verbatim to 20261003120000's function:
`rollback/20261011120000_lead_mission_v2_productive_continuation_no_backoff.down.sql`.
Replayed against real Postgres (PGlite) in
`tests/infra/leadMissionV2ProductiveContinuationNoBackoff.test.ts`.

## `20261015120000_provider_purchase_claims.sql`

**PROPOSED — NOT APPLIED, NOT WIRED, NOT APPROVED.** One buyer per provider-call
idempotency key, decided in the database before the start POST, under D1's
generation token (`tasks.checkpoint_version`). Closes the one purchase race
nothing else covers: a stalled worker and the worker that reclaimed its mission
both POSTing the same Actor run (the execution ledger's key index is not
unique, and `credits_reserve` replays a repeated key). See
`docs/launch/lead-v2-reliability-proposals.md` §1 for the wiring, which is a
separate change. Additive and service-role only; a database without it answers
PGRST202 and every caller keeps today's behaviour. Rollback:
`rollback/20261015120000_provider_purchase_claims.down.sql`. Replayed against
real Postgres (PGlite) in `tests/infra/providerPurchaseClaims.test.ts`.

## Tests

`tests/infra/` still reads these files — the baseline's structure, the V2
queue's invariants, RLS coverage and schema drift all keep their guarantees.
Holding a file changes where it lives, not what it must satisfy.

## `20261015130000_credits_rearm_settled_key.sql`

Billing. `credits_reserve` replayed a key whose reservation had been
**refunded**, either settled `not_charged` (the call did not start) or
`released` by the stale reaper. A later attempt under that key was allowed
with no balance check, and settling it charged 0, so a real purchase went
uncharged.

This migration **re-arms** such a key in place: the same conditional debit as
a new reservation, the row locked first so concurrent attempts re-arm once,
and the reaper's 30-minute window counted from the re-arm (`rearmed_at`,
`rearm_count`, both additive). A key that is `reserved`, `charged`, `partial`
or `granted` is still a replay. `credits_finalize` is untouched.

**Not approved for any hosted project.** It needs billing sign-off. Applied
only by `tests/db-contract/bootstrap.sh` to the lane's throwaway database.
`tests/db-contract/creditRearm.contract.test.ts` proves the behaviour, and
`tests/db-contract/mutation.sh` proves those tests fail without it. It is
independent of the Lead V2 queue chain and of `20261015120000` (purchase
claims, concurrency): either can be applied without the others.

Rollback, verbatim to the baseline functions:
`rollback/20261015130000_credits_rearm_settled_key.down.sql`.
