import {
  priorPurchasesFrom,
  type VerifierLedgerRow,
} from "../../../supabase/functions/_shared/verifierPurchaseRecovery.ts";
// Focused synthetic investigation on the checked-out production funding screen.
// No dependency on unmerged G5 PR #74 and no edits to production code.
import { GOLDEN, goldenMission } from "../golden/scenarios.ts";
import { FixtureProvider, noNetwork } from "../lib/provider.ts";
import {
  type CapabilityExecutionState,
  runCapabilityPlan,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import {
  PRODUCTION_READINESS,
  routeActorReady,
} from "../../../supabase/functions/_shared/routeReadiness.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { fundingScreenPlan } from "../../../supabase/functions/_shared/fundingPoolScreen.ts";
import { screenDownstreamVerifiersUsd } from "../../../supabase/functions/_shared/fundingScreenDefaults.ts";
import { parseRunBudget } from "../../../supabase/functions/_shared/runBudget.ts";
import { fundingStageVerifier } from "../../../supabase/functions/_shared/fundingStageVerifier.ts";
import { ledgerBoundCall } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { verifierSpecCompiler } from "../../../supabase/functions/_shared/verifierCallSpec.ts";
import { criteriaExecutionPolicy } from "../../../supabase/functions/_shared/criteriaExecutionPolicy.ts";
import { missionHash } from "../../../supabase/functions/_shared/leadMission.ts";
import { hashInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import { hiringActorCard } from "../../../supabase/functions/_shared/hiringActorCatalog.ts";
import { guardedInvoker } from "../../../supabase/functions/_shared/leadMissionRuntime.ts";
import { stubMissionEvaluator } from "../../edge-functions/_shared/missionEvaluatorFixture.ts";
import { readPendingRun } from "../../../supabase/functions/_shared/capabilityExecution.ts";

export async function fixedClock<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.Date,
    at = original.parse("2026-10-14T12:00:00.000Z");
  globalThis.Date = new Proxy(original, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [at]);
    },
    get(target, key) {
      return key === "now" ? () => at : Reflect.get(target, key);
    },
  });
  try {
    return await run();
  } finally {
    globalThis.Date = original;
  }
}
export async function interruptedScreen(pending = true) {
  noNetwork();
  const g = GOLDEN.qualified();
  g.mission = goldenMission({ hiring: false });
  g.model.plan_execution.steps = g.model.plan_execution.steps.filter((s) =>
    (s as { capability: string }).capability !== "hiring_verification"
  );
  g.responses.find((r) => r.actor === "apify_funding_atomus")!.pending_once =
    pending;
  const mission = g.mission, readiness = PRODUCTION_READINESS;
  const criteria = deriveMissionCriteria(mission, readiness),
    runBudget = parseRunBudget({ provider_usd: 0.14, max_candidates: 2 });
  const readEnv = (k: string) =>
    k === "FIRECRAWL_USD_PER_CREDIT" ? "0.005" : undefined;
  const priced = fundingScreenPlan({
    criteria,
    runBudget,
    requestedCount: 1,
    downstream_verifiers_usd: screenDownstreamVerifiersUsd(
      mission,
      criteria,
      readEnv,
    ),
  });
  if (!priced.plan) {
    throw Error(
      "synthetic control must price a funding screen: " + priced.reason +
        " downstream=" +
        screenDownstreamVerifiersUsd(mission, criteria, readEnv),
    );
  }
  const scope = {
    workspace_id: "<workspace>",
    lineage_id: "quality-funding-interruption",
  };
  const hash = await missionHash(mission);
  const durableRows: VerifierLedgerRow[] = [];
  async function slice(resume?: Awaited<ReturnType<typeof runCapabilityPlan>>) {
    const provider = new FixtureProvider(g.responses), outcomes: string[] = [];
    let screenCalls = 0;
    const result = await runCapabilityPlan({
      invoke: provider.invoke,
      readPendingRun,
      verifyEmployer: () => ({ verified: true, outcome: "ok" }),
      evaluateMission: stubMissionEvaluator({ mission_fit: "pass" }),
      planExecution: () =>
        Promise.resolve(structuredClone(g.model.plan_execution)),
      planDiscovery: () =>
        Promise.resolve(structuredClone(g.model.plan_discovery)),
    } as never, {
      mission,
      plan: buildCapabilityGraph(mission, {
        executability: "enforce",
        readiness,
      }),
      maxCandidates: priced.plan!.pool_rows,
      remainingLeads: 1,
      readEnv,
      identity: { workspace_id: scope.workspace_id, task_id: scope.lineage_id },
      specMode: "enforce",
      specScope: scope,
      readiness,
      runBudget,
      ...(resume
        ? {
          state: JSON.parse(
            JSON.stringify(resume.state),
          ) as CapabilityExecutionState,
          resume: {
            workspace_id: scope.workspace_id,
            lineage_root_task_id: scope.lineage_id,
            records: JSON.parse(JSON.stringify(resume.resume_records)),
          },
        }
        : {}),
      fundingScreen: {
        plan: priced.plan!,
        recentlyChecked: new Set<string>(),
        priorSearches: [],
        screen: async (targets, state) => {
          screenCalls++;
          const ledger = state.spend_ledger!,
            call = ledgerBoundCall({
              ledger,
              prior: priorPurchasesFrom(durableRows),
              spec: verifierSpecCompiler({
                scope,
                mission_hash: hash,
                policy: criteriaExecutionPolicy(mission),
                ceilings: () => ledger.ceilings,
                readiness,
                plan: null,
              }),
              actorIdFor: (k) => hiringActorCard(k)?.actor_id ?? null,
              invoke: guardedInvoker(
                null,
                (c) => provider.invoke(c),
                undefined,
                readiness,
              ),
              hash: (input, k) => hashInput(input, k),
            });
          // Same findings-only callback contract as current run-agent.
          const report = await fundingStageVerifier({ fallback: false }).verify(
            targets,
            {
              call: async (c) => {
                const answer = await call(c);
                outcomes.push(answer.status);
                return answer;
              },
              now: () => new Date().toISOString(),
              log: () => {},
              ready: (actor) =>
                routeActorReady(actor, "funding_verification", readiness).ready,
            },
            { mission_id: scope.lineage_id, pending: [] },
          );
          return report.findings;
        },
      },
    });
    return { result, provider, outcomes, screenCalls };
  }
  const first = await slice();
  const fundingCall = first.provider.calls.find((c) =>
    c.actor === "apify_funding_atomus"
  )!;
  const reservation = first.result.state.spend_ledger!.reservations.find((r) =>
    r.idempotency_key === fundingCall.idempotency_key
  )!;
  durableRows.push({
    idempotency_key: fundingCall.idempotency_key,
    provider_run_id: reservation.provider_run_id ?? null,
    status: pending ? "started" : "succeeded",
    started_at: new Date().toISOString(),
    record_kind: "provider_call",
  });
  const durableAdoption = priorPurchasesFrom(durableRows).lookup(
    fundingCall.idempotency_key!,
  );
  const second = await slice(first.result);
  const bought = first.provider.calls.find((c) =>
    c.actor === "apify_funding_atomus"
  );
  const availableOnAdoption = pending && bought
    ? await new FixtureProvider(g.responses).invoke({
      actorKey: "apify_funding_atomus",
      input: bought.input,
      resumeRunId: reservation.provider_run_id ?? undefined,
    })
    : [];
  return { first, second, availableOnAdoption, durableAdoption };
}
