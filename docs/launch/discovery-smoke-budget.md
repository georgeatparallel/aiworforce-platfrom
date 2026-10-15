# One smoke budget specification — not activation

[`discovery-smoke-budget.spec.json`](discovery-smoke-budget.spec.json)
reconciles the authorization in #89 with the inactive worker proposal in #87. It
is the proposed contract for one internal test mission, one workspace and one
worker. It does not move a workflow, install environment variables, enqueue work
or authorize a paid call. **Status: BLOCKED.**

The single monetary authorization is **$0.25 total**, split into provider
commitments ≤ $0.20 and model commitments ≤ $0.05. At most **5 provider
purchases**, **4 model attempts**, and **5 minutes from the original queue
timestamp**. Credits are tightened to **5**, below #89's 20-credit maximum:
today one purchased provider call costs one credit; model calls do not become
credits. No billing-policy change is proposed here.

The mission and strict evidence rules remain #89's: one US B2B software company,
declared 11–50 employee band, open Account Executive role dated within 30 days.
No funding purchases or silent broadening. UNKNOWN is not MATCH, and absent
evidence is not a hard rejection. Every mandatory verification remains required.

## What changes in the proposed settings

| #87's current inactive proposal  | Consistent proposed smoke value                                          | Limitation                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Provider cap $0.20               | $0.20 (already aligned)                                                  | Existing ledger bounds reserved estimates; actual invoices need bounded quotes                                            |
| Credit cap 5                     | 5 (already aligned)                                                      | Does not establish atomic cross-process purchase admission                                                                |
| Workspace model meter $0.05      | $0.05 (already aligned)                                                  | Still retrospective once per request; cannot guarantee a $0.05 mission budget                                             |
| Unpriced model calls 2 per slice | 4 unpriced and 4 all-attempt slots per request                           | The new all-attempt guard covers priced calls and retries; neither count is durable across a new process                  |
| Worker 150000 ms per invocation  | 300000 ms invocation maximum plus fixed 300000 ms queue wall-clock guard | Two slices, queue delay and retry backoff share the original queue deadline; adding per-slice times alone is insufficient |
| 1 continuation                   | 1 continuation (already aligned)                                         | Bounds clean two-slice execution; does not replace a global deadline or retry budget                                      |

This comparison pins #87 at `2a60a41a`. Its comment that two unpriced calls per
slice imply at most four model calls per mission is not an enforcement
guarantee: priced calls, retries and newly constructed collectors need separate
admission. This specification does not amend or activate Claude's proposal.

The JSON's environment/request objects are **candidate specifications only**.
Setting them is insufficient to unlock execution. Missing variables do not
install a durable admission service. A run-budget candidate ceiling is not proof
of a global actor-returned row/page limit. A workspace-period model USD meter
does not reserve the next call. The provider rate for Firecrawl must be verified
and explicitly configured in the eventual test target, never filled with a
guessed rate. Current vendor/model rate tables must be reviewed as well.

## Implemented partial runtime protections

The independent `codex/smoke-execution-guards` branch adds:

- Optional all-model **attempt** admission before transport, including retries
  and fallback models. Failed/in-flight attempts retain their request-local
  slots; concurrent calls in the same collector cannot share the last slot.
- Optional strict pricing: unknown model rate refuses before transport; missing
  usage or an uncertain model start blocks further paid attempts. Estimated
  token costs do not become actual invoice amounts.
- Usage budgets survive telemetry drain. The existing unpriced-call semantics
  stay unchanged unless the new all-call/strict-price options are set.
- Invalid new provider quotes cannot commit a reservation. A valid prior paid
  reservation remains adopted without re-buying; a corrupted quote cannot
  authorize a fresh purchase.
- Optional fixed wall-clock bound from the persisted queue timestamp. A new
  worker, lost checkpoint or continuation cannot renew that row's five minutes.
  Unreadable/future timestamps fail closed before the handler. Cancellation and
  deadline stop gates reach model transport too; cleanup/checkpointing can
  finish without permission to start more paid work.

These do **not** implement a durable mission USD reservation, cross-process
model-call cap, actor/page/global-poll counters, vendor-side cancellation or
absolute proof against a newly enqueued queue row for the same authorization.
Queue waiting counts toward this conservative deadline. In-flight vendors can
continue after authorization expires; their maximum liability must already be
reserved. The worker guard does not guarantee that remote vendor work stops or
that local finalization finishes within exactly five minutes.

## Acceptance and abort gates

Do not unlock the smoke until a reviewed durable admission implementation is
available and its multi-process/crash tests pass, Claude validates the exact
test schema and billing RPCs (including held fixes), prices/upper quotes are
verified, and one non-production target with test-only credentials is approved.
The current specification is tested to remain blocked while any of those
capabilities are absent. #89's `assessSmoke` checks supplied observations; it is
not proof of enforcement or permission to execute.

At execution time stop new work at the first exhausted/unknown authorization,
unknown price, unexpected actor, deadline, cancellation or lost ownership. Never
interpret refusal as a reason to widen the mission or start a duplicate provider
run. Retain pending run IDs and unresolved companies for safe reconciliation.
Actual receipts and credits must be reviewed before claiming that the
authorization was respected. Honest zero results are acceptable safe
termination, but do not pass the discovery-efficacy goal of one qualified lead.

No production settings, worker proposal, migration, workflow or existing PR
branch is changed by this specification. No live mission is authorized.

## Updated integration and durable proposal status

All three feature branches now include the merged Tier 0/1 base `9453b7c5`,
retaining their original commits. The runtime merge is clean, including funding
recovery, fencing and credit-uncertainty changes. Its 8,653 edge tests and 270
Replay tests pass (one existing ignored display-only case).

The independent durable proposal now contains precise two-table/four-RPC SQL, a
rollback that refuses to discard audit records, and 32 passing offline SQL and
mutation controls. It is outside migration/bootstrap directories and is **not
applied or wired into physical transports**. Three real multi-session PostgreSQL
tests are prepared and type-checked but unrun; embedded PostgreSQL serializes
requests and is not proof of lock contention. No actual price or provider
receipt was verified; all proposal controls are synthetic.

Activation therefore remains blocked even after all Tier 0/1 merges and these
passing tests. Approval is still required for durable schema/admission wiring
and conservative mission-liability retention; exact test schema/billing checks,
physical request bounds, verified prices, native contention/crash/transport
proofs and separate live authorization must precede execution.
