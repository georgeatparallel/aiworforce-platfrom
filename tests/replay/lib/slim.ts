// CHECKPOINT SLIMMING — replay through the persisted checkpoint, and compare.
//
// `replayLineage` normally hands the next slice the previous slice's records
// in memory. Production does not: run-agent writes `lead_resume_checkpoint`
// into `tasks.result` (JSON), and the next slice reads it back through
// `readCheckpointCompanies`, which validates and bounds every record. The
// carriers here take that path, so a replay resumes exactly the way a
// production slice does.
//
//   persistedCarrier()          what this code writes (closed companies slimmed)
//   persistedCarrier({ full })  what the previous writer wrote (every observation
//                               of every company), for the baseline
//
// `sliceSummary` is the decision-relevant surface of one slice. Two replays are
// equivalent when every slice summary and the terminal match.
//
// PURE.

import { buildCheckpoint, CHECKPOINT_RESULT_KEY, readCheckpointCompanies, RESUME_STATE_VERSION } from "../../../supabase/functions/_shared/leadResumeState.ts";
import type { EngineCompany } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import type { LeadMissionV1 } from "../../../supabase/functions/_shared/leadMission.ts";
import type { EngineSlice } from "./engine.ts";
import { canonicalView } from "./verification.ts";

type Rec = Record<string, unknown>;

/** The checkpoint parts of `tasks.result` one slice writes, as JSON text. */
export function persistedResult(s: EngineSlice, o: { full?: boolean } = {}): string {
  const checkpoint = buildCheckpoint({
    now: 0, deadlineAt: 0, remainingMs: 0,
    lastCompletedCapability: null, nextPendingCapability: null,
    companies: s.resume_records as never, reason: "execution_deadline_checkpoint",
    discoverySourceState: (s.state.discovery_source_state ?? null) as never,
  });
  return JSON.stringify({
    capability_execution_state: s.state,
    // The previous writer stored the engine's records as they were: every
    // observation and up to MAX_SNAPSHOT_JOBS job rows, for every company.
    [CHECKPOINT_RESULT_KEY]: o.full ? previousWriter(checkpoint as unknown as Rec, s.resume_records) : checkpoint,
  });
}

/** The envelope the previous writer stored: plain version, the engine's records as they were, no dictionary. */
export function previousWriter(checkpoint: Rec, records: unknown[]): Rec {
  const { snapshot_dictionary: _dictionary, ...rest } = checkpoint;
  return { ...rest, version: RESUME_STATE_VERSION, companies: records };
}

/** Resume the next slice from what was persisted, read back the way run-agent reads it. */
export function persistedCarrier(o: { full?: boolean } = {}) {
  return (s: EngineSlice) => {
    const result = JSON.parse(persistedResult(s, o)) as Rec;
    return {
      state: result.capability_execution_state as Rec,
      records: readCheckpointCompanies(result) as unknown[],
    };
  };
}

/** The decision-relevant surface of one slice. */
export function sliceSummary(slice: number, s: EngineSlice, mission: LeadMissionV1, taskId: string) {
  const view = canonicalView({ companies: s.companies }, mission, taskId, "job_discovery");
  const byKey = new Map(s.companies.map((c) => [c.key, c]));
  const st = s.state as Rec;
  const ds = (st.discovery_source_state ?? null) as Rec | null;
  return {
    slice,
    companies: s.companies.map((c: EngineCompany) => ({
      key: c.key,
      closed: companyIsClosed(c),
      investigation_state: c.investigation_state,
      eligible: c.prequalified?.eligible ?? null,
      exclusion: c.prequalified?.exclusion ?? null,
      size_status: c.prequalified?.size_status ?? null,
      shortlisted: c.shortlisted,
      shortlist_exclusion: c.shortlist_exclusion,
      identity: c.identity?.status ?? null,
      enriched: c.enriched !== null,
      hiring: c.hiring_assessment?.verdict ?? null,
      brain: (c.brain as { outcome?: string } | null)?.outcome ?? null,
      completed_operations: [...(c.completed_operations ?? [])].sort(),
    })).sort((a, b) => a.key.localeCompare(b.key)),
    leads: view.leads.map((l) => {
      const closed = byKey.has(l.company.key) && companyIsClosed(byKey.get(l.company.key)!);
      return {
        key: l.company.key,
        closed,
        label: l.label,
        bucket: l.bucket,
        pending_state: l.pending_state,
        hard_checks: l.hard_checks,
        missing_evidence: [...l.missing_evidence].sort(),
        // Which posting represents `job` depends on runtime timestamps among
        // tied postings — it differs between two fresh runs of the same slice —
        // so a job is compared by its status and sources, not by which one.
        key_evidence: l.key_evidence.map((e) =>
          `${e.dimension}:${e.status}:${e.dimension === "job" ? "" : JSON.stringify(e.value)}:${[...new Set(e.sources)].sort().join("+")}`).sort(),
      };
    }).sort((a, b) => a.key.localeCompare(b.key)),
    counts: view.counts,
    evidence_gaps: { with_executable_route: view.evidence_gaps.with_executable_route, budget_blocked: view.evidence_gaps.budget_blocked ?? 0 },
    qualified_company_keys: [...((st.qualified_company_keys ?? []) as string[])].sort(),
    completed_capabilities: st.completed_capabilities,
    pending_capabilities: st.pending_capabilities,
    discovery: ds ? { exhausted: ds.exhausted, stop_reason: ds.stop_reason, pages_taken: ds.pages_taken, page_fingerprints: ds.page_fingerprints ?? null } : null,
    provider_calls: s.provider.calls.map((c) => `${c.actor}:${JSON.stringify(c.input)}`),
  };
}

/** Closed by a decision before any paid stage: the companies `slimResumeRecord` slims. */
export function companyIsClosed(c: EngineCompany): boolean {
  return c.investigation_state === "excluded_permanently" &&
    c.identity === null && c.enriched === null && c.hiring_assessment === null && c.brain === null;
}

export type SliceSummary = ReturnType<typeof sliceSummary>;

/** Fields of a closed company's lead that depend on the evidence it no longer carries. */
export function withoutClosedEvidence(sum: SliceSummary): SliceSummary {
  return {
    ...sum,
    leads: sum.leads.map((l) => l.closed
      ? { ...l, hard_checks: {}, missing_evidence: [], key_evidence: l.key_evidence.filter((e) => e.startsWith("company_size_band:")) }
      : l),
  };
}
