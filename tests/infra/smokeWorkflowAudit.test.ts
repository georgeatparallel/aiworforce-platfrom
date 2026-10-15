import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parse } from "https://deno.land/std@0.224.0/yaml/mod.ts";
import spec from "../../docs/launch/discovery-smoke-budget.spec.json" with {
  type: "json",
};
import {
  assessWorker,
  readAudit,
  type WorkerProposal,
} from "./smokeWorkflowAudit.ts";
Deno.test("independent workflow audit matches the recorded repository declaration report", async () => {
  const report = await readAudit();
  const stored = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/launch/smoke-worker-independent-audit.json",
        import.meta.url,
      ),
    ),
  );
  assertEquals(report, stored);
  assertEquals(report.status, "NO_GO");
  assertEquals(report.authorizes_execution, false);
  assertEquals(report.cost_evidence.actual_provider_receipts, null);
});
Deno.test("synthetic matching worker declarations never imply durable enforcement or an invoice guarantee", async () => {
  const wf = parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/launch/proposals/discovery-test-worker.workflow.yml",
        import.meta.url,
      ),
    ),
  ) as WorkerProposal;
  Object.assign(
    wf.jobs.worker.env,
    spec.candidate_environment_spec_not_applied,
  );
  wf.jobs.worker.env.OPENAI_API_KEY = "${{ secrets.TEST_OPENAI_API_KEY }}";
  const report = assessWorker(wf);
  assertEquals(report.counts.mismatches, 0);
  assertEquals(report.counts.unverified, 4);
  assertEquals(report.status, "NO_GO");
  assertEquals(report.authorizes_execution, false);
});
Deno.test("synthetic loss of strict pricing or an all-model attempt cap is detected", async () => {
  const wf = parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/launch/proposals/discovery-test-worker.workflow.yml",
        import.meta.url,
      ),
    ),
  ) as WorkerProposal;
  Object.assign(
    wf.jobs.worker.env,
    spec.candidate_environment_spec_not_applied,
  );
  delete wf.jobs.worker.env.MODEL_RUN_REQUIRE_PRICED;
  delete wf.jobs.worker.env.MODEL_RUN_MAX_ALL_CALLS;
  const report = assessWorker(wf);
  for (const key of ["MODEL_RUN_REQUIRE_PRICED", "MODEL_RUN_MAX_ALL_CALLS"]) {
    assert(report.checks.some((c) => c.id === key && c.status === "MISMATCH"));
  }
});
