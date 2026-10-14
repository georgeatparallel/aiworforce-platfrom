// LEAD V2 READINESS — one command, one answer.
//
//   npm run test:lead-v2-readiness
//
// Runs the offline Replay Lab (tests/replay) with NO network permission — a
// provider call cannot happen even by accident — and reports by category:
//
//   [golden]         Golden missions
//   [historical]     Historical regression replays (production canaries)
//   [claims]         Claim/evidence invariants
//   [provider-spec]  Provider-spec invariants
//   [budget]         Budget invariants
//   [continuation]   Continuation invariants
//   [matrix]         Query regression matrix (request types, wording variants)
//   [invariant]      Lead V2 invariants (the eighteen direct properties)
//   [known-gap]      documented gaps (ignored tests) — listed, never hidden
//
// SAFE FOR PRODUCTION SMOKE is YES only when every category ran and passed and
// every fixture passed the sanitization check. Exit code 1 otherwise.

const CATEGORIES: Array<[tag: string, label: string]> = [
  ["golden", "Golden missions"],
  ["historical", "Historical regression replays"],
  ["claims", "Claim/evidence invariants"],
  ["provider-spec", "Provider-spec invariants"],
  ["budget", "Budget invariants"],
  ["continuation", "Continuation invariants"],
  ["matrix", "Query regression matrix"],
  ["invariant", "Lead V2 invariants"],
  ["failure", "Failure-injection lineages"],
];

const root = new URL("../", import.meta.url);
const junit = await Deno.makeTempFile({ suffix: ".xml" });
const started = performance.now();
const run = await new Deno.Command(Deno.execPath(), {
  args: ["test", "--allow-read", "--allow-env", "--no-check", "--reporter=dot", `--junit-path=${junit}`, "tests/replay/"],
  cwd: root, stdout: "piped", stderr: "piped",
}).output();
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const xml = await Deno.readTextFile(junit).catch(() => "");
await Deno.remove(junit).catch(() => {});

interface Case { name: string; failed: boolean; skipped: boolean }
const cases: Case[] = [];
for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const name = (m[1].match(/\bname="([^"]*)"/)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<");
  const body = m[3] ?? "";
  cases.push({ name, failed: /<failure|<error/.test(body), skipped: /<skipped/.test(body) });
}
const tagOf = (n: string) => n.match(/^\[([a-z-]+)\]/)?.[1] ?? "untagged";

const lines: string[] = [];
let safe = run.success && cases.length > 0;
for (const [tag, label] of CATEGORIES) {
  const mine = cases.filter((c) => tagOf(c.name) === tag && !c.skipped);
  const failed = mine.filter((c) => c.failed);
  const ok = mine.length > 0 && failed.length === 0;
  if (!ok) safe = false;
  lines.push(`${(label + ":").padEnd(32)} ${ok ? "PASS" : "FAIL"}  (${mine.length - failed.length}/${mine.length})`);
  for (const f of failed) lines.push(`    ✗ ${f.name}`);
}
const untagged = cases.filter((c) => tagOf(c.name) === "untagged");
if (untagged.some((c) => c.failed)) { safe = false; lines.push(`Untagged tests: FAIL`); }
const gaps = cases.filter((c) => tagOf(c.name) === "known-gap");

// Every fixture must be sanitized (no credential-shaped strings, no emails).
const { listFixtures, loadFixture } = await import("../tests/replay/lib/fixture.ts");
const fixtureProblems: string[] = [];
for (const f of listFixtures()) { try { loadFixture(f); } catch (e) { fixtureProblems.push(`${f}: ${(e as Error).message}`); } }
if (fixtureProblems.length) safe = false;

console.log("\nLEAD V2 READINESS (offline Replay Lab — zero provider calls, zero credits, zero production writes)\n");
for (const l of lines) console.log(l);
console.log(`${"Fixtures sanitized:".padEnd(32)} ${fixtureProblems.length ? "FAIL" : "PASS"}  (${listFixtures().length} fixtures)`);
for (const p of fixtureProblems) console.log(`    ✗ ${p}`);
if (gaps.length) {
  console.log(`\nKnown gaps (documented, not hidden):`);
  for (const g of gaps) console.log(`    • ${g.name.replace(/^\[known-gap\]\s*/, "")}`);
}
console.log(`\n${cases.filter((c) => !c.skipped && !c.failed).length} passed, ${cases.filter((c) => c.failed).length} failed, ${gaps.length} known gaps — ${seconds}s`);
console.log(`\nSAFE FOR PRODUCTION SMOKE: ${safe ? "YES" : "NO"}\n`);
if (!run.success && cases.length === 0) console.log(new TextDecoder().decode(run.stderr).slice(-2000));
Deno.exit(safe ? 0 : 1);
