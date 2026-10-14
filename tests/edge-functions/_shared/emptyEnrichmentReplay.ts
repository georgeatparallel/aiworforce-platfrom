// Synthetic controls only. Real engine/resume/eligibility, scripted transports.
import { parseLeadMissionDeterministic } from "../../../supabase/functions/_shared/leadMission.ts";
import { buildCapabilityGraph } from "../../../supabase/functions/_shared/leadCapabilityGraph.ts";
import {
  canonicalQualifiedKeys,
  missionCandidatesFrom,
  runCapabilityPlan,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { evaluateEligibility } from "../../../supabase/functions/_shared/candidateEligibility.ts";
import { stubDiscoverySelector } from "./discoverySelectorFixture.ts";

export async function replayEmptyEnrichment(
  o: {
    emptyCompanies?: number;
    retryOutcome?: "provider_error" | "deferred" | "not_attempted";
    legacyMissingOutcome?: boolean;
    retryAnswer?: "empty" | "success" | "failed";
    specMode?: "enforce";
    initialRecord?: boolean;
  } = {},
) {
  const count = o.emptyCompanies ?? 10;
  const mission = parseLeadMissionDeterministic(
    "Find founders of SaaS startups hiring software engineers in the United States. Return 20 qualified leads.",
  );
  const plan = buildCapabilityGraph(mission);
  const rows = Array.from({ length: count + 1 }, (_, n) => ({
    name: `Control${n}`,
    website: `https://control${n}.example`,
    teamSize: 40,
    batch: "W20",
    industries: ["B2B"],
    id: `control${n}`,
    openJobs: [],
  }));
  const identity = (n: number) => ({
    companyName: `Control${n}`,
    linkedinUrl: `https://www.linkedin.com/company/efficiency-control-${n}`,
    website: `https://control${n}.example`,
    employeeCountRange: { start: 11, end: 50 },
  });
  const record = (url: string) => ({
    name: `Control${/control-(\d+)/.exec(url)?.[1] ?? ""}`,
    linkedinUrl: url,
    website: `https://control${/control-(\d+)/.exec(url)?.[1] ?? ""}.example`,
    description: "A SaaS software application for businesses.",
    employeeCountRange: { start: 11, end: 50 },
    locations: [{
      parsed: {
        text: "Austin, TX, United States",
        countryFull: "United States",
      },
      country: "US",
      headquarter: true,
    }],
  });
  const brain = {
    employee_min: 11,
    employee_max: 50,
    positive_industries: ["b2b saas"],
    excluded_industries: [],
    required_geography: null,
  };
  const base = {
    mission,
    plan,
    brain,
    maxCandidates: 60,
    ...(o.specMode
      ? {
        specMode: o.specMode,
        specScope: {
          workspace_id: "synthetic-efficiency",
          lineage_id: "synthetic-root",
        },
      }
      : {}),
    readEnv: (key: string) =>
      key === "LEAD_INVESTIGATION_BUDGET"
        ? "30"
        : key === "LEAD_INVESTIGATION_MAX_PASSES"
        ? "1"
        : undefined,
  };
  const firstCalls: string[][] = [];
  const first = await runCapabilityPlan(
    {
      planDiscovery: stubDiscoverySelector(),
      invoke: (call) => {
        if (call.actorKey === "apify_yc_companies_memo23") {
          return Promise
            .resolve(rows);
        }
        if (call.actorKey === "apify_linkedin_company_details") {
          const urls = (call.input as { companies: string[] }).companies;
          firstCalls.push(urls);
          if (firstCalls.length > 1) {
            throw new Error(
              "synthetic provider failure on the remaining batch",
            );
          }
          return Promise.resolve(o.initialRecord ? [record(urls[0])] : []);
        }
        return Promise.resolve(rows.map((_, n) => identity(n)));
      },
      verifyEmployer: () => ({ verified: true, outcome: "ok" }),
    } as Parameters<typeof runCapabilityPlan>[0],
    base as Parameters<typeof runCapabilityPlan>[1],
  );
  const records = structuredClone(first.resume_records);
  if (o.retryOutcome || o.legacyMissingOutcome) {
    const retry = records.find((r) => r.enrichment !== "empty");
    if (retry?.snapshot) {
      if (o.legacyMissingOutcome) {
        delete retry.snapshot.enrichment_outcome;
        retry.enrichment = "not_started";
      } else {
        retry.snapshot.enrichment_outcome = o.retryOutcome;
        retry.enrichment = o.retryOutcome === "not_attempted"
          ? "not_started"
          : o.retryOutcome!;
      }
    }
  }
  const calls: string[][] = [];
  const second = await runCapabilityPlan(
    {
      planDiscovery: stubDiscoverySelector(),
      invoke: (call) => {
        if (call.actorKey === "apify_linkedin_company_details") {
          const urls = (call.input as { companies: string[] }).companies;
          calls.push(urls);
          if (o.retryAnswer === "failed") {
            throw new Error("synthetic retry still failed");
          }
          if (o.retryAnswer === "success") {
            return Promise.resolve(urls.map(record));
          }
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
      verifyEmployer: () => ({ verified: true, outcome: "ok" }),
    } as Parameters<typeof runCapabilityPlan>[0],
    {
      ...base,
      state: structuredClone(first.state),
      resume: {
        workspace_id: "synthetic-efficiency",
        lineage_root_task_id: "synthetic-root",
        records,
      },
    } as Parameters<typeof runCapabilityPlan>[1],
  );
  const thirdCalls: string[][] = [];
  const third = await runCapabilityPlan(
    {
      planDiscovery: stubDiscoverySelector(),
      invoke: (call) => {
        if (call.actorKey === "apify_linkedin_company_details") {
          thirdCalls.push((call.input as { companies: string[] }).companies);
        }
        return Promise.resolve([]);
      },
      verifyEmployer: () => ({ verified: true, outcome: "ok" }),
    } as Parameters<typeof runCapabilityPlan>[0],
    {
      ...base,
      state: structuredClone(second.state),
      resume: {
        workspace_id: "synthetic-efficiency",
        lineage_root_task_id: "synthetic-root",
        records: second.resume_records,
      },
    } as Parameters<typeof runCapabilityPlan>[1],
  );
  const criteria = deriveMissionCriteria(mission);
  const checks = missionCandidatesFrom(second, { missionId: "synthetic" }).map((
    candidate,
  ) => ({
    company_key: candidate.company_key,
    eligibility: evaluateEligibility(criteria, candidate.graph).eligibility,
    checks: evaluateEligibility(criteria, candidate.graph).checks,
  }));
  return {
    first,
    third,
    thirdCalls,
    second,
    firstCalls,
    calls,
    checks,
    qualified: canonicalQualifiedKeys(second.companies, { mission, plan }),
  };
}
