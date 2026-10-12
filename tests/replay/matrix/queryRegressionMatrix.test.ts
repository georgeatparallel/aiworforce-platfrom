// LEAD V2 QUERY REGRESSION MATRIX — REPRESENTATIVE REQUESTS, DETERMINISTIC ANSWERS.
//
// Every row is a request type Lead V2 must keep answering the same way. The
// expected value is written here by hand from the request's meaning — never
// produced by a model — and each row runs through the production function that
// owns that decision:
//
//   mission rows        → compileLeadMission (fixed proposal, as the model's
//                         recorded output) → deriveMissionCriteria
//   evidence/size rows  → the normalizers, prequalification, observation merge
//   route/outcome rows  → decideAutoContinuation, settleV2Outcome
//
// WORDING VARIANTS: one intent written four ways must compile to the same hard
// requirements. "with open sales roles" compiled to NO hiring requirement at
// all, and "posted sales jobs" to a social post by an employee (geography
// softened to a target) — both found while building this matrix.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileLeadMission } from "../../../supabase/functions/_shared/leadMissionCompiler.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import { readCanonicalSignals } from "../../../supabase/functions/_shared/signalKinds.ts";
import {
  jobEmployerIdentityConflict, jobEmployerToCompany, jobProvesRequestedHiring, normalizeLinkedInJob,
} from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import {
  discoverySizeRejectBlocker, prequalifyNormalizedCompany,
} from "../../../supabase/functions/_shared/leadGenericPrequalification.ts";
import * as actorInputs from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import * as engine from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { decideAutoContinuation, settleV2Outcome } from "../../../supabase/functions/_shared/leadAutoContinuation.ts";

// ── the recorded model proposal, varied per row ─────────────────────────────
const proposal = (o: Record<string, unknown> = {}) => ({
  requested_opportunity_count: 3, requested_contact_ready_count: null, company_types: ["software"],
  geographies: ["United States"], geography_is_hard: true, employee_range: { min: 11, max: 50 },
  decision_maker_roles: [], hard_constraints: [], soft_preferences: [],
  preferred_signals: [], required_signal_terms: [], adjacent_signals: [], excluded_signals: [],
  allowed_broadening: { role_families: [], company_types: [], geographies: [], employee_range: { min: null, max: null } },
  disallowed_broadening: [], required_evidence: [], required_capabilities: [], preferred_source_strategy: [],
  evaluation_instructions: "", founder_unlock_recommended: false, confidence: 0.85, unknowns: [], ...o,
});

interface Hard {
  count: number | null;
  industry?: string;
  geography?: string | null;
  size?: { min: number | null; max: number | null } | null;
  hiring?: { families: string[]; window?: number | null } | null;
  funding?: { round?: string; window?: number | null } | null;
}

/** The hard requirements a request compiles to, in the shape the rows assert. */
function hardOf(query: string, o: Record<string, unknown> = {}): Hard {
  const mission = compileLeadMission({ originalUserQuery: query, proposal: proposal(o) as never }).final_mission;
  const crit = deriveMissionCriteria(mission);
  const hard = (dim: string) => crit.find((c) => c.kind === "hard" && c.dimension === dim)?.value as Record<string, any> | undefined;
  const sig = (event: string) => (mission.required_signals ?? []).find((s) => s.event === event) as Record<string, any> | undefined;
  const hiring = hard("hiring");
  const funding = hard("funding");
  return {
    count: mission.requested_count,
    industry: hard("industry") as unknown as string,
    geography: (hard("geography") as unknown as string) ?? null,
    size: (hard("company_size") as { min: number | null; max: number | null } | undefined) ?? null,
    hiring: hiring ? { families: [...(hiring.qualifier?.role_families ?? [])].sort(), window: sig("hiring")?.timeframe_days ?? null } : null,
    funding: funding ? { round: funding.qualifier?.round_type, window: sig("funding")?.timeframe_days ?? null } : null,
  };
}

const US = "United States";
const S11_50 = { min: 11, max: 50 };

// ══════════ MISSION ROWS (categories 1–9, 11–12) ═══════════════════════════

const MISSION_ROWS: Array<{ cat: string; q: string; o?: Record<string, unknown>; want: Partial<Hard> }> = [
  { cat: "1 hiring only", q: "Find 3 US software companies with 11-50 employees that are currently hiring sales.",
    o: { required_signal_terms: ["sales"] },
    want: { count: 3, geography: US, size: S11_50, hiring: { families: ["gtm_sales"], window: null }, funding: null } },
  { cat: "2 funding only", q: "Find 3 US software companies with 11-50 employees that raised a Series A.",
    o: { required_signal_terms: ["Series A"], preferred_signals: ["raised a Series A"] },
    want: { count: 3, geography: US, size: S11_50, hiring: null, funding: { round: "series a", window: null } } },
  { cat: "3 hiring + funding", q: "Find 3 US software companies with 11-50 employees that raised funding and are hiring sales.",
    o: { required_signal_terms: ["funding", "sales"] },
    want: { count: 3, geography: US, hiring: { families: ["gtm_sales"], window: null }, funding: { round: undefined, window: null } } },
  { cat: "4 size band 51-200", q: "Find 3 US software companies with 51-200 employees hiring engineers.",
    o: { employee_range: { min: 51, max: 200 }, required_signal_terms: ["engineers"] },
    want: { size: { min: 51, max: 200 }, hiring: { families: ["engineering"], window: null } } },
  { cat: "4 size band 201-500", q: "Find 3 US software companies with 201-500 employees hiring sales.",
    o: { employee_range: { min: 201, max: 500 }, required_signal_terms: ["sales"] },
    want: { size: { min: 201, max: 500 } } },
  { cat: "5 US geography", q: "Find 3 software companies in the United States with 11-50 employees hiring sales.",
    o: { required_signal_terms: ["sales"] }, want: { geography: US } },
  { cat: "6 non-US geography", q: "Find 3 software companies in Germany with 11-50 employees hiring sales.",
    o: { geographies: ["Germany"], required_signal_terms: ["sales"] },
    want: { geography: "Germany", hiring: { families: ["gtm_sales"], window: null } } },
  { cat: "7 role family: account executives", q: "Find 3 US software companies with 11-50 employees hiring account executives.",
    o: { required_signal_terms: ["account executives"] }, want: { hiring: { families: ["gtm_sales"], window: null } } },
  { cat: "7 role family: customer success", q: "Find 3 US software companies with 11-50 employees hiring customer success managers.",
    o: { required_signal_terms: ["customer success managers"] }, want: { hiring: { families: ["customer_success"], window: null } } },
  { cat: "7 role family: growth marketer", q: "Find 3 US software companies with 11-50 employees hiring a growth marketer.",
    o: { required_signal_terms: ["growth marketer"] }, want: { hiring: { families: ["marketing_growth"], window: null } } },
  { cat: "8 count = 1", q: "Find 1 US software company with 11-50 employees hiring sales.",
    o: { requested_opportunity_count: 1, required_signal_terms: ["sales"] }, want: { count: 1 } },
  { cat: "9 count = 3", q: "Find 3 US software companies with 11-50 employees hiring sales.",
    o: { required_signal_terms: ["sales"] }, want: { count: 3 } },
  { cat: "10 count beyond the pool", q: "Find 25 US software companies with 11-50 employees hiring sales.",
    o: { requested_opportunity_count: 25, required_signal_terms: ["sales"] }, want: { count: 25 } },
  { cat: "11 recent funding window", q: "Find 3 US software companies with 11-50 employees that raised funding in the last 90 days.",
    o: { required_signal_terms: ["funding"] }, want: { funding: { round: undefined, window: 90 }, hiring: null } },
  { cat: "12 recent hiring window", q: "Find 3 US software companies with 11-50 employees hiring sales in the last 30 days.",
    o: { required_signal_terms: ["sales"] }, want: { hiring: { families: ["gtm_sales"], window: 30 } } },
  { cat: "12 recent hiring window (posted jobs)", q: "Find 3 US software companies with 11-50 employees that posted sales jobs in the last 30 days.",
    o: { required_signal_terms: ["sales"] }, want: { geography: US, hiring: { families: ["gtm_sales"], window: 30 } } },
  { cat: "0 no signal (profile only)", q: "Find 3 US software companies with 11-50 employees.",
    want: { count: 3, geography: US, size: S11_50, hiring: null, funding: null } },
];

for (const row of MISSION_ROWS) {
  Deno.test(`[matrix] ${row.cat}: ${row.q}`, () => {
    const got = hardOf(row.q, row.o);
    assertEquals(got.industry, "software", "industry is always hard here");
    for (const [k, v] of Object.entries(row.want)) {
      assertEquals(got[k as keyof Hard], v, `${k} — got ${JSON.stringify(got)}`);
    }
  });
}

// ══════════ WORDING VARIANTS: ONE INTENT, ONE HARD REQUIREMENT ══════════════

const SALES_VARIANTS: Array<[string, string[]]> = [
  ["Find 3 US software companies with 11-50 employees that are currently hiring sales.", ["sales"]],
  ["Find 3 US software companies with 11-50 employees recruiting salespeople.", ["salespeople"]],
  ["Find 3 US software companies with 11-50 employees with open sales roles.", ["sales"]],
  ["Find 3 US software companies with 11-50 employees currently hiring SDRs.", ["SDR"]],
  ["Find 3 US software companies with 11-50 employees that posted sales jobs.", ["sales"]],
  ["Find 3 US software companies with 11-50 employees with open sales positions.", ["sales"]],
];

Deno.test("[matrix] wording variants: hiring sales / recruiting salespeople / open sales roles / hiring SDRs compile to one hard requirement", () => {
  const compiled = SALES_VARIANTS.map(([q, terms]) => ({ q, h: hardOf(q, { required_signal_terms: terms }) }));
  for (const { q, h } of compiled) {
    assertEquals(h.hiring?.families, ["gtm_sales"], `${q} → ${JSON.stringify(h)}`);
    assertEquals([h.count, h.geography, h.size], [3, US, S11_50], q);
  }
});

Deno.test("[matrix] wording variants: the canonical signal reader agrees (hiring, never a social post)", () => {
  for (const [q] of SALES_VARIANTS) {
    const kinds = readCanonicalSignals(q).map((r) => r.kind);
    assert(kinds.includes("hiring"), `${q} → ${kinds.join(",")}`);
    assertFalse(kinds.includes("social_activity"), `${q} reads as a social post`);
  }
});

Deno.test("[matrix] wording guard: an open-source company is not a hiring request", () => {
  const h = hardOf("Find 3 US open source software companies with 11-50 employees.");
  assertEquals(h.hiring, null);
});

// ══════════ EVIDENCE / SIZE / ROUTE ROWS (categories 10, 13–20) ═════════════

const jobRow = (o: { id?: string; title?: string; body?: string; slug?: string; band?: [number, number] | null; altUrl?: string } = {}) => {
  const slug = o.slug ?? "acme";
  return {
    id: o.id ?? `job-${slug}`, title: o.title ?? "Account Executive", jobState: "LISTED",
    postedDate: "2026-10-12T06:00:00.000Z", linkedinUrl: `https://www.linkedin.com/jobs/view/${o.id ?? slug}/`,
    descriptionText: o.body ?? "Join our sales team.",
    ...(o.altUrl ? { companyLinkedinUrl: o.altUrl } : {}),
    company: {
      id: slug, name: `${slug[0].toUpperCase()}${slug.slice(1)}`, universalName: slug,
      linkedinUrl: `https://www.linkedin.com/company/${slug}`, website: `https://${slug}.com`,
      ...(o.band === null ? {} : { employeeCountRange: { start: (o.band ?? [11, 50])[0], end: (o.band ?? [11, 50])[1] } }),
      industries: [{ name: "Software Development" }],
      locations: [{ headquarter: true, country: "US", parsed: { text: "Austin, TX, United States" } }],
    },
  } as Record<string, unknown>;
};
const SALES = { role_families: ["gtm_sales"], window_days: null };

Deno.test("[matrix] 10 count beyond available: 2 of 3 with nothing left to read is search_exhausted, never completed", () => {
  const d = decideAutoContinuation({
    cancelled: false, qualified: 2, requestedCount: 3, frontierRemaining: 0, continuationsUsed: 2, maxContinuations: 10,
    costUnitsUsed: 4, maxCostUnits: 40, barrenSlices: 0, providerFailed: false, pendingRuns: 0,
    verificationRoutesRemain: 0, discoveryRoutesRemain: false,
  });
  assertFalse(d.continue);
  const o = settleV2Outcome({ continuing: false, stopReason: d.reason, legacyStatus: "completed", legacyQuota: {},
    canonicalQualified: 2, requestedCount: 3, companyIsDeliverable: true } as never);
  assertEquals([o.terminal, o.delivered, o.requested], ["search_exhausted", 2, 3]);
});

Deno.test("[matrix] 13 partial size overlap: 40-70 requested, declared 51-200 — continues to enrichment", () => {
  const v = prequalifyNormalizedCompany(jobEmployerToCompany(jobRow({ band: [51, 200] }))!, { min: 40, max: 70 });
  assertEquals([v.exclusion, v.eligible], [null, true]);
});

Deno.test("[matrix] 14 ambiguous identity: an identity conflict keeps a disjoint company in play", () => {
  const c = jobEmployerToCompany(jobRow({ band: [1001, 5000] }))!;
  const blocker = discoverySizeRejectBlocker({
    identity_conflicts: [{ kind: "linkedin_url", existing: "https://www.linkedin.com/company/other", incoming: c.linkedin_company_url }],
  });
  const v = prequalifyNormalizedCompany(c, S11_50, { early_size_reject_blocker: () => blocker });
  assertEquals([v.exclusion, v.eligible], [null, true]);
});

Deno.test("[matrix] 15 employer conflict: a posting naming another employer proves nothing for this one", () => {
  assertEquals(jobEmployerIdentityConflict(jobRow({ altUrl: "https://www.linkedin.com/company/someone-else" })), "structured_employer_conflict");
  assertEquals(jobEmployerIdentityConflict(jobRow()), null);
});

Deno.test("[matrix] 16 agency posting: 'on behalf of our client' cannot prove the poster is hiring", () => {
  assertEquals(jobEmployerIdentityConflict(jobRow({ body: "We are recruiting on behalf of our client, a Series A SaaS company." })),
    "agency_client_posting");
});

Deno.test("[matrix] 17 duplicate provider page: identical rows are a duplicate; the same count of new rows is not", () => {
  const page = [jobRow({ id: "1" }), jobRow({ id: "2" })];
  assertEquals(engine.discoveryPageFingerprint(page), engine.discoveryPageFingerprint(structuredClone(page).reverse()));
  assert(engine.discoveryPageFingerprint(page) !== engine.discoveryPageFingerprint([jobRow({ id: "3" }), jobRow({ id: "4" })]));
});

Deno.test("[matrix] 18 provider input limit: four titles compile within the actor's limit of three", () => {
  const titles = actorInputs.boundJobDiscoveryTitles(["account executive", "sales development representative", "business development representative", "sales manager"], SALES, actorInputs.JOB_DISCOVERY_LIMITS.jobTitles);
  assert(titles.length <= actorInputs.JOB_DISCOVERY_LIMITS.jobTitles);
  const c = actorInputs.compileHarvestJobDiscoveryInput({ jobTitles: titles, locations: ["United States"], postedLimit: "month", maxItems: 30 } as never);
  assert(c.ok, c.ok ? "" : c.errors.join("; "));
});

Deno.test("[matrix] 19 no useful discovery route: a lineage that cannot widen ends, it does not idle", () => {
  const d = decideAutoContinuation({
    cancelled: false, qualified: 0, requestedCount: 3, frontierRemaining: 0, continuationsUsed: 1, maxContinuations: 10,
    costUnitsUsed: 2, maxCostUnits: 40, barrenSlices: 0, providerFailed: false, pendingRuns: 0,
    verificationRoutesRemain: 0, discoveryRoutesRemain: false,
  });
  assertFalse(d.continue);
  const o = settleV2Outcome({ continuing: false, stopReason: d.reason, legacyStatus: "completed", legacyQuota: {},
    canonicalQualified: 0, requestedCount: 3, companyIsDeliverable: true } as never);
  assertEquals(o.terminal, "search_exhausted");
});

Deno.test("[matrix] 20 evidence contradiction: a trusted contrary reading replaces proof; a weaker one does not", () => {
  const obs = (status: string, confidence: string, value: unknown, firstParty = true) => ({
    evidence: [{ dimension: "business_model", value, status, confidence, valid_until: "2099-01-01T00:00:00Z",
      derived_from: firstParty ? ["web_page:https://acme.com/"] : [] }],
  }) as never;
  const proven = obs("proven", "high", "b2b");
  assert(engine.observationMayReplace(proven, obs("disproven", "medium", "b2c")), "a decisive contradiction replaces and stays visible");
  assertFalse(engine.observationMayReplace(proven, obs("plausible", "low", "b2c", false)), "a weaker contrary reading does not");
  assertFalse(engine.observationMayReplace(proven, obs("proven", "medium", "b2b", false)), "a weaker re-read of the same proof does not");
});

Deno.test("[matrix] role precision: an off-role posting from the same search proves no sales hiring", () => {
  assert(jobProvesRequestedHiring(normalizeLinkedInJob(jobRow({ title: "Enterprise Account Executive" })), SALES));
  assertFalse(jobProvesRequestedHiring(normalizeLinkedInJob(jobRow({ title: "Account Manager" })), SALES));
});
