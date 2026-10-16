# First Discovery smoke: operational readiness

**Status: CODE-COMPLETE, NOT LIVE-TEST-READY. The $0.25 mission stays BLOCKED.**
It runs only after a separate approval of the operator plan, the pricing, the
test environment and the execution itself.

`launch/hardening` at `c98ea690` contains:
- the durable admission (#90);
- the opt-in wall clock and spec v2 (#92).

Codex verified both at their exact heads. This document covers what is still
needed before a live test. It changes no runtime code and raises no limit.

Evidence used:
- the code on `c98ea690`;
- Apify's API reference (`act-runs-post`, `actor-run-get`) and the store pages
  of the two actors, read on 2026-10-16;
- Firecrawl's billing page (`docs.firecrawl.dev/billing`), read on 2026-10-16.

**Every price below is a public list figure or arithmetic on one. None is an
approved quote.**

## 1. Reads: what five can and cannot do

### What the code does today

| Read | Endpoint | Gated as |
|---|---|---|
| Status | `GET /v2/actor-runs/{id}` | `poll`, parent = the admitted start |
| Dataset | `GET /v2/datasets/{id}/items` | `poll`, parent = the admitted start |
| Resume in a later slice | `GET /v2/actor-runs/{id}` | `poll`, parent = the admitted start |
| Receipt | the usage fields of a status read (`usageTotalUsd`) | not a separate read |

The database allows **five reads per mission**, shared by every run. They are
counted separately from the one discovery page. A read priced above $0 would
also consume a purchase slot (`v_paid`), so the reads template must stay at
`maximum_microusd: 0`. That price is itself a decision (see §5).

After an Apify start, `toolRegistry` loops for up to 90 s:
1. sleep 3 s;
2. one status read;
3. repeat until a terminal status;
4. then one dataset read.

Five reads therefore cover about **12 s of one run**. The smoke expects two
Apify runs: the job search (the discovery page) and company details.

### Can five reads support the intended smoke as the code stands?

**No, not reliably.** Neither actor publishes a run time, and a cold Apify
container alone takes seconds. The likely outcome:
- the job-search run ends `pending`;
- its dataset is never read;
- the company-details run gets no reads at all;
- the mission ends with evidence `UNKNOWN`.

That is safe, but it does not test discovery. Twelve reads would not fix this
either. At a 3 s cadence, twelve reads cover about 36 s, and they would still
spend themselves on status before any dataset read.

### The smallest viable plan: five reads, no limit change

**This needs one separate, explicitly reviewed runtime change.**

Apify's status read accepts `waitForFinish`. Per `actor-run-get`, the default
is 0 and "the maximum value is 60". One read then waits server-side for up to
60 s instead of 3 s.

The change, active only when `smokeAdmissionActive()` is true:
- the status read sends `waitForFinish=60`, with a 70 s client timeout;
- the 3 s sleep is dropped;
- the dataset read is unchanged;
- nothing is added through the reads template's `pin_query`, because that
  would also pin the dataset read, and one template covers both.

| Run | Reads | Covers |
|---|---|---|
| Job search (discovery page) | 1 status (≤ 60 s) + 1 dataset | runs finishing ≤ ~60 s after start |
| Company details | 1 status (≤ 60 s) + 1 dataset | the same |
| Reserve | 1 | one extra status read for whichever run is still `RUNNING`, or a resume in slice 2 |
| **Total** | **5** | |

How it fits the other limits:
- **Time:** about 140 s of the 300 s mission deadline. The wall clock and the
  database deadline still bound it.
- **Firecrawl** (map and scrape) is synchronous and uses no reads.
- **Receipts:** the worker spends no read on them. Apify warns that "the first
  response after completion can still show preliminary costs". The final figure
  is reconciled **after** the mission, outside the worker (§7, step 12), and is
  never inferred from an exhausted read budget.

A start-side `waitForFinish` is **not** recommended. The start's client timeout
is 20 s, and a server wait close to it turns a slow answer into
`apify_start_uncertain`, which holds the credit.

If this change is not approved, the five-read smoke is still safe, but expect
`pending` and `UNKNOWN`. Raising the read cap needs a migration change and a
fresh review, and does not help unless the loop also changes.

## 2. Firecrawl

**The rate comes from configuration.**
- `FIRECRAWL_USD_PER_CREDIT` must be a finite, positive number
  (`resolveFirecrawlCreditPrice`).
- `FIRECRAWL_PRICE_TIER` records its provenance in free text, for example
  "Standard, 2026-10 invoice".
- In a USD-capped run, a missing, empty, zero, negative or non-numeric rate
  makes every map and scrape `unpriced`, and they are refused before transport
  (`webEvidenceCreditRate`). The budgeting fallback ($0.0064 per credit) is
  used **only** in uncapped runs.

**The proposal now maps both from reviewed GitHub Environment variables**
(`vars.TEST_FIRECRAWL_USD_PER_CREDIT` and `vars.TEST_FIRECRAWL_PRICE_TIER`).
A test pins that an unset variable, which expands to `""`, still refuses.
This resolves Codex's P2 on #92.

**The credit rule**, from the billing page on 2026-10-16:
- scrape: 1 credit per page;
- map: 1 credit per call;
- JSON format: +4 per page;
- PDF parsing: +1 per PDF page;
- zero data retention: +1 per page;
- the enhanced proxy is billed at the base credit.

The page publishes **no USD price per credit for a plan**. Its pay-as-you-go
top-ups imply about $0.005 (Hobby) to $0.001 (Scale) per credit. That is
arithmetic, not your rate: **the rate must come from your invoice.**

**Open risk: PDF pages.** A scrape that lands on a long PDF is billed per PDF
page. The scrape template pins `formats` and `proxy`, not PDF handling.
Before approval, either:
- pin PDF parsing off in the scrape template, if Firecrawl's current API
  offers it (verify; do not assume); or
- price the template at the largest PDF it could fetch; or
- leave scrape out of the first mission.

## 3. Model routing (the paths the V2 mission actually reaches)

- **Lead workflow models.** `gptProvider.ts`: "THE LEAD WORKFLOW'S ONLY MODEL.
  GPT, with no fallback." Every structured stage calls `api.openai.com` through
  `gptStructured`, with the router's model.
  - `gpt-5.6-luna` is the primary for every main stage.
  - `gpt-5.6-terra` is used only for the `*_repair` stages and as an
    escalation.
- **The OpenAI strategist.** With `LEAD_STRATEGIST_PROVIDER=openai`, the
  primary is `openai/gpt-5.6-luna`, sent as `gpt-5.6-luna`. Escalation is
  `openai/gpt-5.6-terra`. `max_completion_tokens` is 1600.
  - There is **no Anthropic strategist fallback.**
  - `plannerWrapper` labels its calls `orchestration_plan`, but the V2
    bindings inject the OpenAI strategist as its `generate`.
- **The Anthropic task policy** (`aiProvider.TASK_MODELS`: Haiku 4.5, with a
  `gpt-4.1-mini` fallback for `helper` and `tool_input_planning`) **is not on
  the V2 mission path:**
  - the V2 capability engine returns before `run-agent`'s generic
    `generateText` (`agent_execution`);
  - `planActorInput`, the `helper` caller, has no production call site;
  - the other Haiku tasks belong to other functions (chat, briefs, Company
    Brain).

  An unexpected Anthropic call would be refused anyway: it has no template.
  **Decision:** keep or drop `TEST_ANTHROPIC_API_KEY` (§5).
- **The legacy tier fallback** (`gpt-4.1`, `gpt-4.1-mini`, for any stage not
  yet routed) gets no template, so it is refused.

### Maximum cost per attempt

There is one template per model. Each admitted attempt reserves that
template's full maximum, and a request is refused if its bytes or its output
bound exceed the template's.

Output bounds on the mission path:
- 4,000: `gptStrategistModel` and `gptMissionModel` defaults;
- 3,000: execution planner;
- 2,000: discovery planner;
- 1,600: the strategist adapter;
- 1,200: opportunity reasoner;
- 700: route control.

The template's `max_output_tokens` must be **4,000**, or those stages are
refused.

The input bound is "tokens ≤ UTF-8 bytes", #90 decision 4. Using the repo's
list prices (`MODEL_PRICES`):

| Model | $/1M in / out | Per-attempt maximum (µ$) | B = 32,768 bytes, O = 4,000 | Fits 4 attempts in $0.05? |
|---|---|---|---|---|
| `gpt-5.6-luna` | 0.20 / 1.20 | 0.2·B + 1.2·O | **11,354 → template 11,400** | **Yes**: 45,600 ≤ 50,000 |
| `gpt-5.6-terra` | 2.00 / 12.00 | 2·B + 12·O | 113,536 | **No**: one attempt exceeds the whole model cap |
| `claude-haiku-4-5-20251001` | 1.00 / 5.00 | B + 5·O | 52,768 | n/a: not on the mission path |

**Recommendation:** approve one Luna template at B = 32,768 and O = 4,000.
Give Terra **no** template, so repairs and escalations are refused and the
mission degrades. Before approval:
- measure the real request sizes offline (§5): a stage whose prompt exceeds B
  is refused as `request_too_large`;
- re-verify Luna's price. Only Luna's entry in `MODEL_PRICES` cites a source
  ("published list price", effective 2026-08-21), and it must be re-observed
  within 24 h of authorization.

## 4. Apify: the jobs actor's limiter has changed

These findings are from the store and input-schema pages on 2026-10-16.

| Actor (template actor) | Pricing | What bounds the charge |
|---|---|---|
| `curious_coder/linkedin-jobs-scraper` (`apify:curious_coder~linkedin-jobs-scraper`) | **Pay per event**, "from $1.00 / 1,000 results"; "not charged for the Apify platform usage" | The current input has **no `count` field**. The limiter is `limitPerSource`, "maximum number of jobs to scrape from each input URL"; "leave empty to scrape … up to ~1000". `scrapeCompany` adds requests per job. |
| `harvestapi/linkedin-company` (`apify:harvestapi~linkedin-company`) | **Pay per event**, "from $3.00 / 1,000 companies" (the README says $4 per 1k) | One event per company returned |

**Our adapter (`curiousCoderJobsInput.ts`) sends `count` (10 to 100),
`scrapeCompany: true`, and one URL per keyword variant.** If the current
build ignores `count`, one run could scrape about 1,000 results per URL, about
$1 per URL. The database would detect the over-quote charge only **after**
it was billed.

Apify's run-level `maxItems` applies only to pay-per-result actors.
Per `act-runs-post`, `maxTotalChargeUsd` "cap[s] the total amount charged
for all pricing models". **Before any live run:**
1. Pin `maxTotalChargeUsd` in **every** Apify start template's `pin_query`,
   at or below that template's `maximum_microusd`. This is the only
   vendor-side money stop per run.
2. Pin the result limiter the **current** build honours: `pin_body:
   {"limitPerSource": 3}` for the jobs actor. Confirm on the actor's
   input-schema page that day.
3. Decide on `scrapeCompany`: pinning it `false` removes the extra per-job
   requests. Their event pricing is not published separately.
4. Pin `timeout` (and `memory`) as #90 decision 3 describes.

The adapter's stale `count` should be fixed in a separate reviewed change. For
the smoke, the template pins above bound the run without touching code.

## 5. Missing pricing evidence and account limits

| Item | Evidence needed (observed ≤ 24 h before `authorize_discovery_smoke`) | Status |
|---|---|---|
| Luna input/output price | OpenAI pricing for `gpt-5.6-luna`, from the test project's own pricing view | missing |
| Real request sizes per stage | An offline replay of the smoke mission with a recording fake transport: the largest request body per model call | missing (no fixture records it) |
| Jobs actor event table and limiter | Every pay-per-event event and price, including any `scrapeCompany` or actor-start events; that `limitPerSource` is honoured; that `maxTotalChargeUsd` stops the run | missing |
| Company-details event table | Price per company and any start event | missing |
| Apify reads at $0 | That status and dataset reads are free or negligible for these pay-per-event actors (otherwise each read also consumes a purchase slot) | missing |
| Firecrawl account rate | `FIRECRAWL_USD_PER_CREDIT` from the invoice, its tier, and the PDF decision (§2) | missing |
| Apify account | A usage limit at the lowest value allowed, on a test-only account and token | missing |
| OpenAI | A dedicated test project with a hard budget. A budget alert alone is not a hard stop. | missing |
| Anthropic | Either no key (recommended; not on the mission path), or a workspace with a spend limit | decision |
| Firecrawl account | Smallest prepaid credits, or leave Firecrawl out | missing |

## 6. #90's ten policy decisions

| # | Decision | Where it stands | Needs your approval |
|---|---|---|---|
| 1 | Migration design: queue-keyed, hard caps, no refund of capacity | Implemented, merged and verified; held, not applied | **Yes**: approve applying it to the test project only |
| 2 | Poll allowance vs cadence | Five reads; insufficient without the §1 change | **Yes**: approve the §1 change, or accept `pending`/`UNKNOWN` |
| 3 | Template-pinned vendor caps | Mechanism implemented; values not chosen | **Yes**: `maxTotalChargeUsd`, `limitPerSource`, `scrapeCompany`, `timeout`, `memory` (§4); Firecrawl `proxy: basic`, `formats`, PDF |
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
It is **not** a test of finding a qualified company. Two separately reviewed
changes would be needed to test efficacy:
- more model attempts, which the $0.05 model budget cannot fund at Luna's
  4,000-token bound beyond about 4;
- more purchases.

**Decide which test this is before running it.**

## 7. Isolated test project: the checklist

Each line is a separate approval. Production (`ohsdatpvfdjdemstoiuj`) and the
abandoned project (`wqnigjhcwjxtmordrwno`) are never targets; the script and
the workflow refuse both.

**A. Project and schema**
1. [ ] Create a new, empty free-tier project (`agentory-discovery-test`). No production data, and no GitHub integration. Record the ref.
2. [ ] Enable `pg_cron` and `pg_net`.
3. [ ] Run `TEST_PROJECT_REF=<ref> TEST_DB_URL=<url> scripts/test-project/build-test-schema.sh --confirm <ref> --with-held-billing-fix --with-held-admission` (50 files; cron jobs detached in the same transactions).
4. [ ] `select jobname from cron.job` lists only `sweep-stuck-runs` and `release-stale-credit-reservations`.
5. [ ] Confirm the held objects exist: `discovery_smoke_authorizations`, `discovery_smoke_operations` and the four RPCs. Confirm `service_role` cannot execute `authorize_discovery_smoke`.
6. [ ] Seed one internal workspace and grant it 10 credits. The mission cap stays 5.

**B. Credentials** (test-scoped; never production)
7. [ ] Create the GitHub Environment `discovery-test`, with a required reviewer.
   - Variables: `TEST_PROJECT_REF`, `TEST_WORKSPACE_ID`, `TEST_FIRECRAWL_USD_PER_CREDIT` and `TEST_FIRECRAWL_PRICE_TIER` (the last two only if Firecrawl is included).
   - Secrets: `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_APIFY_API_TOKEN`, `TEST_OPENAI_API_KEY`, `TEST_FIRECRAWL_API_KEY` (optional) and `TEST_ANTHROPIC_API_KEY` (§5 decision).
8. [ ] Set the vendor account limits from §5.

**C. Activation**
9. [ ] Move `docs/launch/proposals/discovery-test-worker.workflow.yml` into `.github/workflows/` through a CI-only PR to `launch/hardening`. Its env equals `discovery-smoke-budget.spec.json` (`tests/infra/smokeBudgetSpec.test.ts`).
10. [ ] In one reviewed transaction, as an administrator:
    - insert one queue row with `run_budget {provider_usd: 0.20, max_candidates: 3}`;
    - run `select public.authorize_discovery_smoke(<queue_id>, '<pricing_version>', '<catalog>'::jsonb, '<actor_limits>'::jsonb, 300);`.

    The catalog is the approved one, with every price observed ≤ 24 h earlier.
11. [ ] **Separate execution approval**, then one dispatch, typing the test ref.

**D. Stop** (in this order)
1. `select public.stop_discovery_smoke('<queue_id>', 'operator');` refuses every later admission at once.
2. `select * from public.cancel_lead_mission('<queue_id>', '<workspace_id>');`
3. Cancel the Actions run. SIGTERM drains the worker.
4. Abort any `RUNNING` Apify run in the Apify console. Stopping the worker does not stop a vendor run.
5. Clear `TEST_WORKSPACE_ID`, so no further run can claim.

**E. Reconcile** (before anything else runs)
12. [ ] For each row in `discovery_smoke_operations`, compare the provider run id, `committed_microusd` and `reported_microusd` with:
    - Apify's run history and final `usageTotalUsd` (read about 10 s after completion);
    - Firecrawl's usage page;
    - the OpenAI project's usage.

    These reads happen outside the worker and buy nothing.
13. [ ] `select status, count(*) from credit_transactions group by 1;`. Every `reserved` row must be explained: an uncertain purchase stays held until the reaper.
14. [ ] Record actual vs committed. An actual charge above its template stops the authorization, and is a finding against that template.

**F. Rollback** (test project only)
- Keep the inactive schema. The held rollback refuses while audit rows exist, so export them first (decision 9).
- Pause or delete the project, and rotate every `discovery-test` secret.

## 8. Readiness

| Area | Code-complete | Live-test-ready |
|---|---|---|
| Durable admission: money, counts, deadline, fencing, no refunds | ✅ merged in #90, verified (SAF-001…008) | ⛔ not applied to any database |
| Request bounds, egress, redirects, model shape | ✅ | ⛔ template values not approved |
| Wall clock (opt-in) | ✅ merged in #92, verified | ⛔ the worker is not activated |
| Strategist on OpenAI, Lovable refused | ✅ | ⛔ no Luna template approved |
| Firecrawl priced only from the account rate | ✅ (the proposal maps it) | ⛔ rate not approved; PDF decision open |
| Reads plan | ⚠️ five reads cover about 12 s of one run | ⛔ needs the §1 change, or acceptance of `UNKNOWN` |
| Apify vendor caps | ✅ mechanism | ⛔ `maxTotalChargeUsd`, `limitPerSource`, `scrapeCompany`, `timeout` not pinned; the adapter's `count` is stale |
| Price evidence (§5) | n/a | ⛔ none observed |
| Test project, credentials, account limits | ✅ build script and workflow proposal, tested offline | ⛔ nothing provisioned |
| Hosting-dashboard confirmations (Netlify, Lovable, Render, Vercel) | n/a | ⛔ pending (`merge-safety-checklist.md`) |
| Operator roles, archival, execution approval | n/a | ⛔ not assigned |
