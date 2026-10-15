// Measurement only: committed sanitized rows, no provider or production connection.
// Run: deno run --allow-read --allow-env tests/replay/funding/audit.ts
import { loadFixture } from "../lib/fixture.ts";
import {
  atFixtureTime,
  fixture,
  replayHiring,
  replayScreen,
} from "./screenHarness.ts";
import { spendOf } from "../lib/mission.ts";
import { decisionSummary } from "../../../supabase/functions/_shared/workbenchMissionView.ts";
const root = new URL("../../../", import.meta.url);
const saved = JSON.parse(
  Deno.readTextFileSync(
    new URL(
      "tests/fixtures/lead-v2/size-semantics-replay-2026-09-24/canary_companies.json",
      root,
    ),
  ),
);
const job = loadFixture("queryBa9a6791a.job-first");
const details =
  job.provider_responses.find((r) =>
    r.actor === "apify_linkedin_company_details"
  )!.rows;
// Fixture explicitly identifies Northwind Cloud as synthetic. All other declared bands are recorded.
const recorded = details.filter((r) => r.name !== "Northwind Cloud");
const ranges = [{ min: 11, max: 50 }, { min: 11, max: 20 }, {
  min: 40,
  max: 70,
}].map((range) => ({
  range,
  recorded_employers: recorded.length,
  declared_band_overlap: recorded.filter((r) => {
    const b = r.employeeCountRange as { start: number; end: number };
    return b.start <= range.max && b.end >= range.min;
  }).length,
  declared_band_contained: recorded.filter((r) => {
    const b = r.employeeCountRange as { start: number; end: number };
    return b.start >= range.min && b.end <= range.max;
  }).length,
}));
const canary = JSON.parse(
  Deno.readTextFileSync(
    new URL("tests/fixtures/lead-v2/canary-1156c062/result.json", root),
  ),
);
const result = canary.run_outcome_as_recorded;
const synthetic = await atFixtureTime(async () => {
  const r = await replayScreen(fixture()), v = await replayHiring(r);
  const qualified = decisionSummary(v.view.counts).qualified;
  return {
    provenance: "SYNTHETIC G5 pool; not a production yield estimate",
    discovered: r.companies.length,
    qualified,
    provider_calls: r.provider.calls.length + v.provider.calls.length,
    calls_per_qualified: qualified
      ? (r.provider.calls.length + v.provider.calls.length) / qualified
      : null,
    committed_estimate_usd: spendOf(v.ledger).committed_usd,
  };
});
console.log(JSON.stringify(
  {
    industry: {
      sample: saved.companies.length,
      independently_labeled_industry_verification_pairs: 0,
      precision: null,
      recall: null,
      reason:
        "Recorded triage is multidimensional; no independently labeled industry verifier output or full discovery population. Treat neither triage nor industryIds as industry truth.",
    },
    company_first_declared_size: {
      provenance:
        "Recorded normalized snapshots; rows rebuilt from saved production checkpoints",
      sample: saved.companies.length,
      in_11_50_band: saved.companies.filter((
        c: {
          discovery_row: {
            employeeCountRange: { start: number; end: number };
          };
        },
      ) =>
        c.discovery_row.employeeCountRange.start === 11 &&
        c.discovery_row.employeeCountRange.end === 50
      ).length,
      qualified: saved.companies.filter((c: { old: { bucket: string } }) =>
        ["qualified", "worth_considering", "strong_opportunity"].includes(
          c.old.bucket,
        )
      ).length,
      note:
        "Selected canary fixture, not an unbiased population; declared band is not verified exact headcount.",
    },
    job_first_declared_size: {
      provenance:
        "21 recorded employer bands from a9a6791a; synthetic Northwind Cloud excluded",
      ranges,
    },
    recorded_provider_efficiency: {
      task: "1156c062",
      provider_calls: result.spend.provider_calls,
      qualified: result.qualification.canonical.qualified,
      calls_per_qualified: result.qualification.canonical.qualified
        ? result.spend.provider_calls / result.qualification.canonical.qualified
        : null,
      usd_reported: result.spend.usd_reported,
      note:
        "Zero qualified: ratio undefined, not zero; historic counter is not independently reconstructed provider billing.",
    },
    synthetic,
  },
  null,
  2,
));
