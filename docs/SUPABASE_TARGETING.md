# Which Supabase project does a command touch?

> **Correction (2026-10-14): "TEST" here is the LIVE project.** Since the
> move to `ohsdatpvfdjdemstoiuj`, one project serves both roles:
> `src/lib/env/projectEnvironment.ts` maps both `production` and `test` to it,
> and `scripts/verify-deploy-target.mjs` does the same. So `npm run supabase:test`
> reaches **production**. There is no non-production Supabase project today.
> A test deployment needs a new one: see `docs/launch/test-worker-hosting.md`.
> The rest of this page predates that and is kept as written.

## The default was production

`supabase/config.toml` named `wqnigjhcwjxtmordrwno` — **production** — until
Phase 0b. Every CLI command that resolves its project from config (`db push`,
`link`, `db pull`, `migration list`) therefore aimed at production from an
ordinary working tree. The only thing preventing a production write was that the
CLI account happened to lack access to that project. That is luck, not a
safeguard.

`config.toml` now names TEST. That alone is only a convention, so there is a
structural half too.

## Use these

```bash
npm run supabase:test -- functions list
npm run supabase:test -- secrets list
npm run supabase:test -- migration list --linked
```

Every one resolves to TEST, validates the ref through
`scripts/verify-deploy-target.mjs`, and passes `--project-ref` explicitly so the
CLI cannot fall back to config.

## Production requires two deliberate acts

```bash
SUPABASE_TARGET=production npm run supabase:prod -- functions list
```

The script name alone is not enough and the environment variable alone is not
enough. Either on its own is treated as a mistake, because either on its own
usually is one. A stale `SUPABASE_TARGET=production` in a shell also causes
`supabase:test` to **refuse** rather than quietly ignore it.

Nothing resolves upward: an empty, misspelled or unknown target resolves to
TEST, never to production.

## Three commands are refused outright

| Command | Why |
|---|---|
| `db push` | Local migration filenames and the remote history use **different version strings for the same migrations**, so the CLI believes ~95 migrations are pending and would try to re-apply essentially the whole schema. The outreach base migration alone would abort it — its `CREATE TYPE` statements have no `IF NOT EXISTS` and those types already exist. |
| `db pull` | Requires a migration-history match this repo does not have; it would rewrite local migrations from a mismatched remote. |
| `db reset` | Destructive, and never appropriate against a shared project. |

## So how do migrations get applied?

One at a time, through the TEST-pinned MCP channel — which is how the remote
history was actually built. That is why remote versions do not match local
filenames: the MCP assigns its own version and matches by **name**, so
`20260807090000_credit_ledger_and_founder_unlock.sql` locally is
`20260807082840 credit_ledger_and_founder_unlock` remotely.

Write the migration file for review, then apply exactly that SQL through the
MCP. Both the ledger migrations were applied this way.

## Known state, not yet repaired

The local/remote version divergence is **not** fixed by this phase, and cannot
be fixed by repairing one migration. Roughly 95 files disagree, and 29 remote
entries carry no name at all, so they cannot be matched to local files by
anything better than a guess. Asserting a fabricated history would be worse than
the current honest mismatch. `db push` is refused rather than repaired.

`supabase/migrations/20260526000000_baseline_from_prod.sql` is an informational
snapshot and says so in its own header. It is never applied.

## What Phase 0b repaired, and what it did not

**Repaired.** `supabase/migrations/outreach.sql` had no version prefix at all.
Its four tables and four enums were verified present on TEST while *no* entry in
TEST's migration history creates them — they were applied outside recorded
history. It is now `20260222174500_outreach_engine_base.sql`, ordered 23 seconds
before `20260222174523 outreach_engine_additive` which ALTERs those tables and
must follow them, and TEST history records that version as applied. **Its DDL
was not re-run**; the record has no statements, which is precisely what
`supabase migration repair --status applied` writes.

**Not repaired — a standing blocker.** 95 local files still do not correspond to
TEST history, because their version strings differ by seconds from the remote
entries the MCP channel assigned. 29 of those remote entries carry no name at
all, so they cannot be matched to local files by anything better than a guess.
Recording a fabricated correspondence would make `db push` *appear* safe while
asserting things nobody verified — worse than the current honest mismatch. The
divergence is contained by refusing `db push` rather than papered over.
