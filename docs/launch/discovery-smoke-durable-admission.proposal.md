# Durable smoke admission — proposal only; implementation stopped

**No executable migration, database change or new runtime gateway is included.**
The first $0.25 mission remains blocked. This document identifies the part of
the approved sprint that cannot safely be implemented with the current
checkpoint and observation-ledger interfaces. Claude owns billing/database
integration; review this contract with that work before authorizing a migration
or admission wiring.

## Why existing storage is insufficient for the hard guarantee

1. `ModelCallCollector` is per request. A new worker loses its committed attempt
   count; model rows are written after transport, so a crash before telemetry
   flush leaves no durable model purchase. The new local attempt guard fixes
   same-request races and retry admission, not this loss.
2. The model USD meter sums prior workspace usage once at request start. It
   neither reserves the next call nor locks shared remaining authorization.
   Counting unknown-rate calls bounds volume, not money.
3. Provider `budgetPolicy.reserve` is synchronous in one JS isolate; that is
   enough for concurrent calls sharing that ledger, not for two independently
   restored workers. The durable spend floor reads recorded execution rows, but
   a read is not an atomic prospective reservation. An observational ledger
   writer that swallows errors cannot serve as authorization to buy.
4. The existing #82 held purchase-claim proposal prevents competing owners from
   buying the same key, but does not atomically enforce a shared USD/call/actor/
   page/poll quota or reserve model liability. It is not wired into runtime.
5. The fixed queue deadline derives from immutable server-side `created_at`,
   survives same-row retries/checkpoint loss, and permits finalization without
   starting further paid work. A new queue row or deleting the original row must
   not renew an approved logical mission's deadline. That authorization requires
   a durable identity separate from transient task/checkpoint data.
6. Neither an estimated ledger cap nor a local deadline guarantees that a vendor
   cannot bill more than the estimate or keep running after timeout. Known model
   rate is not proof of a prospective maximum token charge. Pending and
   uncertain operations remain liabilities even when no result was received.

These are verified enforcement boundaries, not reasons to alter qualification,
guess prices, overwrite billing policy or activate the test worker.

## Smallest durable contract to review

Reuse existing workspace/lineage ownership and idempotency vocabulary. A
separate immutable **mission authorization** and transactional **operation
reservation** are needed, either as a reviewed extension of #82 or an isolated
held migration. Do not put the counters only in `tasks.result` or
`lead_lineages.current_state`: checkpoint failure and existing state replacement
can lose them. Final table/RPC names and deployment order remain a database
review decision; no DDL is invented or applied here.

Authorization must pin: one workspace, logical mission/authorization identity,
compiled criteria hash, original absolute deadline, provider USD ceiling $0.20,
model USD ceiling $0.05, combined USD ceiling $0.25, provider purchase count 5,
model attempt count 4, actor purchase limits, discovery rows/pages, global
polls, and exact quote-policy/pricing version. New task, generation, process or
queue row carries this identity; it cannot reset or widen authorization.

An admission transaction must:

1. Lock the authorization row and validate workspace, mission identity, current
   lease/fence, cancellation and the original deadline using the database clock.
2. Look up the operation's stable idempotency identity before consuming a slot.
   Already-started provider operation means adopt its named run; unresolved
   uncertain start means hold, not repurchase. A distinct billable model retry
   is a distinct charged attempt, not a free retry. Never reuse a reservation
   key for different payload/model/actor/quote parameters.
3. Require a finite, nonnegative, conservatively bounded quote with source,
   observation date, currency, billed-by vendor, pricing version and exact
   request limits. Unknown rate/usage maximum refuses; never substitute $0.
   Bound input/output tokens using an audited method, not a guessed character
   ratio. Cache discounts cannot lower a worst-case uncached-input reservation.
4. Check aggregate committed provider/model/combined dollars including reserved,
   in-flight and uncertain operations, total purchase/attempt counts, actor
   counts, discovery limits and global poll counts in the same transaction.
5. Persist the reservation and increment counters **before transport**. A failed
   RPC or failed durable write is refusal, never a logging warning followed by a
   purchase. A process dying after admission retains the slot/liability.
6. Return a bounded admission identity and immutable payload digest. Before
   sending, reject an expired/cancelled/lost-owner authorization. Attach
   provider run IDs durably and adopt by them; retain unresolved unknown-start
   state.

All status/dataset/receipt reads that count as provider polling need their own
global transport admission, even when free of new purchase cost. The allowance
is five across the authorization, not five per provider/slice. Exhaustion keeps
run IDs and evidence UNKNOWN for reconciliation; it does not discard pending
funding recovery or invent a hard negative.

## Accounting and billing decisions

Keep committed maximum quotes, provisional estimates and actual receipt amounts
separate. Model token-table cost remains an estimate unless a vendor invoice
reports it. Pending/uncertain charges keep their conservative liability.
Failure, timeout, cancellation, missing usage or checkpoint loss does not prove
no charge. No slot or monetary capacity is refunded automatically merely because
the application got no answer.

Purchase-count slots should remain consumed conservatively for attempts that
could have started, even if later billing reconciliation refunds a customer
credit. Do not revalue model calls as provider credits: the existing rule is one
credit per paid provider call. Coordinate real credit-reserve/re-arm/hold
semantics with Claude's #86/#88 work rather than modifying it here.

Releasing a quote after verified no-start/no-bill evidence, reconciling a lower
actual charge, dealing with vendor invoice overages, and the lifetime of
uncertain holds need an explicit reviewed policy. An admission transaction alone
cannot guarantee a $0.25 vendor invoice without validated liability bounds and
external provider spending/cancellation controls where necessary.

The worker may safely checkpoint and finish releasing claims after the deadline;
this never renews permission to start a paid operation. Vendor runs already in
flight can outlive it. Do not describe this as a five-minute vendor-execution or
hard process-kill guarantee.

## Required failure-injection proof before activation

Reuse Replay Lab/ChaosLab and the real database-contract lane; do not introduce
another scheduler or a duplicate GitHub Actions worker proposal.

| Failure/control                           | Required proof                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Priced and unpriced model attempts        | All physical attempts debit the same durable mission counter; unknown rate/maximum refuses before transport             |
| Simultaneous model/provider reservations  | Two transactions racing for the last dollars/slot cannot both obtain admission                                          |
| Pending or uncertain provider purchase    | Reserved liability survives; no automatic refund or re-buy; receipt is not assumed zero                                 |
| Crash after reservation/before POST       | Slot persists conservatively; resume cannot silently create a new purchase                                              |
| Crash after POST/before run ID/checkpoint | Original key stays uncertain; no duplicate POST until positively reconciled                                             |
| Lost checkpoint or telemetry drain        | Read authoritative reservations; no budget reset and no duplicate accounting                                            |
| Continuation/new worker/new queue         | Original deadline and counters remain; expiration stops new paid work and ends honestly                                 |
| Repeated page/re-plan/poll                | One-page and five-global-poll limits persist across all slices; repeated questions do not buy new provider runs         |
| Cancellation/lost lease                   | Reject new admissions and sends; preserve pending IDs, checkpoint and release consistently                              |
| Budget refusal                            | No retry/fallback outside authorization; no purchase under another key for the same unanswered request                  |
| Qualification                             | Compare canonical decisions with the same evidence in the existing #89 suite; budget gaps stay UNKNOWN, no weaker proof |
| Mutation                                  | Removing every critical transaction/fence/deadline/quote/counter/dedupe check kills a meaningful regression             |

Existing local runtime tests prove request-local admission,
strict-rate/uncertainty stops, retained drain usage, malformed provider-quote
refusal and immutable same-queue deadline. An active test also proves a new
collector has no durable counter, so those passing tests cannot be mistaken for
restart-safe model USD authorization. Existing ChaosLab tests cover recovery
mechanics; they are not proof of this unimplemented shared admission
transaction.

## Decisions and gates

1. Approve a held durable-authorization/reservation migration design and its
   runtime API, coordinated with Claude's billing/ownership integration.
2. Verify current vendor liability bounds and decide any external account
   controls and uncertain-hold/reconciliation policy needed for an actual-charge
   maximum.
3. Run the exact integrated real DB contract and failure-injection tests in an
   approved isolated test target, including credit re-arm and uncertain holds.
4. Only then reconcile activation with the inert smoke specification and #87's
   existing worker proposal, with separate approval for setup and a live
   mission.

**No live mission is safe to authorize as a guaranteed $0.25 run yet.** No
migration, production access, deployment, infrastructure or paid provider call
was performed in producing this proposal.
