# G5 funding-screen replay and measurement audit

Run from the repository root with Node 22 and Deno 2.8.2:

```sh
deno test --allow-read --allow-env tests/replay/funding/
deno run --allow-read --allow-env tests/replay/funding/audit.ts
npm run test:lead-v2-regression
```

No application network permission is granted. `FixtureProvider` also replaces
`fetch` with a throwing boundary. No paid provider, production service, live
mission, deployment or real credit transaction runs.

## What is replayed

`screenHarness.ts` drives the production capability engine with the enforced
provider-spec spine and the priced $0.14 / two-admission funding-screen plan.
Its callback uses `fundingStageVerifier({ fallback: false })`,
`verifierSpecCompiler`, `guardedInvoker` and `ledgerBoundCall`, matching the
screen-to-ledger wiring in run-agent. The existing screen unit tests return
provider rows directly without this accounting boundary. The post-screen hiring
phase uses Replay Lab's existing `replayVerificationAt`; ledger entries are
strictly earlier than the checkpoint instant, as `ledgerAt` requires.

The clock is fixed at 2026-10-01T12:00Z without mocking timers. The planner
proposes full mode; the production screen must enforce short mode and four rows.
The pool contains a recent Seed round, complete stale history, incomplete stale
history, and a recent non-equity grant. The happy path proves geography,
declared size, recent venture funding and a current growth posting. A partial
company stays pending; a grant is not venture funding.

Stage is **a preference** in this screen-eligible mission, exactly as in the
source canary. A separate hard Seed-or-Series-A verifier check demonstrates that
uncorroborated stage evidence stays pending. This does not pretend that a recent
funding pass alone proves a hard stage requirement or that company-first
screening is the route a hard stage request will select.

Coverage includes full JSON checkpoint restoration, no repeated screen/discovery
purchase, deterministic call/idempotency-key equality, partial evidence,
provider wait and an injected ETIMEDOUT after a run starts, mandatory geography
and size failures, carried spend, a downstream purchase refused before reaching
the provider, and estimates remaining distinct from actual provider receipts.
The synthetic timeout has no sleep or real provider request.

## Provenance and missing data

- `fixtures/g5.funding-screen.json`: **all four company rows, the posting, and
  model answers are synthetic**. The mission shape comes from the committed
  sanitized `tests/fixtures/lead-v2/canary-5bfa76db/result.json`; funding
  response schemas come from committed `p6-funding-probes.json`. No production
  row is claimed in this new fixture, and no new production extraction occurred.
- Existing recorded funding sources: canaries `1156c062` and `5bfa76db`,
  `canary6.budget-hard-stop`, `canary8.hiring-affordability`, and
  `llamaindex.funding-non-equity`. The latter proves why non-equity assistance
  cannot count as venture funding. The historical probes contain provider
  records rather than a complete screened-pool lineage.
- Missing: a sanitized real funding-screen first page and top-up with per-row
  outcomes; an interrupted Atomus screen's checkpoint and eventual answer;
  same-search recent-check history; dated hiring records for every admitted
  company; independent industry labels; final provider receipt settlement.
  Synthetic rows fill only the deterministic control cases above.

The pool's funding read holds an estimated $0.0141; total engine committed spend
is $0.0312. One batched hiring verification adds $0.021, for $0.0522 committed
estimate. Four provider calls produce one canonically qualified company under
this synthetic mission. These are replay accounting assertions, **not measured
production cost, credits charged, or a promised conversion rate**.

## Measurement-only audit

`audit.ts` prints reproducible JSON from committed fixtures and the synthetic G5
run. It excludes synthetic Northwind Cloud from the recorded job-first cohort.
It never pools recorded and synthetic denominators.

| Observation                              | Measured result                                              | Interpretation                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Industry verification precision / recall | Not identifiable; zero independent label/output pairs        | Multidimensional triage and retrieval `industryIds` are not industry-verification predictions or ground truth. Supply independently labeled verifier outcomes and the full discovered/rejected population before estimating either metric. |
| Company-first canary size snapshots      | 11/11 have declared 11–50 bands; 0 historically qualified    | Selected normalized snapshots, reconstructed from checkpoints; not an unbiased yield sample. Declared bands and associated-member counts have different semantics.                                                                         |
| Job-first recorded employers, 11–50      | 6/21 bands overlap and are contained (28.6%); 15/21 disjoint | This saved cohort spends attention on many employers outside the requested range. Unique employers, not posting count, are the denominator.                                                                                                |
| Job-first, 11–20                         | 6/21 overlap; 0/21 bands wholly contained                    | A coarse 11–50 band cannot prove exact 11–20 headcount. Overlap is retention for investigation, not qualification.                                                                                                                         |
| Job-first, 40–70                         | 9/21 overlap; 0/21 wholly contained                          | An even narrower range crossing a provider-band boundary needs additional evidence.                                                                                                                                                        |
| Historic funding canary 1156c062         | 3 reported calls, $0.0242 reported, 0 qualified              | Calls per qualified company is undefined, not zero. The saved counter is not independently reconstructed receipt billing.                                                                                                                  |
| Synthetic G5 control                     | 4 calls / 1 qualified; $0.0522 estimate                      | A bounded reproducible accounting baseline only.                                                                                                                                                                                           |

Size-filtered company-first discovery could reduce downstream identity/details
work on disjoint employers, and a batched funding screen can prioritize fundable
companies before paying for hiring. Job-first discovery can provide dated role
proof immediately, but its employer population is less aligned with a narrow
size band. These are mechanisms to compare, **not an A/B result**: the cohorts
have different requests, dates, filters and selection processes. No routing or
qualification changes are justified by this sample alone.

For a future offline matched comparison, hold geography, size semantics, stage,
funding/hiring windows, request count and budgets constant. Use separately
labeled company and posting pools; report unique employers, retained / qualified
companies, hard-fail and unknown reasons, per-actor purchases/adoptions and
actual receipt cost where present. Count zero-qualified runs explicitly. Include
media, consulting, staffing and software products in the industry labels.

## Production observations and replay limits

On `launch/hardening`, an interrupted funding read leaves unknown funding; the
screen state nevertheless becomes `screened: true`, and replaying that
checkpoint makes no new screen purchase. That proves no duplicate purchase,
**not recovery or successful adoption**. The screen callback returns findings
only and does not carry a pending provider result through this adapter. Treat
interrupted-screen recovery as an unresolved production risk until an actual
sanitized interrupted screen or the separately integrated failure-handling
changes establish it. This PR does not fix it or duplicate PRs #68–#73.

An Atomus Seed record alone also does not complete a hard stage corroboration
claim when the corroborating route is unavailable. That is an evidence
safeguard, not a reason to loosen qualification. The existing display-only NEA
funding headline gap remains separate and unchanged.

Receipt settlement, real Supabase writes, model quality and wall-clock latency
are not measured. Stubbed model outputs are explicitly synthetic. The timeout
adapter does not claim to reproduce the provider's eventual billing receipt.

Decisions needed before another discovery change: define the independent
industry label rubric (including product versus services businesses), decide how
exact size requests should be evidenced when providers expose only bands, and
supply matched sanitized route data if a quantitative company-first/job-first
decision is desired. No additional production access or paid run is requested
here.
