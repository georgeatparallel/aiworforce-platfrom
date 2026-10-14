import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  atFixtureTime,
  fixture,
  page,
  replayHiring,
  replayScreen,
  type ScreenRun,
} from "./screenHarness.ts";
import { spendOf } from "../lib/mission.ts";
import {
  type SpendLedger,
  spendTotals,
} from "../../../supabase/functions/_shared/budgetPolicy.ts";

function purchases(r: ScreenRun) {
  const ledger = r.state.spend_ledger!;
  const paid = spendOf(ledger);
  assertEquals(new Set(paid.paid_keys).size, paid.paid_keys.length);
  const bought = r.provider.calls.filter((c) => !c.adopted);
  assertEquals(
    new Set(bought.map((c) => c.idempotency_key)).size,
    bought.length,
  );
  for (const call of bought) {
    assert(
      ledger.reservations.some((r) =>
        r.idempotency_key === call.idempotency_key &&
        r.status !== "refused_budget"
      ),
    );
  }
  assertLedger(ledger);
}
function assertLedger(ledger: SpendLedger) {
  const paid = spendOf(ledger);
  const sum = paid.paid.reduce(
    (n, r) => n + (r.settled_usd ?? r.provisional_usd ?? r.estimate_usd),
    0,
  );
  assert(Math.abs(paid.committed_usd - sum) < 1e-9);
  assert(paid.committed_usd <= ledger.ceilings.mission_provider_usd + 1e-9);
}
Deno.test("[golden] G5 screened funding pool: one priced read, pass-first bounded admission, hiring still required", () =>
  atFixtureTime(async () => {
    const r = await replayScreen();
    for (const [verdict, slugs] of Object.entries(fixture().expected)) {
      for (const slug of slugs as string[]) {
        assertEquals(r.state.funding_screen?.verdicts[page(slug)], verdict);
      }
    }
    assertEquals(r.provider.calls.map((c) => c.actor), [
      "apify_linkedin_company_search",
      "apify_funding_atomus",
      "apify_linkedin_company_details",
    ]);
    assertEquals(r.provider.calls[0].input.scraperMode, "short");
    assertEquals(r.provider.calls[0].input.maxItems, 4);
    assertEquals(r.provider.calls[2].input.companies, [
      page("g5-seed"),
      page("g5-partial"),
    ]);
    assertEquals(r.state.funding_screen?.screened, true);
    assertEquals(spendOf(r.state.spend_ledger!).committed_usd, 0.0312);
    purchases(r);
    const v = await replayHiring(r);

    const seed = v.view.leads.find((l) => l.company.key === page("g5-seed"))!;
    assertEquals(seed.hard_checks, {
      geography: "pass",
      company_size: "pass",
      funding: "pass",
      hiring: "pass",
    });
    assertEquals(seed.bucket, "worth_considering");
    assertEquals(
      v.view.leads.find((l) => l.company.key === page("g5-partial"))?.bucket,
      "pending",
    );
    assertEquals(
      spendOf(v.ledgerBefore),
      spendOf(r.state.spend_ledger!),
      "screen spend survives reconstruction",
    );
    assertEquals(spendOf(v.ledger).committed_usd, 0.0522);
    assertLedger(v.ledger);
    assert(
      v.ledger.reservations.every((r) => r.settled_usd === null),
      "estimates are not provider receipts",
    );
    assertEquals(
      v.criteria.filter((c) => c.dimension === "company_stage").map((c) =>
        c.kind
      ),
      ["target", "target"],
      "stage preferences must not silently become hard requirements",
    );
  }));
Deno.test("[continuation] G5 JSON checkpoint resume never re-buys discovery or the screen", () =>
  atFixtureTime(async () => {
    const first = await replayScreen();
    const resumed = await replayScreen(fixture(), first);
    assertEquals(resumed.provider.calls.length, 0);
    assertEquals(resumed.state.funding_screen, first.state.funding_screen);
    assertEquals(
      spendOf(resumed.state.spend_ledger!),
      spendOf(first.state.spend_ledger!),
    );
    purchases(resumed);
  }));
Deno.test("[claims] G5 partial history is pending, complete stale history and a grant cannot satisfy venture funding", () =>
  atFixtureTime(async () => {
    const r = await replayScreen();
    assertEquals(
      r.state.funding_screen?.verdicts[page("g5-partial")],
      "pending",
    );
    for (const slug of ["g5-stale", "g5-grant"]) {
      assertEquals(
        r.companies.find((c) => c.key === page(slug))?.shortlist_exclusion,
        "funding_screen_fail",
      );
    }
    assertEquals(
      r.provider.calls.filter((c) => c.actor === "apify_funding_pvalyou")
        .length,
      0,
    );
  }));
Deno.test("[budget] G5 provider wait cannot fabricate funding or settle the estimate as a receipt", () =>
  atFixtureTime(async () => {
    const fx = fixture();
    fx.provider_responses.find((r) => r.actor === "apify_funding_atomus")!
      .pending_once = true;
    const r = await replayScreen(fx);
    assert(
      Object.values(r.state.funding_screen?.verdicts ?? {}).every((v) =>
        v === "pending"
      ),
    );
    assertEquals(
      r.provider.calls.filter((c) => c.actor === "apify_funding_atomus").map(
        (c) => c.pending,
      ),
      [true],
    );
    assert(
      r.state.spend_ledger!.reservations.some((r) =>
        r.status === "executed" || r.status === "reserved"
      ),
    );
    assertLedger(r.state.spend_ledger!);
    const resumed = await replayScreen(fx, r);
    assertEquals(
      resumed.provider.calls.filter((c) => c.actor === "apify_funding_atomus")
        .length,
      0,
    );
  }));
Deno.test("[provider-spec] G5 deterministic repeat: frozen dates, same calls, keys and committed spend", () =>
  atFixtureTime(async () => {
    const a = await replayScreen(), b = await replayScreen();
    assertEquals(a.provider.calls, b.provider.calls);
    assertEquals(
      spendOf(a.state.spend_ledger!),
      spendOf(b.state.spend_ledger!),
    );
    assertEquals(fixture().provenance.environment, "test");
    assertEquals(fixture().provenance.recorded_production_rows, 0);
  }));

Deno.test("[budget] G5 timeout after provider start leaves funding unknown and no fabricated receipt", () =>
  atFixtureTime(async () => {
    const r = await replayScreen(fixture(), undefined, "atomus-timeout");
    assertEquals(
      r.provider.calls.filter((c) => c.actor === "apify_funding_atomus").length,
      1,
    );
    assert(
      Object.values(r.state.funding_screen?.verdicts ?? {}).every((v) =>
        v === "pending"
      ),
    );
    assert(
      r.state.spend_ledger!.reservations.every((r) => r.settled_usd === null),
    );
    assertLedger(r.state.spend_ledger!);
  }));
Deno.test("[budget] G5 downstream hiring purchase is refused before provider when the carried ceiling cannot afford it", () =>
  atFixtureTime(async () => {
    const r = await replayScreen();
    r.state.spend_ledger!.ceilings.mission_provider_usd = 0.04;
    const v = await replayHiring(r);
    assertEquals(v.provider.calls.length, 0);
    assertEquals(
      v.view.leads.find((l) => l.company.key === page("g5-seed"))?.hard_checks
        .hiring,
      "unknown",
    );
    assertEquals(spendOf(v.ledger).committed_usd, 0.0312);
    assert(v.preflights.some((p) => p.result !== null));
    assertLedger(v.ledger);
  }));
Deno.test("[claims] G5 a funded company outside the employee band cannot qualify or buy hiring evidence", () =>
  atFixtureTime(async () => {
    const fx = fixture();
    const details = fx.provider_responses.find((r) =>
      r.actor === "apify_linkedin_company_details"
    )!;
    details.rows.find((r) => r.linkedinUrl === page("g5-seed"))!
      .employeeCountRange = { start: 201, end: 500 };
    const r = await replayScreen(fx), v = await replayHiring(r, fx);
    assertEquals(
      v.view.leads.find((l) => l.company.key === page("g5-seed"))?.hard_checks
        .company_size,
      "fail",
    );
    assert(
      v.provider.calls.every((c) =>
        !c.candidate_keys.includes(page("g5-seed"))
      ),
    );
  }));
Deno.test("[claims] G5 geography stays a hard requirement after a funding-screen pass", () =>
  atFixtureTime(async () => {
    const fx = fixture();
    const details = fx.provider_responses.find((r) =>
      r.actor === "apify_linkedin_company_details"
    )!;
    details.rows.find((r) => r.linkedinUrl === page("g5-seed"))!.locations = [{
      country: "CA",
      city: "Toronto",
      headquarter: true,
      parsed: { text: "Toronto, Canada", countryFull: "Canada" },
    }];
    const r = await replayScreen(fx), v = await replayHiring(r, fx);
    assertEquals(
      v.view.leads.find((l) => l.company.key === page("g5-seed"))?.hard_checks
        .geography,
      "fail",
    );
    assert(
      v.provider.calls.every((c) =>
        !c.candidate_keys.includes(page("g5-seed"))
      ),
    );
  }));
Deno.test("[claims] G5 a hard Seed-or-Series-A stage remains unproven when corroboration is unavailable", () =>
  atFixtureTime(async () => {
    const { missionCandidatesFrom } = await import(
      "../../../supabase/functions/_shared/leadCapabilityEngine.ts"
    );
    const { fundingStageVerifier } = await import(
      "../../../supabase/functions/_shared/fundingStageVerifier.ts"
    );
    const r = await replayScreen();
    const company = missionCandidatesFrom(r, {
      missionId: fixture().provenance.task_id,
    }).find((c) => c.company_key === page("g5-seed"))!;
    const target = {
      company_key: company.company_key,
      name: company.name,
      domain: company.domain,
      linkedin_url: company.linkedin_url,
      graph: company.graph,
      criterion: {
        criterion_id: "g5-hard-stage",
        dimension: "company_stage",
        value: "seed|series_a",
        window_days: null,
      },
    };
    const result = await fundingStageVerifier({ fallback: false }).verify([
      target,
    ], {
      call: () =>
        Promise.resolve({
          status: "refused" as const,
          reason: "SYNTHETIC corroboration unavailable",
        }),
      now: () => new Date().toISOString(),
      log: () => {},
      ready: () => true,
    }, { mission_id: fixture().provenance.task_id, pending: [] });
    assertEquals(result.findings[0]?.detail?.verdict, "pending");
  }));
