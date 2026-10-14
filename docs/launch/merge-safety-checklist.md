# Before merging into `launch/hardening`: the deployment-safety checklist

**Status: CHECKLIST.** Nothing here has been merged, deployed or applied.
The repository proves what it can. The three dashboards below are configured
outside it, so only a person with access can confirm them.

## What the repository already guarantees

- **No workflow deploys on push.** `ci.yml` and `db-contract.yml` run tests on
  `pull_request`/`push`. `deploy-held-back-functions.yml` is
  `workflow_dispatch` only and asks for the release SHA to be typed.
  `ops-health.yml` is scheduled and read-only.
- **No PR in the merge set touches** `supabase/migrations/`,
  `supabase/config.toml`, `railway.json`, `worker/`, `src/`, `public/` or a
  deploy workflow. Held SQL stays in `supabase/migrations-held/`, and a test
  keeps every held file out of every deploy path.
- **`railway.json` has no `watchPatterns`.** If Railway follows a branch,
  *any* push to it redeploys the worker.

## Verify in each dashboard (read-only; change nothing)

| Where | Look at | Safe to merge when |
|---|---|---|
| **Railway** → the worker service → Settings → Source | Connected repo and **branch**; "Wait for CI"; auto-deploy on/off | The branch is **not** `launch/hardening` (last recorded 2026-09-29: `feat/lead-mission-v2-worker`), or auto-deploy is off |
| **Railway** → the worker service → Variables (names only) | `LEAD_V2_WORKER_WORKSPACES` | Record whether it is set. If it is set and Railway follows `launch/hardening`, a merge restarts a live, allowlisted worker |
| **Netlify** → Site configuration → Build & deploy → Branches and deploy contexts | **Production branch**; branch deploys | The production branch is **not** `launch/hardening`. Deploy previews on PRs are fine; they don't touch production |
| **Supabase** (project `ohsdatpvfdjdemstoiuj`) → Project Settings → Integrations → GitHub | Connected repo; production branch; "deploy to production" / automatic branching | No GitHub integration, or it does not follow `launch/hardening` |
| **Lovable** (if connected) | Which repo and branch it builds from | It follows `main` of the production-connected repo (per `supabase/migrations-held/README.md`), not `launch/hardening` |

**If every row is safe,** merging into `launch/hardening` runs CI and nothing
else.

**If any row follows `launch/hardening`, stop:** either repoint it first or
pause its auto-deploy. Even a test-only merge would rebuild and restart that
service. The artifact would be identical, since no runtime file changes, but
a worker restart is still a production event.

## Merge order (each needs approval, and green CI on its head at merge time)

**Tier 0: no runtime file changes.** CI, tests, docs and held SQL only.

| Order | PR | What | Note |
|---|---|---|---|
| 1 | #76 | DB-contract CI lane | adds a CI workflow (tests only) |
| 2 | #86 | credit re-arm: **held** migration + real-DB tests | stacked on #76: retarget to `launch/hardening` after #76 merges |
| 3 | #82 | purchase-claims proposal: **held** SQL + docs | |
| 4 | #87 | this checklist, the test-worker proposal, the guarded test-schema build | |
| 5 | #74 | Codex G5 funding replay (tests) | |
| 6 | #75 | Codex quality benchmark (tests) | |

**Tier 1: runtime code.** Edge functions deploy only through the manual
workflow, so merging changes what a *future* deploy would ship, not what
runs now.

| Order | PR | What | Note |
|---|---|---|---|
| 7 | #79 | stale-generation fencing | |
| 8 | #81 | ledger recovery gaps, uncertain starts in mission spend | |
| 9 | #88 | hold the credit of an uncertain Apify start | stacked on #81: retarget after #81 merges |
| 10 | #78 | Codex: customer context vs vendor offering evidence | independent (`businessModelMatch.ts`) |
| 11 | #83 | Codex: stop repeating answered-empty enrichment | touches `leadCapabilityEngine.ts`, merges cleanly with #77 |
| 12 | #77 | funding-screen recovery | **last runtime PR:** merge `launch/hardening` in, cherry-pick `66aed203` (adapts #74/#75's harnesses), green CI, then merge |
| 13 | #80 | Codex accuracy benchmark | stacked on #78: retarget after #78 merges |
| 14 | #84 | Codex efficiency benchmark | stacked on #83: retarget after #83 merges |

**Never a merge target:** #85, the draft integration preview, which exists
only for CI on the combined tree.
