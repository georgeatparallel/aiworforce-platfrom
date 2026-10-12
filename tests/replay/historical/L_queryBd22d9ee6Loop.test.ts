// HISTORICAL L — QUERY B d22d9ee6 (production 2026-10-12): A LINEAGE THAT COULD NOT STOP.
//
// "Find 3 US software companies with 11–50 employees that are currently hiring
// sales." 29m15s, 6 slices (one a 409 no-op), $0.3864, cancelled by hand.
//
//   slice 1  page 1 + a re-plan query → 33 employers, 3 in band
//   slice 2  page 2 (of that re-plan query) → 47, 4 in band, Continuum AI
//            qualifies
//   slice 3  page 3 — the last the actor allows — + a re-plan → 66, still 4
//   4, 5, …  a fresh re-plan query every slice: 71, 73 … in band 4, qualified 1
//
// Every slice ended `replenishment_required`: discovery reported `pass_limit`,
// read as "routes remain", and `barren_slices` stayed 0 because every new
// out-of-band employer added a resolved (failed) size check to the progress
// count. The replay reproduces that loop through the production engine and
// the production continuation functions; the fixed behaviour is asserted
// against what the STATE says, never against a slice number.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFixture } from "../lib/fixture.ts";
import { type LineageFixture, replayLineage } from "../lib/lineage.ts";

const fx = loadFixture("queryBd22d9ee6.loop") as LineageFixture;
const RUNAWAY_GUARD = 10;
const variant = (edit: (f: LineageFixture) => void) => { const f = structuredClone(fx); edit(f); return f; };
const replanResponse = (f: LineageFixture, n: number) =>
  f.provider_responses.find((r) => r.provenance.startsWith(`re-plan query ${n}:`))!;
const inBandRow = (f: LineageFixture, slug: string) => structuredClone(
  f.provider_responses.flatMap((r) => r.rows).find((r) => (r.company as { universalName?: string })?.universalName === slug)!);

// ══════════ ANCHORS — the production funnel, reproduced ════════════════════

Deno.test("[historical] L anchors: slice 1 → 33 employers / 3 in band; slice 2 → 47 / 4 and Continuum AI qualifies", async () => {
  const r = await replayLineage(fx, { maxSlices: 2 });
  assertEquals([r.slices[0].employers, r.slices[0].admittedInBand, r.slices[0].qualified], [33, 3, []]);
  assertEquals([r.slices[1].employers, r.slices[1].admittedInBand, r.slices[1].qualified], [47, 4, ["Continuum AI"]]);
  assertEquals(r.slices[1].discovery?.pages_taken, { apify_linkedin_job_search: 2 });
});

// ══════════ THE FIXED LINEAGE — it stops because the state says so ═════════

Deno.test("[historical] L FIXED: the lineage terminates on its own, search_exhausted, Continuum AI still the one valid lead", async () => {
  const r = await replayLineage(fx, { maxSlices: RUNAWAY_GUARD });
  assert(r.terminal !== null, `still continuing after ${r.slices.length} slices: ${r.slices.map((s) => `${s.employers}/${s.decision}`).join(" → ")}`);
  assert(r.slices.length <= 4, `${r.slices.length} slices`);
  assertEquals(r.terminal, "search_exhausted");
  assertEquals(r.slices.at(-1)!.qualified, ["Continuum AI"], "no false positive, the valid lead kept");
});

Deno.test("[historical] L FIXED: after the last page, at most ONE re-plan is bought, and an unproductive one exhausts discovery", async () => {
  const r = await replayLineage(fx, { maxSlices: RUNAWAY_GUARD });
  const lastPageSlice = r.slices.findIndex((s) => s.discovery?.pages_taken.apify_linkedin_job_search === 3);
  assert(lastPageSlice >= 0, "page 3 was read");
  const afterLastPage = r.slices.slice(lastPageSlice).flatMap((s) => s.jobSearches).filter((j) => j.page === 1 && !j.adopted);
  assert(afterLastPage.length <= 1, `re-plans bought after the last page: ${afterLastPage.length}`);
  const last = r.slices.at(-1)!.discovery!;
  assertEquals([last.exhausted, last.stop_reason], [true, "replan_unproductive"]);
});

// ══════════ FIX 1 cases — exhaustion follows useful progress, not the clock ═

Deno.test("[historical] L FIX 1-B/C: a post-page-3 re-plan that admits a NEW in-band company is productive — not exhausted", async () => {
  const f = variant((g) => {
    // Whichever re-plan slice 3 buys carries Newco Labs (the re-planner is also
    // consulted in slice 2, where the amendment is refused).
    for (let n = 2; n <= 8; n++) {
      const rn = replanResponse(g, n);
      const row = inBandRow(g, "nebuly");
      const c = row.company as Record<string, unknown>;
      Object.assign(c, { id: "cid-newco", universalName: "newco-labs", name: "Newco Labs",
        linkedinUrl: "https://www.linkedin.com/company/newco-labs", website: "https://newco-labs.example" });
      Object.assign(row, { id: `job-newco-${n}`, linkedinUrl: `https://www.linkedin.com/jobs/view/job-newco-${n}/` });
      rn.rows[0] = row; // same row count (30): a genuinely new admitted candidate, not more rows
    }
    g.provider_responses.find((r) => r.actor === "apify_linkedin_company_details")!.rows.push({
      id: "cid-newco", name: "Newco Labs", linkedinUrl: "https://www.linkedin.com/company/newco-labs", website: "https://newco-labs.example",
      employeeCount: 20, employeeCountRange: { start: 11, end: 50 }, description: "Newco Labs.",
      industries: [{ name: "Software Development" }],
      locations: [{ country: "US", headquarter: true, parsed: { text: "Boston, MA, United States", countryCode: "US", country: "United States" } }],
    });
  });
  const r = await replayLineage(f, { maxSlices: 3 });
  const s3 = r.slices[2];
  assertEquals(s3.discovery?.pages_taken.apify_linkedin_job_search, 3);
  assertEquals(s3.admittedInBand, 5, "the re-plan admitted Newco Labs");
  assertFalse(s3.discovery!.exhausted, "a productive re-plan keeps discovery open");
});

Deno.test("[historical] L FIX 1-D: an unproductive re-plan while pages remain does NOT exhaust discovery", async () => {
  const f = variant((g) => {
    // The slice-1 re-plan admits nobody (JP Carroll Roofing removed).
    const r1 = replanResponse(g, 1);
    r1.rows = r1.rows.filter((row) => (row.company as { universalName?: string }).universalName !== "jp-carroll-roofing");
  });
  const r = await replayLineage(f, { maxSlices: 1 });
  const d = r.slices[0].discovery!;
  assertEquals(d.pages_taken.apify_linkedin_job_search, 1, "pages 2 and 3 are unread");
  assertFalse(d.exhausted, `${d.stop_reason}: unread pages remain`);
});

Deno.test("[historical] L FIX 1-E: no page left and the re-planner has nothing new → exhausted at once", async () => {
  const f = variant((g) => { g.engine.model_responses.replan_queries = g.engine.model_responses.replan_queries.slice(0, 1); });
  const r = await replayLineage(f, { maxSlices: RUNAWAY_GUARD });
  const s3 = r.slices.find((s) => s.discovery?.pages_taken.apify_linkedin_job_search === 3)!;
  assert(s3.discovery!.exhausted, JSON.stringify(s3.discovery));
  assert(r.terminal !== null && r.slices.length <= 3);
});

// ══════════ FIX 2 — rejected employers are not progress ═══════════════════

Deno.test("[historical] L FIX 2: a slice that only adds out-of-band employers is barren", async () => {
  // Page 2 without Continuum AI: fourteen more employers, every one outside 11–50.
  const f = variant((g) => {
    const p2 = g.provider_responses.find((r) => r.provenance.startsWith("page 2"))!;
    p2.rows = p2.rows.filter((row) => (row.company as { universalName?: string }).universalName !== "continuumai");
  });
  const r = await replayLineage(f, { maxSlices: 2 });
  assertEquals(r.slices[1].admittedInBand, 3, "nobody new admitted");
  assert(r.slices[1].employers > r.slices[0].employers, "but more employers were found");
  assertEquals(r.slices[1].barren, 1, `out-of-band employers counted as progress (claim progress ${r.slices[0].claimProgress} → ${r.slices[1].claimProgress})`);
});

Deno.test("[historical] L FIX 2: a slice that admits a candidate or qualifies one is productive", async () => {
  const r = await replayLineage(fx, { maxSlices: 2 });
  assertEquals(r.slices[1].barren, 0, "Continuum AI admitted and qualified in slice 2");
});
