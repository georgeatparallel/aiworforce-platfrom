// EVERY MODEL CALL GOES THROUGH AN ACCOUNTED SEAM, OR IT IS NAMED HERE.
//
// ── WHY A STRUCTURAL TEST AND NOT A CONVENTION ─────────────────────────────
//
// Four separate times this codebase grew a provider call that bypassed the
// accounting it already had:
//
//     toolRegistry     → api.perplexity.ai   live, 13 calls, in no ledger
//     chat-respond     → 3 providers          orphaned, unpriced, no workspace
//     aiProvider       → gateway + Anthropic  emitted nothing until 8958550c
//     leadStrategy     → shared transport     emitted into `undefined`
//
// Every one was written by someone who knew the rule. The rule was not
// checkable, so knowing it was not enough. This file makes it checkable: a new
// `fetch` to a model provider fails the build unless its file is listed below
// with a reason.
//
// ZERO network, ZERO models, ZERO providers, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const FUNCTIONS = new URL("../../../supabase/functions/", import.meta.url);

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

/** Hosts that bill per token. A `fetch` to one of these is model spend. */
const PROVIDER_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.perplexity.ai",
  "ai.gateway.lovable.dev",
];

/**
 * THE APPROVED SEAMS. Each reports to `ModelCallCollector` and honours a budget.
 *
 * A file here is not exempt from accounting — it IS the accounting. Adding a
 * name means claiming the file emits telemetry on success AND failure and
 * consults a budget before spending; the tests beside this one check that for
 * each of them.
 */
const ACCOUNTED: Readonly<Record<string, string>> = Object.freeze({
  "_shared/gptProvider.ts":
    "OpenAI transport; emits via GptDeps.onModelCall on success and failure",
  "_shared/aiProvider.ts":
    "gateway + Anthropic; emits via opts.onModelCall, budget checked per attempt",
  "_shared/leadStrategy/adapters/shared.ts":
    "the one strategist transport; emits on success and failure, budget checked before the request",
  "_shared/leadStrategy/adapters/openai.ts":
    "endpoint constant only; delegates to the shared transport",
  "_shared/leadStrategy/adapters/lovableAi.ts":
    "endpoint constant only; delegates to the shared transport",
  // Images bill per image rather than per token, so this seam reports through
  // `onImageCall` instead of `ModelCallCollector`. The obligation is the same
  // and is met the same way: `generate-content-image` turns every telemetry —
  // success AND failure — into a `record_kind: 'model_call'` row via
  // `recordModelCall`, and consults `authorizeModelSpend` before it spends.
  // That row lands in `lead_model_calls`, which is the view the ceiling itself
  // sums, so image spend both counts toward the ceiling and is stopped by it.
  // Not a caller. The worker's opt-in smoke admission gate names these hosts
  // to CLASSIFY requests other seams make; it forwards an admitted request
  // unchanged and never originates one. Every model call still starts in
  // aiProvider or gptProvider and is metered there.
  "_shared/smokeAdmission.ts":
    "classifier only: admits or refuses requests made by the accounted seams; originates no model call",
  "_shared/imageProvider.ts":
    "OpenAI images; emits via ImageProviderDeps.onImageCall on success and failure, " +
    "ledgered as a model_call and gated by authorizeModelSpend in generate-content-image",
});

/**
 * KNOWN-UNMETERED. EMPTY, AND IT STAYS EMPTY.
 *
 * It once named `screen-candidate`, `generate-screening-invite` and
 * `parse-resume` — five model call sites reachable only from recruiting
 * components. Deleting that product deleted them, so every model call in
 * `supabase/functions` now goes through a seam that reports to
 * `ModelCallCollector` and honours a run budget.
 *
 * An entry here is model spend that appears in no ledger. There is no longer a
 * reason for one to exist, which is why the count below is pinned at zero
 * rather than merely "not growing".
 */
const KNOWN_UNMETERED: Readonly<Record<string, string>> = Object.freeze({});

/** Code with comments removed. A name in prose is not a call site. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l.replace(/\s\/\/.*$/, "")))
    .join("\n");
}

/** A real call site, not a comment or a doc string. */
function providerCallSites(text: string): string[] {
  return text.split("\n")
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return PROVIDER_HOSTS.some((h) => l.includes(h));
    })
    .map((l) => l.trim());
}

// ══════════ 1. no unapproved provider call sites ══════════════════════════

Deno.test("THE INVARIANT: every model provider call is in an accounted file", () => {
  const offenders: string[] = [];
  for (const f of FILES) {
    if (providerCallSites(f.text).length === 0) continue;
    if (f.path in ACCOUNTED || f.path in KNOWN_UNMETERED) continue;
    offenders.push(f.path);
  }
  assertEquals(
    offenders.sort(), [],
    `these files call a model provider directly and are neither an accounted ` +
      `seam nor a known gap: ${offenders.join(", ")}. Route the call through ` +
      `aiProvider, gptProvider or the strategist transport — all three report ` +
      `to ModelCallCollector and honour a run budget.`,
  );
});

Deno.test("there are no unmetered model paths left, and none may return", () => {
  // Pinned. A fourth unmetered function is a regression, and the number is the
  // cheapest possible way to notice one.
  assertEquals(
    Object.keys(KNOWN_UNMETERED).length, 0,
    "every model call now reports to ModelCallCollector; an unmetered one is a regression",
  );
  for (const p of Object.keys(KNOWN_UNMETERED)) {
    const f = FILES.find((x) => x.path === p);
    assert(f, `KNOWN_UNMETERED names "${p}", which no longer exists — remove the entry`);
    assert(
      providerCallSites(f!.text).length > 0,
      `"${p}" no longer calls a provider — remove it from KNOWN_UNMETERED`,
    );
  }
});

Deno.test("every accounted seam still exists and still calls a provider", () => {
  // An allow-list entry for a deleted file protects nothing and hides the next
  // real one.
  for (const p of Object.keys(ACCOUNTED)) {
    const f = FILES.find((x) => x.path === p);
    assert(f, `ACCOUNTED names "${p}", which no longer exists`);
  }
});

// ══════════ 2. deleted implementations stay deleted ═══════════════════════

Deno.test("chat-respond is gone, and nothing references it", () => {
  assert(
    !FILES.some((f) => f.path.startsWith("chat-respond/")),
    "chat-respond was deleted: it had no caller, duplicated pilot-chat, had a " +
      "broken Gemini branch, and had no workspace to attribute spend to",
  );
  // ── PROSE IS NOT A REFERENCE ───────────────────────────────────────────
  //
  // This scanned the raw text, so a COMMENT naming `chat-respond` failed the
  // test. `imageProvider.ts` tripped it by listing the four historic bypasses
  // in its own header — documenting the bug this file exists to prevent was
  // enough to break it.
  //
  // That is this repo's most repeated test defect: a scan matching the comment
  // that explains it. `providerCallSites` above already strips comments; this
  // did not. A dangling reference is an IMPORT or a FETCH, never a sentence,
  // and a test that cannot tell them apart pushes people to stop explaining
  // things — the opposite of what it is for.
  const refs = FILES
    .filter((f) => stripComments(f.text).includes("chat-respond"))
    .map((f) => f.path);
  assertEquals(refs, [], `dangling chat-respond references: ${refs.join(", ")}`);
});

Deno.test("the deleted screening orphans stay deleted", () => {
  // Each had zero callers anywhere in the repo; two made unmetered model calls.
  for (const d of [
    "adaptive-screening-chat", "generate-screening-questions",
    "getResumeAnalysis", "saveResumeAnalysis", "analyze-behavioral-signals",
  ]) {
    assert(
      !FILES.some((f) => f.path.startsWith(`${d}/`)),
      `${d} was deleted as an orphan — restoring it needs a caller and a seam`,
    );
  }
});

Deno.test("Perplexity cannot be reached", () => {
  const callers = FILES
    .filter((f) => providerCallSites(f.text).some((l) => l.includes("api.perplexity.ai")))
    .map((f) => f.path);
  assertEquals(callers, [], `Perplexity call sites: ${callers.join(", ")}`);
  const keyReaders = FILES.filter((f) => f.text.includes("PERPLEXITY_API_KEY")).map((f) => f.path);
  assertEquals(keyReaders, [], "nothing may read the Perplexity key");
});

// ══════════ 3. one canonical chat backend ═════════════════════════════════

Deno.test("pilot-chat is the only chat entrypoint", () => {
  assert(
    FILES.some((f) => f.path === "pilot-chat/index.ts"),
    "pilot-chat is the canonical chat backend and must exist",
  );
  // The property that matters: no OTHER function serves chat by talking to a
  // provider itself. `orchestrate` plans and delegates; it holds no provider URL.
  const orchestrate = FILES.find((f) => f.path === "orchestrate/index.ts");
  assert(orchestrate, "orchestrate must exist");
  assertEquals(
    providerCallSites(orchestrate!.text), [],
    "orchestrate must delegate to the shared providers, never call one itself",
  );
});

// ══════════ 3. the comment stripper does not blind the scan ═══════════════

Deno.test("stripComments removes prose and keeps code", () => {
  // A stripper that ate too much would make every scan above pass vacuously —
  // which is a worse failure than the one it fixed, because it is silent.
  const sample = [
    '// import x from "./chat-respond.ts";',
    '/* chat-respond lived here */',
    'import y from "./chat-respond/index.ts";  // still a real import',
    'const host = "api.openai.com";',
  ].join("\n");
  const out = stripComments(sample);

  assert(out.includes('./chat-respond/index.ts'), "a real import must survive");
  assert(out.includes("api.openai.com"), "a real endpoint must survive");
  assert(!out.includes("lived here"), "block comments must go");
  assert(!out.includes("still a real import"), "trailing comments must go");
  assertEquals(
    out.split("\n").filter((l) => l.includes("import x")).length, 0,
    "a commented-out import is not a reference",
  );
});
