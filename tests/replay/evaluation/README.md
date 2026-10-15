# Offline Discovery mission evaluation

This test-only adapter reuses Replay Lab's `runGoldenMission` and `ChaosLab`; it
adds no alternative qualification, spend, recovery or routing implementation. It
does not run a hosted mission. All transport is scripted, `fetch` is disabled,
and Deno receives no network permission. PGlite executes existing SQL in memory;
no database service is contacted and no migration is applied to a database.

## Run and reproduce

From the repository root, using the existing Node/Deno installation:

```sh
deno check tests/replay/evaluation/*.ts
deno test --cached-only --allow-read --allow-env tests/replay/evaluation/evaluation.test.ts
deno run --cached-only --allow-read --allow-env tests/replay/evaluation/evaluate.ts > /tmp/discovery-evaluation.json
deno run --cached-only --allow-read --allow-env tests/replay/evaluation/evaluate.ts --example
npm run test:lead-v2-regression
```

`--node-modules-dir=manual` is useful when invoking an entrypoint outside the
checkout with this checkout's installed npm dependencies. No permission to
write, run subprocesses or contact providers is needed by the evaluator. The
existing readiness script discovers these tagged tests automatically; there are
no CI/workflow changes. The CLI exits nonzero for failed acceptance or an
execution exception. An exception emits a machine-readable failed-batch record,
not a successful partial report.

The replay clock is frozen at **2026-10-14T12:00:00Z**, including zero-argument
`new Date()` and `Date.now()`. Timer behavior is unchanged, PGlite's lease clock
is advanced by its existing driver, and Date is restored in `finally`. Run
scenarios sequentially. A test runs the entire batch twice and compares the
complete reports, then compares the selected example with `example-report.json`.
Record the actual Git commit alongside an exported report: estimates are tied to
that revision's provider price cards and canonical policy.

## Dataset separation and method

| Group                          |                  Scenarios | Labels                                                                          | What it establishes                                              |
| ------------------------------ | -------------------------: | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Synthetic controls             |                         15 | 4 MATCH, 3 NON_MATCH, 7 UNKNOWN, 1 zero-result scenario without a company label | Designed mission outcomes and safeguards                         |
| Existing Query B fixture       | 2 runs of the same fixture | No independently assigned truth labels                                          | Uninterrupted versus injected worker-death recovery              |
| Matched recorded routing pairs |                          0 | None                                                                            | Valid job-first/company-first performance comparison unavailable |

`scenarios.ts` holds synthetic provider rows and scenario transformations;
`labels.synthetic.json` separately holds the test author's assigned labels,
reasons, expected counts/checks/termination and call ceilings. These synthetic
labels are authored expectations, not independent real-company ground truth.
UNKNOWN is explicit and remains separate from MATCH/NON_MATCH. The zero-result
case has no company to label; its label is `null`, not an invented UNKNOWN.
Repeated Acme controls are separate company evaluations, not new unique real
companies. Label counts are scenario counts, not production sampling counts.

Industry controls retain a broad Software Development category but vary the
actual product, customer and activity statement: subscription software sold to
sales teams; staffing/recruiting services sold to businesses; or a vague
description. Existing `recordedGrounder` supplies synthetic recorded model
outputs. The actual registry, grounded evidence conversion, evidence graph and
canonical eligibility still decide the result. This tests **consumption of
grounded model outputs**, not accuracy of a live model or prompt. The historical
driver likewise consumes recorded model and website reread findings.

The unmodified recorded fixture is
[`queryBd22d9ee6.loop.json`](../fixtures/queryBd22d9ee6.loop.json). Its
provenance explicitly declares synthetic out-of-band employers/postings,
staffing rows and re-plan wording. Its in-band company descriptions/postings and
mission were retained from sanitized historical observations. The baseline and
interrupted runs stay in `recorded_replays`, carrying that provenance and no
independent label. Injecting a worker death is a synthetic fault, not a claim
that this exact historical mission died at that point.

## Coverage and expected outcomes

The 15 synthetic controls cover all requested families:

- Multi-constraint US + 11–50 band + dated equity funding + open sales role: 1
  discovered, 1 qualified, 0 rejected, 0 unresolved; all 4 hard checks proven.
- Disjoint company size or geography: 1 rejected; no funding/hiring verifier
  purchase follows the decisive record.
- Partial band overlap (51–200 against 11–100), missing band with 30 associated
  members, undated funding, stale posting, empty hiring search or vague
  industry: unresolved, never qualified or rejected just for missing evidence.
- Industry negative: explicit business recruiting services fail software; broad
  category cannot override the grounded activity statement.
- Exact 30-employee requirement: the **existing feasibility preflight** refuses
  `size_range_unprovable`, with 0 purchases. The golden driver normally begins
  after preflight; skipping that boundary would give a misleading evaluation. A
  company record's member count is never treated as an exact headcount.
- Zero results: 0 discovered/qualified/rejected/unresolved and honest search
  exhaustion; yield and evidence coverage have denominator 0 and percent `null`.
- Funding fallback pending across a slice: one start and one adoption of the
  same purchase, then qualification. This exercises the claim verifier's
  pending-run adoption, **not run-agent's funding-pool screen**.
- $0.05 provider cap: hiring remains UNKNOWN, purchase is refused before
  transport, and termination is `budget_exhausted`.

The two Query B runs each produce 68 discovered, 1 qualified, 64 screened out
and 3 unresolved, with the same 7 purchased questions. The interrupted run
records one injected worker death in attempt 2 and recovery. Qualification,
every reported company/check and purchased question must equal the baseline.
Claims/leases must clear, rows must agree, the queue must settle, and the
durable spend floor must count each purchase once. This is replay behavior, not
a claim of 1/68 production discovery quality or savings from this sprint.

## Report contract and acceptance

`evaluate.ts` emits `discovery-mission-evaluation-v1`. Each mission includes:

- Discovered, qualified, rejected and unresolved canonical counts, which must
  partition the full discovered pool. Rejected includes screened out/ineligible;
  unresolved includes pending, investigating and identity-unresolved buckets.
- Qualified/discovered yield with numerator, denominator and percentage.
- Supported decisive hard checks/all company-hard-criterion slots, also with
  numerator/denominator/percentage; UNKNOWN slots and companies are counted. A
  decisive check needs canonical provenance. This coverage includes screened
  companies' missing downstream checks, not just admitted candidates.
- Transport calls separately from purchases and adoptions; per-actor counts,
  pending responses where available, duplicate/unreserved purchases and
  purchases per qualified company (`null` at 0 qualified). The Chaos driver does
  not expose per-slice pending counts: those are `null`, not inferred zero.
- Ledger committed estimates, estimate coverage, mission ceiling and estimated
  cost per qualified company (`null` at 0 qualified). These are the existing
  production spec/provisional ledger estimates for **offline synthetic
  purchases**. Actual receipts, live model cost and settled customer credits
  remain `null`. Historical observed fixture evidence does not turn replay
  estimates into historical actual charges.
- Canonical check provenance/evidence, terminal/queue status, slices, execution
  failure events, recovery checks and deterministic acceptance.

Offline acceptance requires expected counts/checks/termination, a consistent
partition, hard proof for every qualified lead, no UNKNOWN promotion or false
hard exclusion of a MATCH control, no duplicate purchase, a reservation before
every purchased call, and the scenario's provider/spend limits. Recovery adds
lease/claim/row/ledger invariants. Tests deliberately remove proof/reservations,
duplicate purchases and change a truth label to ensure these checks fail.
Offline pass is separate from smoke readiness and authorization. The existing
readiness script's `SAFE FOR PRODUCTION SMOKE: YES` line reflects its offline
suite only. It does not supersede the unverified billing/database and
enforceable-cap preconditions below; this artifact keeps smoke blocked.

Failure observations cover returned company provider-error markers, injected
worker deaths and batch exceptions. Comprehensive provider/model error telemetry
is unavailable; an empty array is scoped to these observations.

## Proposed first internal smoke: pass/fail

[`smoke-mission.proposed.json`](smoke-mission.proposed.json) is a **proposal
only**: find **1 US B2B software company, declared 11–50 employees, with an open
Account Executive posting dated within 30 days**. No funding clause or funding
calls.

Hard limits: 3 discovered companies/rows/detail URLs, 1 discovery page, 2
slices, 5 minutes, 5 provider purchases, 5 adoption/poll calls, 4 model calls,
**$0.20 provider + $0.05 model = $0.25 total**, and **20 customer credits**.
Caps by provider: LinkedIn job search 2, company-details batch 1, Firecrawl map
1, Firecrawl scrape 1; every other provider 0. These are proposed bounds, not
price quotes and not installed runtime configuration. In-flight reservations
count.

Before starting, separately authorize one internal mission on an identified
integrated commit; independently verify Claude's billing fix, database/recovery
tests, cancellation and each limit's enforcement. Unknown prices or inability to
enforce three discovery rows without changing routing **block the smoke**. No
field in this proposal enables a worker, schedules a mission or changes
production configuration.

`assessSmoke` evaluates **supplied, operator-reviewed observations**; it
performs no execution and makes no database/provider calls. It fails closed on
missing prices, credit reconciliation, excess spend/counts, unsupported
qualification, UNKNOWN promotion, false exclusions, changed criteria, unexpected
providers, duplicate/unreserved/post-stop purchases, execution failures or
inconsistent terminal rows/retained claims/leases. Evidence review must check
actual dated sources and all four hard rules. It cannot authenticate an
operator's inputs.

Full PASS requires both safety/accounting/execution PASS and at least **1
independently evidence-reviewed qualified company**, with no more than the one
requested. Honest zero results can pass safety/termination while failing the
efficacy gate; do not describe them as a successful discovery smoke. Abort at
the first threatened limit, unsafe proof, lost ownership or accounting mismatch;
stop new purchases, cancel work and reconcile any in-flight charges. Do not
automatically retry or start another mission. Broader production accuracy still
needs a representative, independently labeled cohort with UNKNOWN reported
separately; one smoke mission cannot establish precision/recall.

## Coordination and remaining gaps

Validation on `fec34976` plus this adapter: 227 Replay Lab tests passed, 295
targeted Lead V2 regressions passed, and 8,563 edge tests passed. On a
disposable `b45e66a8` preview copy plus this adapter: 257 Replay Lab tests
passed. Each full Lab run retained one existing ignored display-only funding
headline test. The final 36 new tests passed on both trees after
report/acceptance hardening; new modules and existing replay libraries
type-check, lint and formatting pass. Every scenario passes (17/17); complete
batch output is reproducible. Real DB contract and billing-settlement checks
were not run by this sprint.

Read-only references inspected: `launch/hardening` at `fec34976` and
[PR #85](https://github.com/kathmanducreatives-code/aiworforce-platfrom/pull/85)
at `b45e66a8`. #85 is a DO NOT MERGE validation preview of #74/#75/#76/#82/#79/
#81/#77, not this sprint's base and not evidence that #78/#80/#83/#84 are
integrated. This PR imports only Replay Lab/shared functions already on the
base; it does not copy or edit the pending runtime/benchmark branches.

No billing, database, worker, workflow, deployment, production routing or
qualification-policy files changed. Funding-screen/recovery and real database
validation remain Claude's scope. Combined-preview compatibility is checked only
in a disposable copy, leaving reference branches unchanged.

Limitations: this composes Replay Lab's production building blocks, not the full
authenticated run-agent endpoint. The inline funding-pool screen, live planner/
grounder/triage/reasoner, provider availability, real Postgres/PostgREST/RLS,
receipt/credit settlement and latency are not established here. No real
precision/recall or routing-performance comparison is available from this
fixture cohort. No production defect or runtime fix is claimed by this adapter.

If runtime observations are insufficient for smoke review, propose a single
read-only audit export of canonical candidate checks/provenance/observation
dates, all execution rows including adopted run IDs, reserved/provisional/final
amounts, credit reconciliation and terminal/ownership events keyed by lineage
and provider-call identity. This is an instrumentation proposal only. Approval
and Claude's coordination would be needed before changing runtime files.
