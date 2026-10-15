// Synthetic controls built from existing whole-mission fixtures, not live observations.
import { GOLDEN, li } from "../golden/scenarios.ts";
import { loadFixture } from "../lib/fixture.ts";
import type { GoldenMission } from "../lib/mission.ts";
import type { LineageFixture } from "../lib/lineage.ts";

export const OBSERVED_AT = "2026-10-14T12:00:00.000Z";

/** Freeze evidence windows without replacing timers or the database's clock. Sequential only. */
export async function fixedClock<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.Date;
  const instant = original.parse(OBSERVED_AT);
  globalThis.Date = new Proxy(original, {
    construct: (target, args) =>
      Reflect.construct(target, args.length ? args : [instant]),
    get: (target, key) =>
      key === "now" ? () => instant : Reflect.get(target, key),
  });
  try {
    return await run();
  } finally {
    globalThis.Date = original;
  }
}

function editRows(
  g: GoldenMission,
  actor: string,
  edit: (r: Record<string, unknown>) => void,
) {
  for (const response of g.responses.filter((r) => r.actor === actor)) {
    response.rows.forEach(edit);
  }
}

const DETAILS = "apify_linkedin_company_details";
const SEARCH = "apify_linkedin_company_search";
const ATOMUS = "apify_funding_atomus";
const JOBS = "apify_linkedin_job_search";

export const CONTROLS: Record<string, () => GoldenMission> = {
  multi_constraint_match: GOLDEN.qualified,
  size_disjoint: GOLDEN.ineligible,
  hiring_unknown: GOLDEN.pending,
  interrupted_funding_adoption: GOLDEN.adoption,
  spending_cap: GOLDEN.budget,
  geography_disjoint: () => {
    const g = GOLDEN.qualified();
    editRows(g, DETAILS, (r) => {
      r.locations = [{
        parsed: { text: "Toronto, Canada", countryFull: "Canada" },
        country: "CA",
        headquarter: true,
      }];
    });
    return g;
  },
  size_partial_overlap: () => {
    const g = GOLDEN.qualified();
    editRows(g, DETAILS, (r) => {
      r.employeeCountRange = { start: 51, end: 200 };
    });
    g.mission.company_profile.employee_range = { min: 11, max: 100 };
    for (const c of g.mission.criteria ?? []) {
      if (c.dimension === "company_size") c.value = { min: 11, max: 100 };
    }
    g.mission.original_user_query =
      "Find 1 US company with 11–100 employees, funding in the last 2 years, and an open sales role.";
    return g;
  },
  size_member_count_only: () => {
    const g = GOLDEN.qualified();
    for (const actor of [DETAILS, SEARCH]) {
      editRows(g, actor, (r) => {
        delete r.employeeCountRange;
        r.employeeCount = 30;
      });
    }
    return g;
  },
  size_exact_requirement: () => {
    const g = GOLDEN.qualified();
    g.mission.company_profile.employee_range = { min: 30, max: 30 };
    for (const c of g.mission.criteria ?? []) {
      if (c.dimension === "company_size") c.value = { min: 30, max: 30 };
    }
    g.mission.original_user_query =
      "Find 1 US company with exactly 30 employees, funding in the last 2 years, and an open sales role.";
    return g;
  },
  funding_partial: () => {
    const g = GOLDEN.qualified();
    editRows(g, ATOMUS, (r) => {
      const funding = (r.company as {
        financial: { funding: { rounds: Array<Record<string, unknown>> } };
      }).financial.funding;
      funding.rounds.forEach((round) => {
        delete round.announced_at;
      });
    });
    g.responses.push({
      actor: "apify_funding_pvalyou",
      rows: [],
      provenance: "synthetic: fallback has no dated funding evidence",
    });
    return g;
  },
  hiring_stale: () => {
    const g = GOLDEN.qualified();
    editRows(g, JOBS, (r) => {
      r.postedDate = "2025-01-01";
    });
    return g;
  },
  zero_results: () => {
    const g = GOLDEN.qualified();
    for (const response of g.responses) response.rows = [];
    return g;
  },
};

/** Existing lineage driver supports recorded Stage-2 model outputs; the golden driver doesn't. */
export function industryControl(
  label: "MATCH" | "NON_MATCH" | "UNKNOWN",
): LineageFixture {
  const g = GOLDEN.qualified();
  g.mission.criteria = (g.mission.criteria ?? []).filter((c) =>
    c.dimension !== "funding"
  );
  g.mission.criteria.push({
    id: "industry:software",
    kind: "hard",
    dimension: "industry",
    value: "software",
    label: "Industry: software",
    source: "user_explicit",
    status: "ok",
    user_phrase: "software",
    rationale: "explicit synthetic requirement",
  });
  g.mission.required_signals = g.mission.required_signals.filter((s) =>
    s.type !== "funding"
  );
  g.mission.company_profile.verticals = ["software"];
  g.mission.original_user_query =
    "Find 1 US software company with 11–50 employees currently hiring sales.";
  editRows(g, DETAILS, (r) => {
    r.description = label === "MATCH"
      ? "We build subscription software for sales teams. Customers use our product to manage their sales pipeline."
      : label === "NON_MATCH"
      ? "We are a staffing agency providing recruiting services for businesses. We recruit and place contractors."
      : "We help organizations succeed.";
  });
  // Use a sanitized fixture's schema and ceiling definitions, but no recorded company rows.
  const fx = loadFixture("queryBd22d9ee6.loop") as LineageFixture;
  delete fx.mission_ref;
  fx.fixture = `industry_${label.toLowerCase()}_control`;
  const suffix = label === "MATCH" ? "1" : label === "NON_MATCH" ? "3" : "2";
  fx.provenance = {
    environment: "test",
    task_id: `00000000-0000-4000-8000-00000000000${suffix}`,
    sources: ["synthetic controls; existing golden provider shapes"],
    sanitization: ["no real company observations"],
  };
  fx.mission = g.mission as unknown as Record<string, unknown>;
  const details = g.responses.find((r) => r.actor === DETAILS)!;
  const jobs = g.responses.find((r) => r.actor === JOBS)!;
  for (const row of jobs.rows) {
    row.jobState = "LISTED";
    Object.assign(row.company as Record<string, unknown>, {
      employeeCountRange: { start: 11, end: 50 },
      description: details.rows[0].description,
    });
  }
  fx.provider_responses = [
    {
      ...jobs,
      input_match: { page: null, company: null },
      provenance:
        "synthetic primary job discovery with explicit employer evidence",
    },
    {
      actor: JOBS,
      input_match: { page: 2, company: null },
      rows: [],
      provenance: "synthetic empty next page",
    },
    {
      actor: JOBS,
      input_match: { page: 3, company: null },
      rows: [],
      provenance: "synthetic empty final page",
    },
    details,
  ];
  fx.checkpoints = {};
  fx.ledger_reservations = [];
  fx.anchors = {};
  fx.expected = {};
  fx.engine = {
    readiness: "production",
    max_candidates: 10,
    remaining_leads: 1,
    model_responses: {
      plan_execution: fx.engine.model_responses.plan_execution,
      plan_discovery: [],
      evaluate_mission: { mission_fit: "pass" },
      replan_queries: [],
      proven_business_models: label === "UNKNOWN"
        ? {}
        : { [li("acme")]: label === "MATCH" ? "b2b_software" : "b2b_service" },
    },
  };
  return fx;
}
