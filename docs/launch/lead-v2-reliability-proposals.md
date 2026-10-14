# Lead V2 reliability: what still needs a migration or a decision

These are the risks left after D1–D4, the funding-screen recovery and the
narrow fixes in this sprint. Each needs a database migration, new
infrastructure or a budget/billing decision, so **none is applied or wired**.
Each section gives the failure, the proposal, and what proves it.

| # | Risk | Severity | Needs | State |
|---|---|---|---|---|
| 1 | Two live holders buy the same provider call | Duplicate purchase | Migration + wiring | Migration **held** with tests; wiring not done |
| 2 | Firecrawl `/map` results lost with the checkpoint | Re-purchase (small) | Migration | Proposal |
| 3 | Mission ceilings undercount after a lost write when no operator cap is set | Overspend past a ceiling | Budget-enforcement decision | Proposal |
| 4 | An Apify run started but its id was never recorded | Billing loss, held unresolved | Provider-side reconciliation | Proposal |
| 5 | Credits refunded for a start that may have created a run | Billing loss | Billing-policy decision | Proposal |

## 1. One buyer per idempotency key (`provider_purchase_claims`)

**The failure.**
1. Worker A reserves key K, then its event loop stalls past its claim (more than 300 s).
2. Worker B reclaims the mission. Its slice reads A's ledger row as `started` with no run id.
3. B's credit reservation *replays*: `credits_reserve` protects credits, not provider dollars. So B POSTs.
4. A resumes and POSTs too.

Two Apify runs, one credit. Nothing else stops this:
- the `lead_execution_calls` key index is deliberately not unique;
- the lineage lease's holder is the task id, which both generations share.

**The migration.** `supabase/migrations-held/20261015120000_provider_purchase_claims.sql`, held:
- a `(workspace_id, idempotency_key)` table, service-role only;
- `claim_provider_purchase(ws, key, task, generation)` takes the claim **under D1's generation token**, so a stalled worker is refused `stale_generation` before it can buy;
- `attach_purchase_run` records the run id when the start POST returns;
- `settle_provider_purchase` frees the key only when no run can exist (`failed_before_start`).

Decisions: `buy`, `adopt` (re-read the run id), `uncertain` (never buy; the D2 rule), `settled`, `held_by_self`.

**Proof.** `tests/infra/providerPurchaseClaims.test.ts` runs it verbatim on real Postgres (PGlite), 7 tests:
- stale-generation refusal;
- the reclaimer never buys A's key (`uncertain`, then `adopt` once A's run id lands);
- takeover only after `failed_before_start`;
- a run id is never discarded;
- validation and service-role-only grants;
- a clean rollback.

It also applies and rolls back on the full Postgres 17 schema in the database-contract lane.

**Wiring (a separate, approved change).**
1. In `ledgerBoundCall` (`claimVerifier.ts`) and the engine's `callProvider`, call `claim_provider_purchase` after the spend-ledger reservation and before the guarded invoker:
   - `buy` → proceed;
   - `adopt` → resume by the returned run id, with no reservation (as D2 does);
   - `uncertain` → deferred, then held unresolved (as D2 does);
   - `stale_generation` → stop the slice (it is superseded);
   - PGRST202 / 42883 → today's behaviour.
2. In `onRunStarted` / `onProviderRun`, call `attach_purchase_run`.
3. In the ledger finalizer, call `settle_provider_purchase`.
4. Tests: a chaos-lab variant of *a stale worker wakes while the new generation holds the lineage*, with both workers reaching the same purchase, should record one purchase.

**Rollout.**
1. Apply to a branch database.
2. Wire it behind an env flag, observing only (log the decision, never block).
3. Compare against `lead_execution_calls` for a week.
4. Then enforce.

## 2. Firecrawl `/map` results are not durable

`webEvidenceRunner` stores every fetched page in `company_web_evidence`, which a later slice reads back. The `/map` URL selections live only in the checkpoint (`web_evidence_map_selections`), so a lost write buys the map again.

The provider call is idempotency-keyed for **credits** only (`credits_reserve` replays), so the provider charge repeats. It is small (one map per company) but real.

**Proposal:**
- add a `company_web_evidence_maps` table, keyed by workspace, normalized domain and selection version, holding the selected URL list and the map's `logical_call_key`;
- write it right after the map returns;
- read it before mapping.

Additive, service-role only, the same shape as `company_web_evidence`. Tests: a lost-checkpoint chaos case asserting one map purchase.

## 3. The durable spend floor applies only under an operator cap

`readLineageSpendFloor` is read, and `applySpendFloor` applied, only when `LEAD_V2_MISSION_*_CAP` is set. Otherwise the engine clears any floor (`leadCapabilityEngine.ts`: "a floor carried in from a capped slice means nothing without the cap").

Without a cap, a lost checkpoint write rolls the in-state spend ledger back, so the run budget's ceilings (`run_budget`, `mission_credits`) **undercount by the lost spend** and the mission can spend past them.

**Proposal.** Read the floor whenever P2 specs are on, and apply it whether or not a cap is set:
- without a cap, an **unreadable** floor is ignored, failing open as today;
- under a cap it keeps refusing, as now.

**Why it is not done here.** It changes when *normal* missions are refused. The floor counts each paid call at its settled cost, then its actual cost, then its estimate, while the in-state ledger holds provisional estimates. A mission whose receipts settle above estimate would reach its ceiling earlier than today, even with no lost write.

That is a budget-enforcement decision: measure the settled-vs-estimate gap on recent lineages first.

Tests to add with it:
- a `budgetPolicy` unit test: an empty ledger plus a floor is refused at the ceiling;
- a chaos run with every write lost and a ceiling just above slice 1's spend: slice 3 refuses.

## 4. Reconciling an Apify run whose id was never recorded

If the start POST is cut off (our 20 s abort, or a 5xx after Apify created the run), the run may exist with no id on our side:
- D2 holds such a call **unresolved** and never buys it again;
- PR #81 (`claude/lead-v2-ledger-recovery-gaps`) makes those failures classify as uncertain.

The paid run is still never read.

**Proposal.** A reconciler that lists the actor's runs around the ledger row's `started_at` (free `GET /acts/{actor}/runs`) and matches each run's `INPUT` record against the row's recomputed input fingerprint. On a unique match:
- `attach_purchase_run` (§1);
- the ledger row gains the run id;
- D2 then adopts it.

It needs provider read access in a scheduled job, which is new infrastructure, and a decision on what an ambiguous match does (it must stay unresolved). Putting a marker into the actor input is **not** safe: it changes the input fingerprint and can fail the actor's input schema.

## 5. Credits for an uncertain start

`settleProviderCall` charges credits only when `started` is true. A start whose outcome is unknown is settled as not started, so the reservation is **refunded**, even though a run may exist and Apify may bill it.

Charging it instead (or holding the reservation until reconciliation, §4) is a **billing-policy** decision. Today the user is never charged for something that may not have run; the cost is ours.

**Recommendation.** Hold the reservation as `reserved` (neither charged nor refunded) until reconciliation decides it, with a time limit after which it is refunded.
