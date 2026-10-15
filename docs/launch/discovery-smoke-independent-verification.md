# Independent smoke safety verification — NO-GO

Reviewed base: **9453b7c5**. Existing guards/specification branches remain
independent and retain their original commits. No runtime production code,
reference SQL, held migration, billing policy, Claude branch, worker proposal or
CI workflow was changed during this verification. All new controls use synthetic
fixtures and mocked providers; repository-source observations are not production
captures. No actual vendor receipt or current price was obtained.

## Evidence and results

| Check                                         | Result                         | Scope                                                                                                                                 |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Native final-dollar contention                | Passed                         | Two independent PostgreSQL sessions; only one 30000-microdollar model reservation fits a 50000 limit                                  |
| Native duplicate contention                   | Passed                         | One fresh admission; competing claimant stays uncertain and receives no second purchase permit                                        |
| Native lock-wait deadline                     | Passed                         | Admission checks the database clock after its lock wait and refuses expired work                                                      |
| Native failure injection                      | 8 passed                       | Before/after mock POST, lost checkpoint, re-enqueue, stale generation/lease, cancellation, uncertain billing, retries/unknown pricing |
| Native mutations                              | 2 killed                       | Removing the authorization lock or using transaction-start `now()` breaks the associated invariant                                    |
| Complete reference proposal suite             | 46 passed, zero failed/ignored | Original 33 embedded controls plus 13 native controls                                                                                 |
| Focused runtime regressions/characterizations | 132 passed                     | Includes 29 local guard tests and 3 explicit unsafe-path characterizations                                                            |
| Existing local guard mutations                | 7 killed                       | Attempt cap, drain retention, GPT admission, uncertain hold, unknown price, provider quote, fixed queue anchor                        |
| Worker/spec/held-credit/claim checks          | 26 passed                      | Includes 7 spec/audit tests; no database migration or deployment                                                                      |

The initial native harness double-encoded JSONB using a string; its parameters
now use postgres.js `sql.json()`. All three requested tests pass after that
fixture correction. The native server was PostgreSQL 17.10 from the checksum-
verified `@embedded-postgres/linux-x64@17.10.0-beta.17` binary package. It used
a new `/tmp` cluster bound only to 127.0.0.1, with no hosted credentials or
existing environment database. Only reference SQL was loaded into disposable
scratch schemas. The server was stopped after verification.

A real native mutation exposed a meaningful race: without the authorization row
lock, worker B can read the old aggregate, wait at an INSERT's foreign key while
A reserves dollars, and then commit its stale decision. A lock somewhere in the
transaction is insufficient; admission must serialize **before** its budget
read. Tests also distinguish wall-clock deadline from transaction-start time.

These tests do not run Claude's adapter, the full Supabase/PostgREST schema or
live credit RPCs. Failure injection uses controlled exceptions/volatile-state
loss rather than OS SIGKILL or power failure. The mock credit reaper is explicit
synthetic state; existing customer-credit settlement rules are unchanged.
Passing reference tests does not imply physical transport coverage or an invoice
cap.

## Confirmed uncovered paths

Three active tests in `smokeAdmissionCoverageGaps.test.ts` reproduce unsafe
behavior. Their passing status is **characterization, not acceptance**:

1. The shared strategist transport calls `budget.check()` instead of prospective
   model-aware admission. Under strict pricing it still sends one unknown-price
   model request. Two concurrent strategist requests both start under a local
   one-attempt cap before either telemetry row exists. Both OpenAI and Lovable
   strategist adapters share this transport.
2. A Firecrawl scrape retries inside one logical `runTool` credit reservation. A
   mocked 500 then success yields **two physical POST attempts and one credit
   reservation**. Whether a failed request is billed remains UNKNOWN; neither a
   zero charge nor a second actual charge is inferred.

Claude's implementation must cover at least this physical-boundary inventory:

| Path                                   | Existing boundary                                                                | Missing independent durable proof                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GPT transport/retries                  | `gptProvider.ts` physical attempts; local collector guards on the feature branch | Combined durable USD/counter reservation and post-reservation failure recovery                                     |
| Strategist OpenAI/Lovable              | `leadStrategy/adapters/shared.ts`                                                | Model-aware prospective admission, unknown-price refusal and concurrency; confirmed local gap                      |
| Generic OpenAI/Anthropic attempt chain | `aiProvider.ts`                                                                  | Durable admission for every fallback/attempt if reachable within the mission; explicitly contain other agent paths |
| Apify start/adopt                      | `toolRegistry.ts` + engine/verifier recovery                                     | Each POST admitted exactly once; uncertainty must never reopen a purchase; run attachment must preserve fencing    |
| Apify status and dataset GETs          | `toolRegistry.ts`                                                                | One global read/poll count across slices, including reads during adoption                                          |
| Apify receipt settlement               | `providerReceipts.ts` and both `run-agent` settlement sites                      | Each transport read counts, including multiple reservations/settlement passes                                      |
| Firecrawl map/scrape/crawl             | `toolRegistry.ts`                                                                | Every physical POST and internal retry admitted; bounded request liability and returned/discovery pages            |
| Firecrawl crawl polling                | `toolRegistry.ts`                                                                | Global polling/deadline checks at every physical GET, not a reset local loop                                       |

This is a minimum audited inventory, not a claim that every transitive
application call graph is covered. Planning, re-planning, repairing and any
pre-worker model purchase attributable to this mission need an explicit budget
scope and the same durable authorization. No image, email, Radar or unrelated
agent path may silently become reachable under the smoke authorization.

## Worker specification compatibility

[`smoke-worker-independent-audit.json`](smoke-worker-independent-audit.json) is
generated by `tests/infra/smokeWorkflowAudit.ts`. It records **9 matching
repository declarations, 8 differences and 4 unverified guarantees out of 21
checks**; this is not a discovery accuracy measurement.

Missing declarations include `MODEL_RUN_MAX_ALL_CALLS`, strict model pricing,
the fixed-wall-clock option, specs enforcement and the shared cap workspace
binding. `OPENAI_API_KEY` is absent, although `gptProvider` requires it; future
wiring needs a test-only secret reference, never a production key. Declared
unpriced cap 2 and per-slice 150000 ms differ from the candidate spec's 4 and
300000 ms. Those smaller values are not themselves proof of overspending; they
also do not bound all priced/retried model calls or the original mission's wall
clock. Queueing, backoff, retries and re-enqueue cannot renew the deadline.

The proposal's one manual workflow/concurrency group and project/workspace
refusal declarations remain intact and inactive. Actual resolved workspace,
secret ownership and test-target isolation were not inspected. Static matches
cannot prove those runtime properties. No future worker file was edited.

## External billing and compatibility gate

A reservation is an application-side maximum commitment, not a provider invoice.
Actual prices and maximum input/output/result liability need verified bounds,
and external provider/account controls where necessary. Remote work may outlive
a local deadline. Late actual receipts exceeding a quote can stop new work but
cannot undo incurred cost. Neither a local counter, five-minute process/slice
setting nor a passing synthetic scenario proves a hard vendor billing guarantee.

Claude's durable implementation branch was **not visible among remote heads**
after completing the independent tests. Compatibility against that
implementation is therefore **PENDING**, not passed. The guards remain
compatible with the merged `9453b7c5` tree; the reference SQL was left unchanged
for Claude.

Before GO, review Claude's exact commit read-only, port/reuse the native and
failure invariants against its real API, intercept every reachable billable
transport, verify missing-RPC/write-failure/commit-uncertainty behavior, run
exact schema/credit contracts and reconcile worker settings/request bounds. Then
independently verify external liability controls and seek separate live
approval. **The first $0.25 mission remains BLOCKED.**
