import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { replayEmptyEnrichment } from "./emptyEnrichmentReplay.ts";

Deno.test("answered-empty enrichment is not purchased again when another company's enrichment is retried", async () => {
  const run = await replayEmptyEnrichment();
  assertEquals(run.first.companies.length, 11);
  const answered = run.first.companies.filter((c) =>
    c.enrichment_outcome === "empty"
  );
  const retry = run.first.companies.filter((c) =>
    c.enrichment_outcome === "provider_error"
  );
  assertEquals(answered.length, 10);
  assertEquals(retry.length, 1);
  assertEquals(
    run.calls.length,
    1,
    "Only the one unfinished company needs a new company-details batch",
  );
  assertEquals(
    run.calls.flat(),
    retry.map((c) => c.identity!.linkedin_company_url),
  );
  assertEquals(
    run.qualified,
    [],
    "An empty provider answer never becomes qualification evidence",
  );
  assert(run.second.companies.every((c) => c.enrichment_outcome === "empty"));
  assert(run.checks.every((c) => c.eligibility !== "eligible"));
  assertEquals(
    run.thirdCalls,
    [],
    "No company is still owed an enrichment read after all answers are empty",
  );
});

for (
  const retryOutcome of ["provider_error", "deferred", "not_attempted"] as const
) {
  Deno.test(`unanswered enrichment is still retried: ${retryOutcome}`, async () => {
    const run = await replayEmptyEnrichment({ retryOutcome });
    assertEquals(run.calls.flat().length, 1);
    assertEquals(run.qualified, []);
    assert(run.second.companies.every((c) => c.enrichment_outcome === "empty"));
    assert(
      run.second.companies.every((c) =>
        c.stage_block?.capability !== "company_enrichment"
      ),
    );
    assertEquals(run.thirdCalls, []);
  });
}

Deno.test("an older checkpoint without enrichment outcome still gets its first evidence request", async () => {
  const run = await replayEmptyEnrichment({ legacyMissingOutcome: true });
  assertEquals(run.calls.flat().length, 1);
  assertEquals(run.qualified, []);
});

Deno.test("a retry that still fails stays unanswered and retryable; no empty evidence is fabricated", async () => {
  const run = await replayEmptyEnrichment({ retryAnswer: "failed" });
  assertEquals(run.calls.flat().length, 1);
  assertEquals(
    run.second.companies.filter((c) =>
      c.enrichment_outcome === "provider_error"
    ).length,
    1,
  );
  assertEquals(
    run.second.companies.filter((c) => c.enrichment_outcome === "empty").length,
    10,
  );
  assertEquals(
    run.thirdCalls.flat().length,
    1,
    "The unanswered company still gets its owed retry",
  );
  assertEquals(run.qualified, []);
});

Deno.test("a retry that returns a real record retains its normal success path and is not bought again", async () => {
  const run = await replayEmptyEnrichment({ retryAnswer: "success" });
  assertEquals(run.calls.flat().length, 1);
  assertEquals(
    run.second.companies.filter((c) => c.enrichment_outcome === "success")
      .length,
    1,
  );
  assertEquals(
    run.second.companies.filter((c) => c.enrichment_outcome === "empty").length,
    10,
  );
  assertEquals(run.thirdCalls, []);
  assertEquals(run.second.companies.find((c) => c.enriched)?.stage_block, null);
});

Deno.test("the enforced execution spine avoids changed-batch purchases of already-answered companies", async () => {
  const run = await replayEmptyEnrichment({
    specMode: "enforce",
    initialRecord: true,
    emptyCompanies: 11,
  });
  assertEquals(run.first.companies.length, 12);
  assertEquals(
    run.first.companies.filter((c) => c.enrichment_outcome === "empty").length,
    9,
  );
  assertEquals(
    run.first.companies.filter((c) => c.enrichment_outcome === "success")
      .length,
    1,
  );
  assertEquals(
    run.first.companies.filter((c) => c.enrichment_outcome === "provider_error")
      .length,
    2,
  );
  assertEquals(
    run.calls,
    [],
    "Only the original unanswered batch remains; its prior reservation still guards it",
  );
  assertEquals(run.thirdCalls, []);
  assertEquals(
    run.second.companies.filter((c) => c.enriched).length,
    1,
    "Prior real evidence is preserved",
  );
  assertEquals(
    run.second.companies.filter((c) =>
      c.enrichment_outcome === "provider_error"
    ).length,
    2,
    "A guarded unanswered call never becomes empty evidence",
  );
  assertEquals(run.qualified, []);
});
