# First Discovery smoke: operator runbook (prepared, not executed)

**Status: BLOCKED.** Nothing here has been run. Every numbered phase is a
separate approval. Production (`ohsdatpvfdjdemstoiuj`) and the abandoned
project (`wqnigjhcwjxtmordrwno`) are never targets; the build script and the
workflow refuse both.

Companion documents:
- `discovery-smoke-readiness.md`: the evidence and decisions;
- `discovery-smoke-budget.spec.json`: the `first_smoke_profile`;
- `discovery-smoke-admission.md`: the admission design.

Code: `launch/hardening` with #90, #92 and #94.

## The mission

**One job search, one employer at most, $0.25 authorized.**

| | Value |
|---|---|
| Question | 1 US B2B software company, declared 11–50 employees, an open Account Executive role posted within 30 days |
| Provider purchases | **1** Apify run of `harvestapi/linkedin-job-search`: 1 title ("Account Executive"), 1 location ("United States"), `maxItems` 3, `postedLimit` "month" |
| Not bought | company details, Firecrawl, any other actor (refused: no template or no allowance) |
| Reads | ≤ 5: 1–2 long-polled status reads, 1 settled receipt, 1 dataset |
| Models | `gpt-5.6-luna` only, ≤ 4 attempts (Terra and Anthropic refused) |
| Money | provider ≤ $0.005 (vendor-capped), model ≤ $0.0456, total committed ≤ $0.25 |
| Time | 300 s from the queue row; 2 slices of 150 s |
| Expected outcome | Safe bounding. At best one employer from three rows, evaluated within four Luna attempts. Zero is an acceptable, honest result. |

## Phase 1 — Isolated Supabase project

1. Create a new, empty free-tier project (`agentory-discovery-test`) in the organization. Use no production data and no GitHub integration. Record `<ref>`.
2. In the dashboard, enable `pg_cron` and `pg_net`.
3. From a machine holding only the test project's DB URL:
   ```sh
   TEST_PROJECT_REF=<ref> TEST_DB_URL='<test DB URL>' \
     scripts/test-project/build-test-schema.sh --confirm <ref> --with-held-billing-fix --with-held-admission
   ```
   This applies 50 files. Each cron-scheduling migration is detached in its own transaction.

## Phase 2 — Held migration and role verification (read-only SQL, test project)

```sql
-- 2a. Only the two in-database jobs.
select jobname from cron.job order by 1;          -- sweep-stuck-runs, release-stale-credit-reservations
-- 2b. The held admission objects exist.
select to_regclass('public.discovery_smoke_authorizations'), to_regclass('public.discovery_smoke_operations');
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like '%discovery_smoke%' order by 1;
--   admit_discovery_smoke, authorize_discovery_smoke, record_discovery_smoke_receipt, stop_discovery_smoke
-- 2c. The worker cannot authorize, write or widen; it can admit, record and stop.
select r.rolname, f,
       has_function_privilege(r.rolname, f, 'execute') as can_execute
  from (values ('service_role'), ('authenticated'), ('anon')) r(rolname),
       (values ('public.authorize_discovery_smoke(uuid,text,jsonb,jsonb,integer)'),
               ('public.admit_discovery_smoke(uuid,uuid,uuid,integer,text,text,text,text,text,text)'),
               ('public.record_discovery_smoke_receipt(uuid,text,uuid,text,text,bigint,text)'),
               ('public.stop_discovery_smoke(uuid,text)')) x(f) order by 1, 2;
--   service_role: authorize = false; admit, record, stop = true. anon and authenticated: all false.
select has_table_privilege('service_role', 'public.discovery_smoke_operations', 'insert'),
       has_table_privilege('service_role', 'public.discovery_smoke_operations', 'update'),
       has_table_privilege('service_role', 'public.discovery_smoke_authorizations', 'update');  -- all false
-- 2d. The hard caps are the CHECK ceilings.
select pg_get_constraintdef(c.oid) from pg_constraint c
 where c.conrelid = 'public.discovery_smoke_authorizations'::regclass and c.contype = 'c';
```

**Stop here if any answer differs.**

## Phase 3 — Test-only credentials and account controls

| Item | Required setting |
|---|---|
| GitHub Environment `discovery-test` | Required reviewer. Vars `TEST_PROJECT_REF`, `TEST_WORKSPACE_ID`. Secrets `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_APIFY_API_TOKEN`, `TEST_OPENAI_API_KEY`. **No** Firecrawl or Lovable key. Anthropic: drop `TEST_ANTHROPIC_API_KEY` from the proposal (decision D3). |
| Apify | A test-only account and token. Account **usage limit at the lowest value Apify allows**. Confirm the account's pricing tier (job $0.001 on BRONZE+). |
| OpenAI | A dedicated test project with a **hard** monthly budget (not only an alert) and a key scoped to that project. Record `gpt-5.6-luna`'s price from that project within 24 h of Phase 5. |
| Supabase | Test-project keys only. Rotate them after the test (Phase 8). |
| Workspace | One internal workspace (`TEST_WORKSPACE_ID`) with 10 credits (`credits_grant`). The mission cap stays 5. |

## Phase 4 — The kickoff body (offline, reviewed)

The queue row's `request` is orchestrate's run-agent kickoff for one approved
plan step (`validateV2KickoffBody`):
- `workspace_id`, `plan_id`, `step_index`;
- `agent_slug: "scout"`;
- `instruction`;
- a `lead_mission` v1 with `requested_count` 1 and `run_budget {provider_usd: 0.20, max_candidates: 3}`;
- no resume fields.

The worker replays it into run-agent, so the referenced plan row must exist in
the test project. **Generate both the body and its plan row in the offline
rehearsal** (fake vendors, local Postgres with the held schema), review them,
and keep them as the two inserts of Phase 5.

The admission binds the authorization to `sha256(request::text)`. The body
cannot change after authorization.

## Phase 5 — Authorize and dispatch (the only phase that can spend)

1. **Separate execution approval.** Prior liability must be zero (Phase 7 from
   any earlier run is complete, and the reconciliation query returns no rows).
2. Move `docs/launch/proposals/discovery-test-worker.workflow.yml` into
   `.github/workflows/` through a CI-only PR to `launch/hardening`.
3. Dispatch it, typing `<ref>`. The worker starts idle; nothing is queued.
4. In **one** reviewed transaction, as an administrator on the test project:
   ```sql
   begin;
   insert into public.task_plans (...) values (...);            -- from Phase 4
   insert into public.lead_mission_queue (id, workspace_id, request, status)
        values ('<queue_id>', '<TEST_WORKSPACE_ID>', '<kickoff body>'::jsonb, 'queued');
   select public.authorize_discovery_smoke(
     '<queue_id>', '<pricing_version>',
     '<catalog: see below>'::jsonb,
     '{"apify:harvestapi~linkedin-job-search": 1}'::jsonb,
     300);
   commit;
   ```
   The 300 s deadline starts at the queue row's `created_at`. The idle worker
   claims at once.

**The catalog.** Every `observed_at` must be within 24 h; replace the
`<…>` placeholders with observed values.

```json
{
  "jobs": { "allowed_kinds": ["provider"], "allowed_actors": ["apify:harvestapi~linkedin-job-search"],
    "maximum_microusd": 5000, "discovery_page": true,
    "source": "<Apify actor pricing: job $0.001, start $0.001, tier <tier>>", "liability_bound_ref": "maxTotalChargeUsd=0.005 (gate-pinned)",
    "observed_at": "<ISO time>",
    "request_limits": { "max_request_bytes": 4096, "pin_query": { "timeout": "120", "memory": "256" },
      "max_fields": { "maxItems": 3 }, "max_array_items": { "jobTitles": 1, "locations": 1, "geoIds": 0 } } },
  "reads": { "allowed_kinds": ["poll"], "allowed_actors": ["apify:harvestapi~linkedin-job-search"],
    "maximum_microusd": 0, "source": "<Apify usage page: API reads not charged for this actor>",
    "liability_bound_ref": "reads are not actor events", "observed_at": "<ISO time>", "request_limits": {} },
  "luna": { "allowed_kinds": ["model"], "allowed_actors": ["openai:gpt-5.6-luna"],
    "maximum_microusd": 11400, "source": "<OpenAI project pricing: $<in>/1M in, $<out>/1M out>",
    "liability_bound_ref": "B=32768 bytes (tokens <= bytes), O=4000", "observed_at": "<ISO time>",
    "request_limits": { "max_request_bytes": 32768, "max_output_tokens": 4000 } }
}
```

If Luna's observed price differs from $0.20 in / $1.20 out per 1M, recompute
`0.2·B + 1.2·O` with the real figures. If four attempts no longer fit in
50,000 µ$, **stop**: the model allocation is not raised.

## Phase 6 — Stop and cancellation (in this order, any time)

```sql
select public.stop_discovery_smoke('<queue_id>', 'operator');              -- refuses every later admission at once
select * from public.cancel_lead_mission('<queue_id>', '<TEST_WORKSPACE_ID>');
```

Then:
1. Cancel the Actions run. SIGTERM drains the worker.
2. In the Apify console, **abort any RUNNING run** of the test account. Stopping the worker never stops a vendor run.
3. Clear `TEST_WORKSPACE_ID` in the Environment, so nothing more can claim.

## Phase 7 — Receipt reconciliation (before anything else runs)

```sh
psql "$TEST_DB_URL" -v queue_id='<queue_id>' -f scripts/test-project/smoke-reconciliation.sql
```

1. **Every listed row** is an Apify purchase without a settled figure. Close
   each one against the Apify run history: final `usageTotalUsd`, read at least
   10 s after the run finished. Record the figure and its source in the run log.
2. For every row of `discovery_smoke_operations`, compare `committed_microusd`,
   `reported_microusd` and `report_source` with Apify and the OpenAI project's
   usage.
3. Check `select status, count(*) from credit_transactions group by 1;`. Every
   `reserved` row is an uncertain purchase that stays held until the
   30-minute reaper. Explain each one.
4. If any actual charge is above its template's maximum, the authorization is
   already stopped, and that template is a finding.

**Rule (conservative):** no further paid mission is authorized while any row
from step 1 is open, any uncertain purchase is unexplained, or any charge
exceeds its template. Today this rule is procedural only. See the proposed
enforcement below.

## Phase 8 — Teardown

1. Export `discovery_smoke_authorizations` and `discovery_smoke_operations`.
   The held rollback refuses while rows exist; the archival owner is decision D7.
2. Pause or delete the test project.
3. Rotate every `discovery-test` secret and revoke the Apify and OpenAI test keys.

## Proposed durable enforcement (for separate review; not implemented)

**Problem.** "No new paid mission while earlier liability is uncertain" is
only an operator rule.

**Proposal.** A held migration adds:
- `discovery_smoke_reconciliations(authorization_id, closed_by, closed_at, evidence_ref, actual_microusd)`,
  writable only by an administrator;
- a check in `authorize_discovery_smoke` that refuses a new authorization for
  a workspace when any earlier authorization of that workspace has a
  reconciliation row missing and any of:
  - an Apify provider operation whose `report_source` is not
    `apify_run(settled).receipt`;
  - a provider operation with no `provider_run_id` (uncertain);
  - a `reported_microusd` above its `committed_microusd`.

**What it gives.** The worker still cannot authorize anything. An operator
closes a liability only by recording vendor evidence, and the database then
enforces the conservative rule. It needs its own tests (refusal, closure,
privileges) and approval. It is not required for the **first** smoke, which
has no earlier liability.

## Decisions needing your approval

| # | Decision |
|---|---|
| D1 | The first-smoke profile above (one job search, Luna only, no details, no Firecrawl) |
| D2 | The catalog values, once the prices are observed (job-search 5,000 µ$; Luna 11,400 µ$ or recomputed) |
| D3 | Drop `TEST_ANTHROPIC_API_KEY` from the worker proposal (not on the mission path) |
| D4 | Reconcile after the mission (Phase 7) is acceptable for the first smoke; the durable gate above goes to separate review before any second paid mission |
| D5 | Create the test project; set the account limits (Phase 1, Phase 3) |
| D6 | #90's remaining policy decisions (`discovery-smoke-admission.md`), and the Netlify, Lovable, Render and Vercel dashboard confirmations |
| D7 | Who authorizes, stops and reconciles; who owns archival |
| D8 | The execution itself (Phase 5) |
