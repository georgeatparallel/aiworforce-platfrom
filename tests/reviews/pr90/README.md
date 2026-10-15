# Independent PR #90 review reproductions

These are explicit review runners, not the automatically discovered regression
suite. They import the actual PR implementation from a separate, pinned archive.
No production source, Claude branch, or held migration is edited. The source
hashes in `source-pins.json` are checked before execution.

The complete findings and acceptance matrix are in
[`pr90-independent-smoke-safety.md`](../../../docs/launch/reviews/pr90-independent-smoke-safety.md).

## Requirements and isolation

- Deno 2.8.2, PostgreSQL 17.10 native binaries, and cached repository
  dependencies including `npm:postgres@3.4.5` and Deno std 0.224.0 assertions.
- A disposable, private PostgreSQL cluster listening on `127.0.0.1`, with local
  administrator access. **Never use a hosted or shared application database.**
- A fresh database named `contract_pr90_review`. The harness refuses
  non-loopback hosts and databases outside the `contract_pr90_[a-z_]+` pattern.
  This name check is a second guard; it does not make an existing database
  disposable.
- Cluster roles `anon`, `authenticated`, and `service_role`; their privileges
  are tested with actual `SET ROLE`. Create them only in the disposable cluster.

Each test creates a random schema, loads the PR's held SQL after schema
qualification, and drops that schema in `finally`. Supporting queue/task/lineage
tables are minimal fixtures. Credit tests load the repository's real credit
functions into fixture tables. This exercises native PostgreSQL transactions,
privileges and locks; it does not replace the full Supabase/PostgREST contract
suite. No production migration is applied.

## Prepare the pinned archive and scratch database

From the repository root, with PostgreSQL tools on `PATH`:

```sh
git fetch origin pull/90/head:refs/remotes/origin/review-pr90
review_root=$(mktemp -d /tmp/agentory-pr90-source.XXXXXX)
git archive 40d7c0aa67ba470a76b44f79955a3a0b3a8d730f | tar -x -C "$review_root"
ln -s "$PWD/node_modules" "$review_root/node_modules"

review_pg=$(mktemp -d /tmp/agentory-pr90-pg.XXXXXX)
initdb -D "$review_pg/data" -U postgres --auth=trust --no-locale
pg_ctl -D "$review_pg/data" -l "$review_pg/server.log" \
  -o "-h 127.0.0.1 -p 55490 -k $review_pg" -w start
trap 'pg_ctl -D "$review_pg/data" -m fast -w stop' EXIT
psql -h 127.0.0.1 -p 55490 -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'create role anon; create role authenticated; create role service_role;'
createdb -h 127.0.0.1 -p 55490 -U postgres contract_pr90_review
export PR90_REVIEW_ROOT="$review_root"
export PR90_REVIEW_PG_URL=postgres://postgres@127.0.0.1:55490/contract_pr90_review
```

Use an unused local port if 55490 is occupied. The native review in this report
used port 54193. Environment activation in this cloud workspace additionally
used `/workspace/.cloud-tools/node_modules/.bin` on `PATH`,
`DENO_DIR=/workspace/.deno-cache`, and `npm_config_cache=/workspace/.npm-cache`.
PostgreSQL's packaged native library directory was supplied through
`LD_LIBRARY_PATH`. None is a production binding.

## Run

```sh
deno test --cached-only --allow-read --allow-env --allow-net=127.0.0.1 \
  tests/reviews/pr90/verify.ts tests/reviews/pr90/egress.ts \
  tests/reviews/pr90/polling.ts tests/reviews/pr90/mutations.ts

PR90_REQUIRE_SAFE=1 deno test --cached-only --allow-read --allow-env \
  --allow-net=127.0.0.1 tests/reviews/pr90/verify.ts tests/reviews/pr90/egress.ts

deno lint --rules-exclude=no-import-prefix tests/reviews/pr90
deno fmt --check tests/reviews/pr90
```

The first command checks **current behavior**, including explicitly unsafe
characterizations: 43 passed on the reviewed commit. It is not a smoke approval.
The second asserts required safe behavior: **24 passed, 7 failed**, exit
status 1. Those seven failures are the reproducible defects; do not mark them as
skipped, expected successes, or qualification failures. The scoped lint
exception allows the repository's existing version-pinned URL/npm import
convention; other lint rules remain enabled.

`mutations.ts` checks the unmodified safeguard first, then changes an in-memory
copy or a newly created scratch-schema function and requires the same assertion
to fail. Eight mutations were killed. Claude's archive remains untouched.

All vendor responses and prices are synthetic. Real HTTP is used only between
loopback servers for redirect/non-fetch tests. Network permission excludes
vendor hosts, and `--cached-only` prevents dependency downloads. The four Apify
controls use the actual tool loop but accelerate its 3000 ms sleeps; their
nominal wait times are not vendor latency measurements. Crash tests inject
boundary failures and use fresh mission contexts/connections; they do not
SIGKILL a real worker or contact a real provider.

## Independent verification loop

The seven original failures now carry unique IDs `SAF-001`–`SAF-007`, all P1.
[`safety-cases.json`](safety-cases.json) records the original failure, exact
safe expectation and residual risk for each. These IDs split the two Apify
outage and cancellation cases; they do not replace the earlier report's R1–R8
section IDs. The original 43-check suite and its assertions are retained. The
original review commit is immutable and remains available as
`092d2e937031f0e4d09570e10260e93563d12f5d`.

```sh
node tests/reviews/pr90/assert-originals.mjs
git fetch origin launch/hardening:refs/remotes/origin/launch/hardening \
  pull/90/head:refs/remotes/origin/review-pr90
git rev-parse refs/remotes/origin/review-pr90
node tests/reviews/pr90/prepare-retest.mjs <exact-40-character-fetched-SHA>
python3 tests/reviews/pr90/run-safety.py <printed-preparation.json-path>
```

Run from the repository root, with the same localhost database and cached Deno
environment described above. The preservation guard compares all six original
test/helper modules to the original Git commit using the TypeScript parser and
printer. It ignores only test names and comments/formatting; changing an
assertion, fixture or conditional fails the check. It also requires the original
source fingerprint JSON to remain unchanged.

Preparation creates a separate temporary archive of an already fetched commit.
It copies the identical test code into that temporary directory and changes only
the copy's source fingerprints to the exact target SHA. The branch's original
pins are never overwritten. Execution verifies source/test hashes, runs all 31
required-safe tests and writes fresh JUnit, logs and per-ID JSON. Missing,
duplicate or skipped IDs cannot be PASS; nonzero exits and type-check failures
remain failures. No script fetches a vendor, changes Claude's branch or applies
SQL to an application database.

Use `--filter SAF-001` through the normal Deno command for a single
counterexample. All seven cases use controlled responses/callback boundaries and
native DB state; none depends on live vendor latency or pricing. Test ports and
schema names are allocated for isolation, rather than used as behavioral random
inputs.

`adjacent.ts` is a separate runner. It must not be included in, or relabeled as,
the seven-failure/43-check baseline:

```sh
deno test --cached-only --allow-read --allow-env --allow-net=127.0.0.1 \
  tests/reviews/pr90/adjacent.ts
PR90_REQUIRE_ADJACENT_SAFE=1 deno test --cached-only --allow-read --allow-env \
  --allow-net=127.0.0.1 tests/reviews/pr90/adjacent.ts
```

At the original SHA: seven adjacent characterizations pass; required-safe mode
has five passes and two failures (initial receipt usage and paid redirect-policy
loss). The twelve-poll case changes a copy of the SQL constraint **only in a
scratch schema** to investigate a hypothetical policy. It is neither an
implemented twelve-poll proposal nor a recommended/approved production setting.

For a new patch, run unchanged required-safe assertions first, then the actual
target's billing, purchase-recovery, admission and native concurrency tests.
Once all critical cases pass, run final Replay and mutation checks against the
exact independently archived integration tree. Do not run the original unsafe
characterization expectations on a fixed tree and interpret their expected
behavioral changes as newly discovered production bugs. Preserve their baseline
results and continue using the unchanged safe assertions for acceptance.
