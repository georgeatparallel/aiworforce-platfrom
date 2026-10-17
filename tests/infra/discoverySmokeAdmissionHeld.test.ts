// The durable smoke admission is HELD and OPT-IN: its migration reaches only the
// disposable contract lane (and, behind an explicit flag, a new non-production
// project), no deploy path names it, the worker installs the gate only when
// DISCOVERY_SMOKE_ADMISSION is set, and the worker's role can never mint or
// widen an authorization. Behaviour: tests/db-contract/smokeAdmission*.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const NAME = "20261015140000_discovery_smoke_admission";
const UP = read(`supabase/migrations-held/${NAME}.sql`);
const DOWN = read(`supabase/migrations-held/rollback/${NAME}.down.sql`);

Deno.test("smoke admission: held — no deploy path applies it", async () => {
  for await (const e of Deno.readDir(new URL("supabase/migrations/", ROOT))) {
    assert(!e.name.includes("discovery_smoke"), `must not sit in supabase/migrations/: ${e.name}`);
  }
  assert(!read("scripts/local-supabase/rebuild-local-db.sh").includes(NAME));
  for await (const e of Deno.readDir(new URL(".github/workflows/", ROOT))) {
    const wf = read(`.github/workflows/${e.name}`);
    assert(!wf.includes(NAME), `${e.name} must not name the held admission`);
    assert(!wf.includes("DISCOVERY_SMOKE_ADMISSION"), `${e.name} must not configure the gate (only the inactive proposal does)`);
  }
  assert(!read("railway.json").includes("DISCOVERY_SMOKE_ADMISSION"));
  const bootstrap = read("tests/db-contract/bootstrap.sh");
  assert(bootstrap.includes(`${NAME}.sql`) && bootstrap.includes("only builds a database on localhost"));
  const build = read("scripts/test-project/build-test-schema.sh");
  assert(build.includes('if [ $with_admission -eq 1 ]; then apply "$admission"; fi'), "the test-project build applies it only on request");
  assert(read("supabase/migrations-held/README.md").includes(`${NAME}.sql`));
});

Deno.test("smoke admission: the worker's role reads and admits, nothing more", () => {
  assert(UP.includes("revoke all on public.discovery_smoke_authorizations, public.discovery_smoke_operations,\n  public.discovery_smoke_reconciliations\n  from public, anon, authenticated, service_role;"));
  assert(UP.includes("grant select on public.discovery_smoke_authorizations, public.discovery_smoke_operations,\n  public.discovery_smoke_reconciliations to service_role;"));
  assert(/revoke all on function public\.authorize_discovery_smoke\([^)]*\) from public, anon, authenticated, service_role;/.test(UP));
  assert(!/grant execute on function public\.authorize_discovery_smoke/.test(UP), "nobody is granted the approval RPC");
  assert(/revoke all on function public\.reconcile_discovery_smoke_operation\([^)]*\) from public, anon, authenticated, service_role;/.test(UP));
  assert(!/grant execute on function public\.reconcile_discovery_smoke_operation/.test(UP), "nobody is granted the reconciliation RPC");
  assert(/function public\.reconcile_discovery_smoke_operation[^$]*?security definer set search_path = pg_catalog, public/.test(UP),
    "reconcile: pinned search_path");
  const grants = [...UP.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to (\w+);/g)].map((m) => `${m[1]}:${m[2]}`);
  assertEquals(grants.sort(), ["admit_discovery_smoke:service_role", "record_discovery_smoke_receipt:service_role", "stop_discovery_smoke:service_role"]);
  for (const fn of ["authorize", "admit", "record", "stop"]) {
    assert(new RegExp(`function public\\.${fn}_discovery_smoke[^$]*?security definer set search_path = pg_catalog, public`).test(UP), `${fn}: pinned search_path`);
  }
});

Deno.test("smoke admission: the hard ceilings are in the schema, not in configuration", () => {
  for (const c of ["total_microusd between 0 and 250000", "provider_microusd between 0 and 200000", "model_microusd between 0 and 50000",
    "provider_purchases between 0 and 5", "model_attempts between 0 and 4", "discovery_pages between 0 and 1", "provider_polls between 0 and 5",
    "deadline_at <= authorized_at + interval '300 seconds'"]) {
    assert(UP.includes(c), c);
  }
  assert(UP.includes("for update;\n  if not found then return jsonb_build_object('decision', 'not_authorized')"), "one serialization point");
  assert(UP.includes("v_now := clock_timestamp();  -- after the lock wait"));
  assert(!/\bdelete from public\.discovery_smoke_operations/i.test(UP), "nothing is ever refunded by deletion");
});

Deno.test("smoke admission: the rollback refuses while there is anything to account for", () => {
  assert(DOWN.trimStart().startsWith("--") && /\nbegin;\n/.test(DOWN) && DOWN.trimEnd().endsWith("commit;"), "one transaction");
  const guard = DOWN.indexOf("raise exception");
  assert(guard > 0 && guard < DOWN.indexOf("drop function"), "the guard runs before anything is dropped");
  assert(DOWN.includes("exists (select 1 from public.discovery_smoke_authorizations)") && DOWN.includes("exists (select 1 from public.discovery_smoke_operations)"));
  for (const o of ["stop_discovery_smoke", "reconcile_discovery_smoke_operation", "record_discovery_smoke_receipt", "admit_discovery_smoke",
    "authorize_discovery_smoke", "table public.discovery_smoke_reconciliations",
    "table public.discovery_smoke_operations", "table public.discovery_smoke_authorizations"]) {
    assert(DOWN.includes(`drop ${o.startsWith("table") ? "" : "function public."}${o}`), o);
  }
});

Deno.test("smoke admission: the rollback drops each function by the signature its revoke names", () => {
  const revoked = [...UP.matchAll(/revoke all on function public\.(\w+\([^)]*\)) from/g)].map((m) => m[1]).sort();
  const dropped = [...DOWN.matchAll(/drop function public\.(\w+\([^)]*\));/g)].map((m) => m[1]).sort();
  assertEquals(dropped, revoked);
  // Final hardening: reconciliation states the vendor's terminal status.
  assert(revoked.includes("reconcile_discovery_smoke_operation(uuid, text, bigint, text, text)"));
});

Deno.test("smoke admission: the worker installs the gate only when enforced, before run-agent loads", () => {
  const main = read("worker/main.ts");
  const at = main.indexOf("if (admissionEnforced) {");
  assert(at > 0 && main.indexOf("globalThis.fetch = createAdmissionFetch(") > at, "installed only inside the opt-in branch");
  assert(at < main.indexOf('await import("../supabase/functions/run-agent/index.ts")'), "before the handler is imported");
  assert(main.includes("global: { fetch: baseFetch }"), "the gate's own client never goes through the gate");
  assert(main.includes("...(admissionEnforced ? { admission: { workerId } } : {})"));
});

// ── Codex review R4: the gate covers `fetch` only, so the worker's code may use
// no other HTTP client. The worker's whole local import graph (from
// worker/main.ts, including the in-process run-agent) is walked; every external
// module must be on this reviewed list, and no file may open a socket, a TLS
// stream, a WebSocket or an XHR of its own. A new SDK or raw client fails here
// until the gate is reviewed for it.
const REVIEWED_EXTERNAL_MODULES = new Set([
  "https://esm.sh/@supabase/supabase-js@2", // the project's own API, through fetch
  "node:async_hooks", // the gate's mission context
]);
const NON_FETCH_NETWORK = [
  /\bnode:(?:http|https|http2|net|tls|dgram)\b/, /\bDeno\.(?:connect|connectTls|startTls|connectQuic)\s*\(/,
  /\bnew\s+WebSocket\s*\(/, /\bXMLHttpRequest\b/, /\bnpm:(?:openai|@anthropic-ai\/sdk|axios|node-fetch|undici|got|apify-client)\b/,
];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const IMPORTS = [/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g];

Deno.test("smoke admission: the worker's code reaches the network only through fetch", () => {
  const seen = new Set<string>();
  const external = new Map<string, string>();
  const queue = [new URL("worker/main.ts", ROOT).href];
  while (queue.length) {
    const u = queue.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const src = stripComments(Deno.readTextFileSync(new URL(u)));
    const rel = u.slice(ROOT.href.length);
    for (const re of NON_FETCH_NETWORK) assert(!re.test(src), `${rel} uses a non-fetch network client (${re})`);
    for (const re of IMPORTS) {
      for (const m of src.matchAll(re)) {
        if (m[1].startsWith(".")) queue.push(new URL(m[1], u).href);
        else if (!external.has(m[1])) external.set(m[1], rel);
      }
    }
  }
  assert(seen.size > 100, `the walk reached the in-process run-agent (${seen.size} files)`);
  assert([...seen].some((u) => u.endsWith("supabase/functions/run-agent/index.ts")));
  for (const [mod, from] of external) {
    assert(REVIEWED_EXTERNAL_MODULES.has(mod), `${from} imports ${mod}, which the admission gate has not been reviewed for`);
  }
});
