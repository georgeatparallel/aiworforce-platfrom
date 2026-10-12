// HISTORICAL J — EVIDENCE REGRESSION (Query B f6133796, production 2026-10-11).
//
// Citian's business model went: weak (LinkedIn description, review) → strong
// (its own /about page, proven) → checkpoint → a slice that restored the
// Stage-2 grounding checkpointed BEFORE the website re-read, and re-read the
// description. That stale re-read replaced the website proof; Citian and Coval
// fell from qualified to pending. PR #59 made evidence monotonic unless
// contradicted; this replay pins the whole sequence end to end, across a
// checkpoint round-trip of the company record.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { EngineCompany } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import {
  businessModel, citian, CONSUMER_PAGE, DESCRIPTION_CONSUMER, DESCRIPTION_ONLY, industry, PAGE, read,
  WEBSITE, WEBSITE_CONSUMER,
} from "../lib/citian.ts";

/** A checkpoint round-trip: the record as JSON, as the task result stores it. */
const checkpointed = (c: EngineCompany): EngineCompany => JSON.parse(JSON.stringify(c));

Deno.test("[historical] J weak description → website proof → checkpoint → stale restore: the stronger proof survives", () => {
  const c = citian();
  read(c, DESCRIPTION_ONLY());
  assertEquals([businessModel(c).status, industry(c)], ["plausible", "unknown"], "slice 2: description only");
  read(c, WEBSITE(), [PAGE]);
  assertEquals([businessModel(c).status, industry(c)], ["proven", "pass"], "slice 3: the website proves it");
  const restored = checkpointed(c);
  read(restored, DESCRIPTION_ONLY());
  const bm = businessModel(restored);
  assertEquals([bm.status, bm.source.url, industry(restored)], ["proven", PAGE.source_url, "pass"],
    "slice 4: the restored stale grounding does not downgrade durable evidence");
});

Deno.test("[historical] J a trusted contradiction after the restore is still recorded and visible", () => {
  const c = checkpointed((() => { const x = citian(); read(x, WEBSITE(), [PAGE]); return x; })());
  read(c, WEBSITE_CONSUMER(), [CONSUMER_PAGE]);
  assertEquals([businessModel(c).value, industry(c)], ["consumer", "fail"]);
});

Deno.test("[historical] J a weaker contrary reading after the restore does not overturn the proof", () => {
  const c = checkpointed((() => { const x = citian(); read(x, WEBSITE(), [PAGE]); return x; })());
  read(c, DESCRIPTION_CONSUMER());
  assertEquals([businessModel(c).status, industry(c)], ["proven", "pass"]);
});

Deno.test("[historical] J the final claim does not depend on the order the slices delivered the readings", () => {
  const orders = [
    [DESCRIPTION_ONLY, WEBSITE, DESCRIPTION_ONLY],
    [WEBSITE, DESCRIPTION_ONLY, DESCRIPTION_ONLY],
    [DESCRIPTION_ONLY, DESCRIPTION_ONLY, WEBSITE],
  ];
  const finals = orders.map((seq) => {
    let c = citian();
    for (const r of seq) { read(c, r(), r === WEBSITE ? [PAGE] : []); c = checkpointed(c); }
    return { value: businessModel(c).value, status: businessModel(c).status, url: businessModel(c).source.url, industry: industry(c) };
  });
  for (const f of finals) assertEquals(f, finals[0]);
  assert(finals[0].industry === "pass");
});
