# PR #94 independent review and offline mission proof

**Verdict: NO-GO for isolated-test preparation. The live $0.25 mission remains
BLOCKED.**

Implementation: `b557ff6e1d025afca9f9b59ab00d31245664c0b0`. Proposed
mission/catalog: PR #93 `0fb6312c1b78bf0282401140e62e903b31567930`. Base:
`launch/hardening` at `c98ea69026a0f30b8f463f48000a4fa7e0e1ddaa`. Reviewed
2026-10-16. Both PR heads were rechecked before publication.

## P1 integration blocker: execution planning exceeds the approved input bound

The exact proposed mission is:

> Find 1 US B2B software company with a current declared 11–50 employee band and
> an open Account Executive posting dated within 30 days.

The production compiler succeeds with a **26,245-byte** Luna request. The real
worker then enters `handleRunAgent` and constructs a **53,922-byte** execution
planner request. The approved template allows **32,768 bytes**. The real gate
refuses `request_limits: request_too_large` before admission or vendor dispatch.
The handler persists a failed task and returns HTTP 500 with
`ExecutionPlanBlockedError`; the dashboard-facing candidate query returns no
rows.

This is a successful safety refusal and a failed mission. It is not caused by a
bad model response: the fake transport receives only compilation. The rejected
planner request never consumes its scripted answer. No actor purchase, research
or qualification occurs. It cannot finish under the exact current configuration.

**Smallest required correction without increasing limits:** reduce the complete
planner request by at least **21,154 bytes**, preserving its validation and the
32,768-byte/4,000-output-token template. Filter irrelevant actor/catalog context
and compact shared instructions as needed; compact JSON alone is not a
demonstrated fix. The actual planner request contains 23,917 bytes of system
instructions and 24,886 bytes of user content, plus schema/JSON overhead. Rerun
this proof after the change, then extend it through research and qualification.
No downstream completion or four-attempt sufficiency is claimed yet. Do not
raise any cap.

Sources: `supabase/functions/_shared/gptExecutionPlanner.ts` constructs the
production request; `supabase/functions/_shared/smokeAdmission.ts:210` enforces
the template; PR #93's readiness document specifies B=32,768/O=4,000/11,400 µ$.

## Exact-SHA safety results

| Check                                                  | Result                                 |
| ------------------------------------------------------ | -------------------------------------- |
| SAF-001: uncertain Apify hold after admission outage   | PASS                                   |
| SAF-002: uncertain Apify hold after authorization stop | PASS                                   |
| SAF-003: uncertain Firecrawl hold                      | PASS                                   |
| SAF-004: model input/media/output bounds               | PASS                                   |
| SAF-005: redirect gating                               | PASS                                   |
| SAF-006: malformed admission refuses dispatch          | PASS                                   |
| SAF-007: closure while admission is in flight          | PASS                                   |
| SAF-008: null/empty mandatory provider bodies          | PASS; both originals plus two controls |
| Status/receipt/dataset lifecycle and read-plan replay  | PASS in targeted native contracts      |
| Vendor charge cap and billed-entry bounds              | PASS in targeted native contracts      |
| Cancellation, generation, ownership and queue leases   | PASS in targeted native contracts      |
| Fixed deadline, skew, restarts and customer path       | PASS in focused unit/native checks     |
| Exact proposed mission completion                      | BLOCKED at execution planning          |

**No confirmed new P0/P1 safety regression in PR #94's production changes.** The
P1 above is an integration/readiness defect in the proposed configuration, not a
failure to enforce the bound. All changed production files were reviewed. The
SQL admission authority is unchanged. New actor shaping and read planning are
conditional on the installed smoke gate; existing non-smoke behavior remains
covered. Uncertain replay refusals retain their credit and purchase capacity.

Executed: 11 original SAF checks, 64 targeted native admission/runtime/billing/
recovery checks, 17 additional native queue/fenced-write checks, 37 focused
read-plan/admission/runner checks, and 16 clock/non-smoke actor-handling checks:
**145 existing checks pass**. The new deterministic blocker/control test also
passes by asserting the stated refusal, not successful mission completion.

Original SAF-001–007 logic and helpers passed the six-module immutable assertion
preservation check. SAF-008's reproduction is byte-identical to the original;
only disposable source fingerprints changed. Its initial attempt used an old
fingerprint file and failed setup; the corrected disposable copy passes 4/4.
Historical unsafe characterization expectations and obsolete polling-cadence
expectations were not used as safety acceptance tests or counted as product
defects.

Native environment: PostgreSQL 17.11, checksum-verified PostgREST 12.2.3, Deno
2.8.2; real local migrations, RLS-bypassing service role and SQL locks. The
established contract harness supplies its documented Supabase platform shims.
Only localhost has test network permission; vendor fetches are in-process fakes.
The final new handler rehearsal passes with typechecking enabled, and its
format/lint checks pass. Initial fixture type annotations were corrected before
the final typed run; no implementation type error was found.

## Mutation tooling finding and proofs

At the tested SHA, `tests/db-contract/mutation.sh`'s **settled receipt not
labelled** mutation searches for `apifyRunSettled(..., now())`, but production
now uses `sentAt`. That mutation cannot apply and the full script stops at its
setup check. It is a P2 tooling defect; the claim that the current full script
proves all 43 mutants needs correction.

Ten other selected lifecycle/entry-bound/send-time mutations were killed on
their named behavioral assertions. Updating only the stale selector to `sentAt`
in a disposable copy also kills that guard on the same named assertion: **11/11
selected behavioral proofs after selector correction**. A source mismatch is not
a kill. This branch includes that one-line test-tool correction; it changes no
assertion. The full 43-mutation suite was not repeated.

## Measured trace and reconciliation

| Measurement                                     | Observed                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Physical model sends / durable model admissions | 1 / 1                                                                   |
| Execution-plan admission / vendor send          | 0 / 0; rejected before both                                             |
| Paid provider purchases                         | 0                                                                       |
| Apify status / dataset / receipt reads          | 0 / 0 / 0; actor stage never reached                                    |
| Total / provider / model authorization          | $0.25 / $0.20 / $0.05                                                   |
| Committed provider / model / combined USD       | $0 / $0.0114 / $0.0114                                                  |
| Synthetic usage-priced model estimate           | $0.000680                                                               |
| Actual settled model USD                        | unknown/null; no real invoice or vendor receipt                         |
| Provider customer-credit reservations/charges   | 0 / 0                                                                   |
| Dashboard candidate rows / qualified leads      | 0 / 0                                                                   |
| Local measured duration                         | 333 ms to run the blocker and controls; not vendor latency              |
| Resume                                          | HTTP 409 `continuation_refused: no_checkpoint`; no additional paid send |
| Restart with original creation older than 300 s | refused before handler; deadline not renewed                            |
| Operator stop                                   | subsequent bounded request refused 409 `stopped`; no new operation/send |

The model telemetry view has two rows: compilation priced from synthetic usage,
and an unknown-cost failed planner entry. Two telemetry rows do not mean two
physical model attempts. The full observed transport trace also includes a
third, small post-stop refusal probe; that probe is not mission planning work.

The compiler's mission provenance is retained from the real production compiler.
There is no purchased source evidence, research result or qualification
provenance: those stages are unreached. The real PostgREST candidate query
proves no result was persisted; it does not prove authenticated UI/RLS behavior.

Machine-readable measurement:
`tests/fixtures/lead-v2/pr94-offline-smoke-measurement.json`. Full local logs
and raw attempted/physical request bodies:
`/workspace/pr94-evidence/mission-typed-trace.json`, plus JUnit/native/mutation
logs.

## Reproduction and limits of the harness

```sh
PG_ADMIN_URL=postgres://postgres@127.0.0.1:55490/postgres \
POSTGREST_BIN=/tmp/postgrest \
tests/db-contract/run.sh --cached-only \
  tests/db-contract/offlineSmokeMission.contract.test.ts
```

Optionally set `OFFLINE_SMOKE_TRACE_PATH=/tmp/trace.json` and add
`--allow-write=/tmp/trace.json`. The existing contract runner creates and drops
a disposable database and starts/stops its own PostgREST. It refuses hosted
URLs.

The test uses the production compiler binding, actual runner and
`handleRunAgent`, production bind RPC, real admission SQL, ledger writer and
result reads. There is no substitute mission engine. The existing fixture starts
bound so compilation can share the same admission budget; before the worker
starts, fixture preparation restores a fresh kickoff task binding while
retaining every commitment and the original queue creation/deadline. Actual
worker binding then uses its real RPC. This does not exercise pilot-chat's
UI/HTTP intake, or the worker claim/heartbeat/ release loop; native contracts
cover claims/ownership separately. It stops at the first demonstrated blocker
and explicitly does not certify full end-to-end success.

This harness is a blocker characterization. Fixing the body size should make its
blocker assertion fail; then extend the same real execution path to assert
actual qualification and persistence. Do not preserve an obsolete failure
expectation as a safety acceptance test.

## Next step

Keep isolated-test preparation and the live mission blocked. Correct the prompt
size and mutation selector, rerun the exact mission without raising limits, and
prove the remaining stages fit. Operator/reconciler assignment, fresh account
pricing/vendor controls, isolated-environment approval and separate execution
authorization still remain. No implementation branch, hosted schema, production
data, deployment or live mission was changed by this review.
