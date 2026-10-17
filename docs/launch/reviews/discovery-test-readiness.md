# Independent correction review and isolated-test readiness

PR #96 at **fa53ebbe139d4a18d3c33e3d23b740f776ec6c2e: P1 correction PASS**.
The combined #94 → #96 → #93 code is **READY TO MERGE** at the pinned heads below. **Isolated live execution remains BLOCKED** pending the operator evidence/approvals in this checklist. No runtime P2 correction is implemented by this draft test PR.

## Exact scope and verification

- Base `launch/hardening`: `c98ea69026a0f30b8f463f48000a4fa7e0e1ddaa`.
- #94 `8701b360a6845c611e23b06f567721ad5a686d8d`.
- #96 `fa53ebbe139d4a18d3c33e3d23b740f776ec6c2e`.
- #93 `7d1aa801ef1adc07c3db8875c62ddae6686d2e27`.
- Local combined commit `2c8aca3e6493e123bc73aab1509f5499348a9d8e`, tree `cb9cfd12718210ff9ac866cdd6b8e7bbe26045d7`. The requested order merges without conflict. Production code is unmodified in the review worktrees.

Claude moved the paid-kind global liability lock before the clock read and all lifetime/ownership checks. Lock acquisition order is still authorization → queue → task → lineage → global advisory lock. Reconciliation takes authorization → global; initial authorization takes queue → global. No new reverse order was introduced. Reads continue without the global paid lock. Existing-authorization replay and new-purchase liability checks remain serialized.

**The original independent reproduction is unchanged**, SHA256 `f3adeeb37079058e43ed88e61ed99d56d5f9f3d315d6c687de6efb971b777c45`. Both final-template requests refuse with `lost_ownership`, zero physical sends and zero operation rows. The fixed implementation passes 74 native admission/runtime checks, 15 independent ownership/concurrency controls, 17 queue/generation/fenced-write controls, and 34 focused smoke unit checks. Worker/run-agent type checks pass. No observed deadlock or timeout regression; bounded tests cannot establish absence of every possible database deadlock.

Main CI and database CI both completed/success on the exact corrected #96 head: runs 39027403051 and 39027403004. Existing #94/#93 heads were previously green; recheck them if they change. A full 8,669-test edge suite and mutation suite were not repeated locally against the SQL-only production change. The exact-head CI covers the repository's full suites/mutations.

Real local compiler/worker/handler/admission/PostgREST missions on the combined tree:

| Measurement | Normal | Initially RUNNING job search |
|---|---:|---:|
| Qualified / persisted / retrieved lead | 1 / 1 / 1 | 1 / 1 / 1 |
| Model attempts | 4 | 4 |
| Provider purchases | 2 | 2 |
| Reads | 3 jobs + 2 details | 3 jobs + 2 details |
| Model commitments | 49,920 µ$ | 49,920 µ$ |
| Provider commitments | 10,000 µ$ | 10,000 µ$ |
| Total commitments | 59,920 µ$ | 59,920 µ$ |
| Local duration | 10,978 ms | 403 ms |

The company-details price, all responses and usage are synthetic. Durations are local fake-vendor measurements, not predictions of live provider timing. The compiler preflight is simulated offline before authorization; every one of the 11 mission requests is admitted. Canonical hiring, industry, geography and company-size checks all pass on the saved lead. The planner is 29,417 bytes, leaving 1,303 bytes; the other model bodies are 11,099 / 16,046 / 4,810 bytes. Dashboard verification is a real service-role/PostgREST result query, not a frontend/RLS browser test.

## Confirmed remaining findings and limits

These are P2 or operator-readiness limitations; none reproduces the corrected P1 or exceeds the smoke's durable dollar ceiling.

1. **Telemetry undercounts cache writes.** Both `prompt_tokens_details.cache_write_tokens` and `input_tokens_details.cache_write_tokens` are ignored. 12,000 written tokens plus 400 output should cost $0.003480, while current telemetry estimates $0.002880. Cache hits are correctly a subset of total input. Smallest safe correction: carry a nonnegative optional cache-write token count through usage/telemetry; add the verified per-model write rate (Luna $0.25/M); price ordinary input as total minus cached reads minus writes, with both subsets clamped so their sum cannot exceed input. Keep old behavior when writes are absent/zero and return unknown for unsupported billed categories/rates. Preserve provenance and retain writes in telemetry metadata if no new column is needed. Add mixed-hit/write, malformed-count and unknown-rate controls before shipping that correction. **Do not edit the authorization catalog, reservation amounts or spending limits.** [Official cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching).
2. **Unknown Apify read counts can buy an unusable run.** A deterministic failure of only the count query leaves all other real RPCs working. The real gate sends one job start and commits 5,000 µ$; its subsequent status-read plan refuses `read_state_unknown`. This is not merely the older non-awaitable fake adapter: a real count-query error follows the same path. If the outage persists, the tool cannot reach the dataset. Smallest safe correction: refuse a *new* start when read availability is unknown, after the prior-purchase lookup so an uncertain replay stays uncertain. Keep the committed liability on already admitted requests and never refund on count-read failure.
3. **No-Brain is currently an operator requirement, not an authorization invariant.** Inserting a small real `company_brain` row does not prevent `authorize_discovery_smoke` from authorizing the reviewed catalog. A large Brain cannot bypass the 30,720-byte bound: the independent planner control constructs a 33,266-byte request, and the limiter refuses it before admission/transport. This draft adds a read-only preflight that raises when a Brain exists. It must be explicitly used by the operator; it is not automatically wired into authorization and does not prevent a later Brain edit. Keep this isolated workspace unmodified between preflight and mission completion, or add a separately reviewed durable guard before broader use.
4. **Discovery fallback loses provenance.** A job-search employer description with `enriched:null` is emitted as `company_description`, source `linkedin`, `verification_state:verified` solely because identity resolves; the registry omits its actual `harvestapi/linkedin-job-search` origin and has no description-level from-company-record marker. The strict regression asks for `reported` fallback provenance. This confirms the metadata behavior, **not a fabricated fact or a demonstrated falsely qualified lead**. The previous empty-details/wrong-company/weak-description worker controls saved no qualified lead. A correction should preserve actor/field origin and avoid promoting discovery fallback to an authoritative record, without relaxing quote, identity, size, recency or qualification rules. Do not infer that every embedded company description is false.

`riskControls.ts` deliberately asserts required-safe behavior and remains red for these unresolved P2s. A red explicit risk suite is never a green acceptance result.

## Operator checklist — nothing below has been executed against a hosted system

All unchecked account/project facts require **operator access**. Creating/configuring a project, installing hosted schema, activating a workflow or executing a paid mission additionally needs **explicit approval**. No approval is implied by merge readiness.

### Isolated Supabase and schema

- [ ] Operator records an existing or separately approved new empty non-production project ref; rejects production `ohsdatpvfdjdemstoiuj` and retired `wqnigjhcwjxtmordrwno`. No production data, GitHub auto-deploy integration or hosted credentials enter local tests.
- [ ] Enable/verify `pg_cron` and `pg_net` in the test project, with operator approval. Use the reviewed `scripts/test-project/build-test-schema.sh --confirm <ref> --with-held-billing-fix --with-held-admission` only after explicit hosted-write approval; it refuses an existing non-empty schema.
- [ ] Apply in dependency order: held baseline `20260816120000_baseline_schema.sql`; every shipped `supabase/migrations/*.sql` in lexical order; held queue chain `20260910140000_lead_mission_v2_claim.sql`, `20260915120000_sweep_skips_v2_queue_tasks.sql`, `20261003120000_lead_mission_v2_continuations_not_retries.sql`, `20261011120000_lead_mission_v2_productive_continuation_no_backoff.sql`; held billing `20261015130000_credits_rearm_settled_key.sql`; **corrected** held admission `20261015140000_discovery_smoke_admission.sql` from the verified SHA.
- [ ] Each migration scheduling HTTP cron is committed in the same transaction as `scripts/local-supabase/01-local-cron-detach.sql`. Verify only the two in-database jobs remain. A schedule calling production must never be briefly committed.
- [ ] If an older admission file was already installed, its timestamp does **not** install this correction automatically. Do not reapply a CREATE-table migration blindly. Require a separately reviewed forward upgrade or rebuild plan and exact deployed function identity.
- [ ] Verify RLS and grants: worker can select/admit/record/stop, cannot authorize/reconcile/insert/update/delete smoke audit rows. Confirm runtime schema compatibility and all five smoke RPCs.
- [ ] One internal workspace, no Company Brain row, existing Scout agent and reviewed plan, approved test-credit grant. No user/automation edits until the smoke finishes.
- [ ] Run read-only `scripts/test-project/discovery-smoke-preflight.sql` with the exact test workspace and `ON_ERROR_STOP`; archive its result. It asserts workspace existence, no Brain, no open/over-quote provider liability, administrative privilege separation and no hosted-calling cron. It does not prove the selected project's identity, vendor facts or future immutability.

### Credentials, permissions and build

- [ ] GitHub `discovery-test` Environment has an authorized required reviewer; organization/repository policy actually enforces that reviewer and restricts allowed deployment branches to the reviewed target. Do not assume that UI settings/features exist on the account's plan.
- [ ] Vars: `TEST_PROJECT_REF`, one `TEST_WORKSPACE_ID`. Secrets: `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_ANON_KEY`, `TEST_APIFY_API_TOKEN`, `TEST_OPENAI_API_KEY`. Verify all belong to the test accounts. Never paste keys into a PR, log or kickoff body.
- [ ] No Firecrawl, Anthropic or Lovable credential is passed to the worker. Retain `contents:read`, the single-worker concurrency group, project/ref rejection checks and private worker log handling. Admission enforced, wall clock enforced, minimal orchestration explicit, strategist OpenAI; per-slice 150 seconds, original 300-second deadline, at most one continuation.
- [ ] Build/release uses the reviewed combined commit. Activating the currently inactive workflow proposal is a separate reviewed/approved action; do not move it into `.github/workflows` as part of this test PR.

### Vendor evidence, account limits and pricing

- [ ] Apify test token may run **both** `harvestapi/linkedin-job-search` and `harvestapi/linkedin-company`. Capture account tier, actor/build/input schema, billing events and prices, and minimum account usage limit. Set the account control only with operator approval.
- [ ] Capture evidence that `maxTotalChargeUsd` caps the total charge for both selected actors on this account. The software pins it correctly; that is not account-specific enforcement proof. Any paid verification of vendor behavior requires separate execution approval.
- [ ] Jobs are one title × one location × at most three rows; company details one URL, `searches:0`. Company-details maximum remains null until evidenced; never substitute the offline synthetic 5,000 µ$ price for a real quote.
- [ ] Dedicated OpenAI test project/key, model access to literal `gpt-5.6-luna`, Standard rates including cache-write, output, regional/service-tier uplifts, taxes/credits if relevant. Evidence observed within 24 hours of authorization. No Terra template or fallback permission.
- [ ] Verify an actual **enforced hard spend limit**, not just a spend alert. Current official [spend-limit guidance](https://developers.openai.com/api/docs/guides/spend-limits) distinguishes these and says enforcement can lag. Record the project/organization setting and operator evidence; do not spend money to demonstrate exhaustion. The application admission ceiling remains necessary.
- [ ] Keep B=30,720, O≤4,000 and 12,480 µ$ reservation only if verified rates support it: 0.25×30,720 + 1.20×4,000 = 12,480; four = 49,920≤50,000. If account pricing does not fit, stop; do not increase a limit.

### Exact kickoff and authorization

- [ ] Review/export the fake-compiled kickoff and matching plan/agent/workspace references offline. Mission: one US B2B software company, declared 11–50 band, an open AE posting within 30 days; no resume fields; provider budget $0.20, at most three candidates. Public fixture identities are not live facts.
- [ ] Record exact SHA/build, body, queue UUID, pricing version, approved quotes/limits, operator and stop owner. Every quote source and timestamp is fresh (≤24 hours), company price numeric, actor limits one each, reads 3+2, four model attempts, five reads, total $0.25/model $0.05 unchanged.
- [ ] Obtain separate execution approval. Immediately recheck no Brain/open liability, then in **one reviewed administrator transaction** insert plan and final queue body and call `authorize_discovery_smoke(...,300)`. The request hash is SHA256 of PostgreSQL `request::text`; do not hash a differently formatted raw JSON file and assume equality. Never edit or renew the authorized body/deadline.
- [ ] Start/dispatch only the approved test worker. Record admissions, all attempted/sent operations, provider run IDs, receipts, canonical evidence/decisions and result retrieval. Zero qualified leads is a valid live outcome; do not buy more to force a success.

### Emergency stop and reconciliation

- [ ] Administrator ready with `stop_discovery_smoke(queue_id,'operator')`; then `cancel_lead_mission(queue_id,workspace_id)`. Drain/cancel the Actions worker and remove its workspace allowlist. Never assume stopping the worker aborts a vendor run.
- [ ] Operator can abort RUNNING Apify runs in the test account and revoke/rotate test keys if needed. Already sent requests remain liabilities; cancellation is not proof of zero charge.
- [ ] After stop or expiry, obtain terminal vendor history and final charges (Apify settlement delay accounted for); run `smoke-reconciliation.sql`. Worker receipt labels do not close liability.
- [ ] Administrator only calls `reconcile_discovery_smoke_operation(queue_id,key,vendor_microusd,reference,terminal_status)`. Same trimmed reference/status/amount replays idempotently; contradictory reconciliation refuses. `NO_RUN` requires no stored run ID and vendor-confirmed zero charge.
- [ ] Over-quote figures remain held and block every later smoke, including previously authorized missions. Do not lower/delete audit rows, auto-refund uncertain purchases, or claim a credit reaper settled vendor liability. Explain every outstanding reservation and reconcile actual model usage against the vendor invoice; current cache-write estimates are insufficient evidence.
- [ ] Archive evidence and confirm zero open liabilities before another authorization; cleanup/credential rotation or hosted rollback requires its own operator plan/approval. Do not run a rollback guarded against existing audit rows.
