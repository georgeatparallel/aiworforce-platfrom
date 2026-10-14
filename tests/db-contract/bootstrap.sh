#!/usr/bin/env bash
# Build a DISPOSABLE database for the database-contract lane.
#
#   tests/db-contract/bootstrap.sh <postgres-url>
#
# Applies, in order: the Supabase platform shim (sql/00_supabase_shim.sql),
# the held schema baseline, every migration in supabase/migrations/, then the
# held Lead V2 queue migrations. The held files are applied HERE ONLY — to a
# throwaway database this lane creates and destroys. They are not approved for
# production (supabase/migrations-held/README.md) and nothing in this lane can
# reach production: the URL must point at localhost, which is checked below.
set -euo pipefail
url="${1:?usage: bootstrap.sh <postgres-url>}"
case "$url" in
  postgres://*@127.0.0.1:*|postgres://*@localhost:*|postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
  *) echo "refusing: the contract lane only builds a database on localhost" >&2; exit 2 ;;
esac
root="$(cd "$(dirname "$0")/../.." && pwd)"
held="$root/supabase/migrations-held"
# The held Lead V2 queue chain, in dependency order (see the held README).
held_v2=(
  20260910140000_lead_mission_v2_claim.sql
  20260915120000_sweep_skips_v2_queue_tasks.sql
  20261003120000_lead_mission_v2_continuations_not_retries.sql
  20261011120000_lead_mission_v2_productive_continuation_no_backoff.sql
)
apply() {
  psql "$url" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$1" >/dev/null \
    || { echo "FAILED applying ${1#$root/}" >&2; exit 1; }
  echo "applied ${1#$root/}"
}
apply "$root/tests/db-contract/sql/00_supabase_shim.sql"
apply "$held/20260816120000_baseline_schema.sql"
for f in $(ls "$root/supabase/migrations/"*.sql | sort); do apply "$f"; done
for f in "${held_v2[@]}"; do apply "$held/$f"; done
# PostgREST reads its schema cache once at start; nothing else to reload here.
echo "database ready"
