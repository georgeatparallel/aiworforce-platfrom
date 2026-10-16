# Smoke integration after PR #90: what was taken, what was not, what is left

**Status: BLOCKED.** Nothing here applies a migration, deploys, creates a
credential or starts a mission. Every new switch is off unless set.

**Next:** `discovery-smoke-readiness.md` covers what remains before a live
test: the reads plan, the pricing evidence, model routing, #90's decisions,
and the test-project checklist.

PR #90 (durable smoke admission) merged into `launch/hardening` at
`b4ffcd20`. Its tree is identical to the head Codex verified,
`4c094d2f`. This document compares Codex's three smoke branches with that
merged base and records what this integration PR takes from them.

## The three branches against the merged base

All three fork from `9453b7c5`, the base before #90.

| Branch (head) | Content | Decision |
|---|---|---|
| `codex/smoke-durable-admission-proposal` (`a64aa848`) | Reference SQL (`docs/launch/proposals/smoke-budget/0001.*.sql`) for two tables and four RPCs. Offline PGlite, native and mutation tests in `tests/proposals/`. | **Superseded; not merged.** #90 implements this design: the same tables and RPCs, caps, no-refund rule, guarded rollback, lock-then-clock deadline, billable polls counted as purchases, and 24 h quote freshness. It adds queue keying, ownership fencing through commit and request-hash checks. Merging the proposal SQL would add a second, unwired admission design beside the real one. Its native contention and failure-injection scenarios run against the **real** #90 SQL in Codex's review harness (`codex/review-pr90-smoke-safety`, SAF-001…008). |
| `codex/smoke-execution-guards` (`9aec00da`) | Runtime work: (a) request-local model-attempt reservation, strict pricing, `stopBeforeAttempt` and a budget wired through every strategist binding; (b) `budgetPolicy.reserve` refuses non-finite quotes; (c) an opt-in 300 s mission wall clock from the queue row; (d) three passing characterizations of unsafe paths. | **(c) taken.** (a), (b) and (d) not taken; reasons below. |
| `codex/smoke-budget-spec` (`ae0fa524`) | The budget spec JSON, its infra tests, a read-only workflow audit, and two dated narrative reports. | **Spec taken and updated** to v2. The audit and the dated reports are not copied: they describe the pre-#90 tree, and their findings are resolved below. |

### From `smoke-execution-guards`

**Taken: the opt-in mission wall clock** (`missionWallClock.ts`, the runner,
and `worker/main.ts`). With `LEAD_V2_SMOKE_WALL_CLOCK` set:
- Every slice's deadline ends at queue `created_at` + 300 s. That is the
  same anchor the admission RPC uses, so the mission stops instead of running
  on refusals.
- A restart or a lost checkpoint cannot renew the deadline.
- An unreadable or future timestamp refuses before the handler.

One change from Codex's version: a timestamp up to 30 s in the worker's
future is accepted. `created_at` is the database clock, so without this a
worker clock slightly behind it would refuse a fresh mission. The expiry is
unchanged, `created_at + 300 s`. Unset, the runner behaves exactly as before.

**Not taken: the local model-attempt layer (a).** In the smoke, #90's gate
admits each physical model attempt durably, against a mission-wide cap of 4
and an approved price. That covers retries, fallbacks and the strategist.
The local layer has a different scope: it is request-local and resets per
slice and process, as Codex's own test notes. Adopting it would mean two
model-attempt authorities with different semantics. It would also change
customer runs, because `stopBeforeAttempt` was wired unconditionally across
about 15 call sites.

**Not taken: the `reserve` price check (b).** Unpriced calls already carry a
`+Infinity` estimate (`webEvidenceSpec.ts`), which every ceiling refuses.
Only a corrupted NaN or negative estimate slips through. The change also
relabels existing refusals from `call` to `price` for customers. It is a
reasonable, separate hardening PR outside smoke scope. Suggested shape:
refuse NaN and negative values, and keep `+Infinity` as `call`.

**Replaced: the three gap characterizations (d).** Each test passes by
reproducing an unsafe outcome against the local layer, through an injected
`fetchImpl`. No production caller injects one: the strategist adapter calls
the process `fetch` at call time, which in the smoke is #90's gate. This PR
adds regressions that assert the safe outcome through the real gate and the
real admission RPC:
- an unpriced strategist model, and the Lovable gateway, send nothing;
- six concurrent strategist attempts produce exactly four physical starts.

The Firecrawl retry gap is already pinned by #90's test "firecrawl: the
scrape's own retry after a 5xx is the same purchase and is never sent twice".

### From `smoke-budget-spec`

Spec v2 (`discovery-smoke-budget.spec.json`) keeps every limit:
- $0.25 total, split $0.20 provider and $0.05 model;
- 5 purchases and 4 model attempts;
- 300 s;
- 1 page and 5 polls, counted independently;
- per-actor allowances.

Changes from v1:
- `enforcement` now names what enforces each limit after #90.
- The candidate environment drops `MODEL_RUN_MAX_ALL_CALLS` and
  `MODEL_RUN_REQUIRE_PRICED`. Their code is not taken; the durable cap and
  template pricing replace them.
- It adds `DISCOVERY_SMOKE_ADMISSION`, `LEAD_V2_SMOKE_WALL_CLOCK` and
  `LEAD_STRATEGIST_PROVIDER`.
- It equals the worker proposal exactly.

`tests/infra/smokeBudgetSpec.test.ts` fails if the spec, the held
migration's hard `CHECK` caps and the worker proposal disagree, if
activation is marked ready, or if any workflow, `railway.json` or the
Dockerfile turns a smoke switch on.

Codex's workflow audit found three proposal defects. All are fixed in the
inactive proposal:
- no absolute deadline (`LEAD_V2_SMOKE_WALL_CLOCK: enforce` added);
- no OpenAI key mapping (`OPENAI_API_KEY` from `TEST_OPENAI_API_KEY` added);
- the strategist defaults to the Lovable gateway, which the gate refuses
  (found here; `LEAD_STRATEGIST_PROVIDER: openai` added and the Lovable key
  removed).

## Proposed isolated Supabase test environment

Nothing below exists yet. Each step needs its own approval
(`test-project-checklist.md`, `test-worker-hosting.md` §4).

**Supabase project**
- New free-tier project `agentory-discovery-test`, with no production data.
- Never `ohsdatpvfdjdemstoiuj` (production) or `wqnigjhcwjxtmordrwno`
  (abandoned). The build script and workflow refuse both.
- Extensions: `pg_cron` and `pg_net`.
- No GitHub integration; schema only through the build script.

**Schema**
- Build with `build-test-schema.sh --confirm <ref> --with-held-billing-fix --with-held-admission` (50 files).
- Every cron migration is detached in the same transaction.
- Afterwards, `cron.job` must list only `sweep-stuck-runs` and
  `release-stale-credit-reservations`.

**Edge functions**
- None deployed. The worker runs `run-agent` in-process, and the gate
  refuses edge-function URLs.

**Data**
- One internal workspace, granted 10 credits; the mission cap is 5.
- One queue row, inserted by reviewed SQL.
- `authorize_discovery_smoke(queue_id, pricing_version, catalog, actor_limits, 300)`,
  run by an administrator in the same transaction.

**Worker**
- The inactive proposal workflow, moved into `.github/workflows/` by a CI-only PR.
- Dispatched manually, one session, with `timeout-minutes: 45`.

**GitHub Environment `discovery-test`**
- Required reviewer.
- Variables: `TEST_PROJECT_REF`, `TEST_WORKSPACE_ID`.
- Secrets: `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`,
  `TEST_SUPABASE_ANON_KEY`, and the provider keys below.

**Provider keys** (all test-scoped)
- `TEST_APIFY_API_TOKEN`, with the account usage limit at its minimum.
- `TEST_OPENAI_API_KEY`: a dedicated project with a budget.
- `TEST_ANTHROPIC_API_KEY`: a workspace with a spend limit.
- `TEST_FIRECRAWL_API_KEY`: smallest prepaid credits. Omit it to leave
  Firecrawl out.

**Worker settings**
- Exactly the spec's `candidate_environment_spec_not_applied`.

**Stop**
1. `stop_discovery_smoke`.
2. `cancel_lead_mission`.
3. Abort the Apify run.
4. Clear `TEST_WORKSPACE_ID`.

**Reconcile**
- Check every `discovery_smoke_operations` row against vendor run history,
  receipts and `credit_transactions` before anything else runs.

## Outstanding operator and pricing decisions before any live test

1. **Approve #90's ten policy decisions** (`discovery-smoke-admission.md`).
   The ones that need numbers:
   - the poll allowance against Apify's cadence;
   - the pinned vendor caps;
   - the input-token bound;
   - refusing calls without `maxTokens`.
2. **The quote catalog.** For each actor and model, record:
   - a verified upper price in micro-USD;
   - its source and liability reference;
   - an observation within 24 h of `authorize_discovery_smoke`.

   The catalog must cover:
   - both Apify actors, priced pay-per-result, pay-per-event, or with
     platform and rental fees included;
   - Firecrawl map and scrape at the plan's USD per credit;
   - every model the mission routes to. That includes the strategist's
     OpenAI model and the Anthropic fallback; an unlisted model is refused.

   No guessed rates.
3. **The actor limits**: job search 2, company details 1, map 1 and scrape 1,
   all within 5 purchases.
4. **Account-level limits** at each vendor. These are the only hard external
   stop for work already sent.
5. **Strategist provider = OpenAI for the smoke.** Confirm that this
   configuration, used only in the test environment, is acceptable.
6. **Who** runs `authorize_discovery_smoke` and `stop_discovery_smoke`, and
   who reconciles afterwards.
7. **Rollback and archival** of audit rows after the run. The held rollback
   refuses while any row exists.
8. **Netlify, Lovable, Render and Vercel** dashboard confirmations, still
   pending in `merge-safety-checklist.md`.
9. **The separate approvals**, in order:
   1. create the project;
   2. build the schema;
   3. move the workflow;
   4. enqueue and authorize;
   5. dispatch.
