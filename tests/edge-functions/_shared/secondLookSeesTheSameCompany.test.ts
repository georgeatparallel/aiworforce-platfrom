// A SECOND LOOK MUST NOT BE SHOWN A NARROWER COMPANY THAN THE FIRST.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// P4 runs in `run-agent`, outside the capability walk, and it assembled its own
// registry rather than calling the engine's. The copy was written as:
//
//     buildCompanyEvidence({
//       company: (c?.enriched ?? c?.company)!,
//       company_key: companyKey,
//       identity: c?.identity ?? null,     // declared `identity_state`
//       jobs: c?.hiring_jobs ?? [],        // declared `commercial_jobs`
//     } as never)
//
// `as never` silenced both. Neither field was read, so every re-evaluation in
// every run was handed a company with NO commercial job evidence, NO strongest
// signal, and `identity_state: "not_attempted"` for an identity the first pass
// had verified — plus, from the omitted registry inputs, no funding round, no
// expansion or launch evidence, no provider failures and no employee-count
// alternatives. Nine fields, one cast.
//
// The comment above it claimed the opposite: "the same builder the first pass
// used, so a re-evaluation never sees a narrower company". A comment cannot
// keep two copies of a builder in step. There is now one builder.
//
// ZERO network, ZERO models, ZERO providers, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCompanyEvidence } from "../../../supabase/functions/_shared/leadCompanyEvidence.ts";

const company = {
  company_name: "Acme", canonical_domain: "acme.com",
  linkedin_company_url: "https://www.linkedin.com/company/acme",
  employee_count: 120, geography: "London, United Kingdom",
  description: "Acme builds workflow software.", industry_ids: [],
  provider_industry: "Software Development",
} as never;

const jobs = [{ title: "Account Executive", url: "https://x/1", location: "London" }];

// ══════════ 1. the property the cast hid ══════════════════════════════════

Deno.test("1. the misnamed fields produce a STRICTLY narrower company", () => {
  // What the P4 copy passed.
  const asItWas = buildCompanyEvidence({
    company, company_key: "acme.com",
    identity: { status: "verified_match" },
    jobs,
  } as never);

  // What the builder actually declares.
  const asItShould = buildCompanyEvidence({
    company, company_key: "acme.com",
    source_capability: "general_company_discovery",
    identity_state: "resolved",
    commercial_jobs: jobs,
    strongest_signal: "Account Executive",
  } as never);

  assertEquals(asItWas.commercial_job_evidence.length, 0,
    "`jobs` is not `commercial_jobs`; the second pass saw no commercial hiring");
  assertEquals(asItWas.identity_state, "not_attempted",
    "`identity` is not `identity_state`; a verified match read as never attempted");
  assertEquals(asItWas.strongest_signal, null);
  assert(asItWas.missing_fields.includes("commercial_job_evidence"),
    "and the record even declared the gap it had invented");

  assertEquals(asItShould.commercial_job_evidence.length, 1);
  assertEquals(asItShould.identity_state, "resolved");
  assertEquals(asItShould.strongest_signal, "Account Executive");
});

// ══════════ 2. there is ONE builder, and P4 calls it ══════════════════════

Deno.test("2. run-agent no longer assembles a company record of its own", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url),
  );
  // The name may still appear in the comment that records why it left.
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(!code.includes("buildCompanyEvidence"),
    "the second look must not build its own company record — that is the drift");
  assert(src.includes("engineRun.rebuild_registry("),
    "it must call the engine's own builder");
});

Deno.test("3. the engine exposes that builder, and it takes the fetched pages", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  assert(src.includes("rebuild_registry:"), "the run must carry the builder across the boundary");
  // Since 2026-10-11 the first pass also carries the company's verified
  // website statements from the checkpoint (evidenceMonotonicity.test.ts) —
  // still one builder, still the second look's pages taking precedence.
  assert(src.includes("web_pages: withVerifiedWebStatements(c, webPages)"),
    "one builder serves both passes: the second supplies pages, the first only what a website re-read already proved");
  // And the builder is reachable from the run's own scope, not trapped inside a
  // stage that a resumed slice might never enter.
  const decl = src.indexOf("const registryFor = (");
  const stage = src.indexOf("const registries = new Map(");
  assert(decl > 0 && stage > 0 && decl < stage,
    "registryFor must be declared in the run scope, above the stage that uses it");
});
