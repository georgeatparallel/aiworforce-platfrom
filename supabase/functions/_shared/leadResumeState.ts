// RESUME WHERE IT STOPPED, NOT WHERE IT STARTED.
//
// Continuation 90bad481 hit `execution_deadline_reached` at 109,009 ms with
// seven companies at `verifying`. Everything expensive was already done for
// them — identity resolved, enrichment complete — and none of it was recorded
// per company. A resume could only replay the whole capability, buying the same
// searches and the same enrichment a second time.
//
// TWO THINGS FIX THAT.
//
//   * A RESERVE. The engine stops starting paid calls while it still has time to
//     write a checkpoint, instead of discovering the deadline by being killed.
//   * PER-COMPANY STAGE STATE. Each company records how far it individually got,
//     so a continuation resumes the unfinished stage for each one rather than
//     the unfinished capability for all of them.
//
// AND A STABLE OPERATION KEY, so a completed provider call is recognisable
// across invocations. Without it "already done" is a guess.
//
// PURE. No network, no provider, no database.

export const RESUME_STATE_VERSION = "lead-resume-state-v1" as const;

// ------------------------------------------------------------- the reserve ----

/**
 * Wall-clock kept back for writing state, on top of the engine's own budget.
 *
 * WHY 18 SECONDS. The checkpoint is a read-modify-write of `tasks.result` plus a
 * plan update — normally well under a second. The reserve is not sized for the
 * write; it is sized so that the LAST call the engine allows can still finish
 * inside the budget. Observed starts on TEST: memo23 24.3s, company search
 * ~9s, company details ~11s, job search ~6s. A reserve below the slowest
 * downstream call would let the engine authorise a call it cannot complete,
 * which is exactly how the previous run died holding work it never read.
 * 18s covers every downstream provider (max ~11s) with margin, and is small
 * enough not to waste a third of the budget.
 */
export const CHECKPOINT_RESERVE_MS = 18_000;

/**
 * The reserve the QUALIFICATION loop admits work against.
 *
 * WHY IT IS ITS OWN NUMBER. The 18s above is sized for the slowest downstream
 * PROVIDER call — "a reserve below the slowest downstream call would let the
 * engine authorise a call it cannot complete". That argument does not apply to
 * qualification: its model calls are already hard-bounded by the engine's
 * `clockBound`, which caps each one at `remaining − reserve`, so a
 * qualification call physically cannot run into the reserve. And a company the
 * clock stops mid-flight is NOT REACHED — no verdict, no rejection, still
 * resumable. Borrowing the provider reserve here bought safety that was
 * already guaranteed, and paid for it in leads.
 *
 * WHAT IT COST. TEST run b7a9e112 stopped qualification three times:
 *
 *     evaluated: 1, not_reached: 2, remaining_ms: 22206
 *     evaluated: 1, not_reached: 6, remaining_ms: 22984
 *     evaluated: 2, not_reached: 2, remaining_ms: 23658
 *
 * Admission needs `reserve + estimate` — 18,000 + 7,000 = 25,000 — so every one
 * fell one to three seconds short and left between two and six ALREADY ENRICHED
 * companies without a verdict. Run 9b5ad99b lost all four of its at 19,137ms.
 *
 * WHY 14 SECONDS. Measured, not chosen. The work that actually happens after
 * qualification stops — persistence, the quota pass, auto-continuation dispatch
 * and the terminal guard — across five slices on three builds:
 *
 *     5.96s   6.27s   7.80s   7.86s   9.38s
 *
 * 14s clears all three admissions above (needing 21,000 against 22.2–23.7s
 * available) and keeps 4.6s of margin over the worst tail ever observed. A
 * smaller reserve would admit no more companies than this one does — after one
 * ~7s evaluation the remaining clock is ~15s, below every candidate threshold —
 * so 14s is the LARGEST value that unblocks, which is the one to pick.
 */
export const QUALIFICATION_RESERVE_MS = 14_000;

export interface ReserveClock {
  elapsedMs(): number;
  remainingMs(): number;
}

/** Should the engine stop starting new paid work and checkpoint instead? */
export function shouldCheckpoint(
  clock: ReserveClock, reserveMs: number = CHECKPOINT_RESERVE_MS,
): boolean {
  return clock.remainingMs() <= reserveMs;
}

/**
 * IS THERE ROOM FOR THIS UNIT OF WORK, plus the reserve, plus a stop?
 *
 * `shouldCheckpoint` answers a WEAKER question: "is there still room to write a
 * checkpoint?" A loop that only asks that will admit an iteration with 100ms to
 * spare and then run it for a minute, because admitting work and bounding work
 * are different things. Task 1e67725f died exactly there — the qualification
 * loop's guard passed at 91s of a 125s budget, entered a company, and the
 * isolate was killed at 146s with no checkpoint written and the row left
 * `running` forever.
 *
 * So the question a loop must actually ask is "is there room for what I am
 * about to start, AND to stop cleanly afterwards?" — which needs an estimate of
 * the work, not just the reserve.
 *
 * `estimatedWorkMs` should come from `ExecutionDeadline.estimateFor(op)`, whose
 * floor is the conservative assumed duration and which only ever moves UP from
 * observed reality. A stage with no history is therefore admitted pessimistically,
 * which is the safe direction: the cost of guessing high is one company deferred
 * to a continuation, and the cost of guessing low is the whole run lost.
 *
 * THIS IS NECESSARY BUT NOT SUFFICIENT. An estimate bounds the TYPICAL
 * iteration; it cannot bound a pathological one. The work itself must also be
 * capped — see `withDeadlineBudget` — or a single call three times slower than
 * its estimate defeats the admission that let it in.
 */
export function shouldStartWork(
  clock: ReserveClock,
  estimatedWorkMs: number,
  reserveMs: number = CHECKPOINT_RESERVE_MS,
): boolean {
  return clock.remainingMs() > reserveMs + Math.max(0, estimatedWorkMs);
}

// ------------------------------------------------------ per-company stages ----

/**
 * How far identity resolution got for ONE company — five outcomes, not three.
 *
 * The three that existed collapsed distinct facts into one. A company the
 * deadline never reached recorded `not_started`, which is also what a company
 * nobody had scheduled yet recorded; a company whose provider call ERRORED
 * recorded `unresolved`, which is what a company with no LinkedIn presence
 * records. So "we ran out of time" and "this company does not exist on
 * LinkedIn" were the same value, and the second is terminal.
 *
 *   not_started     scheduled, not yet reached by this run
 *   resolved        an actionable identity was found
 *   unresolved      the provider answered, and nothing matched  — TERMINAL
 *   mismatch        the provider answered, and the match was rejected — TERMINAL
 *   deferred        selected and budgeted, but the deadline fired first
 *   provider_error  the call was made and failed — says nothing about the company
 *
 * `deferred` and `provider_error` are RESUMABLE. Neither is evidence about the
 * company, so neither may end its journey.
 */
export type IdentityStage =
  | "not_started" | "resolved" | "unresolved" | "mismatch"
  | "deferred" | "provider_error";

/** Identity outcomes that are a real, final answer ABOUT THE COMPANY. */
const IDENTITY_TERMINAL: ReadonlySet<IdentityStage> =
  new Set<IdentityStage>(["unresolved", "mismatch"]);

/**
 * Identity outcomes that mean "this company still owes an identity attempt".
 *
 * A resume MUST pick these up. Treating either as finished is how nine of
 * twenty candidates disappeared from a run that reported itself complete.
 */
export const IDENTITY_RESUMABLE: ReadonlySet<IdentityStage> =
  new Set<IdentityStage>(["not_started", "deferred", "provider_error"]);
/**
 * ENRICHMENT MAKES THE SAME DISTINCTION IDENTITY ALREADY DOES.
 *
 * `not_started` used to absorb four different outcomes: never reached, answered
 * with nothing, the call failed, and the call was never started. A resume
 * therefore could not tell a company that still owes a paid lookup from one
 * that has already been answered — so it re-bought the answered ones and left
 * the deferred ones looking finished.
 *
 *   empty           ANSWERED. The provider has no record of this company.
 *                   Asking again buys the same silence, so it is terminal.
 *   deferred        never started; the checkpoint reserve was reached first.
 *   provider_error  started and failed.
 */
export type EnrichmentStage =
  | "not_started" | "completed" | "failed" | "not_required"
  | "empty" | "deferred" | "provider_error";

/**
 * Enrichment outcomes that mean "this company still owes an enrichment attempt".
 *
 * `empty` is deliberately ABSENT: it is a real answer, and retrying it spends
 * money to be told the same thing.
 */
export const ENRICHMENT_RESUMABLE: ReadonlySet<EnrichmentStage> =
  new Set<EnrichmentStage>(["not_started", "deferred", "provider_error"]);
export type HiringStage =
  | "not_started" | "verified_from_existing_evidence" | "verified_externally"
  | "verification_needed"
  /**
   * A SETTLED CALL COVERED THIS COMPANY AND FOUND NOTHING MATCHING.
   *
   * A finding, and terminal. `intelletec-ltd` on 2026-08-29 is the honest
   * example: the batch it was in completed, returned five rows, and none of
   * them named it.
   */
  | "not_verified"
  /**
   * WE DID NOT FIND OUT.
   *
   * No paid call covered this company, or one was started and its dataset was
   * never read, or a restore lost the rows it had. Non-terminal: the company
   * stays on the frontier and the next slice asks again.
   *
   * ── WHY THIS STATE HAD TO EXIST ────────────────────────────────────────
   *
   * `not_verified` meant both things. On 2026-08-29 every company in lineage
   * 06d3544a ended with `evidence_source: "none"` and the reason "No open roles
   * at all" — including Storm4, whose dataset held an Inside Sales
   * Representative opening, and Blue Signal Search, whose 83-row dataset was
   * bought, charged, and never read. `nextStageFor` treats `not_verified` as
   * final, so all of them were finished companies that nothing would revisit.
   *
   * A replay of the real rows through the real assessor produces
   * `hiring_verified` for Storm4 and `watch` for Atlas Search, so the verdicts
   * production recorded were not reachable from the evidence it paid for.
   */
  | "evidence_unavailable"
  | "failed";
export type BrainStage = "not_started" | "qualified" | "review" | "rejected" | "failed";
export type FounderStage =
  | "not_started" | "completed" | "unresolved" | "failed" | "not_eligible";

/**
 * ENOUGH OF A COMPANY TO REBUILD IT WITHOUT RE-DISCOVERING IT.
 *
 * THE WORKING SET IS BUILT ONLY BY DISCOVERY. A continuation whose state says
 * `startup_company_discovery` is already complete skips that step — correctly,
 * because re-running it means paying for the same Actor twice — and then has an
 * EMPTY working set. Every downstream stage iterates over that empty array, so
 * nothing resumes: not the deferred identity candidates, not the enrichment,
 * not the evaluation. The per-company resume ledger was unreachable across
 * invocations, which is the same as not existing.
 *
 * This snapshot is what makes the ledger real. It carries the normalized
 * company, its discovery-time jobs, its prequalification verdict and its
 * shortlist status — the four things `addCompany` and `applyPrequalification`
 * would otherwise have to buy again.
 *
 * OPTIONAL BY DESIGN. A checkpoint written before this existed has no snapshot;
 * such a record restores nothing and the run behaves exactly as it did before,
 * rather than failing to parse.
 *
 * Typed structurally so this module stays free of runtime imports — the shapes
 * are `NormalizedHiringCompany`, `NormalizedHiringJob[]` and
 * `PrequalifiedCompany`, and the engine owns the casts.
 */
export interface CompanyWorkingSetSnapshot {
  /** LEAD V2 P3 — first-hire evidence, so a continuation does not re-check it. */
  first_in_function?: Record<string, unknown> | null;
  /** P4 — every route that found the company (entityResolution `FoundBy`). */
  found_by?: Record<string, unknown>[];
  /** P4 — bounded route observations (candidateObservation). */
  observations?: Record<string, unknown>[];
  identity_conflicts?: Record<string, unknown>[];
  /** The normalized company, as discovery produced it. */
  company: Record<string, unknown>;
  /** Discovery-time open jobs. BOUNDED — see `MAX_SNAPSHOT_JOBS`. */
  yc_open_jobs: Record<string, unknown>[];
  /** The free prequalification verdict, so triage is not recomputed. */
  prequalified: Record<string, unknown> | null;
  prequal_key: string | null;
  /** Whether this company was worth paying to resolve. */
  shortlisted: boolean;
  /**
   * WHERE THIS COMPANY SITS IN THE INVESTIGATION FRONTIER.
   *
   * The field that makes a continuation able to widen the pool. Without it a
   * restored company was only `shortlisted: true/false`, and "false" could not
   * be told apart from "excluded by GPT" — so every continuation restored the
   * same frozen ten and the other ninety were reported pending forever.
   *
   * Optional: a checkpoint written before this existed has no state, and the
   * engine narrows an absent value to `pending_investigation`, which puts those
   * companies back on the frontier rather than stranding them.
   */
  investigation_state?: string | null;
  /** Why a closed company was closed (`excluded_permanently`); absent on older checkpoints. */
  shortlist_exclusion?: string | null;
  /** Position in the persisted triage ranking. */
  investigation_rank?: number | null;
  /** The triage verdict, so a continuation never re-pays for triage. */
  triage?: Record<string, unknown> | null;
  /** Enrichment already bought, so a resume never buys it twice. */
  enriched: Record<string, unknown> | null;
  /**
   * WHY there is no `enriched` row — `EnrichmentOutcome`, carried verbatim.
   *
   * Optional: checkpoints written before this field existed simply have no
   * outcome, and the engine narrows an absent or unrecognised value back to
   * `not_attempted` rather than failing to restore.
   */
  enrichment_outcome?: string | null;
  /**
   * WHAT IDENTITY RESOLUTION PRODUCED, not merely that it ran.
   *
   * `CompanyResumeRecord.identity` is a STAGE ("resolved"), and
   * `linkedin_company_url` is one field of the answer. Every paid stage after
   * identity selects on the OBJECT — `hiring_verification` filters
   * `c.identity && identityIsActionable(c.identity)` — so a company restored
   * without it is invisible to them.
   *
   * A resumed slice reported "no company had a relevant commercial role" with
   * `targets: 0`, holding a fully enriched company and a paid hiring run
   * waiting to be adopted, because identity resolution was skipped as complete
   * and nothing rebuilt what it had made.
   *
   * Optional: a checkpoint from before this field existed has none, and the
   * engine simply leaves `c.identity` null rather than failing to restore.
   */
  identity?: Record<string, unknown> | null;
  /**
   * WHAT HIRING VERIFICATION PRODUCED, not merely that it ran.
   *
   * The same distinction as `identity` directly above, one stage later, and it
   * failed the same way. `CompanyResumeRecord.hiring` is a STAGE
   * ("verified_externally"); the Company Brain's eligibility filter reads the
   * OBJECT, and a company whose `hiring_assessment` is null "carried no hiring
   * assessment" however emphatic the stage label is.
   *
   * Task 02ea3aed: four companies verified from 148 paid job rows, resumed, and
   * the Brain reported "the eligible set was empty (50 companies carried no
   * hiring assessment)". `hiring_verification` was already `completed`, so
   * nothing recomputed the verdicts — and nothing could, because
   * `completed_operations` correctly forbids re-buying the search. Evidence the
   * run had paid for, destroyed by the resume built to preserve it.
   *
   * Optional, for the same reason as every field above: an older checkpoint has
   * none and the engine leaves the assessment null rather than failing.
   */
  hiring_assessment?: Record<string, unknown> | null;
  /**
   * The job rows the verdict CITES. BOUNDED — see `MAX_SNAPSHOT_JOBS`.
   *
   * Carried with the assessment because a citation whose evidence is gone is
   * not a citation: `hiringJobsFor` picked these rows, the Workbench renders
   * them, and the evaluator quotes them.
   */
  hiring_jobs?: Record<string, unknown>[];
  /**
   * WHAT THE COMPANY BRAIN DECIDED, not merely that a stage label says so.
   *
   * The third field in this series, and it failed exactly like the first two.
   * `CompanyResumeRecord.brain` is a STAGE ("qualified"); the engine's
   * `c.brain` is the DECISION OBJECT, and it is set only by `decideCompanyBrain`
   * — never restored. So every continuation began with `c.brain === null` for
   * every company, re-evaluated companies it had already qualified, and paid the
   * downstream reserve for all of them.
   *
   * Lineage 862e81be: generations 11 and 12 each re-evaluated the same three
   * qualified companies, holding the identity reserve at 7 companies' worth
   * (114,000 ms) against a 105,597 ms window — so identity resolution attempted
   * NOTHING, twice, and the run stayed capped at 3 of 5 leads while 14 companies
   * had never had a paid lookup.
   *
   * Optional, like every field here: a checkpoint written before this existed
   * has none, and the engine behaves exactly as it did.
   */
  brain?: Record<string, unknown> | null;
  /**
   * THE EVALUATION THE BRAIN'S DECISION CITES.
   *
   * `brain` above survived the checkpoint and this did not, and that pairing is
   * what made a lost evaluation PERMANENT. `buildLeadVerdict` reads
   * `mission_evaluation.icp_fit`; without it `icpVerdictFrom` answers
   * `insufficient_evidence`, so the company is held — and because `brain` DID
   * come back, the restored-decision branch short-circuits before the evaluator
   * could run again. Evaluated once, judgement discarded, never re-judged.
   *
   * Optional: a checkpoint written before this existed has none, and a company
   * restored without it is treated as not yet decided rather than as decided
   * badly — see `restoredBrainKeys`.
   */
  mission_evaluation?: Record<string, unknown> | null;
}

/**
 * Jobs kept per company in the checkpoint.
 *
 * The checkpoint is one jsonb column on `tasks`, and a hundred companies with
 * unbounded job arrays is how a resume record stops being writable. Twenty is
 * far above what prequalification actually reads and keeps a full working set
 * comfortably inside a single row.
 */
export const MAX_SNAPSHOT_JOBS = 20;

export interface CompanyResumeRecord {
  company_key: string;
  company_name: string;
  identity: IdentityStage;
  enrichment: EnrichmentStage;
  hiring: HiringStage;
  brain: BrainStage;
  founder: FounderStage;
  /** LinkedIn URL, once resolved — so a resume never re-searches for it. */
  linkedin_company_url: string | null;
  /** Completed provider operations, by stable key. */
  completed_operations: string[];
  /**
   * STAGES WHOSE PRIOR VERDICT IS KNOWN TO BE INVALID, and when that was decided.
   *
   * ── WHY A SETTLED STAGE NEEDED A WAY TO BE UN-SETTLED ──────────────────
   *
   * The monotonic merge refuses to move a stage from settled back to unsettled,
   * which is what stops a stale generation destroying a finished verdict. It
   * cannot, on its own, tell that apart from a verdict somebody deliberately
   * invalidated — and on 2026-08-30 that difference mattered: `862e81be`'s three
   * companies were reset to `brain: not_started` because the gate that rejected
   * them was itself defective, and resuming from task `66ef37b7` — whose row
   * still said `brain: rejected` — restored the rejection and routed ZERO
   * companies to the Brain.
   *
   * An ISO timestamp per stage. A stored value is treated as known-invalid when
   * it was last written BEFORE the invalidation. Absent, everything behaves
   * exactly as it did.
   *
   * It can only ever un-settle clause 1 of the merge (settled beats unsettled).
   * Cited hiring evidence is governed by clause 2 and is NOT overridable here —
   * evidence monotonicity is not weakened by this field.
   */
  invalidated_stages?: Record<string, string> | null;
  /**
   * Enough of the company to rebuild the working set on a continuation.
   *
   * Absent on checkpoints written before this field existed, and absent is
   * handled: the run simply cannot reconstruct, exactly as before.
   */
  snapshot?: CompanyWorkingSetSnapshot | null;
  updated_at: string;
}

export function newCompanyRecord(
  company_key: string, company_name: string,
): CompanyResumeRecord {
  return {
    company_key, company_name,
    identity: "not_started", enrichment: "not_started", hiring: "not_started",
    brain: "not_started", founder: "not_started",
    linkedin_company_url: null, completed_operations: [],
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * The next stage this company still owes, or null when it is finished.
 *
 * Read in pipeline order and stops at the first unfinished stage, so a company
 * with identity + enrichment + hiring done resumes at the Brain and nowhere
 * earlier. A company whose identity is `unresolved` or `mismatch` is FINISHED —
 * retrying it is what the caps exist to prevent.
 */
/**
 * Which resume STAGE a capability is responsible for.
 *
 * `nextStageFor` answers "what does this company still owe"; this answers "which
 * capability owes it". Only the per-company stages appear: discovery fills the
 * working set and has no per-company frontier, so it is deliberately absent and
 * a completed discovery stays skipped — re-running it re-pays for the Actor.
 */
export const CAPABILITY_STAGE: Readonly<Record<string, ResumeStageName>> =
  Object.freeze({
    company_identity_resolution: "identity",
    company_enrichment: "enrichment",
    hiring_verification: "hiring",
    company_brain_qualification: "brain",
    founder_discovery: "founder",
  });

export type ResumeStageName =
  "identity" | "enrichment" | "hiring" | "brain" | "founder";

/**
 * Does any company still owe this capability?
 *
 * ── WHY A COMPLETED CAPABILITY IS NOT A FINISHED ONE ──────────────────────
 *
 * `completed_capabilities` records that a stage RAN and reached its own end. It
 * does not record that every company reached a terminal state, and those are
 * different facts — which is the same conflation `not_verified` carried before
 * Phase 3 split it.
 *
 * Lineage 862e81be, generation 21: every capability reported
 * `skipped_resumed / "completed in an earlier run"`, `evidence_satisfied: true`,
 * `pending: []` — while ELEVEN of twenty-one resolved companies sat at
 * `hiring: evidence_unavailable`, the state Phase 3 created precisely so they
 * would be asked again. `nextStageFor` routed every one of them to "hiring" and
 * the stage was skipped before it could look, so the run declared itself
 * finished at 4 of 5 leads with its only remaining candidates unexamined.
 *
 * SAFE AGAINST RE-BUYING, and that is not an assumption: `shouldSkipProviderCall`
 * is per company and per operation key, keyed on `completed_operations`, so a
 * search already paid for is refused at the call. The stage-level skip is a
 * second, coarser guard layered on top of one that already works — and being
 * coarser is exactly how it strands companies the finer guard would have let
 * through.
 */
export function capabilityStillOwed(
  capability: string, records: readonly CompanyResumeRecord[],
): boolean {
  const stage = CAPABILITY_STAGE[capability];
  if (!stage) return false;
  return records.some((r) => nextStageFor(r) === stage);
}

export function nextStageFor(r: CompanyResumeRecord):
  "identity" | "enrichment" | "hiring" | "brain" | "founder" | null {
  // DEFERRED AND PROVIDER_ERROR RESUME HERE, exactly like `not_started`. The
  // work was never done; only a real answer from the provider ends it.
  if (IDENTITY_RESUMABLE.has(r.identity)) return "identity";
  if (IDENTITY_TERMINAL.has(r.identity)) return null;
  // DEFERRED AND PROVIDER_ERROR RESUME HERE, for the same reason they do for
  // identity: the work was never done. `empty` does NOT — it is an answer.
  if (ENRICHMENT_RESUMABLE.has(r.enrichment)) return "enrichment";
  if (r.enrichment === "failed") return null;
  if (r.hiring === "not_started") return "hiring";
  if (r.hiring === "verification_needed") return "hiring";
  // ── ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE ──────────────────────
  //
  // `evidence_unavailable` means the question was never answered FOR THIS
  // COMPANY: no paid call covered it, or one was started and its dataset was
  // never read, or a restore lost the rows. It resumes exactly like
  // `not_started`, because that is what it is.
  //
  // `not_verified` keeps its meaning and its finality — a settled call covered
  // this company and returned nothing matching. That is a finding.
  if (r.hiring === "evidence_unavailable") return "hiring";
  if (r.hiring === "not_verified" || r.hiring === "failed") return null;
  if (r.brain === "not_started") return "brain";
  if (r.brain === "rejected" || r.brain === "review" || r.brain === "failed") return null;
  // Only an explicit Brain pass may reach people discovery.
  if (r.brain === "qualified" && r.founder === "not_started") return "founder";
  return null;
}

export function companyIsComplete(r: CompanyResumeRecord): boolean {
  return nextStageFor(r) === null;
}

// -------------------------------------------------- provider deduplication ----

/**
 * A stable identifier for one provider operation.
 *
 * Deliberately built from the things that make two calls the SAME QUESTION:
 * workspace, the continuation lineage root, the company, the capability and a
 * normalized input. It excludes the task id and any timestamp, because a
 * continuation is a different task asking the same question — and if the key
 * changed per task, every resume would re-buy everything.
 */
export function providerOperationKey(i: {
  workspace_id: string;
  lineage_root_task_id: string;
  company_key: string;
  capability: string;
  provider: string;
  input_fingerprint: string;
}): string {
  return [
    RESUME_STATE_VERSION, i.workspace_id, i.lineage_root_task_id,
    i.company_key, i.capability, i.provider, i.input_fingerprint,
  ].join("|");
}

/**
 * The fingerprint of a compiled provider input.
 *
 * ── V2, AND WHY THE OLD ONE IS STILL READ ─────────────────────────────────
 *
 * This was djb2 32-bit and carried no actor: the same input aimed at two actors
 * fingerprinted identically, and 4.3e9 is a small space for a value whose whole
 * job is "do not buy this again". It is now
 * `SHA-256(canonicalJson({actorKey, input}))`, prefixed `v2:`.
 *
 * `actorKey` is optional ONLY so the legacy call shape keeps compiling; every
 * production call site passes it. Without it the fingerprint still hashes, but
 * two actors sharing an input would share a key — so the parameter is required
 * in spirit and a test asserts every engine call site supplies one.
 */
export function inputFingerprintV2(actorKey: string, input: unknown): string {
  return providerInputFingerprint(actorKey, input);
}

/** The pre-v2 fingerprint. READ ONLY — never written, kept so paid work matches. */
export function inputFingerprint(input: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined && x !== null)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, norm(x)]));
    }
    return v;
  };
  const s = JSON.stringify(norm(input));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export type SkipReason = "already_completed" | "identity_terminal" | "not_eligible" | null;

/**
 * Should this provider call be skipped because the work already exists?
 *
 * Only a COMPLETED, usable result skips. An explicitly failed or invalid prior
 * result is not a reason to give up — it is a reason to try once more.
 */
export function shouldSkipProviderCall(
  record: CompanyResumeRecord | undefined,
  operationKey: string,
  /**
   * KEYS THIS OPERATION WOULD HAVE HAD UNDER AN OLDER SCHEME.
   *
   * A checkpoint written before the v2 fingerprint records the djb2 key. If only
   * the new key were checked, every already-paid search in every existing
   * lineage would look unbought and be purchased a second time — the single
   * worst outcome a fingerprint change can have. Matching either is what makes
   * the migration free.
   *
   * Optional: a caller that passes none behaves exactly as before.
   */
  legacyOperationKeys: readonly string[] = [],
): { skip: boolean; reason: SkipReason } {
  if (!record) return { skip: false, reason: null };
  if (record.completed_operations.includes(operationKey)) {
    return { skip: true, reason: "already_completed" };
  }
  for (const legacy of legacyOperationKeys) {
    if (legacy && record.completed_operations.includes(legacy)) {
      return { skip: true, reason: "already_completed" };
    }
  }
  // ONLY A REAL ANSWER IS A REASON NOT TO ASK AGAIN. `deferred` and
  // `provider_error` are deliberately absent: the question was never answered,
  // so a resume must be allowed to ask it.
  if (IDENTITY_TERMINAL.has(record.identity)) {
    return { skip: true, reason: "identity_terminal" };
  }
  return { skip: false, reason: null };
}

// ---------------------------------------------------------- the checkpoint ----

export interface Checkpoint {
  version: typeof RESUME_STATE_VERSION | typeof CHECKPOINT_COMPACT_VERSION;
  deadline_at: string;
  time_remaining_at_checkpoint_ms: number;
  last_completed_capability: string | null;
  next_pending_capability: string | null;
  pending_company_keys: string[];
  completed_company_keys: string[];
  continuation_required: boolean;
  checkpoint_reason: "execution_deadline_checkpoint" | "all_work_complete";
  companies: CompanyResumeRecord[];
  /** Repeated snapshot values, referenced from `companies` (CHECKPOINT_COMPACT_VERSION). */
  snapshot_dictionary?: unknown[];
  /**
   * WHAT DISCOVERY HAD ALREADY ASKED, SO THE NEXT SLICE DOES NOT ASK IT AGAIN.
   *
   * ── WHY THIS IS RUN-LEVEL AND NOT PER-COMPANY ──────────────────────────
   *
   * Every other field here describes a COMPANY. This describes the SEARCH: the
   * actors already tried, how far down each one's index we have read, and
   * whether anything remains that could widen the pool. No company carries
   * that, and a slice that has to re-derive it re-derives it wrong — it would
   * restart a paginating source at page one.
   *
   * Restarting page one is cheap in money and expensive in time: the identical
   * input hashes to the identical `logical_call_key`, so the completed run is
   * ADOPTED rather than re-bought, and the slice spends its budget re-reading
   * rows it already holds instead of finding new ones.
   *
   * Optional, like every field added here after the fact. A checkpoint written
   * before this existed has none, and the reader narrows absence to "discovery
   * state unknown" — which `decideAutoContinuation` treats as "no routes
   * remain", the behaviour those runs already had.
   */
  discovery_source_state?: {
    sources_attempted: string[];
    pages_taken: Record<string, number>;
    admitted: number;
    /** Admitted candidates still able to do downstream work. Optional: a
     * checkpoint written before this existed has none. */
    available_admitted?: number;
    raw_rows: number;
    pool_target: number;
    exhausted: boolean;
    stop_reason: string;
    /** Per actor, the row-identity fingerprint of the last page read (duplicate-page detection). */
    page_fingerprints?: Record<string, string>;
  } | null;
}

/**
 * Build the checkpoint.
 *
 * `continuation_required` is TRUE whenever any company still owes a stage. That
 * is the flag the UI reads, and it is what stops a run with pending verification
 * being described as complete.
 */
export function buildCheckpoint(i: {
  now: number;
  deadlineAt: number;
  remainingMs: number;
  lastCompletedCapability: string | null;
  nextPendingCapability: string | null;
  companies: readonly CompanyResumeRecord[];
  reason: Checkpoint["checkpoint_reason"];
  /** From `CapabilityExecutionState.discovery_source_state`, carried verbatim. */
  discoverySourceState?: Checkpoint["discovery_source_state"];
}): Checkpoint {
  const pending = i.companies.filter((c) => !companyIsComplete(c));
  const complete = i.companies.filter(companyIsComplete);
  const stored = compactCheckpointCompanies(i.companies);
  return {
    version: stored.version,
    deadline_at: new Date(i.deadlineAt).toISOString(),
    time_remaining_at_checkpoint_ms: Math.max(0, i.remainingMs),
    last_completed_capability: i.lastCompletedCapability,
    next_pending_capability: i.nextPendingCapability,
    pending_company_keys: pending.map((c) => c.company_key),
    completed_company_keys: complete.map((c) => c.company_key),
    // A CAPABILITY STILL OWED IS ALSO UNFINISHED WORK, even with no pending
    // company — that is how a run with a whole stage left could look complete.
    continuation_required: pending.length > 0 || i.nextPendingCapability !== null,
    checkpoint_reason: i.reason,
    companies: stored.companies,
    snapshot_dictionary: stored.snapshot_dictionary,
    // WRITTEN, DECLARED AND READ BACK. All three, or it does not survive a
    // resume — the failure this file has already recorded twice, for
    // `identity` and for the hiring assessment.
    discovery_source_state: i.discoverySourceState ?? null,
  };
}

/** May the UI say "Run complete"? Only when nothing is owed. */
export function runIsComplete(c: Checkpoint | null): boolean {
  return !!c && !c.continuation_required;
}

/** Should "Continue verification" be offered? */
export function continuationAvailable(c: Checkpoint | null): boolean {
  return !!c && c.continuation_required && c.pending_company_keys.length +
    (c.next_pending_capability ? 1 : 0) > 0;
}

// ------------------------------------------------------ reading it back in ----
//
// A checkpoint nobody reads is a receipt, not a resume. These are the readers
// that turn `tasks.result` back into the two things the guard needs: the prior
// per-company records, and the lineage root the operation key is built from.

/** The key `tasks.result` stores the checkpoint under. */
import { providerInputFingerprint } from "./providerInputFingerprint.ts";

export const CHECKPOINT_RESULT_KEY = "lead_resume_checkpoint" as const;
/** The key `tasks.result` stores the lineage root task id under. */
export const LINEAGE_ROOT_RESULT_KEY = "lead_resume_lineage_root" as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown> : null;
}

function asStage<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? v as T : fallback;
}

const asObjectOrNull = (v: unknown): Record<string, unknown> | null => asRecord(v);
const asStringOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * THE HALF OF RESUME THAT WAS WRITTEN AND NEVER READ.
 *
 * `toResumeRecord` has written a `snapshot` for every company since the durable
 * working set was introduced. This reader rebuilt each record field by field —
 * identity, enrichment, hiring, brain, founder, url, operations, timestamp —
 * and simply did not mention `snapshot`, so every one was dropped on load.
 *
 * The writer and the reader disagreed, and the reader wins. Measured on TEST
 * run 9105aa67's own persisted checkpoint:
 *
 *     companies in the persisted checkpoint : 100
 *     of those carrying a snapshot          : 100
 *     records returned by this function     : 100
 *     of those carrying a snapshot          :   0
 *
 * `restoreWorkingSet` therefore restored nothing on every continuation. The
 * frontier read empty, the yield gate answered `frontier_exhausted`, and runs
 * reported "every discovered candidate has been investigated" with 88 of 98
 * never touched — while the auto-continuation message promised the user it was
 * "looking for 8 more across 87 remaining companies". Three consecutive TEST
 * runs ended that way. The continuation machinery was complete except for this.
 *
 * VALIDATED, NOT CAST, like everything else here — a checkpoint is JSON another
 * deploy wrote. Only the SHAPE is checked; `restoreWorkingSet` owns the value
 * narrowing (investigation state, enrichment outcome, rank) and already treats
 * every field as untrusted. A snapshot with no `company` object cannot rebuild
 * anything, so it reads as absent rather than as an empty company — which keeps
 * the `snapshots_missing` count honest.
 */
function readWorkingSetSnapshot(raw: unknown): CompanyWorkingSetSnapshot | null {
  const s = asRecord(raw);
  const company = asRecord(s?.company);
  if (!s || !company) return null;
  return {
    company,
    // BOUNDED ON READ AS WELL AS ON WRITE. The cap is this module's promise
    // about how large a restored working set can get, and a checkpoint written
    // by a build with a different cap must not be able to break it.
    yc_open_jobs: (Array.isArray(s.yc_open_jobs) ? s.yc_open_jobs : [])
      .map(asRecord).filter((j): j is Record<string, unknown> => j !== null)
      .slice(0, MAX_SNAPSHOT_JOBS),
    prequalified: asObjectOrNull(s.prequalified),
    prequal_key: asStringOrNull(s.prequal_key),
    shortlisted: s.shortlisted === true,
    investigation_state: asStringOrNull(s.investigation_state),
    shortlist_exclusion: asStringOrNull(s.shortlist_exclusion),
    investigation_rank: typeof s.investigation_rank === "number" &&
        Number.isFinite(s.investigation_rank)
      ? s.investigation_rank
      : null,
    triage: asObjectOrNull(s.triage),
    enriched: asObjectOrNull(s.enriched),
    enrichment_outcome: asStringOrNull(s.enrichment_outcome),
    // Carried across the JSON boundary like everything else here. A field
    // written but not read back is a field that does not survive a resume.
    identity: asObjectOrNull(s.identity),
    // ── AND THE SAME, ONE STAGE LATER ──────────────────────────────────────
    //
    // These two were written by `buildCheckpoint` and declared on the interface
    // — with a doc comment describing precisely this failure — and then never
    // read back here. So every restore silently dropped them, and the field
    // added to stop the Brain reporting "50 companies carried no hiring
    // assessment" could not do it: the assessment was persisted and then thrown
    // away on the way back in.
    //
    // Verified on the 2026-08-30 run: `tasks.result` for 66ef37b7 holds
    // `evidence_source: external_job_search` for Storm4, Talentoma and Storm3,
    // and `readCheckpointCompanies` returned all three with no assessment at
    // all. A continuation could not qualify a company whose hiring another
    // generation had already paid to verify.
    hiring_assessment: asObjectOrNull(s.hiring_assessment),
    // Bounded on read exactly like `yc_open_jobs`: a citation whose rows are
    // gone is not a citation, and an unbounded restore is how a working set
    // grows without limit.
    hiring_jobs: (Array.isArray(s.hiring_jobs) ? s.hiring_jobs : [])
      .map(asRecord).filter((j): j is Record<string, unknown> => j !== null)
      .slice(0, MAX_SNAPSHOT_JOBS),
    // Written, declared, and — until now — never read back. The same omission
    // that cost `hiring_assessment` a whole incident.
    brain: asObjectOrNull(s.brain),
    // AND THE EVALUATION IT CITES. Written, declared and read — all three, or
    // the verdict comes back as an outcome with no reasoning behind it.
    mission_evaluation: asObjectOrNull(s.mission_evaluation),
    // P4 — THE UNION'S PROVENANCE, READ BACK AS WELL AS WRITTEN.
    //
    // Canary 0dbce8d5 restored ten companies whose `found_by` the writer had
    // recorded and this reader dropped, so a continuation reported one source
    // for a company two routes had found. Bounded on read like the job lists.
    found_by: boundedRecords(s.found_by, MAX_SNAPSHOT_FOUND_BY),
    observations: boundedRecords(s.observations, MAX_SNAPSHOT_OBSERVATIONS).map(expandObservation),
    identity_conflicts: boundedRecords(s.identity_conflicts, MAX_SNAPSHOT_FOUND_BY),
  };
}

/** How many route sightings and observations a restored company may carry. */
export const MAX_SNAPSHOT_FOUND_BY = 12;
export const MAX_SNAPSHOT_OBSERVATIONS = 8;

function boundedRecords(raw: unknown, cap: number): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : [])
    .map(asRecord).filter((x): x is Record<string, unknown> => x !== null).slice(0, cap);
}

// ── CHECKPOINT SLIMMING ──────────────────────────────────────────────────────
//
// Query B canaries d22d9ee6 and eb0d520f (2026-10-12/13). Most discovered
// employers were rejected at discovery on a disjoint size band, and every one
// was still carried in every checkpoint with each job row it arrived on. Each
// row restated the same identity, location, size, headcount, industry and
// hiring evidence. The screened-out companies were most of the resume
// checkpoint; the task result passed 2 MB; its writes hit the 120 s statement
// timeout; and a lost slice-result write left the queue counting a real slice
// as a retry.
//
// `slimResumeRecord` is what a checkpoint stores for one company. It is pure
// and idempotent, and `readCheckpointCompanies` restores a record every reader
// treats the same: the replays of both Query B lineages resume from the slim
// checkpoint at every slice boundary and make the same decisions, with the
// same Workbench rows, as from the full one
// (tests/replay/historical/M_checkpointSlimming.test.ts).
//
// 1. Every company: at most MAX_SNAPSHOT_OBSERVATIONS observations — all the
//    reader ever restored. The rest were written on every checkpoint and never
//    read.
// 2. A CLOSED company (`recordIsClosed`):
//    * no job rows. The facts they established are in its observations, and
//      nothing investigates the company again;
//    * one statement per dimension (identity, location, size, headcount,
//      industry, job, hiring), the first it was seen with. Later sightings
//      restate the same dimensions; the Workbench row is built from one of
//      each. Every DISTINCT size band is kept, so a later sighting declaring a
//      different band still makes `discoverySizeRejectBlocker` refuse the
//      discovery-time rejection;
//    * every observation keeps its id, provider call, source record and entity
//      hint, which identity matching and observation de-duplication read;
//    * provenance once per observation: fields every evidence item of an
//      observation shares (source, company key, mission, timestamps) are
//      written once in `evidence_shared` and restored by `expandObservation`.

/**
 * A company closed by a decision before any paid stage touched it.
 *
 * `excluded_permanently` is the one investigation state only a decision sets
 * (a mission constraint or triage). With no identity, enrichment, hiring
 * assessment or Company Brain outcome, nothing was bought for it and nothing
 * will be: the next slice only has to keep it closed and recognisable.
 */
export function recordIsClosed(r: CompanyResumeRecord): boolean {
  const s = r.snapshot;
  return !!s && s.investigation_state === "excluded_permanently" &&
    !s.identity && !s.enriched && !s.hiring_assessment && !s.brain;
}

const SHARED_KEY = "evidence_shared";
const ORDER_KEY = "evidence_order";

/** One observation, with the fields all its evidence items share written once. Exactly invertible. */
export function compactObservation(o: Record<string, unknown>): Record<string, unknown> {
  if (o[SHARED_KEY] !== undefined || !Array.isArray(o.evidence) || o.evidence.length < 2) return o;
  const rows = o.evidence.map(asRecord);
  if (rows.some((x) => x === null)) return o;
  const items = rows as Record<string, unknown>[];
  // One field order every item follows (an item may lack an optional field,
  // such as `authority`). The expansion rebuilds each item in this order, so
  // the restored item is identical, key order included; when the items do not
  // share an order the observation is stored as it is.
  const order = [...new Set(items.flatMap((x) => Object.keys(x)))];
  const follows = (x: Record<string, unknown>) =>
    Object.keys(x).join("\u0000") === order.filter((k) => k in x).join("\u0000");
  if (!items.every(follows)) return o;
  const shared: Record<string, unknown> = {};
  for (const k of order) {
    if (!items.every((x) => k in x)) continue;
    const v = JSON.stringify(items[0][k]);
    if (items.every((x) => JSON.stringify(x[k]) === v)) shared[k] = items[0][k];
  }
  if (Object.keys(shared).length === 0) return o;
  return {
    ...o,
    evidence: items.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !(k in shared)))),
    [SHARED_KEY]: shared,
    [ORDER_KEY]: order,
  };
}

/** The inverse of `compactObservation`. An observation that was never compacted passes through unchanged. */
export function expandObservation(o: Record<string, unknown>): Record<string, unknown> {
  const shared = asRecord(o[SHARED_KEY]);
  const order = Array.isArray(o[ORDER_KEY])
    ? (o[ORDER_KEY] as unknown[]).filter((k): k is string => typeof k === "string")
    : null;
  if (!shared || !order) return o;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== SHARED_KEY && k !== ORDER_KEY) rest[k] = v;
  const items = Array.isArray(o.evidence)
    ? o.evidence.map(asRecord).filter((x): x is Record<string, unknown> => x !== null)
    : [];
  return {
    ...rest,
    evidence: items.map((x) => {
      const out: Record<string, unknown> = {};
      for (const k of order) {
        if (k in x) out[k] = x[k];
        else if (k in shared) out[k] = shared[k];
      }
      for (const [k, v] of Object.entries(x)) if (!(k in out)) out[k] = v;
      return out;
    }),
  };
}

/** A closed company's observations: one statement per dimension (every distinct size band), provenance once per observation. */
function closedObservations(raw: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const stated = new Set<string>();
  return raw.map(expandObservation).map((o) => compactObservation({
    ...o,
    evidence: (Array.isArray(o.evidence) ? o.evidence : []).filter((e) => {
      const x = asRecord(e);
      if (!x) return false;
      // One statement per dimension; every distinct size band.
      const fact = x.dimension === "company_size_band"
        ? `${x.dimension}|${x.status}|${x.method}|${JSON.stringify(x.value)}`
        : `${x.dimension}|${x.status}|${x.method}`;
      if (stated.has(fact)) return false;
      stated.add(fact);
      return true;
    }),
  }));
}

/** What a checkpoint stores for one company. Pure and idempotent. */
export function slimResumeRecord(r: CompanyResumeRecord): CompanyResumeRecord {
  const s = r.snapshot;
  if (!s) return r;
  const observations = (Array.isArray(s.observations) ? s.observations : [])
    .slice(0, MAX_SNAPSHOT_OBSERVATIONS);
  if (!recordIsClosed(r)) return { ...r, snapshot: { ...s, observations } };
  return { ...r, snapshot: { ...s, yc_open_jobs: [], observations: closedObservations(observations) } };
}

// ── THE CHECKPOINT DICTIONARY ────────────────────────────────────────────────
//
// After slimming, most of what remains in the company snapshots is repeated:
// the same evidence-authority object on every company seen by the same actor,
// the same identity hint on each of a company's sightings, the same reason
// sentence on every company rejected for the same band. A value inside a
// snapshot that occurs twice or more (a string of 24+ characters, or an object
// or array of 48+ bytes) is stored once in `snapshot_dictionary` and referenced
// as `{ "$ref": n }`.
//
// Lossless and deterministic: entries are numbered in first-seen order, and
// `expandSnapshotRefs` rebuilds every value as a fresh copy (a shared instance
// would let the engine's in-place edits of one company leak into another).
// Only snapshots are touched: a record's top-level stage labels stay readable
// by `runOutcome` without expansion.
//
// A compacted checkpoint carries CHECKPOINT_COMPACT_VERSION. The provider
// operation key embeds RESUME_STATE_VERSION, so that value cannot change; a
// separate envelope version keeps idempotency keys stable while a reader that
// predates compaction (a rollback) reads "no restorable companies" and refuses
// to resume, rather than restoring references as data.

export const CHECKPOINT_COMPACT_VERSION = "lead-resume-state-v1+dictionary-1" as const;

const REF = "$ref";
const MIN_STRING = 24;
const MIN_STRUCT = 48;

function isRef(v: unknown): v is { [REF]: number } {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).length === 1 && typeof (v as Record<string, unknown>)[REF] === "number";
}

function usesRefKey(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (!Array.isArray(v) && REF in (v as Record<string, unknown>)) return true;
  return (Array.isArray(v) ? v : Object.values(v)).some(usesRefKey);
}

const internable = (v: unknown, json: string) =>
  typeof v === "string" ? v.length >= MIN_STRING : !!v && typeof v === "object" && json.length >= MIN_STRUCT;

/** Snapshots with every repeated value replaced by a dictionary reference. */
export function internSnapshots(
  records: readonly CompanyResumeRecord[],
): { companies: CompanyResumeRecord[]; dictionary: unknown[] } {
  // A literal `$ref` key in the data would be ambiguous: store as it is.
  if (records.some((r) => usesRefKey(r.snapshot))) return { companies: [...records], dictionary: [] };
  const counts = new Map<string, number>();
  const count = (v: unknown) => {
    if (v === null || (typeof v !== "object" && typeof v !== "string")) return;
    const json = JSON.stringify(v);
    if (internable(v, json)) counts.set(json, (counts.get(json) ?? 0) + 1);
    if (v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) count(x);
  };
  for (const r of records) if (r.snapshot) for (const x of Object.values(r.snapshot)) count(x);
  const dictionary: unknown[] = [];
  const index = new Map<string, number>();
  const ref = (v: unknown): unknown => {
    if (v === null || (typeof v !== "object" && typeof v !== "string")) return v;
    const json = JSON.stringify(v);
    if (internable(v, json) && (counts.get(json) ?? 0) >= 2) {
      let n = index.get(json);
      if (n === undefined) {
        n = dictionary.length;
        index.set(json, n);
        dictionary.push(null);
        dictionary[n] = typeof v === "object" ? inner(v as object) : v;
      }
      return { [REF]: n };
    }
    return typeof v === "object" ? inner(v as object) : v;
  };
  const inner = (v: object): unknown => Array.isArray(v)
    ? v.map(ref)
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ref(x)]));
  const companies = records.map((r) => r.snapshot
    ? { ...r, snapshot: inner(r.snapshot) as CompanyWorkingSetSnapshot }
    : r);
  return { companies, dictionary };
}

/** The inverse of `internSnapshots` for one value: every reference rebuilt as a fresh copy. */
export function expandSnapshotRefs(v: unknown, dictionary: readonly unknown[], depth = 0): unknown {
  if (depth > 64) return null;
  if (isRef(v)) {
    const n = v[REF];
    return n >= 0 && n < dictionary.length ? expandSnapshotRefs(dictionary[n], dictionary, depth + 1) : null;
  }
  if (!v || typeof v !== "object") return v;
  return Array.isArray(v)
    ? v.map((x) => expandSnapshotRefs(x, dictionary, depth + 1))
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandSnapshotRefs(x, dictionary, depth + 1)]));
}

/** What a checkpoint stores for its companies: each slimmed, then the dictionary. */
export function compactCheckpointCompanies(
  records: readonly CompanyResumeRecord[],
): { version: typeof CHECKPOINT_COMPACT_VERSION; companies: CompanyResumeRecord[]; snapshot_dictionary: unknown[] } {
  const { companies, dictionary } = internSnapshots(records.map(slimResumeRecord));
  return { version: CHECKPOINT_COMPACT_VERSION, companies, snapshot_dictionary: dictionary };
}

const readableCheckpoint = (v: unknown) =>
  v === RESUME_STATE_VERSION || v === CHECKPOINT_COMPACT_VERSION;

/**
 * Per-company records from a persisted task result.
 *
 * VALIDATED, not cast. This crosses a trust boundary — the result column is
 * JSON that a previous deploy, or a hand edit, may have written in another
 * shape. A record whose `company_key` is missing is dropped rather than
 * defaulted, because a record under the wrong key would skip a paid call for a
 * company it does not describe. Everything else falls back to the "not started"
 * value, which can only ever cause work to be REDONE, never wrongly skipped.
 */
/** Stage names a deliberate invalidation may name. */
export const INVALIDATABLE_STAGES: readonly string[] =
  ["identity", "enrichment", "brain", "founder"];

/**
 * Parse `invalidated_stages`.
 *
 * `hiring` is DELIBERATELY ABSENT from `INVALIDATABLE_STAGES`. Hiring evidence is
 * the one thing this repo has repeatedly lost, and a field that could un-settle
 * it would be a way to destroy a paid citation through a checkpoint edit.
 */
function readInvalidatedStages(raw: unknown): Record<string, string> | null {
  const r = asRecord(raw);
  if (!r) return null;
  const out: Record<string, string> = {};
  for (const [stage, at] of Object.entries(r)) {
    if (!INVALIDATABLE_STAGES.includes(stage)) continue;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
    out[stage] = at;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * THE SEARCH STATE A RESUME NEEDS, READ BACK OFF THE CHECKPOINT.
 *
 * Its own reader because it is run-level, while `readCheckpointCompanies`
 * returns a list of companies. Same contract as everything else here: an
 * unrecognised or absent value narrows to `null`, which the caller reads as
 * "discovery state unknown" and therefore as "no routes remain" — the terminal
 * behaviour a checkpoint from before this field existed already had.
 */
export function readCheckpointDiscoveryState(
  taskResult: unknown,
): Checkpoint["discovery_source_state"] {
  const result = asRecord(taskResult);
  const checkpoint = asRecord(result?.[CHECKPOINT_RESULT_KEY]);
  if (!checkpoint || !readableCheckpoint(checkpoint.version)) return null;
  const d = asRecord(checkpoint.discovery_source_state);
  if (!d) return null;
  const pages: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(d.pages_taken) ?? {})) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) pages[k] = v;
  }
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    sources_attempted: Array.isArray(d.sources_attempted)
      ? d.sources_attempted.filter((x): x is string => typeof x === "string")
      : [],
    pages_taken: pages,
    admitted: num(d.admitted),
    available_admitted: num(d.available_admitted),
    raw_rows: num(d.raw_rows),
    pool_target: num(d.pool_target),
    // DEFAULTS TO EXHAUSTED. An unreadable flag must not be the reason a
    // lineage keeps spending; the safe direction for this one field is to stop.
    exhausted: d.exhausted !== false,
    stop_reason: typeof d.stop_reason === "string" ? d.stop_reason : "unknown",
    ...(() => {
      const fps: Record<string, string> = {};
      for (const [k, v] of Object.entries(asRecord(d.page_fingerprints) ?? {})) {
        if (typeof v === "string" && v) fps[k] = v;
      }
      return Object.keys(fps).length ? { page_fingerprints: fps } : {};
    })(),
  };
}

export function readCheckpointCompanies(taskResult: unknown): CompanyResumeRecord[] {
  const result = asRecord(taskResult);
  const checkpoint = asRecord(result?.[CHECKPOINT_RESULT_KEY]);
  if (!checkpoint || !readableCheckpoint(checkpoint.version)) return [];
  if (!Array.isArray(checkpoint.companies)) return [];
  const dictionary = Array.isArray(checkpoint.snapshot_dictionary) ? checkpoint.snapshot_dictionary : [];
  const out: CompanyResumeRecord[] = [];
  for (const raw of checkpoint.companies) {
    const c = asRecord(raw);
    const key = c?.company_key;
    if (!c || typeof key !== "string" || !key) continue;
    const base = newCompanyRecord(
      key, typeof c.company_name === "string" ? c.company_name : key);
    out.push({
      ...base,
      identity: asStage(c.identity,
        ["not_started", "resolved", "unresolved", "mismatch"] as const, "not_started"),
      enrichment: asStage(c.enrichment,
        ["not_started", "completed", "failed", "not_required",
          "empty", "deferred", "provider_error"] as const, "not_started"),
      hiring: asStage(c.hiring,
        ["not_started", "verified_from_existing_evidence", "verified_externally",
          "verification_needed", "not_verified", "evidence_unavailable",
          "failed"] as const, "not_started"),
      brain: asStage(c.brain,
        ["not_started", "qualified", "review", "rejected", "failed"] as const, "not_started"),
      founder: asStage(c.founder,
        ["not_started", "completed", "unresolved", "failed", "not_eligible"] as const,
        "not_started"),
      linkedin_company_url: typeof c.linkedin_company_url === "string"
        ? c.linkedin_company_url : null,
      completed_operations: Array.isArray(c.completed_operations)
        ? c.completed_operations.filter((o): o is string => typeof o === "string" && !!o)
        : [],
      updated_at: typeof c.updated_at === "string" ? c.updated_at : base.updated_at,
      // Validated, like everything else that crosses this boundary: only known
      // stage names, only ISO-shaped values.
      invalidated_stages: readInvalidatedStages(c.invalidated_stages),
      // WITHOUT THIS LINE THE LEDGER IS UNREACHABLE. See
      // `readWorkingSetSnapshot` — it was written on every checkpoint and read
      // on none, which is what made every continuation restore zero companies.
      snapshot: readWorkingSetSnapshot(dictionary.length ? expandSnapshotRefs(c.snapshot, dictionary) : c.snapshot),
    });
  }
  return out;
}

/**
 * The task id every invocation in one continuation chain shares.
 *
 * `providerOperationKey` is only stable if this is. Using the immediate parent
 * would make a THIRD invocation compute different keys from the second and
 * re-buy everything the second had already paid for — the exact failure the key
 * exists to prevent. So the root propagates: a run that has one keeps it, and
 * only a run without one becomes the root.
 */
export function lineageRootTaskId(
  parentTaskId: string, parentTaskResult: unknown,
): string {
  const stored = asRecord(parentTaskResult)?.[LINEAGE_ROOT_RESULT_KEY];
  return typeof stored === "string" && stored ? stored : parentTaskId;
}
