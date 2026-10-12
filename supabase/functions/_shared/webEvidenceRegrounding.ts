// LEAD V2 P5 PHASE C — THE PAGES WE BOUGHT MUST RESOLVE THE CLAIM WE BOUGHT THEM FOR.
//
// Canary c5e281c9 fetched Dioptra's /product, /customers and /pricing, stored
// them, spent $0.0256 — and still reported `business_model` PENDING with "the
// quote does not state saas delivery". The pages reached only the legacy
// mission re-evaluation. The canonical claim was decided once, during
// qualification, from the registry as it stood BEFORE those pages existed, and
// nothing ever asked the grounder to read them.
//
// So the route that the evidence-gap router exists to choose could never close
// the gap it was chosen for, `with_executable_route` stayed 0, and continuation
// — correctly, given its inputs — widened discovery instead. Four more
// job-search pages, five slices, nothing qualified.
//
// This module is the missing executor:
//
//   pending claim → pages → rebuild registry → re-ground → re-decide → item
//
// WHAT IT WILL NOT DO.
//
//   * It never re-grounds a claim that is not pending. A PASS or a verified
//     FAIL is an answer; re-reading it would only risk unsettling it.
//   * It never re-grounds on evidence the current reading already saw. Same
//     pages ⇒ same answer, so the model call is skipped, not spent.
//   * It never decides anything itself. The grounder reads, `businessModelDecision`
//     judges, and the engine's `applyRegroundedVerification` writes.
//   * It never throws into the run. A failed re-grounding leaves the claim
//     exactly as pending as it was.
//
// Deps are injected, so this is testable without a provider, a model or a
// database.

import type { GroundedVerification } from "./groundedClaims.ts";

export const WEB_EVIDENCE_REGROUNDING_VERSION = "web-evidence-regrounding-v1" as const;

/** A page already fetched and stored for this company. */
export interface RegroundPage {
  source_url: string;
  page_intent: string;
  source_text: string;
  fetched_at: string | null;
}

export interface RegroundCandidate {
  company_key: string;
  /** True when the canonical business-model claim is still PENDING for this company. */
  business_model_pending: boolean;
  /**
   * Source urls the CURRENT grounding was read from. A page outside this set is
   * new evidence and is worth a second reading; a page inside it is not.
   */
  grounded_source_urls: readonly string[];
}

export interface RegroundDeps {
  /** Fresh first-party pages held for this company. */
  pagesFor: (company_key: string) => Promise<readonly RegroundPage[]>;
  /** The engine's own registry builder, with the pages folded in. */
  rebuildRegistry: (company_key: string, pages: readonly RegroundPage[]) => unknown | null;
  /** The grounder. Null when it is unavailable — then nothing is re-grounded. */
  ground:
    | ((i: { registry: unknown; requiresCommercialSignal: boolean; company_key: string })
      => Promise<GroundedVerification | null>)
    | null;
  /**
   * The engine writes the result: `applyRegroundedVerification`. `registry` is
   * the one the verification was grounded against, so the claim can name the
   * page its quote came from.
   */
  apply: (company_key: string, verification: GroundedVerification, registry: unknown)
    => { item: { status: string } | null; decision: string | null };
  log?: (event: string, meta?: Record<string, unknown>) => void;
}

export interface RegroundOutcome {
  company_key: string;
  /** Why nothing happened, when nothing happened. */
  skipped: "not_pending" | "no_pages" | "no_new_pages" | "no_grounder" | "no_registry" | "ground_failed" | null;
  pages_read: number;
  new_pages: number;
  decision: string | null;
  /** The claim's status after the re-grounding: proven | plausible | disproven. */
  status: string | null;
}

export interface RegroundReport {
  version: typeof WEB_EVIDENCE_REGROUNDING_VERSION;
  considered: number;
  regrounded: number;
  /** Claims the re-reading turned into proof. */
  resolved: number;
  /** Claims a verified contradiction turned into a FAIL. */
  contradicted: number;
  /** Re-read and still ambiguous — PENDING is the honest answer. */
  still_pending: number;
  outcomes: RegroundOutcome[];
}

/** How many companies one slice re-grounds. One model call each. */
export const MAX_REGROUNDED_PER_SLICE = 8;

/**
 * Re-ground pending business-model claims on the pages the verification route
 * bought. Returns what happened, per company, for the trace.
 */
export async function regroundPendingClaims(i: {
  candidates: readonly RegroundCandidate[];
  requiresCommercialSignal: boolean;
  deps: RegroundDeps;
  limit?: number;
}): Promise<RegroundReport> {
  const log = i.deps.log ?? (() => {});
  const report: RegroundReport = {
    version: WEB_EVIDENCE_REGROUNDING_VERSION,
    considered: 0, regrounded: 0, resolved: 0, contradicted: 0, still_pending: 0, outcomes: [],
  };
  const pending = i.candidates.filter((c) => c.business_model_pending);
  const budget = Math.max(0, i.limit ?? MAX_REGROUNDED_PER_SLICE);

  for (const c of pending) {
    if (report.regrounded >= budget) break;
    report.considered++;
    const outcome: RegroundOutcome = {
      company_key: c.company_key, skipped: null, pages_read: 0, new_pages: 0, decision: null, status: null,
    };
    try {
      if (!i.deps.ground) { outcome.skipped = "no_grounder"; report.outcomes.push(outcome); continue; }
      const pages = (await i.deps.pagesFor(c.company_key)).filter((p) => (p.source_text ?? "").trim().length > 0);
      outcome.pages_read = pages.length;
      if (pages.length === 0) { outcome.skipped = "no_pages"; report.outcomes.push(outcome); continue; }

      // NEW EVIDENCE OR NOTHING. Re-reading the same pages buys the same answer
      // at the price of a model call.
      const seen = new Set(c.grounded_source_urls);
      outcome.new_pages = pages.filter((p) => !seen.has(p.source_url)).length;
      if (outcome.new_pages === 0) { outcome.skipped = "no_new_pages"; report.outcomes.push(outcome); continue; }

      const registry = i.deps.rebuildRegistry(c.company_key, pages);
      if (!registry) { outcome.skipped = "no_registry"; report.outcomes.push(outcome); continue; }

      const verification = await i.deps.ground({
        registry, requiresCommercialSignal: i.requiresCommercialSignal, company_key: c.company_key,
      });
      if (!verification) { outcome.skipped = "ground_failed"; report.outcomes.push(outcome); continue; }

      const applied = i.deps.apply(c.company_key, verification, registry);
      report.regrounded++;
      outcome.decision = applied.decision;
      outcome.status = applied.item?.status ?? null;
      if (outcome.status === "proven") report.resolved++;
      else if (outcome.status === "disproven") report.contradicted++;
      else report.still_pending++;
      log("web_evidence_regrounded", {
        company_key: c.company_key, pages: pages.length, new_pages: outcome.new_pages,
        decision: outcome.decision, status: outcome.status,
      });
    } catch (e) {
      // A FAILED RE-READING IS NOT A VERDICT. The claim stays pending.
      outcome.skipped = "ground_failed";
      log("web_evidence_regrounding_failed", { company_key: c.company_key, error: String(e).slice(0, 200) });
    }
    report.outcomes.push(outcome);
  }
  return report;
}
