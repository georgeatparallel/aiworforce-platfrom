#!/usr/bin/env bash
# Mutation proof for the database-contract lane: revert the D1 PostgREST fix
# and require the fenced-write contract tests to FAIL on it.
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
