#!/usr/bin/env bash
# Mutation proofs for the database-contract lane. Each removes one fix and
# requires its contract tests to FAIL on the behaviour:
#   1. revert the D1 PostgREST fix: the fenced-write tests fail;
#   2. build without the held credit re-arm migration: the credit tests fail.
#
#   PG_ADMIN_URL=… POSTGREST_BIN=… tests/db-contract/mutation.sh
#
# The real module is restored on exit whatever happens. Run it only in a
# disposable checkout (CI) or a clean working tree.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
real="$root/supabase/functions/_shared/fencedTaskWrite.ts"
backup="$(mktemp)"; out="$(mktemp)"
cp "$real" "$backup"
trap 'cp "$backup" "$real"; rm -f "$backup" "$out"' EXIT
cp "$root/tests/db-contract/mutants/fencedTaskWrite.pre-d1-fix.ts" "$real"
set +e
"$root/tests/db-contract/run.sh" "$root/tests/db-contract/fencedWrite.contract.test.ts" >"$out" 2>&1
status=$?
set -e
sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -E '\.\.\. (ok|FAILED)|passed \|' || true
if [ $status -eq 0 ]; then
  echo "MUTANT SURVIVED: the contract tests pass with the D1 fix reverted" >&2; exit 1
fi
# It must fail on the behaviour, not on a build or type error. No `grep -q`
# here: under pipefail it exits on the first match, sed takes SIGPIPE on a
# large log, and the pipeline reports a miss for a line that is present.
if ! sed 's/\x1b\[[0-9;]*m//g' "$out" | grep 'own generation, open row: the write lands and is reported written \.\.\. FAILED' >/dev/null; then
  echo "the mutant run failed, but not on the fenced write itself:" >&2; tail -30 "$out" >&2; exit 1
fi
echo "mutant killed: reverting the D1 fix fails the fenced-write contract"

# ── PROOF 2: the credit re-arm ──────────────────────────────────────────────
# Build the database WITHOUT the held billing fix and require the credit test
# to fail on its behaviour: the refunded key is replayed, not re-armed.
set +e
DB_CONTRACT_OMIT_HELD=20261015130000_credits_rearm_settled_key.sql \
  "$root/tests/db-contract/run.sh" "$root/tests/db-contract/creditRearm.contract.test.ts" >"$out" 2>&1
status=$?
set -e
sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -E '\.\.\. (ok|FAILED)|passed \||^omitted ' || true
if [ $status -eq 0 ]; then
  echo "MUTANT SURVIVED: the credit tests pass without the re-arm migration" >&2; exit 1
fi
if ! sed 's/\x1b\[[0-9;]*m//g' "$out" | grep 'a key refunded once (not_charged) and then really bought is charged \.\.\. FAILED' >/dev/null; then
  echo "the credit mutant failed, but not on the re-arm itself:" >&2; tail -30 "$out" >&2; exit 1
fi
echo "mutant killed: without the re-arm migration a refunded key's purchase goes uncharged"
