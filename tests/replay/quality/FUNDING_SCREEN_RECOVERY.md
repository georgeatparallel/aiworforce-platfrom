# Interrupted funding-screen recovery: reproduced defect, proposed fix

## Current-code evidence

Investigated against `launch/hardening` at `fec34976`, which integrates all PRs
#68–#73. D3 (#72) adopts pending **discovery** selections. This test instead
interrupts the **Atomus verification inside the funding screen**. It does not
modify or replace those changes and does not depend on unmerged G5 PR #74.

The focused adapter uses existing golden synthetic company rows, a $0.14
provider ceiling and two-admission screen, with the hard hiring clause removed
to keep this investigation about the funding read. It uses the production
engine, enforced specs, readiness policy, `fundingStageVerifier`,
`ledgerBoundCall` and the same findings-only screen callback as run-agent. The
synthetic provider reports a running run before it has rows; that exact fixture
can deliver one decisive funding row when asked with `resumeRunId`.

Observed deterministically:

1. The funding call reaches the provider after a ledger reservation and starts a
   paid operation. `ledgerBoundCall` reports `running`.
2. `fundingStageVerifier` handles completed Atomus answers and deferred calls,
   but does not persist an Atomus running result as a pending verifier run.
3. run-agent's screen callback returns only `.findings`.
4. `applyFundingScreen` sets `funding_screen.screened = true` and exhausts its
   discovery source even though this read did not deliver its answer.
5. The JSON-checkpointed state contains zero pending verifier runs.
6. D2's `priorPurchasesFrom` is supplied the paid run under its original key and
   returns `adopt`. It is available to the resumed screen callback, but the
   completed-screen guard prevents that callback from running.
7. Resume makes zero screen calls and zero Atomus adoptions. Funding stays
   pending despite the fixture's decisive answer being available on adoption.

The delivered-answer control passes and resume does not buy it again. The
interrupted characterization also passes because it asserts the current broken
behavior. The desired recovery test is different:

```sh
RUN_FUNDING_SCREEN_RECOVERY_SPEC=1 deno test --allow-read --allow-env \
  tests/replay/quality/fundingInterruption.test.ts
```

**Expected and observed: exit 1; two controls passed, one specification
failed.** The failed assertion expects funding `pass`; actual funding is
`pending`. This is an offline synthetic reproduction of a current-code defect,
not a new observed production incident or a measurement of its prevalence.

Ordinary runs expose the desired behavior as an explicit `[known-gap]` skipped
test. Once a production fix is approved and implemented, enable that contract
and replace the broken-behavior characterization. Do not disable assertions to
make the recovery test pass.

## Proposed production fix — NOT implemented; approval required

1. Represent a started screen separately from a completed screen. Keep the
   bounded discovery pool closed while its single priced Atomus read is running,
   but do not mark the answer complete or mark funding verification answered for
   those companies.
2. Extend the shared verifier pending-run mechanism to Atomus: persist the run
   and dataset ids, actor, original input and candidate keys, original compiled
   spec/idempotency key, and criterion/window context. Preserve its reservation
   and estimated commitment. Do not manufacture a receipt or release committed
   spend merely because a slice ends.
3. Have the screen callback carry pending state as well as findings. On resume,
   adopt that same run using the original spec and reservation before any fresh
   screening or admission decision. A still-running poll keeps the carrier; only
   a completed answer is normalized and applied to the held pool.
4. Mark the screen completed and finalize its verdicts after the answer is
   processed. Missing rows remain UNKNOWN; incomplete history is not disproof;
   all existing geography, size, funding-kind, stage and hiring rules remain.
5. Keep the existing fence/deadline/cancellation gates and ledger idempotency.
   Coordinate with the already integrated D2/#71 recovery work so a lost
   checkpoint can restore this carrier from durable execution records without
   duplicating verifier recovery or introducing a second purchase.
6. For old checkpoints with `screened: true` but unresolved funding and no
   carrier, consult durable call records only. If the original run/input/spec
   cannot be recovered, surface an explicit unresolved recovery state. Do not
   guess the run, silently rerun a paid query, or grant qualification.

Approve a separate production-fix task before changing any of those modules.
Likely modules are `fundingStageVerifier.ts`, the pending-verifier carrier,
`applyFundingScreen` in `leadCapabilityEngine.ts`, and run-agent's callback.
This PR edits none of them.

## Acceptance tests for the future fix

- Before purchase: a deferred/deadline-stopped screen remains not-started and
  spends nothing; retry uses its one allowed priced read.
- After provider start: full JSON checkpoint restore retains the exact carrier
  and commitment; pending polls do not buy a second run.
- After provider completion: normalize the original answer, update only the
  original candidate pool, clear its carrier and complete the screen once.
- Lost checkpoint: recover via durable execution records under the same key; do
  not bypass the existing generation fence or the separately integrated
  verifier-purchase recovery.
- Failure, missing row and partial history: remain truthful; no invented
  funding, no silent budget refund or weakened hard qualification.
- Receipts and cancellation: preserve settlement/source attribution and report
  unresolved paid work rather than pretending that cancellation means free.

No production code, services, paid APIs, database writes or live missions were
used for this investigation.
