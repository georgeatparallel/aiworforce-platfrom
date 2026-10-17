import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
const root = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
Deno.test("test no-Brain guard: explicit opt-in, admission dependency and final install order", () => {
  const sh = read("scripts/test-project/build-test-schema.sh");
  assert(sh.includes("--with-test-no-brain-guard) with_no_brain=1; shift ;;"));
  assert(
    sh.includes("--with-test-no-brain-guard requires --with-held-admission"),
  );
  assert(
    sh.indexOf("if [ $with_admission -eq 1 ]; then apply") <
      sh.indexOf("if [ $with_no_brain -eq 1 ]; then apply"),
  );
  assert(sh.includes('no_brain="$root/scripts/test-project/sql/'));
});
Deno.test("test no-Brain guard: no default production or local migration glob can install it", async () => {
  for (const folder of ["supabase/migrations/", "supabase/migrations-held/"]) {
    for await (const entry of Deno.readDir(new URL(folder, root))) {
      if (entry.name.endsWith(".sql")) {
        assert(
          !read(folder + entry.name).includes(
            "create trigger discovery_test_no_company_brain",
          ),
        );
      }
    }
  }
});
Deno.test("test no-Brain guard: missing admission refuses before any database connection", async () => {
  const o = await new Deno.Command("bash", {
    args: [
      new URL("scripts/test-project/build-test-schema.sh", root).pathname,
      "--confirm",
      "testref",
      "--with-test-no-brain-guard",
    ],
    clearEnv: true,
    env: {
      PATH: `${new URL("tests/infra/fixtures/fake-psql/", root).pathname}:${
        Deno.env.get("PATH") ?? ""
      }`,
      TEST_PROJECT_REF: "testref",
      TEST_DB_URL: "postgresql://x@db.testref.supabase.co/postgres",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(o.code, 1);
  const s = new TextDecoder().decode(o.stdout) +
    new TextDecoder().decode(o.stderr);
  assert(s.includes("requires --with-held-admission"));
  assert(!s.includes("PSQL_CALLED"));
});
