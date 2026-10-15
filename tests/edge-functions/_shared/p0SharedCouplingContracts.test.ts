// LEAD V2 P0 — THE SHARED SYSTEMS LEAD V2 TOUCHES KEEP THEIR CONTRACTS.
//
// Lead V2 shares the capability engine, provider transport, credits, the model
// ledger and spend ceiling, the Company Brain, and the continuation / sweeper
// machinery with V1, Signals monitoring, Pilot and Content. These tests pin
// the contracts P0 depends on, and that P0's own modules stay pure — so later
// phases cannot change a neighbour by accident.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url);
const src = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));
const FN = (p: string) => src(`supabase/functions/${p}`);

function tsFiles(dir: URL, out: string[] = []): string[] {
  for (const e of Deno.readDirSync(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) tsFiles(u, out);
    else if (e.name.endsWith(".ts")) out.push(u.pathname);
  }
  return out;
}
const FUNCTIONS = new URL("supabase/functions/", ROOT);
const importers = (re: RegExp) => tsFiles(FUNCTIONS)
  .filter((p) => re.test(Deno.readTextFileSync(p)))
  .map((p) => p.slice(FUNCTIONS.pathname.length)).sort();

Deno.test("P0 modules are pure: no transport, credits, ledger, DB or network", () => {
  for (const p of ["_shared/capabilityExecutability.ts", "_shared/monitoringRetrievalPort.ts"]) {
    const s = FN(p);
    const imports = [...s.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const i of imports) {
      assert(["./leadCapabilityGraph.ts", "./leadExecutionEngine.ts", "./leadMission.ts"].includes(i), `${p} imports ${i}`);
    }
    assertFalse(/fetch\(|runTool|\.rpc\(|\.from\(/.test(s), p);
  }
});

Deno.test("provider transport: runTool keeps its importers", () => {
  assertEquals(importers(/import \{[^}]*\brunTool\b[^}]*\} from/), [
    "_shared/toolRegistry.ts", "run-agent/index.ts", "run-lead-action/index.ts", "run-monitoring-scan/index.ts",
    "setup-company-brain/index.ts", "unlock-founders/index.ts",
  ]);
  assertFalse(FN("_shared/toolRegistry.ts").includes("capabilityExecutability"));
});

Deno.test("credits: reserve/finalize RPCs are unchanged", () => {
  const c = FN("_shared/creditAuthorization.ts");
  assert(c.includes('rpc("credits_reserve"') && c.includes('rpc("credits_finalize"'));
});

Deno.test("model ledger + spend ceiling: one view, shared by Lead, Content and Brain", () => {
  assert(FN("_shared/modelSpendCeiling.ts").includes('.from("lead_model_calls")'));
  const users = importers(/\bauthorizeModelSpend\b/);
  for (const f of ["run-agent/index.ts", "pilot-chat/index.ts", "orchestrate/index.ts",
    "generate-content-image/index.ts", "generate-company-brain-draft/index.ts", "setup-company-brain/index.ts"]) {
    assert(users.includes(f), `${f} still gated by the shared ceiling`);
  }
});

Deno.test("orchestrate routes to V2 only for an allowlisted workspace with a valid kickoff", () => {
  const o = FN("orchestrate/index.ts");
  assert(o.includes('resolveLeadExecutionEngine(workspace_id, (k) => Deno.env.get(k)) === "v2_worker"\n      && validateV2KickoffBody(kickoffBody).ok'));
});

Deno.test("resume-stalled-leads excludes V2-owned tasks", () => {
  const r = FN("resume-stalled-leads/index.ts");
  // Strict: an unreadable ownership answer skips the pass (leadMissionV2Request.test.ts).
  assert(r.includes("loadV2OwnedTaskIdsStrict(admin as never, rows.map((r) => r.id))"));
  assert(r.includes("excludeV2OwnedTasks(rows, v2Owned)"));
});

Deno.test("run-agent refuses both continuation doors into a V2 lineage, except for the worker", () => {
  const ra = FN("run-agent/index.ts");
  const parent = ra.indexOf("if (leadResumeParentTaskId && inProcess.continuationOwner !== \"v2_queue\")");
  const resume = ra.indexOf("if (resume_task_id) {");
  assert(parent > 0 && parent < resume, "parent-task refusal runs before any resume work");
  assert(ra.slice(parent, resume).includes("loadV2OwnedTaskIds(supabase as never, [leadResumeParentTaskId])"));
  assert(ra.slice(parent, resume).includes('reason: "v2_queue_owned"'));
  assert(ra.includes("loadV2OwnedTaskIds(supabase as never, [resume_task_id])"));
  assert(src("worker/leadMissionRunner.ts").includes('continuationOwner: "v2_queue"'), "the worker is exempt");
});

Deno.test("continue-workflow refuses a V2-owned lineage before creating anything", () => {
  const cw = FN("continue-workflow/index.ts");
  const refusal = cw.indexOf("loadV2OwnedTaskIds(admin as never, [request.original_task_id])");
  const spec = cw.indexOf("const spec = decision.spec;");
  const invoke = cw.indexOf("lead_resume_parent_task_id: spec.lineage.parent_task_id");
  assert(spec > 0 && refusal > spec && refusal < invoke, "refused after the decision, before run-agent is invoked");
  assert(cw.slice(refusal, refusal + 400).includes('error: "v2_queue_owned"'));
});

Deno.test("run-agent recovery reads skip a fresh mission and log readable errors", () => {
  const ra = FN("run-agent/index.ts");
  const skips = ra.split("if (!leadResumeParentTaskId) return [] as LedgerStartedRow[];").length - 1;
  assertEquals(skips, 2, "completed-run and pending-run recovery both skip without a parent");
  assertFalse(ra.includes('read failed", String(error)'), "no more `[object Object]`");
  assertEquals(ra.split("describeReadError(error)").length - 1, 2);
});

Deno.test("stuck-run sweeper: V2 exclusion is prepared as a HELD migration, not applied", () => {
  const held = src("supabase/migrations-held/20260915120000_sweep_skips_v2_queue_tasks.sql");
  assert(held.includes("create or replace function public.tasks_sweep_stuck_runs("));
  assert(/and not exists \(\s*select 1 from public\.lead_mission_queue q\s*where q\.task_id = t\.id\s*and q\.status in \('queued', 'running', 'resumable'\)/
    .test(held));
  // Everything else is the live function, unchanged.
  for (const line of ["where t.status = 'running'", "and t.updated_at < now() - stale_after",
    "insert into public.ops_stuck_run_archive", "set status = 'ready', updated_at = now()"]) {
    assert(held.includes(line), line);
  }
  assertFalse(held.includes("cron.schedule"), "the cron is not re-registered");
  for (const e of Deno.readDirSync(new URL("supabase/migrations/", ROOT))) {
    assertFalse(e.name.includes("sweep_skips_v2_queue"), "not in the applied directory");
  }
  assert(src("supabase/migrations-held/README.md").includes("20260915120000_sweep_skips_v2_queue_tasks.sql"));
});
