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

| #87's inactive proposal         | Consistent proposed smoke value        | Limitation                                                                            |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| Provider cap $0.25              | $0.20                                  | Existing ledger bounds reserved estimates; actual invoices need bounded quotes        |
| Credit cap 10                   | 5                                      | Also tightens global purchased-provider-call count under the existing one-credit rule |
| Workspace model meter $1.00     | $0.05                                  | Still retrospective once per request; cannot guarantee a $0.05 mission budget         |
| Unpriced model calls 50         | 4, plus new all-attempt guard 4        | New all-attempt guard is request-local, not durable across a new process              |
| Worker 300000 ms per invocation | Same plus fixed queue wall-clock guard | Derived from server-persisted queue.created_at; never renewed by a retry/checkpoint   |
| Default continuation allowance  | 1 continuation                         | Bounds clean two-slice execution; does not replace a global deadline or retry budget  |

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
