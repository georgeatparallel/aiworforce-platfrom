// LEAD V2 — THE HARD "CURRENTLY HIRING <ROLE>" CLAIM, VERIFIED LIKE ANY OTHER.
//
// Hiring used to be an in-slice graph stage that bought a LinkedIn job search
// for EVERY identity-resolved company, before country, size, business model or
// funding had been grounded. A company that had already failed on country still
// paid for a job search, and the search asked for a whole sales vocabulary
// whatever the role (pre-canary compile, 2026-09-24).
//
// Here it is a claim verifier in the verification phase, so it obeys the same
// discipline as the funding and business-model verifiers:
//
//   targeted by the gap router     only PENDING candidates whose hard `hiring`
//                                  claim is open, and only once every cheap hard
//                                  claim (country, size band) is settled
//   re-grounded between verifiers  a candidate a cheaper verifier disproved is
//                                  never a target here
//   ordered by its real estimate   `estimate_per_target_usd` from the card and
//                                  the actual title keywords, not a static hint
//   bought through the spine       ProviderCallSpec → reservation → guard →
//                                  settlement, via `deps.call`
//
// WHAT COUNTS AS AN ANSWER. The provider's title matching is fuzzy (card
// warning), so every returned posting passes a deterministic role test — the
// requested family's own matcher — and the mission's posting window. A matching
// posting is PROVEN open-role evidence (`job_evidence` authority). No matching
// posting on LinkedIn is NOT a disproof — a company may hire elsewhere — so the
// claim stays PENDING, answered, and is not bought again this mission.
//
// A RUN STILL EXECUTING IS ADOPTED, NEVER RE-BOUGHT. A job search that outlives
// the provider poll (or whose wait the slice's stop cut short) comes back
// `running`. It used to be dropped: the next slice compiled the same spec, found
// it already executed, and was refused — the paid answer was never read and the
// claim never answered. Its run id now travels as a pending run, and the next
// slice adopts it with the same input (same spec, same idempotency key) and a
// free status read. A deferred adoption carries the run unchanged.
//
// Pure apart from `deps.call`.

import type {
  ClaimVerifier, PendingVerifierRun, VerificationTarget, VerifierCall, VerifierDeps, VerifierFinding,
} from "./claimVerifier.ts";
import type { EvidenceItem } from "./candidateObservation.ts";
import { EVIDENCE_VALIDITY_DAYS } from "./candidateObservation.ts";
import { authorityForEvidence, authorityRecord } from "./evidenceAuthority.ts";
import { compileHarvestJobSearchInput } from "./hiringActorInputs.ts";
import { jobEmployerIdentityConflict, normalizeLinkedInJob, type NormalizedHiringJob } from "./hiringActorNormalizers.ts";
import { normalizeCompanyLinkedInUrl } from "./structuredCompanyEnrichment.ts";
import { estimateCallUsd } from "./budgetPolicy.ts";
import { hiringActorCard } from "./hiringActorCatalog.ts";

export const HIRING_CLAIM_VERIFIER_KEY = "open_role_linkedin_jobs" as const;
export const HIRING_ROUTE_ACTOR = "apify_linkedin_job_search" as const;
/** Job rows asked per company — the same evidence standard the in-slice stage used. */
export const HIRING_ROWS_PER_COMPANY = 10;
/** Companies per slice; one call carries them all (the actor takes up to 10). */
export const HIRING_MAX_TARGETS = 5;

export interface HiringVerifierIO {
  /** The title KEYWORDS to search — the requested role family, already covering-reduced. */
  titles: readonly string[];
  /** The requested role, as a deterministic test on a posting title. */
  matchesRole: (title: string) => boolean;
  /** The role family names the claim asked for, recorded on the evidence. */
  role_families: readonly string[];
  /** The hiring window in days (the criterion's), or null for none. */
  window_days: number | null;
  now?: () => Date;
}

/** The provider's posting-date filter for a window. The enum is 1h | 24h | week | month. */
function postedLimitFor(days: number | null): string | undefined {
  if (days == null) return undefined;
  if (days <= 1) return "24h";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return undefined;
}

/** The input for these companies, compiled against the card's contract. */
export function hiringVerifierInput(io: Pick<HiringVerifierIO, "titles" | "window_days">, companyUrls: readonly string[]):
  Record<string, unknown> | null {
  const postedLimit = postedLimitFor(io.window_days);
  const r = compileHarvestJobSearchInput({
    company: [...companyUrls], jobTitles: [...io.titles],
    maxItems: HIRING_ROWS_PER_COMPANY * companyUrls.length,
    ...(postedLimit ? { postedLimit } : {}),
  } as never) as { ok?: boolean; input?: Record<string, unknown> };
  return r.ok === false || !r.input ? null : r.input;
}

/**
 * The card's price for asking about ONE company with these titles — the
 * ordering estimate, from the RAW input. Not what the ledger reserves: the spec
 * compiler clamps the rows to the call ceiling, so this can be several times
 * the compiled estimate ($0.121 vs $0.049 for 12 titles). Affordability never
 * reads it (`claimVerifier.ledgerAffordability`).
 */
export function hiringEstimatePerTargetUsd(io: Pick<HiringVerifierIO, "titles" | "window_days">): number | null {
  const input = hiringVerifierInput(io, ["https://www.linkedin.com/company/estimate"]);
  const card = hiringActorCard(HIRING_ROUTE_ACTOR);
  if (!input || !card) return null;
  return estimateCallUsd(HIRING_ROUTE_ACTOR, card.cost_model, input);
}

/**
 * Is this posting inside the claim's window?
 *
 * AN UNDATED POSTING PROVES NO WINDOW. With no window every posting counts; with
 * one, a posting whose date is missing or unreadable cannot show it is recent, so
 * it does not prove "currently hiring" (quality run T02: an undated Account
 * Executive posting qualified a company on a 30-day window). Live job-search rows
 * carry an ISO `postedDate`, so this only ever drops malformed rows.
 */
function withinWindow(job: NormalizedHiringJob, days: number | null, now: Date): boolean {
  if (days == null) return true;
  const t = job.posted_date ? Date.parse(job.posted_date) : NaN;
  return Number.isFinite(t) && now.getTime() - t <= days * 86_400_000;
}

function openRoleItem(t: Pick<VerificationTarget, "company_key">, jobs: NormalizedHiringJob[], io: HiringVerifierIO,
  providerCallId: string, observedAt: string, missionId: string | null): EvidenceItem {
  const a = authorityForEvidence({
    claim: "open_role", source: HIRING_ROUTE_ACTOR, field: "job_posting", observed_at: observedAt,
    now: io.now?.() ?? new Date(),
  });
  const days = EVIDENCE_VALIDITY_DAYS.hiring ?? null;
  const top = jobs[0];
  return {
    evidence_id: `hir_${t.company_key}_open_role`.slice(0, 64),
    company_key: t.company_key,
    dimension: "hiring",
    value: {
      open_role: true,
      role_families: [...io.role_families],
      titles: jobs.slice(0, 5).map((j) => j.title).filter(Boolean),
    },
    status: a.authority === "proven" ? "proven" : "plausible",
    authority: authorityRecord(a),
    source: {
      provider: "apify", actor: HIRING_ROUTE_ACTOR, provider_call_id: providerCallId,
      url: top?.job_url ?? null, excerpt: top?.title ?? null,
    },
    method: "provider_field",
    observed_at: observedAt,
    valid_until: days == null ? null : new Date(Date.parse(observedAt) + days * 86_400_000).toISOString(),
    confidence: "high",
    derived_from: [],
    mission_id: missionId,
    origin: "lead_mission",
  } as EvidenceItem;
}

/** The targets a job search can ask about: a company is asked by its LinkedIn page; one without it cannot be. */
function askable(targets: readonly VerificationTarget[]): Array<{ t: VerificationTarget; url: string }> {
  return targets
    .map((t) => ({ t, url: normalizeCompanyLinkedInUrl(t.linkedin_url) }))
    .filter((x): x is { t: VerificationTarget; url: string } => !!x.url);
}

/** The one job search for these companies — what `verify` sends and what the phase prices. */
function hiringCall(io: Pick<HiringVerifierIO, "titles" | "window_days">,
  asked: ReadonlyArray<{ t: VerificationTarget; url: string }>): VerifierCall | null {
  if (asked.length === 0 || io.titles.length === 0) return null;
  const input = hiringVerifierInput(io, asked.map((x) => x.url));
  if (!input) return null;
  return {
    actor_key: HIRING_ROUTE_ACTOR, capability: "hiring_verification", input,
    candidate_keys: asked.map((x) => x.t.company_key), purpose: "hiring_evidence",
  };
}

export function hiringClaimVerifier(io: HiringVerifierIO): ClaimVerifier & { estimate_per_target_usd: () => number | null } {
  return {
    key: HIRING_CLAIM_VERIFIER_KEY,
    claim: "open_role",
    route_actor: HIRING_ROUTE_ACTOR,
    max_targets: HIRING_MAX_TARGETS,
    estimate_per_target_usd: () => hiringEstimatePerTargetUsd(io),
    // One job search per batch, and a company is answered only if it runs: a
    // company its evidence budget cannot cover is left out, not allowed to get
    // the whole batch refused (`claimVerificationPhase`). Priced from the
    // compiled `call_for`, never from `estimate_per_target_usd`.
    all_or_nothing_per_target: true,
    call_for: (targets) => hiringCall(io, askable(targets)),
    async verify(targets, deps: VerifierDeps, ctx) {
      const findings: VerifierFinding[] = [];
      const pending: PendingVerifierRun[] = [];
      const at = deps.now();
      // One finding per asked company, from the rows of the call that answered it.
      const settle = (asked: ReadonlyArray<{ t: Pick<VerificationTarget, "company_key">; url: string }>,
        rows: Record<string, unknown>[], providerCallId: string) => {
        const now = io.now?.() ?? new Date();
        const jobs = rows.filter((r) => !jobEmployerIdentityConflict(r)).map((r) => normalizeLinkedInJob(r));
        for (const { t, url } of asked) {
          const mine = jobs.filter((j) => normalizeCompanyLinkedInUrl(j.company_linkedin_url) === url);
          const matching = mine.filter((j) => !!j.title && io.matchesRole(j.title) && withinWindow(j, io.window_days, now));
          findings.push({
            company_key: t.company_key,
            item: matching.length > 0 ? openRoleItem(t, matching, io, providerCallId, at, ctx.mission_id) : null,
            answered: true,
            detail: {
              postings_returned: mine.length,
              postings_matching_role: matching.length,
              // Postings with no readable date: never proof inside a window (T02).
              postings_undated: io.window_days == null ? 0
                : mine.filter((j) => !(j.posted_date && Number.isFinite(Date.parse(j.posted_date)))).length,
              rejected_titles: mine.filter((j) => !matching.includes(j)).map((j) => j.title).slice(0, 5),
              verdict: matching.length > 0 ? "open_role_proven" : "no_matching_posting_on_linkedin_pending",
            },
          });
        }
      };

      // ── 1. ADOPT WHAT EARLIER SLICES STARTED ─────────────────────────────
      // Before the readiness and target checks: a run already paid for is read
      // (or carried) whatever this slice would buy.
      for (const p of ctx.pending.filter((x) => x.verifier === HIRING_CLAIM_VERIFIER_KEY)) {
        const asked = hiringCarryOf(p);
        if (!asked) {
          deps.log("hiring_verifier_pending_unreadable", { run_id: p.run_id });
          continue;
        }
        const out = await deps.call({
          actor_key: HIRING_ROUTE_ACTOR, capability: "hiring_verification", input: p.input,
          candidate_keys: p.candidate_keys, purpose: "hiring_evidence", resume_run_id: p.run_id,
        });
        if (out.status === "ok") {
          settle(asked.map((a) => ({ t: { company_key: a.company_key }, url: a.url })), out.rows, out.provider_call_id);
          continue;
        }
        // Still executing, or not even asked (the slice is stopping): the SAME
        // run, carried unchanged, so the next slice adopts it.
        if (out.status === "running" || out.status === "deferred") {
          pending.push(p);
          deps.log("hiring_verifier_run_carried", { run_id: p.run_id, status: out.status });
          continue;
        }
        deps.log("hiring_verifier_adoption", { run_id: p.run_id, status: out.status, reason: out.reason });
      }

      if (targets.length === 0 || io.titles.length === 0 || !deps.ready(HIRING_ROUTE_ACTOR)) {
        return { findings, pending };
      }
      const asked = askable(targets);
      if (asked.length === 0) return { findings, pending };
      const call = hiringCall(io, asked);
      if (!call) {
        deps.log("hiring_verifier_input_refused", { companies: asked.length });
        return { findings, pending };
      }
      const out = await deps.call(call);
      if (out.status === "running") {
        // PAID AND STILL EXECUTING: carried by run id, adopted next slice.
        pending.push({
          verifier: HIRING_CLAIM_VERIFIER_KEY, stage: HIRING_PENDING_STAGE, actor_key: HIRING_ROUTE_ACTOR,
          run_id: out.run_id, input: call.input, candidate_keys: call.candidate_keys, started_at: at,
          carry: { asked: asked.map(({ t, url }) => ({ company_key: t.company_key, url })) },
        });
        deps.log("hiring_verifier_run_pending", { run_id: out.run_id, companies: asked.length });
        return { findings, pending };
      }
      if (out.status !== "ok") {
        // Refused (budget, readiness), failed, or deferred by the slice's stop:
        // nothing is marked answered, so the gap stays open for a later slice.
        deps.log("hiring_verifier_call", { status: out.status, reason: "reason" in out ? out.reason : null });
        return { findings, pending };
      }
      settle(asked, out.rows, out.provider_call_id);
      return { findings, pending };
    },
  };
}

/** The stage name a carried hiring run is recorded under. */
export const HIRING_PENDING_STAGE = "job_search" as const;

/** The companies a carried run asked about, or null when the carry is unreadable. */
function hiringCarryOf(p: PendingVerifierRun): Array<{ company_key: string; url: string }> | null {
  const asked = (p.carry as { asked?: unknown } | undefined)?.asked;
  if (!Array.isArray(asked) || asked.length === 0) return null;
  const out: Array<{ company_key: string; url: string }> = [];
  for (const a of asked) {
    const k = (a as { company_key?: unknown })?.company_key;
    const u = (a as { url?: unknown })?.url;
    if (typeof k !== "string" || typeof u !== "string" || !k || !u) return null;
    out.push({ company_key: k, url: u });
  }
  return out;
}
