// Read-only repository declaration audit. This NEVER authorizes execution.
import { parse } from "https://deno.land/std@0.224.0/yaml/mod.ts";
import spec from "../../docs/launch/discovery-smoke-budget.spec.json" with {
  type: "json",
};
export interface WorkerProposal {
  jobs: {
    worker: {
      env: Record<string, string>;
      steps: Array<{ run?: string }>;
      "timeout-minutes": number;
    };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
}
export interface Check {
  id: string;
  status: "DECLARED_MATCH" | "MISMATCH" | "UNVERIFIED";
  expected: unknown;
  observed: unknown;
}
export function assessWorker(workflow: WorkerProposal) {
  const checks: Check[] = [];
  const e = workflow.jobs.worker.env;
  for (
    const [key, expected] of Object.entries(
      spec.candidate_environment_spec_not_applied,
    )
  ) {
    if (key.endsWith("WORKSPACES")) continue;
    checks.push({
      id: key,
      status: e[key] === expected ? "DECLARED_MATCH" : "MISMATCH",
      expected,
      observed: e[key] ?? null,
    });
  }
  const worker = e.LEAD_V2_WORKER_WORKSPACES;
  checks.push({
    id: "same_single_workspace_binding",
    status: !!worker && worker === e.LEAD_V2_MISSION_CAP_WORKSPACES
      ? "DECLARED_MATCH"
      : "MISMATCH",
    expected: "same one test workspace on worker and cap",
    observed: {
      worker: worker ?? null,
      cap: e.LEAD_V2_MISSION_CAP_WORKSPACES ?? null,
    },
  });
  checks.push({
    id: "single_workflow_concurrency",
    status: workflow.concurrency.group === "discovery-test-worker" &&
        workflow.concurrency["cancel-in-progress"] === false
      ? "DECLARED_MATCH"
      : "MISMATCH",
    expected: "one serialized manual worker workflow",
    observed: workflow.concurrency,
  });
  checks.push({
    id: "test_openai_credential_binding",
    status: /secrets\.TEST_[A-Z_]+/.test(e.OPENAI_API_KEY ?? "")
      ? "DECLARED_MATCH"
      : "MISMATCH",
    expected: "OPENAI_API_KEY from a TEST_ secret for gptProvider",
    observed: e.OPENAI_API_KEY ?? null,
  });
  for (
    const [id, expected] of Object.entries({
      logical_mission_absolute_deadline:
        "one original absolute five-minute deadline, including queue/retries/backoff",
      durable_physical_transport_coverage:
        "every physical model/provider/retry/page/poll/receipt operation admitted",
      actual_workspace_and_test_target:
        "one resolved approved internal workspace and isolated target",
      external_vendor_liability:
        "verified request/token bounds and external controls; estimates alone do not prove invoice maximum",
    })
  ) checks.push({ id, status: "UNVERIFIED", expected, observed: null });
  return {
    schema: "independent-smoke-workflow-audit-v1",
    evidence_class: "repository_source_observation",
    base: "9453b7c5",
    status: "NO_GO",
    authorizes_execution: false,
    checks,
    counts: {
      declared_matches:
        checks.filter((c) => c.status === "DECLARED_MATCH").length,
      mismatches: checks.filter((c) => c.status === "MISMATCH").length,
      unverified: checks.filter((c) => c.status === "UNVERIFIED").length,
    },
    cost_evidence: {
      actual_provider_receipts: null,
      historical_captures: 0,
      verified_live_prices: false,
    },
    note:
      "A matching declaration is not runtime enforcement. No secret values or resolved environment settings were read.",
  };
}
export async function readAudit() {
  return assessWorker(
    parse(
      await Deno.readTextFile(
        new URL(
          "../../docs/launch/proposals/discovery-test-worker.workflow.yml",
          import.meta.url,
        ),
      ),
    ) as WorkerProposal,
  );
}
if (import.meta.main) console.log(JSON.stringify(await readAudit(), null, 2));
