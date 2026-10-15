// SCHEMA COMPATIBILITY: every literal PostgREST query the Lead V2 runtime
// sends — run-agent, the worker and the shared modules — is executed against
// the schema the migrations actually build, and every RPC call's arguments are
// checked against the function's real signature.
//
// What this catches: a column, JSON path or alias that does not exist (42703,
// PGRST100), a filter on a renamed column, an RPC argument the function does
// not take or a required argument the caller omits (PGRST202). It cannot see a
// query built from a template literal or a variable column; those are listed
// as skipped so the gap is visible, never silent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { serviceClient, sql } from "./lib/harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const ROOT = new URL("../../", import.meta.url);

async function sources(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  const add = async (rel: string) => out.push({ file: rel, text: await Deno.readTextFile(new URL(rel, ROOT)) });
  await add("supabase/functions/run-agent/index.ts");
  for (const dir of ["supabase/functions/_shared/", "worker/"]) {
    for await (const e of Deno.readDir(new URL(dir, ROOT))) {
      if (e.isFile && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) await add(dir + e.name);
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** `"a" + "b"\n + "c"` → "abc"; null when anything but string literals is joined. */
function literalConcat(src: string): string | null {
  const parts = src.trim().split(/\s*\+\s*/);
  let out = "";
  for (const p of parts) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(p.trim());
    if (!m) return null;
    out += m[1];
  }
  return out;
}

interface Query { file: string; line: number; table: string; select: string; filterCols: string[]; ors: string[] }

/** Each `.from("t")…;` statement with a literal select. */
function queriesIn(file: string, text: string, consts: Record<string, string>): { found: Query[]; skipped: string[] } {
  const found: Query[] = []; const skipped: string[] = [];
  const re = /\.from\(\s*(?:"([a-z_]+)"|LEAD_EXECUTION_CALLS_TABLE)\s*\)/g;
  for (let m; (m = re.exec(text));) {
    const table = m[1] ?? "lead_execution_calls";
    const end = text.indexOf(";", m.index);
    const stmt = text.slice(m.index, end < 0 ? undefined : end);
    const sel = /\.select\(\s*([^)]*?)\s*(?:,\s*\{[^}]*\}\s*)?\)/s.exec(stmt);
    if (!sel) continue;  // insert/update/delete without a projection: covered elsewhere
    const line = text.slice(0, m.index).split("\n").length;
    const select = literalConcat(sel[1]) ?? (consts[sel[1].trim()] ?? null);
    if (select === null) { skipped.push(`${file}:${line} ${table} select(${sel[1].slice(0, 40)})`); continue; }
    const filterCols = [...stmt.matchAll(/\.(?:eq|neq|in|gte|gt|lte|lt|like|ilike|is|not|order)\(\s*"([^"]+)"/g)].map((x) => x[1]);
    const ors = [...stmt.matchAll(/\.or\(\s*"([^"]+)"\s*\)/g)].map((x) => x[1]);
    found.push({ file, line, table, select, filterCols, ors });
  }
  return { found, skipped };
}

/** The worker's composed projections (string constants built from literals). */
function stringConsts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(?:export )?const ([A-Z_]+)\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*|[A-Z_]+\s*\+\s*)+);/g)) {
    const expr = m[2].replace(/\b([A-Z_]+)\b(?=\s*\+)/g, (_, k) => (out[k] !== undefined ? JSON.stringify(out[k]) : k));
    const v = literalConcat(expr);
    if (v !== null) out[m[1]] = v;
  }
  return out;
}

/** Run a query's shape (projection, filter columns, `or` filters) with no rows. */
interface ShapeBuilder {
  not(column: string, op: string, value: null): ShapeBuilder;
  or(filters: string): ShapeBuilder;
  limit(n: number): PromiseLike<{ error: { code?: string; message?: string } | null }>;
}
async function runShape(db: Awaited<ReturnType<typeof serviceClient>>, q: Query): Promise<{ code?: string; message?: string } | null> {
  let b = db.from(q.table).select(q.select) as unknown as ShapeBuilder;
  // A filter is checked for EXISTENCE, not for its value: `not … is null` is
  // valid on every type, a JSON path included.
  for (const c of q.filterCols) b = b.not(c, "is", null);
  for (const o of q.ors) b = b.or(o);
  const { error } = await b.limit(0);
  return error ?? null;
}

Deno.test("the sweep itself catches a missing column, a missing filter column and a bad JSON alias", opts, async () => {
  const db = await serviceClient();
  const fake = `
    a = await db.from("tasks").select("id, no_such_column").eq("id", x);
    b = await db.from("tasks").select("id").eq("no_such_filter", x);
    c = await db.from("lead_lineages").select("status, r:current_state->>terminal_status").eq("lineage_id", x);
    d = await db.from("tasks").select("id, " +
      "status").or("result->>terminal_status.is.null,nope.eq.1");`;
  const { found } = queriesIn("fake.ts", fake, {});
  assertEquals(found.map((q) => q.select), ["id, no_such_column", "id", "status, r:current_state->>terminal_status", "id, status"]);
  const errors = await Promise.all(found.map((q) => runShape(db, q)));
  assert(errors[0], "a missing column fails");
  assert(errors[1], "a missing filter column fails");
  assertEquals(errors[2], null, "a valid JSON-path alias passes");
  assert(errors[3], "a bad column inside an `or` fails");
});

Deno.test("every literal Lead V2 select, filter column and `or` runs against the migrated schema", opts, async () => {
  const db = await serviceClient();
  const all: Query[] = []; const skipped: string[] = [];
  for (const { file, text } of await sources()) {
    const r = queriesIn(file, text, stringConsts(text));
    all.push(...r.found); skipped.push(...r.skipped);
  }
  assert(all.length >= 100, `expected the sweep to find the runtime's queries, found ${all.length}`);
  const failures: string[] = [];
  for (const q of all) {
    const error = await runShape(db, q);
    if (error) failures.push(`${q.file}:${q.line} ${q.table} select(${q.select}) → ${error.code} ${error.message}`);
  }
  if (skipped.length) console.log(`[schema-compat] ${skipped.length} non-literal selects not checked:\n  ${skipped.join("\n  ")}`);
  console.log(`[schema-compat] ${all.length} queries checked`);
  assertEquals(failures, [], failures.join("\n"));
});

interface RpcCall { file: string; line: number; fn: string; keys: string[] }

function rpcCallsIn(file: string, text: string): RpcCall[] {
  const out: RpcCall[] = [];
  for (const m of text.matchAll(/\.rpc\(\s*"([a-z_]+)"\s*,\s*\{([^}]*)\}/gs)) {
    const body = m[2].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const keys = [...body.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*(?=[:,]|$)/gm)].map((x) => x[1]);
    out.push({ file, line: text.slice(0, m.index).split("\n").length, fn: m[1], keys });
  }
  return out;
}

Deno.test("every literal RPC call names a real function and only real arguments, and supplies every required one", opts, async () => {
  const sigs = await sql<Array<{ fn: string; args: string[]; required: number }>>`
    select p.proname as fn,
           coalesce(p.proargnames[1:p.pronargs], '{}') as args,
           p.pronargs - p.pronargdefaults as required
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'`;
  const calls: RpcCall[] = [];
  for (const { file, text } of await sources()) calls.push(...rpcCallsIn(file, text));
  assert(calls.length >= 8, `expected the runtime's RPC calls, found ${calls.length}`);
  const failures: string[] = [];
  for (const c of calls) {
    const overloads = sigs.filter((s) => s.fn === c.fn);
    if (overloads.length === 0) { failures.push(`${c.file}:${c.line} ${c.fn}: no such function`); continue; }
    const fits = overloads.some((s) =>
      c.keys.every((k) => s.args.includes(k)) && s.args.slice(0, s.required).every((a) => c.keys.includes(a)));
    if (!fits) {
      failures.push(`${c.file}:${c.line} ${c.fn}(${c.keys.join(", ")}) fits no overload: ` +
        overloads.map((s) => `(${s.args.join(", ")}; ${s.required} required)`).join(" | "));
    }
  }
  console.log(`[schema-compat] ${calls.length} RPC calls checked`);
  assertEquals(failures, [], failures.join("\n"));
});

Deno.test("the RPCs the Lead V2 runtime depends on exist with the exact signatures it calls", opts, async () => {
  // Calls built from a variable argument object (release_lead_mission) are not
  // visible to the sweep above, so the Lead V2 surface is pinned explicitly.
  const want: Record<string, string> = {
    claim_sourcing_continuation: "p_task_id uuid, p_workspace_id uuid, p_claim_id uuid, p_lease_seconds integer",
    release_sourcing_continuation: "p_task_id uuid, p_workspace_id uuid, p_claim_id uuid, p_row_status text",
    acquire_lineage_lease: "p_lineage_id uuid, p_workspace_id uuid, p_holder_task_id uuid, p_mission_hash text, p_lease_seconds integer",
    release_lineage_lease: "p_lineage_id uuid, p_workspace_id uuid, p_holder_task_id uuid, p_expected_version integer, p_next_state jsonb, p_terminal_reason text, p_made_progress boolean",
    claim_next_lead_mission: "p_worker_id uuid, p_lease_seconds integer",
    heartbeat_lead_mission: "p_queue_id uuid, p_worker_id uuid, p_lease_seconds integer",
    bind_lead_mission_execution: "p_queue_id uuid, p_worker_id uuid, p_task_id uuid, p_lineage_id uuid",
    release_lead_mission: "p_queue_id uuid, p_worker_id uuid, p_status text, p_outcome jsonb, p_lineage_slices integer",
    cancel_lead_mission: "p_queue_id uuid, p_workspace_id uuid",
    credits_reserve: "p_workspace uuid, p_amount integer, p_idempotency_key text, p_kind text, p_task_id uuid, p_company_key text",
    credits_finalize: "p_transaction_id uuid, p_actual integer, p_status text, p_reason text",
  };
  const rows = await sql<Array<{ fn: string; args: string }>>`
    select p.proname as fn, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(${Object.keys(want)})`;
  for (const [fn, args] of Object.entries(want)) {
    assert(rows.some((r) => r.fn === fn && r.args === args), `${fn}(${args}) — found: ${rows.filter((r) => r.fn === fn).map((r) => r.args).join(" | ") || "none"}`);
  }
});
