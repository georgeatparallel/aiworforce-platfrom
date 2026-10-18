// PERPLEXITY MUST NOT BE REACHABLE FROM PRODUCTION.
//
// ── WHY IT WAS REMOVED ─────────────────────────────────────────────────────
//
// `research_web` called `api.perplexity.ai` directly from `toolRegistry`,
// outside `aiProvider` and `gptProvider` — the only two seams that reach
// `ModelCallCollector`. So it was:
//
//     live         13 calls, the last on 2026-08-31
//     uncaptured   no row in `lead_model_calls`, no tokens, no cost
//     unmetered    absent from `PAID_TOOLS`, so no credit reservation either
//
// One production path that could spend money without appearing in ANY of the
// three accounting systems. Rather than wire a fourth provider into the ledger
// and the two spend ceilings, it is retired until something needs it.
//
// ── WHAT THIS FILE GUARDS ──────────────────────────────────────────────────
//
// The executor was deleted, not flagged off, so the guarantee is structural: a
// `fetch` that does not exist cannot be re-enabled by configuration. This test
// keeps it that way, and fails if a Perplexity call site reappears anywhere in
// `supabase/functions` without being added to the allow-list below with a
// reason.
//
// ZERO network, ZERO models, ZERO providers, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RETIRED_TOOLS, isToolConfigured, listTools, runTool,
} from "../../../supabase/functions/_shared/toolRegistry.ts";
import { resolveWebSearch } from "../../../supabase/functions/_shared/parallelSearch.ts";

const FUNCTIONS = new URL("../../../supabase/functions/", import.meta.url);

/**
 * Files permitted to mention Perplexity, and why.
 *
 * EXPLICIT, so re-adding a call site is a decision someone wrote down. A
 * comment explaining a retirement is not a call site; a `fetch` is.
 */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  "_shared/toolRegistry.ts": "the retirement notice and RETIRED_TOOLS entry",
  "_shared/broadResearchPolicy.ts": "policy comments naming the retired path",
  "orchestrate/index.ts": "comments and the truthful capability message",
  "run-agent/index.ts": "comments explaining why the call is gone",
});

async function* walk(dir: URL, prefix = ""): AsyncGenerator<{ path: string; text: string }> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(child, `${prefix}${e.name}/`);
    else if (e.name.endsWith(".ts")) {
      yield { path: `${prefix}${e.name}`, text: await Deno.readTextFile(child) };
    }
  }
}

const FILES: { path: string; text: string }[] = [];
for await (const f of walk(FUNCTIONS)) FILES.push(f);

// ══════════ 1. no reachable call site ═════════════════════════════════════

Deno.test("THE REMOVAL: no production code can call Perplexity", () => {
  // A CALL, not a mention. `fetch("https://api.perplexity.ai…")` is the thing
  // that spends money; a comment saying it used to is what keeps the reason.
  const callers = FILES
    .filter((f) => /https?:\/\/[^"'`\s]*perplexity/i.test(f.text))
    .map((f) => f.path);
  assertEquals(
    callers, [],
    `these files can reach Perplexity: ${callers.join(", ")}. It is retired ` +
      `because it spent outside the model ledger, the credit system and both ` +
      `spend ceilings. Reintroduce it through those, not around them.`,
  );
});

Deno.test("no PERPLEXITY_API_KEY is read anywhere in production code", () => {
  const readers = FILES
    .filter((f) => f.text.includes("PERPLEXITY_API_KEY"))
    .map((f) => f.path);
  assertEquals(
    readers, [],
    `${readers.join(", ")} still reads the Perplexity key — the secret may ` +
      `remain set, but nothing may consume it`,
  );
});

Deno.test("every remaining mention is allow-listed, and the list is honest", () => {
  const mentions = FILES
    .filter((f) => /perplexity|\bsonar\b/i.test(f.text))
    .map((f) => f.path)
    .sort();
  const unlisted = mentions.filter((p) => !(p in ALLOWED));
  assertEquals(
    unlisted, [],
    `unlisted Perplexity references: ${unlisted.join(", ")}. Add the file to ` +
      `ALLOWED with a reason, or remove the reference.`,
  );
  // And the list must not rot: an entry naming a file with no mention left is
  // an exception protecting nothing, which is how a real one hides later.
  for (const p of Object.keys(ALLOWED)) {
    assert(mentions.includes(p), `ALLOWED names "${p}", which no longer mentions Perplexity`);
  }
});

// ══════════ 2. the tool is retired, not merely missing ════════════════════

Deno.test("research_web is not offered to any planner", () => {
  const names = listTools().map((t) => t.name);
  assert(!names.includes("research_web"), "a retired tool must not be selectable");
  assert(names.length > 0, "sanity: other tools are still registered");
});

Deno.test("THE TRAP: isToolConfigured reports retired, not ready", () => {
  // `isToolConfigured` answers `{ready: true}` for any name absent from
  // TOOL_ENV — correct for a tool needing no key, and catastrophic for a
  // deleted one. Removing the entry without RETIRED_TOOLS would have told
  // every caller that research was available.
  const v = isToolConfigured("research_web");
  assertEquals(v.ready, false, "a retired tool is NEVER ready");
  assert(v.retired, "and it says so, rather than looking unconfigured");
  assert(!v.env, "it must not point at an env var someone would try to set");

  // The contrast that proves the assertion means something.
  assertEquals(isToolConfigured("summarize_text").ready, true, "a live tool is still ready");
});

Deno.test("runTool answers `unavailable`, not `tool_not_found`", async () => {
  // Callers branch on `unavailable` to mean "an optional capability is absent,
  // continue without it". `tool_not_found` reads as a bug. Which one is
  // returned decides whether a step degrades cleanly or fails.
  const r = await runTool("research_web", { query: "x" }, {
    agent_slug: "hawk", workspace_id: "w",
  } as never);
  assertEquals(r.ok, false);
  assertEquals(r.unavailable, true, "retired is unavailable, not broken");
  assert(String(r.error).includes("tool_retired"));

  const missing = await runTool("no_such_tool", {}, {
    agent_slug: "hawk", workspace_id: "w",
  } as never);
  assertEquals(missing.unavailable, undefined, "a genuinely unknown tool is still an error");
});

Deno.test("RETIRED_TOOLS says why, so the entry is not cargo", () => {
  assert("research_web" in RETIRED_TOOLS);
  assert(
    RETIRED_TOOLS.research_web.length > 40,
    "a retirement with no reason invites someone to undo it",
  );
});

// ══════════ 3. no fallback chain can reach it ═════════════════════════════

Deno.test("nothing falls back to research_web", async () => {
  const orchestrate = await Deno.readTextFile(new URL("orchestrate/index.ts", FUNCTIONS));
  assert(
    !/\?\s*"research_web"/.test(orchestrate),
    "a selection branch still resolves to research_web",
  );
  assert(
    !orchestrate.includes("- research_web"),
    "the model-facing tool list still offers research_web, which no longer exists",
  );
  assert(
    !/"tool_needed":\s*"research_web"/.test(orchestrate),
    "the JSON example still teaches the planner a retired tool",
  );
});

Deno.test("a stored plan naming research_web does not become another provider", async () => {
  // The repair branch shared `defaultTool`, which is `source_with_apify` for
  // anything hiring-shaped — so retiring the tool would have turned every
  // stored plan naming it into paid sourcing the user never asked for, decided
  // by a regex on their sentence. It lands on `search_web`, which reports
  // `unavailable` and spends nothing.
  const src = await Deno.readTextFile(new URL("orchestrate/index.ts", FUNCTIONS));
  const branch = src.indexOf('hawk.tool_needed === "research_web"');
  assert(branch > 0, "the repair branch must still handle stored plans");
  const body = src.slice(branch, branch + 900);
  assert(
    !/hawk\.tool_needed\s*=(?!=)/.test(body.slice(0, body.indexOf("} else if"))),
    "an explicit retired selection must be preserved, never replaced by another provider",
  );
});

// ══════════ 4. the rest of the toolchain is untouched ════════════════════

Deno.test("the live tools are unaffected", () => {
  const names = listTools().map((t) => t.name).sort();
  for (const t of ["source_with_apify", "scrape_url", "search_web", "send_email"]) {
    assert(names.includes(t), `${t} must still be registered — this change is Perplexity only`);
  }
  assertEquals(
    isToolConfigured("search_web").ready,
    resolveWebSearch() === "parallel",
    "search_web answers from the shared provider resolver",
  );
});
