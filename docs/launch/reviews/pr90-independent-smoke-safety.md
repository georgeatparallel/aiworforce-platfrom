# PR #90 independent smoke safety review

**Decision: NO-GO. PR #90 needs changes before the first $0.25 mission.**

Reviewed on 2026-10-15: PR #90 at `40d7c0aa67ba470a76b44f79955a3a0b3a8d730f`,
based on `launch/hardening` `9453b7c5f612f6ad8a4ef7da1b554dede27fcc53`. Both
remote refs were checked during the review. These conclusions apply to these
commits, not future revisions.

This review adds independent tests and documentation only. Claude's branch,
runtime, held SQL, billing policy, infrastructure and configuration were not
changed. All database execution was in disposable localhost schemas. Vendors,
prices and receipts in the reproductions are synthetic; no paid API, production
database, deployment, migration application to an application database, or live
mission was used.

## Critical guarantee matrix

| Guarantee                                                                                          | Result                                | Independent evidence and scope                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue authorization exists before task binding and cannot be minted/reset by a worker              | PASS                                  | Native owner/service/client-role tests; a new queue has no inherited authorization. Owner approval is still a trusted administrative action.                                                                                                                                                       |
| Combined $0.25, provider $0.20, model $0.05 commitments serialize prospectively                    | PASS                                  | Native final-dollar contention and each category/combined cap; pending/failed/uncertain operations retain commitments. This proves catalog arithmetic, not vendor invoice amounts.                                                                                                                 |
| Concurrent retries and purchase/page/actor/poll counts cannot reset across slices                  | PASS                                  | Duplicate concurrent starts issue one admission; 12 queued attempts over two connections admit four model attempts; actor, purchase, page and global poll refusals tested independently.                                                                                                           |
| Sequential generation, queue/lineage lease and cancellation checks                                 | PASS                                  | Native stale generation, cancellation, expired leases and revoked-context tests reject.                                                                                                                                                                                                            |
| Ownership remains fenced against concurrent cancellation/generation change until admission commits | FAIL for this stronger guarantee      | Trigger-paused admission permits a concurrent queue cancellation or generation change to commit, then itself returns admitted. Overlapping operations may linearize before cancellation; do not claim this test proves an unavoidable overspend. Strict fence semantics need an explicit decision. |
| Crash/lost checkpoint cannot dispatch the same already-admitted provider request twice             | PASS within tested identity           | Durable rows survive lost RPC/receipt/checkpoint; fresh contexts adopt or remain uncertain. No automatic re-buy. Byte-different bodies remain different operation identities.                                                                                                                      |
| Existing uncertain customer credit remains held until resolved                                     | FAIL                                  | Real credit RPCs and `runTool`: admission outage or stopped replay refunds an earlier uncertain Apify hold; uncertain Firecrawl also refunds.                                                                                                                                                      |
| Fixed mission deadline prevents new admitted paid work after expiry                                | PASS with response-validation caveat  | Deadline is anchored to original queue creation; native post-lock wall clock refuses a wait that crosses expiry. Malformed admitted responses separately fail open. This is a new-work cutoff, not a hard vendor stop or total-process-duration guarantee.                                         |
| A handler that has ended cannot start transport from an in-flight admission                        | FAIL                                  | `closedReason` set after admission starts is not rechecked before send. Revoked `AbortSignal` is rechecked and passes its control.                                                                                                                                                                 |
| Every physical request uses admission, including redirect hops and alternate HTTP clients          | FAIL                                  | Real loopback redirect follows without reclassification; `node:http` bypasses patched fetch. No current vendor SDK/non-fetch call site was found in the inspected worker/run-agent/shared tree.                                                                                                    |
| Observed model/provider retries, fallback, dataset access and polling use the fetch gate           | PASS for inspected paths              | Actual GPT retry, generic Anthropic→OpenAI fallback, strategist transport, Apify tool and Firecrawl tool tested. Unexpected hosts/gateway and missing output limits refuse. Global fetch is not an egress sandbox.                                                                                 |
| Model request bounds prove the quoted maximum charge                                               | FAIL                                  | A remote image request below 300 serialized bytes passes the byte/output checks; remote media tokens are not bounded by those bytes. Text-only quotes also need documented tokenization/protocol/pricing assumptions.                                                                              |
| Every admitted response is validated before dispatch                                               | FAIL                                  | Missing deadline/operation/cost with a string token is accepted; `Date.parse(undefined)` is NaN and the expiry comparison does not refuse.                                                                                                                                                         |
| All available Apify receipt usage is recorded and stops further admissions on overrun              | FAIL                                  | Initial start response usage is ignored; status-poll usage is recorded. Native receipt-overrun refusal control passes.                                                                                                                                                                             |
| Qualification and evidence rules remain unchanged                                                  | PASS for diff and offline regressions | No policy changes in PR #90 or this review; combined Replay tests pass. This is not a production-wide accuracy estimate.                                                                                                                                                                           |
| Future worker exactly implements the approved smoke specification                                  | FAIL / incomplete                     | Gate is enabled only in the inactive proposal; OpenAI key mapping, exact reviewed catalog/request bounds and specification reconciliation are unfinished. Workspace checks are static, not a verified deployed target.                                                                             |
| $0.25 is a hard external vendor billing ceiling                                                    | NOT PROVEN                            | Unverified price maxima, asynchronous runs, modality/tool/tier pricing and external vendor behavior prevent this claim.                                                                                                                                                                            |

## Reproducible defects and proposed corrections

### R1 — A new refusal releases an older uncertain Apify credit hold

`smokeAdmission.ts:390` maps only `uncertain` and `adopt` to 503; an admission
outage, stopped authorization or local revocation becomes 409. That is a
definite non-start for this attempt, but does not prove a preceding purchase did
not happen. With the same billing key, the actual `runTool` settlement refunds
the original held transaction. In both native reproductions, exactly one mock
vendor POST occurred, the durable commitment remained, and the credit changed
from `reserved` to `not_charged` with one refunded credit.

Tests: `verify.ts`, `rpc-outage` and `cancelled-replay`. Required correction:
preserve original operation uncertainty across new transport refusals and
reconcile it explicitly. Do not equate a presently unsent attempt with proof
that the original purchase never existed. Preserve the integrated #88 credit
hold/recovery safeguards; do not solve this by buying again.

### R2 — Uncertain Firecrawl is refunded despite retained purchase liability

Actual Firecrawl `runTool` receives a mock vendor 503. A retry is correctly
suppressed by the stable durable operation, leaving one physical POST, but the
generic Firecrawl error is settled as `not_charged`. The existing special
uncertainty settlement is Apify-specific. This is an uncovered integration case,
not evidence that PR #90 introduced all of Firecrawl's pre-existing billing
semantics. Required correction: an approved uncertainty-settlement contract
covering Firecrawl and admission refusals; retain liabilities until resolved. Do
not silently change customer billing policy.

### R3 — Serialized request bytes do not bound remote model input charges

`boundRequest` checks serialized bytes, output tokens and `n`, but permits
unconstrained nested message content. A synthetic OpenAI image URL in a request
under 300 bytes passes a 20,000-byte/1,000-output-token template. The vendor
would fetch/tokenize media outside that byte count. Similar file/document/tool
inputs and pricing options need explicit validation, not guessed prices. The
test never fetches the image or invokes a model; it proves missing validation,
not a real invoice overrun.

Required correction: for the first smoke, permit an audited text-only request
schema and known model/rate/tier, cap all charge-driving fields, and document a
conservative input-token bound including protocol/schema overhead. Alternatively
provide modality-aware worst-case quotes. Missing request output-token limits
already refuse correctly, including through real `gptStructured`.

### R4 — Redirects bypass classification and admission

`createAdmissionFetch` passes allowed own-API requests directly to `baseFetch`
and sends admitted requests without a restrictive redirect policy. The runtime
follows redirects internally. Two real local servers reproduce an own-API 307
redirect to a directly forbidden destination: the destination gets a POST with
zero admissions. No actual Supabase redirect or production exploit was observed.

Required correction: reject redirects, or reclassify/bound/admit every hop
before sending it, including own-API requests. Keep vendor cap pins and request
hashes valid for the final destination. Separately, real `node:http` bypasses a
patched global fetch; no current paid non-fetch caller was found. Either
explicitly restrict support to audited fetch-only clients with regression
checks, or obtain a separately approved egress control. Do not describe the
patch as a network sandbox or as protection against arbitrary future SDKs.

### R5 — Malformed admission response can bypass expiry

`admitOperation` accepts `{decision:"admitted",reservation_token:"synthetic"}`
without a valid deadline, operation key or committed amount. The transport sends
because `now >= NaN` is false. Required correction: validate the complete RPC
shape, expected operation identity, finite nonnegative commitment and finite
future deadline before send. This was fault injection; the actual held SQL
normally supplies these fields.

### R6 — Handler closure is not rechecked after admission

The runner marks an ended context `mission_call_ended`, intending to prevent
stray work. If the request was already awaiting admission when the handler
ended, the transport checks only signal/deadline afterward. A real native
admission followed by setting `closedReason` still sends a mock model request.
Required correction: recheck closure immediately before send and retain the
conservative reservation. The explicit signal-revocation control does refuse
correctly.

### R7 — Initial Apify response usage is dropped

`observe` attaches start-response run/dataset IDs, but reads `usageTotalUsd`
only from later status GETs. With a synthetic immediately completed start
reporting $1 against a $0.06 commitment, recorded usage stays null and another
purchase is admitted. These are artificial prices, not an observed charge.
Required correction: record available usage from either response shape with
provenance; an overrun must stop additional admissions. Detection still cannot
undo a vendor charge or turn an estimate into a guaranteed upper bound.

### R8 — Ownership reads are not fenced through commit

The authorization row serializes all admissions, but queue/task/lineage
ownership reads are unlocked. Independent tests install a pause immediately
before the operation insert; another connection commits cancellation or a
generation bump; the original admission then commits. This does not invalidate
budget serialization. Decide whether admission may linearize at its earlier
ownership check, or require stronger cooperative locking/fencing with the
existing queue and generation writers. Review lock ordering before changing it.
A database check alone cannot atomically revoke an external request already
being sent.

## Native execution, failure injection and mutations

Reproduction instructions and source fingerprints:
[`tests/reviews/pr90/README.md`](../../../tests/reviews/pr90/README.md).
Machine-readable summary:
[`pr90-independent-results.json`](pr90-independent-results.json).

| Independently executed suite                                      | Result                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New review characterization, native, transport and mutation suite | **43 passed, 0 failed**: 29 verification + 2 egress + 4 poll controls + 8 mutation checks                                                                                 |
| Required-safe mode of verification + egress                       | **24 passed, 7 failed**; deliberate safety assertions expose R1 twice, R2, R3, R4, R5 and R6                                                                              |
| Native final-dollar / duplicate admission / lock-wait expiry      | **3/3 passed** using distinct PostgreSQL sessions; not mocked locks                                                                                                       |
| Mutation checks, included in 43                                   | **8/8 killed**: row lock, post-lock clock, generation fence, model attempt cap, approval privilege, no-context denial, uncertain-status mapping, output-bound requirement |
| PR #90 + runtime guard branch, targeted regressions               | **124 passed**                                                                                                                                                            |
| Combined Replay suites                                            | **270 passed, 0 failed, 1 existing ignored**                                                                                                                              |
| PR #90 + runtime guard + smoke specification                      | **7 passed** specification checks                                                                                                                                         |
| Relevant combined type checks                                     | Passed: admission, runner, execution ledger, GPT provider                                                                                                                 |
| New review formatting and lint                                    | Passed; lint excludes only the inline-import style rule                                                                                                                   |

The green characterization command verifies that the defects are reproducible;
it is not seven safety passes. Required-safe mode exits nonzero. Mutants are
applied only to scratch SQL/functions or in-memory module copies, after the
unmodified control passes. None is a mutation of Claude's branch.

Failure boundaries exercised include before admission (no commitment), lost
admission answer after commit (commitment retained, no send), after vendor
execution with lost receipt (uncertain, no second send), lost checkpoint/fresh
context, new queue, duplicate questions, stale generation, expired leases,
cancellation, concurrent limits, unknown quote, model retries/fallback, absent
output limit, revoked context and handler closure. These are boundary fault
injections, not OS-killed worker or real-vendor idempotency tests.

The native harness executes actual PR SQL against minimal prerequisite tables in
unique schemas, with real credit functions for settlement tests. It does not
independently reproduce the full deployed Supabase schema, PostgREST role
switching/cache, pg_net/cron or secrets binding. Claude's reported full-contract
passes are not counted as independent runs here.

## Five-poll usefulness, with mock runs only

Status reads, dataset reads and receipt reads share the five-poll allowance.
Actual tool-loop behavior with four synthetic completion schedules:

| Completion schedule            | Status GETs | Dataset GETs | Total polls | Evidence returned           |
| ------------------------------ | ----------: | -----------: | ----------: | --------------------------- |
| Complete in initial POST       |           0 |            1 |           1 | Yes                         |
| Complete on second status read |           2 |            1 |           3 | Yes                         |
| Complete on fifth status read  |           5 |            0 |           5 | No: dataset refused         |
| Complete on eighth status read |           5 |            0 |           5 | No: still running at cutoff |

Only the loop's 3-second sleeps were accelerated. These schedules are not real
Apify timing observations and support no production success percentage. The
five-read cap is safe for a plumbing test which accepts unresolved evidence; it
does not support a claim of useful research for slower async runs or multiple
actors. Receipt reads must have an explicit allowance too.

Retain the intended **$0.25 total, $0.20 provider, $0.05 model, five purchases,
four model attempts, 300 seconds from original authorization/queue creation, one
workspace, one worker, one discovery page and at most three candidates**. Never
raise spending limits to compensate for missing evidence. Keep five polls for
the current safety-only proposal and classify unresolved output honestly. For
useful two-actor research, propose a reviewed eight-read plan (for example, two
statuses + dataset + receipt for each of two runs) with backoff/bounded long
polling and no increase in purchase/USD limits. **Eight is a design candidate,
not a measured sufficient value or an approved setting**; PR #90's held database
constraint currently allows at most five and would need explicit review. Any
long poll must also fit the actual transport timeout; increasing `waitForFinish`
past the existing start-request timeout creates uncertainty rather than safety.

## Compatibility and separate branch readiness

The runtime patch from `codex/smoke-execution-guards` (`9aec00da`) and the
specification patch from `codex/smoke-budget-spec` (`ae0fa524`) apply cleanly to
a separate archive of PR #90. The combined checks above pass. Existing request
budgets remain partial defense in depth; durable commitments are not replaced by
request-local telemetry or credit estimates. Funding recovery and canonical
qualification regressions remain green. No existing branch was rewritten.

Both branches are ready for **separate draft review**, not activation. The spec
continues to say BLOCKED and must be reconciled after PR #90 fixes: its earlier
"Claude implementation unavailable"/reference-only status is now historical, and
some physical-path gaps have improved. Do not flip those flags to verified
merely because these local tests ran. The durable proposal branch remains
reference material; do not independently implement or apply a competing schema.

The inactive #87 workflow proposal in PR #90 adds `DISCOVERY_SMOKE_ADMISSION`
enforcement but still lacks an `OPENAI_API_KEY` secret mapping for GPT paths.
The Lovable gateway is deliberately denied by this gate, so its key alone does
not make strategist research usable. Pin the reviewed provider/model and quote
catalog, request/output limits and test-scoped credentials before activation.
`AGENTORY_ROLE` defaults to `worker` correctly; explicitly setting it would make
the intended launch mode clearer. Existing confirmation of one non-production
project/workspace and Actions concurrency remain useful static checks, not a
verified environment binding. A worker can claim successive queue rows; only the
one approved row should have a live authorization. Multiple administrative
authorizations are separate spend approvals, not one global $0.25 budget.

Review links (GitHub API is still forbidden in this environment; HTTPS Git
read/push works):

- [Runtime guards vs launch/hardening](https://github.com/kathmanducreatives-code/aiworforce-platfrom/compare/launch/hardening...codex/smoke-execution-guards)
- [Smoke specification vs launch/hardening](https://github.com/kathmanducreatives-code/aiworforce-platfrom/compare/launch/hardening...codex/smoke-budget-spec)
- [Reference proposal vs launch/hardening](https://github.com/kathmanducreatives-code/aiworforce-platfrom/compare/launch/hardening...codex/smoke-durable-admission-proposal)
- [Independent review tests/report vs launch/hardening](https://github.com/kathmanducreatives-code/aiworforce-platfrom/compare/launch/hardening...codex/review-pr90-smoke-safety)

## Authorization blockers and next decision

Keep the first live mission **BLOCKED**. Have Claude correct R1–R7, decide and
document R8's concurrency semantics and the supported fetch-only scope, rerun
the independent safe assertions plus the full isolated contract/recovery tests,
and reconcile the inert worker/specification. Preserve all commitments across
uncertainty; never use automatic retries to regain a lost purchase receipt.

Schema application, actual test-target validation, credential/catalog binding,
Firecrawl uncertainty billing semantics and any poll-cap change require their
own review/approval. No migration or policy decision was implemented here.
Verify external actor/platform/proxy/rental/model pricing and account controls:
vendor work can continue and bill after the application deadline, even if new
requests stop. Abort or cancellation is not proof of zero charge. A reported
overrun only stops future work. Application-reserved estimates and later vendor
receipts must remain separate, with receipts unknown until reconciled.

The local tests demonstrate strong admission arithmetic and conservative
duplicate suppression, but do not establish a hard $0.25 vendor invoice ceiling,
a hard five-minute end to all remote execution, or authorization to run a live
test. A useful evidence result remains unproven with the five-poll proposal.
