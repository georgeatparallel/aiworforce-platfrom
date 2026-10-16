// The offline smoke rehearsal carried past the execution planner. Derived from
// Codex's independent harness (PR #95, tests/db-contract/offlineSmokeMission
// .contract.test.ts at 2f48cb0f): actual compiler, worker, handler, SQL
// admission and PostgREST; only vendor responses and Supabase's gateway path
// are substituted. Three changes, each matching the runbook rather than the
// harness: the mission is compiled OFFLINE before authorization (Phase 4) and
// the authorization is over the FINAL kickoff body (Phase 5; the request may
// not change after it); and the fixture row's `postedDate` (the field the
// normalizer reads) is inside the 30-day window. It asserts the limits and
// records where the mission stops today, and must be extended when that moves.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mintJwt, REST_URL, sql, uuid } from "./lib/harness.ts";
import { seedSmokeMission } from "./lib/smokeMission.ts";
import {
  createAdmissionFetch,
  missionAdmission,
} from "../../supabase/functions/_shared/smokeAdmission.ts";
import { createLeadMissionRunner } from "../../worker/leadMissionRunner.ts";
import { createExecutionDeadline } from "../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { buildMissionCompilerBinding } from "../../supabase/functions/_shared/leadMissionCompilerBinding.ts";
import { compileLeadMission } from "../../supabase/functions/_shared/leadMissionCompiler.ts";
import {
  LEAD_INTELLIGENCE_CONTRACT_VERSION,
  runtimeIdentity,
} from "../../supabase/functions/_shared/leadRuntimeIdentity.ts";
import {
  createLedgerWriter,
  ModelCallCollector,
} from "../../supabase/functions/_shared/executionLedger.ts";
import { terminalStatusOf } from "../../supabase/functions/_shared/leadMissionV2Request.ts";

const MISSION =
  "Find 1 US B2B software company with a current declared 11–50 employee band and an open Account Executive posting dated within 30 days.";
const JOBS = "apify:harvestapi~linkedin-job-search";
const LUNA = "openai:gpt-5.6-luna";
const proposal = {
  requested_opportunity_count: 1,
  requested_contact_ready_count: null,
  company_types: ["B2B software"],
  geographies: ["United States"],
  geography_is_hard: true,
  employee_range: { min: 11, max: 50 },
  decision_maker_roles: [],
  hard_constraints: [],
  soft_preferences: [],
  preferred_signals: ["hiring Account Executive"],
  required_signal_terms: ["Account Executive"],
  signal_recency_days: 30,
  adjacent_signals: [],
  excluded_signals: [],
  allowed_broadening: {
    role_families: [],
    company_types: [],
    geographies: [],
    employee_range: { min: null, max: null },
  },
  disallowed_broadening: ["geography", "role", "size"],
  required_evidence: [],
  required_capabilities: [
    "general_company_discovery",
    "embedded_hiring_evidence",
    "company_semantic_evaluation",
  ],
  preferred_source_strategy: [],
  evaluation_instructions:
    "All requirements must be verified; unknown is never match.",
  founder_unlock_recommended: false,
  confidence: 0.99,
  unknowns: [],
};
const jobInput = {
  jobTitles: ["Account Executive"],
  locations: ["United States"],
  maxItems: 3,
  postedLimit: "month",
  sortBy: "date",
};
const executionPlan = {
  reasoning:
    "One hiring-led discovery; employer identity and declared company band come from the posting. No paid enrichment or contact unlock.",
  steps: [
    {
      capability: "job_discovery",
      actor_key: "apify_linkedin_job_search",
      purpose: "find the specified open role",
      input: jobInput,
      depends_on: [],
    },
    {
      capability: "company_brain_qualification",
      actor_key: null,
      purpose: "verify every stated company requirement",
      input: {},
      depends_on: [1],
    },
    {
      capability: "persistence",
      actor_key: null,
      purpose: "persist evidence-backed results",
      input: {},
      depends_on: [2],
    },
  ],
};
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const DETAILS = "apify:harvestapi~linkedin-company";

// ── AN HONEST STAND-IN FOR THE MODEL ─────────────────────────────────────────
// Each stage gets the answer its schema asks for, built only from the evidence
// the request itself carries: every excerpt is copied verbatim from a supplied
// `source_text`, and a requirement with nothing citable is `review`, never a
// pass. Nothing here can qualify a company the evidence does not support.
type Ev = { evidence_id: string; evidence_type?: string; source_text?: string | null };
function evidenceIn(x: unknown, out: Ev[] = []): Ev[] {
  if (Array.isArray(x)) for (const y of x) evidenceIn(y, out);
  else if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.evidence_id === "string" && typeof o.source_text === "string") out.push(o as Ev);
    else for (const v of Object.values(o)) evidenceIn(v, out);
  }
  return out;
}
const cite = (ev: Ev[], test: (e: Ev) => boolean, phrase: string) => {
  const e = ev.find((x) => test(x) && (x.source_text ?? "").includes(phrase));
  return e ? { evidence_id: e.evidence_id, excerpt: phrase } : null;
};
function citations(ev: Ev[]) {
  return {
    business: cite(ev, (e) => e.evidence_type === "company_description", "sales software for revenue teams at mid-size companies"),
    location: cite(ev, (e) => /location|headquarter/.test(e.evidence_type ?? ""), "United States"),
    size: cite(ev, (e) => e.evidence_type === "company_size_band", "11-50 employees"),
    hiring: cite(ev, (e) => /job|posting|hiring/.test(e.evidence_type ?? ""), "Account Executive"),
  };
}
function evaluatorAnswer(input: unknown) {
  const c = citations(evidenceIn(input));
  const req: Array<[string, { evidence_id: string; excerpt: string } | null]> = [
    ["B2B software company", c.business], ["located in the United States", c.location],
    ["declared 11–50 employee band", c.size], ["open Account Executive posting within 30 days", c.hiring],
  ];
  const missing = req.filter(([, x]) => !x).map(([r]) => r);
  return {
    mission_fit: missing.length === 0 ? "pass" : "review", icp_fit: "plausible",
    hiring_fit: c.hiring ? "verified" : "absent", confidence: 0.8, match_score: missing.length === 0 ? 80 : 0,
    matched_requirements: req.filter(([, x]) => x).map(([requirement, x]) => ({ requirement, ...x!, support: "verified" })),
    failed_requirements: [], reasoning: missing.length ? `not established: ${missing.join("; ")}` : "every requirement cited",
    rejection_reasons: [], evidence_quality: missing.length ? "weak" : "moderate", unknown_fields: missing, next_action: null,
  };
}
function groundedResult(company_key: string, ev: Ev[]) {
  const c = citations(ev);
  const claim = (claim: string, claim_type: string, x: { evidence_id: string; excerpt: string }) =>
    ({ claim, claim_type, evidence_ids: [x.evidence_id], evidence_excerpts: [x] });
  const supporting = [
    ...(c.business ? [claim("builds sales software for revenue teams", "business_model", c.business)] : []),
    ...(c.hiring ? [claim("has an open Account Executive posting", "commercial_signal", c.hiring)] : []),
  ];
  return {
    company_key,
    business_model: { value: c.business ? "b2b_software" : "unknown", confidence: c.business ? 0.7 : 0,
      claims: c.business ? [supporting[0]] : [] },
    company_fit: c.business && c.hiring ? "pass" : "review", agentory_use_case: "plausible",
    mission_signal_assessment: { strongest_signal: c.hiring ? "Account Executive" : null,
      signal_strength: c.hiring ? "strong" : "none", evidence_ids: c.hiring ? [c.hiring.evidence_id] : [], reason: "cited" },
    supporting_claims: supporting, conflicting_evidence_ids: [], missing_evidence: [], unknown_fields: [],
    confidence: 0.7, reason: "from the supplied evidence only",
  };
}
function batchAnswer(input: { companies?: Array<{ company_key: string; evidence?: unknown }> }) {
  return { results: (input.companies ?? []).map((co) => groundedResult(co.company_key, evidenceIn(co.evidence))) };
}

interface Variant {
  /** LEAD_V2_SMOKE_ORCHESTRATION; absent = the customer orchestration. */
  orchestration?: "minimal";
  /** Add the company-details actor to the rehearsal catalog (NOT in the approved first-smoke profile). */
  companyDetails?: boolean;
  label: string;
}
// deno-lint-ignore no-explicit-any
type Rehearsal = Record<string, any>;

async function rehearse(v: Variant, check: (r: Rehearsal) => void | Promise<void>) {
  {
    const originalFetch = globalThis.fetch;
    const key = await mintJwt("service_role");
    const localFetch: typeof fetch = (u, i) => {
      const url = u instanceof Request ? u.url : String(u);
      assertEquals(
        new URL(url).origin,
        new URL(REST_URL).origin,
        "database transport must remain localhost",
      );
      return originalFetch(url.replace(`${REST_URL}/rest/v1`, REST_URL), i);
    };
    const client = createClient(REST_URL, key, {
      auth: { persistSession: false },
      global: { fetch: localFetch },
    });
    const env = {
      RUN_AGENT_IMPORT_ONLY: "1",
      SUPABASE_URL: REST_URL,
      SUPABASE_SERVICE_ROLE_KEY: key,
      SUPABASE_ANON_KEY: key,
      OPENAI_API_KEY: "fake-openai-no-network",
      APIFY_API_TOKEN: "fake-apify-no-network",
      DISCOVERY_SMOKE_ADMISSION: "enforce",
      LEAD_V2_SMOKE_WALL_CLOCK: "enforce",
      LEAD_STRATEGIST_PROVIDER: "openai",
      LEAD_CREDIT_ENFORCEMENT: "enforce",
      LINEAGE_LEASE_ENFORCED: "true",
      MODEL_SPEND_ENFORCEMENT: "enforce",
      MODEL_SPEND_CEILING_USD: "0.05",
      MODEL_SPEND_PERIOD_DAYS: "1",
      MODEL_RUN_MAX_CALLS: "2",
      LEAD_V2_MISSION_PROVIDER_USD_CAP: "0.20",
      LEAD_V2_MISSION_CREDIT_CAP: "5",
      LEAD_WORKER_MAX_RUNTIME_MS: "150000",
      LEAD_MAX_AUTO_CONTINUATIONS: "1",
      ...(v.orchestration ? { LEAD_V2_SMOKE_ORCHESTRATION: v.orchestration } : {}),
    };
    const saved = new Map(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    for (
      const k of [
        "ANTHROPIC_API_KEY",
        "FIRECRAWL_API_KEY",
        "FIRECRAWL_USD_PER_CREDIT",
        ...(v.orchestration ? [] : ["LEAD_V2_SMOKE_ORCHESTRATION"]),
      ]
    ) {
      saved.set(k, Deno.env.get(k));
      Deno.env.delete(k);
    }
    const at = new Date(Date.now() - 60_000).toISOString();
    const evidence = {
      observed_at: at,
      source: "synthetic offline fixture; not an approved vendor quote",
      liability_bound_ref: "offline rehearsal",
    };
    const quotes = {
      jobs: {
        allowed_kinds: ["provider"],
        allowed_actors: [JOBS],
        maximum_microusd: 5000,
        discovery_page: true,
        ...evidence,
        request_limits: {
          max_request_bytes: 4096,
          max_fields: { maxItems: 3 },
          max_array_items: { jobTitles: 1, locations: 1, geoIds: 0 },
          pin_query: { timeout: "120", memory: "256" },
        },
      },
      model: {
        allowed_kinds: ["model"],
        allowed_actors: [LUNA],
        maximum_microusd: 11400,
        ...evidence,
        request_limits: { max_request_bytes: 32768, max_output_tokens: 4000 },
      },
      ...(v.companyDetails ? {
        details: {
          allowed_kinds: ["provider"],
          allowed_actors: [DETAILS],
          maximum_microusd: 5000,
          ...evidence,
          request_limits: {
            max_request_bytes: 4096,
            max_array_items: { companies: 1 },
            pin_query: { timeout: "120", memory: "256" },
          },
        },
      } : {}),
      reads: {
        allowed_kinds: ["poll"],
        allowed_actors: v.companyDetails ? [JOBS, DETAILS] : [JOBS],
        maximum_microusd: 0,
        ...evidence,
        request_limits: {},
      },
    };
    const m = await seedSmokeMission({ quotes, actorLimits: { [JOBS]: 1, ...(v.companyDetails ? { [DETAILS]: 1 } : {}) } });
    const user = uuid(), plan = uuid();
    await sql`insert into auth.users (id, email) values (${user}, ${
      "offline-" + user + "@example.invalid"
    })`;
    await sql`insert into public.agents (workspace_id, slug, name, role_prompt, department) values (${m.ws}, 'scout', 'Offline Scout', 'Find and verify the requested company using source evidence.', 'research')`;
    await sql`insert into public.task_plans (id, workspace_id, user_id, user_instruction, status) values (${plan}, ${m.ws}, ${user}, ${MISSION}, 'running')`;
    await sql`insert into public.workspace_credit_balances (workspace_id, balance_credits) values (${m.ws}, 10)`;

    type HandlerCall = { status: number; body: Record<string, unknown> };
    type Trace = Record<string, unknown> & {
      requests: Array<
        { method: string; url: string; bytes: number; body: unknown }
      >;
      attempted_requests: Array<
        { host: string; path: string; bytes: number; body: unknown }
      >;
      admissions: Array<{ message: string; data: unknown }>;
      errors: string[];
      stages: unknown[];
      handler_calls: HandlerCall[];
      handler?: HandlerCall;
      task_id?: string;
    };
    const trace: Trace = {
      variant: v.label,
      proposed_spec_sha: "0fb6312c1b78bf0282401140e62e903b31567930",
      mission: MISSION,
      requests: [],
      attempted_requests: [],
      admissions: [],
      errors: [],
      stages: [],
      handler_calls: [],
      model_stages: [],
    };
    const finishedAt = new Map<string, string>();
    const fixture = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../fixtures/lead-v2/p3-job-discovery-probe.json",
          import.meta.url,
        ),
      ),
    );
    const row = structuredClone(
      fixture.probes["harvestapi~linkedin-job-search"].items[0],
    );
    Object.assign(row, {
      id: "offline-ae",
      title: "Account Executive",
      linkedinUrl: "https://www.linkedin.com/jobs/view/offline-ae",
      postedAt: new Date(Date.now() - 86400_000).toISOString(),
      postedDate: new Date(Date.now() - 86400_000).toISOString(),
      descriptionText:
        "Example Software is a US B2B software company. We are hiring an Account Executive for our business software platform.",
    });
    Object.assign(row.company, {
      id: "offline-company",
      name: "Example Software",
      linkedinUrl: "https://www.linkedin.com/company/offline-software",
      website: "https://offline-software.example",
      description:
        // The company's own words name its buyers and its product, as the
        // business-model rule requires (a plural buyer noun; "business
        // customers" names none and correctly stays unverified).
        "Example Software builds sales software for revenue teams at mid-size companies.",
      employeeCountRange: { start: 11, end: 50 },
      locations: [{
        country: "United States",
        city: "Boston",
        isHeadquarter: true,
      }],
    });
    let models = 0;
    const fakeTransport: typeof fetch = (u, init) => {
      const url = new URL(u instanceof Request ? u.url : String(u));
      if (url.origin === new URL(REST_URL).origin) return localFetch(u, init);
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body)
        : null;
      const request = {
        method: init?.method ?? "GET",
        url: url.origin + url.pathname +
          (url.hostname === "api.apify.com"
            ? "?" +
              new URLSearchParams(
                [...url.searchParams].filter(([k]) => k !== "token"),
              )
            : ""),
        bytes: new TextEncoder().encode(String(init?.body ?? "")).length,
        body,
      };
      trace.requests.push(request);
      if (url.hostname === "api.openai.com") {
        models++;
        const system = String(body.messages?.[0]?.content ?? "");
        const name = body.response_format?.json_schema?.name ?? null;
        const user = (() => { try { return JSON.parse(String(body.messages?.at(-1)?.content ?? "")); } catch { return null; } })();
        const answer = name === "lead_mission_proposal" ? proposal
          : name === "lead_execution_plan" ? executionPlan
          : system.startsWith("You assess several companies") ? batchAnswer(user ?? {})
          : system.startsWith("Decide whether this company satisfies") ? evaluatorAnswer(user)
          : system.startsWith("You interpret supplied company evidence")
            ? groundedResult(String(user?.company_key ?? ""), evidenceIn(user))
          : {};
        (trace.model_stages as string[]).push(name ?? system.slice(0, 40));
        return json({
          id: `fake-${models}`,
          model: body.model,
          choices: [{
            message: { content: JSON.stringify(answer) },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 400,
            total_tokens: 1400,
          },
        });
      }
      assertEquals(
        url.hostname,
        "api.apify.com",
        "unexpected vendor path must fail the rehearsal",
      );
      // One run per actor: `run-jobs` / `run-details`, each with its dataset.
      const kind = url.pathname.includes("linkedin-company") || url.pathname.includes("details") ? "details" : "jobs";
      if (request.method === "POST") {
        return json({
          data: { id: `run-${kind}`, defaultDatasetId: `dataset-${kind}`, status: "RUNNING" },
        }, 201);
      }
      if (url.pathname.includes("/actor-runs/")) {
        const run = url.pathname.split("/").at(-1)!;
        if (!finishedAt.has(run)) finishedAt.set(run, new Date().toISOString());
        return json({
          data: {
            id: run, defaultDatasetId: run.replace("run-", "dataset-"), status: "SUCCEEDED",
            finishedAt: finishedAt.get(run), usageTotalUsd: run === "run-jobs" ? 0.002 : 0.004,
          },
        });
      }
      assert(url.pathname.includes("/datasets/"));
      return json(url.pathname.includes("dataset-details") ? [structuredClone(row.company)] : [row]);
    };
    const gate = createAdmissionFetch({
      db: client as never,
      ownApi: REST_URL,
      baseFetch: fakeTransport,
      log: (message, data) => trace.admissions.push({ message, data }),
    });
    const observedGate: typeof fetch = (u, init) => {
      const url = new URL(u instanceof Request ? u.url : String(u));
      if (url.origin !== new URL(REST_URL).origin) {
        trace.attempted_requests.push({
          host: url.hostname,
          path: url.pathname,
          bytes: new TextEncoder().encode(String(init?.body ?? "")).length,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
      }
      return gate(u, init);
    };
    for (const symbol of Object.getOwnPropertySymbols(gate)) {
      Object.defineProperty(
        observedGate,
        symbol,
        Object.getOwnPropertyDescriptor(gate, symbol)!,
      );
    }
    const started = Date.now();
    // Runbook Phase 4: the kickoff body (and its mission) is compiled OFFLINE,
    // before authorization; it is not a live attempt of the smoke.
    globalThis.fetch = fakeTransport;
    try {
      const compilerCalls = new ModelCallCollector();
      const binding = buildMissionCompilerBinding({
        workspaceId: m.ws,
        onModelCall: compilerCalls.sink,
      });
      const raw = await missionAdmission.run({
        queueId: m.queueId,
        workerId: m.workerId,
        taskId: m.taskId,
        generation: m.generation,
      }, () =>
        binding.proposeMission!({
          originalUserQuery: MISSION,
          requestedCount: 1,
        }));
      assert(
        raw,
        JSON.stringify({
          compiler_failure: binding.lastModelFailure(),
          admissions: trace.admissions,
        }),
      );
      trace.compiler_ledger_rows = await compilerCalls.drain(
        createLedgerWriter(client as never),
        {
          workspace_id: m.ws,
          task_id: m.taskId,
          plan_id: plan,
          logical_call_key: "offline:mission_compilation",
        },
      );
      const compiled = compileLeadMission({
        originalUserQuery: MISSION,
        proposal: raw,
        requestedCount: 1,
      });
      const mission = {
        ...compiled.final_mission,
        mission_parser_source: compiled.parser_source,
        lead_intelligence_contract_version: LEAD_INTELLIGENCE_CONTRACT_VERSION,
        planner_runtime: runtimeIdentity("planner", "offline-rehearsal"),
      };
      trace.stages.push({ stage: "compile", mission });
      globalThis.fetch = observedGate;
      const compiledOffline = trace.requests.length;
      const request = {
        plan_id: plan,
        step_index: 0,
        agent_slug: "scout",
        workspace_id: m.ws,
        user_id: user,
        instruction: MISSION,
        requested_lead_count: 1,
        workflow_kind: "qualified_lead_sourcing",
        execution_mode: "company_first",
        tool_needed: "source_with_apify",
        lead_mission: mission,
        tool_input: { lead_mission: mission, source_type: "jobs" },
        run_budget: { provider_usd: 0.20, max_candidates: 3 },
      };
      // The contract helper starts bound so compilation can be metered too.
      // Prepare the worker's fresh queued kickoff after compilation, preserving
      // the same authorization, original creation time and every admission.
      // No runtime decision or qualification state is synthesized here.
      await sql`update public.tasks set status = 'complete' where id = ${m.taskId}`;
      await sql`update public.lead_mission_queue set task_id = null, lineage_id = null, request = ${
        sql.json(request as never)
      } where id = ${m.queueId}`;
      // Runbook Phase 5 order: the authorization is over the FINAL kickoff body
      // (the queue row's request cannot change after authorization).
      await sql`update public.discovery_smoke_authorizations a
                   set criteria_hash = encode(sha256(convert_to(q.request::text, 'UTF8')), 'hex')
                  from public.lead_mission_queue q where q.id = a.queue_id and a.id = ${m.authorizationId}`;
      const { handleRunAgent } = await import(
        "../../supabase/functions/run-agent/index.ts"
      );
      const runner = createLeadMissionRunner({
        handler: async (req, opts) => {
          const response = await handleRunAgent(req, opts);
          const call = {
            status: response.status,
            body: await response.clone().json(),
          };
          trace.handler_calls.push(call);
          trace.handler ??= call;
          return response;
        },
        enforceMissionWallClock: true,
        serviceRoleKey: key,
        functionsBaseUrl: `${REST_URL}/functions/v1/`,
        admission: { workerId: m.workerId },
        createDeadline: (budgetMs) => createExecutionDeadline({ budgetMs }),
        bind: async (queueId, taskId, lineageId) => {
          const { data, error } = await client.rpc(
            "bind_lead_mission_execution",
            {
              p_queue_id: queueId,
              p_worker_id: m.workerId,
              p_task_id: taskId,
              p_lineage_id: lineageId,
            },
          );
          assertEquals(error, null);
          const row = Array.isArray(data) ? data[0] : data;
          trace.worker_binding = row;
          trace.task_id = taskId;
          return row?.bound === true;
        },
        readTaskOutcome: async (taskId) => {
          const { data, error } = await client.from("tasks").select(
            "status,result",
          ).eq("id", taskId).single();
          assertEquals(error, null);
          assert(data);
          return {
            status: data.status,
            terminal_status: terminalStatusOf(data.result),
          };
        },
        readLineageOutcome: async (lineageId) => {
          const { data } = await client.from("lead_lineages").select(
            "status,terminal_reason,current_state",
          ).eq("lineage_id", lineageId).maybeSingle();
          return data
            ? {
              status: data.status,
              terminal_reason: data.terminal_reason,
              terminal_status: terminalStatusOf(data.current_state),
            }
            : null;
        },
      });
      const [q] =
        await sql`select created_at from public.lead_mission_queue where id = ${m.queueId}`;
      const queued = {
        queueId: m.queueId,
        workspaceId: m.ws,
        request,
        taskId: null,
        lineageId: null,
        attempts: 1,
        isResume: false,
        heldUntil: null,
        enqueuedAt: new Date(q.created_at).toISOString(),
      };
      trace.outcome = await runner.run(queued, {
        executionBudgetMs: 150000,
        signal: new AbortController().signal,
      });
      const operations =
        await sql`select kind, actor, committed_microusd, reported_microusd, report_source, provider_run_id from public.discovery_smoke_operations where authorization_id = ${m.authorizationId} order by admitted_at`;
      trace.operations = operations;
      trace.tasks =
        await sql`select id,status,result from public.tasks where workspace_id = ${m.ws}`;
      const dashboard = await client.from("lead_candidates").select("*").eq(
        "workspace_id",
        m.ws,
      );
      trace.dashboard = dashboard;
      const credits =
        await sql`select * from public.credit_transactions where workspace_id = ${m.ws}`;
      trace.credits = credits;
      trace.model_ledger =
        await sql`select model, estimated_cost_usd, actual_cost_usd, cost_source from public.lead_model_calls where workspace_id = ${m.ws}`;
      trace.authorization =
        await sql`select status, total_microusd, provider_microusd, model_microusd, provider_purchases, model_attempts, provider_polls, deadline_at from public.discovery_smoke_authorizations where id = ${m.authorizationId}`;
      const of = (k: string) => operations.filter((o) => o.kind === k);
      const sentByGate = trace.admissions.filter((a) => a.message === "[smoke-admission] sent").length;
      const refused = trace.admissions.filter((a) => a.message === "[smoke-admission] refused")
        .map((a) => (a.data as { decision: string }).decision);
      trace.candidates = (dashboard.data ?? []).map((c: Record<string, unknown>) => ({
        company_name: c.company_name, status: c.status, qualification_status: c.qualification_status,
      }));
      await check({ trace, operations, dashboard, credits, compiledOffline, sentByGate, refused, of });
    } catch (e) {
      trace.errors.push(String(e));
      throw e;
    } finally {
      trace.elapsed_ms = Date.now() - started;
      console.log("OFFLINE_SMOKE_TRACE", JSON.stringify(trace));
      const output = Deno.env.get("OFFLINE_SMOKE_TRACE_PATH");
      if (output) {
        await Deno.writeTextFile(`${output}.${v.label}.json`, JSON.stringify(trace, null, 2) + "\n");
      }
      globalThis.fetch = originalFetch;
      for (const [k, v] of saved) {
        v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      }
    }
  }
}

/** Every variant: the limits hold and nothing the gate refused reached a vendor. */
function limitsHeld(r: Rehearsal) {
  const { trace, operations, of } = r;
  assertEquals(trace.requests.length - r.compiledOffline, r.sentByGate, "only admitted requests are sent");
  assert(of("model").length <= 4, "four model attempts");
  assert(of("model").reduce((a: number, o: Rehearsal) => a + Number(o.committed_microusd), 0) <= 50000, "$0.05 model");
  assert(of("provider").length <= 5, "five purchases");
  assert(of("poll").length <= 5, "five reads");
  assert(operations.reduce((a: number, o: Rehearsal) => a + Number(o.committed_microusd), 0) <= 250000, "$0.25 total");
  for (const q of trace.requests) {
    if (q.url.includes("api.openai.com")) assert(q.bytes <= 32768, `model request ${q.bytes} bytes was sent`);
    if (q.method === "POST" && q.url.includes("api.apify.com")) {
      assert(/maxTotalChargeUsd=0\.00[0-5]\d*(&|$)/.test(q.url), `vendor cap on ${q.url}`);
    }
  }
  assert(!r.refused.includes("stale_generation"), JSON.stringify(r.refused));
  // One purchase per actor, never repeated.
  const actors = of("provider").map((o: Rehearsal) => o.actor);
  assertEquals(actors.length, new Set(actors).size, "no duplicate paid purchase");
}

const opts = { sanitizeOps: false, sanitizeResources: false };
const SKIPPED_STAGES = ["research_route_control", "discovery_actor_strategy", "You triage companies", "You compare prospect companies"];
const stageRan = (r: Rehearsal, prefix: string) => (r.trace.model_stages as string[]).some((s) => s.startsWith(prefix.slice(0, 40)));
const taskJson = (r: Rehearsal) => JSON.stringify(r.trace.tasks);

/** Minimal orchestration: plan + qualification only; the skipped stages never call a model. */
function minimalShape(r: Rehearsal) {
  for (const s of SKIPPED_STAGES) assert(!stageRan(r, s), `${s} ran under the minimal orchestration`);
  assertEquals((r.trace.model_stages as string[]).filter((s) => s === "lead_execution_plan").length, 1, "the real planner, once");
  assert(stageRan(r, "You assess several companies") && stageRan(r, "Decide whether this company satisfies"),
    "qualification uses the real evaluators");
  assertEquals(r.of("model").length, 3, "plan, batch evaluation, mission evaluation");
  // No terminal receipt re-reads: every Apify read is one of the run's own.
  const apifyReads = r.trace.requests.filter((q: Rehearsal) => q.method === "GET" && q.url.includes("api.apify.com")).length;
  assertEquals(apifyReads, r.of("poll").length);
}

/**
 * WHERE THE MISSION STOPS TODAY, and why — each must be lifted by an approved
 * change, never by loosening a rule (docs: the PR #94 rehearsal report):
 *   1. enrichment is a precondition of qualifying, and the job row "can suggest
 *      but not prove" size, country and industry: the company record
 *      (apify:harvestapi~linkedin-company) is required, and the approved
 *      first-smoke catalog does not include it;
 *   2. with it, two runs need 3 + 3 reads against the cap of five;
 *   3. the compiler reads "an open Account Executive posting" as a leadership
 *      POST, a signal the smoke can never answer.
 */
function blockersRecorded(r: Rehearsal) {
  const signals = ((r.trace.stages as Rehearsal[])[0].mission.required_signals as Rehearsal[]).map((x) => x.event);
  assert(signals.includes("post"), `blocker 3 lifted (${signals}): extend the rehearsal to persistence`);
  assert(taskJson(r).includes('"enrichment_outcome": "provider_error"') || taskJson(r).includes('"enrichment_outcome":"provider_error"'),
    "held: no company record");
  assert(taskJson(r).includes("insufficient_evidence"), "held as insufficient evidence, never passed");
  assertEquals(r.dashboard.error, null);
  assertEquals(r.dashboard.data?.length, 0, "nothing qualified is persisted without the company record");
}

Deno.test("offline smoke, minimal orchestration, approved catalog: qualification is reached; held without the company record", opts, () =>
  rehearse({ orchestration: "minimal", label: "minimal-approved" }, (r) => {
    limitsHeld(r);
    minimalShape(r);
    assertEquals(r.of("provider").length, 1);
    assertEquals(r.of("provider")[0].report_source, "apify_run(settled).receipt");
    assertEquals(r.of("poll").length, 3, "status, settled receipt, dataset");
    assert(r.refused.includes("unknown_quote"), "company details is outside the approved catalog");
    blockersRecorded(r);
    assertEquals(r.credits.filter((c: Rehearsal) => c.status === "charged").length, 1);
    r.trace.verdict = "BLOCKED: company record not approved (1); reads (2); compiled post signal (3)";
  }));

Deno.test("offline smoke, minimal orchestration, + company details: the second run is refused its start on reads", opts, () =>
  rehearse({ orchestration: "minimal", companyDetails: true, label: "minimal-details" }, (r) => {
    limitsHeld(r);
    minimalShape(r);
    assertEquals(r.of("provider").length, 1, "the company-details start is refused before admission");
    assertEquals(r.of("poll").length, 3);
    assert(r.trace.admissions.some((a: Rehearsal) => a.data?.decision === "read_plan" && a.data?.detail === "reads_exhausted"),
      JSON.stringify(r.refused));
    blockersRecorded(r);
    r.trace.verdict = "BLOCKED: 3 + 3 reads against five (2)";
  }));

Deno.test("offline smoke, customer orchestration: the stages the smoke skips still run outside it", opts, () =>
  rehearse({ label: "customer" }, (r) => {
    limitsHeld(r);
    assert(stageRan(r, "research_route_control") && stageRan(r, "You triage companies"),
      JSON.stringify(r.trace.model_stages));
  }));
