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
