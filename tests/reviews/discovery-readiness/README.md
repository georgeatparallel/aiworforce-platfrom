# Independent Discovery review controls

Reviewed implementation: PR #96 `fa53ebbe139d4a18d3c33e3d23b740f776ec6c2e`.
These tests do not implement Claude's correction or change a limit/catalog.

- `tests/db-contract/independentLeaseWait.contract.test.ts`: original
  independent P1 reproduction, **byte-for-byte unchanged** (SHA256
  `f3adeeb37079058e43ed88e61ed99d56d5f9f3d315d6c687de6efb971b777c45`). Two
  requests use the final Luna/job templates. On `4992878f` plus #93 both fail;
  on `fa53ebbe` both pass with no sends or reservations.
- `ownershipMatrix.ts`: 15 additional native controls, all PASS. Queue/lineage
  expiry separately; valid concurrent admissions and duplicate purchases;
  concurrent expired owners; cancellation during pending admission;
  cancelled/expired missions; ownership/generation updates blocked by shared
  locks, then later requests fenced. Wait detection is scoped to the current
  database, not arbitrary cluster activity. Lock waits have bounded assertions;
  valid requests are included so an always-refuse mutant cannot pass.
- `riskControls.ts`: required-safe P2 assertions, **expected to fail on the
  reviewed implementation**. Both API cache-write detail shapes, unknown
  read-count purchase, populated Brain authorization, and verified discovery
  fallback. Cache-hit and clean-workspace controls pass. No skips, conditionals
  accepting unsafe behavior, or altered financial ceilings.
- `brainBound.ts`: a real planner request with a populated Brain exceeds 30,720
  bytes and is refused by the final request limiter. It does not certify the
  absence-of-Brain prerequisite is automatically enforced.
- `preflight.ts`: the proposed read-only operator guard rejects a Brain and
  hosted-calling cron schedules; an isolated clean workspace passes. The
  contract shim only records cron commands and cannot execute HTTP; its fixture
  invokes the repository's real detach script before the positive control.

The explicit review runners live outside Deno's automatically discovered
`.test.ts` files. They are intentionally run individually; required-safe P2
failures must remain visible and must not be reported as a green safety suite.
The unchanged original P1 file is discoverable by the normal database lane.

## Run offline

Use Deno 2.8.2, a disposable localhost PostgreSQL 17 server and
checksum-verified PostgREST 12.2.3. The database runner creates/drops one random
database and refuses remote URLs; only localhost receives test network
permission. Vendor responses and prices are fake. No hosted URL or vendor
credentials are needed.

```sh
export PG_ADMIN_URL='postgres://postgres@127.0.0.1:55490/postgres'
export POSTGREST_BIN='/path/to/postgrest'
tests/db-contract/run.sh --cached-only tests/db-contract/independentLeaseWait.contract.test.ts
tests/db-contract/run.sh --cached-only tests/reviews/discovery-readiness/ownershipMatrix.ts
tests/db-contract/run.sh --cached-only tests/reviews/discovery-readiness/riskControls.ts # EXPECT RED until P2s are fixed
tests/db-contract/run.sh --cached-only tests/reviews/discovery-readiness/preflight.ts
deno test --node-modules-dir=none --cached-only --allow-read --allow-env tests/reviews/discovery-readiness/brainBound.ts
```

Run database invocations sequentially on a disposable cluster: each creates a
temporary authenticator password, and some older contract lock probes inspect
cluster-wide activity. The proof is bounded concurrency inside each test, not
competing test runners. A missing dependency, failed schema bootstrap or zero
selected cases is NOT a pass.

The exact baseline SHA must remain available when testing a future head. Retest
both the untouched original and the added matrix, and record the exact
implementation SHA. See `docs/launch/reviews/discovery-test-readiness.md` for
findings and the operator checklist.
