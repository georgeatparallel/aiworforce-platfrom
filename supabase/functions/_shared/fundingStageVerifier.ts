// LEAD V2 P6 — THE FUNDING-STAGE VERIFIER: ONE CAPABILITY, TWO PROVIDERS.
//
// Plugs into the Claim Registry route `apify_funding_atomus / funding_verification`.
// The gap router decides WHEN a company needs it (a hard `company_stage` claim
// PENDING, route READY, not yet answered); this decides WHAT the funding record
// says, cheapest first:
//
//   0. what the mission already holds: funding discovery's rounds, read from
//        the company's evidence graph (never re-bought). They cite, and they
//        can contradict; they never prove completeness.
//   1. atomus, one batch, by LinkedIn page       (cheapest; price on its card)
//        a verified later round (Series A+)  → FAIL, done
//        complete history, latest = Seed, and a DISCOVERED round cites that
//        same Seed round                     → PASS, no pvalyou purchase
//   2. pvalyou, batches of 2, only for Seed / pre-seed / unclear  (price on its card)
//        corroborated by `fundingCorroboration`, decided with
//        `pass_requires_source_url`:
//        complete history + cited decisive Seed round → PASS
//        a cited later round atomus lacks             → FAIL
//        anything else                                → PENDING
//
// A pvalyou read of a company it has not seen can take many minutes, longer
// than a slice; the run is returned as PENDING-RUN with the atomus reading
// carried beside it, and adopted on the next slice — never bought twice.
//
// Nothing here infers a stage: no age, size, branding or model reading reaches
// the decision (`fundingStageClaim` takes rounds and nothing else).

import { hiringActorCard } from "./hiringActorCatalog.ts";
import { estimateCallUsd } from "./budgetPolicy.ts";
import {
  batches, type ClaimVerifier, type PendingVerifierRun, type VerificationTarget,
  type VerifierDeps, type VerifierFinding,
} from "./claimVerifier.ts";
import {
  ATOMUS_FUNDING_ACTOR_KEY, atomusSettles, decideCorroboratedFundingStage, fundingRecordEvidenceItem, fundingRecordsInGraph,
  normalizeAtomusFunding, normalizePvalyouFunding, PVALYOU_FUNDING_ACTOR_KEY, stampFundingCall,
} from "./fundingCorroboration.ts";
import {
  decideHasRaised, decideRecentlyFunded, fundingKindOf, fundingPresenceOf, fundingStageEvidenceItem, recordCompleteness, stageRequirement,
  type FundingRecordFact,
  type FundingStageDecision,
} from "./fundingStageClaim.ts";

export const FUNDING_STAGE_VERIFIER_KEY = "funding_stage_corroboration" as const;
/** The claim-verifier capability both halves of the pair are carded under. */
export const FUNDING_VERIFICATION_CAPABILITY = "funding_verification" as const;
/** atomus is one call for all of them; bounded so per-candidate evidence spend stays small. */
export const FUNDING_MAX_TARGETS = 6;
/** Two pvalyou reads per call keeps each call under the funding-evidence call ceiling (DEFAULT_CEILINGS). */
export const PVALYOU_BATCH = 2;

/** A LinkedIn company page as atomus accepts it: the canonical URL, or null. */
export function atomusInput(linkedinUrl: string | null): string | null {
  if (!linkedinUrl) return null;
  const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(linkedinUrl);
  return m ? `https://www.linkedin.com/company/${m[1].toLowerCase()}` : null;
}

/** atomus's slug for a URL, for matching its row back when it echoes a slug. */
function slugOf(v: string | null): string | null {
  if (!v) return null;
  const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(v);
  return (m ? m[1] : v).toLowerCase().replace(/\/+$/, "");
}

function finding(t: VerificationTarget, decision: FundingStageDecision, record: FundingRecordFact | null, i: {
  mission_id: string | null; provider_call_id: string | null; at: string; stage: string; conflicts?: string[];
}): VerifierFinding {
  // THE DATED ROUNDS, as the same `funding` record discovery writes, so the
  // time-window claim reads what the pair already bought — and the record the
  // verdict is DERIVED FROM, so the graph can say which evidence it rests on.
  const supporting = record
    ? fundingRecordEvidenceItem({ company_key: t.company_key, record, mission_id: i.mission_id, observed_at: i.at })
    : null;
  const item = record
    ? fundingStageEvidenceItem({
      company_key: t.company_key, decision, record, mission_id: i.mission_id,
      provider_call_id: i.provider_call_id, observed_at: i.at,
      derived_from: supporting ? [supporting.evidence_id] : [],
    })
    : null;
  return {
    company_key: t.company_key, item, answered: true,
    ...(supporting ? { supporting: [supporting] } : {}),
    detail: {
      stage: i.stage, verdict: decision.verdict, reasons: decision.reasons, explanation: decision.explanation,
      ...(i.conflicts?.length ? { conflicts: i.conflicts } : {}),
    },
  };
}

/** The carry a pending pvalyou run holds: each company's atomus record and the input it was read under. */
interface PvalyouCarry {
  targets: VerificationTarget[];
  atomus: Record<string, FundingRecordFact | null>;
  inputs: Record<string, string>;
  atomus_call_id: string | null;
  /** The funding records each company's graph already carried (discovery). */
  discovered?: Record<string, FundingRecordFact[]>;
}

/** The records discovery already bought for this company. */
const discoveredOf = (t: VerificationTarget): FundingRecordFact[] => (t.graph ? fundingRecordsInGraph(t.graph) : []);

/** The Atomus record a company already holds — from the funding screen or an earlier slice. */
const heldAtomusOf = (t: VerificationTarget): FundingRecordFact | null =>
  discoveredOf(t).find((r) => r.actor === ATOMUS_FUNDING_ACTOR_KEY) ?? null;

/** Pending stages for Pvalyou steps a stopped slice deferred (`PendingVerifierRun.deferred`). */
export const DEFERRED_PVALYOU_STAGE = "pvalyou_deferred" as const;
export const DEFERRED_PVALYOU_RECENCY_STAGE = "pvalyou_recency_deferred" as const;
type DeferredFundingStage = typeof DEFERRED_PVALYOU_STAGE | typeof DEFERRED_PVALYOU_RECENCY_STAGE;

export interface FundingStageVerifierOptions {
  /**
   * Ask Pvalyou when Atomus leaves a recency claim open. Off for the funding
   * SCREEN (`fundingPoolScreen.ts`): the pool is read by Atomus alone, and the
   * fallback is spent later, only on a company that was admitted.
   */
  fallback?: boolean;
}

export function fundingStageVerifier(opts: FundingStageVerifierOptions = {}): ClaimVerifier {
  const fallbackOn = opts.fallback !== false;
  return {
    key: FUNDING_STAGE_VERIFIER_KEY,
    claim: "funding_stage",
    route_actor: ATOMUS_FUNDING_ACTOR_KEY,
    // Atomus, then — only after Atomus answered without a decisive round — the
    // Pvalyou recency fallback (`PVALYOU_RECENCY_FALLBACK_ROUTE`).
    route_actors: [ATOMUS_FUNDING_ACTOR_KEY, PVALYOU_FUNDING_ACTOR_KEY],
    max_targets: FUNDING_MAX_TARGETS,
    // The first purchase for a company is one atomus read, at the card's price.
    estimate_per_target_usd: () => {
      const card = hiringActorCard(ATOMUS_FUNDING_ACTOR_KEY);
      return card ? estimateCallUsd(ATOMUS_FUNDING_ACTOR_KEY, card.cost_model,
        { companies: ["https://www.linkedin.com/company/estimate"] }) : null;
    },
    async verify(targets, deps, ctx) {
      const findings: VerifierFinding[] = [];
      const pending: PendingVerifierRun[] = [];
      const at = deps.now();

      // ── the pvalyou half of a pair, decided once its rows exist ──────────
      const settleWithPvalyou = (
        carry: PvalyouCarry, rows: Record<string, unknown>[] | null, callId: string | null,
      ) => {
        const reads = (rows ?? []).map(normalizePvalyouFunding);
        for (const t of carry.targets) {
          const sent = carry.inputs[t.company_key];
          const pv = reads.find((r) => r.input === sent) ?? null;
          const pvRecord = pv?.record ? stampFundingCall(pv.record, callId) : null;
          const atomus = carry.atomus[t.company_key] ?? null;
          const { decision, corroboration } = decideCorroboratedFundingStage({
            required_stage: stageRequirement(t.criterion), atomus, pvalyou: pvRecord,
            discovered: carry.discovered?.[t.company_key] ?? [],
          });
          findings.push(finding(t, decision, corroboration.record, {
            mission_id: ctx.mission_id, provider_call_id: callId ?? carry.atomus_call_id, at,
            stage: rows === null ? "atomus_only" : "corroborated", conflicts: corroboration.conflicts,
          }));
        }
      };

      // ── STOPPED BEFORE A PVALYOU READ (deadline, cancellation, lost lease) ──
      //
      // Not an answer: no finding marks the route, so the claim stays open.
      // What THIS slice already bought is not bought again:
      //   * the Atomus record is recorded as evidence (`heldAtomusOf` reads it);
      //   * the whole step — targets, Atomus answers INCLUDING "no record",
      //     inputs — is carried as a `deferred` pending entry, so the next slice
      //     asks Pvalyou from it. Without the carry a company Atomus had no
      //     record for would be re-batched and its Atomus read bought twice.
      // The carried companies are held from other verifiers until it resumes,
      // exactly as a running Pvalyou run's are.
      const deferAfterAtomus = (carry: PvalyouCarry, reason: string, stage: DeferredFundingStage) => {
        for (const t of carry.targets) {
          const atomus = carry.atomus[t.company_key] ?? null;
          if (!atomus) continue;
          findings.push({
            company_key: t.company_key, answered: false,
            item: fundingRecordEvidenceItem({ company_key: t.company_key, record: atomus, mission_id: ctx.mission_id, observed_at: at }),
            detail: { stage, deferred: true, reason },
          });
        }
        pending.push({
          verifier: FUNDING_STAGE_VERIFIER_KEY, stage, actor_key: PVALYOU_FUNDING_ACTOR_KEY, run_id: "",
          input: {}, candidate_keys: carry.targets.map((t) => t.company_key), started_at: at,
          carry: carry as unknown as Record<string, unknown>, deferred: true,
        });
        deps.log("funding_verifier_deferred", { stage, companies: carry.targets.length, reason });
      };

      const runPvalyou = async (carry: PvalyouCarry, resume?: PendingVerifierRun) => {
        const input = resume?.input ?? {
          tier: "basic", companies: carry.targets.map((t) => carry.inputs[t.company_key]),
        };
        const out = await deps.call({
          actor_key: PVALYOU_FUNDING_ACTOR_KEY, capability: FUNDING_VERIFICATION_CAPABILITY, input, purpose: "funding_evidence",
          candidate_keys: carry.targets.map((t) => t.company_key), resume_run_id: resume?.run_id ?? null,
        });
        if (out.status === "ok") return settleWithPvalyou(carry, out.rows, out.provider_call_id);
        if (out.status === "running") {
          pending.push({
            verifier: FUNDING_STAGE_VERIFIER_KEY, stage: "pvalyou", actor_key: PVALYOU_FUNDING_ACTOR_KEY,
            run_id: out.run_id, input, candidate_keys: carry.targets.map((t) => t.company_key),
            started_at: resume?.started_at ?? at, carry: carry as unknown as Record<string, unknown>,
          });
          deps.log("funding_verifier_run_pending", { run_id: out.run_id, companies: carry.targets.length });
          return;
        }
        if (out.status === "deferred") {
          // An adoption not even asked: the SAME run, carried unchanged.
          if (resume) {
            pending.push(resume);
            deps.log("funding_verifier_run_carried", { run_id: resume.run_id, stage: "pvalyou" });
          } else {
            deferAfterAtomus(carry, out.reason, DEFERRED_PVALYOU_STAGE);
          }
          return;
        }
        // Refused or failed: nothing to cite. atomus alone can still FAIL (already
        // settled above) but can never PASS, so the claim stays PENDING — and is
        // answered: asking again this mission would return the same refusal.
        deps.log("funding_verifier_corroboration_unavailable", { status: out.status, reason: out.reason });
        settleWithPvalyou(carry, null, null);
      };

      // ── RECENCY: THE ATOMUS READING, AND THE PVALYOU FALLBACK WHEN IT IS OPEN ──
      //
      // One finding per company. The ATOMUS record (when there is one) is the
      // item; a Pvalyou record is recorded beside it, so the eligibility check
      // reads every dated round either provider holds. Pvalyou never states a
      // complete history (normalizePvalyouFunding: no round count, no
      // history_complete), so it can PASS a claim — a verified dated round inside
      // the window — but never FAIL one: absence is not completeness.
      const recencyFinding = (t: VerificationTarget, atomus: FundingRecordFact | null, atomusCall: string | null,
        pv: FundingRecordFact | null, stage: string): VerifierFinding => {
        const at2 = at;
        const atomusItem = atomus
          ? fundingRecordEvidenceItem({ company_key: t.company_key, record: atomus, mission_id: ctx.mission_id, observed_at: at2 })
          : null;
        const pvItem = pv
          ? fundingRecordEvidenceItem({ company_key: t.company_key, record: pv, mission_id: ctx.mission_id, observed_at: at2 })
          : null;
        const item = atomusItem ?? pvItem;
        const window = t.criterion.window_days ?? null;
        const after = decideRecentlyFunded({ window_days: window, records: [...discoveredOf(t), ...(atomus ? [atomus] : []), ...(pv ? [pv] : [])], now: at2,
          kind: fundingKindOf(t.criterion.value) });
        return {
          company_key: t.company_key, answered: true, item,
          ...(atomusItem && pvItem ? { supporting: [pvItem] } : {}),
          detail: {
            stage, claim: "recently_funded", provider_call_id: atomusCall,
            rounds: atomus?.rounds.length ?? 0, history_complete: atomus ? recordCompleteness(atomus)?.complete === true : false,
            ...(stage !== "atomus_recency" ? { pvalyou_rounds: pv?.rounds.length ?? 0, pvalyou_call_id: pv?.provider_call_id ?? null } : {}),
            verdict_after: after.verdict, reasons: after.reasons,
          },
        };
      };
      const runRecencyFallback = async (carry: PvalyouCarry, resume?: PendingVerifierRun) => {
        const input = resume?.input ?? {
          tier: "basic", companies: carry.targets.map((t) => carry.inputs[t.company_key]),
        };
        const out = await deps.call({
          actor_key: PVALYOU_FUNDING_ACTOR_KEY, capability: FUNDING_VERIFICATION_CAPABILITY, input, purpose: "funding_evidence",
          candidate_keys: carry.targets.map((t) => t.company_key), resume_run_id: resume?.run_id ?? null,
          // Bought only because Atomus was inconclusive: it must not crowd the
          // company's other hard checks out of its evidence budget (Wave 3).
          ceiling_allowance: "funding_fallback",
        });
        if (out.status === "running") {
          pending.push({
            verifier: FUNDING_STAGE_VERIFIER_KEY, stage: "pvalyou_recency", actor_key: PVALYOU_FUNDING_ACTOR_KEY,
            run_id: out.run_id, input, candidate_keys: carry.targets.map((t) => t.company_key),
            started_at: resume?.started_at ?? at, carry: carry as unknown as Record<string, unknown>,
          });
          deps.log("funding_recency_fallback_pending", { run_id: out.run_id, companies: carry.targets.length });
          return;
        }
        if (out.status === "deferred") {
          // Never asked, so never "attempted": the fallback stays available.
          if (resume) {
            pending.push(resume);
            deps.log("funding_verifier_run_carried", { run_id: resume.run_id, stage: "pvalyou_recency" });
          } else {
            deferAfterAtomus(carry, out.reason, DEFERRED_PVALYOU_RECENCY_STAGE);
          }
          return;
        }
        const reads = out.status === "ok" ? out.rows.map(normalizePvalyouFunding) : [];
        if (out.status !== "ok") deps.log("funding_recency_fallback_unavailable", { status: out.status, reason: out.reason });
        for (const t of carry.targets) {
          const sent = carry.inputs[t.company_key];
          const pv = reads.find((r) => r.input === sent) ?? null;
          const pvRecord = pv?.record && out.status === "ok" ? stampFundingCall(pv.record, out.provider_call_id) : null;
          findings.push({
            ...recencyFinding(t, carry.atomus[t.company_key] ?? null, carry.atomus_call_id, pvRecord,
              out.status === "ok" ? "atomus_then_pvalyou" : "atomus_only_fallback_unavailable"),
            // ASKED, whatever it said: a Pvalyou answer (or refusal) for this
            // company is never bought twice.
            attempted_actors: [PVALYOU_FUNDING_ACTOR_KEY],
          });
        }
      };

      // ── 1. adopt what earlier slices started ─────────────────────────────
      for (const p of ctx.pending.filter((x) => x.verifier === FUNDING_STAGE_VERIFIER_KEY && x.stage === "pvalyou")) {
        await runPvalyou(p.carry as unknown as PvalyouCarry, p);
      }
      for (const p of ctx.pending.filter((x) => x.verifier === FUNDING_STAGE_VERIFIER_KEY && x.stage === "pvalyou_recency")) {
        await runRecencyFallback(p.carry as unknown as PvalyouCarry, p);
      }
      // …and the steps a stopped slice deferred: asked now, from what it bought.
      for (const p of ctx.pending.filter((x) => x.verifier === FUNDING_STAGE_VERIFIER_KEY && x.deferred)) {
        const carry = p.carry as unknown as PvalyouCarry | undefined;
        if (!carry?.targets?.length) continue;
        if (p.stage === DEFERRED_PVALYOU_STAGE) await runPvalyou(carry);
        else if (p.stage === DEFERRED_PVALYOU_RECENCY_STAGE) await runRecencyFallback(carry);
      }
      const inFlight = new Set(ctx.pending.flatMap((p) => p.candidate_keys));
      const fresh = targets.filter((t) => !inFlight.has(t.company_key));
      if (fresh.length === 0) return { findings, pending };

      // ── 2. atomus, one batch, for every target with a LinkedIn page ──────
      const atomusRecords: Record<string, FundingRecordFact | null> = {};
      let atomusCallId: string | null = null;
      /**
       * Companies Atomus has answered for — this call, or an earlier read the
       * graph holds. A refused or failed call is not an answer to fall back from.
       */
      const atomusAnswered = new Set<string>();
      // ── AN ATOMUS RECORD ALREADY HELD IS NOT RE-BOUGHT ─────────────────
      //
      // The funding SCREEN reads the whole pool with Atomus before admission;
      // an admitted company reaches this verifier holding that record, through
      // the Pvalyou fallback route. Its Atomus reading is the one the screen
      // bought, and the fallback decision is made from it.
      for (const t of fresh) {
        const held = heldAtomusOf(t);
        if (!held) continue;
        atomusRecords[t.company_key] = held;
        atomusAnswered.add(t.company_key);
      }
      const byPage = fresh.filter((t) => !atomusAnswered.has(t.company_key))
        .map((t) => ({ t, page: atomusInput(t.linkedin_url) }));
      const withPage = byPage.filter((x) => x.page);
      if (withPage.length > 0 && deps.ready(ATOMUS_FUNDING_ACTOR_KEY)) {
        const out = await deps.call({
          actor_key: ATOMUS_FUNDING_ACTOR_KEY, capability: FUNDING_VERIFICATION_CAPABILITY, purpose: "funding_evidence",
          input: { companies: withPage.map((x) => x.page!) },
          candidate_keys: withPage.map((x) => x.t.company_key),
        });
        if (out.status === "ok") {
          atomusCallId = out.provider_call_id;
          for (const { t } of withPage) atomusAnswered.add(t.company_key);
          const reads = out.rows.map(normalizeAtomusFunding);
          for (const { t, page } of withPage) {
            const want = slugOf(page);
            const r = reads.find((x) => slugOf(x.input) === want || slugOf(x.linkedin_url) === want) ?? null;
            // The call is written on the record, so it survives the merge.
            atomusRecords[t.company_key] = r?.record ? stampFundingCall(r.record, atomusCallId) : null;
          }
        } else if (out.status === "deferred") {
          // Nothing bought, nothing answered: every fresh company stays open.
          deps.log("funding_verifier_deferred", { stage: "atomus", companies: withPage.length, reason: out.reason });
          return { findings, pending };
        } else {
          deps.log("funding_verifier_atomus_unavailable", { status: out.status, reason: (out as { reason?: string }).reason });
        }
      }

      // ── 3. what atomus settles alone, or with what discovery carried ─────
      const needCitation: VerificationTarget[] = [];
      const discovered: Record<string, FundingRecordFact[]> = {};
      const recencyFallback: VerificationTarget[] = [];
      const recencyInputs: Record<string, string> = {};
      for (const t of fresh) {
        const atomus = atomusRecords[t.company_key] ?? null;
        // ── A RECENCY GAP NEEDS THE DATED HISTORY, NOT A STAGE VERDICT ──────
        //
        // "Raised funding in the last N years" is `recently_funded`, decided by
        // eligibility from a funding RECORD: a dated verified round inside the
        // window passes, and a COMPLETE history with none fails. atomus holds
        // both — dates and the true round count — so its record is the whole
        // answer. Running the stage logic here read the signal object as a
        // required stage ("[object Object]" is not a funding round) and bought
        // pvalyou's citations (~$0.02 a company), which recency never uses.
        // No atomus record (no LinkedIn page, not found, or refused) leaves the
        // claim PENDING: absence is never disproof.
        if (t.criterion.dimension === "funding") {
          // ── THE NARROW PVALYOU FALLBACK ──────────────────────────────────
          //
          // Atomus is the PRIMARY recency verifier. Pvalyou is asked ONCE, and
          // only when every one of these holds:
          //   the claim is HARD and the candidate viable — the only targets the
          //     gap router ever hands a verifier;
          //   atomus RAN (a refused or failed call is not an answer);
          //   atomus was NOT decisive: no verified dated round inside the window
          //     and no complete history — `decideRecentlyFunded` still PENDING;
          //   Pvalyou has not already answered for this company;
          //   there is a key it can be asked by, and the route is READY.
          // Canaries 1156c062 and 5bfa76db: Atomus found How to AI, BigRio and
          // Design Milk and returned zero rounds, so recency stayed PENDING and
          // every later verifier was (correctly) never bought.
          const known = [...discoveredOf(t), ...(atomus ? [atomus] : [])];
          // DECISIVE = a verdict under the claim's window. Without a window the
          // claim is PRESENCE (RC05): decided once a cited qualifying round is
          // held or a complete history rules one out (`decideHasRaised`).
          const window = t.criterion.window_days ?? null;
          const openAfterAtomus = window != null
            ? decideRecentlyFunded({ window_days: window, records: known, now: at, kind: fundingKindOf(t.criterion.value) }).verdict === "pending"
            : decideHasRaised({ records: known, ...fundingPresenceOf(t.criterion.value) }).verdict === "pending";
          const pvalyouAnswered = known.some((r) => r.actor === PVALYOU_FUNDING_ACTOR_KEY);
          const key = t.domain ?? t.linkedin_url;
          if (fallbackOn && atomusAnswered.has(t.company_key) && openAfterAtomus && !pvalyouAnswered && key &&
            deps.ready(PVALYOU_FUNDING_ACTOR_KEY)) {
            recencyFallback.push(t);
            recencyInputs[t.company_key] = key;
            continue;
          }
          findings.push(recencyFinding(t, atomus, atomus ? (atomus.provider_call_id ?? atomusCallId) : null, null, "atomus_recency"));
          continue;
        }
        discovered[t.company_key] = discoveredOf(t);
        const failed = atomusSettles(stageRequirement(t.criterion), atomus);
        if (failed) {
          findings.push(finding(t, failed, atomus, {
            mission_id: ctx.mission_id, provider_call_id: atomusCallId, at, stage: "atomus_later_round",
          }));
          continue;
        }
        // NOT RE-BOUGHT: a discovered round that cites the decisive round —
        // or cites a later one — decides the claim without pvalyou.
        if (atomus && discovered[t.company_key].length > 0) {
          const { decision, corroboration } = decideCorroboratedFundingStage({
            required_stage: stageRequirement(t.criterion), atomus, pvalyou: null, discovered: discovered[t.company_key],
          });
          if (decision.verdict !== "pending") {
            findings.push(finding(t, decision, corroboration.record, {
              mission_id: ctx.mission_id, provider_call_id: atomusCallId, at, stage: "atomus_with_discovery",
              conflicts: corroboration.conflicts,
            }));
            continue;
          }
        }
        needCitation.push(t);
      }

      // ── 3b. the recency fallback, batched like the stage citation ──────────
      for (const group of batches(recencyFallback, PVALYOU_BATCH)) {
        await runRecencyFallback({ targets: group, atomus: atomusRecords, inputs: recencyInputs, atomus_call_id: atomusCallId });
      }

      // ── 4. pvalyou cites, for Seed / pre-seed / unclear ──────────────────
      const inputs: Record<string, string> = {};
      for (const t of needCitation) {
        const key = t.domain ?? t.linkedin_url;
        if (key) inputs[t.company_key] = key;
      }
      const citable = needCitation.filter((t) => inputs[t.company_key]);
      const uncitable = needCitation.filter((t) => !inputs[t.company_key]);
      if (uncitable.length > 0 || (citable.length > 0 && !deps.ready(PVALYOU_FUNDING_ACTOR_KEY))) {
        // Nothing can cite these this mission: decide on atomus alone (PENDING at best).
        settleWithPvalyou({
          targets: deps.ready(PVALYOU_FUNDING_ACTOR_KEY) ? uncitable : needCitation,
          atomus: atomusRecords, inputs, atomus_call_id: atomusCallId, discovered,
        }, null, null);
      }
      if (deps.ready(PVALYOU_FUNDING_ACTOR_KEY)) {
        for (const group of batches(citable, PVALYOU_BATCH)) {
          await runPvalyou({ targets: group, atomus: atomusRecords, inputs, atomus_call_id: atomusCallId, discovered });
        }
      }
      return { findings, pending };
    },
  };
}
