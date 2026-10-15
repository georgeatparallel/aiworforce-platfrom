#!/usr/bin/env bash
# The database-contract lane: real Postgres + real PostgREST + the repository's
# real Supabase client and query modules. Everything here is disposable.
#
#   PG_ADMIN_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
#   POSTGREST_BIN=/path/to/postgrest \
#   tests/db-contract/run.sh [deno test args…]
#
# 1. creates a fresh database `contract_<random>` on that server;
# 2. builds it (tests/db-contract/bootstrap.sh: shim, baseline, migrations,
#    held V2 queue migrations — in this throwaway database only);
# 3. generates a JWT secret and an `authenticator` password for this run only;
# 4. starts PostgREST on a free localhost port against that database, with
#    Supabase's hosted defaults: at most 1000 rows per response
#    (db-max-rows) and `extensions` on the search path;
# 5. runs tests/db-contract/*.test.ts through `deno test`;
# 6. stops PostgREST and drops the database, whatever happened.
#
# Nothing here reads a production URL, key or secret: the admin URL must be
# localhost (checked), and every credential the tests use is minted below.
set -euo pipefail
admin="${PG_ADMIN_URL:?set PG_ADMIN_URL to a localhost postgres superuser URL}"
bin="${POSTGREST_BIN:?set POSTGREST_BIN to the pinned postgrest binary}"
case "$admin" in
  postgres://*@127.0.0.1:*|postgres://*@localhost:*|postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
  *) echo "refusing: PG_ADMIN_URL must point at localhost" >&2; exit 2 ;;
esac
root="$(cd "$(dirname "$0")/../.." && pwd)"
db="contract_$(openssl rand -hex 4)"
base="${admin%/*}"               # postgres://user[:pw]@host:port
hostport="${base##*@}"           # host:port
db_url="$base/$db"
jwt_secret="$(openssl rand -hex 32)"
auth_pw="$(openssl rand -hex 16)"
port="${DB_CONTRACT_PORT:-$(( 30000 + RANDOM % 20000 ))}"
pgrst_pid=""
log="$(mktemp)"
cleanup() {
  [ -n "$pgrst_pid" ] && kill "$pgrst_pid" 2>/dev/null && wait "$pgrst_pid" 2>/dev/null || true
  psql "$admin" -X -q -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  rm -f "$log"
}
trap cleanup EXIT

psql "$admin" -X -q -c "create database $db" >/dev/null
PGOPTIONS="-c client_min_messages=warning" "$root/tests/db-contract/bootstrap.sh" "$db_url"
# A login password for PostgREST's role, valid for this database's lifetime.
psql "$db_url" -X -q -c "alter role authenticator with login password '$auth_pw'" >/dev/null

# A random port can already be taken ("Address in use", seen in a local run). A bind failure
# happens before any test runs, so it is retried on a fresh port, at most three
# times. Any other PostgREST failure stops the run, as before. Liveness is
# checked before readiness, so another server on the port is never mistaken
# for ours.
start_postgrest() {
  PGRST_DB_URI="postgres://authenticator:$auth_pw@$hostport/$db" \
  PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$jwt_secret" \
  PGRST_DB_MAX_ROWS=1000 PGRST_DB_EXTRA_SEARCH_PATH=public,extensions \
  PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$port" PGRST_DB_POOL=4 \
    "$bin" >"$log" 2>&1 &
  pgrst_pid=$!
  for _ in $(seq 1 60); do
    kill -0 "$pgrst_pid" 2>/dev/null || return 1
    curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null && return 0
    sleep 0.5
  done
  return 2
}
for attempt in 1 2 3; do
  start_postgrest && break
  rc=$?
  if [ $rc -eq 1 ] && grep -q "Address in use" "$log" && [ -z "${DB_CONTRACT_PORT:-}" ] && [ $attempt -lt 3 ]; then
    echo "port $port in use; retrying PostgREST on another port" >&2
    port=$(( 30000 + RANDOM % 20000 )); pgrst_pid=""
    continue
  fi
  [ $rc -eq 1 ] && { echo "postgrest exited:" >&2; cat "$log" >&2; exit 1; }
  echo "postgrest not ready:" >&2; cat "$log" >&2; exit 1
done
echo "postgrest $("$bin" --version 2>/dev/null | head -1) on :$port, postgres $(psql "$db_url" -XAtc 'show server_version')"

set +e
DB_CONTRACT_REST_URL="http://127.0.0.1:$port" DB_CONTRACT_JWT_SECRET="$jwt_secret" DB_CONTRACT_PG_URL="$db_url" \
  deno test --node-modules-dir=none --allow-read --allow-env --allow-net=127.0.0.1,localhost --no-prompt "${@:-$root/tests/db-contract/}"
status=$?
set -e
[ $status -ne 0 ] && { echo "--- postgrest log ---"; tail -20 "$log"; }
exit $status
