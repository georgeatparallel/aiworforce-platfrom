// HISTORICAL H — EMPLOYER INTEGRITY (Query B a9a6791a, production 2026-10-12).
//
// Shift Group is a recruiting firm whose LinkedIn industry is "Software
// Development", so the staffing-agency filter (industry / name / requisition
// code) let its four postings through — and each one proved that SHIFT GROUP
// was hiring sales. The posting bodies say otherwise:
//
//   "This opportunity is presented by Shift Group on behalf of a market-leading
//    Real Estate Technology (PropTech) partner."
//   "We are partnering with a highly funded, category-defining AI platform
//    looking for a Sales Development Representative."
//
// A posting made FOR a client proves the client's hiring, not the poster's. It
// must not prove the posting company is hiring — but the company is not
// rejected: a separate direct posting from it still proves hiring.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { jobEmployerIdentityConflict } from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import { loadFixture } from "../lib/fixture.ts";
import { type EngineFixture, replayEngineSlice } from "../lib/engine.ts";

const fx = loadFixture("queryBa9a6791a.job-first") as EngineFixture;
const PAGE_1 = fx.provider_responses.find((r) => r.actor === "apify_linkedin_job_search" && r.rows.length === 30)!;
const rowsOf = (slug: string) => PAGE_1.rows.filter((r) => (r.company as { universalName: string }).universalName === slug);
const withBody = (body: string) => ({ ...structuredClone(rowsOf("shipdayinc")[0]), descriptionText: body });

const CLIENT_POSTINGS = [
  "We are recruiting on behalf of our client, a Series A SaaS company in Austin.",
  "*This opportunity is presented by Shift Group on behalf of a market-leading Real Estate Technology (PropTech) partner.",
  "Acme Talent is recruiting for a client in the fintech space.",
  "Our confidential client is a fast-growing B2B platform.",
  "Confidential Client — Account Executive, Enterprise.",
  "Our client is hiring an SDR to join their founding sales team.",
  "We are partnering with a highly funded, category-defining AI platform looking for a Sales Development Representative in Austin.",
];

Deno.test("[historical] H every client-posting pattern is read as a posting made for someone else", () => {
  for (const body of CLIENT_POSTINGS) {
    assertEquals(jobEmployerIdentityConflict(withBody(body)), "agency_client_posting", body);
  }
});

Deno.test("[historical] H a direct employer's own posting is not a client posting", () => {
  // Shipday's and Perfect Venue's production bodies, verbatim (trimmed).
  assertEquals(jobEmployerIdentityConflict(rowsOf("shipdayinc")[0]), null);
  assertEquals(jobEmployerIdentityConflict(rowsOf("perfect-venue")[0]), null);
  // Ordinary prose that merely mentions clients or partners.
  for (const body of [
    "You will manage a book of clients and partner with our customer success team.",
    "We partner with leading venues to help them grow.",
    "Our clients include 500 restaurants across the US.",
  ]) assertEquals(jobEmployerIdentityConflict(withBody(body)), null, body);
});

Deno.test("[historical] H a posting naming a different employer is still an employer conflict", () => {
  const conflicting = { ...structuredClone(rowsOf("shipdayinc")[0]), companyLinkedinUrl: "https://www.linkedin.com/company/someone-else" };
  assertEquals(jobEmployerIdentityConflict(conflicting), "structured_employer_conflict");
});

Deno.test("[historical] H replay: Shift Group stays a candidate, but its four client postings prove no hiring", async () => {
  const s1 = await replayEngineSlice(fx);
  const shift = s1.companies.find((c) => c.company.company_name === "Shift Group")!;
  assert(shift, "the company is not rejected globally");
  assertEquals((shift.hiring_jobs ?? []).length, 0, "no posting made for a client is the poster's hiring");
  assertFalse((shift.observations ?? []).some((o) => o.evidence.some((e) => e.dimension === "hiring" && e.value === true)),
    "and no hiring observation was recorded from them");
  assert(shift.mission_evaluation?.decision !== "qualified");
  const qualified = s1.companies.filter((c) => c.mission_evaluation?.decision === "qualified").map((c) => c.company.company_name).sort();
  assertEquals(qualified, ["Perfect Venue", "Shipday"], "the direct employers are unaffected");
});

Deno.test("[historical] H replay: a direct posting from the same company still proves hiring", async () => {
  const direct = { ...structuredClone(rowsOf("shift-groupllc")[0]), id: "direct-1",
    linkedinUrl: "https://www.linkedin.com/jobs/view/direct-1/", title: "Account Executive (internal team)",
    descriptionText: "Join Shift Group's own sales team selling our recruiting services." };
  const variant = structuredClone(fx);
  variant.provider_responses.find((r) => r.rows === PAGE_1.rows || r.rows.length === 30)!.rows.push(direct);
  const s1 = await replayEngineSlice(variant as EngineFixture);
  const shift = s1.companies.find((c) => c.company.company_name === "Shift Group")!;
  assertEquals((shift.hiring_jobs ?? []).map((j) => j.title), ["Account Executive (internal team)"]);
});
