# First isolated Discovery test — operator handoff

**Live execution remains BLOCKED. No hosted setup or paid call has been performed.**
This handoff supersedes the manual-only no-Brain workaround in the earlier
report. Mission and limits are unchanged. All setup commands remain **NOT
EXECUTED** against hosted systems.

## Code prepared for review

- **#100**: unknown Apify read capacity now refuses a new actor start before
  admission/transport. A count outage on uncertain replay keeps the earlier
  purchase/credit held. A delayed failed count can outlive a prior=no lookup while another attempt purchases the same run: the unknown-state refusal is therefore conservatively uncertain (503), preserving even that concurrent credit hold. Zero sends/admissions remain guaranteed for failed-count attempts. A new failed-count attempt may also leave a credit reserved; resolve it only from evidence, never infer zero liability from a failed query. Five reads and 3+2 allocation unchanged.
- **#101**: optional SQL guard for a *new dedicated smoke project*, installed
  before any workspace. Every Company Brain INSERT/UPDATE is rejected; the
  authorization path requires the ALWAYS-enabled guard and an empty Brain.
  This holds across concurrent writes, old repeatable-read snapshots and
  cancellation/expiry. The worker cannot disable it. Owner DDL bypass remains
  outside the worker boundary. Never apply this guard to customer/production
  projects. SQL lives outside both migration directories and is opt-in only.
- **#98**: this operator pack, request/plan templates, read-only workspace
  preflight and measured evidence. These are draft review artifacts, not an
  execution approval. Review/merge and exact final release selection remain
  operator/integration work; this task merges nothing.

Exact draft heads: **#100 `554eadc94724dda559d5f0fb1f991c3ccff1f406`**; **#101 `87dcf34d1833f641d226516ba5c7acfe6b3b07b8`**.

Implementation SHAs, focused results and current CI snapshots are recorded in
`blocker-fix-evidence.json`. Final integration must include the approved fixes
and corrected lease-fencing SQL and have completed successful exact-SHA checks.
Local tests used `a4eb3209`. The latest remote target is now `cb2121d556b169294740e2bc0bb83fcc706bb5a7`: #99 merged, changing only the database CI timeout (30 → 45 minutes); worker/schema/installer/admission files are identical. #93 remains open at 7d1aa801ef1adc07c3db8875c62ddae6686d2e27. Pending/cancelled CI is not a pass.

## Configure these accounts, in this order

| System | Operator configuration | Evidence required before authorization |
|---|---|---|
| **GitHub production** | Disable the manual production-deploy workflow. It still reports `active`; manual-only is not disabled. | Metadata showing `disabled_manually`; do not dispatch or enable it. |
| **Supabase** | Approve/create one NEW empty dedicated test project. No production data, keys, vault entries or deployment integrations. Enable pg_cron/pg_net; restrict Auth signup and use only test Site URL/redirects. Install schema plus test-only no-Brain guard before seeding one internal Auth user/workspace/membership/Scout and approved test credits. | Independently checked project ref and direct/pooler hostname+username; managed extension/role compatibility; exact deployed function/guard identity; zero HTTP cron, RLS/grant checks, guard verifier and workspace preflight pass; queue otherwise empty. Do not use the production frontend defaults. |
| **Apify** | Test-only token/account; permission to execute BOTH `harvestapi/linkedin-job-search` and `harvestapi/linkedin-company`; practical minimum account usage limit approved by owner. | Fresh actor/build/input schema, pricing tier and per-start/per-job/per-company fees; permission; `maxTotalChargeUsd` total-charge cap applicability, precision/minimum-event behavior for BOTH actors; free-read assumption; numeric company-details maximum. Public pages do not verify account behavior. |
| **OpenAI** | Dedicated test project/key with literal `gpt-5.6-luna` access; approved Standard service tier and actual enforced hard budget, not just alerts. | Account rates including cache writes and output, applicable uplifts, model access and hard-budget configuration; allow for provider enforcement lag. No alternate model/paid compilation outside authorization. |
| **GitHub test execution** | Create `discovery-test` Environment with enforced required reviewer, restricted reviewed refs and test-only secrets. Its lookup currently returns 404, so protection is unverified. Activate the worker proposal through a separate reviewed/approved PR on default branch `launch/hardening`; keep manual-only trigger, one concurrency group and bounded session. | Reviewer gate actually enforced, exact checked-out SHA and successful CI, environment settings/secret ownership confirmed, workflow origin guards and all smoke flags intact. No Firecrawl/Anthropic/Lovable credentials. |

Environment variables: `TEST_PROJECT_REF`, exactly one `TEST_WORKSPACE_ID`.
Environment secrets: `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`,
`TEST_SUPABASE_ANON_KEY`, `TEST_APIFY_API_TOKEN`, `TEST_OPENAI_API_KEY`.
Never paste values into a PR, kickoff, shell trace or public Actions log.

**Fresh-project seeding caveat:** normal `provision_workspace_for_user` inserts a Brain and must not be used here; `seed_agents_for_workspace` returns zero without an existing template workspace. Create the Auth user in the test Supabase admin UI only, then use the explicit administrator workspace/membership/Scout seed in `operator-commands.md`. That command is locally tested (one membership, one Scout, zero Brain); authenticated member access succeeds and a stranger sees zero workspaces. It has not run hosted. Do not disable the Brain guard to make onboarding work.

No Railway or hosted edge-function deployment is needed: the ephemeral worker
imports run-agent in process. Approve any project/Actions costs separately.

## Setup commands — NOT EXECUTED

Requires the reviewed code from #100/#101/#98. Use the endpoint-parsing guard
and secure secret handling in `operator-commands.md` first; the installer's
substring match alone does not establish project identity.

```bash
# NOT EXECUTED — fresh hosted TEST schema writes require separate approval.
bash scripts/test-project/build-test-schema.sh --confirm "$TEST_PROJECT_REF" \
  --with-held-billing-fix --with-held-admission --with-test-no-brain-guard
# NOT EXECUTED — read-only checks on the independently confirmed test project.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f scripts/test-project/verify-no-brain-guard.sql
# Create Auth user in the TEST admin UI, then use the reviewed administrator
# workspace/membership/Scout seed (normal onboarding creates a Brain). Approve
# the existing test-credit grant, then run the workspace read-only check.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v workspace_id="$TEST_WORKSPACE_ID" \
  -f scripts/test-project/discovery-smoke-preflight.sql
```

Order: held baseline → 43 shipped migrations lexically → four held V2 queue
files → held billing → **corrected** held admission → test-only no-Brain guard.
Two local builds applied all **51** files successfully. Scheduling migrations
and HTTP-cron detachment use the same transaction: production-calling jobs
never commit. Only `sweep-stuck-runs` and `release-stale-credit-reservations`
remain. The local shim records cron and cannot execute HTTP; real managed
Supabase compatibility still needs operator verification. Both fresh builds
retained RLS and admin-only authorization/reconciliation. Repeating installation
on the same populated database refuses before writes; it is not an upgrade path.

## Exact paid-execution gate

Separate approvals are needed for (1) infrastructure/account configuration,
(2) hosted installation/test credits, (3) workflow activation/credentials, and
(4) **one paid mission**. None is implied by these draft PRs.

Before the last approval, archive:

1. Final code SHA/artifact identity and successful exact-SHA CI, installed SQL
   identity including lease lock before clock, and enforced workflow reviewer.
2. New project/workspace/user/Scout/plan IDs; passing mandatory Brain-guard
   verification and workspace preflight; **zero unreconciled or over-quote
   provider liabilities across all missions**; no unrelated queued work.
3. Pricing evidence observed within 24 hours, immutable pricing version,
   numeric `approved_quotes` and actor limits one start each. The proposed
   catalog's null company-details price and fake $0.005 price are not live quotes.
4. Final kickoff and matching plan, validated offline with fake providers on
   the final code; exact PostgreSQL `sha256(request::text)` hash, new queue UUID,
   original 300-second lifetime and named operator/stop/reconciliation owners.
5. Explicit approval for bounded vendor liability: application **$0.25 total**,
   **$0.20 provider/$0.05 model**, **four model attempts**, **five reads (3+2)**,
   one discovery page, one start per selected actor, one controlled worker run.
   Model requests ≤30,720 bytes and ≤4,000 output tokens; approved reservation
   12,480 micro-USD each, four=49,920. Public Standard assumptions are
   $0.20/M ordinary input, $0.02/M cached reads, $0.25/M writes, $1.20/M output;
   account/service-tier facts must fit without raising any limit.
6. Stop access, test-account actor abort access, terminal-billing access and
   administrator reconciliation readiness. Preserve raw model usage because
   current cache-write telemetry undercounts.

Approve/start the **idle** test worker while queue is empty, confirm its target
and exact build, then atomically insert the reviewed plan+queue and authorize
using the prepared administrator transaction in `operator-commands.md`.
Do not consume the 300-second lifetime waiting for an Environment approval.
Never edit/renew an authorized request or automatically dispatch another run.

## Mission, acceptance and stop

Goal: **Find 1 US B2B software company with a current declared 11–50 employee
band and an open Account Executive posting dated within 30 days.**

Jobs input is one `Account Executive` title, `United States` location,
`maxItems:3`, `postedLimit:"month"`, `sortBy:"date"`. Company details uses one
resolved employer LinkedIn URL in `companies`; **searches:0**. No Company Brain,
people/contact unlock, Firecrawl or Anthropic. Do not mistake job location for
company geography or member count for declared staff band.

Accept truthful qualification or an honest shortfall. **Zero qualified leads is
acceptable.** Missing/wrong/weak authoritative company evidence must not qualify.
Inspect saved evidence provenance manually until the separate beta fix ships.
Success requires admitted requests only, respected limits, truthful persistence
and test-project retrieval for any genuine match, plus complete billing audit;
no extra purchases or weaker qualification to force a lead.

On wrong target/credential/model, missing admission/guard, cancellation,
ownership loss, unexpected charge/over-quote or evidence integrity violation:
call `stop_discovery_smoke`, then `cancel_lead_mission`; cancel/drain running
and queued test workflow runs and remove allowlist. Abort still-running actors
in the TEST account as necessary. Worker stop does not stop vendor billing.
Run `smoke-reconciliation.sql`, obtain terminal vendor charges and reconcile
administratively. The report exits zero even with liabilities: inspect rows.
Uncertain/cancelled/deferred/over-quote purchases remain held; never clear them
by refund, deletion or an invented zero receipt. Reconcile model billing too.
No new authorization until every liability is closed; over-quote remains blocked.

## Before private beta — separate P2 corrections

- **Cache writes:** extend `ModelUsage`/telemetry to preserve both API detail
  shapes' write counts. For models with verified write rates, price ordinary
  input as total minus cache reads minus writes; clamp disjoint subsets and
  return unknown for unsupported billed categories/rates. Carry counts through
  telemetry and the existing ledger metadata; avoid a schema migration if that
  metadata suffices. Add pure/mixed cache, malformed subset and unknown-rate
  controls. Confirmed example: 12,000 writes + 400 output should be $0.003480,
  currently $0.002880. **Do not change the smoke catalog/reservations/limits.**
- **Discovery provenance:** carry per-field origin and a description-from-
  authoritative-company-record flag through `buildCompanyEvidence` and
  `buildEvidenceRegistry`. Discovery-row fallback stays reported, with its
  actual actor origin; resolved identity alone cannot promote it to verified
  company details. When qualification requires a company record, consumers must check this origin marker before accepting a fallback. Preserve hard evidence/qualification rules and existing
  negative worker controls. The metadata defect is confirmed; no falsely
  qualified lead has been reproduced. Fix before beta, not broad rollout.

These improvements are not included in #100/#101. Test-only hard-denial of all
Brains is not a general beta workspace policy; customer-aware Brain handling
and size enforcement remain separately reviewed work.
