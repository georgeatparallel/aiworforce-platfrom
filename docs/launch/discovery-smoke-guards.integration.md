# Smoke guards after the Tier 0/1 integration

Validated base: **9453b7c5**, all 15 Tier 0/1 PRs merged. This feature branch
retains original runtime commit **9cdb1372** and merges the base without
rewriting its history. No Claude or previous Codex PR branch is modified.

The merge is clean. Shared-file changes in `executionLedger.ts`, `run-agent` and
Replay source-order assertions preserve both the new guards and the merged
ledger retries, durable-spend recovery and funding-run adoption. No additional
production-code compatibility fix was needed. The feature diff remains the
focused local model admission, provider quote validation and queue-deadline
work; no qualification, evidence, billing-policy or discovery-routing change.

Implemented protections:

- Optional prospective request-local admission for priced/unpriced model
  attempts, retries and fallback; failed/in-flight attempts retain slots.
- Strict unknown-price refusal and uncertainty/missing-usage holds; telemetry
  drain cannot renew existing allowance.
- Budget, cancellation and deadline refusal before model transport; budget
  refusal is nonretryable and cannot trigger paid repair.
- Invalid new/restored provider quotes cannot authorize a fresh purchase; valid
  existing reservations remain adopted without rebuying.
- Optional five-minute fixed deadline from the server-persisted queue timestamp;
  same-row restart/continuation/checkpoint loss cannot renew it. Finalization
  can finish without authorizing new paid work.

Validation on the merged tree plus this feature:

| Check                                                                 | Result                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Complete edge suite                                                   | 8,653 passed, zero failed                                       |
| Complete Replay suite                                                 | 270 passed, zero failed, one existing ignored display-only case |
| Focused guard/recovery/funding/credit/evidence-reuse/superseded suite | 122 passed                                                      |
| New local guard regressions                                           | 29 passed, included in edge suite                               |
| Runtime mutations                                                     | All seven safeguard removals fail their regression tests        |
| Relevant runtime and new test module type checks                      | Passed                                                          |

The Replay suite includes the merged interrupted funding-screen recovery, lost
checkpoint/worker/claim cases, canonical qualification decisions and synthetic
accuracy/efficiency evaluations. No actual provider/model transport or network
permission is used. Tests do not assert production-wide discovery accuracy.

The bounds above are request-local and queue-row-local. Shared prospective USD,
mission purchase/actor/page/poll counters, immutable logical-mission deadlines
across re-enqueue, physical request liability bounds and guaranteed remote
cancellation remain outside this implementation. See the independent
`codex/smoke-durable-admission-proposal` and `codex/smoke-budget-spec` branches.
Proposed SQL there is unapplied and unwired, so passing its tests cannot make
this runtime enforce a durable $0.25 authorization. The first live smoke remains
**BLOCKED** pending approved durable admission, real multi-session/transport
failure tests, verified prices and exact nonproduction schema/billing
validation.
