# PR #90 independent verification loop

**NO-GO. No fix SHA is available at the latest checked remote head.** PR #90
remains at `40d7c0aa67ba470a76b44f79955a3a0b3a8d730f` and `launch/hardening`
remains at `9453b7c5f612f6ad8a4ef7da1b554dede27fcc53`. The original evidence
commit is `092d2e937031f0e4d09570e10260e93563d12f5d`. This report is a baseline
re-verification and prepared retest workflow, not a review of a nonexistent
patch.

## Per-bug results

| ID      | Severity | Original failure                                                            | Fix SHA        | Retest PASS/FAIL | Remaining risk                                                                                               |
| ------- | -------- | --------------------------------------------------------------------------- | -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| SAF-001 | P1       | Admission outage refunds an earlier uncertain Apify hold                    | None available | FAIL at 40d7c0aa | Keep the original liability held despite a newly unsent attempt; no second vendor POST                       |
| SAF-002 | P1       | Stopped authorization refunds an earlier uncertain Apify hold               | None available | FAIL at 40d7c0aa | Cancellation does not prove the earlier purchase never happened                                              |
| SAF-003 | P1       | Uncertain Firecrawl purchase is refunded                                    | None available | FAIL at 40d7c0aa | Keep unresolved liability and suppress duplicate retries; billing-policy contract needs review               |
| SAF-004 | P1       | Remote media passes byte/output limits without a maximum input charge bound | None available | FAIL at 40d7c0aa | Refuse unsupported modalities; verify text/schema overhead, model tier and maximum external rates separately |
| SAF-005 | P1       | Own-API redirect reaches a forbidden destination without admission          | None available | FAIL at 40d7c0aa | Every hop needs a refusal or valid admission; paid-path redirect handling also needs correction              |
| SAF-006 | P1       | Malformed admitted response permits transport                               | None available | FAIL at 40d7c0aa | Require complete identity/cost/deadline validation and zero vendor sends on malformed data                   |
| SAF-007 | P1       | Handler closes during admission but transport still starts                  | None available | FAIL at 40d7c0aa | Recheck closure before sending; keep the conservative commitment                                             |

All seven original safe assertions remain intact. Only test names gained IDs.
The preservation guard parses and compares all six original test/helper modules
against Git commit `092d2e93`, ignoring only test names/comments/formatting. It
also verifies the original source pins remain byte-identical. The repeated
baseline is **43 passed / 0 failed**, including **8 mutation checks**; the
unchanged required-safe assertions are **24 passed / 7 failed**, with each ID
matched once in fresh JUnit output. The native final-dollar, duplicate-purchase
and lock-wait expiry checks execute against actual PR SQL and distinct
PostgreSQL sessions.

Machine-readable results:
[`pr90-verification-loop-results.json`](pr90-verification-loop-results.json).
Reproduction and exact-SHA preparation:
[`tests/reviews/pr90/README.md`](../../../tests/reviews/pr90/README.md).

## Adjacent audit, separate from the original seven cases

Seven additional characterization checks pass. Their required-safe mode has five
passes and two failures:

- **ADJ-001, P1:** a completed initial Apify POST reporting usage above its
  quote still leaves recorded usage null and permits another admission. This
  extends the original report's R7; it is separate from SAF-001–SAF-007. Prices
  and receipt values are synthetic. Capture the available usage before
  permitting more work; detection cannot undo an external charge.
- **ADJ-004, SAF-005 extension:** the paid-request path drops a caller's
  explicit `redirect: "error"`; the base transport receives no no-follow policy.
  Fixing only the free own-API path would leave this uncovered. A safe base
  transport must reject redirects or handle them manually with per-hop
  admission.
- **Late receipt controls pass:** receipts remain attachable after deadline,
  cancellation and generation changes, cannot replace immutable run IDs, cannot
  lower the maximum observed charge, and do not release committed amounts.
- **Native late-receipt contention passes:** a receipt reporting over-quote
  usage while holding the authorization lock stops an admission waiting on
  another session. This is actual PostgreSQL serialization, not a mocked RPC
  decision.
- **Ownership semantics remain unresolved:** the original trigger-paused tests
  still demonstrate that cancellation/generation writers can commit between an
  admission's unlocked ownership checks and its own commit. Sequential checks
  and signal revocation pass. Overlapping operations may linearize earlier; do
  not report this as a proven unavoidable vendor overcharge. Define the
  guarantee and cooperative lock order before changing the implementation.
- **Alternate HTTP clients remain outside the fetch patch:** the original
  loopback `node:http` bypass remains reproducible. No current paid non-fetch
  call site was found in the inspected worker/run-agent/shared implementation.
  Runtime source inspection is not proof against arbitrary future SDKs, indirect
  database side effects or an external actor's own subsequent charges.

All vendor responses, prices and receipts here are synthetic. Actual provider
receipts remain absent and actual spend remains unknown/null. Native execution
uses disposable localhost schemas with minimal prerequisite tables, not the full
hosted Supabase/PostgREST environment or OS-killed workers.

## Twelve polls, discovery pages and receipt-read capacity

The actual checked PR still has `provider_polls <= 5`; a native check confirms
that setting twelve fails its held SQL constraint. API access currently prevents
reading any newer discussion-only twelve-poll proposal, and no corresponding
code revision is visible. The following is an independent design evaluation, not
approval or a claim that twelve has been implemented.

A synthetic scratch-schema variant permitting twelve reads admits twelve status
reads and then refuses the dataset/receipt read. Merely increasing one shared
counter cannot reserve evidence or reconciliation capacity. Twelve at the
existing three-second cadence also does not prove a run will finish: no recorded
completion-latency cohort exists in this review.

Before authorizing useful research, define an explicit plan for status,
dataset/pagination and final-receipt requests for each allowed actor. An example
allocation totaling twelve could be seven reads for one run and five for
another, **only if** the reviewed actor plan can justify those maxima. It is a
synthetic planning example, not measured sufficiency. Reserve mandatory
dataset/final-cost reads durably before starting the purchase; optional status
reads must not consume them. Count pending reads, transport retries, slices and
workers against the same authorization. Prevent new purchases if remaining read
capacity cannot support their mandatory evidence/reconciliation. Stay within the
unchanged $0.25 total, five purchases and original 300-second deadline. A free
quoted read still needs a validated price; neither GET nor "poll" automatically
means unbilled.

Receipt persistence through the database RPC is distinct from a vendor request
to obtain a receipt. The former is allowed after expiry and passes these tests;
the latter currently needs gate admission, parent identity and available poll
capacity before expiry. Missing/late vendor receipts must leave liability held
and costs unresolved, with any subsequent reconciliation separately authorized.
Do not turn exhausted reads into a refund, guessed actual cost or automatic
re-purchase. A larger poll allowance does not extend a mission deadline.

Page counting currently trusts each approved template's `discovery_page` flag. A
native synthetic catalog with that flag false on the jobs actor permits two
distinct searches while recording zero discovery pages; purchase/USD/actor caps
still apply. This is a trusted catalog-classification gap, not a worker
privilege bypass. Review every actor/input variant that discovers a new company
cohort, including page/cursor variants and any configured fallback. Ensure it
counts as discovery even when used outside the initial job search. Treat reads
of an already-purchased bounded dataset separately from new paid discovery
pages, and pin result/page/cursor limits. Assert the actual approved catalog's
classification before activation rather than assuming optional metadata enforces
the policy.

## PR communication and retest gate

The consolidated comment is prepared at
[`pr90-consolidated-comment.md`](pr90-consolidated-comment.md), with per-bug
counterexamples, links and expected safe behavior. Posting to PR #90 was
attempted before further test work, retried after the user reported restored
access, and retried with the available escalation. All attempts returned
`Forbidden`. An anonymous API-root request also failed at the proxy CONNECT
tunnel with HTTP 403. `gh auth status` additionally reports the injected
`GH_TOKEN` invalid, but that diagnostic cannot establish token validity while
the proxy blocks the API. Authentication must be checked again after
connectivity works. No token value was inspected or printed. No comment URL
exists because posting did not succeed. The network restriction must permit
`api.github.com`, and the running environment needs valid secure GitHub
authentication, before this chat can use PR #90 as the requested communication
hub. HTTPS Git read/push remains available. Do not infer that a comment was
posted from a pushed Markdown file.

On a new exact SHA, the prepared workflow archives source into a fresh temporary
directory, verifies original assertions, fingerprints the new source without
overwriting baseline pins, and emits per-ID PASS/FAIL/NOT_RUN with fresh JUnit.
Type-check errors, skipped/missing IDs and stale output cannot count as success.
Run targeted billing/recovery tests and native contention controls against that
same archive. If a case fails, preserve its smallest `--filter SAF-00N`
counterexample and post the exact SHA/results when API access works. No Claude
implementation code is changed by this verification workflow.

Only after the seven cases **and any additional critical transport/receipt
findings** pass should final independent regression/mutation validation run
against the exact integration tree. Even then, separately verified vendor
prices, account spending controls, test workspace, credentials and explicit
live-test authorization remain required. Application reservations do not
establish a hard external vendor billing ceiling or instant cancellation of
remote work.
