// Offline evaluator for an operator-reviewed smoke observation. It never executes a mission.
import proposed from "./smoke-mission.proposed.json" with { type: "json" };

export interface SmokeObservation {
  preconditions_verified: boolean;
  independent_evidence_review: boolean;
  qualified: number;
  discovered: number;
  rejected: number;
  unresolved: number;
  unsupported_matches: number;
  false_exclusions: number;
  unknown_promotions: number;
  failures: number;
  duplicate_purchases: number;
  unreserved_purchases: number;
  post_stop_purchases: number;
  criteria_broadened: boolean;
  cost_complete: boolean;
  accounting_reconciled: boolean;
  committed_provider_usd: number | null;
  committed_model_usd: number | null;
  settled_credits: number | null;
  model_calls: number;
  provider_purchases: Record<string, number>;
  adoption_polls: number;
  detail_urls: number;
  discovery_rows: number;
  discovery_pages: number;
  slices: number;
  duration_seconds: number;
  terminal_rows_consistent: boolean;
  no_held_claim_or_lease: boolean;
  terminal: "completed" | "search_exhausted" | "budget_exhausted" | "failed";
}

export function assessSmoke(o: SmokeObservation) {
  const limits = proposed.limits;
  const providerCaps = limits.provider_purchase_caps as Record<string, number>;
  const counts = Object.values(o.provider_purchases);
  const finiteCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const checks = {
    preconditions: o.preconditions_verified,
    independent_review: o.independent_evidence_review,
    sane_counts: [
      o.qualified,
      o.discovered,
      o.rejected,
      o.unresolved,
      o.model_calls,
      o.adoption_polls,
      o.detail_urls,
      o.discovery_rows,
      o.discovery_pages,
      o.slices,
      ...counts,
    ].every(finiteCount),
    partition: o.discovered === o.qualified + o.rejected + o.unresolved,
    evidence_safeguards: o.unsupported_matches === 0 &&
      o.false_exclusions === 0 && o.unknown_promotions === 0 &&
      !o.criteria_broadened,
    execution: o.failures === 0 &&
      ["completed", "search_exhausted", "budget_exhausted"].includes(
        o.terminal,
      ),
    purchases: o.duplicate_purchases === 0 && o.unreserved_purchases === 0 &&
      o.post_stop_purchases === 0,
    prices_and_accounting: o.cost_complete && o.accounting_reconciled,
    spend_cap: o.committed_provider_usd !== null &&
      Number.isFinite(o.committed_provider_usd) &&
      o.committed_provider_usd >= 0 &&
      o.committed_provider_usd <= limits.mission_provider_usd,
    credit_cap: o.settled_credits !== null && finiteCount(o.settled_credits) &&
      o.settled_credits <= limits.maximum_customer_credits,
    model_and_total_spend: o.committed_model_usd !== null &&
      Number.isFinite(o.committed_model_usd) && o.committed_model_usd >= 0 &&
      o.committed_model_usd <= limits.maximum_model_usd &&
      o.committed_provider_usd !== null &&
      o.committed_provider_usd + o.committed_model_usd <=
        limits.maximum_total_usd,
    provider_caps:
      Object.entries(o.provider_purchases).every(([actor, calls]) =>
        calls <= (providerCaps[actor] ?? 0)
      ) && counts.reduce((n, x) =>
          n + x, 0) <= limits.maximum_provider_purchases,
    model_cap: o.model_calls <= limits.maximum_model_calls,
    quota_bound: o.qualified <= limits.requested_companies,
    poll_cap: o.adoption_polls <= 5,
    discovery_caps: o.discovered <= limits.maximum_discovered_companies &&
      o.detail_urls <= limits.maximum_company_detail_urls &&
      o.discovery_rows <= limits.maximum_discovery_rows &&
      o.discovery_pages <= limits.maximum_discovery_pages,
    execution_caps: o.slices <= limits.maximum_slices &&
      Number.isFinite(o.duration_seconds) && o.duration_seconds >= 0 &&
      o.duration_seconds <= limits.maximum_duration_seconds,
    terminal_consistency: o.terminal_rows_consistent &&
      o.no_held_claim_or_lease &&
      (o.terminal !== "completed" || o.qualified >= limits.requested_companies),
  };
  const safetyPass = Object.values(checks).every(Boolean);
  const efficacyPass = o.qualified >= limits.requested_companies &&
    o.terminal === "completed";
  return {
    safety_pass: safetyPass,
    efficacy_pass: efficacyPass,
    pass: safetyPass && efficacyPass,
    checks,
    failed_checks: Object.entries(checks).filter(([, pass]) => !pass).map((
      [name],
    ) => name),
    zero_result: o.discovered === 0,
    authorization:
      "This evaluates supplied observations; it grants no permission to run a mission.",
  };
}
