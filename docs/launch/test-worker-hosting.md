# Test-worker hosting: a proposal (nothing created, nothing active)

**Status: PROPOSAL.** No infrastructure exists for it. The workflow lives at
`docs/launch/proposals/discovery-test-worker.workflow.yml`, outside
`.github/workflows/`, so GitHub never loads it. No Supabase project is
connected, and no secret has been added. Every step under *Activation* needs
explicit approval. It replaces Railway for **one controlled Discovery worker
in a non-production environment**. It is not a production host.

## 1. There is no non-production Supabase project today

The repository is explicit:

- `src/lib/env/projectEnvironment.ts`: `CANONICAL_PROJECT_REFS = { production:
  "ohsdatpvfdjdemstoiuj", test: "ohsdatpvfdjdemstoiuj" }`, described as
  *"one project serving both roles … with one live project, everything IS
  production."*
- `src/integrations/supabase/productionTarget.ts`:
  `PRODUCTION_SUPABASE_PROJECT_REF = "ohsdatpvfdjdemstoiuj"`.
- `supabase/migrations-held/README.md` calls it "the live project", and
  `.github/workflows/deploy-held-back-functions.yml` deploys to it.
- `docs/SUPABASE_TARGETING.md` and `supabase/config.toml` still call it
  **TEST**. That wording predates the single-project migration and is out of
  date: the "test" project is production.
- `wqnigjhcwjxtmordrwno` is the abandoned former Lovable-Cloud project. It
  still accepts credentials and its contents are unknown, so **it is not a
  test target either.** The proposed workflow refuses both refs.

**So a test deployment needs a new project.** Recommended: a new free-tier
Supabase project, for example `agentory-discovery-test`, used for nothing
else, with no production data copied in. Creating it is the first approval.

## 2. The exact migrations a new test project needs

The order is the one `tests/db-contract/bootstrap.sh` applies to real
Postgres 17 on every CI run. That run proves these files build a working
schema in this order. Not `supabase db push`, which this repository refuses
(docs/SUPABASE_TARGETING.md).

**Use the guarded script; don't apply files by hand:**

```sh
TEST_PROJECT_REF=<new-ref> TEST_DB_URL='<the NEW project's postgres URL>' \
  scripts/test-project/build-test-schema.sh --confirm <new-ref> [--with-held-billing-fix]
```

**It refuses before connecting** when:
- the ref is empty, `ohsdatpvfdjdemstoiuj` or `wqnigjhcwjxtmordrwno`;
- `--confirm` doesn't repeat the ref;
- the URL doesn't name the ref, or names a refused project;
- any file is missing.

**It refuses before writing** when:
- the database is not empty;
- `pg_cron` and `pg_net` aren't enabled.

It then applies Steps A to D (D only with the flag) and Step E's detach (see
below). It ends by proving no cron job calls a hosted project.

**Tested locally:** a disposable Postgres with the contract lane's platform
shim, which stands in for Supabase's platform objects. All 49 files applied,
leaving only the two in-database jobs. `tests/infra/testWorkerProposal.test.ts`
checks the refusals with a stub `psql`.

**Step A: held baseline (fresh databases only, never production)**

| # | File |
|---|---|
| A | `supabase/migrations-held/20260816120000_baseline_schema.sql` |

**Step B: every shipped migration, in filename order (43 files)**

| # | File (`supabase/migrations/`) |
|---|---|
| 1 | `20260816180000_mcp_feed_views.sql` |
| 2 | `20260821120000_execution_cost_provenance.sql` |
| 3 | `20260822120000_model_call_ledger.sql` |
| 4 | `20260822130000_credit_kind_provider_call.sql` |
| 5 | `20260822140000_company_headcount_snapshots.sql` |
| 6 | `20260824120000_signal_events_origin.sql` |
| 7 | `20260824130000_signal_events_subject.sql` |
| 8 | `20260824140000_monitoring_subjects.sql` |
| 9 | `20260824180000_monitoring_runs.sql` |
| 10 | `20260824190000_backfill_signal_event_feed_payload.sql` |
| 11 | `20260825120000_monitoring_schedule.sql` |
| 12 | `20260825130000_monitoring_call_kind.sql` |
| 13 | `20260825140000_monitoring_cron.sql` |
| 14 | `20260825150000_signal_cluster_relevance.sql` |
| 15 | `20260825160000_relevance_cites_check_fix.sql` |
| 16 | `20260825170000_canonical_dedupe_keys.sql` |
| 17 | `20260826100000_sweep_stuck_runs.sql` |
| 18 | `20260826170000_resume_stalled_leads_cron.sql` |
| 19 | `20260827090000_request_understanding_log.sql` |
| 20 | `20260828090000_messages_realtime_publication.sql` |
| 21 | `20260828100000_request_understanding_log_read.sql` |
| 22 | `20260829140000_lead_lineages.sql` |
| 23 | `20260829150000_lead_lineages_backfill.sql` |
| 24 | `20260829170000_hiring_evidence_unavailable_backfill.sql` |
| 25 | `20260903090000_company_web_evidence.sql` |
| 26 | `20260903120000_company_web_evidence_requirement.sql` |
| 27 | `20260903130000_company_web_evidence_soft_404_correction.sql` |
| 28 | `20260903160000_cancellation_row_fence.sql` |
| 29 | `20260904120000_claim_fences_on_lineage_status.sql` |
| 30 | `20260907090000_ops_archive_rls.sql` |
| 31 | `20260907120000_drop_permissive_policies.sql` |
| 32 | `20260907150000_drop_fake_token_policies.sql` |
| 33 | `20260907170000_close_screening_scenarios.sql` |
| 34 | `20260910120000_content_item.sql` |
| 35 | `20260910130000_content_item_versioning.sql` |
| 36 | `20260911120000_content_v1.sql` |
| 37 | `20260911140000_content_asset.sql` |
| 38 | `20260911150000_content_version_empty_draft.sql` |
| 39 | `20260916120000_lead_v2_p2_execution_spine.sql` |
| 40 | `20260917120000_signal_events_realtime_publication.sql` |
| 41 | `20260929120000_lock_down_definer_rpcs.sql` |
| 42 | `20260929130000_revoke_anon_writes_on_workspace_tables.sql` |
| 43 | `20260929140000_beta_access_requests.sql` |

**Step C: the held Lead V2 queue chain (needed by the worker)**

| # | File (`supabase/migrations-held/`) |
|---|---|
| C1 | `20260910140000_lead_mission_v2_claim.sql` |
| C2 | `20260915120000_sweep_skips_v2_queue_tasks.sql` |
| C3 | `20261003120000_lead_mission_v2_continuations_not_retries.sql` |
| C4 | `20261011120000_lead_mission_v2_productive_continuation_no_backoff.sql` |

**Step D: the held billing fix (recommended, if its PR is approved)**

| # | File (`supabase/migrations-held/`) |
|---|---|
| D1 | `20261015130000_credits_rearm_settled_key.sql`: refunded credit keys are re-armed, not replayed |

**Not applied:**
- `20260912160000_content_format_model.sql`: unrelated to Discovery.
- `20261015120000_provider_purchase_claims.sql`: a proposal, not wired into
  any code.

**Step E: detach the schedules that call production. Mandatory; the script
does it in the same transaction as each scheduling migration.**

`20260825140000_monitoring_cron.sql` and
`20260826170000_resume_stalled_leads_cron.sql` schedule `net.http_post` to the
**literal production URL** (`https://ohsdatpvfdjdemstoiuj.supabase.co/functions/v1/…`)
every 15 and every 3 minutes. On a new project they would call production on
a timer.
- They authenticate with the project's own vault secret
  `monitoring_tick_key`. Without it production rejects them, but they still
  reach production.
- **Never put a production key in the test project's vault.**
- `scripts/local-supabase/01-local-cron-detach.sql` unschedules every job
  whose command calls `net.http_post` or names `supabase.co`. The build script
  applies it **in the same transaction** as each file that calls
  `cron.schedule`. A hosted-calling job therefore never commits and cannot
  fire, not even once during the build, which a separate detach step
  afterwards could not guarantee.
- **Afterwards, confirm by hand:** `select jobname, command from cron.job`
  lists only `sweep-stuck-runs` and `release-stale-credit-reservations`.
- **Never run the build, or the detach, against production.** Production
  needs those schedules.

## 3. The worker host: a manual GitHub Actions job

Why this host:
- **No new account and no always-on machine.** It costs nothing within the
  free Actions minutes; beyond them, a 45-minute run is about $0.35.
- **Bounded by construction:**
  - `workflow_dispatch` only, so it is started by hand;
  - `concurrency` group of one, so a second worker never runs beside the
    first;
  - a `timeout-minutes: 45` job.
- **Drains rather than dies.** The session ends with SIGTERM, which the worker
  treats as *drain* (`worker/README.md`, "Shutdown"). A mission in flight
  finishes and checkpoints first: the session is at most 25 minutes, plus one
  mission at most 5 minutes (`LEAD_WORKER_MAX_RUNTIME_MS=300000`), plus a
  10-minute kill grace.
- **The same runtime as production:** Deno `v2.8.2` (worker/Dockerfile),
  `deno run --allow-env --allow-net --allow-read worker/main.ts`.

What the workflow refuses before anything starts:
- an empty ref, `ohsdatpvfdjdemstoiuj` or `wqnigjhcwjxtmordrwno`;
- a typed ref that differs from the Environment's `TEST_PROJECT_REF`;
- a `TEST_SUPABASE_URL` that doesn't name the typed ref;
- an allowlist that is empty, `*`, or names more than one workspace;
- a session longer than 25 minutes.

Its spend controls are fail-closed and set in the workflow, not left to
defaults:
- `LEAD_CREDIT_ENFORCEMENT=enforce` and `LINEAGE_LEASE_ENFORCED=true`;
- `LEAD_V2_MISSION_PROVIDER_USD_CAP=0.25` and `LEAD_V2_MISSION_CREDIT_CAP=10`;
- `MODEL_SPEND_ENFORCEMENT=enforce`, `MODEL_SPEND_CEILING_USD=1.00` and
  `MODEL_RUN_MAX_CALLS=50`;
- an Apify token whose account has its own spending limit.

**Fallback host:** a single Fly.io shared-cpu machine built from
`worker/Dockerfile`, about $2 a month while running and stopped between tests.
It's only needed if a session must outlive a GitHub job.

## 4. Activation (each step needs explicit approval, in this order)

1. Create the non-production Supabase project. Record its ref.
2. Enable `pg_cron` and `pg_net` on it, run `scripts/test-project/build-test-schema.sh`
   (Steps A to E), and confirm `cron.job` by hand.
3. Seed one internal test workspace and grant it a small number of credits
   (`credits_grant`).
4. Create the GitHub Environment `discovery-test`:
   - variables `TEST_PROJECT_REF` and `TEST_WORKSPACE_ID`;
   - secrets `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY` (the
     `sb_secret_…` key), `TEST_SUPABASE_ANON_KEY` and the four provider keys.
   Test-scoped keys only. Add a required reviewer if the plan allows it.
5. Move the workflow into `.github/workflows/` through a reviewed PR to the
   **default branch**, because GitHub only offers `workflow_dispatch` there.
   The move is a CI-only change, separate from runtime changes.
6. Enqueue one mission for the test workspace, through a reviewed SQL script
   or the enqueue function deployed to the **test** project.
7. Dispatch the workflow once, typing the test ref. This is the first step
   that can spend money, within the caps above.

Until step 7, nothing calls a paid provider.
