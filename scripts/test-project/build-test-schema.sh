#!/usr/bin/env bash
# BUILD THE SCHEMA OF A NEW, EMPTY, NON-PRODUCTION SUPABASE PROJECT.
#
# PROPOSAL TOOLING. Not run by CI, not run by any workflow. Running it needs
# explicit approval (docs/launch/test-worker-hosting.md §4). It writes ONLY to
# the database named by TEST_DB_URL, and only after every check below passes.
#
#   TEST_PROJECT_REF=<ref> TEST_DB_URL='postgresql://…<ref>…' \
#     scripts/test-project/build-test-schema.sh --confirm <ref> [--with-held-billing-fix] [--with-held-admission]
#
# Refuses, before any connection is made, when:
#   * the ref is empty, the live project or the abandoned former project;
#   * --confirm does not repeat the ref exactly;
#   * TEST_DB_URL does not name the ref, or names a refused project anywhere.
# Refuses, after connecting but before writing, when:
#   * the database is not empty (`public` already has tables);
#   * pg_cron or pg_net is not enabled (enable both in the test project first).
#
# Applies, in the order tests/db-contract/bootstrap.sh proves in CI:
#   A  the held baseline, B  every shipped migration, C  the held Lead V2 chain,
#   D  (opt-in) the held billing fix, E  (opt-in) the held smoke admission.
#
# CRON SAFETY. Two shipped migrations schedule `net.http_post` to the literal
# PRODUCTION URL. Each file that calls `cron.schedule` is applied in the SAME
# transaction as scripts/local-supabase/01-local-cron-detach.sql, so a job
# that calls a hosted project is never committed and can never fire, not even
# once during the build. The script ends by proving no such job exists.
set -euo pipefail

REFUSED_REFS="ohsdatpvfdjdemstoiuj wqnigjhcwjxtmordrwno"
ref="${TEST_PROJECT_REF:-}"
url="${TEST_DB_URL:-}"
confirm=""; with_billing=0; with_admission=0
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) confirm="${2:-}"; shift 2 ;;
    --with-held-billing-fix) with_billing=1; shift ;;
    --with-held-admission) with_admission=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

refuse() { echo "refusing: $*" >&2; exit 1; }
[ -n "$ref" ] || refuse "TEST_PROJECT_REF is empty"
for r in $REFUSED_REFS; do
  [ "$ref" != "$r" ] || refuse "$ref is the live or the abandoned project, never a test target"
  case "$url" in *"$r"*) refuse "TEST_DB_URL names $r" ;; esac
done
[ "$confirm" = "$ref" ] || refuse "--confirm must repeat TEST_PROJECT_REF exactly"
case "$url" in
  postgres://*"$ref"*|postgresql://*"$ref"*) ;;
  *) refuse "TEST_DB_URL must be a postgres URL that names $ref" ;;
esac

root="$(cd "$(dirname "$0")/../.." && pwd)"
held="$root/supabase/migrations-held"
detach="$root/scripts/local-supabase/01-local-cron-detach.sql"
held_v2=(
  20260910140000_lead_mission_v2_claim.sql
  20260915120000_sweep_skips_v2_queue_tasks.sql
  20261003120000_lead_mission_v2_continuations_not_retries.sql
  20261011120000_lead_mission_v2_productive_continuation_no_backoff.sql
)
billing_fix="$held/20261015130000_credits_rearm_settled_key.sql"
admission="$held/20261015140000_discovery_smoke_admission.sql"
# Every file is checked before anything connects, so a build never stops half-way on a missing one.
for f in "$held/20260816120000_baseline_schema.sql" "${held_v2[@]/#/$held/}" "$detach"; do
  [ -f "$f" ] || refuse "missing ${f#$root/}"
done
[ $with_billing -eq 0 ] || [ -f "$billing_fix" ] \
  || refuse "--with-held-billing-fix needs ${billing_fix#$root/} (its PR is not merged here)"
[ $with_admission -eq 0 ] || [ -f "$admission" ] \
  || refuse "--with-held-admission needs ${admission#$root/} (its PR is not merged here)"
q() { psql "$url" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

q "select 1" >/dev/null || refuse "cannot connect to TEST_DB_URL"
[ "$(q "select count(*) from information_schema.tables where table_schema = 'public'")" = "0" ] \
  || refuse "the database is not empty; this builds a NEW project only"
# pg_cron and pg_net create the `cron` and `net` schemas the cron migrations call.
[ "$(q "select count(*) from pg_namespace where nspname in ('cron', 'net')")" = "2" ] \
  || refuse "enable pg_cron and pg_net in the test project first"

apply() {
  local f="$1"
  if grep -q "cron.schedule" "$f"; then
    # Scheduled and detached in one transaction: a hosted-calling job never commits.
    psql "$url" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" -f "$detach" >/dev/null
    echo "applied ${f#$root/} (+ cron detach, same transaction)"
  else
    psql "$url" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" >/dev/null
    echo "applied ${f#$root/}"
  fi
}

apply "$held/20260816120000_baseline_schema.sql"
for f in $(ls "$root/supabase/migrations/"*.sql | sort); do apply "$f"; done
for f in "${held_v2[@]}"; do apply "$held/$f"; done
if [ $with_billing -eq 1 ]; then apply "$billing_fix"; fi
if [ $with_admission -eq 1 ]; then apply "$admission"; fi

hosted="$(q "select count(*) from cron.job where command ilike '%net.http_post%' or command ilike '%supabase.co%'")"
[ "$hosted" = "0" ] || { echo "FAILED: $hosted cron job(s) still call a hosted project" >&2; exit 1; }
echo "cron jobs left (in-database only):"
q "select jobname from cron.job order by 1" | sed 's/^/  /'
echo "test schema ready on $ref"
