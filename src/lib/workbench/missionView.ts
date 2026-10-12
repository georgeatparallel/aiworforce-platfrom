// THE CANONICAL LEAD V2 DECISION, AS THE UI READS IT.
//
// The backend writes `tasks.result.workbench_mission_view` — one projection
// over canonical company state that owns every Lead V2 number: which companies
// are surfaced (EXACT MATCH … LOW PRIORITY), pending, ineligible, screened out
// or still being worked, each with its hard checks and the evidence behind
// them. The UI renders that decision. It never re-qualifies a company.
//
// Legacy runs carry no view; every reader here returns null for them and the
// callers fall back to exactly what they did before.
//
// Pure.

export type CanonicalBucket =
  | 'screened_out' | 'identity_unresolved' | 'investigating' | 'ineligible' | 'pending'
  | 'exact_match' | 'strong_opportunity' | 'worth_considering' | 'low_priority';

export type CanonicalCheckResult = 'pass' | 'fail' | 'unknown';

export interface CanonicalCheckProvenance {
  evidence_id: string;
  dimension: string;
  status: string;
  method: string;
  confidence: string;
  actor: string;
  grounding_decision: string | null;
  business_model_decision: string | null;
  url: string | null;
  excerpt: string | null;
}

export interface CanonicalHardCheck {
  criterion_id: string;
  dimension: string;
  result: CanonicalCheckResult;
  reason: string;
  provenance: CanonicalCheckProvenance | null;
}

/** One unknown hard check on a pending lead, and what could close it (`evidenceGapRouter`). */
export interface CanonicalEvidenceGap {
  dimension: string;
  claim: string | null;
  next: 'verify' | 'blocked';
  /** What the next route reads, when there is one. */
  route: string | null;
  /** Why each considered route cannot be taken, when blocked. */
  blocked_by: string[];
}

export interface CanonicalLead {
  company: { key: string; name: string | null; domain: string | null; linkedin_url: string | null };
  label: string | null;
  bucket: CanonicalBucket;
  found_by: string[];
  hard_checks: Record<string, CanonicalCheckResult>;
  hard_check_details: CanonicalHardCheck[];
  why_surfaced: Array<{ text: string; evidence_ids: string[] }>;
  key_evidence: Array<{ dimension: string; value: unknown; status: string; sources: string[]; evidence_id: string | null }>;
  missing_evidence: string[];
  caveats: string[];
  evidence_coverage: number;
  evidence_gaps: CanonicalEvidenceGap[];
  /**
   * Pending leads only: `verifying` while every unknown hard check still has a
   * route; `unverifiable` when nothing more will be tried this run. Null for
   * every other bucket, and on views written before the field existed.
   */
  pending_state: 'verifying' | 'unverifiable' | null;
}

export interface CanonicalCounts {
  discovered: number; screened_out: number; investigating: number; identity_unresolved: number;
  pending: number; exact_match: number; strong_opportunity: number; worth_considering: number;
  low_priority: number; ineligible: number;
}

export interface CanonicalMissionView {
  version: string;
  stage: string;
  counts: CanonicalCounts;
  /** Pending leads nothing more will be tried for — a subset of `counts.pending`, never a bucket. */
  pending_unverifiable: number;
  leads: CanonicalLead[];
}

export const LABEL_BUCKETS: ReadonlySet<CanonicalBucket> = new Set<CanonicalBucket>([
  'exact_match', 'strong_opportunity', 'worth_considering', 'low_priority',
]);

const BUCKETS: ReadonlySet<string> = new Set<string>([
  'screened_out', 'identity_unresolved', 'investigating', 'ineligible', 'pending',
  'exact_match', 'strong_opportunity', 'worth_considering', 'low_priority',
]);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function readCheck(v: unknown): CanonicalHardCheck | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const result = r.result === 'pass' || r.result === 'fail' ? r.result : 'unknown';
  const p = r.provenance && typeof r.provenance === 'object' ? r.provenance as Record<string, unknown> : null;
  return {
    criterion_id: String(r.criterion_id ?? ''),
    dimension: String(r.dimension ?? ''),
    result,
    reason: String(r.reason ?? ''),
    provenance: p
      ? {
        evidence_id: String(p.evidence_id ?? ''), dimension: String(p.dimension ?? ''),
        status: String(p.status ?? ''), method: String(p.method ?? ''),
        confidence: String(p.confidence ?? ''), actor: String(p.actor ?? ''),
        grounding_decision: str(p.grounding_decision), business_model_decision: str(p.business_model_decision),
        url: str(p.url), excerpt: str(p.excerpt),
      }
      : null,
  };
}

/** The canonical view on a task result, or null (legacy run, or malformed). */
export function readMissionView(result: unknown): CanonicalMissionView | null {
  if (!result || typeof result !== 'object') return null;
  const v = (result as { workbench_mission_view?: unknown }).workbench_mission_view;
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const c = (r.counts && typeof r.counts === 'object' ? r.counts : null) as Record<string, unknown> | null;
  if (!c || !Array.isArray(r.leads)) return null;
  const counts: CanonicalCounts = {
    discovered: num(c.discovered), screened_out: num(c.screened_out), investigating: num(c.investigating),
    identity_unresolved: num(c.identity_unresolved), pending: num(c.pending), exact_match: num(c.exact_match),
    strong_opportunity: num(c.strong_opportunity), worth_considering: num(c.worth_considering),
    low_priority: num(c.low_priority), ineligible: num(c.ineligible),
  };
  const leads: CanonicalLead[] = (r.leads as unknown[])
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && BUCKETS.has(String((l as Record<string, unknown>).bucket)))
    .map((l) => {
      const co = (l.company && typeof l.company === 'object' ? l.company : {}) as Record<string, unknown>;
      const checks = Array.isArray(l.hard_check_details) ? l.hard_check_details.map(readCheck).filter((x): x is CanonicalHardCheck => !!x) : [];
      return {
        company: { key: String(co.key ?? ''), name: str(co.name), domain: str(co.domain), linkedin_url: str(co.linkedin_url) },
        label: str(l.label),
        bucket: String(l.bucket) as CanonicalBucket,
        found_by: strArr(l.found_by),
        hard_checks: (l.hard_checks && typeof l.hard_checks === 'object' ? l.hard_checks : {}) as Record<string, CanonicalCheckResult>,
        hard_check_details: checks,
        why_surfaced: Array.isArray(l.why_surfaced)
          ? (l.why_surfaced as Array<Record<string, unknown>>).map((w) => ({ text: String(w?.text ?? ''), evidence_ids: strArr(w?.evidence_ids) }))
          : [],
        key_evidence: Array.isArray(l.key_evidence) ? l.key_evidence as CanonicalLead['key_evidence'] : [],
        missing_evidence: strArr(l.missing_evidence),
        caveats: strArr(l.caveats),
        evidence_coverage: num(l.evidence_coverage),
        evidence_gaps: Array.isArray(l.evidence_gaps)
          ? (l.evidence_gaps as Array<Record<string, unknown>>).filter((g) => !!g && typeof g === 'object').map((g) => {
            const route = g.route && typeof g.route === 'object' ? g.route as Record<string, unknown> : null;
            const considered = Array.isArray(g.considered) ? g.considered as Array<Record<string, unknown>> : [];
            return {
              dimension: String(g.dimension ?? ''),
              claim: str(g.claim),
              next: g.next === 'verify' ? 'verify' as const : 'blocked' as const,
              route: route ? str(route.purpose) : null,
              blocked_by: considered.map((r) => `${String(r.purpose ?? r.actor ?? '')}: ${String(r.why ?? '')}`),
            };
          })
          : [],
        pending_state: l.pending_state === 'verifying' || l.pending_state === 'unverifiable' ? l.pending_state : null,
      };
    });
  return {
    version: String(r.version ?? ''), stage: String(r.stage ?? ''), counts,
    pending_unverifiable: Math.min(num(r.pending_unverifiable), counts.pending), leads,
  };
}

/** The numbers the Workbench header shows, straight from the canonical counts. */
export function canonicalSummary(c: CanonicalCounts): {
  discovered: number; qualified: number; pending: number; ineligible: number;
  screenedOut: number; undecided: number;
} {
  return {
    discovered: c.discovered,
    qualified: c.exact_match + c.strong_opportunity + c.worth_considering + c.low_priority,
    pending: c.pending,
    ineligible: c.ineligible,
    screenedOut: c.screened_out,
    undecided: c.investigating + c.identity_unresolved,
  };
}

/** A hard check, in one line a person can read, with where its evidence came from. */
export function describeHardCheck(h: CanonicalHardCheck): string {
  const verdict = h.result === 'pass' ? 'PASS' : h.result === 'fail' ? 'FAIL' : 'PENDING';
  const p = h.provenance;
  const source = p
    ? [p.status, p.method.replace(/_/g, ' '), p.confidence ? `${p.confidence} confidence` : null, p.actor.replace(/_/g, ' '),
      p.grounding_decision ? `grounding ${p.grounding_decision}` : null,
      p.business_model_decision ? `business model ${p.business_model_decision}` : null]
      .filter(Boolean).join(' · ')
    : 'no evidence';
  return `${verdict} — ${h.reason} (${source})`;
}
