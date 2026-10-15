// The credit re-arm fix is HELD: it is applied only to the disposable
// database-contract lane, never by a deploy path, and its rollback restores the
// baseline functions verbatim. The behaviour itself is proven against real
// Postgres + PostgREST in tests/db-contract/creditRearm.contract.test.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const NAME = "20261015130000_credits_rearm_settled_key";
const UP = read(`supabase/migrations-held/${NAME}.sql`);
const DOWN = read(`supabase/migrations-held/rollback/${NAME}.down.sql`);
const BASELINE = read("supabase/migrations-held/20260816120000_baseline_schema.sql");

/** A function's full definition from `CREATE [OR REPLACE] FUNCTION` to its closing `$$;`. */
function definition(sql: string, fn: string): string {
  const m = sql.match(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert(m && m.index !== undefined, `${fn} is defined`);
  const end = sql.indexOf("$$;", sql.indexOf("AS $$", m.index)) + 3;
  return sql.slice(m.index, end).replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION");
}

Deno.test("credit re-arm: held — not in the production-synced directory, not in any deploy path", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("supabase/migrations/", ROOT))) names.push(e.name);
  assert(!names.some((n) => n.includes("credits_rearm")), "must not sit in supabase/migrations/");
  assert(!read("scripts/local-supabase/rebuild-local-db.sh").includes(NAME));
  for await (const e of Deno.readDir(new URL(".github/workflows/", ROOT))) {
    assert(!read(`.github/workflows/${e.name}`).includes(NAME), `${e.name} must not name the held billing fix`);
  }
  const bootstrap = read("tests/db-contract/bootstrap.sh");
  assert(bootstrap.includes(`${NAME}.sql`), "the disposable contract lane applies it");
  assert(bootstrap.includes("only builds a database on localhost"), "and only to localhost");
});

Deno.test("credit re-arm: only refunded keys re-arm; money-taken and in-flight keys still replay", () => {
  assert(UP.includes("v_existing.status not in ('not_charged', 'released')"));
  assert(UP.includes("for update;"), "the existing row is locked before it is re-armed");
  assert(/and balance_credits >= p_amount/.test(UP.slice(UP.indexOf("RE-ARM"))), "a re-arm is balance-checked");
  assert(UP.includes("coalesce(rearmed_at, created_at) < now() - p_older_than"), "the reaper window runs from the re-arm");
  assert(!/function public\.credits_finalize/i.test(UP), "credits_finalize is untouched");
});

Deno.test("credit re-arm: the rollback restores both functions byte-identical to the baseline", () => {
  for (const fn of ["credits_reserve", "credits_release_stale"]) {
    assertEquals(definition(DOWN, fn), definition(BASELINE, fn), `${fn} is restored verbatim`);
  }
  assert(DOWN.includes("drop column if exists rearm_count") && DOWN.includes("drop column if exists rearmed_at"));
  assert(DOWN.indexOf("drop column") > DOWN.lastIndexOf("$$;"), "columns are dropped only after the functions stop reading them");
});
