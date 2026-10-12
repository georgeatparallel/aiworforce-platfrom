// LEAD V2 P1 — CANONICAL SIGNAL KINDS, ONE ALIAS MODULE, NO RENAMES.
//
// The lead path already speaks several vocabularies for the same facts:
// `MissionSignal.type`, `SIGNAL_EVENTS`, capability ids, actor evidence
// events, playbooks and Signals V2 types. None of them is renamed here. This
// module maps each onto one of nine canonical kinds
// (`LEAD_V2_SIGNAL_FIRST_FINAL_IMPLEMENTATION_PLAN.md`, "Canonical Signal
// Vocabulary") and reads the USER'S OWN WORDS into those kinds.
//
// ── WHY THE USER'S WORDS, AND NOT THE MODEL'S PROSE ─────────────────────────
//
// Live task fd27bfac's sibling card compiled "Find 5 companies that just hired
// a new VP of Sales" into `required_signals: [{ type: "hiring", phrase: "hiring
// VP of Sales" }]`. The model rephrased the request; `readSignalPhrases` read
// the rephrasing; the leadership change became an open-role search. The shared
// reader, run on the sentence the user typed, already said `leadership_change`
// — it simply was never asked. Code owns the canonical meaning (locked rule 2);
// the model's prose is a proposal.
//
// ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
//
// It never selects an actor, capability or route (locked rule 1). It produces
// readings; `missionCriteria.ts` decides what a reading means for the mission.
//
// Pure. No network, no model, no database.

import {
  describeSignal, OPEN_ROLES_RE, POSTED_JOBS_RE, readSignalPhrase, readSignalsFromQuery,
  type MissionSignalDescriptor, type SignalEvent, type SignalQualifier, type SignalSubject,
} from "./missionSignalDescriptor.ts";

export const SIGNAL_KINDS_VERSION = "signal-kinds-v1" as const;

export const CANONICAL_SIGNAL_KINDS = [
  "hiring", "funding", "product_launch", "expansion", "headcount_growth",
  "leadership_change", "technology", "social_activity", "company_profile",
] as const;
export type CanonicalSignalKind = typeof CANONICAL_SIGNAL_KINDS[number];

/** Existing event names → canonical kind. The events keep their names. */
const EVENT_KIND: Readonly<Record<SignalEvent, CanonicalSignalKind>> = Object.freeze({
  hiring: "hiring",
  funding: "funding",
  expansion: "expansion",
  product_launch: "product_launch",
  technology: "technology",
  leadership_change: "leadership_change",
  post: "social_activity",
  comment: "social_activity",
  headcount_change: "headcount_growth",
});

export function kindForEvent(event: string | null | undefined): CanonicalSignalKind | null {
  return (EVENT_KIND as Record<string, CanonicalSignalKind>)[String(event ?? "").trim()] ?? null;
}

/** The carrier event a kind is written as on `required_signals`. */
export function legacyEventForKind(kind: CanonicalSignalKind): SignalEvent | null {
  switch (kind) {
    case "headcount_growth": return "headcount_change";
    case "social_activity": return "post";
    case "company_profile": return null;
    default: return kind;
  }
}

// ── TIME WINDOWS ────────────────────────────────────────────────────────────

export type WindowBasis = "posted" | "announced" | "observed" | "published";

export interface SignalWindowDefault {
  days: number;
  basis: WindowBasis;
  /** The phrase class the default is for, shown on the card. */
  rule: string;
}

/**
 * System defaults from the plan's time-window table. `social_activity` is not
 * in that table; 90 days is a P1 default for "recent" social activity and is
 * shown as a default like every other.
 */
export const DEFAULT_SIGNAL_WINDOWS: Readonly<Partial<Record<CanonicalSignalKind, SignalWindowDefault>>> =
  Object.freeze({
    hiring: { days: 30, basis: "posted", rule: "currently / actively hiring" },
    funding: { days: 180, basis: "announced", rule: "recently funded / raised" },
    product_launch: { days: 90, basis: "published", rule: "recently launched" },
    expansion: { days: 180, basis: "published", rule: "recently expanded / opened an office" },
    leadership_change: { days: 120, basis: "observed", rule: "recently hired / appointed an executive" },
    headcount_growth: { days: 180, basis: "observed", rule: "growing headcount" },
    social_activity: { days: 90, basis: "published", rule: "recent social activity" },
  });

/**
 * A window the user stated in words: "in the last 60 days", "past 6 months",
 * "within the last year". Null when none is stated — a bare "recently" is not
 * a window. Returned in CANONICAL days (`canonicalWindowDays`), so "12 months",
 * "1 year" and "365 days" are the same number.
 */
export function explicitWindowDays(text: string): number | null {
  return explicitWindowMatch(text)?.days ?? null;
}

// A COUNT WRITTEN IN WORDS IS THE SAME COUNT (Wave 3). "in the last two years"
// read as no window at all, so a stated funding window compiled as a soft
// target and an unfunded company qualified, while "in the last 2 years" was a
// hard requirement. Cardinals only: "few", "several" and "couple" name no number
// and stay windowless.
const UNITS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries([
  ["a", 1], ...UNITS.map((w, i) => [w, i + 1]), ...TEENS.map((w, i) => [w, i + 10]), ...TENS.map((w, i) => [w, (i + 2) * 10]),
]));
const COUNT_SRC = `\\d{1,3}|(?:${TENS.join("|")})[-\\s](?:${UNITS.join("|")})|${[...TEENS, ...TENS, ...UNITS, "a"].join("|")}`;
const WINDOW_RE = new RegExp(`\\b(?:in|within|over|during)?\\s*the\\s+(?:last|past)\\s+(?:(${COUNT_SRC})\\s*)?(day|week|month|year)s?\\b`, "g");

function countOf(word: string | undefined): number {
  if (word === undefined) return 1;
  if (/^\d+$/.test(word)) return Number(word);
  const [tens, unit] = word.split(/[-\s]/);
  return (NUMBER_WORDS[tens] ?? 0) + (unit ? NUMBER_WORDS[unit] ?? 0 : 0);
}

// A WINDOW ON THE COMPANY'S AGE IS NOT A SIGNAL'S. "founded in the last 3
// years that raised funding" dates the company; handed to the nearest signal it
// became a hard 1,095-day funding window (A2), and "founded in the last 5 years
// that are hiring sales" let a five-year-old posting prove "hiring".
const COMPANY_AGE_RE = /\b(?:founded|established|incorporated|formed)\s*$/;

/** Every stated window in the text, in order, and whether it dates the company itself. */
function* statedWindows(text: string): Generator<{ days: number; index: number; end: number; company_age: boolean }> {
  const t = String(text ?? "").toLowerCase();
  for (const m of t.matchAll(WINDOW_RE)) {
    const n = countOf(m[1]);
    const per: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    const unit = m[2];
    // Whole years are years however they were said ("12 months", "24 months").
    const raw = unit === "month" && n > 0 && n % 12 === 0 ? (n / 12) * 365 : n * (per[unit] ?? 1);
    if (!(raw > 0)) continue;
    yield {
      days: unit === "month" && n % 12 === 0 ? raw : canonicalWindowDays(raw), index: m.index!, end: m.index! + m[0].length,
      company_age: COMPANY_AGE_RE.test(t.slice(0, m.index)),
    };
  }
}

/** The first stated window, with WHERE it sits in the text — so it can be given to the signal it belongs to (RC06). */
export function explicitWindowMatch(text: string): { days: number; index: number; end: number } | null {
  for (const w of statedWindows(text)) if (!w.company_age) return { days: w.days, index: w.index, end: w.end };
  return null;
}

/** The window the text states for the company's own age ("founded in the last 3 years"), or null. */
export function companyAgeWindowDays(text: string): number | null {
  for (const w of statedWindows(text)) if (w.company_age) return w.days;
  return null;
}

/**
 * ONE REPRESENTATION FOR A TIME WINDOW.
 *
 * Two compilers that read the same words can carry different integers: "12
 * months" as 360 (30-day months) or 365, "6 months" as 180 or 183, "2 years" as
 * 720 or 730. Whether a funding window is a HARD requirement used to hang on
 * `days === explicitWindowDays(query)`, so the same sentence could flip between
 * hard and soft on a rounding choice. A window is compared here as the calendar
 * span it names, never as a raw integer:
 *
 *   within ~1.5% of a whole number of YEARS   → that many years × 365
 *   within ~3 days of a whole number of MONTHS → that many months × 30
 *   anything else                              → the days themselves
 *
 * Months keep the 30-day convention the rest of the system already uses (a
 * stated "6 months" has always been 180), so only whole years change value.
 */
export function canonicalWindowDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return days;
  const years = Math.round(days / 365);
  if (years >= 1 && Math.abs(days - years * 365) <= Math.max(5, years * 6)) return years * 365;
  const months = Math.round(days / 30.4375);
  if (months >= 1 && months < 12 && Math.abs(days - months * 30.4375) <= 3) return months * 30;
  return Math.round(days);
}

/** Do two windows name the same calendar span? */
export function sameWindow(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return canonicalWindowDays(a) === canonicalWindowDays(b);
}

// ── ALIASES THE SHARED READER DOES NOT COVER ────────────────────────────────

/** Executive titles. A past hire of one of these is a leadership change. */
const EXEC_TITLE =
  String.raw`(?:(?:vp|vice[- ]president|svp|evp)(?:\s+(?:of\s+)?(?:sales|marketing|engineering|product|growth|revenue|operations|finance|people|hr|talent|customer success|partnerships|business development))?|chief\s+[a-z]+(?:\s+[a-z]+)?\s+officer|c[efmortix]o|head of\s+[a-z]+(?:\s+[a-z]+)?|president|general manager|director of\s+[a-z]+)`;
export const EXEC_TITLE_RE = new RegExp(String.raw`\b${EXEC_TITLE}\b`, "i");

const OPEN_ROLE_VERB = /\b(?:hiring|recruiting|looking for|seeking|searching for|to hire|open role|job opening)\b/i;

/**
 * Hiring words that are really an INDUSTRY noun: "recruiting agency",
 * "staffing firm". The shared reader's hiring marker matches `recruit\w*`, so
 * persona-01 ("Find 5 recruiting Agency in B2B…") read as a hiring signal.
 */
const HIRING_INDUSTRY_NOUN =
  /\b(?:recruit\w*|staffing|talent acquisition|headhunting|hiring)\s+(?:agenc\w*|firms?|compan\w*|platforms?|software|industry|businesses|services?|partners?|marketplaces?|tools?)\b/gi;
const REAL_HIRING_CUE = new RegExp(
  String.raw`\bhiring\b|\brecruit(?:ing|s|ed)?\b|\bopen roles?\b|\bjob (?:postings?|openings?)\b|\bhires?\b|\bsellers?\b|` +
  `${OPEN_ROLES_RE.source}|${POSTED_JOBS_RE.source}`, "i");

interface AliasRule { re: RegExp; kind: CanonicalSignalKind; subkind?: string; name: string }

const ALIAS_RULES: readonly AliasRule[] = Object.freeze([
  // LEADERSHIP — a past appointment of an executive. "hiring a VP" is an open
  // role and stays hiring; "just hired a VP" / "new CRO" is a change.
  { kind: "leadership_change", name: "past_executive_hire", re: new RegExp(
    String.raw`\b(?:just|recently|newly|lately)?\s*(?:hired|appointed|named|brought on|onboarded|welcomed|promoted|poached)\s+(?:a|an|their|its|the)?\s*(?:new\s+)?${EXEC_TITLE}\b`, "i") },
  { kind: "leadership_change", name: "new_executive", re: new RegExp(
    String.raw`\bnew(?:ly appointed)?\s+${EXEC_TITLE}\b`, "i") },
  { kind: "leadership_change", name: "leadership_change", re:
    /\b(?:leadership|executive|c-suite)\s+(?:change|changes|transition|turnover|shake-?up|hires?|appointments?)\b/i },
  // HEADCOUNT — before expansion, so "expanding headcount" is not a market move.
  { kind: "headcount_growth", name: "headcount_growth", re:
    /\b(?:rapidly|fast|quickly|aggressively)?\s*(?:growing|expanding|scaling|increasing)\s+(?:their\s+|its\s+|the\s+)?(?:headcount|team|teams|workforce|employee count)\b|\bheadcount (?:growth|increase|expansion)\b|\bhiring spree\b/i },
  // EXPANSION — a new physical presence.
  { kind: "expansion", subkind: "geographic_expansion", name: "new_office", re:
    /\b(?:opened|opening|opens|launched|launching|set up|setting up|established|establishing)\s+(?:a\s+|an\s+|their\s+|its\s+|the\s+)?(?:new\s+|second\s+|first\s+)?(?:[a-z]+\s+)?(?:office|offices|location|locations|hq|headquarters|hub|branch)\b|\bnew\s+(?:[a-z]+\s+)?(?:office|offices|hq|headquarters|hub|branch)\b/i },
  { kind: "expansion", subkind: "market_expansion", name: "entering_market", re:
    /\b(?:entering|entered)\s+(?:the\s+)?(?:[a-z]+\s+){0,2}market\b/i },
  // SOCIAL — activity on LinkedIn or social media. Company by default.
  { kind: "social_activity", name: "social_activity", re:
    /\b(?:strong|high|active|heavy|growing|rising|recent|regular|frequent|consistent)\s+(?:[a-z]+\s+){0,2}(?:linkedin|social(?:\s+media)?|twitter)\s+(?:activity|presence|engagement|posting|posts)\b|\b(?:linkedin|social(?:\s+media)?)\s+(?:activity|presence|engagement|posting)\b|\bactive on (?:linkedin|social(?:\s+media)?|twitter)\b|\bposting (?:regularly|frequently|a lot|often)\b/i },
]);

export interface CanonicalSignalReading {
  kind: CanonicalSignalKind;
  subkind?: string;
  /** How the kind is carried on `required_signals`. */
  event: SignalEvent;
  subject: SignalSubject;
  qualifier: SignalQualifier;
  /** The user's words that produced it. */
  phrase: string;
  /** "reader" (shared missionSignalDescriptor reader) or the alias rule name. */
  alias: string;
}

function matchAlias(text: string, kind: CanonicalSignalKind): { rule: AliasRule; match: string } | null {
  for (const rule of ALIAS_RULES) {
    if (rule.kind !== kind) continue;
    const m = rule.re.exec(text);
    if (!m) continue;
    const phrase = m[0].trim();
    // "hiring a new VP of Sales" is an open role, not an appointment.
    if (rule.name === "new_executive") {
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (OPEN_ROLE_VERB.test(before)) continue;
    }
    return { rule, match: phrase };
  }
  return null;
}

/** Does any alias rule read this phrase? Used to decide coverage. */
export function aliasKindFor(phrase: string): CanonicalSignalKind | null {
  for (const kind of CANONICAL_SIGNAL_KINDS) {
    if (matchAlias(phrase, kind)) return kind;
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Every canonical signal the user's sentence states.
 *
 * The shared reader first (so both mission paths read the same words the same
 * way), then the alias rules for phrasings it misses, with two precedence
 * rules the reader cannot express on its own:
 *   - a leadership appointment is not also an open-role hiring requirement;
 *   - "expanding headcount" is headcount growth, not a market expansion.
 */
export function readCanonicalSignals(query: string): CanonicalSignalReading[] {
  const text = String(query ?? "");
  const out: CanonicalSignalReading[] = [];
  const has = (kind: CanonicalSignalKind) => out.some((r) => r.kind === kind);

  const leadership = matchAlias(text, "leadership_change");
  const headcount = matchAlias(text, "headcount_growth");

  for (const d of readSignalsFromQuery(text)) {
    const kind = kindForEvent(d.event);
    if (!kind) continue;
    const clause = norm(d.phrase ?? text);
    if (kind === "hiring" && leadership && clause.includes(norm(leadership.match))) {
      // The only hiring words in this clause are the appointment itself.
      const rest = clause.replace(norm(leadership.match), " ");
      if (!OPEN_ROLE_VERB.test(rest)) continue;
    }
    if (kind === "hiring" && !REAL_HIRING_CUE.test(clause.replace(HIRING_INDUSTRY_NOUN, " "))) {
      continue; // the only "hiring" word names an industry, not an opening
    }
    if (kind === "expansion" && headcount && clause.includes(norm(headcount.match)) && !d.qualifier?.region) {
      continue;
    }
    if (has(kind)) continue;
    // The shared reader's leadership marker fires on "hiring a new VP" (an open
    // role). Only the guarded alias may declare a leadership change.
    if (kind === "leadership_change" && !leadership) continue;
    if (kind === "leadership_change" && leadership) {
      // The reader returns the whole clause; the alias knows the appointment
      // and the title, which is what the card and the evaluator need.
      const title = leadership.match.match(EXEC_TITLE_RE)?.[0];
      out.push({
        kind, subkind: leadership.rule.name, event: d.event, subject: d.subject,
        qualifier: { ...(d.qualifier ?? {}), ...(title ? { role_terms: [title.toLowerCase()] } : {}) },
        phrase: leadership.match, alias: leadership.rule.name,
      });
      continue;
    }
    out.push({
      kind,
      ...(kind === "expansion" && d.qualifier?.region ? { subkind: "geographic_expansion" } : {}),
      event: d.event, subject: d.subject, qualifier: { ...(d.qualifier ?? {}) },
      phrase: String(d.phrase ?? text).trim(), alias: "reader",
    });
  }

  if (leadership && !has("leadership_change")) {
    const title = leadership.match.match(EXEC_TITLE_RE)?.[0];
    out.push({
      kind: "leadership_change", subkind: leadership.rule.name, event: "leadership_change",
      subject: "leadership", qualifier: title ? { role_terms: [title.toLowerCase()] } : {},
      phrase: leadership.match, alias: leadership.rule.name,
    });
  }
  if (headcount && !has("headcount_growth")) {
    out.push({
      kind: "headcount_growth", event: "headcount_change", subject: "company",
      qualifier: { direction: "increase" } as SignalQualifier,
      phrase: headcount.match, alias: headcount.rule.name,
    });
  }
  for (const kind of ["expansion", "social_activity"] as const) {
    if (has(kind)) continue;
    const a = matchAlias(text, kind);
    if (!a) continue;
    const personal = /\b(?:founders?|ceos?|leaders?|leadership|executives?)\b/i.test(a.match);
    out.push({
      kind, ...(a.rule.subkind ? { subkind: a.rule.subkind } : {}),
      event: legacyEventForKind(kind)!,
      subject: kind === "social_activity" && personal ? "leadership" : "company",
      qualifier: {}, phrase: a.match, alias: a.rule.name,
    });
  }
  return out;
}

/** The carrier descriptor for a reading, built by the shared constructor. */
export function descriptorForReading(r: CanonicalSignalReading): MissionSignalDescriptor {
  return describeSignal(r.event, r.subject, r.qualifier, { phrase: r.phrase });
}

// ── HYPOTHESES ───────────────────────────────────────────────────────────────

const HYPOTHESIS_RE =
  /\b(?:(?:likely|probably|possibly|poised|about|set|going)\s+to\s+(?:need|want|buy|hire|look for|benefit from|invest in|struggle with)|(?:may|might|could|would|will)\s+(?:soon\s+)?(?:need|want|benefit from|be looking for)|in need of|could use)\b[^.;,!?]*/gi;

export interface HypothesisReading {
  /** The user's thesis, in their words. */
  phrase: string;
  /** Role the thesis is about, when it names one ("a growth marketer"). */
  role_families: string[];
  role_terms: string[];
}

/**
 * Opportunity theses — "likely to need a growth marketer soon". A thesis is
 * something to TEST, never evidence to require: it can rank a company, it can
 * never reject one, and it is not a verified signal.
 */
export function readHypotheses(query: string): HypothesisReading[] {
  const out: HypothesisReading[] = [];
  for (const m of String(query ?? "").matchAll(HYPOTHESIS_RE)) {
    const phrase = m[0].trim();
    if (!phrase || out.some((h) => h.phrase === phrase)) continue;
    const object = phrase.replace(
      /^(?:(?:likely|probably|possibly|poised|about|set|going)\s+to\s+\w+(?:\s+\w+)?|(?:may|might|could|would|will)\s+(?:soon\s+)?\w+(?:\s+\w+)?|in need of|could use)\s*/i, "");
    const role = object.replace(
      /\s+(?:soon|shortly|next\s+\w+|this\s+(?:year|quarter|month)|in\s+the\s+(?:near\s+)?future|eventually)\s*$/i, "");
    const asHiring = role ? readSignalPhrase(`hiring ${role}`) : null;
    out.push({
      phrase,
      role_families: [...(asHiring?.qualifier?.role_families ?? [])],
      role_terms: [...(asHiring?.qualifier?.role_terms ?? [])],
    });
  }
  return out;
}

// ── LANGUAGE THAT LOOKS LIKE A SIGNAL AND IS NOT ONE WE KNOW ────────────────

const SIGNAL_CUES: readonly RegExp[] = [
  /\b(?:recently|just|newly|lately)\s+[a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,4}/gi,
  /\b(?:with|showing|seeing|displaying|having|experiencing)\s+(?:strong|high|growing|rising|increasing|heavy|significant|rapid|recent|lots of|a lot of)\s+[a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,3}/gi,
  /\bsigns? of\s+[a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,3}/gi,
];

const CONTENT_STOP = new Set([
  "a", "an", "the", "their", "its", "of", "in", "on", "for", "to", "and", "with", "that",
  "recently", "just", "newly", "lately", "strong", "high", "recent", "companies", "company",
]);
const contentWords = (s: string) =>
  norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !CONTENT_STOP.has(w));

function overlaps(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(contentWords(a));
  return contentWords(b).filter((w) => wa.has(w)).length >= 1 && contentWords(b).length <= 2;
}

/**
 * Signal-like phrases nothing above could read.
 *
 * NEVER DISCARDED. A request whose defining requirement is not in the
 * vocabulary used to compile to `required_signals: []` and run as a plain
 * company search — "strong recent LinkedIn activity" did exactly that. Each
 * phrase returned here is recorded on the mission and shown on the card.
 */
export function unmappedSignalLanguage(
  query: string,
  readings: readonly CanonicalSignalReading[],
  hypotheses: readonly HypothesisReading[],
): string[] {
  const out: string[] = [];
  const text = String(query ?? "");
  for (const re of SIGNAL_CUES) {
    for (const m of text.matchAll(re)) {
      // Cut at the first connective: the cue is one requirement, not the rest
      // of the sentence.
      const cue = m[0].split(/\s+(?:and|or|but|who|which|that|whose|in|with)\s+/i)[0].trim()
        .replace(/[.,;:!?]+$/, "");
      if (contentWords(cue).length === 0) continue;
      const covered =
        readSignalPhrase(cue) !== null ||
        aliasKindFor(cue) !== null ||
        readings.some((r) => overlaps(r.phrase, cue)) ||
        hypotheses.some((h) => overlaps(h.phrase, cue));
      if (!covered && !out.some((o) => overlaps(o, cue))) out.push(cue);
    }
  }
  return out;
}
