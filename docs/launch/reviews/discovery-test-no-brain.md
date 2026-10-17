# First-smoke Company Brain isolation (test project only)

The first approved smoke has no Company Brain. A read-only preflight does not
prevent an INSERT between that check and the worker's planner. This opt-in SQL
guard makes the restriction permanent for a **new dedicated test project**.
It is not a customer feature and must never be installed in production.

The guard SQL lives under `scripts/test-project/sql/`, outside both migration
directories, so shipped migrations and generic held/local migration globs do
not pick it up. The guarded installer adds it only with
`--with-test-no-brain-guard`, which requires `--with-held-admission`. The SQL
refuses any project with an existing workspace or Brain row. It runs after
held admission and before creating the first test workspace.

Two database triggers enforce the restriction:

- Brain INSERT/UPDATE always raises `23514`; no query-then-insert window exists.
  This covers service-role BYPASSRLS, COPY/UPSERT and workspace reassignment.
  The trigger is ENABLE ALWAYS, including replica-mode writes. There are no
  extra row/advisory locks and no new admission lock ordering.
- Before inserting an authorization, the administrator path verifies that the
  Brain write trigger exists, has the expected function and is ALWAYS enabled,
  and that the workspace has no Brain. This also rejects an owner-created
  inconsistent state. No automatic Brain deletion is performed.

Stopping, cancelling or expiring a mission never removes the guard. The test
project remains unable to acquire a Brain before or after execution. A database
owner could drop/disable/replace a trigger; do not give the worker ownership or
DDL access. Administrative DDL bypass is outside the service-role boundary and
requires separate review. A test that needs a Brain should use another project,
not silently relax this first-smoke project.

## Operator procedure — NOT EXECUTED against hosted systems

Only after approvals in PR #98 and independent verification of the NEW project's
connection URL (the installer's substring check is not endpoint identity proof):

```bash
# NOT EXECUTED — hosted writes require separate approval.
bash scripts/test-project/build-test-schema.sh --confirm "$TEST_PROJECT_REF" \
  --with-held-billing-fix --with-held-admission --with-test-no-brain-guard
# NOT EXECUTED — read-only verification on that confirmed test database.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f scripts/test-project/verify-no-brain-guard.sql
```

Then create the internal test user/workspace/Scout/credits, run the workspace
preflight from PR #98, and prepare the exact immutable kickoff. Existing
projects need a separately reviewed installation/rebuild plan; this file
intentionally refuses them. Do not rerun the fresh schema installer to upgrade
a populated database. Do not use either production or retired project ref.

No worker, production schema, approved catalog, 30,720-byte limit, dollar cap,
attempt limit, read count or 3+2 allocation changes. No hosted action occurred.

## Focused offline evidence

Based on merged `a4eb32099992f404cf00b729a25b9d28856432a0`; #93/#99 remain
independent integration work. Seven native SQL/PostgREST controls pass: clean
authorization; service-role INSERT/UPSERT; concurrent writes; a repeatable-read
snapshot established before authorization; missing/disabled guard; a populated
workspace after administrator bypass; UPDATE/replica mode/stopped mission;
administrative permissions and installation-reuse refusal. Some controls group
several assertions in one test.

```bash
# LOCAL ONLY: disposable localhost PostgreSQL + pinned PostgREST, fake prices.
# This explicit lane must get a fresh database: it refuses existing workspaces.
PG_ADMIN_URL='postgres://postgres@127.0.0.1:55490/postgres' \
POSTGREST_BIN='/path/to/postgrest' \
  tests/db-contract/run.sh --cached-only tests/reviews/discoveryTestNoBrain.ts
```

The dedicated test is outside automatic shared contract discovery because the
guard must be installed before any workspace exists. Run it explicitly; zero
selected tests is not a pass. Three new automatically discovered infrastructure
checks verify opt-in/dependency order, exclusion from both migration directories
and refusal before connecting when the admission flag is missing. All 17 focused
setup/workflow/budget checks pass. Two independent fresh PostgreSQL 17.6 builds
with the repository Supabase platform shim applied 51 files each, left zero HTTP
cron jobs and only two database-local jobs, retained the lease lock before clock,
and passed the new verifier. Both refused a second install on the populated
schema. Smoke audit RLS remained enabled, worker audit INSERT/UPDATE/DELETE
remained denied, and authorize/reconcile remained administrator-only. Real
managed Supabase extension compatibility still needs operator verification.
