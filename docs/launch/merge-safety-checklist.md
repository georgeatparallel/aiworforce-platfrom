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

`launch/hardening` is the repository's **default branch**. Railway and Netlify
both name it as their production branch, so their *auto-deploy* setting is
what keeps a merge from deploying.

Owner-verified 2026-10-14/15:

| Hook | Finding | Status |
|---|---|---|
| **Supabase** native GitHub integration (`ohsdatpvfdjdemstoiuj`) | "Connect GitHub", no repository connected | ✅ **verified inactive** |
| **Railway** (worker service) | production branch `launch/hardening`; **automatic deployments DISABLED** (confirmed in dashboard); trial expired | ✅ **verified inactive**. Re-enabling auto-deploy would deploy the branch head |
| **GitHub** repository webhooks | none configured | ✅ **verified none** |
| **Netlify** (site `teal-chimera-be7c79`) | production branch `launch/hardening`; **"Stop builds" selected**; final stopped status pending | ⏳ **pending**: confirm "Builds: stopped" on Build settings. A PR push that gets no Netlify deploy preview is consistent with it |
| **Lovable** (GitHub App installed) | which repo and branch its project syncs; whether it publishes on sync | ⏳ **unverified** |
| **Render** (GitHub App installed) | any service linked to this repo; its branch; auto-deploy on/off | ⏳ **unverified** |
| **Vercel** (GitHub App installed) | any project linked to this repo; its production branch; Git deployments on/off | ⏳ **unverified** |

Circumstantial only: no Vercel or Render check, status or comment has
appeared on any of the PRs opened 2026-10-14 (#76 to #89). Vercel posts on
every PR of a linked project, so this suggests nothing is linked; Render
posts only when PR previews are on. **Not proof**; the dashboards decide.

**Not proof that every deployment is disabled.** These rows cover push-
and merge-triggered hooks only. Two manual paths remain, and neither runs on
a merge:
- `deploy-held-back-functions.yml`, which asks for the release SHA to be
  typed;
- the Supabase CLI or MCP, from any machine holding an access token.

**Gate:**
- **Tier 0 merges** when the Netlify, Lovable, Render and Vercel rows are
  confirmed and you approve explicitly.
- **Tier 1 merges** under the same condition, plus a separate approval.

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
