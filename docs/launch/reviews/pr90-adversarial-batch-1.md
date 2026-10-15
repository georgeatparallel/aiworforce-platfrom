# Independent adversarial batch 1 — SAF-008

**NO-GO. Reviewed PR #90 SHA: `40d7c0aa67ba470a76b44f79955a3a0b3a8d730f`.**

## Confirmed provider request-bound bypass

| ID      | Severity | Original failure                                                                                            | Fix SHA        | Retest PASS/FAIL    | Remaining risk                                                                                                |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------- | -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| SAF-008 | P1       | An absent or empty provider body bypasses mandatory fields in the approved quote and reaches paid transport | None available | FAIL, both variants | The approved maximum is conditional on a field that was never validated; no real vendor overcharge is claimed |

Exact implementation: `supabase/functions/_shared/smokeAdmission.ts`,
`boundRequest`, lines 212–220 of the reviewed SHA. `createAdmissionFetch` then
uses that successful bound result to reserve and dispatch.

Root cause: mandatory `max_fields` validation is inside
`if (hasBody || limits.pin_body)`. A provider request with no body or `""`, and
a template without body pins, skips the loop entirely. The same request with
body `{}` correctly refuses because the mandatory field is missing. Only model
requests have a separate final body-presence refusal.

Deterministic counterexample: authorize an Apify provider quote with
`request_limits: {max_request_bytes:4096,max_fields:{maxItems:3}}`, then invoke
the actual gate with an absent/empty POST body. The native admission operation
commits and the fake vendor sees one request without `maxItems`. Sending `{}`
under the identical quote produces `field_unbounded:maxItems`, zero admissions
and zero vendor requests. A populated valid `{"maxItems":3}` request is admitted
once as a positive control.

This is a confirmed violation of the gate's approved-request contract at its
callable transport boundary, not a claim that a current Discovery tool emits an
empty body or that Apify was actually charged above its quote. Inspected tool
paths construct JSON bodies; an application-level empty-body trigger through
those tools was not established. The P1 priority concerns the money-boundary
fail-closed guarantee: a request that cannot prove its approved mandatory bounds
must not be sent. A real actor may reject or use defaults; neither is evidence
that the unvalidated request is safe to purchase.

Smallest proposed correction for Claude: apply mandatory field validation to an
empty object when the body is absent, or refuse absent bodies when a quote
requires body fields. Keep legitimate bodyless, independently capped operations
only where explicitly supported. No implementation change is included here.

## Reproduce

Use the same disposable localhost PostgreSQL setup and pinned source described
in [`tests/reviews/pr90/README.md`](../../../tests/reviews/pr90/README.md).

```sh
deno test --cached-only --allow-read --allow-env --allow-net=127.0.0.1 \
  tests/reviews/pr90/providerBounds.ts
PR90_CHARACTERIZE_NEW=1 deno test --cached-only --allow-read --allow-env \
  --allow-net=127.0.0.1 tests/reviews/pr90/providerBounds.ts
```

Required-safe mode: **2 passed / 2 failed**. Characterization mode: **4
passed**. The two failures are variants of one bug, not two new IDs. SQL and
runtime gate are the actual reviewed implementation; quote, vendor responses and
all prices are synthetic. No paid request is executed.

The original SAF-001–SAF-007 assertions and 43-check baseline remain unchanged.
The latest task explicitly permits isolated worktrees; exact-SHA preparation now
uses a detached worktree rather than an archive and still modifies no Claude
branch or runtime code. GitHub API comments remain unavailable at the last
attempt; this committed report is the small-batch handoff source.
