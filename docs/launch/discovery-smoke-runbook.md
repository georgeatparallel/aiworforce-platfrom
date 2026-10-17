# First Discovery smoke: operator runbook (prepared, not executed)

**Status: BLOCKED.** Nothing here has been run. Every numbered phase is a
separate approval. Production (`ohsdatpvfdjdemstoiuj`) and the abandoned
project (`wqnigjhcwjxtmordrwno`) are never targets; the build script and the
workflow refuse both.

Companion documents:
- `discovery-smoke-readiness.md`: the evidence and decisions;
- `discovery-smoke-budget.spec.json`: the `first_smoke_profile`;
- `discovery-smoke-admission.md`: the admission design.

Code: `launch/hardening` with #90, #92, #94 and #96.
The catalog: `docs/launch/proposals/smoke-catalog-two-actor.json` (#96).

## The mission

**One job search, one company-details lookup, one employer at most, $0.25 authorized.**

| | Value |
|---|---|
| Question | 1 US B2B software company, declared 11–50 employees, an open Account Executive role posted within 30 days |
| Provider purchases | **2** Apify runs. (1) `harvestapi/linkedin-job-search`: 1 title ("Account Executive"), 1 location ("United States"), `maxItems` 3, `postedLimit` "month". (2) `harvestapi/linkedin-company`: **one** LinkedIn company URL (`companies` 1, `searches` 0), the employer's own record, which qualification needs as evidence |
| Not bought | Firecrawl, any other actor (refused: no template or no allowance) |
| Reads | **5, allocated 3 + 2** (`max_reads_per_actor`, enforced by the database). Job search: status, settled receipt, dataset. Company details: status, dataset; its receipt is deferred to reconciliation. A slow job search (two status reads) keeps its dataset read and defers its receipt instead. |
| Models | `gpt-5.6-luna` only, ≤ 4 attempts (Terra and Anthropic refused). `LEAD_V2_SMOKE_ORCHESTRATION=minimal`: execution plan, batch evaluation, mission evaluation, opportunity reasoning |
| Money | job search ≤ $0.005 (vendor-capped); company details ≤ its observed maximum (vendor-capped; **not yet observed**); model ≤ $0.0456; total committed ≤ $0.25 |
| Time | 300 s from the queue row; 2 slices of 150 s |
| Expected outcome | One employer from three rows, enriched with its company record and evaluated within four Luna attempts. The offline rehearsal persisted one qualified, evidence-backed lead (normal and slow job search). Zero is still an acceptable, honest live result. |

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
select to_regclass('public.discovery_smoke_authorizations'), to_regclass('public.discovery_smoke_operations'),
       to_regclass('public.discovery_smoke_reconciliations');
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like '%discovery_smoke%' order by 1;
--   admit_discovery_smoke, authorize_discovery_smoke, reconcile_discovery_smoke_operation,
--   record_discovery_smoke_receipt, stop_discovery_smoke
-- 2c. The worker cannot authorize, reconcile, write or widen; it can admit, record and stop.
select r.rolname, f,
       has_function_privilege(r.rolname, f, 'execute') as can_execute
  from (values ('service_role'), ('authenticated'), ('anon')) r(rolname),
       (values ('public.authorize_discovery_smoke(uuid,text,jsonb,jsonb,integer)'),
               ('public.reconcile_discovery_smoke_operation(uuid,text,bigint,text,text)'),
               ('public.admit_discovery_smoke(uuid,uuid,uuid,integer,text,text,text,text,text,text)'),
               ('public.record_discovery_smoke_receipt(uuid,text,uuid,text,text,bigint,text)'),
               ('public.stop_discovery_smoke(uuid,text)')) x(f) order by 1, 2;
--   service_role: authorize, reconcile = false; admit, record, stop = true. anon and authenticated: all false.
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
| GitHub Environment `discovery-test` | Required reviewer. Vars `TEST_PROJECT_REF`, `TEST_WORKSPACE_ID`. Secrets `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_APIFY_API_TOKEN`, `TEST_OPENAI_API_KEY`. **No** Firecrawl, Anthropic or Lovable key: the worker proposal maps neither (#96), and the catalog has no template for them. |
| Apify | A test-only account and token. Account **usage limit at the lowest value Apify allows**. Confirm the account's pricing tier (job $0.001 on BRONZE+), that the account may run **both** `harvestapi/linkedin-job-search` and `harvestapi/linkedin-company`, the company-details event price on that tier, and that `maxTotalChargeUsd` caps a `harvestapi/linkedin-company` run on this account. |
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
     '{"apify:harvestapi~linkedin-job-search": 1, "apify:harvestapi~linkedin-company": 1}'::jsonb,
     300);
   commit;
   ```
   The 300 s deadline starts at the queue row's `created_at`. The idle worker
   claims at once.

**The catalog** is `approved_quotes` of
`docs/launch/proposals/smoke-catalog-two-actor.json`, as written, with every
placeholder replaced by an observation made within 24 h:

| Template | Kind, actor | Maximum | Request bounds |
|---|---|---|---|
| `jobs` | provider, `apify:harvestapi~linkedin-job-search` | 5,000 µ$ (`discovery_page`) | ≤ 4,096 bytes; `timeout` 120, `memory` 256; `maxItems` ≤ 3 (mandatory); `jobTitles` 1, `locations` 1, `geoIds` 0 |
| `details` | provider, `apify:harvestapi~linkedin-company` | **`null`: the observed per-run maximum goes here** | ≤ 1,024 bytes; `timeout` 120, `memory` 256; `companies` 1, `searches` 0 |
| `reads` | poll, both actors | 0 (reads must be free) | `max_reads_per_actor`: job search 3, company details 2 |
| `luna` | model, `openai:gpt-5.6-luna` | 11,400 µ$ | ≤ 32,768 bytes; ≤ 4,000 output tokens |

The gate pins `maxTotalChargeUsd` on each Apify start to its template's
maximum. **As written, the catalog cannot be authorized:** `details` has no
maximum, and `authorize_discovery_smoke` refuses a template without one. No
figure is invented; the company-details price (the actor start plus one
company on the account's tier) must be observed first.

`authorize_discovery_smoke` also refuses, as a malformed catalog:
- a template missing a required key (`allowed_kinds`, `allowed_actors`,
  `maximum_microusd`, `request_limits`, `source`, `liability_bound_ref`,
  `observed_at`);
- a read template with a nonzero maximum (a priced read would spend outside
  the reconciliation);
- a read allocation that does not name exactly the reads template's actors,
  or sums to more than the five reads;
- two templates for the same kind and actor.

Why only these request bounds: the company-details actor bills per company
looked up, through `companies` (URLs) **or** `searches` (names). The job
search bills `maxItems` per title per location. Its other fields only filter
each search or choose its start page (`request_bounds_basis` in the catalog).

If Luna's observed price differs from $0.20 in / $1.20 out per 1M, recompute
`0.2·B + 1.2·O` with the real figures. If four attempts no longer fit in
50,000 µ$, **stop**: the model allocation is not raised.

**Request size (Codex P1 on #94).**
- **The fix.** The execution planner's request was 53,922 bytes. In smoke
  mode, #94 shows the planner only the approved actors, in unindented JSON:
  **29,417 bytes** measured for the two-actor mission with no Company Brain
  (#96's offline rehearsal), against B = 32,768: a margin of 3,351.
- **Where it gets measured.** The full-path rehearsal must measure every
  stage with the test workspace's real brain.
- **If a stage still exceeds 32,768,** that stage is refused before transport
  and nothing is bought.
- **The only bound-preserving fallback is B ≤ 38,400.** At that size
  0.2·38,400 + 1.2·4,000 = 12,480 µ$, and four attempts are 49,920 µ$, still
  inside the $0.05 model allocation. That is decision D2; it raises no
  authorized limit.

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

**The database enforces this (#96).** Every provider purchase is open
liability, carried at its committed maximum, until an administrator records
the vendor's own figure. While any purchase of any smoke is open:
- `authorize_discovery_smoke` refuses a new smoke;
- `admit_discovery_smoke` refuses every provider or model admission of any
  other authorization (`prior_liability_unreconciled`).

A worker-written receipt (`report_source`) closes nothing.

```sh
psql "$TEST_DB_URL" -v queue_id='<queue_id>' -f scripts/test-project/smoke-reconciliation.sql
```

1. **Wait until the authorization is no longer live.** Either its deadline
   has passed (≤ 300 s from the queue row) or it was stopped (Phase 6).
   Reconciliation is refused while it is live.
2. **For every listed row** (state `open`), read the Apify run history:
   - the run's terminal status;
   - its final `usageTotalUsd`, at least 10 s after it finished.

   The company-details row is normally `unsettled`, because the five-read plan
   defers its receipt. A `settled` row carries the worker's figure, which is
   evidence to confirm, not a reconciliation. Then record:
   ```sql
   select public.reconcile_discovery_smoke_operation(
     '<queue_id>', '<operation_key>', <vendor micro-USD>,
     '<Apify run URL or export reference>', '<SUCCEEDED | FAILED | ABORTED | TIMED-OUT | NO_RUN>');
   ```
   - The status must be terminal. A run that is still `RUNNING` is aborted in
     the console first (Phase 6).
   - `NO_RUN` (figure 0) is only for an uncertain start with no run id whose
     history shows no run.
   - The reference is trimmed. The same record again returns the first
     record; anything different is refused.
   - `reconciled_by` records your login.
3. **A figure above the committed maximum** is recorded but **held**: state
   `held_above_quote`. It does not close the purchase, and it stops the
   authorization if that is still active. The approved bound was wrong, so
   **no further smoke can run** until the database owner reviews the catalog
   and decides, outside these functions. This is a finding against that
   template.
4. For every row of `discovery_smoke_operations`, compare `committed_microusd`,
   `reported_microusd` and `report_source` with Apify and the OpenAI project's
   usage.
5. Check `select status, count(*) from credit_transactions group by 1;`. Every
   `reserved` row is an uncertain purchase that stays held until the
   30-minute reaper. Explain each one.

An empty result from the reconciliation script means every purchase of this
mission is closed.

## Phase 8 — Teardown

1. Export `discovery_smoke_authorizations`, `discovery_smoke_operations` and
   `discovery_smoke_reconciliations`. The held rollback refuses while rows
   exist; the archival owner is decision D7.
2. Pause or delete the test project.
3. Rotate every `discovery-test` secret and revoke the Apify and OpenAI test keys.

## Decisions needing your approval

| # | Decision |
|---|---|
| D1 | The two-actor profile above (one job search, one company-details lookup, Luna only, minimal orchestration, no Firecrawl) |
| D2 | The catalog values, once the prices are observed: job search 5,000 µ$; **company details: its observed maximum** (unset today); Luna B = 32,768 → 11,400 µ$, or B ≤ 38,400 → 12,480 µ$ if the live brain makes the planner larger (both keep 4 attempts within $0.05) |
| D3 | Resolved in #96: the worker proposal maps no Anthropic or Firecrawl key |
| D4 | The deferred company-details receipt is closed by Phase 7's durable reconciliation (#96); no later smoke can be authorized or spend until it is |
| D5 | Create the test project; set the account limits (Phase 1, Phase 3) |
| D6 | #90's remaining policy decisions (`discovery-smoke-admission.md`), and the Netlify, Lovable, Render and Vercel dashboard confirmations |
| D7 | Who authorizes, stops and reconciles; who owns archival |
| D8 | The execution itself (Phase 5) |
