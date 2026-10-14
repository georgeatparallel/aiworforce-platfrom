// A reporting adapter over canonical Replay Lab results. No alternative qualifier.
import type { SpendLedger } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import type { LeadMissionV1 } from "../../../supabase/functions/_shared/leadMission.ts";
import { deriveMissionCriteria } from "../../../supabase/functions/_shared/missionCriteria.ts";
import type { WorkbenchMissionView } from "../../../supabase/functions/_shared/workbenchMissionView.ts";
import { spendOf } from "../lib/mission.ts";
import type { RecordedProviderCall } from "../lib/provider.ts";

export const fraction = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  percent: denominator
    ? Math.round(numerator / denominator * 10000) / 100
    : null,
});

export interface Expected {
  label: "MATCH" | "NON_MATCH" | "UNKNOWN" | null;
  reason: string;
  counts: number[];
  terminal: string;
  checks: Record<string, string>;
  max_calls: number;
}

export function missionReport(i: {
  id: string;
  mission: LeadMissionV1;
  view: WorkbenchMissionView | null;
  ledger: SpendLedger | null;
  calls: RecordedProviderCall[];
  terminal: string | null;
  queueStatus: string | null;
  expected: Expected;
  refusalCodes?: string[];
  pendingObservationsAvailable?: boolean;
  failures?: Array<{ kind: string; company_key?: string; capability?: string }>;
  slices: Array<
    { decision: string; qualified: number; pending_runs: number | null }
  >;
}) {
  const leads = i.view?.leads ?? [];
  const qualified = leads.filter((l) => l.label !== null).length;
  const rejected =
    leads.filter((l) => ["screened_out", "ineligible"].includes(l.bucket))
      .length;
  const discovered = i.view?.counts.discovered ?? 0;
  const unresolved = discovered - qualified - rejected;
  const hard = deriveMissionCriteria(i.mission).filter((c) =>
    c.kind === "hard"
  );
  const decisions = leads.flatMap((l) =>
    hard.map((c) => {
      const check = l.hard_check_details.find((d) => d.criterion_id === c.id);
      return {
        result: check?.result ?? "unknown",
        supported: !!check?.provenance && check.result !== "unknown" &&
          ["proven", "disproven"].includes(check.provenance.status),
      };
    })
  );
  const bought = i.calls.filter((c) => !c.adopted);
  const paidKeys = bought.map((c) => c.idempotency_key);
  const duplicates = paidKeys.length - new Set(paidKeys).size;
  const unsupportedMatches =
    leads.filter((l) =>
      l.label !== null && hard.some((c) => {
        const d = l.hard_check_details.find((d) => d.criterion_id === c.id);
        return d?.result !== "pass" || d.provenance?.status !== "proven";
      })
    ).length;
  const spend = i.ledger ? spendOf(i.ledger).committed_usd : 0;
  const priced =
    bought.filter((c) =>
      c.estimate_usd !== null && Number.isFinite(c.estimate_usd) &&
      c.estimate_usd >= 0
    ).length;
  const unreserved =
    bought.filter((c) =>
      !i.ledger?.reservations.some((r) =>
        r.idempotency_key === c.idempotency_key && r.status !== "refused_budget"
      )
    ).length;
  const counts = [discovered, qualified, rejected, unresolved];
  const acceptance = {
    expected_counts:
      JSON.stringify(counts) === JSON.stringify(i.expected.counts),
    expected_terminal: i.terminal === i.expected.terminal,
    expected_checks: Object.entries(i.expected.checks).every((
      [dimension, result],
    ) => leads.some((l) => l.hard_checks[dimension] === result)),
    partition_consistent: discovered === leads.length && unresolved >= 0,
    every_match_supported: unsupportedMatches === 0,
    no_unknown_promoted: i.expected.label !== "UNKNOWN" || qualified === 0,
    no_false_hard_exclusion: i.expected.label !== "MATCH" || rejected === 0,
    no_duplicate_purchase: duplicates === 0 && !paidKeys.includes(null),
    reservation_before_call: unreserved === 0,
    provider_cap: i.calls.length <= i.expected.max_calls,
    spend_ceiling: !i.ledger ||
      spend <= i.ledger.ceilings.mission_provider_usd + 1e-9,
    queue_terminal: i.queueStatus === "complete" ||
      i.terminal === "preflight_refused",
    no_observed_provider_failure: (i.failures?.length ?? 0) === 0,
    exact_size_refused: i.id !== "size_exact_requirement" ||
      (i.refusalCodes?.includes("size_range_unprovable") === true &&
        i.calls.length === 0),
  };
  return {
    id: i.id,
    provenance: "synthetic_control" as const,
    label_ref: `labels.synthetic.json#/scenarios/${i.id}`,
    counts: { discovered, qualified, rejected, unresolved },
    company_discovery_yield: fraction(qualified, discovered),
    evidence: {
      supported_hard_decisions: fraction(
        decisions.filter((d) => d.supported).length,
        decisions.length,
      ),
      unknown_hard_checks:
        decisions.filter((d) => d.result === "unknown").length,
      companies_with_unknown:
        leads.filter((l) =>
          hard.some((c) =>
            !l.hard_check_details.some((d) =>
              d.criterion_id === c.id && d.result !== "unknown"
            )
          )
        ).length,
      exact_headcount_proofs: 0, // Catalogued LinkedIn member counts never establish staff counts.
      employee_band_proofs:
        leads.filter((l) =>
          l.hard_check_details.some((d) =>
            d.dimension === "company_size" && d.result !== "unknown" &&
            d.provenance?.dimension === "company_size_band"
          )
        ).length,
    },
    provider_calls: {
      total_transport: i.calls.length,
      purchases: bought.length,
      adoptions: i.calls.length - bought.length,
      pending_responses: i.pendingObservationsAvailable === false
        ? null
        : i.calls.filter((c) => c.pending).length,
      duplicate_purchases: duplicates,
      unreserved_calls: unreserved,
      per_qualified_company: qualified ? bought.length / qualified : null,
      by_actor: Object.fromEntries(
        [...new Set(i.calls.map((c) => c.actor))].sort().map((
          actor,
        ) => [actor, i.calls.filter((c) => c.actor === actor).length]),
      ),
    },
    cost: {
      ledger_committed_estimate_usd: spend,
      provenance:
        "offline production pricing/spec estimates; synthetic purchases, no actual charges",
      priced_purchases: fraction(
        priced,
        bought.length,
      ),
      actual_provider_receipts_usd: null,
      settled_customer_credits: null,
      actual_model_usd: null,
      estimated_usd_per_qualified_company:
        qualified && i.ledger && priced === bought.length
          ? spend / qualified
          : null,
      mission_ceiling_usd: i.ledger?.ceilings.mission_provider_usd ?? null,
    },
    execution: {
      terminal: i.terminal,
      queue_status: i.queueStatus,
      failures: i.failures ?? [],
      failure_observation_scope:
        "returned company provider-error markers and driver faults/exceptions; no complete live provider/model error telemetry",
      slices: i.slices,
      refusal_codes: i.refusalCodes ?? [],
    },
    companies: leads.map((l) => ({
      key: l.company.key,
      bucket: l.bucket,
      hard_checks: l.hard_checks,
      checks: l.hard_check_details.map((d) => ({
        criterion: d.criterion_id,
        result: d.result,
        provenance: d.provenance,
      })),
      evidence: l.key_evidence,
    })),
    unsupported_matches: unsupportedMatches,
    false_hard_exclusions: i.expected.label === "MATCH" ? rejected : 0,
    acceptance: {
      pass: Object.values(acceptance).every(Boolean),
      checks: acceptance,
    },
  };
}
