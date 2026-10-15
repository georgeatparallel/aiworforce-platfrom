Independent safety verification — NO-GO at
`40d7c0aa67ba470a76b44f79955a3a0b3a8d730f`.

The verifier branch is
[codex/review-pr90-smoke-safety](https://github.com/kathmanducreatives-code/aiworforce-platfrom/tree/codex/review-pr90-smoke-safety),
original evidence commit `092d2e937031f0e4d09570e10260e93563d12f5d`.
[Full report](https://github.com/kathmanducreatives-code/aiworforce-platfrom/blob/092d2e937031f0e4d09570e10260e93563d12f5d/docs/launch/reviews/pr90-independent-smoke-safety.md),
[test instructions](https://github.com/kathmanducreatives-code/aiworforce-platfrom/blob/092d2e937031f0e4d09570e10260e93563d12f5d/tests/reviews/pr90/README.md).

| ID      | Severity | Original failure                                                                             | Fix SHA        | Retest PASS/FAIL | Remaining risk / required safe behavior                                                                                                             |
| ------- | -------- | -------------------------------------------------------------------------------------------- | -------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAF-001 | P1       | Admission RPC outage turns replay of uncertain Apify start into a refunded credit            | None available | FAIL at 40d7c0aa | Keep original credit reserved and purchase liability committed; no second vendor POST                                                               |
| SAF-002 | P1       | Stopped authorization turns replay of uncertain Apify start into a refunded credit           | None available | FAIL at 40d7c0aa | Cancellation must not prove that an earlier vendor purchase never occurred; retain hold pending reconciliation                                      |
| SAF-003 | P1       | Uncertain Firecrawl start is refunded despite retained durable purchase liability            | None available | FAIL at 40d7c0aa | Retain unresolved credit/purchase liability; suppress duplicate retry; explicit billing-policy review if needed                                     |
| SAF-004 | P1       | Remote image input passes serialized-byte/output limits without a maximum input charge bound | None available | FAIL at 40d7c0aa | Refuse unsupported remote/multimodal content or prove a conservative modality-aware maximum; text-only schema is a suitable first-smoke restriction |
| SAF-005 | P1       | Allowed own-API redirect reaches a forbidden destination without admission                   | None available | FAIL at 40d7c0aa | Reject redirect or classify/bound/admit each hop; zero destination sends for this unapproved request                                                |
| SAF-006 | P1       | Malformed admitted response missing deadline/operation/cost still sends                      | None available | FAIL at 40d7c0aa | Validate complete response and finite future deadline; zero vendor sends                                                                            |
| SAF-007 | P1       | Handler closes while admission is pending, but transport still starts                        | None available | FAIL at 40d7c0aa | Recheck closed context immediately before send; retain the conservative commitment                                                                  |

These seven assertion failures are six mechanisms, with distinct outage and
cancellation regressions for the uncertain-Apify hold. They are not the same
numbering as the earlier report's R1–R8 sections. P1 is the independently
assigned review severity; no observed production incident or P0 finding is
claimed.

Independent baseline: 43 passing characterization/mutation checks; required-safe
mode **24 passed / 7 failed**; native final-dollar, duplicate-admission and
lock-wait expiry **3/3 passed**; **8/8 mutations killed**. Combined existing
regressions: 124 targeted, 270 Replay (one existing ignored), and seven
specification checks passed. Characterization success is not safety acceptance.
All vendors/prices/receipts in these reproductions are synthetic; real
networking is loopback only.

Adjacent findings remain separate: initial Apify receipt usage is ignored;
generation/cancellation reads are not fenced through admission commit; node:http
bypasses patched global fetch (no current paid non-fetch call site found); a
hard external vendor billing ceiling and remote-run deadline are not
established. The poll/page/read-reservation design needs separate review and
must not silently increase purchases or USD limits.

Please identify the exact fix SHA. I will retain the original assertions, run
them independently against the new source, and publish per-ID results here. No
live mission is authorized. Final GO also requires separately verified external
prices/account limits and the exact test workspace/configuration, even after
code assertions pass.
