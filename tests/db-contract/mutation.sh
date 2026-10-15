#!/usr/bin/env bash
# Mutation proofs for the database-contract lane. Each removes one fix and
# requires its contract tests to FAIL on the behaviour:
#   1. revert the D1 PostgREST fix: the fenced-write tests fail;
#   2. build without the held credit re-arm migration: the credit tests fail;
#   3. build without, or with one guard removed from, the held smoke admission
#      (migration, transport gate, poll loop): a named admission test fails.
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

# ── PROOFS 3+: durable smoke admission ─────────────────────────────────────
# Each mutant removes ONE guard (in the held migration, the gate or the poll
# loop) and requires a named contract test to FAIL on that behaviour. The file
# is edited in place and restored on exit; a mutant whose text no longer
# matches stops the script rather than passing vacuously.
adm_sql="$root/supabase/migrations-held/20261015140000_discovery_smoke_admission.sql"
gate_ts="$root/supabase/functions/_shared/smokeAdmission.ts"
tools_ts="$root/supabase/functions/_shared/toolRegistry.ts"
restore_list=()
for f in "$adm_sql" "$gate_ts" "$tools_ts"; do
  cp "$f" "$f.mutation-backup"; restore_list+=("$f")
done
trap 'cp "$backup" "$real"; for f in "${restore_list[@]}"; do mv -f "$f.mutation-backup" "$f"; done; rm -f "$backup" "$out"' EXIT
adm_tests="$root/tests/db-contract/smokeAdmission.contract.test.ts"
gate_tests="$root/tests/db-contract/smokeAdmissionRuntime.contract.test.ts"

# prove_killed <label> <file> <literal to find> <replacement> <test file> <test name that must FAIL>
prove_killed() {
  local label="$1" file="$2" find="$3" repl="$4" tests="$5" name="$6"
  cp "$file.mutation-backup" "$file"
  FIND="$find" REPL="$repl" perl -0pi -e 's/\Q$ENV{FIND}\E/$ENV{REPL}/' "$file"
  if cmp -s "$file" "$file.mutation-backup"; then
    echo "MUTANT DID NOT APPLY ($label): the guarded text changed; update this proof" >&2; exit 1
  fi
  set +e
  "$root/tests/db-contract/run.sh" "$tests" >"$out" 2>&1
  local status=$?
  set -e
  cp "$file.mutation-backup" "$file"
  if [ $status -eq 0 ]; then echo "MUTANT SURVIVED ($label)" >&2; exit 1; fi
  if ! sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -F "$name ... FAILED" >/dev/null; then
    echo "the mutant ($label) failed, but not on '$name':" >&2; tail -30 "$out" >&2; exit 1
  fi
  echo "mutant killed: $label"
}

set +e
DB_CONTRACT_OMIT_HELD=20261015140000_discovery_smoke_admission.sql "$root/tests/db-contract/run.sh" "$adm_tests" >"$out" 2>&1
status=$?
set -e
if [ $status -eq 0 ] || ! sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -F "admission: the template's maximum is charged, durably, before anything is sent ... FAILED" >/dev/null; then
  echo "MUTANT SURVIVED or failed elsewhere: admission tests without the held migration" >&2; tail -30 "$out" >&2; exit 1
fi
echo "mutant killed: without the held admission migration nothing is admitted"

prove_killed "no serialization lock" "$adm_sql" \
  "where queue_id = p_queue for update;
  if not found then return jsonb_build_object('decision', 'not_authorized'); end if;" \
  "where queue_id = p_queue;
  if not found then return jsonb_build_object('decision', 'not_authorized'); end if;" \
  "$adm_tests" "race: an admission still in flight holds the last slot until it commits"
prove_killed "no deadline" "$adm_sql" "or a.deadline_at <= v_now" "" \
  "$adm_tests" "deadline: absolute, from the queue row, read after the lock, never renewed"
prove_killed "clock read before the lock wait" "$adm_sql" "v_now := clock_timestamp();  -- after the lock wait" "v_now := now();  --" \
  "$adm_tests" "deadline: an admission that waited on the lock past the deadline is refused"
prove_killed "no generation fence" "$adm_sql" "or t.checkpoint_version is distinct from p_generation" "" \
  "$adm_tests" "ownership: queue claim, queue lease, lineage lease, task binding and generation all fence"
prove_killed "no lineage lease check" "$adm_sql" "or l.lease_holder is distinct from p_task " "" \
  "$adm_tests" "ownership: queue claim, queue lease, lineage lease, task binding and generation all fence"
prove_killed "re-keyed payload buys again" "$adm_sql" \
  "or (p_kind = 'provider' and kind = 'provider' and actor = p_actor and payload_hash = p_payload_hash)" "" \
  "$adm_tests" "replay: the same key, or the same payload under a new key, is never a second purchase"
prove_killed "no model attempt count" "$adm_sql" "if p_kind = 'model' and n_model >= a.model_attempts then" "if false then" \
  "$adm_tests" "model: four attempts, then refused; failed attempts keep their slot"
prove_killed "no combined USD cap" "$adm_sql" "if v_total + v_cost > a.total_microusd" "if false" \
  "$adm_tests" "money: provider \$0.20 and combined \$0.25 are shared by every kind"
prove_killed "no provider USD cap" "$adm_sql" "or (p_kind <> 'model' and v_provider + v_cost > a.provider_microusd)" "" \
  "$adm_tests" "race: two purchases racing for the last provider dollars cannot both win"
prove_killed "no model USD cap" "$adm_sql" "or (p_kind = 'model' and v_model + v_cost > a.model_microusd)" "" \
  "$adm_tests" "model: the \$0.05 model ceiling binds before the attempt count"
prove_killed "no poll limit" "$adm_sql" "if p_kind = 'poll' and n_poll >= a.provider_polls then" "if false then" \
  "$adm_tests" "polls: five across the whole mission, each tied to a purchase this mission made"
prove_killed "worker may authorize" "$adm_sql" \
  "revoke all on function public.authorize_discovery_smoke(uuid, text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;" \
  "grant execute on function public.authorize_discovery_smoke(uuid, text, jsonb, jsonb, integer) to service_role;" \
  "$adm_tests" "privileges: service_role reads and admits; it cannot authorize, insert, update or delete"
prove_killed "gate passes requests with no mission" "$gate_ts" 'if (!ctx) return refuse("no_mission_context");' 'if (!ctx) return d.baseFetch(input, init);' \
  "$gate_tests" "gate: outside a mission, before binding, after revocation, or to an unknown host, nothing is sent"
prove_killed "replayed purchase reported as a definite refusal" "$gate_ts" \
  "status: PURCHASE_MAY_EXIST.has(decision) ? ADMISSION_UNCERTAIN_STATUS : ADMISSION_REFUSED_STATUS," \
  "status: ADMISSION_REFUSED_STATUS," \
  "$gate_tests" "apify: an uncertain start keeps its credit HELD and is never bought again"
prove_killed "vendor caps not pinned" "$gate_ts" "url.searchParams.set(k, String(v));" "void [k, v];" \
  "$gate_tests" "apify: admitted with the template's vendor caps, run id durable, polls admitted, one credit charged"
prove_killed "poll loop ignores a refusal" "$tools_ts" "    if (isAdmissionRefusal(poll)) {" "    if (false) {" \
  "$gate_tests" "apify: when polls run out the wait stops at once; the run stays pending with its id"
