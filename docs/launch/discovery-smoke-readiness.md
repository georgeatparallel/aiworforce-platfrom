# First Discovery smoke: operational readiness

**Status: CODE-COMPLETE FOR AN OFFLINE REHEARSAL, NOT LIVE-TEST-READY. The
$0.25 mission stays BLOCKED** until the operator plan, the pricing, the test
environment and the execution are separately approved.

`launch/hardening` contains:
- the durable admission (#90);
- the opt-in wall clock and spec v2 (#92).

The implementation PR (#94) adds:
- the smoke's Apify read lifecycle;
- the gate's vendor cap and billed-entry bounds;
- the job-search smoke bound;
- a durable receipt reconciliation.

The unblocking PR (#96) adds:
- the two-actor smoke (job search + one company-details lookup), with a
  database-enforced 3 + 2 read allocation (`docs/launch/proposals/smoke-catalog-two-actor.json`);
- a smoke-only minimal orchestration (`LEAD_V2_SMOKE_ORCHESTRATION=minimal`),
  so qualification fits four model attempts;
- durable reconciliation (`reconcile_discovery_smoke_operation`): an open
  purchase blocks every later smoke, in the database;
- the final offline hardening: NULL-safe catalog validation, complete read
  allocations, free reads, terminal-only reconciliation, and a hold on any
  figure above its quote.

**Where this document and #96 differ, #96 and `discovery-smoke-runbook.md`
are current.** The one-actor profile below (§1, §4, §6b) was the first draft:
it qualified no lead, because the company record is the evidence.

This document records the decisions and evidence around it. It raises no
limit and changes no admission rule.

Evidence used, read on 2026-10-16:
- the code;
- Apify's API reference (`act-runs-post`, `actor-run-get`);
- each actor's public `GET /v2/acts/{actor}` (pricing events) and its build OpenAPI (input schema);
- Firecrawl's billing page.

**Every price below is a public list figure. None is an approved quote.**

## 1. Reads: the five-read lifecycle (implemented in #94, smoke only)

The database allows **five reads per mission**: status, dataset, resume and
receipt GETs together, counted separately from the one discovery page. That
cap is unchanged.

One Apify run's complete lifecycle is **three reads**:

| Read | What | When |
|---|---|---|
| Status | `GET /actor-runs/{id}?waitForFinish=W`, W ≤ 60 s (Apify's maximum) | until terminal |
| Receipt | `GET /actor-runs/{id}` once the run finished ≥ 10 s ago (Apify: the first response after completion "can still show preliminary … costs") | skipped when the terminal status read was already settled |
| Dataset | `GET /datasets/{id}/items` | SUCCEEDED only |

**The plan spends a read only when what follows it still fits**
(`smokeAdmissionRefusal.ts`):
- **A run is started** only with ≥ 3 reads and ≥ 75 s left. That covers:
  - the start (20 s);
  - a minimal 5 s wait plus 10 s of client slack;
  - the tail (dataset 20 s, settle 10 s, receipt 10 s).

  Otherwise nothing is bought, and no credit is touched.
- **A status read** (including a resume in a later slice) needs ≥ 3 reads, so
  the dataset and receipt reads always remain. W is the smaller of 60 s and
  the time left minus the tail and the slack, and the client timeout is W + 10 s.
- **"Time left"** is the smallest of:
  - the slice's own deadline (150 s per slice, wall clock included);
  - the authorization's `deadline_at` (≤ 300 s from the queue row).

  A long poll therefore never runs past either.
- **The receipt** is read once the run is settled, if a read (and the
  dataset's) and the time remain. The gate records a settled figure as
  `apify_run(settled).receipt`. Otherwise the result says
  `receipt: "unsettled"` and a warning is logged. **Nothing is silently taken
  as final:** `scripts/test-project/smoke-reconciliation.sql` lists every
  Apify purchase whose figure is not settled.
- **A run still running** when the reserve is reached stays `pending`. Its id
  is durable and its receipt explicitly unsettled.

**Measured** (DB contract lane: real admission RPC, real gate, `runTool`, fake Apify honouring `waitForFinish`):

| Case | Reads used | Receipt |
|---|---|---|
| Run finishes inside the first long poll | **3**: status, receipt, dataset | settled |
| Slow run (two long polls) | **4**: status, status, receipt, dataset | settled. A second run is then **not bought** (1 read left). |
| Run still RUNNING | **3** status reads, then pending. A slice-2 resume is not read (reserve). | unsettled, listed by the reconciliation |
| 90 s left | **2**: status with W = 40, plus dataset (that status was already settled) | settled |
| 60 s left | **0**: nothing bought | n/a |

**Two runs in five reads (#96).** Five reads cannot settle two runs in full
(3 + 3 > 5). The final run is therefore bought with **two** reads (status,
dataset), and its receipt is deferred to reconciliation. The reads template
allocates them: job search 3, company details 2 (`max_reads_per_actor`; the
database refuses a read beyond an actor's share with `read_allocation`). A
slow job search (two status reads) keeps its dataset read and defers its own
receipt.

**Deferral is durable (#96).** A deferred receipt is open liability at its
committed maximum. `authorize_discovery_smoke` refuses every new smoke, and
`admit_discovery_smoke` refuses every other authorization's paid admission,
until an administrator reconciles it against Apify's run history. That
requires a terminal vendor status, and the authorization must no longer be
live. A figure above the quote is held, not closed (runbook, Phase 7).

## 2. Firecrawl: omitted from the first smoke

**Decision: no Firecrawl.** It is enforced three ways:
- the approved catalog has no Firecrawl template, so the gate refuses
  `unknown_quote` before transport;
- the worker proposal maps no Firecrawl key and no rate;
- the spec's first-smoke profile gives it no allowance
  (`tests/infra/smokeBudgetSpec.test.ts`).

If a key were ever mapped without a rate, a capped run still prices Firecrawl
`unpriced` and refuses it.

**The open variable-credit defect** (follow-up; customer billing unchanged here):
- **Charges are derived, not receipted.** `/scrape` reports no credits, so a
  scrape's charge is derived from the published rule (`firecrawlCredits`), and
  `pdfPages` is unknown at that point (0).
- **That derived figure is treated as final.** Its `derived_floor` settlement
  is final for Firecrawl (`PUBLISHED_RULE_SETTLED_PROVIDERS`).
- **Long PDFs undercount.** A scrape that lands on a long PDF is billed +1
  credit per PDF page but recorded as one.
- **The smoke gate records no Firecrawl figure at all.** It observes only
  Apify.

A fix needs one of:
- Firecrawl's own per-request credit count, if its API exposes one (verify);
- PDF parsing pinned off (verify the option);
- the template priced at the largest PDF it could fetch.

**Restrictions, if Firecrawl is ever included:**
- approved ordinary company-site URLs only (`allowed_values`);
- `formats` restricted to `markdown` and `summary`;
- `proxy: basic` pinned;
- PDF parsing off, or the template priced at the largest PDF;
- an account rate from the invoice.

## 3. Models: the canonical OpenAI-only route

**What the code says:**
- `gptProvider.ts`: "THE LEAD WORKFLOW'S ONLY MODEL. GPT, with no fallback."
- Every structured stage calls `POST api.openai.com/v1/chat/completions`
  through `gptStructured`, with the router's model.
- `gptModelRouter.ts`:

| Model | Stages |
|---|---|
| `gpt-5.6-luna` | mission compilation, discovery actor selection, execution plan and amendment, opportunity reasoning, route control, triage, evaluation, signal relevance, request understanding, company qualification, semantic classification, grounded evidence, evidence planning and extraction, pool evaluation, summary |
| `gpt-5.6-terra` | the `*_repair` stages, and the escalation of the Luna stages that declare one |

- **The strategist**, with `LEAD_STRATEGIST_PROVIDER=openai` (set in the proposal):
  - primary `openai/gpt-5.6-luna`, sent as `gpt-5.6-luna`;
  - escalation `openai/gpt-5.6-terra`;
  - `max_completion_tokens` 1600;
  - no Anthropic fallback.
- **Not on the mission path:**
  - **Anthropic** (Haiku 4.5, `aiProvider.TASK_MODELS`). The V2 capability
    engine returns before `run-agent`'s generic `generateText`;
    `planActorInput` has no production caller; `plannerWrapper` receives the
    OpenAI strategist as its `generate`.
  - **The legacy tier** (`gpt-4.1`, `gpt-4.1-mini`).

**Approved:**
- **`openai:gpt-5.6-luna` only.** One template per model.
  - Input bound B = 32,768 bytes (tokens ≤ bytes).
  - Output bound O = 4,000 tokens; the largest mission call is 4,000
    (`gptStrategistModel` and `gptMissionModel` defaults).
  - Maximum 0.2·B + 1.2·O = **11,354 → 11,400 µ$**, using the repo's list
    price, re-observed within 24 h.
  - **4 attempts = 45,600 µ$ ≤ $0.05.**

**Refused:**
- **`gpt-5.6-terra`** — 2·B + 12·O = 113,536 µ$ exceeds the whole $0.05 model
  allocation. Any template that large is refused at every admission (tested in
  #94), so repairs and escalations fail closed.
- **Anthropic** — no template, no key needed.

Model attempts stay at 4.

## 4. Apify: the actors the mission actually buys

**The V2 mission's job discovery is `apify_linkedin_job_search` =
`harvestapi/linkedin-job-search`** (`hiringActorCatalog.ts`). It is
`READY`, and each row carries the employer's LinkedIn record and **declared
size band**. #93's first draft named `curious_coder/linkedin-jobs-scraper`;
that is the legacy `apify_jobs`, an uncarded fallback, and the spec now names
the real actor.

| Actor | Public pricing (pay per event) | Default run options | Billed results |
|---|---|---|---|
| `harvestapi/linkedin-job-search` | job $0.001, actor start $0.001 | timeout 4000 s, 256 MB, no charge cap | `maxItems` × jobTitles × locations; `geoIds` is another location filter |
| `harvestapi/linkedin-company` (details) | company $0.004 (FREE/BRONZE) to $0.003; start $0.00005 | timeout 30000 s, 256 MB, no charge cap | one per company |
| `curious_coder/linkedin-jobs-scraper` (legacy) | result $0.002 (FREE) / $0.001; start $0.00005 | timeout 3600 s, 512 MB, no charge cap | `limitPerSource` × URLs; build 1.7 has **no `count`** |

**Implemented in #94:**
- **Vendor cap.** Every Apify start carries `maxTotalChargeUsd` no greater
  than its template's maximum (the gate sets it; a higher caller or pinned
  value is replaced). Apify: it "cap[s] the total amount charged for all
  pricing models".
- **Billed-entry bound.** `max_array_items` in a template refuses a second
  title, location, `geoIds` entry or URL. `max_fields` bounds `maxItems`.
- **Job search, in smoke mode.** The engine asks for one title, one location
  and ≤ 3 rows, the request the template admits.
- **Legacy actor, in smoke mode.** One URL, `limitPerSource: 3`,
  `splitByLocation: false`, `scrapeCompany: true`, no `count`. The customer
  shape is unchanged; the stale `count` is a separate follow-up.

**Recommended first-smoke template** for `apify:harvestapi~linkedin-job-search`:
- `maximum_microusd` 5,000;
- `discovery_page: true`;
- `pin_query` `{timeout: "120", memory: "256"}`;
- `max_fields` `{maxItems: 3}`;
- `max_array_items` `{jobTitles: 1, locations: 1, geoIds: 0}`;
- the gate pins `maxTotalChargeUsd=0.005`.

At $0.001 per job, 3 jobs plus the start is $0.004.

**Company details (#96).** One lookup of the employer's own LinkedIn record,
which qualification requires as evidence: `companies` 1, `searches` 0 (the
actor bills per company looked up, by URL or by name). Its `maximum_microusd`
is **not observed** and stays `null`, so the catalog cannot be authorized
until it is.

## 5. Pricing evidence and account limits

| Item | Status |
|---|---|
| Job search, company details and legacy jobs actor event prices | **Public figures obtained** (§4). Confirm your account's tier on the Apify billing page the day of authorization. |
| Apify status and dataset reads at $0 | Reads are API GETs, not actor events. Confirm on the Apify usage page that a pay-per-event actor's dataset reads add no platform charge (otherwise a nonzero read price also consumes a purchase slot). |
| `gpt-5.6-luna` price | **Missing.** Read it from the test OpenAI project's pricing page within 24 h. |
| Real request sizes per stage | **Missing.** Measure the largest request body per model call in an offline rehearsal (fake vendors); B must cover it, or that stage is refused. |
| Firecrawl | n/a: omitted |
| Apify account | **Missing.** Test-only token and account, usage limit at the minimum. |
| OpenAI account | **Missing.** Dedicated test project with a hard budget. |
| Anthropic | Not needed (§3) |

## 6. #90's ten policy decisions

| # | Decision | Where it stands | Needs your approval |
|---|---|---|---|
| 1 | Migration design: queue-keyed, hard caps, no refund of capacity | Implemented, merged and verified; held, not applied | **Yes**: approve applying it to the test project only |
| 2 | Poll allowance vs cadence | Five reads, 3 + 2 (#96): the job search settled, the company details' receipt deferred to reconciliation | **Yes**: approve the two-run smoke |
| 3 | Template-pinned vendor caps | `maxTotalChargeUsd` now automatic; billed-entry bounds implemented | **Yes**: the job-search template in §4 (`timeout`, `memory`, `maxItems`, entry bounds) |
| 4 | Input-token bound (tokens ≤ bytes) | Implemented | **Yes**: accept it, with B = 32,768 |
| 5 | Refuse model calls without `maxTokens` | Implemented; every mission call site sets one | **Yes, confirm.** No stage on the mission path is affected. |
| 6 | The quote catalog | Not written | **Yes**: every price in §5, each with a source and a 24 h observation |
| 7 | Uncertain replays keep their credit held until the 30-minute reaper | Implemented | **Yes, confirm** |
| 8 | Deny-by-default egress; role `worker`; `LINEAGE_LEASE_ENFORCED=true` | Implemented; set in the proposal | **Yes, confirm** |
| 9 | Rollback refuses while audit rows exist; archival owner | Implemented | **Yes**: who approves archival, and where the export goes |
| 10 | Who runs `authorize_discovery_smoke` and `stop_discovery_smoke` | Not assigned | **Yes**: name the administrator and the reconciler |

**Expected outcome under these caps.** A comparable production mission (`docs/lead-v2/LEAD_V2_CURRENT_PROCESS_DIAGRAM.md`) made **20 model
calls** and 15 provider purchases in its first slice. It billed **$0.27**
against a $0.07 ledger. With 4 model attempts and 5 purchases, the smoke
will stop at a cap well before evaluation finishes. It is a test of **safe
bounding**: refusal at each cap, held uncertain credit, correct reconciliation.
It is **not** a test of finding a qualified company. With one job search
of three rows, the realistic best case is one employer, read from those rows,
evaluated within four Luna attempts. Two separately reviewed
changes would be needed to test efficacy:
- more model attempts, which the $0.05 model budget cannot fund at Luna's
  4,000-token bound beyond about 4;
- more purchases.

**Superseded by #96.** The minimal orchestration skips the stages that do not
decide qualification, so the mission's four model attempts are the execution
plan, batch evaluation, mission evaluation and opportunity reasoning. With the
company-details lookup as evidence, the offline rehearsal (normal and slow job
search) persisted one qualified, evidence-backed lead inside every cap:
4 attempts, 2 purchases, 5 reads (3 + 2), 55,600 µ$ committed with the
company-details maximum set to a synthetic 5,000 µ$. The live run tests both
safe bounding and qualification; zero leads remains an honest outcome.

**Decide which test this is before running it.**

## 7. Isolated test project: the checklist

The step-by-step version, with exact SQL, the catalog and stop and
reconciliation commands, is `discovery-smoke-runbook.md`.

Each line is a separate approval. Production (`ohsdatpvfdjdemstoiuj`) and the
abandoned project (`wqnigjhcwjxtmordrwno`) are never targets; the script and
the workflow refuse both.

**A. Project and schema**
1. [ ] Create a new, empty free-tier project (`agentory-discovery-test`). No production data, and no GitHub integration. Record the ref.
2. [ ] Enable `pg_cron` and `pg_net`.
3. [ ] Run `TEST_PROJECT_REF=<ref> TEST_DB_URL=<url> scripts/test-project/build-test-schema.sh --confirm <ref> --with-held-billing-fix --with-held-admission` (50 files; cron jobs detached in the same transactions).
4. [ ] `select jobname from cron.job` lists only `sweep-stuck-runs` and `release-stale-credit-reservations`.
5. [ ] Confirm the held objects exist: `discovery_smoke_authorizations`, `discovery_smoke_operations`, `discovery_smoke_reconciliations` and the five RPCs. Confirm `service_role` cannot execute `authorize_discovery_smoke` or `reconcile_discovery_smoke_operation` (runbook, Phase 2).
6. [ ] Seed one internal workspace and grant it 10 credits. The mission cap stays 5.

**B. Credentials** (test-scoped; never production)
7. [ ] Create the GitHub Environment `discovery-test`, with a required reviewer.
   - Variables: `TEST_PROJECT_REF`, `TEST_WORKSPACE_ID`.
   - Secrets: `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_APIFY_API_TOKEN`, `TEST_OPENAI_API_KEY`. No Firecrawl, Lovable or Anthropic key (§2, §3); the proposal maps neither since #96.
8. [ ] Set the vendor account limits from §5.

**C. Activation**
9. [ ] Move `docs/launch/proposals/discovery-test-worker.workflow.yml` into `.github/workflows/` through a CI-only PR to `launch/hardening`. Its env equals `discovery-smoke-budget.spec.json` (`tests/infra/smokeBudgetSpec.test.ts`).
10. [ ] In one reviewed transaction, as an administrator:
    - insert one queue row with `run_budget {provider_usd: 0.20, max_candidates: 3}`;
    - run `select public.authorize_discovery_smoke(<queue_id>, '<pricing_version>', '<catalog>'::jsonb, '<actor_limits>'::jsonb, 300);`.

    The catalog is the approved one (`smoke-catalog-two-actor.json`), with every price observed ≤ 24 h earlier; `<actor_limits>` is `{"apify:harvestapi~linkedin-job-search": 1, "apify:harvestapi~linkedin-company": 1}`.
11. [ ] **Separate execution approval**, then one dispatch, typing the test ref.

**D. Stop** (in this order)
1. `select public.stop_discovery_smoke('<queue_id>', 'operator');` refuses every later admission at once.
2. `select * from public.cancel_lead_mission('<queue_id>', '<workspace_id>');`
3. Cancel the Actions run. SIGTERM drains the worker.
4. Abort any `RUNNING` Apify run in the Apify console. Stopping the worker does not stop a vendor run.
5. Clear `TEST_WORKSPACE_ID`, so no further run can claim.

**E. Reconcile** (before anything else runs)
12. [ ] Run `psql "$TEST_DB_URL" -v queue_id='<queue_id>' -f scripts/test-project/smoke-reconciliation.sql` once the authorization is no longer live. Close every listed purchase with `reconcile_discovery_smoke_operation(<queue>, <key>, <figure>, <reference>, <terminal status>)` against Apify's run history and final `usageTotalUsd` (runbook, Phase 7). Then compare every row's `committed_microusd` and `reported_microusd` with:
    - Apify;
    - the OpenAI project's usage.

    These reads happen outside the worker and buy nothing.
13. [ ] `select status, count(*) from credit_transactions group by 1;`. Every `reserved` row must be explained: an uncertain purchase stays held until the reaper.
14. [ ] Record actual vs committed. An actual charge above its template stops the authorization, and is a finding against that template.

**F. Rollback** (test project only)
- Keep the inactive schema. The held rollback refuses while audit rows exist, so export them first (decision 9).
- Pause or delete the project, and rotate every `discovery-test` secret.

## 6b. Still requiring your approval

1. **Receipt deferral.** Implemented durably in #96: an open purchase blocks
   the next mission until it is reconciled. Approve the procedure (runbook,
   Phase 7).
2. **The smoke profile** (spec `first_smoke_profile`, #96):
   - one job search (1 title, 1 location, 3 rows);
   - one company-details lookup (1 URL, no searches);
   - no Firecrawl;
   - Luna only, minimal orchestration;
   - five reads, 3 + 2.
3. **The templates** in `smoke-catalog-two-actor.json`, the company-details
   maximum once observed, and the actor limits
   `{apify:harvestapi~linkedin-job-search: 1, apify:harvestapi~linkedin-company: 1}`.
4. **The Luna template** (B = 32,768, O = 4,000, 11,400 µ$) once its price is
   observed; Terra and Anthropic refused.
5. **The remaining §6 rows** (1, 4, 5, 7–10), the account limits in §5, and
   the hosting-dashboard confirmations.
6. **Follow-ups outside the smoke:**
   - the legacy jobs adapter's stale `count`, which affects customer runs;
   - Firecrawl's variable-credit undercount (§2);
   - the `reserve()` NaN check (#92).

## 8. Readiness

| Area | Code-complete | Offline rehearsal | Live test |
|---|---|---|---|
| Durable admission: money, counts, deadline, fencing, no refunds | ✅ #90, verified | ✅ | ⛔ not applied to any database |
| Five-read Apify lifecycle, settled receipt, reconciliation | ✅ #94, #96 (3 + 2, durable reconciliation) | ✅ (two runs; one qualified lead) | ⛔ procedure approval (§6b.1) |
| Vendor cap, billed-entry bounds, one-search smoke bound | ✅ #94 | ✅ | ⛔ template values not approved |
| Wall clock (opt-in) | ✅ #92, verified | ✅ | ⛔ the worker is not activated |
| Models: Luna only; Terra and Anthropic refused | ✅ | ✅ | ⛔ Luna price not observed; request sizes not measured |
| Firecrawl omitted | ✅ | ✅ | ✅ decision; ⛔ variable-credit defect open for later inclusion |
| Price evidence | Public Apify prices obtained | n/a | ⛔ account tier, company-details maximum, Luna price, read charges |
| Test project, credentials, account limits | ✅ build script and workflow proposal | n/a | ⛔ nothing provisioned |
| Operator roles, archival, execution approval | n/a | n/a | ⛔ not assigned |

**Verdict:**
- **Offline rehearsal: READY to start.** No code blocker remains. Every
  stage's lifecycle already runs offline through the real gate and admission
  RPC (DB contract lane). What does not exist yet is a harness that drives one
  **whole** mission (`run-agent` through the worker, smoke mode, fake vendors,
  local Postgres with the held schema). Building it is the rehearsal's first
  task, and it is also where the real request sizes (§5) get measured.
- **The live mission is BLOCKED** (§6b).
