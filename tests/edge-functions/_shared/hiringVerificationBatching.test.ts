// ONE QUESTION, ASKED FOR SEVERAL COMPANIES AT A TIME.
//
// `hiring_verification` asked the provider once per company. The Actor accepts
// `company[]` up to 10, so a slice that could afford one paid search answered
// ONE company and left the rest unassessed.
//
// Run 07e973f1, live: eleven companies enriched, ONE hiring call,
// "the eligible set was empty (29 companies carried no hiring assessment)",
// nothing qualified, no canonical event written.
//
// ── THE BATCH SIZE WAS 10, ON A PREMISE THAT MEASUREMENT DISPROVED ─────────
//
// This file used to state that "a call takes ~48s whether it carries one
// company or ten", and 10 followed from it. Task 783fa163 ran the same Actor
// on the same twenty titles twice:
//
//     companies  queries  duration  per query  per company  run
//             1       20     72.0s      3.60s        72.0s  Ot2Jpwe8ezMvbe6Eu
//            10      200    796.4s      3.98s        79.6s  Zs5bYFGlnua1hJWYg
//
// The Actor fans out one query per company×title pair, so duration is LINEAR at
// ~4s a query — the flat-cost premise was simply wrong. Ten companies is ~800s,
// which is 6.4 of the lineage's 10 continuation slices spent watching one call.
//
// So the batch is now DERIVED from that measurement against a wait budget
// (`HIRING_BATCH_WAIT_BUDGET_MS / HIRING_MS_PER_COMPANY`), which is 3. These
// tests assert the derivation and the invariants, not the literal 3 — a future
// re-measurement should move the number without rewriting the file.
//
// THE SEMANTICS DO NOT CHANGE. Same twenty titles, same evidence standard,
// same `freeHiringAssessment` first and paid rows only ever upgrading. What
// changes is how many HTTP calls carry the same question.
//
// Pure. No network, no provider, no model call.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  HIRING_BATCH_WAIT_BUDGET_MS,
  HIRING_JOB_TITLES,
  HIRING_JOBS_PER_BATCH_COMPANY,
  HIRING_MS_PER_COMPANY,
  HIRING_VERIFICATION_BATCH_SIZE,
} from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import {
  createExecutionDeadline,
} from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";

/** Injected clock for the deadline tests at the end of this file. */
let now = 0;
import { compileHarvestJobSearchInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import {
  dedupeJobs,
  normalizeLinkedInJob,
} from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import { normalizeCompanyLinkedInUrl } from "../../../supabase/functions/_shared/structuredCompanyEnrichment.ts";

const url = (n: number) => `https://www.linkedin.com/company/co-${n}`;
const companies = (n: number) => Array.from({ length: n }, (_, i) => url(i + 1));

/** The batching the engine performs, expressed here so the shape is pinned. */
const batches = (urls: string[]) => {
  const out: string[][] = [];
  for (let i = 0; i < urls.length; i += HIRING_VERIFICATION_BATCH_SIZE) {
    out.push(urls.slice(i, i + HIRING_VERIFICATION_BATCH_SIZE));
  }
  return out;
};

// ── the size is derived from measurement, not chosen ──────────────────────

Deno.test("the batch size is the wait budget divided by the measured cost", () => {
  assertEquals(
    HIRING_VERIFICATION_BATCH_SIZE,
    Math.max(1, Math.min(10,
      Math.floor(HIRING_BATCH_WAIT_BUDGET_MS / HIRING_MS_PER_COMPANY))),
    "the constant must follow the measurement, not sit beside it",
  );
  assert(HIRING_VERIFICATION_BATCH_SIZE >= 1, "a batch of none asks nothing");
  assert(HIRING_VERIFICATION_BATCH_SIZE <= 10, "the Actor's own company[] ceiling");
});

Deno.test("a batch never keeps the lineage waiting past its budget", () => {
  // THE PROPERTY THE OLD SIZE VIOLATED. At 10 companies the wait was ~800s,
  // 6.4 of the 10 continuations a lineage gets — spent entirely on polling.
  assert(
    HIRING_VERIFICATION_BATCH_SIZE * HIRING_MS_PER_COMPANY
      <= HIRING_BATCH_WAIT_BUDGET_MS,
    "a batch that outlives the wait budget starves the lineage of continuations",
  );
});

// ── 11 companies partition into full batches plus a remainder ─────────────

Deno.test("11 companies partition into full batches and a remainder", () => {
  const B = HIRING_VERIFICATION_BATCH_SIZE;
  const b = batches(companies(11));
  assertEquals(b.length, Math.ceil(11 / B), "one call per batch, not one per company");
  for (const g of b.slice(0, -1)) {
    assertEquals(g.length, B, "every batch but the last is full");
  }
  assertEquals(b[b.length - 1].length, 11 - B * (b.length - 1), "the remainder");
  assert(b[b.length - 1].length >= 1, "and it is never empty");
});

Deno.test("the same companies are asked about, none dropped or repeated", () => {
  const all = companies(11);
  const flat = batches(all).flat();
  assertEquals(flat.length, all.length, "every company is asked about exactly once");
  assertEquals(new Set(flat).size, all.length, "and none twice");
  assertEquals(flat.sort(), [...all].sort());
});

Deno.test("fewer provider calls for the same work", () => {
  // The property that motivated this: one call per company becomes one per
  // batch. Still true at 3, and it is the property — not the count — that has
  // to hold if the measurement moves again.
  const before = 11;
  const after = batches(companies(11)).length;
  assert(after < before, `${after} calls must be fewer than ${before}`);
  assertEquals(after, Math.ceil(before / HIRING_VERIFICATION_BATCH_SIZE));
});

Deno.test("every batch compiles against the Actor's own limit", () => {
  for (const group of batches(companies(11))) {
    const c = compileHarvestJobSearchInput({
      company: group,
      jobTitles: HIRING_JOB_TITLES,
      maxItems: HIRING_JOBS_PER_BATCH_COMPANY * group.length,
    });
    assert(c.ok, `batch of ${group.length} must compile: ${JSON.stringify((c as { errors?: string[] }).errors)}`);
  }
});

Deno.test("a batch may never exceed the compiler's company ceiling", () => {
  // `compileHarvestJobSearchInput` caps `company[]` at 10, from the Actor's
  // verified card. The derived size must stay under it whatever the wait budget
  // says — which is what the `Math.min(10, …)` in the derivation is for.
  assert(HIRING_VERIFICATION_BATCH_SIZE <= 10);
  const atCeiling = compileHarvestJobSearchInput({
    company: companies(HIRING_VERIFICATION_BATCH_SIZE),
    jobTitles: HIRING_JOB_TITLES, maxItems: 10,
  });
  assert(atCeiling.ok, "the derived batch size must itself compile");
  const over = compileHarvestJobSearchInput({
    company: companies(11), jobTitles: HIRING_JOB_TITLES, maxItems: 10,
  });
  assertEquals(over.ok, false, "the compiler rejects a batch above its limit");
});

// ── the qualifier and evidence standard are untouched ─────────────────────

Deno.test("the twenty-title sales vocabulary is unchanged", () => {
  assertEquals(HIRING_JOB_TITLES.length, 20, "same breadth as the per-company call");
  const joined = HIRING_JOB_TITLES.join(" ").toLowerCase();
  assert(/sales/.test(joined), "the sales-role qualifier still reaches the provider");
  // Every batch carries the WHOLE vocabulary — batching must not shard titles.
  for (const group of batches(companies(11))) {
    const c = compileHarvestJobSearchInput({
      company: group, jobTitles: HIRING_JOB_TITLES,
      maxItems: HIRING_JOBS_PER_BATCH_COMPANY * group.length,
    });
    assertEquals(
      (c as { input?: { jobTitles?: string[] } }).input?.jobTitles?.length, 20,
      "each call asks the full question, not a slice of it",
    );
  }
});

Deno.test("a batch asks for what the calls it replaces would have asked for", () => {
  // Ten companies × ten rows each — the same per-company evidence depth, not a
  // shared pool that would starve the last company in the batch.
  const group = companies(10);
  const c = compileHarvestJobSearchInput({
    company: group, jobTitles: HIRING_JOB_TITLES,
    maxItems: HIRING_JOBS_PER_BATCH_COMPANY * group.length,
  });
  assertEquals((c as { input?: { maxItems?: number } }).input?.maxItems, 100);
});

// ── evidence is partitioned, never shared ─────────────────────────────────

const jobRow = (companyUrl: string, title: string, id: string) => ({
  id, title, linkedinUrl: `https://www.linkedin.com/jobs/view/${id}`,
  company: { name: "X", linkedinUrl: companyUrl, id: companyUrl },
});

Deno.test("a job row reaches only the company it names", () => {
  const group = [url(1), url(2), url(3)];
  const byUrl = new Map(group.map((u) => [normalizeCompanyLinkedInUrl(u)!, u]));

  const rows = [
    jobRow(url(1), "Account Executive", "j1"),
    jobRow(url(1), "Sales Operations", "j2"),
    jobRow(url(3), "Head of Sales", "j3"),
  ];

  const routed = new Map<string, string[]>();
  for (const raw of rows) {
    const j = normalizeLinkedInJob(raw as never);
    const owner = j.company_linkedin_url ? byUrl.get(j.company_linkedin_url) : undefined;
    if (!owner) continue;
    routed.set(owner, [...(routed.get(owner) ?? []), j.title ?? ""]);
  }

  assertEquals(routed.get(url(1))?.length, 2);
  assertEquals(routed.get(url(3))?.length, 1);
  assertEquals(
    routed.get(url(2)), undefined,
    "a company with no rows gets none — one company's opening cannot earn another's verdict",
  );
});

Deno.test("a row naming a company outside the batch is dropped, not attributed", () => {
  const byUrl = new Map([[normalizeCompanyLinkedInUrl(url(1))!, url(1)]]);
  const j = normalizeLinkedInJob(jobRow(url(99), "Account Executive", "jX") as never);
  const owner = j.company_linkedin_url ? byUrl.get(j.company_linkedin_url) : undefined;
  assertEquals(owner, undefined, "an unknown company's row must not land on a batch member");
});

Deno.test("routing survives URL formatting differences", () => {
  // The batch key and the row both go through `normalizeCompanyLinkedInUrl`, so
  // a trailing slash or a scheme difference cannot orphan a company's evidence.
  const a = normalizeCompanyLinkedInUrl("https://www.linkedin.com/company/acme/");
  const b = normalizeCompanyLinkedInUrl("http://linkedin.com/company/acme");
  assertEquals(a, b);
  assert(a);
});

Deno.test("duplicate rows from a batch are deduplicated per company", () => {
  // The Actor returned 25% duplicate rows in one observed pack; a batch makes
  // that more likely, not less.
  const jobs = [
    normalizeLinkedInJob(jobRow(url(1), "Account Executive", "j1") as never),
    normalizeLinkedInJob(jobRow(url(1), "Account Executive", "j1") as never),
  ];
  assertEquals(dedupeJobs(jobs).length, 1);
});

// ── idempotency: the key must not depend on batch composition ─────────────

Deno.test("the operation key is per company, not per batch", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = ENGINE.indexOf("const hiringOperationKey");
  assert(i > 0, "hiring verification must derive a per-company operation key");
  const block = ENGINE.slice(i, i + 900);
  assert(
    /input_fingerprint: inputFingerprint\(\{\s*company: \[url\]/.test(block),
    "the fingerprint must be the SINGLE-company input — a batch-derived key " +
      "changes as batches change and would re-POST answered companies",
  );
  assert(block.includes("company_key: c.key"), "keyed by the company it answers for");
});

Deno.test("a company already answered is not re-asked", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = ENGINE.indexOf("const needsPaid:");
  const block = ENGINE.slice(i, i + 2600);
  assert(block.includes("shouldSkipProviderCall"), "the resume ledger is consulted");
  assert(block.includes("completed_operations.includes(opKey)"),
    "and so is this run's own record of what it has already asked");
});

Deno.test("every company in a batch is marked asked, including zero-result ones", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = ENGINE.indexOf("for (const g of group) {\n          asked.add(g.c.key);");
  assert(i > 0, "the whole batch is recorded as asked, not only the rows that returned");
  const block = ENGINE.slice(i, i + 400);
  assert(block.includes("completed_operations.push(g.opKey)"),
    "a company answered `no openings` has been investigated and must not be paid for twice");
});

Deno.test("a zero-result company gets an explicit investigated reason", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  assert(
    ENGINE.includes('asked.has(c.key) ? "job_search_returned_no_matching_role"'),
    "`we asked and there are none` must be distinguishable from `nobody looked`",
  );
});

// ── THE CLOCK QUESTION CHANGED, BECAUSE THE ANSWER WAS ALWAYS "NO" ────────
//
// This pinned `expired("apify_linkedin_job_search")`, whose estimate is 60s.
// The measurement above puts ONE company at ~72-80s, so that check is false
// from the start of the stage and every batch would be deferred for ever.
//
// It asks whether the call can FINISH. Since persist-on-start the run id
// reaches `lead_execution_calls` before any polling — run 783fa163's
// Zs5bYFGlnua1hJWYg was durably recorded and adopted from `pending_runs` — so a
// slice killed mid-poll loses nothing and the next one re-reads the run for
// free. The answerable question is whether it can be STARTED and written down.

Deno.test("the deadline is checked per batch, not per company", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  // ANCHORED ON THE LOOP, whatever it iterates. It ran over `needsPaid` in
  // fixed strides until in-flight batches began being re-formed first, so it
  // now walks a prepared `batches` list — the guard inside is the invariant,
  // not the loop header.
  const i = ENGINE.indexOf("for (let i = 0; i < batches.length; i++)");
  assert(i > 0, "the hiring stage must still batch its calls");
  // WIDE ENOUGH FOR THE WHOLE GATE. The loop now also asks what the batch will
  // OWE — `canStartHiringBatch` reserves the qualification budget of companies
  // already verified — and that pushed the durable-start check past a 1400-char
  // window. The invariant below is unchanged; only the block that has to
  // contain it grew.
  const block = ENGINE.slice(i, i + 3000);
  assert(
    block.includes("deps.deadline?.expiredForDurableStart()"),
    "a batch costs one call, so one start's budget is what must be available",
  );
  assertEquals(
    block.includes('deps.deadline?.expired("apify_linkedin_job_search")'), false,
    "asking whether a 796s call fits a 125s slice defers hiring for ever",
  );
});

Deno.test("a durable start is affordable where completion never is", () => {
  const d = createExecutionDeadline({ budgetMs: 125_000, now: () => now });
  now = 96_000; // the live moment: ~29s left
  assertEquals(
    d.expired("apify_linkedin_job_search"), true,
    "29s cannot COMPLETE a call measured at 72s for a single company",
  );
  assertEquals(
    d.expiredForDurableStart(), false,
    "but it is ample to POST the run and persist its id",
  );
  now = 118_000; // ~7s left — not even enough to start and write
  assertEquals(d.expiredForDurableStart(), true, "a start still needs room to be recorded");
});

Deno.test("the engine DROPS an unattributable row rather than guessing an owner", () => {
  // The routing test above reimplements the partition locally, so it passes
  // even if the engine misattributes — the same call-site hole that shipped the
  // compiler fold and the frontier count. Pinned by source.
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = ENGINE.indexOf("for (const raw of rows) {\n          if (jobEmployerIdentityConflict(raw)) continue;\n          const j = normalizeLinkedInJob(raw);");
  assert(i > 0, "the batch partition must exist");
  const block = ENGINE.slice(i, i + 500);
  assert(
    /if \(!owner\) continue;/.test(block),
    "a row whose company is not in this batch must be dropped outright — " +
      "attributing it to any batch member is how one company's opening earns another's verdict",
  );
  assert(
    block.includes("byUrl.get(j.company_linkedin_url)"),
    "ownership comes from the row's own company URL, never from position",
  );
});

// ── A PENDING RUN BELONGS TO THE QUESTION THAT STARTED IT ─────────────────
//
// Run ede69c8c, live, on the first batched mission. Batching worked — ten
// companies in one call, then one — but BOTH ledger rows carried the same
// provider_run_id:
//
//   call 1  companies=10  run_id=ju8MYeOYSgoQ9zBAv  timed_out
//   call 2  companies=1   run_id=ju8MYeOYSgoQ9zBAv  timed_out
//
// The batch of ten timed out and was recorded pending; the batch of one then
// ADOPTED it, because adoption matched on capability+provider alone. That
// company was never asked about, and the other batch's answer would have been
// read as its own.
//
// The flaw predates batching — a per-company call would have inherited another
// company's run the same way — but a batch of ten beside a batch of one is
// what made it unmissable.

Deno.test("adoption requires the same input, not just the same stage", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = ENGINE.indexOf("const inFlight = (opts.state?.pending_runs ?? []).find(");
  assert(i > 0, "the adoption lookup must exist");
  const block = ENGINE.slice(i, i + 400);
  assert(
    block.includes("r.input_fingerprint === thisFingerprint"),
    "a run may only be adopted by a call asking the same question",
  );
  assert(
    block.includes("!!r.input_fingerprint"),
    "an entry with no recorded question is not adopted — one re-POST is cheaper " +
      "than attributing one batch's answer to another",
  );
});

Deno.test("a pending run records what it was asked", () => {
  const ENGINE = Deno.readTextFileSync(
    new URL("../../../supabase/functions/_shared/leadCapabilityEngine.ts", import.meta.url),
  );
  const i = ENGINE.indexOf("state.pending_runs.push({");
  const block = ENGINE.slice(i, i + 500);
  assert(
    block.includes("input_fingerprint: attemptFingerprint"),
    "without the fingerprint the adoption check above can never match",
  );
});
