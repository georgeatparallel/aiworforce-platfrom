# Atomic smoke admission: precise proposal, never activation

This extends `codex/smoke-durable-admission-proposal` after all 15 Tier 0/1 PRs
merged at **9453b7c5**. [`0001.up.sql`](0001.up.sql) and
[`0001.down.sql`](0001.down.sql) are **review artifacts** outside both migration
directories. No bootstrap, workflow, worker or runtime loads them. Nothing is
applied to an environment. Tests execute the text in disposable offline
databases.

The first $0.25 mission remains **BLOCKED**. Passing a proposed admission RPC's
tests does not connect physical transports to it or verify any real prices. All
fixtures, maxima, hashes, receipts and observations in this suite are
**synthetic controls**, not historical captures or vendor invoices.

## Minimum database surface

Two new tables and four service/admin RPCs; no changes to existing billing,
credit transactions, execution observations, queue, lineage or task columns.

| Object                           | Contract                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery_smoke_authorizations` | Unique workspace/lineage authorization; immutable criteria hash, approved pricing templates, maximum amounts/counters and five-minute absolute deadline. Worker cannot create, replace, delete or extend it.                          |
| `discovery_smoke_operations`     | One persistent operation reservation, token, physical request digest, kind/actor, conservative committed maximum, original task/generation and optional run/receipt. No automatic release or deletion.                                |
| `authorize_discovery_smoke`      | Administrative approval only; worker `service_role` cannot call it. Same lineage returns the original identity/deadline; mismatched criteria/pricing templates refuse.                                                                |
| `admit_discovery_smoke`          | Task/generation/workspace/lineage/lease/cancellation checks, then authorization `FOR UPDATE`, then aggregate all holds and insert one admission in the same transaction. Only a fresh `admitted` response can allow transport.        |
| `record_discovery_smoke_receipt` | Attach one immutable run ID and actual receipt by reservation token, including after cancellation/expiry or generation loss. Cannot release/reprice commitments or grant transport. An over-quote receipt cancels further admissions. |
| `stop_discovery_smoke`           | One-way cancellation; no restart/reset RPC.                                                                                                                                                                                           |

The existing execution ledger admits duplicate observational rows and tolerates
write failures, so it cannot be the purchase authority. #82's held claims cover
provider identity, but not model liability or shared quotas. Keeping this draft
separate avoids changing Claude's objects; a reviewed future consolidation may
reuse its claim table, but cannot omit the authorization serialization point or
all-operation reservation identity.

USD uses integer millionths; 250000 = $0.25. Conservative fixed limits: provider
200000, model 50000, combined 250000; five provider purchases, four model
attempts, one discovery page, five global polls. Actor limits match the smoke
spec: two job searches, one company-details request, one map, one scrape; all
other provider actors refuse. A billable poll consumes both polling and provider
purchase/USD/actor allowances. A zero-priced provider start still consumes a
purchase. A page gate is separate from its provider purchase and consumes its
slot even if the later purchase is refused. No optimistic refunds.

The locked authorization serializes every operation kind across all workers.
Sums derive from at most the small admitted operation set, avoiding a third
counter table and avoiding checkpoint/ledger-write dependence. Authorization and
operation primary keys plus the provider payload unique index defend against
duplicate operation identities. Changing a key cannot rebuy the same
actor/payload. Replaying a key with different payload, kind, parent or quote
refuses. Replays return `adopt` or `uncertain`, **never `held_by_self`
permission to POST again**. All model physical retries need their own counted
operation.

An administrative approval pins a catalog of reviewed maximum-price request
templates in `approved_quotes`. Worker-supplied metadata alone cannot invent a
price: template ID, allowed kind/actor, maximum, limits hash, source, bound
reference and observation must match that catalog. Quotes older than 24 hours,
future/infinite dates, missing bounds and unknown pricing refuse. A catalog
entry is an approval artifact, not proof that an external invoice cannot exceed
it. Actual payloads must still satisfy the template's audited request limits at
the transport adapter; no such adapter is implemented in this proposal.

## Concurrency, recovery and persistent deadlines

Lock order: task `FOR SHARE`, lineage `FOR SHARE`, authorization `FOR UPDATE`,
then operation. Generation fencing remains `tasks.checkpoint_version`; current
lineage lease holder and expiry are additionally required. Check the database
clock **after** acquiring all locks. `now()` at transaction start is unsafe when
admission waits for a lock past expiry; the proposal uses `clock_timestamp()`.
No budget check happens only before the serialization lock.

A committed reservation precedes every POST/read. Crash before or after POST,
unknown start, missing run ID, lost checkpoint, telemetry drain and retry leave
the commitment consumed. A second process sees authoritative rows, not a local
counter. A new task/queue/slice using the same lineage must use the same
approved authorization; its deadline never changes. Worker credentials cannot
mint a new authorization even if they create a new lineage. Cleanup can attach
receipts without extending the deadline; further provider polling still requires
a fresh poll admission and stops at deadline/cancellation.

No RPC can atomically control an external network side effect. A stale or
expired worker can pause after receiving admission and before POST. Future
wiring must recheck ownership/deadline immediately before transport, consume a
single dispatch permission locally and use provider-side
idempotency/cancellation where available. The persisted reservation still bounds
reserved liability and prevents another worker rebuying that operation. Do not
claim exact remote stop time, strict single-process execution, or a maximum
actual invoice without verified external controls. One physical worker remains
an operator/configuration gate, not a property proved by these tables.

## Integration contract with merged Tier 1 code

No existing #77 funding recovery, #79/#81 fencing/recovery, #83 evidence reuse,
#86 credit re-arm or #88 uncertain-credit hold behavior is changed. The held #82
purchase claim and #86 credit SQL remain held and unwired where applicable. This
draft supersedes none of them by deployment accident.

A later reviewed runtime adapter must coordinate the existing purchase claim,
mission admission and credit reservation before transport. Acquire/adopt the
same stable logical operation; any refusal/uncertain claim, credit failure,
missing RPC or durable write failure means **no transport**, never fallback to
legacy admission. Credit failure after mission reservation may strand that
mission slot conservatively. Do not interpret `held_by_self` from #82 as a
second dispatch permit. Record the existing `onProviderRun`/uncertain-start
information without bypassing funding adoption or generation-fenced writes.

Only `admitted` from a committed transaction permits one physical operation; a
connection loss during commit is uncertain, so query/recover the same key, never
POST on the strength of a timed-out RPC. Models, Apify starts, Firecrawl,
discovery page gates, retry/fallback requests and every status/dataset/receipt
poll require this adapter. No transport path is exempt because its estimated
price is zero. A fixed provider template must bound returned rows and model
templates must bound input/output tokens; otherwise refuse. The SQL alone does
not enforce physical request parameters or validate observed company rows.

The existing one-credit-per-paid-provider-call policy and 30-minute uncertain
credit release behavior remain unchanged. Mission liability does **not** release
when the credit reaper refunds; counters and quote holds persist independently.
Models do not become provider credits. Policy approval is needed before any
mission-capacity refund/revaluation or reconciliation-driven new spending; none
is implemented. No approved worker role is allowed to widen caps or edit audit
rows directly. Database owners/administrators remain trusted.

## Rollback and approval sequence

Both SQL files wrap their changes in an explicit transaction, so a client
continuing after an SQL error cannot partially apply or destroy the schema. The
rollback removes only these four RPCs/two tables/index; it refuses while **any**
authorization or operation exists, even if cancelled. It does not delete cost
evidence, reverse credits or silently drop uncertain liabilities. For an empty
never-used scratch schema it rolls back/reapplies cleanly. After use, stop
admissions and drain/stop the worker, reconcile possible vendor liability,
export immutable records and obtain an explicit archival/destruction decision.
Keeping the inactive schema is the default. A runtime adapter with a missing RPC
must refuse, so schema rollback cannot reopen unbounded legacy transport.

Before application: approve the SQL and fixed conservative no-refund mission
capacity semantics; verify PostgreSQL/Supabase role privileges and the exact
merged schema; run true multi-session lock/crash tests and the existing billing
DB contract suite in an approved isolated target; review upper-price templates
and physical request bounds; review the adapter and transport-failure tests;
then seek separate approval for migration/application and later the live smoke.
No migration or production billing-policy change is authorized by this PR.

## Offline tests and limits of the proof

Use the existing cached Deno/npm dependencies; no paid provider or network
permission is needed for embedded tests:

```sh
deno test --cached-only --allow-read --allow-write --allow-env tests/proposals/smokeBudget.test.ts tests/proposals/smokeBudget.mutation.test.ts
```

The SQL suite exercises pending model/provider totals, simultaneous submitted
requests, same-key/re-keyed duplicates, crash/uncertainty/adoption, database
close/reopen, new generation and new task, actor/purchase/zero-price limits,
page/poll caps, unknown/stale quotes, cancelled/expired missions, failed durable
writes, actual-versus-estimated evidence, role restrictions and guarded
rollback. Mutation controls remove one guard at a time and require its invariant
to fail.

**PGlite is a single backend and serializes submitted transactions.** These
results prove SQL state transitions, not PostgreSQL multi-session contention,
PostgREST role/transaction behavior, hard process-kill durability or actual
physical purchase prevention. Close/reopen is a persisted-state restart test,
not a power-loss/fsync guarantee.

`tests/proposals/smokeBudget.postgres.test.ts` prepares three native
multi-session proofs: competing final dollars, duplicate dispatch, and deadline
expiry during a lock wait. They are explicitly ignored when
`SMOKE_PROPOSAL_PG_URL` is absent. The URL must name an **existing localhost
`contract_*` scratch database**; the tests require the existing contract roles
(`anon`, `authenticated`, `service_role`) and use/drop only a unique schema
there. They start no server, provision no infrastructure and never load
repository migrations. Do not point at a tunnel or any production database.
These tests need the already installed `postgres` npm dependency used by the
existing DB contract harness. Run only in an approved scratch target, with
loopback-only network permission:

```sh
deno test --cached-only --allow-read --allow-env --allow-net=127.0.0.1,localhost tests/proposals/smokeBudget.postgres.test.ts
```

The independent verification follow-up ran all three tests on an isolated native
PostgreSQL 17.10 database: **three passed, zero ignored**. The initial native
harness double-encoded JSONB parameters; it now uses postgres.js `sql.json()`.
Eight additional reference-contract/mock-provider failure cases and two native
mutation controls also passed. No Claude database implementation is claimed
verified by these reference tests; no production schema was changed.

## Initial proposal validation (before independent native verification)

On the `9453b7c5` base, the complete proposal suite reports **33 passed, zero
failed, three ignored**: 21 SQL/state/permissions/rollback controls and 12
mutation controls. The three ignored tests are the native multi-session proofs
above, not expected failures or passing enforcement guarantees. All four test
modules type-check and lint. SQL controls run without network permission.

The separate runtime branch on the same base reports 8,653 edge tests passed,
270 Replay tests passed with one existing ignored display-only case, and all
seven runtime guard mutations killed. Funding-screen interrupted-run adoption
passes. These runtime tests exercise the existing qualification/recovery code;
they do not wire this proposed admission gateway into any physical transport.

## Independent native verification follow-up

Base remains `9453b7c5`. The complete reference suite now reports **46 passed,
zero failed, zero ignored** when the isolated native URL is supplied: the
original 33 embedded controls, three native contention tests, eight native
failure-injection cases and two native mutation controls. Removing the admission
row lock admits a second 30000-microdollar model reservation after the first
consumes the same 50000 limit. A foreign-key lock can delay insertion without
protecting the earlier budget check. Replacing the post-lock clock with
transaction-start `now()` also fails its native deadline invariant.

Failure cases exercise durable admission followed by a simulated worker crash
before or after a mock POST, checkpoint loss after run attachment, new task and
generation, stale/expired lease, cancellation, duplicate/re-keyed provider
questions, uncertain credit disposition and model retries/unknown quote. Mock
credit reaping is explicitly synthetic; no customer ledger is changed. These are
controlled exception/checkpoint-loss injections, not OS SIGKILL, power-loss or
fsync proofs and not execution of a production adapter.

The local server was initialized only in a new `/tmp` cluster, bound to
127.0.0.1 and stopped after validation. No Docker/hosted database, production
credential, live model/provider or environment migration was used. Native
binaries came from checksum-verified `@embedded-postgres/linux-x64` version
`17.10.0-beta.17`; the underlying server reports PostgreSQL 17.10. This is a
local verification dependency only, not a runtime or package manifest change.
Run all proposal tests with an existing isolated scratch database and:

```sh
deno test --cached-only --allow-read --allow-write --allow-env --allow-net=127.0.0.1 tests/proposals/
```

Claude's durable implementation was not present among visible remote branches at
verification time. Physical billable-path coverage and compatibility remain
**UNVERIFIED**, so the first live mission stays BLOCKED despite these results.
