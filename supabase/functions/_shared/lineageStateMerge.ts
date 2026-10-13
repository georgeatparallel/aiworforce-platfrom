// A GENERATION MAY ADD TO WHAT THE LINEAGE KNOWS. IT MAY NOT SUBTRACT.
//
// ── WHAT LAST-WRITER-WINS COST, ON 2026-08-30 ──────────────────────────────
//
// Lineage 862e81be, live, with the lease enforced. Generation 2 (task 66ef37b7)
// bought a job search and recorded three companies:
//
//   Storm4 / Talentoma / Storm3   verified_externally, external_job_search
//
// `resume-stalled-leads` then resumed the ORPHANED generation-1 task, which had
// been killed before it ever saw that evidence. It read its own task row, found
// nothing verified, and released last:
//
//   Storm4 / Talentoma / Storm3   not_verified, evidence_source: none
//
// `not_verified` is terminal, so all three became companies nothing would ever
// revisit, and the evidence they were bought with was stranded on a task row
// that nothing reads.
//
// ── WHY THE COMPARE-AND-SWAP DID NOT STOP IT ───────────────────────────────
//
// `release_lineage_lease` refuses a write whose `expected_version` is stale. The
// stale generation's version was NOT stale: the sweeper started it after
// generation 2 had already committed, so it acquired the lease, read version 1,
// and quoted 1 back. The lease and the CAS serialise writers. Serialising a
// writer that carries old CONTENT still loses the newer content — order is not
// monotonicity, and nothing in the schema said so.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// Two clauses, and the second is the one that matters:
//
//   1. SETTLED BEATS UNSETTLED. A stage that owes no further work may not be
//      replaced by one that does. "Owes work" is decided by the same predicates
//      `nextStageFor` routes on, so the merge and the resume cannot disagree
//      about whether a company is finished.
//
//   2. CITED BEATS UNCITED. Both `verified_externally` and `not_verified` are
//      settled, so clause 1 alone would have permitted the whole regression. A
//      verdict that cites evidence outranks one that cites none.
//
// Clause 2 is deliberately narrow, and matches the guard Phase 3 put in the
// assessor: a pass that DID inspect evidence may still change the answer. Only
// an EVIDENCE-FREE verdict is refused. Protecting a citation from a better
// citation would be its own defect.
//
// Pure. No I/O.

import {
  ENRICHMENT_RESUMABLE, IDENTITY_RESUMABLE, RESUME_STATE_VERSION, slimResumeRecord,
  readCheckpointCompanies, type CompanyResumeRecord,
} from "./leadResumeState.ts";

/** Stages whose value means "this company still owes work here". */
export function stageOwesWork(r: CompanyResumeRecord, stage:
  "identity" | "enrichment" | "hiring" | "brain" | "founder"): boolean {
  switch (stage) {
    case "identity": return IDENTITY_RESUMABLE.has(r.identity);
    case "enrichment": return ENRICHMENT_RESUMABLE.has(r.enrichment);
    // The three `nextStageFor` sends back to hiring. `not_verified` and
    // `failed` are answers; `evidence_unavailable` is the frontier.
    case "hiring": return r.hiring === "not_started" ||
      r.hiring === "verification_needed" || r.hiring === "evidence_unavailable";
    case "brain": return r.brain === "not_started";
    case "founder": return r.founder === "not_started";
  }
}

/**
 * Does this record's hiring verdict CITE something?
 *
 * NARROWER THAN `hiringEvidenceWasInspected`, on purpose. That predicate also
 * counts a settled provider call that named nobody — which is how `intelletec`
 * earns an honest `not_verified` with no citation of its own. That company is a
 * legitimate finding and must be overwritable by a later, better-evidenced pass;
 * it is not something to freeze. Only an actual citation outranks here.
 */
export function hiringIsCited(r: CompanyResumeRecord): boolean {
  const src = (r.snapshot?.hiring_assessment as { evidence_source?: unknown } | null | undefined)
    ?.evidence_source;
  return typeof src === "string" && src.length > 0 && src !== "none";
}

export interface MergeDecision {
  company_key: string;
  company_name: string;
  field: "identity" | "enrichment" | "hiring" | "brain" | "founder" | "record";
  /** What the lineage already held, and what the releasing generation carried. */
  stored: string;
  incoming: string;
  why: "settled_beats_unsettled" | "cited_beats_uncited" | "only_in_stored";
}

export interface LineageMergeResult {
  records: CompanyResumeRecord[];
  /** Only the places a regression was REFUSED. An empty list is the normal case. */
  refused: MergeDecision[];
  summary: {
    companies: number;
    companies_only_in_stored: number;
    companies_only_in_incoming: number;
    regressions_refused: number;
    operations_unioned: number;
  };
}

const STAGES = ["identity", "enrichment", "hiring", "brain", "founder"] as const;

/** Snapshot fields that belong to a stage and must travel with its verdict. */
const SNAPSHOT_FIELDS_BY_STAGE: Record<typeof STAGES[number], readonly string[]> = {
  identity: ["identity"],
  enrichment: ["enriched", "enrichment_outcome"],
  // A citation whose rows are gone is not a citation.
  hiring: ["hiring_assessment", "hiring_jobs"],
  brain: [],
  founder: [],
};

/**
 * Merge one company's two records.
 *
 * Field by field, because the two sides are usually each ahead of the other
 * somewhere: the generation that ran last has newer discovery-time state, and
 * the lineage may hold a paid verdict that generation never saw.
 */
function mergeOne(
  stored: CompanyResumeRecord, incoming: CompanyResumeRecord, refused: MergeDecision[],
): CompanyResumeRecord {
  // Start from the incoming record: it is the newer view, and every field not
  // explicitly protected below should be its.
  const out: CompanyResumeRecord = { ...incoming };

  for (const stage of STAGES) {
    const storedOwes = stageOwesWork(stored, stage);
    const incomingOwes = stageOwesWork(incoming, stage);

    let keepStored = false;
    let why: MergeDecision["why"] | null = null;

    // 0. A DELIBERATELY INVALIDATED VERDICT IS NOT A SETTLED ONE.
    //
    // The merge cannot otherwise tell "this generation has not got there yet"
    // from "somebody established that this verdict was wrong". On 2026-08-30
    // that difference routed zero companies to the Company Brain: `862e81be`
    // held `brain: not_started` after the three stale rejections were cleared,
    // task `66ef37b7` still said `brain: rejected`, and clause 1 restored the
    // rejection from the older row.
    //
    // Only clause 1 is affected. `hiring` cannot appear here at all — see
    // `INVALIDATABLE_STAGES` — so cited evidence keeps the absolute protection
    // clause 2 gives it.
    const invalidatedAt = incoming.invalidated_stages?.[stage];
    const storedIsKnownInvalid = !!invalidatedAt &&
      Date.parse(stored.updated_at) <= Date.parse(invalidatedAt);
    if (storedIsKnownInvalid) {
      // Incoming wins for this stage. Say nothing to `refused` — nothing was
      // refused; a stale verdict was correctly not resurrected.
      continue;
    }

    // 1. SETTLED BEATS UNSETTLED.
    if (!storedOwes && incomingOwes) {
      keepStored = true;
      why = "settled_beats_unsettled";
    } else if (stage === "hiring" && !storedOwes && !incomingOwes &&
               hiringIsCited(stored) && !hiringIsCited(incoming)) {
      // 2. CITED BEATS UNCITED. The clause that catches Storm4: both settled,
      // and the newer one has nothing to show for its answer.
      keepStored = true;
      why = "cited_beats_uncited";
    }

    if (keepStored && why) {
      refused.push({
        company_key: stored.company_key,
        company_name: stored.company_name ?? incoming.company_name,
        field: stage, stored: String(stored[stage]), incoming: String(incoming[stage]), why,
      });
      Object.assign(out, { [stage]: stored[stage] });
      // The verdict's own evidence travels with it, or the record claims a
      // citation it can no longer produce.
      for (const f of SNAPSHOT_FIELDS_BY_STAGE[stage]) {
        const kept = (stored.snapshot as Record<string, unknown> | null | undefined)?.[f];
        if (kept !== undefined) {
          out.snapshot = { ...(out.snapshot ?? {}), [f]: kept } as typeof out.snapshot;
        }
      }
    }

    // ── A PAYLOAD PRESENT ON ONE SIDE IS NEVER LOST TO A SIDE WITHOUT IT ──
    //
    // THE RUN THIS EXISTS FOR. Lineage c31585f8, 2026-09-05. Seventy checkpoint
    // writes, every one confirmed `written: true` with an advancing
    // `checkpoint_version` — and the enriched payload count still went
    // 49 → 42 and 52 → 42 across slice boundaries, re-buying the difference
    // each time and, on DiligenceVault, discarding a requirement P4 had already
    // resolved from a page the run had paid for.
    //
    // The clauses above are STAGE monotonicity: they fire only when one side
    // owes work and the other does not. When both sides agree on the stage —
    // both `completed` — nothing fires, `out` keeps the incoming snapshot, and a
    // payload the other side holds is dropped on a tie.
    //
    // That tie is not rare here. `mergeOne` starts from `incoming` because it is
    // documented as "the newer view", and at the lineage-restore call site it is
    // NOT: `lead_lineages.current_state` is written once per slice, at release,
    // while `tasks.result` is written at every publish. A slice killed between
    // its last publish and its release leaves the task row AHEAD of the lineage,
    // and the stale side leads the merge.
    //
    // Rather than invert the argument order — which would resurrect the
    // 2026-08-30 regression the lineage-leads rule was added to fix — this makes
    // the PAYLOAD monotonic independently of which side leads. Presence beats
    // absence, always. Neither side can delete evidence the other still holds.
    for (const f of SNAPSHOT_FIELDS_BY_STAGE[stage]) {
      const mine = (out.snapshot as Record<string, unknown> | null | undefined)?.[f];
      const theirs = (stored.snapshot as Record<string, unknown> | null | undefined)?.[f];
      const absent = (v: unknown) => v === undefined || v === null;
      if (absent(mine) && !absent(theirs)) {
        out.snapshot = { ...(out.snapshot ?? {}), [f]: theirs } as typeof out.snapshot;
      }
    }
  }

  // COMPLETED OPERATIONS ONLY EVER GROW. This is the record of what has been
  // PAID FOR, and dropping an entry means buying it again.
  out.completed_operations = [...new Set([
    ...(stored.completed_operations ?? []), ...(incoming.completed_operations ?? []),
  ])];

  // THE INVALIDATION TRAVELS WITH THE RECORD, or the next generation resurrects
  // the same stale verdict from the same old row. Union of both sides, newest
  // timestamp per stage.
  const inv: Record<string, string> = { ...(stored.invalidated_stages ?? {}) };
  for (const [k, v] of Object.entries(incoming.invalidated_stages ?? {})) {
    if (!inv[k] || Date.parse(v) > Date.parse(inv[k])) inv[k] = v;
  }
  out.invalidated_stages = Object.keys(inv).length > 0 ? inv : null;

  // A resolved URL is a fact; losing it costs a paid lookup.
  out.linkedin_company_url = incoming.linkedin_company_url ?? stored.linkedin_company_url ?? null;
  // Neither side's snapshot may erase the other's.
  if (stored.snapshot && !incoming.snapshot) out.snapshot = stored.snapshot;

  return out;
}

/**
 * Merge what the lineage holds with what a generation is releasing.
 *
 * `stored` is the lineage's own `current_state` as this generation read it when
 * it took the lease; `incoming` is what this generation produced.
 */
export function mergeCompanyResumeRecords(
  stored: CompanyResumeRecord[], incoming: CompanyResumeRecord[],
): LineageMergeResult {
  const refused: MergeDecision[] = [];
  const byKey = new Map<string, CompanyResumeRecord>();
  const storedByKey = new Map(stored.map((r) => [r.company_key, r]));
  const incomingKeys = new Set(incoming.map((r) => r.company_key));

  // Incoming order is the working set's order, and investigation rank is
  // positional in places — so it leads.
  for (const inc of incoming) {
    const st = storedByKey.get(inc.company_key);
    byKey.set(inc.company_key, st ? mergeOne(st, inc, refused) : inc);
  }

  // A COMPANY THE RELEASING GENERATION NEVER LOADED IS NOT A COMPANY IT
  // DISCARDED. A slice that restored ten of fifty must not delete forty.
  let onlyStored = 0;
  for (const st of stored) {
    if (incomingKeys.has(st.company_key)) continue;
    onlyStored++;
    refused.push({
      company_key: st.company_key, company_name: st.company_name,
      field: "record", stored: st.hiring, incoming: "absent", why: "only_in_stored",
    });
    byKey.set(st.company_key, st);
  }

  const records = [...byKey.values()];
  return {
    records, refused,
    summary: {
      companies: records.length,
      companies_only_in_stored: onlyStored,
      companies_only_in_incoming: incoming.filter((r) => !storedByKey.has(r.company_key)).length,
      regressions_refused: refused.filter((d) => d.why !== "only_in_stored").length,
      operations_unioned: records.reduce((n, r) => n + (r.completed_operations?.length ?? 0), 0),
    },
  };
}

/** The checkpoint envelope, as it sits on `lead_lineages.current_state`. */
export const CHECKPOINT_KEY = "lead_resume_checkpoint";

/**
 * The same merge, over the stored state envelopes.
 *
 * Returns the checkpoint to write. Everything else on `next` is this
 * generation's and passes through — only the working set is merged.
 */
export function mergeLineageState(
  storedState: unknown, nextState: Record<string, unknown>,
): { state: Record<string, unknown>; merge: LineageMergeResult } {
  const stored = readCheckpointCompanies(
    (storedState as Record<string, unknown> | null)?.[CHECKPOINT_KEY] !== undefined
      ? storedState
      : null);
  const incoming = readCheckpointCompanies(nextState);
  // NOTHING TO MERGE INTO IS NOT A MERGE. A first generation writes its own
  // state unchanged, and so does one whose lineage row is still empty.
  if (stored.length === 0) {
    return {
      state: nextState,
      merge: {
        records: incoming, refused: [],
        summary: {
          companies: incoming.length, companies_only_in_stored: 0,
          companies_only_in_incoming: incoming.length, regressions_refused: 0,
          operations_unioned: incoming.reduce(
            (n, r) => n + (r.completed_operations?.length ?? 0), 0),
        },
      },
    };
  }
  const merge = mergeCompanyResumeRecords(stored, incoming);
  return {
    state: {
      ...nextState,
      // Slim, like the task result's copy: `merge.records` were read back
      // (expanded) by `readCheckpointCompanies`.
      [CHECKPOINT_KEY]: { version: RESUME_STATE_VERSION, companies: merge.records.map(slimResumeRecord) },
    },
    merge,
  };
}
