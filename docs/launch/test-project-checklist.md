# First controlled Discovery mission: test-project checklist and rollback

**Status: PLAN.** Every step needs explicit approval. Production
(`ohsdatpvfdjdemstoiuj`) is never touched; the abandoned project
`wqnigjhcwjxtmordrwno` is never a target.

## A. Test project (each line is a separate approval)

- [ ] A free project slot exists. If not, pause one abandoned project. Pausing is reversible.
- [ ] Create the project, empty, with no production data. Record its ref.
- [ ] Enable `pg_cron` and `pg_net`.
- [ ] `TEST_PROJECT_REF=<ref> TEST_DB_URL=<url> scripts/test-project/build-test-schema.sh --confirm <ref> --with-held-billing-fix`
      (49 files; each cron-scheduling migration is detached in the same transaction).
- [ ] `select jobname from cron.job` lists only `sweep-stuck-runs` and
      `release-stale-credit-reservations`.
- [ ] Seed one internal workspace; `credits_grant` it **10** credits.
- [ ] GitHub Environment `discovery-test` (required reviewer):
  - vars `TEST_PROJECT_REF` and `TEST_WORKSPACE_ID`;
  - test-only secrets (`TEST_SUPABASE_*` and the provider keys);
  - an Apify account spending limit;
  - Firecrawl excluded unless `FIRECRAWL_USD_PER_CREDIT` is set from current pricing.
- [ ] Workflow moved into `.github/workflows/` by a CI-only PR to `launch/hardening`.
- [ ] Codex's budget-enforcement PR is merged, and CI is green on the exact
      commit to be dispatched.
- [ ] One mission enqueued (reviewed SQL) with `run_budget {provider_usd: 0.20, max_candidates: 3}`.
- [ ] One dispatch, after a separate approval.

## B. Rollback

| What went wrong | Do this |
|---|---|
| **A Tier 0 merge** (tests, docs, held SQL) | Revert PR: `git revert -m 1 <merge sha>`. Nothing ran: no migration was applied and no runtime file changed. |
| **A Tier 1 merge** (runtime) | Revert PRs in reverse merge order. Edge functions deploy only through the manual workflow, so production is unaffected unless someone deployed. If they did, redeploy the previous SHA through `deploy-held-back-functions.yml`. |
| **A mission misbehaves** | 1. Cancel the Actions run. SIGTERM drains the worker and the mission checkpoints. 2. `select * from public.cancel_lead_mission('<queue_id>', '<workspace_id>');` 3. Abort any running actor in the Apify console. 4. Clear the Environment variable `TEST_WORKSPACE_ID`, so no further run can claim. |
| **Credits look wrong** | `select status, count(*) from credit_transactions group by 1;` A `reserved` row older than 30 minutes is released by the reaper. Compare `lead_execution_calls` (provider run ids) with Apify's run history before re-running anything. |
| **The held billing fix misbehaves (test project only)** | Apply `supabase/migrations-held/rollback/20261015130000_credits_rearm_settled_key.down.sql` to the **test** project. It restores the baseline functions verbatim. |
| **The test project itself** | Pause or delete it. It holds no production data. Then rotate every key stored in `discovery-test`. |
| **The workflow** | Actions → the workflow → *Disable workflow*, or revert its CI-only PR. Delete the Environment's secrets. |

Nothing in this plan writes to production, so production needs no rollback.
