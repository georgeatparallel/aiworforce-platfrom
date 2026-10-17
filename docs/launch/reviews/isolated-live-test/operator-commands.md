# Operator commands — NOT EXECUTED

Every hosted command below is **NOT EXECUTED**. These are staged procedures, not permission to run them. Stop at every unmet prerequisite in README.md. Never use production/retired credentials, linked CLI defaults, or production deployment scripts. Use an administrator terminal with shell tracing/history disabled for credentials; source a protected local secret file or secure prompt, never paste secrets into this document. Run from a clean checkout of the final reviewed SHA.

## 1. Read-only GitHub inspection; production stop prerequisite

```bash
# NOT EXECUTED operator procedure. This metadata inspection was independently
# performed during review; repeat it before activation.
gh api repos/kathmanducreatives-code/aiworforce-platfrom/actions/workflows/deploy-held-back-functions.yml --jq '{path,state}'
gh api repos/kathmanducreatives-code/aiworforce-platfrom/environments/discovery-test --jq '{name,protection_rules,deployment_branch_policy}'
```

Operator must separately disable the production workflow using GitHub's workflow UI and repeat the first query until `disabled_manually`. No disable/enable/deploy command is bundled here. Create the approved new Supabase project and protected GitHub Environment manually; inspect branch protections and required reviewers in the UI. Do not treat 404 as proof of an enforced approval gate.

## 2. Fresh schema installation — HOSTED WRITE, separate approval required

After approval, obtain TEST_DB_URL directly from the new project's Connect panel. Set TEST_PROJECT_REF, TEST_DB_URL and TEST_WORKSPACE_ID securely. The guard below parses endpoint identity independently of the installer's substring check; it intentionally supports only standard Supabase direct/pooler forms. An unrecognized form needs manual review, not removal of the guard.

```bash
# NOT EXECUTED. TEST_DB_URL is secret; do not echo it or enable set -x.
: "${TEST_PROJECT_REF:?operator must set the approved NEW project ref}"
: "${TEST_DB_URL:?operator must securely set the approved NEW database URL}"
export TEST_PROJECT_REF TEST_DB_URL
python3 - <<'PY'
import os,re,urllib.parse
ref=os.environ['TEST_PROJECT_REF']; u=urllib.parse.urlsplit(os.environ['TEST_DB_URL'])
assert re.fullmatch(r'[a-z]{20}',ref), 'unexpected project-ref shape; review manually'
assert ref not in {'ohsdatpvfdjdemstoiuj','wqnigjhcwjxtmordrwno'}, 'refused project'
assert u.scheme in {'postgres','postgresql'} and u.path=='/postgres', 'unexpected database URL'
host=u.hostname or ''; user=urllib.parse.unquote(u.username or '')
direct=host==f'db.{ref}.supabase.co' and user=='postgres'
pooler=host.endswith('.pooler.supabase.com') and user==f'postgres.{ref}'
assert direct or pooler, 'URL does not independently identify approved project'
assert urllib.parse.parse_qs(u.query).get('sslmode') in (['require'],['verify-full']), 'TLS required'
print('endpoint guard passed; operator must also confirm project ownership in Supabase UI')
PY
# Enable pg_cron and pg_net in the approved TEST project UI first.
bash scripts/test-project/build-test-schema.sh --confirm "$TEST_PROJECT_REF" \
  --with-held-billing-fix --with-held-admission
```

No platform shim, `supabase db push`, generic migration glob or production rollback command belongs in this procedure. If installation fails, stop and review the partially installed test schema; do not bypass the empty-schema refusal.

## 3. Internal test workspace and read-only checks

Create the Auth test user and workspace through the supported test-project flow. Record membership, Scout agent, user ID, workspace ID and one fresh plan ID. Keep all users/automations except the operator out. Do not import fixtures into hosted auth.users. Use the existing credits function after its small grant is approved:

```bash
# NOT EXECUTED. Read its exact deployed signature before any grant.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
select oid::regprocedure from pg_proc where proname='credits_grant';
select jobname,command from cron.job order by jobname;
select c.relname,c.relrowsecurity,
       has_table_privilege('service_role',c.oid,'insert') as worker_insert,
       has_table_privilege('service_role',c.oid,'update') as worker_update
from pg_class c where c.relname in
 ('discovery_smoke_authorizations','discovery_smoke_operations','discovery_smoke_reconciliations');
select pg_get_functiondef(oid) from pg_proc where proname='admit_discovery_smoke';
SQL
# NOT EXECUTED: approved test-credit grant, idempotent for this unique key.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v workspace_id="$TEST_WORKSPACE_ID" <<'SQL'
select public.credits_grant(:'workspace_id'::uuid,10,
 'discovery-isolated-smoke-initial-credit-grant','approved isolated test credits');
SQL
# NOT EXECUTED: no authorization, no paid request, errors abort.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v workspace_id="$TEST_WORKSPACE_ID" \
  -f scripts/test-project/discovery-smoke-preflight.sql
```

Expect only the two local cron jobs, all three RLS flags true and insert/update false. Compare deployed admission function with the pinned file, including global lock before `clock_timestamp()` and ownership checks after the wait. Do not merely look for the migration filename. The read-only guard is copied unchanged from draft #97 and locally tested. Passing does not freeze future Brain edits.

## 4. Finalize the offline request and plan

Copy `kickoff.template.json` to a private review artifact, replace all explicit placeholders with the approved new test IDs/build metadata, and keep both mission copies identical. `plan.template.json` describes the matching row. Run `validateV2KickoffBody` and the final no-Brain fake-provider rehearsal on the exact final code/body. Do not call a real model to compile it. Review goal, fields, request sizes and hash before execution approval. Save `reviewed-kickoff.json` and an approved `reviewed-catalog.json` containing **only the approved_quotes object**, not the entire proposed catalog. All quotes require numeric maxima/fresh evidence; the proposed details null cannot authorize.

```bash
# NOT EXECUTED. Local file review only, no network.
python3 - <<'PY'
import json,pathlib
r=json.loads(pathlib.Path('reviewed-kickoff.json').read_text())
q=json.loads(pathlib.Path('reviewed-catalog.json').read_text())
assert '<' not in json.dumps(r), 'unresolved kickoff placeholders'
assert r['lead_mission']==r['tool_input']['lead_mission']
assert r['run_budget']=={'provider_usd':0.2,'max_candidates':3}
assert r['requested_lead_count']==1 and r['lead_mission']['requested_count']==1
assert set(q)=={'jobs','details','reads','luna'}
assert isinstance(q['details']['maximum_microusd'],int)
assert q['luna']['maximum_microusd']==12480
assert q['luna']['request_limits']=={'max_request_bytes':30720,'max_output_tokens':4000}
print('local shape checks passed; final worker validator, quote review and execution approval still required')
PY
```

The reviewed template cannot know the future account IDs, quote, queue or release SHA. Do not label it ready-to-send before these steps. The JSON file's byte hash is not the database's criteria hash.

## 5. Approved execution — MAY SPEND, NOT EXECUTED

Only after every blocker is closed and explicit execution approval: activate the reviewed workflow through its own approved PR, then dispatch its **final approved filename** from the reviewed branch/ref. Do not dispatch the production workflow. Approve the `discovery-test` Environment job while queue is empty; confirm worker readiness/identity. No automatic second run. Do not queue before a GitHub approval wait.

In the administrator terminal, rerun endpoint guard and preflight. Verify TEST_WORKSPACE_ID, QUEUE_ID, PRICING_VERSION and file contents against the signed approval. Freeze all other workspace writers. This transaction creates the matching minimal plan and final queue body, asserts no Brain before authorization, and records the immutable DB hash. It is prepared only; it has **NOT** been executed against a hosted database.

```bash
# NOT EXECUTED — HOSTED WRITE / AUTHORIZATION / MAY SPEND after commit.
: "${QUEUE_ID:?approved fresh queue UUID required}"
: "${PRICING_VERSION:?approved immutable pricing evidence version required}"
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 \
  -v workspace_id="$TEST_WORKSPACE_ID" -v queue_id="$QUEUE_ID" \
  -v pricing_version="$PRICING_VERSION" \
  -v kickoff_json="$(cat reviewed-kickoff.json)" \
  -v quotes_json="$(cat reviewed-catalog.json)" <<'SQL'
begin;
set local lock_timeout='5s';
-- Guard concurrent Brain writes during this transaction. Other writers remain
-- disabled through the entire mission by the operator's isolated-access setup.
lock table public.company_brain in share mode;
select set_config('agentory.preflight_workspace',:'workspace_id',true);
do $$ begin
 if not exists(select 1 from public.workspaces where id=current_setting('agentory.preflight_workspace')::uuid) then
   raise exception 'unknown workspace'; end if;
 if exists(select 1 from public.company_brain where workspace_id=current_setting('agentory.preflight_workspace')::uuid) then
   raise exception 'Company Brain must be absent'; end if;
end $$;
create temporary table reviewed_kickoff on commit drop as select :'kickoff_json'::jsonb as body;
select set_config('agentory.reviewed_workspace_matches',
 ((select body->>'workspace_id' from reviewed_kickoff)=:'workspace_id')::text,true);
do $$ begin
 if current_setting('agentory.reviewed_workspace_matches') is distinct from 'true' then
   raise exception 'kickoff workspace mismatch'; end if;
end $$;
insert into public.task_plans(id,workspace_id,user_id,user_instruction,status)
 select (body->>'plan_id')::uuid,(body->>'workspace_id')::uuid,
        (body->>'user_id')::uuid,body->>'instruction','running' from reviewed_kickoff;
insert into public.lead_mission_queue(id,workspace_id,request,status)
 select :'queue_id'::uuid,:'workspace_id'::uuid,body,'queued' from reviewed_kickoff;
-- This admin RPC independently refuses every unresolved/over-quote purchase.
select public.authorize_discovery_smoke(:'queue_id'::uuid,:'pricing_version',:'quotes_json'::jsonb,
 '{"apify:harvestapi~linkedin-job-search":1,"apify:harvestapi~linkedin-company":1}'::jsonb,300);
select id,queue_id,criteria_hash,deadline_at from public.discovery_smoke_authorizations
 where queue_id=:'queue_id'::uuid;
commit;
SQL
```

This intentionally refuses an existing plan/queue UUID and never updates an authorization. No resume field, criteria edit, renewal, raised cap or automatic retry is allowed. Retain the plan insert and finalized request in approval records. The plan shape is the same minimum row used in the offline rehearsal; the existing test Scout must already belong to this workspace. Use the test project's result retrieval path, not the production frontend defaults.

## 6. Emergency stop and reconciliation

```bash
# NOT EXECUTED — administrative test-project writes, only if stop is required.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 \
 -v queue_id="$QUEUE_ID" -v workspace_id="$TEST_WORKSPACE_ID" <<'SQL'
select public.stop_discovery_smoke(:'queue_id'::uuid,'operator stop');
select * from public.cancel_lead_mission(:'queue_id'::uuid,:'workspace_id'::uuid);
SQL
# NOT EXECUTED — read-only report; empty result required before another smoke.
psql "$TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v queue_id="$QUEUE_ID" \
 -f scripts/test-project/smoke-reconciliation.sql
```

Also cancel/drain running and queued test Actions runs; disable the workspace allowlist. Test-account operator must abort still-running Apify runs if needed. A workflow cancellation does not abort vendor runs or remove liability. Final account history/charge evidence is required even for cancelled/uncertain operations; wait for settlement. Administrator reconciliation syntax is documented in the existing report script. Supply the verified operation key, exact integer vendor micro-USD, durable evidence reference and terminal status; do not invent them or mark zero just because no response arrived. Over-quote remains held. Reconcile OpenAI actual billing separately; telemetry is not an invoice. Preserve the complete audit and obtain new approval before any later mission.
