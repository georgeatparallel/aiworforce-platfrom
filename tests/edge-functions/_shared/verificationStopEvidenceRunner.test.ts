// LEAD V2 — THE PAGE RUNNER STOPS WITH ITS SLICE, AND NEVER LOSES A MAP.
//
// `runEvidenceCollection` buys Firecrawl `/map` and page fetches and may call
// a planner and an extraction model. Every one of those now asks `deps.stop`
// first. A company it does not finish is reported `stopped` — not an answer —
// and the pages it did fetch were written as they arrived.
//
// A `/map` this mission already bought is RECALLED by a later collection for the
// same company (`mapMemory`), instead of being asked again: the ledger skips a
// repeated map as executed and returns nothing, which read as
// `site_unavailable`.
//
// Scripted fetchers; no network.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type MapSelection, recordMapMemory, runEvidenceCollection,
} from "../../../supabase/functions/_shared/webEvidenceRunner.ts";
import {
  BUSINESS_MODEL_MAX_PAGES, BUSINESS_MODEL_PAGE_INTENTS, claimPageBudget, claimPageDebts, claimPagePlan,
} from "../../../supabase/functions/_shared/businessModelVerifier.ts";
import { VERIFICATION_OPS } from "../../../supabase/functions/_shared/verificationStop.ts";
import type { VerificationTarget } from "../../../supabase/functions/_shared/claimVerifier.ts";
import { buildCompanyEvidenceGraph } from "../../../supabase/functions/_shared/evidenceGraph.ts";

globalThis.fetch = () => { throw new Error("these tests must not reach the network"); };

const NOW = new Date("2026-09-24T16:00:00.000Z");
const STOP = { reason: "deadline", detail: "checkpoint reserve reached" };
const target = (slug: string): VerificationTarget => ({
  company_key: `k_${slug}`, name: slug, domain: `${slug}.com`, linkedin_url: null,
  criterion: { criterion_id: "bm", dimension: "business_model", value: "B2B SaaS", window_days: null },
  graph: buildCompanyEvidenceGraph(`k_${slug}`, [], { now: NOW }),
});
const siteMap = (domain: string) => [`https://${domain}/`, `https://${domain}/pricing`, `https://${domain}/product`, `https://${domain}/about`];
const PAGE = "We sell a B2B SaaS platform to finance teams. ".repeat(20);

interface Log { maps: string[]; fetches: string[]; plans: number; extracts: number; asked: Array<string | null | undefined> }

function collect(slugs: string[], o: {
  stop?: (log: Log, op?: string | null) => { reason: string; detail: string } | null;
  extract?: boolean;
  mapMemory?: ReturnType<typeof recordMapMemory>;
  mapReturns?: (domain: string) => string[];
} = {}) {
  const targets = slugs.map(target);
  const debts = claimPageDebts(targets);
  const log: Log = { maps: [], fetches: [], plans: 0, extracts: 0, asked: [] };
  const run = runEvidenceCollection({
    workspace_id: "ws", debts, budget: claimPageBudget(debts.length, BUSINESS_MODEL_PAGE_INTENTS, BUSINESS_MODEL_MAX_PAGES),
    deps: {
      plan: () => { log.plans++; return Promise.resolve(claimPagePlan(debts, BUSINESS_MODEL_PAGE_INTENTS)); },
      extract: o.extract ? () => { log.extracts++; return Promise.resolve({ claims: [] }); } : null,
      fetchPage: ({ url }) => { log.fetches.push(url); return Promise.resolve({ ok: true, markdown: PAGE, status: "ok", final_url: url }); },
      mapSite: ({ domain }) => { log.maps.push(domain); return Promise.resolve((o.mapReturns ?? siteMap)(domain)); },
      ...(o.stop ? { stop: (op?: string | null) => { log.asked.push(op); return o.stop!(log, op); } } : {}),
      ...(o.mapMemory ? { mapMemory: o.mapMemory } : {}),
    },
  });
  return { run, log };
}

Deno.test("RUNNER: stopped before it starts — no planner, no map, no page; every company `stopped`", async () => {
  const { run, log } = collect(["acme", "bolt"], { stop: () => STOP });
  const r = await run;
  assertEquals([log.plans, log.maps.length, log.fetches.length], [0, 0, 0]);
  assertEquals(r.companies.map((c) => c.outcome), ["stopped", "stopped"]);
  assertEquals(r.stopped, STOP);
});

Deno.test("RUNNER: stopped between pages — the next page is never fetched, later companies are not mapped", async () => {
  const { run, log } = collect(["acme", "bolt"], { stop: (l) => l.fetches.length >= 1 ? STOP : null });
  const r = await run;
  assertEquals(log.maps, ["acme.com"], "bolt was never mapped");
  assertEquals(log.fetches.length, 1, "one page, then the stop");
  assertEquals(r.companies.find((c) => c.company_key === "k_acme")?.outcome, "stopped", "cut short is not 'collected'");
  assertEquals(r.companies.find((c) => c.company_key === "k_acme")?.pages_ok, 1, "the page it did fetch is counted (and was written)");
  assertEquals(r.companies.find((c) => c.company_key === "k_bolt")?.outcome, "stopped");
});

Deno.test("RUNNER: each page and each map asks with its own latency key", async () => {
  const { run, log } = collect(["acme"], { stop: () => null });
  await run;
  assert(log.asked.includes(VERIFICATION_OPS.map));
  assert(log.asked.includes(VERIFICATION_OPS.page));
  assertEquals(log.asked.filter((x) => x === VERIFICATION_OPS.page).length, log.fetches.length, "asked before EVERY page");
});

Deno.test("RUNNER: no room left for the extraction model call — not made, the company `stopped`", async () => {
  const { run, log } = collect(["acme"], { extract: true, stop: (_l, op) => op === VERIFICATION_OPS.model && _l.fetches.length > 0 ? STOP : null });
  const r = await run;
  assertEquals(log.extracts, 0);
  assert(log.fetches.length > 0, "the pages were fetched first");
  assertEquals(r.companies[0].outcome, "stopped");
});

Deno.test("RUNNER: with no stop, exactly the previous behaviour", async () => {
  const a = collect(["acme", "bolt"]);
  const b = collect(["acme", "bolt"], { stop: () => null });
  const [ra, rb] = [await a.run, await b.run];
  assertEquals(rb.companies, ra.companies);
  assertEquals(b.log.fetches, a.log.fetches);
  assertEquals(rb.stopped, null);
  assert(ra.companies.every((c) => c.outcome === "collected"));
});

// ════════════════════════════════════════════════════════════ map memory ════

Deno.test("MAP MEMORY: a later collection for the same company recalls the map — not bought again, same pages", async () => {
  const store: Record<string, MapSelection> = {};
  const first = collect(["acme"], { mapMemory: recordMapMemory(store) });
  await first.run;
  assertEquals(first.log.maps, ["acme.com"]);
  // The next slice: the ledger would answer a repeated map with NOTHING (idempotent skip).
  const second = collect(["acme"], { mapMemory: recordMapMemory(store), mapReturns: () => [] });
  const r = await second.run;
  assertEquals(second.log.maps, [], "the map is not asked again");
  assertEquals(second.log.fetches, first.log.fetches, "the same selected pages");
  assertEquals(r.companies[0].outcome, "collected", "never `site_unavailable` for a site this mission mapped");
});

Deno.test("MAP MEMORY: stopped between the map and its pages — the next slice buys the pages, never the map", async () => {
  const store: Record<string, MapSelection> = {};
  const stopped = collect(["acme"], { mapMemory: recordMapMemory(store), stop: (_l, op) => op === VERIFICATION_OPS.page ? STOP : null });
  const r1 = await stopped.run;
  assertEquals([stopped.log.maps.length, stopped.log.fetches.length, r1.companies[0].outcome], [1, 0, "stopped"]);
  const resumed = collect(["acme"], { mapMemory: recordMapMemory(store), mapReturns: () => [] });
  const r2 = await resumed.run;
  assertEquals(resumed.log.maps, []);
  assert(resumed.log.fetches.length > 0);
  assertEquals(r2.companies[0].outcome, "collected");
});

Deno.test("MAP MEMORY: an empty map is never remembered (it may be the ledger's skip); keys ignore intent order and case", () => {
  const store: Record<string, MapSelection> = {};
  const m = recordMapMemory(store);
  m.remember("Acme.com", ["pricing", "product"], { targets: [{ intent: "pricing", url: "https://acme.com/pricing" }], mapped: 4 });
  assertEquals(m.recall("acme.com", ["product", "pricing"])?.targets, [{ intent: "pricing", url: "https://acme.com/pricing" }]);
  assertEquals(m.recall("acme.com", ["pricing"]), null, "a different intent set is a different selection");
  return (async () => {
    const s2: Record<string, MapSelection> = {};
    await collect(["acme"], { mapMemory: recordMapMemory(s2), mapReturns: () => [] }).run;
    assertEquals(Object.keys(s2), []);
  })();
});
