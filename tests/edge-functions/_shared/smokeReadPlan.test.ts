// The smoke's Apify read plan, vendor cap and billed-result bounds, as pure
// functions. The full lifecycle against the real admission RPC is in
// tests/db-contract/smokeAdmissionRuntime.contract.test.ts ("read lifecycle").
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  APIFY_MAX_WAIT_S, apifyRunSettled, planSmokeReceipt, planSmokeStart, planSmokeStatusRead,
} from "../../../supabase/functions/_shared/smokeAdmissionRefusal.ts";
import { boundRequest, classifyRequest, type PhysicalRequest } from "../../../supabase/functions/_shared/smokeAdmission.ts";
import { boundJobDiscoveryForSmoke, compileHarvestJobDiscoveryInput } from "../../../supabase/functions/_shared/hiringActorInputs.ts";
import {
  buildCuriousCoderLinkedInJobsInput, buildCuriousCoderSmokeJobsInput,
} from "../../../supabase/functions/_shared/curiousCoderJobsInput.ts";

const T0 = Date.parse("2026-10-16T12:00:00Z");

Deno.test("read plan: a run is bought only when its status and dataset reads and its time remain", () => {
  assertEquals(planSmokeStart({ readsLeft: 3, remainingMs: 75_000 }), { ok: true });
  // The final run: status and dataset; its receipt is deferred to reconciliation.
  assertEquals(planSmokeStart({ readsLeft: 2, remainingMs: 300_000 }), { ok: true });
  assertEquals(planSmokeStart({ readsLeft: 1, remainingMs: 300_000 }), { ok: false, reason: "reads_exhausted" });
  assertEquals(planSmokeStart({ readsLeft: 0, remainingMs: 300_000 }), { ok: false, reason: "reads_exhausted" });
  assertEquals(planSmokeStart({ readsLeft: 5, remainingMs: 74_999 }), { ok: false, reason: "no_time" });
  // Unknown is not a reason to refuse a purchase the database bounds; it never spends a read.
  assertEquals(planSmokeStart({ readsLeft: null, remainingMs: null }), { ok: true });
  assertEquals(planSmokeStatusRead({ readsLeft: null, remainingMs: 300_000 }), { ok: false, reason: "read_state_unknown" });
});

Deno.test("read plan: a status read waits at most 60 s and always keeps the dataset's read and time", () => {
  assertEquals(planSmokeStatusRead({ readsLeft: 5, remainingMs: 300_000 }), { ok: true, waitS: APIFY_MAX_WAIT_S, timeoutMs: 70_000 });
  assertEquals(planSmokeStatusRead({ readsLeft: 3, remainingMs: 90_000 }), { ok: true, waitS: 40, timeoutMs: 50_000 });
  // Two left: the status read and the dataset's; the receipt is the one deferred.
  assertEquals(planSmokeStatusRead({ readsLeft: 2, remainingMs: 300_000 }), { ok: true, waitS: APIFY_MAX_WAIT_S, timeoutMs: 70_000 });
  assertEquals(planSmokeStatusRead({ readsLeft: 1, remainingMs: 300_000 }), { ok: false, reason: "reads_reserved" });
  assertEquals(planSmokeStatusRead({ readsLeft: 5, remainingMs: 54_999 }), { ok: false, reason: "no_time" });
  // The client timeout never outlasts the time left.
  for (let ms = 55_000; ms <= 300_000; ms += 5_000) {
    const p = planSmokeStatusRead({ readsLeft: 3, remainingMs: ms });
    assert(p.ok && p.timeoutMs + 40_000 <= ms, `${ms}`);
  }
});

Deno.test("read plan: the receipt waits until settled, and needs its read (and the dataset's) and the time", () => {
  const fin = T0 - 4_000;
  assertEquals(planSmokeReceipt({ readsLeft: 2, remainingMs: 60_000 }, { finishedAtMs: fin, nowMs: T0, needDataset: true }), { ok: true, waitMs: 6_000 });
  assertEquals(planSmokeReceipt({ readsLeft: 1, remainingMs: 60_000 }, { finishedAtMs: fin, nowMs: T0, needDataset: true }), { ok: false, reason: "reads_exhausted" });
  assertEquals(planSmokeReceipt({ readsLeft: 1, remainingMs: 60_000 }, { finishedAtMs: fin, nowMs: T0, needDataset: false }), { ok: true, waitMs: 6_000 });
  assertEquals(planSmokeReceipt({ readsLeft: 2, remainingMs: 35_999 }, { finishedAtMs: fin, nowMs: T0, needDataset: true }), { ok: false, reason: "no_time" });
});

Deno.test("settled: terminal and finished at least 10 s ago; anything else is preliminary", () => {
  const at = (ms: number) => new Date(T0 - ms).toISOString();
  assert(apifyRunSettled({ status: "SUCCEEDED", finishedAt: at(10_000) }, T0));
  assert(apifyRunSettled({ status: "FAILED", finishedAt: at(60_000) }, T0));
  assert(!apifyRunSettled({ status: "SUCCEEDED", finishedAt: at(9_999) }, T0));
  assert(!apifyRunSettled({ status: "RUNNING", finishedAt: at(60_000) }, T0));
  assert(!apifyRunSettled({ status: "SUCCEEDED" }, T0), "no finish time, no settlement");
});

const req = (method: string, url: string, body: string | null = null): PhysicalRequest => ({ method, url: new URL(url), body });
const own = new URL("https://proj.supabase.co");
const start = (url: string, body: string) => {
  const r = req("POST", url, body);
  return { r, c: classifyRequest(r, own) as Parameters<typeof boundRequest>[1] };
};

Deno.test("vendor cap: every Apify start carries maxTotalChargeUsd no greater than the authorized maximum", () => {
  const url = "https://api.apify.com/v2/acts/a~b/runs?token=t";
  const cap = (u: string, max: number) => {
    const { r, c } = start(u, "{}");
    const b = boundRequest(r, c, { max_request_bytes: 100 }, max);
    assert(b.ok);
    return b.ok ? b.request.url.searchParams.get("maxTotalChargeUsd") : null;
  };
  assertEquals(cap(url, 5_000), "0.005", "absent: the maximum");
  assertEquals(cap(`${url}&maxTotalChargeUsd=1`, 5_000), "0.005", "higher: replaced");
  assertEquals(cap(`${url}&maxTotalChargeUsd=0.002`, 5_000), "0.002", "lower: kept");
  assertEquals(cap(`${url}&maxTotalChargeUsd=lots`, 5_000), "0.005", "unreadable: the maximum");
  const pinned = start(url, "{}");
  const b = boundRequest(pinned.r, pinned.c, { max_request_bytes: 100, pin_query: { maxTotalChargeUsd: "9" } }, 5_000);
  assert(b.ok && b.request.url.searchParams.get("maxTotalChargeUsd") === "0.005", "even a pinned value above the maximum");
  // Not an Apify start: untouched.
  const f = start("https://api.firecrawl.dev/v2/scrape", "{\"url\":\"u\"}");
  const fb = boundRequest(f.r, f.c, { max_request_bytes: 100 }, 5_000);
  assert(fb.ok && !fb.request.url.searchParams.has("maxTotalChargeUsd"));
});

Deno.test("array bound: billed-per-entry inputs hold at most the template's count; absent is allowed", () => {
  const url = "https://api.apify.com/v2/acts/harvestapi~linkedin-job-search/runs";
  const limits = { max_request_bytes: 4096, max_array_items: { jobTitles: 1, locations: 1, geoIds: 0 } };
  const check = (body: unknown) => {
    const { r, c } = start(url, JSON.stringify(body));
    return boundRequest(r, c, limits);
  };
  assert(check({ jobTitles: ["AE"], locations: ["United States"] }).ok);
  assert(check({ jobTitles: ["AE"] }).ok, "an absent location is one search, not more");
  assertEquals(check({ jobTitles: ["AE", "SE"] }), { ok: false, reason: "array_unbounded:jobTitles" });
  assertEquals(check({ jobTitles: ["AE"], locations: ["US", "CA"] }), { ok: false, reason: "array_unbounded:locations" });
  assertEquals(check({ jobTitles: ["AE"], geoIds: ["1"] }), { ok: false, reason: "array_unbounded:geoIds" });
  assertEquals(check({ jobTitles: "AE" }), { ok: false, reason: "array_unbounded:jobTitles" });
  // The legacy actor: `limitPerSource` is per URL, so a second URL is a second billed search.
  const legacy = "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs";
  const { r, c } = start(legacy, JSON.stringify({ urls: ["u1", "u2", "u3"], limitPerSource: 3 }));
  assertEquals(boundRequest(r, c, { max_request_bytes: 4096, max_array_items: { urls: 1 } }), { ok: false, reason: "array_unbounded:urls" });
});

Deno.test("smoke discovery: one title, one location, at most three rows; the compiler still validates it", () => {
  const proposed = { jobTitles: ["Account Executive", "Sales Executive", "AE"], locations: ["United States", "Canada"],
    geoIds: ["1"], maxItems: 50, postedLimit: "week" };
  const bounded = boundJobDiscoveryForSmoke(proposed, 3);
  assertEquals(bounded, { jobTitles: ["Account Executive"], locations: ["United States"], maxItems: 3, postedLimit: "week" });
  assertEquals(boundJobDiscoveryForSmoke({ ...proposed, maxItems: 2 }, 3).maxItems, 2, "a smaller ask is kept");
  assertEquals(boundJobDiscoveryForSmoke({ ...proposed, maxItems: undefined }, 1).maxItems, 1, "never above the candidate bound");
  const compiled = compileHarvestJobDiscoveryInput(bounded as never);
  assert(compiled.ok, JSON.stringify(compiled));
});

Deno.test("legacy jobs actor: the smoke shape has one URL, three per source, no `count`; the customer shape is unchanged", () => {
  const urls = ["https://www.linkedin.com/jobs/search/?keywords=a", "https://www.linkedin.com/jobs/search/?keywords=b"];
  assertEquals(buildCuriousCoderSmokeJobsInput({ urls }), { urls: [urls[0]], limitPerSource: 3, splitByLocation: false, scrapeCompany: true });
  const built = buildCuriousCoderSmokeJobsInput({ urls: null, keywords: "Account Executive", location: "United States" });
  assertEquals(built.urls.length, 1);
  assert(!("count" in built));
  // Outside the smoke the existing input is untouched (a general change needs its own review).
  assertEquals(buildCuriousCoderLinkedInJobsInput({ urls, maxResults: 25 }).count, 25);
});
