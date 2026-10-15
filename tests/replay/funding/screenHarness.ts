// G5 adapter only: production engine + verifier + ledger; synthetic provider boundary.
// Separate from lib/engine.ts and lib/provider.ts, which PRs #68–#73 modify.
import type { CompanyResumeRecord } from "../../../supabase/functions/_shared/leadResumeState.ts";
import { loadFixture, type ReplayFixture } from "../lib/fixture.ts";
import { FixtureProvider, noNetwork } from "../lib/provider.ts";
import {
  type CapabilityExecutionState,
  type EngineCompany,
  runCapabilityPlan,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import {
  type LeadMissionV1,
  missionHash,
} from "../../../supabase/functions/_shared/leadMission.ts";
import {
  PRODUCTION_READINESS,
  routeActorReady,
} from "../../../supabase/functions/_shared/routeReadiness.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { fundingScreenPlan } from "../../../supabase/functions/_shared/fundingPoolScreen.ts";
import { screenDownstreamVerifiersUsd } from "../../../supabase/functions/_shared/fundingScreenDefaults.ts";
import { parseRunBudget } from "../../../supabase/functions/_shared/runBudget.ts";
import { fundingStageVerifier } from "../../../supabase/functions/_shared/fundingStageVerifier.ts";
import {
  ledgerBoundCall,
  type LedgerCallDeps,
  type VerifierFinding,
} from "../../../supabase/functions/_shared/claimVerifier.ts";
import { verifierSpecCompiler } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { guardedInvoker } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { hashInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { stubMissionEvaluator } from "../../edge-functions/_shared/missionEvaluatorFixture.ts";

export const fixture = () => loadFixture("g5.funding-screen");
export const page = (slug: string) =>
  `https://www.linkedin.com/company/${slug}`;
export type ScreenState = CapabilityExecutionState;
export interface ScreenRun {
  companies: EngineCompany[];
  state: ScreenState;
  resume_records: CompanyResumeRecord[];
  provider: FixtureProvider;
  findings: VerifierFinding[];
}

/** Freeze Date only (not timers), so dates, hashes and eligibility never age. */
export async function atFixtureTime<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.Date;
  const instant = original.parse("2026-10-01T12:00:00.000Z");
  globalThis.Date = new Proxy(original, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [instant]);
    },
    get(target, key) {
      return key === "now" ? () => instant : Reflect.get(target, key);
    },
  });
  try {
    return await run();
  } finally {
    globalThis.Date = original;
  }
}

export async function replayScreen(
  fx: ReplayFixture = fixture(),
  resume?: ScreenRun,
  fault?: "atomus-timeout",
): Promise<ScreenRun> {
  noNetwork();
  const mission = fx.mission as unknown as LeadMissionV1;
  const readiness = PRODUCTION_READINESS;
  const criteria = deriveMissionCriteria(mission, readiness);
  const runBudget = parseRunBudget({ provider_usd: 0.14, max_candidates: 2 });
  const readEnv = (k: string) =>
    k === "FIRECRAWL_USD_PER_CREDIT" ? "0.005" : undefined;
  const downstream = screenDownstreamVerifiersUsd(mission, criteria, readEnv);
  const priced = fundingScreenPlan({
    criteria,
    runBudget,
    requestedCount: 1,
    downstream_verifiers_usd: downstream,
  });
  if (!priced.plan) {
    throw new Error(
      `G5 screen did not price: ${priced.reason}, downstream=${downstream}`,
    );
  }
  const provider = new FixtureProvider(fx.provider_responses);
  const invoke: FixtureProvider["invoke"] = async (call) => {
    const rows = await provider.invoke(call);
    if (
      fault === "atomus-timeout" && call.actorKey === "apify_funding_atomus"
    ) {
      provider.calls[provider.calls.length - 1].rows = 0;
      throw Object.assign(
        new Error("SYNTHETIC provider timeout after run started"),
        { code: "ETIMEDOUT" },
      );
    }
    return rows;
  };
  const findings: VerifierFinding[] = [];
  const scope = {
    workspace_id: "<workspace>",
    lineage_id: fx.provenance.task_id,
  };
  const model = {
    reasoning:
      "SYNTHETIC fixed G5 planner; operational screen must override full-mode proposal",
    steps: [
      {
        capability: "general_company_discovery",
        actor_key: "apify_linkedin_company_search",
        input: {
          scraperMode: "full",
          maxItems: 5,
          locations: ["United States"],
          industryIds: ["4", "6"],
          companySize: ["11-50"],
          startPage: 1,
          takePages: 2,
        },
        depends_on: [],
      },
      {
        capability: "company_identity_resolution",
        actor_key: "apify_linkedin_company_search",
        input: { searchQuery: "{{name}}", maxItems: 5 },
        depends_on: [1],
      },
      {
        capability: "company_enrichment",
        actor_key: "apify_linkedin_company_details",
        input: { companies: ["{{url}}"] },
        depends_on: [2],
      },
      {
        capability: "company_brain_qualification",
        actor_key: null,
        input: {},
        depends_on: [3],
      },
      {
        capability: "persistence",
        actor_key: null,
        input: {},
        depends_on: [4],
      },
    ],
  };
  const mh = await missionHash(mission);
  const result = await runCapabilityPlan({
    invoke,
    verifyEmployer: () => ({ verified: true, outcome: "ok" }),
    evaluateMission: stubMissionEvaluator({ mission_fit: "pass" }),
    planExecution: () => Promise.resolve(structuredClone(model)),
    planDiscovery: () =>
      Promise.resolve([{
        actor_key: "apify_linkedin_company_search",
        role: "primary",
        input: structuredClone(model.steps[0].input),
      }]),
  } as never, {
    mission,
    plan: buildCapabilityGraph(mission, {
      executability: "enforce",
      readiness,
    }),
    maxCandidates: priced.plan.pool_rows,
    remainingLeads: 1,
    readEnv,
    identity: {
      workspace_id: scope.workspace_id,
      task_id: fx.provenance.task_id,
    },
    specMode: "enforce",
    specScope: scope,
    readiness,
    runBudget,
    ...(resume
      ? {
        state: JSON.parse(JSON.stringify(resume.state)),
        resume: {
          workspace_id: scope.workspace_id,
          lineage_root_task_id: scope.lineage_id,
          records: JSON.parse(JSON.stringify(resume.resume_records)),
        },
      }
      : {}),
    fundingScreen: {
      plan: priced.plan,
      recentlyChecked: new Set<string>(),
      priorSearches: [],
      // The screen resumes its own owed reads and hands back what it still owes (#77).
      screen: async (targets, state, pending) => {
        const ledger = state.spend_ledger!;
        const deps: LedgerCallDeps = {
          ledger,
          spec: verifierSpecCompiler({
            scope,
            mission_hash: mh,
            policy: criteriaExecutionPolicy(mission),
            ceilings: () => ledger.ceilings,
            readiness,
            plan: null,
          }),
          actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
          invoke: guardedInvoker(
            null,
            (call) => invoke(call),
            undefined,
            readiness,
          ),
          hash: (input, k) => hashInput(input, k),
        };
        const report = await fundingStageVerifier({ fallback: false }).verify(
          targets,
          {
            call: ledgerBoundCall(deps),
            now: () => new Date().toISOString(),
            log: () => {},
            ready: (actor) =>
              routeActorReady(actor, "funding_verification", readiness).ready,
          },
          { mission_id: fx.provenance.task_id, pending },
        );
        findings.push(...report.findings);
        return { findings: report.findings, pending: report.pending };
      },
    },
  });
  return {
    ...result,
    state: result.state as ScreenState,
    resume_records: result.resume_records ?? [],
    provider,
    findings,
  };
}

/** Existing Replay Lab verifier phase, fed the real screen checkpoint and ledger. */
export async function replayHiring(run: ScreenRun, fx = fixture()) {
  const { replayVerificationAt, canonicalView } = await import(
    "../lib/verification.ts"
  );
  const checkpoint = "g5_after_screen";
  fx.checkpoints[checkpoint] = {
    at: new Date().toISOString(),
    note: "SYNTHETIC runtime checkpoint after real funding-screen execution",
    companies: run.resume_records,
    verifier_pending_runs: [],
  };
  fx.ledger_reservations = run.state.spend_ledger!.reservations.map((r) => ({
    at: new Date(Date.now() - 1).toISOString(),
    r,
  }));
  fx.ceilings = run.state.spend_ledger!.ceilings;
  const result = await replayVerificationAt(fx, checkpoint, {
    verifiers: "hiring",
  });
  return {
    ...result,
    view: canonicalView(
      { companies: result.companies },
      result.mission,
      fx.provenance.task_id,
      "general_company_discovery",
    ),
  };
}
