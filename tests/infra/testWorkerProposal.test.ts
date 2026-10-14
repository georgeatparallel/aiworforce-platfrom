// The test-worker workflow is a PROPOSAL: it must stay outside
// .github/workflows/ (so GitHub never loads it), and the guards that make it
// safe to activate later must not erode while it waits.
// docs/launch/test-worker-hosting.md explains each one.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parse } from "https://deno.land/std@0.224.0/yaml/mod.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const PATH = "docs/launch/proposals/discovery-test-worker.workflow.yml";
const RAW = read(PATH);
// deno-lint-ignore no-explicit-any
const wf = parse(RAW) as any;
const job = wf.jobs.worker;
const steps: Array<{ name?: string; run?: string; uses?: string }> = job.steps;
const guard = steps[0].run ?? "";

Deno.test("test worker: the proposal is not an active workflow", async () => {
  for await (const e of Deno.readDir(new URL(".github/workflows/", ROOT))) {
    const text = read(`.github/workflows/${e.name}`);
    assert(!text.includes("discovery-test-worker"), `${e.name} must not carry the proposal`);
    assert(!text.includes("TEST_SUPABASE_SERVICE_ROLE_KEY"), `${e.name} must not read the test project's secrets`);
  }
});

Deno.test("test worker: manual only, one at a time, bounded, read-only token", () => {
  assertEquals(Object.keys(wf.on), ["workflow_dispatch"], "no push, schedule or PR trigger");
  assertEquals(wf.concurrency, { group: "discovery-test-worker", "cancel-in-progress": false });
  assertEquals(wf.permissions, { contents: "read" });
  assertEquals(job["timeout-minutes"], 45);
  assertEquals(job.environment, "discovery-test");
});

Deno.test("test worker: the refusal step runs first and refuses production and the abandoned project", () => {
  assert(steps[0].name?.startsWith("Refuse"), "the guard is the first step, before checkout");
  assert(guard.includes("ohsdatpvfdjdemstoiuj") && guard.includes("wqnigjhcwjxtmordrwno"));
  assert(guard.includes('[ "$CONFIRM_REF" = "$TEST_PROJECT_REF" ]'));
  assert(guard.includes('[ "$SUPABASE_URL" = "https://$CONFIRM_REF.supabase.co" ]'));
  assert(guard.includes("!= *,*") && guard.includes('!= "*"'), "exactly one workspace");
  assert(guard.includes('-le 25'), "the session is capped");
  // Inputs reach the shell through env, never by interpolation into the script.
  for (const s of steps) assert(!(s.run ?? "").includes("${{"), `no expression interpolation in '${s.name ?? s.uses}'`);
});

Deno.test("test worker: spend controls are set, fail-closed, and never from production secrets", () => {
  const env = job.env as Record<string, string>;
  assertEquals(env.LEAD_CREDIT_ENFORCEMENT, "enforce");
  assertEquals(env.LINEAGE_LEASE_ENFORCED, "true");
  assertEquals(env.MODEL_SPEND_ENFORCEMENT, "enforce");
  assert(Number(env.LEAD_V2_MISSION_PROVIDER_USD_CAP) > 0 && Number(env.LEAD_V2_MISSION_PROVIDER_USD_CAP) <= 0.25);
  assert(Number(env.LEAD_V2_MISSION_CREDIT_CAP) > 0 && Number(env.LEAD_V2_MISSION_CREDIT_CAP) <= 10);
  assertEquals(env.LEAD_WORKER_MAX_RUNTIME_MS, "300000");
  for (const [k, v] of Object.entries(env)) {
    if (!String(v).includes("secrets.")) continue;
    assert(/secrets\.TEST_[A-Z_]+/.test(String(v)), `${k} must come from a TEST_ secret`);
  }
});

Deno.test("test worker: one worker session that drains on SIGTERM, on the worker's own Deno", () => {
  const run = steps.find((s) => (s.run ?? "").includes("worker/main.ts"))!.run!;
  assert(run.includes("timeout -s TERM --kill-after=10m"));
  assert(run.includes("deno run --allow-env --allow-net --allow-read worker/main.ts"));
  const deno = steps.find((s) => s.uses?.startsWith("denoland/setup-deno")) as { with?: { "deno-version"?: string } };
  assert(read("worker/Dockerfile").includes(`denoland/deno:${deno.with!["deno-version"]!.replace(/^v/, "")}`));
});

Deno.test("test worker: the hosting doc names the detach step for schedules that call production", () => {
  const doc = read("docs/launch/test-worker-hosting.md");
  assert(doc.includes("scripts/local-supabase/01-local-cron-detach.sql"));
  for (const f of ["20260825140000_monitoring_cron.sql", "20260826170000_resume_stalled_leads_cron.sql"]) {
    assert(read(`supabase/migrations/${f}`).includes("https://ohsdatpvfdjdemstoiuj.supabase.co/functions/v1/"),
      `${f} still calls the literal production URL; the doc's warning must stay true`);
    assert(doc.includes(f));
  }
  // Every shipped migration is listed, so the list cannot silently fall behind.
  const shipped = [...Deno.readDirSync(new URL("supabase/migrations/", ROOT))].map((e) => e.name).filter((n) => n.endsWith(".sql"));
  for (const n of shipped) assert(doc.includes(`\`${n}\``), `the hosting doc's migration list is missing ${n}`);
});
