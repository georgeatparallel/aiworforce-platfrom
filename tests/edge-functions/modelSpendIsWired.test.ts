// PHASE 6 — THE MODEL LEDGER IS ONLY REAL IF THE PIPELINE IS WIRED TO IT.
//
// ── WHAT WAS OBSERVED ──────────────────────────────────────────────────────
//
// `recordModelCall`, the `model_call` record kind, its three CHECK constraints
// and `modelCallLedger.test.ts` were all built, shipped and correct. The
// collector was wired into `pilot-chat` — and nowhere else.
//
// In the ten days to 2026-09-04 the ledger held exactly ONE `model_call` row,
// from a `signal_relevance` call on a pilot path, against 1277 provider rows.
// Every lead mission's model spend was unrecorded: triage, evaluation,
// discovery and execution planning, pool and round planning, evidence planning
// and extraction, and the P4 re-evaluation. A run could be audited for Apify
// dollars to the cent and still not answer "what did the models cost?".
//
// ── WHY THIS TEST IS STRUCTURAL ────────────────────────────────────────────
//
// Every unit test of the mechanism passed throughout. They exercised
// `recordModelCall` against a fake writer, which is exactly what stayed
// healthy; what was missing was the ARGUMENT at the call site. A test of the
// mechanism cannot see that, so this one reads the wiring itself.
//
// It is deliberately a whitelist-free scan: it finds every model-backed factory
// `run-agent` constructs and requires the seam on each, so a factory added
// later is covered without anybody remembering to extend a list.
//
// ZERO network, ZERO DB, ZERO model, ZERO spend.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../", import.meta.url);
const runAgent = await Deno.readTextFile(
  new URL("supabase/functions/run-agent/index.ts", ROOT),
);

/** Every factory in this repo that ends in a model call. */
const FACTORY = /(createGptStrategistGenerateJson|makeGpt[A-Za-z]*Planner|build[A-Za-z]*Binding)\s*\(/g;

/**
 * The text of one call's arguments, from `(` to its matching `)`.
 *
 * Brace/paren matching rather than a line window: these calls span twenty lines
 * and nest object literals, and a window either truncates them or swallows the
 * next call.
 */
function argsOf(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return src.slice(openParen);
}

interface Site { name: string; args: string; line: number }

const sites: Site[] = [];
for (const m of runAgent.matchAll(FACTORY)) {
  const openParen = m.index! + m[0].length - 1;
  sites.push({
    name: m[1],
    args: argsOf(runAgent, openParen),
    line: runAgent.slice(0, m.index!).split("\n").length,
  });
}

Deno.test("run-agent still constructs the model-backed factories this guards", () => {
  // If this drops to zero the scan below passes vacuously — the failure mode of
  // every structural test.
  assert(
    sites.length >= 9,
    `expected run-agent to build at least 9 model-backed factories, found ` +
      `${sites.length}: ${sites.map((s) => s.name).join(", ")}`,
  );
});

Deno.test("THE WIRING: every model factory in run-agent records its spend", () => {
  const unwired = sites.filter((s) => !s.args.includes("onModelCall"));
  assertEquals(
    unwired.map((s) => `${s.name} (line ${s.line})`),
    [],
    "these construct a model caller without passing the ledger seam, so their " +
      "spend is invisible — the defect that left ONE model_call row in ten days",
  );
});

Deno.test("the collected calls are actually drained to the ledger", () => {
  // Collecting without draining is the same outcome with more steps.
  assert(
    /modelCalls\.drain\(/.test(runAgent),
    "run-agent must drain the collector; collecting alone writes nothing",
  );
  assert(
    /await\s+modelCalls\.drain\(/.test(runAgent),
    "the drain must be awaited — a floating promise can be cut off when the " +
      "response returns, losing exactly the rows worth having",
  );
});

Deno.test("the drain is attributed to this run, not to ambient state", () => {
  const at = runAgent.indexOf("modelCalls.drain(");
  assert(at > 0);
  const call = argsOf(runAgent, runAgent.indexOf("(", at));
  for (const field of ["workspace_id", "task_id", "logical_call_key"]) {
    assert(call.includes(field), `the drain must carry ${field}`);
  }
});

Deno.test("every binding that defaults its own generate accepts the seam", () => {
  // The six bindings build their own `createGptStrategistGenerateJson` when the
  // caller passes no `generate`. Each has to hand the seam down, or wiring the
  // call site above achieves nothing.
  const BINDINGS = [
    "missionEvaluationBinding",
    "missionTriageBinding",
    "poolEvaluationBinding",
    "multiRoundBinding",
    "semanticClassificationBinding",
    "groundedBrainBinding",
  ];
  for (const b of BINDINGS) {
    const src = Deno.readTextFileSync(
      new URL(`supabase/functions/_shared/${b}.ts`, ROOT),
    );
    assert(
      src.includes("onModelCall?: GptDeps[\"onModelCall\"]"),
      `${b} must accept an onModelCall seam`,
    );
    assert(
      /createGptStrategistGenerateJson\(\{\s*onModelCall:\s*input\.onModelCall,\s*budget:\s*input\.budget\s*\}/
        .test(src),
      `${b} accepts the seam but does not pass it to its default generate, ` +
        `which is the same as not accepting it`,
    );
  }
});

Deno.test("no factory in run-agent passes an empty deps object", () => {
  // `createGptStrategistGenerateJson({}, …)` is how all three evidence-path
  // generators were built, and `{}` is a silent opt-out of telemetry rather
  // than a visible one.
  assertEquals(
    runAgent.includes("createGptStrategistGenerateJson({},"),
    false,
    "an empty deps object opts out of the model ledger without saying so",
  );
});
