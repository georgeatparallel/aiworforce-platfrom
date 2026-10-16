# Durable admission for the first controlled Discovery mission

**Status: HELD. Nothing here is applied, deployed or enabled.** The migration
lives in `supabase/migrations-held/`, and the worker gate stays off unless
`DISCOVERY_SMOKE_ADMISSION` is set. **The first $0.25 mission stays BLOCKED**
until the approvals at the end of this page are given and Codex's independent
failure-injection run has passed.

## What it guarantees

Before any billable request is sent, it needs one committed `admitted` answer
from the database. That covers every model attempt, provider purchase, retry,
fallback, status poll and dataset page. All admissions for a mission
serialize on a single authorization row. In that one transaction, each new
admission is checked against everything already admitted:

| Bound | Value (schema ceiling) |
|---|---|
| Provider USD (committed maxima, pending and uncertain included) | $0.20 |
| Model USD | $0.05 |
| Combined USD | $0.25 |
| Provider purchases (paid polls included) | 5 |
| Model attempts (retries and fallbacks included) | 4 |
| Per-actor purchases | from the approved `actor_limits` |
| Discovery pages | 1 |
| Provider polls (status and dataset reads, across the mission) | 5 |
| Deadline | queue `created_at` + at most 300 s, on the database clock, read **after** the lock |
| Ownership | queue claim and lease, the task bound to the queue row, `tasks.checkpoint_version`, the lineage lease, cancellation, and the request hash as approved |

The ceilings are `CHECK` constraints, so even an administrator cannot
authorize more without a new migration.

**Nothing is refunded.** An admitted operation keeps its committed maximum
whatever happens next: failure, timeout, a crash before or after the POST, a
lost checkpoint, or a customer-credit refund. That is why a restart, a
re-enqueue or a lost telemetry drain cannot buy more.

**The worker cannot widen it.** `service_role` can `SELECT` both tables and
`EXECUTE` admit, record and stop, and nothing else:
- It cannot insert, update or delete a row.
- It cannot call `authorize_discovery_smoke`.
- A new queue row has no authorization, so it can buy nothing.

## How it is wired

```
worker/main.ts            DISCOVERY_SMOKE_ADMISSION set → globalThis.fetch = gate (before run-agent loads)
worker/leadMissionRunner  each mission's handler call runs in its own context (AsyncLocalStorage):
                          queue row + worker id; task and generation set by onExecutionBound
run-agent                 onExecutionBound now also reports the slice's generation (D1 fence)
smokeAdmission.ts         classify → template → pin vendor caps → check limits → hash →
                          admit (RPC) → recheck revocation and deadline → send → record run id / charge
toolRegistry.ts           Apify and Firecrawl poll loops stop waiting on a refused poll (the run stays pending)
```

The gate sits at the transport layer, so a path nobody wired is not a gap. It
refuses:
- a request to a paid host that it does not recognise;
- any request made outside a bound mission;
- any request made before the task is bound.

| Physical request | Class | Callers covered |
|---|---|---|
| Apify `POST /v2/acts/{actor}/runs` | provider purchase | every `runTool("source_with_apify")`: jobs, company, people, decision makers, enrichment, lead actions, founders |
| Apify `GET /v2/actor-runs/{id}` | poll (parent by run id) | the 90 s wait loop, `resume_run_id` adoption, `providerReceipts` |
| Apify `GET /v2/datasets/{id}/items` | poll (parent by dataset id) | result reads |
| Firecrawl `POST /v2/scrape`, `/map`, `/crawl` | provider purchase | `scrape_url` (its internal retry is the same payload, so it is replayed and never re-sent) |
| Firecrawl `GET /v2/crawl/{id}` | poll | the crawl wait loop |
| OpenAI `POST /v1/chat/completions` | model attempt | `gptStructured` (and its retry), `aiProvider` OpenAI attempts |
| Anthropic `POST /v1/messages` | model attempt | `aiProvider` Anthropic attempts and fallbacks |
| project REST, Auth, Storage | free | the database itself |
| project `/functions/v1/*`, OpenAI images, Resend, Perplexity, any other host, any non-HTTPS URL | **refused** | would spend outside the gate |

**Refusals.** No request reaches the vendor. The gate answers with a
synthetic HTTP 409, which every caller already reads as a definite non-start:
- the Apify start reports `apify_start_failed:409`, and its credit is released;
- the model transports do not retry it.

One exception: a *replay* of a purchase that may already exist (`uncertain` or
`adopt`) answers 503 and is still not sent. That keeps it **uncertain**
everywhere, so #88's credit hold and #81's uncertain spend still apply.

## Codex review fixes (PR #90, review of `40d7c0aa`)

| ID | Defect | Fix |
|---|---|---|
| R1 | A later refusal (outage, stop, revocation) of a provider request refunded an earlier **uncertain** credit hold | Before asking for admission the gate reads whether this exact purchase (actor + payload) was already admitted. A refusal reads as uncertain (503) when it was, or when that cannot be ruled out; a provably-first purchase still refunds (409). |
| R2 | An uncertain Firecrawl purchase was refunded | **In smoke mode only** (the gate is the process's `fetch`), a Firecrawl 5xx, lost connection or uncertain replay is `firecrawl_uncertain:*`, held like `apify_start_uncertain`. Outside the smoke, Firecrawl errors and customer billing are unchanged. |
| R3 | Request bytes do not bound input tokens for remote media | Model requests must be the audited text-only shape: an allow-list of fields per vendor, text-only message content, no media/file/audio parts, tools, web search or streaming. Anything else is refused before admission. |
| R4 | Redirects escaped classification; non-fetch clients bypass a patched `fetch` | Every request (own API and admitted) is sent with `redirect: "manual"`; a 3xx is refused and never followed. **Scope: the gate covers `fetch` only; it is not a network sandbox.** `tests/infra/discoverySmokeAdmissionHeld.test.ts` walks the worker's whole import graph (425 files) and fails on any external module outside a reviewed list (today: supabase-js, `node:async_hooks`) or any `node:http(s)`/`net`/`tls`, `Deno.connect*`, WebSocket or XHR use. |
| R5 | A malformed `admitted` answer could bypass the deadline | The whole answer is validated (UUID token, the requested operation key, a safe non-negative integer commitment, a parseable deadline); anything else is `admission_unavailable` and nothing is sent. |
| R6 | A mission call that ended while its admission was in flight still sent | Closure is rechecked after admission, immediately before the send; the reservation stays consumed. |
| R7 | Charges reported in the Apify **start** response were ignored | Start and status responses are both read with the repository's receipt rule (larger of usage total and priced events, never their sum); the database keeps the largest report, so nothing is counted twice, and an over-quote stops further admissions. |
| R8 | Ownership reads were not fenced through commit | Admission now holds the queue, task and lineage rows `FOR SHARE` until it commits, in the heartbeat's own order (claims, fences, cancellation and lease RPCs each lock one of these rows; none touches the authorization). A cancellation, generation bump or lease change cannot commit while an admission is in flight: it waits, so the admission is ordered before it, and every admission after it is refused. Residual window: between an admission's commit and its socket write, a cancellation that commits is seen only through the worker's revocation signal (heartbeat) and the gate's post-admission recheck; no database can revoke a request already being sent. |

## The price is never the worker's

The authorization pins a catalog of reviewed **maximum-price templates**. For
each request, the gate:
1. finds the single template whose `allowed_kinds` and `allowed_actors` match;
2. applies its vendor-side caps (`pin_query`, `pin_body`);
3. checks the final request against `request_limits`;
4. sends the template id.

The database then charges that template's `maximum_microusd`. The gate
refuses the request if:
- no template matches, or more than one does;
- the model request has no output-token bound, or `n` is not 1;
- the body is larger than the bound, or cannot be read;
- a required field is unbounded.

```jsonc
{
  "apify_jobs": {
    "allowed_kinds": ["provider"], "allowed_actors": ["apify:curious_coder~linkedin-jobs-scraper"],
    "maximum_microusd": 60000, "discovery_page": true,
    "source": "<vendor page or invoice>", "liability_bound_ref": "<how the maximum was derived>",
    "observed_at": "<within 24 h of approval>",
    "request_limits": { "max_request_bytes": 4096, "pin_query": { "timeout": "120", "memory": "1024", "maxItems": "50" } }
  },
  "openai_mini": {
    "allowed_kinds": ["model"], "allowed_actors": ["openai:gpt-4.1-mini"], "maximum_microusd": 12000,
    "request_limits": { "max_request_bytes": 20000, "max_output_tokens": 1000 }, "...": "..."
  },
  "polls": { "allowed_kinds": ["poll"], "allowed_actors": ["apify:…"], "maximum_microusd": 0, "request_limits": {}, "...": "..." }
}
```

## Changes from Codex's proposal

The proposal is `docs/launch/proposals/smoke-budget/0001.up.sql` on
`codex/smoke-durable-admission-proposal`. It keeps the same two tables, the
same RPC names, the same caps, the no-refund rule, the guarded rollback, and
the refusal of `adopt` and `uncertain` replays. The changes are:

| # | Proposal | Problem found in review | Change |
|---|---|---|---|
| 1 | Authorization keyed on `lead_lineages` | A V2 lineage id is the root task id, which the handler creates during the first slice. No authorization could exist before the first paid call. | Keyed on `lead_mission_queue.id`, which exists at enqueue. `bind_lead_mission_execution` ties exactly one task to it. |
| 2 | Admission requires lineage `status = 'active'` | `acquire_lineage_lease` sets `running`, so every admission while leased would be `lost_ownership`. | Accepts `active` or `running`, with this task as the unexpired lease holder. |
| 3 | Locks task, then lineage `FOR SHARE`, then authorization | Couples to the heartbeat and fence lock order. | Locks the authorization (`FOR UPDATE`) first, then queue, task and lineage `FOR SHARE` in the heartbeat's own order, held through commit (R8 below). |
| 4 | Deadline = authorization time + 5 min | Disagrees with Codex's runtime wall clock (queue `created_at` + 300 s); late approval extended it. | Queue `created_at` + window (≤ 300 s). A late approval is refused; a second approval returns the same row and deadline. |
| 5 | Worker sends its own maximum and quote fields, matched against the catalog | Redundant: the worker could only echo the catalog. | Worker names a template; the database reads the maximum from it. |
| 6 | `page` as a separate admission before a purchase | Extra RPC per discovery purchase. | A template flag (`discovery_page`), counted on the purchase itself. |
| 7 | No queue-claim check | A worker that lost the queue row kept admitting until the lineage lease moved. | Requires `claimed_by`, an unexpired queue lease and `task_id` to match. |
| 8 | No identity check on the request | An edited queue request kept its authorization. | `sha256(request)` is pinned at approval; any change is `identity_mismatch`. |
| 9 | Run ids not unique; no dataset id | A poll could not find its parent by dataset id. | Unique run and dataset ids per authorization; poll parents are found by either. |
| 10 | Receipt and run attachment in one shape | — | `record_discovery_smoke_receipt` attaches immutable ids, plus the largest reported charge. Above the quote, it stops the authorization. |

## Billing is preserved

The gate runs inside `runTool`, after `authorizeProviderCall`, so the credit
rules are untouched:
- one credit per paid provider call;
- `credits_reserve` and `credits_finalize`;
- the #86 re-arm;
- the #88 uncertain hold;
- the 30-minute reaper.

The real-database tests prove each outcome:

| Outcome | Credit | Mission |
|---|---|---|
| Admitted purchase that ran | charged once | one operation, run id recorded |
| Refused admission (nothing sent) | released (`not_charged`) | nothing reserved |
| Vendor 5xx or timeout on start (uncertain) | **held** (`reserved`) | operation kept, no run id |
| Replay of an uncertain or admitted purchase | still held; no second charge | not sent; same operation answers |

## Tests (all offline; vendors are fakes; no network beyond localhost)

| Suite | Result |
|---|---|
| `tests/db-contract/smokeAdmission.contract.test.ts` (real Postgres 17 + PostgREST 12.2.3, the worker's role) | 21 passed |
| `tests/db-contract/smokeAdmissionRuntime.contract.test.ts` (gate installed as `fetch` in front of real `runTool`, `gptStructured`, `generateText`, the credit RPCs and the runner) | 8 passed |
| `tests/db-contract/mutation.sh`: 17 new mutants, each removing one guard (lock, deadline, clock-after-lock, generation, lease, re-key, each cap, poll limit, privilege, no-context pass-through, uncertain mapping, vendor caps, poll-loop break), plus 2 existing ones | 19 killed, each on its named test |
| `tests/edge-functions/_shared/smokeAdmission.test.ts` (classifier, limits, refusals, fail-closed RPC handling) | 12 passed |
| `tests/infra/discoverySmokeAdmissionHeld.test.ts` (held, privileges, ceilings, rollback, opt-in install) | 5 passed |

The races run on real concurrent sessions:
- twelve simultaneous model admissions admit exactly four;
- two purchases for the last provider dollars never both win;
- a duplicate dispatch admits exactly one;
- an admission still in flight holds the last slot until it commits;
- an admission that waited on the lock past the deadline is refused.

## Operator sequence (each step needs separate approval)

1. Build the test project with
   `build-test-schema.sh --confirm <ref> --with-held-billing-fix --with-held-admission`
   (50 files).
2. Dispatch the inactive worker proposal first, so the worker is idle and
   waiting. It sets `DISCOVERY_SMOKE_ADMISSION: enforce`,
   `LINEAGE_LEASE_ENFORCED: "true"` and role `worker`.
3. In one reviewed transaction, as an administrator:
   - insert the queue row;
   - `select public.authorize_discovery_smoke(<queue_id>, '<pricing version>', '<catalog>'::jsonb, '<actor limits>'::jsonb, 300);`
4. To stop:
   - `select public.stop_discovery_smoke('<queue_id>', 'operator');`
   - then `cancel_lead_mission`, as in the test-project checklist.
5. After the run, reconcile every row in `discovery_smoke_operations` against
   the vendors' own run history before anything else runs.

## Remaining vendor-side spending and timeout risks

The database bounds what **we** admit. It cannot bound what a vendor bills
for an admitted request. These remain:

1. **A run outlives the deadline.**
   - Admission stops at the deadline, but an Apify run already started keeps
     running vendor-side until it finishes or reaches its own `timeout`.
   - The template's pinned `timeout` (with `memory`) is the only vendor-side
     stop. Nothing aborts runs at our deadline.
   - Firecrawl and model requests in flight complete and bill even when our
     client aborts at 20 to 30 s.
2. **The maximum is only as good as the template.** The schema enforces
   reviewed numbers, not vendor truth. Apify pricing may stack:
   - pay-per-result: is `maxItems` honoured by this actor?
   - pay-per-event: `maxTotalChargeUsd`;
   - platform usage (compute, proxy, storage) on top;
   - a rental fee.

   Each must be verified per actor. A wrong maximum is detected only when a
   reported charge exceeds it, and that stops further admissions; it does not
   undo the charge.
3. **Late charge reports.** Apify posts per-result charges after a run reports
   `SUCCEEDED`, and `usageTotalUsd` can lag. If the last poll is admitted
   before the final figure exists, an over-quote charge may go unseen. Only
   the vendor's billing page is final.
4. **Firecrawl credits are not a currency.** Scrape cost varies with:
   - formats;
   - the proxy (`auto` may escalate to stealth; the template should pin `basic`);
   - the plan's USD per credit.

   Crawl has no template and is refused.
5. **Model input tokens.** The bound assumes input tokens are at most the
   request's UTF-8 bytes. That holds for byte-level BPE tokenizers, with
   per-message overhead covered by JSON framing, but it is an assumption
   needing approval. Long-context price tiers must be priced at the maximum
   size the template allows. Prompt caching only lowers cost.
6. **A stalled sender.** A worker that receives `admitted` and then stalls
   past the deadline is stopped by the local recheck. A stall *between* that
   recheck and the socket write can still send after the deadline, bounded by
   clock skew and scheduling delay. The liability was already reserved.
7. **Lost admission answers.** An RPC timeout after the database committed
   leaves a reserved slot that was never used. This is conservative: it costs
   capacity, not money.
8. **Account-level limits are the only hard external stop.** These are:
   - Apify's account usage limit;
   - an OpenAI project budget (a soft alert);
   - an Anthropic workspace spend limit;
   - Firecrawl's prepaid credits.

   Use test-scoped keys with the lowest limits the vendors allow.

## Policy decisions requiring approval

1. **The held migration's design.**
   - Authorization is keyed on the queue row.
   - The caps are hard `CHECK` ceilings.
   - Capacity is never refunded, and is independent of customer-credit
     refunds.
2. **Poll allowance vs cadence.**
   - Five polls per mission against the Apify loop's 3 s cadence is about
     15 s of waiting, so most runs will end `pending`, with evidence
     `UNKNOWN`.
   - Options:
     - accept that;
     - space polls;
     - use Apify `waitForFinish` long-polls;
     - raise the allowance.

     Each changes runtime behaviour or the spec.
3. **Vendor-side caps pinned by templates.**
   - Examples: Apify `timeout`, `memory`, `maxItems` and `maxTotalChargeUsd`;
     Firecrawl `proxy: "basic"` and allowed formats.
   - These alter the request in enforced mode only, and may truncate results.
4. **The model input-token bound** ("tokens ≤ UTF-8 bytes"), or a substitute
   tokenizer-based bound.
5. **Model calls without `maxTokens`.** Under enforcement these are refused,
   not guessed. Any mission stage that omits it degrades. Option: accept
   that, or add bounds to those calls (a runtime change).
6. **The template catalog itself.**
   - Every `maximum_microusd`, its source, its `liability_bound_ref`, and an
     observation within 24 h of approval.
   - The actor limits.
   - Reconcile them with Codex's `discovery-smoke-budget.spec.json`.
7. **Replays of uncertain purchases keep their credit held** until the
   30-minute reaper releases it (consistent with #88). Confirm.
8. **Enforcement is deny-by-default egress for the whole worker process.**
   - The process must run role `worker`: API routes in the same process are
     refused.
   - `LINEAGE_LEASE_ENFORCED` must be `true`, because admission requires the
     lease holder.
9. **Rollback.** It refuses while any audit row exists. Who approves
   archival, and where the export goes.
10. **Who runs `authorize_discovery_smoke`, and how.** It is run by an
    administrator in the same reviewed transaction as the enqueue.
