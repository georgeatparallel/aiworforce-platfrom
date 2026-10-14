# Lead V2 Replay Lab

A production bug should only need to happen once. After that, its execution
state is a deterministic fixture replayed offline — zero provider calls, zero
credits, zero production writes — through the **same production functions**
Lead V2 runs.

```bash
npm run test:lead-v2-readiness     # the Replay Lab, by category
npm run test:lead-v2-regression    # the Lab + the targeted Lead V2 edge/UI tests (~10s, zero spend)
```

`matrix/` is the query regression matrix (20 request categories and wording
variants, hand-written expectations); `invariants/leadV2Invariants.test.ts`
asserts the twenty-eight properties every mission must keep (19–25: termination, progress, leases, deadlines, cancellation, qualified-company counts; 26–28: checkpoint slimming), and
`invariants/verificationStop.test.ts` adds 29–32: the verification phase stops with its slice (deadline,
cancellation, lost lease), buys nothing after the stop, carries what is in flight by run id, and is
not counted barren for it.

```
Golden missions:                 PASS  (6/6)
Historical regression replays:   PASS  (20/20)
Claim/evidence invariants:       PASS  (6/6)
Provider-spec invariants:        PASS  (5/5)
Budget invariants:               PASS  (2/2)
Continuation invariants:         PASS  (2/2)
Fixtures sanitized:              PASS  (6 fixtures)

SAFE FOR PRODUCTION SMOKE: YES
```

The tests run with `--allow-read --allow-env` only: a network call is a
permission error, not a silent purchase. CI runs the same command
(`.github/workflows/ci.yml`, "Lead V2 readiness").

## Architecture

| Layer | Production | Replay |
|---|---|---|
| Spec compile | `compileProviderCallSpec` / `verifierSpecCompiler` | same |
| Readiness, guard | `routeReadiness`, `guardedInvoker` | same |
| Budget | `reserve` / `candidateCeilingRefusal`, `missionSpendCap` | same |
| **Network** | `capabilityInvoke` → Apify / Firecrawl | **`FixtureProvider.invoke`** (strict) |
| Normalizers → observations → claims → eligibility | engine + `candidateEligibility` | same |
| Verifiers | `runClaimVerificationPhase` + `ledgerBoundCall` + `ledgerAffordability` (one `verifierSpecFor` compiler) | same |
| Model calls | planner, selector, evaluator, triage, reasoner | recorded outputs (`model_responses`) |
| Canonical view | `buildWorkbenchMissionView` | same |
| Continuation | `foldSlice`, `decideAutoContinuation`, `settleV2Outcome` | same |
| Queue | Postgres functions + worker core + `releaseQueuedMission` | same SQL in PGlite + same worker core |
| Checkpoint | `toResumeRecord` / `restoreWorkingSet` | same |

`lib/`
- `fixture.ts` — schema, loader, sanitization guard (credential/email shapes refuse to load)
- `provider.ts` — `FixtureProvider` (match by candidate keys, input fields or input hash; per-company row selection; `pending_once` runs adopted later) and `noNetwork()`
- `state.ts` — the ledger **as of an instant** (reservations timed by their `lead_execution_calls` rows; a reservation settled after the instant counts at its provisional figure, from its first `call_settled` event — `settled_at`) and companies via `restoreWorkingSet`
- `prod.ts` — **the binding**: the canonical production implementation (PR #24, `bbbaf3ff`) behind the lab's names, plus verbatim copies of the two builders run-agent keeps inline (verifier candidates, the open-role verifier) and its frontier count, each pinned to run-agent's source so a drifted copy fails
- `verification.ts` — checkpoint replay of the verification phase wired exactly as run-agent's `verifierDepsFor`; `canonicalView`
- `engine.ts` — one `runCapabilityPlan` slice with recorded model outputs
- `mission.ts` — whole golden missions: engine → verifiers → checkpoint → view → continuation → real queue SQL
- `continuation.ts` — a canary's logged slice counters through `foldSlice` + `decideAutoContinuation`
- `queue.ts` — PGlite running the production queue migrations, the production worker core and release
- `lineage.ts` — a whole lineage slice by slice (`replayLineage`); its fold/decide/replenishment steps are exported for `chaos.ts`
- `chaos.ts` — `ChaosLab`: a lineage through the production queue, worker runner, continuation claim, lineage lease, checkpoint writes and execution ledger, with faults injected (see **Failure injection**)

## Checkpoint replay

`replayVerificationAt(fixture, "before_hiring_verification:slice1")` rebuilds the
state at that instant — the ledger from reservations written before it, the
companies from the checkpoint records trimmed to it — and runs only the
downstream phase. Each fixture's **anchors** (figures production logged at that
instant, e.g. LlamaIndex's $0.0098 evidence spend) are asserted first, so a
reconstruction that drifted from production fails before any expectation is read.

## Historical fixtures

| | Canary | Bug | Data |
|---|---|---|---|
| A | 98ce374b | pool counted "enough"; page 2 never bought | stored mission + logged shape (task row gone) |
| B | 9230df70 | verifier-only slices counted barren | logged counters (task row gone) |
| C | 53784493 | clean continuations spent retries; slice 6 never claimed | logged counters, real queue SQL |
| D | 3f945ff4 (Canary 6) | budget hard stop | production ledger, refusals to the cent |
| E | 154541e8 / c01d28d8 | NON_EQUITY_ASSISTANCE counted as funding | LlamaIndex's production Atomus record |
| F | c01d28d8 (Canary 8) | affordability priced raw ($0.121) vs reserved ($0.049) | production checkpoints (LlamaIndex, Solana Labs, Delta Lake, Actioneer), ledger with settlement instants, mission |
| G | a9a6791a (Query B) | stale schema_failure across slices; 4 titles to a 3-title actor; "account manager" in a sales search; page 3 replayed page 2 | 21 employers + declared bands, 21 retained postings, recorded route-control and selector outputs (`queryBa9a6791a.job-first`, synthetic rows listed) |
| H | a9a6791a | a recruiter's "on behalf of a partner" postings proved its own hiring | same fixture |
| I | a9a6791a | four companies "still being checked" after the lineage ended | same fixture, canonical view |
| J | f6133796 (Citian) | a stale Stage-2 restore replaced website proof | `lib/citian.ts` (production shapes) |
| K | a9a6791a | role precision and size filtering on every production title / band | same fixture |
| L | d22d9ee6 (Query B) | a lineage that could not stop: re-plan after the last page every slice, barren never counted, 29 min until cancelled | `queryBd22d9ee6.loop` (production's four in-band companies and per-call employer growth; out-of-band synthetic), driven by `lib/lineage.ts` |
| M | d22d9ee6 / eb0d520f (Query B) | a 2 MB task result: closed companies carried whole in every checkpoint, writes past the statement timeout | both Query B fixtures, resumed through the persisted checkpoint (`lib/slim.ts`), full vs slim, every slice |

Each fixture lists its sources and sanitization in `provenance`; extraction
queries live in `fixtures/queries/` (read-only).

## Payload size

`deno run -A tests/replay/bench/payloadBench.ts [fixture] [--breakdown]` replays a
lineage twice — storing what the previous checkpoint writer stored, and what the
current one stores — and prints, per slice, the checkpoint, engine state,
research fabric, Workbench view, task result and lineage state in bytes, with
the number of whole-result rewrites. Byte counts only: database latency is not
measurable offline.

## Failure injection

`failure/` (`[failure]`, counted by readiness as *Failure-injection lineages*)
replays Query B d22d9ee6 and a9a6791a through `ChaosLab` — PGlite running the
production queue, continuation-claim and lineage-lease SQL; the production
worker runner, tick and release; checkpoint writes through the production
progress guard; and a durable `lead_execution_calls` ledger that the
production resume recovery (`recoverCompletedRuns`, `recoverPendingRuns`,
`mergePendingRuns`) reads. `ChaosLab.handle` is the one written-out mirror of
run-agent's slice sequence; `failure/sourceOrder.test.ts` pins its order and
guards to run-agent's and the worker's source.

Faults, each keyed by slice attempt: `stage_writes_lost`, `end_write_lost`,
`worker_dies_after_engine`, `claim_release_fails` (57014 on every retry),
`lineage_release_fails`; plus a stalled worker (`stalledWorker()`, lease lost
mid-slice), a provider run still running at slice end (`pending_once`), and
seeded fault schedules. Every scenario asserts: nothing bought twice; the queue
settles; no claim or lease left held; task and lineage agree with the queue;
attempts within `V2_MAX_ATTEMPTS`; the durable spend floor equals what was bought.

Defects found here are pinned twice — a `[failure] … DEFECT REPRODUCED` test
for today's behaviour and an ignored `[known-gap]` test for the fix:

| | Defect | Where |
|---|---|---|
| D1 (fixed) | A worker that stalls past its lease woke after another worker finished the mission (or wrote a newer checkpoint); its end-of-slice write landed over the newer result. Every slice result write is now one conditional UPDATE fenced on the generation its claim set (`tasks.checkpoint_version`) and, before the slice's verdict, on an open row (`fencedTaskUpdate`) | `lineageFailureInjection` §3 |
| D2 | A verifier purchase is deduped only by the checkpointed `spend_ledger`; a lost end-of-slice write (or a worker dying after verification) makes the next slice buy the same verification again, same idempotency key | `verificationLostWrite` |
| D3 (fixed) | A replenishment page or re-planned query still running at slice end was never adopted: discovery re-asks only its own strategy, and once the replenishment slice ended it was marked done, so the lineage waited to the continuation ceiling. The engine now records the selection that started a pending discovery run and reopens discovery DRAIN-ONLY to ask it again, adoption-only; `pendingFor` reads runs pending now, not the attempt history; and `awaitedPendingRuns` bounds the wait (`PENDING_RUN_MAX_POLLS`, `PENDING_RUN_MAX_WAIT_MS`) | `lineageFailureInjection` §6 |
| D4 (fixed) | The LAST slice's result write is lost: the lineage is released `terminal` from memory, the worker read the stale row (`continuation_required`) and released the queue `resumable`, and `claim_next_lead_mission` never claims a row whose lineage is terminal — the queue row was stranded. The worker now asks the lineage row when the task row says the run did not end (`mapTaskOutcome(row, lineage)`); the terminal release reconciles task and plan to the lineage's verdict | `lineageFailureInjection` §1, seeded schedules |

Lab fidelity notes: `replayEngineSlice` passes the production `readPendingRun`
(run-agent always does), so a pending provider run is adopted by run id; the
recorded re-planner answers a re-run slice with the NEXT recorded query, as a
live model would answer again, so faulted runs compare re-planned questions by
count (`questionsOf`).

## Adding a fixture after a production bug

1. Extract read-only (see `fixtures/queries/canary8.sql`): mission, ledger
   reservations + their call timestamps, the checkpoint records, the events.
2. Trim records to the decision instant; restore in-flight runs as `verifier_pending_runs`.
3. Record the logged figures as `anchors` and assert them first.
4. Write the expectation against the corrected behaviour; mutation-check it
   against the bug (the test must fail with the bug reintroduced).
5. Tag tests `[historical]` (or `[claims]`, `[budget]`, …) so the readiness report counts them.

## Gaps

- **run-agent's end-of-slice orchestration is inline.** The lab mirrors its
  continuation-input assembly with the same production building blocks and a
  source-pin test (`invariants/providerSpec.test.ts`) fails if run-agent's
  wiring changes; extracting it into a shared function would remove the mirror.
- **Not replayed:** run-agent's funding pool screen, model triage and reasoner
  (their outputs are recorded, not re-derived), Apify receipt settlement (spend
  is held at the provisional/estimate), and every Supabase write.
- **Model outputs are recorded, not regenerated** — a prompt change is not
  exercised by replay.
- **Inline builders copied, not shared.** run-agent builds the verifier
  candidates, the open-role verifier and the frontier count inline; the lab
  carries verbatim copies (`lib/prod.ts`) pinned to run-agent's source. Moving
  them into shared functions would remove the copies — a production refactor,
  deliberately left out of this test-only PR.
- **Fixtures A and B** use the logged counters/shape: their task rows are no
  longer in production.
- Known gap test: the funding evidence headline names the NEA event (display only).
- **Failure injection:** the first slice losing EVERY write cannot resume
  (409 `no_checkpoint`; the mission fails honestly with its paid calls
  stranded); lost end-of-slice writes make the queue count real slices as
  retries; a lost slice's model re-plan is asked again. a9a6791a is covered for
  invariance only (its fixture has no grounding or verification answers), and
  the funding screen is not replayed.
