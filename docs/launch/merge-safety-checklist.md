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

`launch/hardening` is the repository's **default branch**, so any service
connected with default settings follows it.

| Where | Status | Evidence needed | Safe to merge runtime changes when |
|---|---|---|---|
| **Supabase** native GitHub integration (project `ohsdatpvfdjdemstoiuj` → Project Settings → Integrations → GitHub) | **VERIFIED DISCONNECTED, 2026-10-14** (checked by the owner: the page shows "Connect GitHub", no repository) | done | — |
| **Railway** → the worker service → Settings → Source | trial expired; branch **unverified** | screenshot of Source (repo, branch, automatic deployments, "Wait for CI") and of the Deployments list (latest deployment, its commit, status) | auto-deploy is off, or the branch is not `launch/hardening` (last recorded 2026-09-29: `feat/lead-mission-v2-worker`). A reactivated trial would otherwise deploy the branch head |
| **Railway** → Variables (names only) | unverified | whether `LEAD_V2_WORKER_WORKSPACES` is set (value not needed) | recorded, so a reactivation is not a surprise |
| **Netlify** → Site configuration → Build & deploy → Continuous deployment | production deploys paused (credits exhausted); production branch **unverified** | screenshot of "Branches and deploy contexts" (production branch, branch deploys, deploy previews) and of "Build settings" (builds active or stopped) | the production branch is not `launch/hardening`, or builds are stopped. When credits return, Netlify builds the production branch's head |
| **GitHub** → repository Settings → GitHub Apps, and Settings → Webhooks | **unverified** (the catch-all for anything else that deploys on push: Vercel, Render, Railway or Netlify apps, Lovable, custom hooks) | screenshot of both lists | nothing there deploys from `launch/hardening`, or each one has been checked as above |
| **Lovable** (if listed under GitHub Apps) | unverified | the project's GitHub connection (repo, branch) | it does not build from this repository's `launch/hardening` |

**Not proof that every deployment is disabled.** The Supabase result covers
the native integration only. Other ways to deploy remain and need no merge:
- the manual `deploy-held-back-functions.yml` (it asks for the release SHA to
  be typed);
- the Supabase CLI or MCP from any machine holding an access token.
Neither runs on a merge.

**Tier 0 (below) changes no deployable file**, and today neither Railway
(expired) nor Netlify (paused) can build. So Tier 0 needs only approval.
**Tier 1 (runtime) waits for the Railway, Netlify and GitHub Apps/Webhooks
rows.**

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
| 7 | #89 | Codex mission evaluation and smoke acceptance (tests only, `tests/replay/evaluation/`) | independent; imports exist on the base. 36 tests pass on the full integrated tree |

**Tier 1: runtime code.** Edge functions deploy only through the manual
workflow, so merging changes what a *future* deploy would ship, not what
runs now.

| Order | PR | What | Note |
|---|---|---|---|
| 8 | #79 | stale-generation fencing | |
| 9 | #81 | ledger recovery gaps, uncertain starts in mission spend | |
| 10 | #88 | hold the credit of an uncertain Apify start | stacked on #81: retarget after #81 merges |
| 11 | #78 | Codex: customer context vs vendor offering evidence | independent (`businessModelMatch.ts`) |
| 12 | #83 | Codex: stop repeating answered-empty enrichment | touches `leadCapabilityEngine.ts`, merges cleanly with #77 |
| 13 | #77 | funding-screen recovery | **last runtime PR:** merge `launch/hardening` in, cherry-pick `66aed203` (adapts #74/#75's harnesses), green CI, then merge |
| 14 | #80 | Codex accuracy benchmark | stacked on #78: retarget after #78 merges |
| 15 | #84 | Codex efficiency benchmark | stacked on #83: retarget after #83 merges |

**Never a merge target:** #85, the draft integration preview, which exists
only for CI on the combined tree.
