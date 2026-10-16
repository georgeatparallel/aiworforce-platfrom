// WHAT A SIGNAL ACTUALLY IS — an event, about a subject, with qualifiers.
//
// ── WHY A SCALAR TYPE WAS NEVER ENOUGH ───────────────────────────────────────
//
// `MissionSignal.type` is one string, and the Phase 0 audit measured what that
// costs. Three separate facts reach this system in every real B2B request:
//
//   WHAT HAPPENED   a post, a funding round, an open role
//   TO WHOM         the company itself, or a named leader at it
//   ABOUT WHAT      US expansion, enterprise sales, a Series B
//
// A scalar can hold the first and drops the other two. So:
//
//   "enterprise sales hiring"              -> "hiring"      (role gone)
//   "leadership posted about US expansion" -> "leadership posts", unrecognised
//   "US expansion"                         -> "expansion"   (topic gone, and the
//                                             deterministic reader booked
//                                             "United States" as a company
//                                             GEOGRAPHY, inverting the meaning)
//
// The role survived only through a parallel channel — `role_families` plus
// `required_signal_terms` — which exists for roles and nothing else. There was
// no channel at all for a topic, for the subject of a post, or for the
// difference between a company posting and its CEO posting.
//
// ── WHAT THIS MODULE IS AND IS NOT ───────────────────────────────────────────
//
// It is the REQUIREMENT vocabulary: what the user asked to be proven. It is not
// `signalEvent.ts`, which is the persisted signals-v2 record of something that
// was observed, with provenance and verification. One is a question, the other
// is an answer, and they are deliberately separate types.
//
// Nothing here selects an Actor, names a provider, or decides whether a signal
// can be served. That is `actorEvidenceCapability`'s job, and keeping the two
// apart is what stops a requirement vocabulary quietly becoming a routing table.
//
// PURE. No network, provider, model or database access.

import { classifyRoleFamily, ROLE_FAMILY_ALIASES } from "./roleFamilies.ts";

export const SIGNAL_DESCRIPTOR_VERSION = "mission-signal-descriptor-v1" as const;

/**
 * WHAT HAPPENED.
 *
 * A superset of the old `MISSION_SIGNAL_TYPES`, and every old member keeps its
 * exact spelling so `s.type === "hiring"` — compared in a dozen places across
 * the lead path — continues to mean what it always meant.
 *
 * `post` and `comment` are new and are deliberately separate. A post is content
 * the subject authored; a comment is a reply on content someone else authored.
 * They need different evidence (a post URL and date, versus a parent post plus
 * the commenter's identity) and no registered source produces the second at
 * all, so collapsing them would hide a real capability gap behind a real
 * capability.
 *
 * `headcount_change` is separate from `expansion` for the same reason: growth
 * is a delta between two observations, expansion is a stated new market, and
 * one is not evidence of the other.
 */
export const SIGNAL_EVENTS = [
  "hiring",
  "funding",
  "expansion",
  "product_launch",
  "technology",
  "leadership_change",
  "post",
  "comment",
  "headcount_change",
] as const;
export type SignalEvent = typeof SIGNAL_EVENTS[number];

const EVENT_SET: ReadonlySet<string> = new Set(SIGNAL_EVENTS);
export function isSignalEvent(s: string): s is SignalEvent {
  return EVENT_SET.has(s);
}

/**
 * TO WHOM.
 *
 * The boundary this whole phase exists to draw. These three claims are not the
 * same claim and were previously one word:
 *
 *   company    the company posted about US expansion
 *   leadership the CEO posted about US expansion
 *   employee   an employee posted about US expansion
 *
 * `leadership` and `employee` are PERSON-level. A person-level signal cannot be
 * proven without first establishing who that person is, and person discovery is
 * unlock-gated by deliberate design. Recording the subject is what lets the
 * plan surface that dependency truthfully instead of either auto-spending on it
 * or silently dropping the requirement.
 */
export const SIGNAL_SUBJECTS = ["company", "leadership", "employee"] as const;
export type SignalSubject = typeof SIGNAL_SUBJECTS[number];

/** Person-level subjects, which carry an identity dependency before any proof. */
export function isPersonSubject(s: SignalSubject): boolean {
  return s === "leadership" || s === "employee";
}

/**
 * Events only a COMPANY can perform, whoever is mentioned in the sentence.
 *
 * ── WHY THE SUBJECT IS NOT SIMPLY "WHICHEVER PERSON NOUN APPEARS" ───────────
 *
 * The canonical query is "Find 5 founders of B2B SaaS startups in the United
 * States hiring Sales Operations". A person noun is present, but the founders
 * are the people the user wants to CONTACT — they are the requested output —
 * and the hiring is done by the company. Reading `subject: leadership` there
 * would invent a person-level hiring signal, and Phase 3 would then correctly
 * report it as needing an unlock it never needed.
 *
 * A company is the only thing that can raise a round, open a role, enter a
 * market, ship a product or change headcount. A PERSON can author a post or a
 * comment, and a leadership change is about a person by definition — those are
 * the only events where a person noun genuinely changes the subject.
 *
 * So the person-noun scan applies to social events only. This is the rule that
 * keeps "founders of companies that are hiring" a company signal and
 * "founders who posted about hiring" a person one.
 */
const COMPANY_ONLY_EVENTS: ReadonlySet<SignalEvent> = new Set<SignalEvent>([
  "hiring", "funding", "expansion", "product_launch", "technology",
  "headcount_change",
]);

/**
 * The subject an event may legitimately take, given the words around it.
 *
 * ── WHY A SENTENCE-LEVEL FALLBACK EXISTS ───────────────────────────────────
 *
 * `readSignalsFromQuery` splits a sentence into clauses so that two
 * requirements in one sentence both survive. That split can sever the SUBJECT
 * from its verb: "Find 5 founders matching my ICP who have recently posted
 * about X" splits on " who ", and the clause that carries the posting no longer
 * carries the word "founders".
 *
 * Read clause-locally, that produced `post/company` — a company-page post — for
 * a request explicitly about founders, which is the exact conflation the
 * subject field exists to prevent, arriving through the back door.
 *
 * So for person-AUTHORABLE events only, a clause with no person noun of its own
 * inherits one from the whole sentence. Company-only events are unaffected: a
 * sentence mentioning founders still yields `hiring/company`, because a company
 * hires and a founder does not.
 */
function subjectFor(
  event: SignalEvent, t: string, sentence?: string,
): SignalSubject {
  if (COMPANY_ONLY_EVENTS.has(event)) return "company";
  if (event === "leadership_change") return "leadership";
  if (LEADERSHIP_RE.test(t)) return "leadership";
  if (EMPLOYEE_RE.test(t)) return "employee";
  // The clause said nothing about who. Ask the sentence it came from.
  if (sentence) {
    const full = lc(sentence);
    // A COMPANY PAGE stated explicitly wins: "companies whose LinkedIn PAGE is
    // talking about X" is a company post even in a sentence about founders.
    if (/\b(?:company (?:page|linkedin)|linkedin page|company's page)\b/.test(t)) {
      return "company";
    }
    if (LEADERSHIP_RE.test(full)) return "leadership";
    if (EMPLOYEE_RE.test(full)) return "employee";
  }
  return "company";
}

/**
 * ABOUT WHAT.
 *
 * Every field is optional and every field is a NARROWING of the event. A
 * qualifier never widens a requirement and never introduces one: a signal with
 * no qualifiers is the unqualified event, which is a legitimate request.
 *
 * `region` is the region the SIGNAL is about — "expanding into the US" — and is
 * emphatically not the company's location. Conflating those two is what turned
 * the flagship's "US expansion" into a filter for companies already in the US,
 * excluding exactly the European companies it asked for.
 */
export interface SignalQualifier {
  /** Canonical role-family keys, for the existing role vocabulary. */
  role_families?: string[];
  /** The user's own role words, verbatim, for title matching. */
  role_terms?: string[];
  /** What the content is about — "US expansion", "AI adoption". */
  topic?: string;
  /** The region the SIGNAL concerns. NEVER the company's own location. */
  region?: string;
  /** "series a", "seed" — for funding events. */
  round_type?: string;
  /** For headcount_change: which way. */
  direction?: "increase" | "decrease";
  /**
   * LEAD V2 P3 — the hire is the FIRST in its function ("our first growth
   * marketer", "founding AE"). Only ever set from the user's own words. Not a
   * `QUALIFIER_KEYS` member: it refines a hiring requirement, it does not make
   * a different one.
   */
  first_in_function?: { phrase: string; source: "user_explicit" };
}

export const QUALIFIER_KEYS = [
  "role_families", "role_terms", "topic", "region", "round_type", "direction",
] as const;
export type QualifierKey = typeof QUALIFIER_KEYS[number];

/**
 * A requirement, fully stated.
 *
 * `type` is kept and is ALWAYS equal to `event`. It is not redundancy for its
 * own sake: every existing comparison in the lead path reads `type`, and a
 * migration that renamed the field would have to change all of them at once or
 * silently stop matching. `signalDescriptorAlignment` asserts the two never
 * diverge, so the alias cannot rot into a second opinion.
 */
export interface MissionSignalDescriptor {
  /** DERIVED ALIAS of `event`, for the existing `=== "hiring"` comparisons. */
  type: string;
  event: SignalEvent;
  subject: SignalSubject;
  qualifier: SignalQualifier;
  /** How recent the evidence must be. Absent means the request stated none. */
  timeframe_days?: number;
  /** Legacy channel, kept in sync with `qualifier.role_families`. */
  role_families?: string[];
  /** The user's own words for this requirement, for reporting and prompts. */
  phrase?: string;
}

/** Build a descriptor, keeping `type`/`event` and the role channels aligned. */
export function describeSignal(
  event: SignalEvent,
  subject: SignalSubject = "company",
  qualifier: SignalQualifier = {},
  extra: { timeframe_days?: number; phrase?: string } = {},
): MissionSignalDescriptor {
  const q: SignalQualifier = { ...qualifier };
  // Drop empties so two descriptors for the same requirement compare equal.
  for (const k of QUALIFIER_KEYS) {
    const v = q[k];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === "") delete q[k];
  }
  return {
    type: event,
    event,
    subject,
    qualifier: q,
    ...(extra.timeframe_days != null ? { timeframe_days: extra.timeframe_days } : {}),
    ...(q.role_families?.length ? { role_families: [...q.role_families] } : {}),
    ...(extra.phrase ? { phrase: extra.phrase } : {}),
  };
}

// ─────────────────────────────────────────────── reading a signal phrase ────
//
// WHY A READER LIVES HERE AND NOT IN THE PARSER.
//
// Two callers need to turn a phrase into a descriptor and they used to disagree.
// The deterministic parser read the whole user sentence with marker tables; the
// model-compiled path took `preferred_signals` — prose the model wrote, in the
// user's own terms — and ran it through `canonicalSignalType`, which reduces a
// phrase to ONE word and returns it verbatim when it matches nothing.
//
// That is where "enterprise sales hiring" lost its role and "leadership posts"
// became an unrecognised string. One reader, used by both, is what makes the
// two paths produce the same requirement from the same words.

const lc = (v: unknown) => String(v ?? "").toLowerCase().trim();

/** Person-subject markers. Ordered longest-first so "head of sales" beats "head". */
const LEADERSHIP_RE =
  /\b(?:founders?|co-?founders?|ceos?|ctos?|cfos?|coos?|cmos?|owners?|presidents?|partners?|executives?|execs?|leadership|leaders?|vps?|heads? of \w+|decision[- ]makers?)\b/;
const EMPLOYEE_RE = /\b(?:employees?|staff|team members?|workers?)\b/;

/**
 * A JOB OPENING NAMED AS THE OBJECT OF THE SENTENCE — "open sales roles",
 * "posted sales jobs", "open sales positions".
 *
 * Both used to be lost. "with open sales roles" matched no hiring marker (only
 * the bare "open roles" did), so the request compiled with NO hiring
 * requirement at all; "posted sales jobs" matched the social `post` marker
 * first, so it became an EMPLOYEE'S POST about the US — the hiring requirement
 * gone and the company's geography softened into the post's topic. Same intent
 * as "hiring sales", which compiled correctly. "Open source" is a kind of
 * software, never an opening.
 */
const JOB_OBJECT = String.raw`(?:(?:new|open|several|multiple|\d+)\s+)?(?:(?!about\b|on\b|regarding\b|that\b|source\b)[a-z][a-z/&-]*\s+){0,3}(?:jobs?|roles?|openings?|positions?|vacanc(?:y|ies)|job ads?|job listings?)\b`;
export const OPEN_ROLES_RE = new RegExp(String.raw`\bopen\s+(?!source\b)(?:[a-z][a-z/&-]*\s+){0,3}(?:roles?|positions?|jobs?|openings?|reqs?|vacanc(?:y|ies))\b`, "i");
export const POSTED_JOBS_RE = new RegExp(String.raw`\bpost(?:ed|s|ing)?\s+${JOB_OBJECT}`, "i");
/**
 * "A job posting", "an open Account Executive posting": the NOUN for an
 * opening. The words between "open" and "posting" name a role, never a
 * preposition, so "open to posting" is still a person posting. Without this
 * the smoke's own request ("…and an open Account Executive posting dated
 * within 30 days") compiled into a leadership POST — a signal nothing the
 * mission bought could answer — because the social reading is tried first.
 */
const ROLE_WORDS = String.raw`(?:(?!(?:source|to|about|on|regarding|that|for|and|in|with|of|up)\b)[a-z][a-z/&-]*\s+){0,3}`;
const JOB_POSTING_RE = new RegExp(String.raw`\b(?:job\s+|open\s+${ROLE_WORDS})postings?\b`, "i");
const POST_MARKER_RE = new RegExp(
  String.raw`\bpost(?:ed|s)?\b(?!\s+${JOB_OBJECT})|(?<!\b(?:job\s+|open\s+${ROLE_WORDS}))\bposting\b(?!\s+${JOB_OBJECT})|\bshar(?:ed|ing) (?:a|an|their)\b|\bwrote about\b|\bdiscuss(?:ed|ing|es)\b|\btalking about\b|\bannounc(?:ed|ing)\b`);
const HIRING_MARKER_RE = new RegExp(
  String.raw`\bhiring\b|\brecruit\w*\b|\bopen roles?\b|\bjob postings?\b|\bsellers?\b|\bhires?\b|${OPEN_ROLES_RE.source}|${POSTED_JOBS_RE.source}|${JOB_POSTING_RE.source}`);

/** Event markers, in precedence order. FIRST MATCH WINS, so order is meaning. */
const EVENT_MARKERS: ReadonlyArray<readonly [SignalEvent, RegExp]> = Object.freeze([
  // Engagement before authorship: "commented on a post" is a comment, and it
  // contains the word "post". Reading it as a post would claim the subject
  // authored content they only replied to.
  ["comment", /\bcomment(?:ed|s|ing)?\b|\breplied to\b|\bengag(?:ed|ing|ement) with\b/],
  ["post", POST_MARKER_RE],
  ["funding", /\bfund(?:ed|ing)\b|\braised\b|\bseries [a-e]\b|\bpre-?seed\b|\bseed round\b/],
  ["headcount_change", /\bheadcount\b|\bteam growth\b|\bgrowing (?:their|the) (?:team|headcount)\b|\bgtm growth\b|\bheadcount growth\b/],
  ["product_launch", /\bproduct launch\w*\b|\bnew product\b|\b(?:just|recently) launched\b|\blaunch(?:ed|ing) an? \w+/],
  ["leadership_change", /\bnew (?:ceo|cto|cfo|coo|cmo|vp|head of|exec\w*)\b|\bjust hired an? \w+|\bappointed\b|\bleadership change\b/],
  ["expansion", /\bexpan(?:d|ding|sion)\w*\b|\bopening (?:an? )?(?:office|location)\b|\bentering\b|\bnew market\b/],
  ["technology", /\btech(?:nology)? stack\b|\bbuilt on\b|\bpowered by\b|\badopt(?:ion|ed|ing)\b|\busing \w+/],
  ["hiring", HIRING_MARKER_RE],
]);

/**
 * Topic extraction: what the content is ABOUT.
 *
 * Only ever applied to `post` and `comment`, where "about X" is the requirement
 * and X is not otherwise recoverable. Deliberately conservative — it reads an
 * explicit "about"/"on"/"discussing" preposition and nothing else, because a
 * guessed topic is worse than an absent one: it would narrow a requirement the
 * user never narrowed.
 */
const TOPIC_RE = /\b(?:about|around|regarding|on the topic of|discussing|discuss|talking about|commenting on|commented on|posted on|pain (?:around|with)|struggling with)\s+([a-z0-9][a-z0-9 &/'-]{2,60}?)(?:\s*[.,;]|\s+and\s|$)/;

/**
 * The ROLE a hiring requirement names.
 *
 * Reads the ONE alias table the rest of the funnel already matches titles
 * against, so a family recognised here is a family the job filter can enforce.
 * Defining a second role vocabulary in this module is exactly the drift the
 * phase is removing.
 *
 * Two things are returned and both matter. `role_families` is the canonical key
 * the gate compares against; `role_terms` is the user's own wording, which
 * reaches the provider's title search and the evaluator's prompt, where
 * "enterprise sellers" carries a seniority the family key does not.
 */
function extractRoleQualifier(t: string): Pick<SignalQualifier, "role_families" | "role_terms"> {
  // ── LONGEST ALIAS WINS, AND SHORTER OVERLAPS ARE DROPPED ──────────────────
  //
  // Plain substring matching widens a request the repo explicitly forbids
  // widening. "Revenue Operations" contains "Revenue", which is a `gtm_sales`
  // alias, so a Sales-Operations request matched gtm_sales too — and
  // `roleFamilies.ts` states at its own `sales_operations` entry that such a
  // request "must never be widened into SDR/BDR/AE quota-carrying roles".
  //
  // So each family records the LONGEST alias it matched, and a family whose
  // best match is a strict substring of another family's is discarded: the
  // longer phrase is the more specific reading of the same words.
  const best = new Map<string, string>();
  for (const [family, aliases] of Object.entries(ROLE_FAMILY_ALIASES)) {
    let longest = "";
    for (const a of aliases) {
      const al = a.toLowerCase();
      if (t.includes(al) && al.length > longest.length) longest = al;
    }
    if (longest) best.set(family, longest);
  }
  const families: string[] = [];
  for (const [family, alias] of best) {
    const shadowed = [...best.values()].some((other) =>
      other.length > alias.length && other.includes(alias));
    if (!shadowed) families.push(family);
  }

  // The phrase the user actually used, kept verbatim. Taken from either side of
  // the hiring verb — "hiring enterprise sellers" and "enterprise sales hiring"
  // are the same request written in two orders.
  const terms: string[] = [];
  // Words that describe WHEN or WHAT KIND OF ORGANISATION, never WHO is wanted.
  // Captured alongside a role they are harmless; captured alone they become a
  // "role" matching no job title, which narrows the gate to nothing.
  const ADVERB = /^(?:currently|actively|now|recently|still|urgently|already)$/;
  const ORG_NOUN =
    /^(?:companies|company|startups|startup|businesses|business|firms|firm|orgs|organisations|organizations|teams|employers)$/;

  const keep = (raw: string | undefined) => {
    let v = (raw ?? "").trim();
    if (!v) return;
    // Strip the leading org/adverb words, then judge what is left.
    // "companies currently" reduces to nothing and is dropped; "enterprise
    // sellers" survives whole.
    const words = v.split(/\s+/);
    while (words.length && (ADVERB.test(words[0]) || ORG_NOUN.test(words[0]))) words.shift();
    while (words.length && ADVERB.test(words[words.length - 1])) words.pop();
    v = words.join(" ").trim();
    if (!v || ADVERB.test(v) || ORG_NOUN.test(v)) return;
    if (!terms.includes(v)) terms.push(v);
  };
  keep(t.match(/\b(?:hiring|recruiting|hire|hiring for|looking for)\s+([a-z][a-z0-9 /&-]{2,40}?)(?:\s*[.,;]|\s+(?:and|who|whose|in|at|with)\b|$)/)?.[1]);
  // THE ROLE SITS IMMEDIATELY BEFORE THE VERB, AT MOST A FEW WORDS OF IT.
  //
  // An unbounded lazy capture anchored anywhere in the clause swallowed the
  // entire sentence prefix: "Find 15 cybersecurity companies in Europe hiring
  // enterprise sellers" produced the role term "find 15 cybersecurity companies
  // in europe", which matches no job title and would poison the title filter.
  // Only consulted when the phrase after the verb gave nothing, since
  // "hiring X" is the far more common ordering.
  if (terms.length === 0) {
    keep(t.match(/\b((?:[a-z][a-z0-9/&-]*\s+){0,2}[a-z][a-z0-9/&-]*)\s+(?:hiring|hires|recruitment)\b/)?.[1]);
  }
  // THE ROLE NAMED AS THE OPENING ITSELF: "open sales roles", "posted sales jobs".
  if (terms.length === 0) {
    keep(t.match(/\b(?:open|post(?:ed|s|ing)?(?:\s+(?:new|open))?)\s+((?:[a-z][a-z0-9/&-]*\s+){0,2}?[a-z][a-z0-9/&-]*)\s+(?:jobs?|roles?|openings?|positions?|reqs?|vacanc(?:y|ies))\b/)?.[1]);
  }

  // NO ALIAS, BUT A NAMED DISCIPLINE. "Hiring a sales role" matches no title
  // alias ("sales role" is nobody's job title) and used to fall through to the
  // default commercial ladder — sales operations and growth titles included.
  // The user's own term is classified by the same family reader; only when the
  // alias table found nothing, so an alias match is never second-guessed.
  if (families.length === 0) {
    for (const term of terms) {
      const fam = classifyRoleFamily(term);
      if (fam && fam !== "custom" && !families.includes(fam)) families.push(fam);
    }
  }

  return {
    ...(families.length ? { role_families: families } : {}),
    ...(terms.length ? { role_terms: terms } : {}),
  };
}

/** Regions the signal may be ABOUT. Never read as a company location. */
const SIGNAL_REGION_RE =
  /\b(u\.?s\.?a?\.?|united states|america|europe|emea|apac|uk|united kingdom|germany|france|canada|australia|india|latam|middle east)\b/;

const ROUND_RE = /\b(pre-?seed|seed|series [a-e])\b/;

/**
 * Turn one signal phrase into a descriptor, or null when it names no event.
 *
 * NULL IS A REAL ANSWER and must not be rounded away. A phrase this cannot read
 * is a requirement the system does not understand, and the caller records it as
 * unrepresented rather than substituting the nearest event — which is how
 * "leadership posts" became a hiring mission with two thirds of the request
 * missing.
 */
export function readSignalPhrase(
  phrase: string, sentence?: string,
): MissionSignalDescriptor | null {
  const t = lc(phrase);
  if (!t) return null;

  let event: SignalEvent | null = null;
  for (const [e, re] of EVENT_MARKERS) {
    if (re.test(t)) { event = e; break; }
  }
  // An exact vocabulary word with no marker match — "funding", "post" alone.
  if (!event) {
    const bare = t.replace(/[\s-]+/g, "_");
    if (isSignalEvent(bare)) event = bare;
  }
  if (!event) return null;

  const subject = subjectFor(event, t, sentence);

  const qualifier: SignalQualifier = {};

  if (event === "post" || event === "comment") {
    const m = t.match(TOPIC_RE);
    if (m) qualifier.topic = m[1].trim();
    // A region named inside a social requirement is what the content is about,
    // not where the company sits.
    const r = (qualifier.topic ?? t).match(SIGNAL_REGION_RE);
    if (r) qualifier.region = r[1];
  }

  if (event === "hiring") {
    Object.assign(qualifier, extractRoleQualifier(t));
  }

  if (event === "expansion") {
    const r = t.match(SIGNAL_REGION_RE);
    if (r) qualifier.region = r[1];
  }

  if (event === "funding") {
    const r = t.match(ROUND_RE);
    if (r) qualifier.round_type = r[1];
  }

  if (event === "headcount_change") {
    qualifier.direction = /\b(?:shrink|reduc|layoff|cut)\w*\b/.test(t) ? "decrease" : "increase";
  }

  return describeSignal(event, subject, qualifier, { phrase: String(phrase).trim() });
}

/**
 * Every requirement a whole sentence states.
 *
 * ── WHY A CLAUSE SPLIT, AND WHY SOCIAL EVENTS SWALLOW THEIR CLAUSE ──────────
 *
 * A real request carries several requirements in one sentence:
 *
 *   "…hiring enterprise sellers AND whose leadership has recently posted
 *    about US expansion"
 *
 * `readSignalPhrase` answers for one phrase and takes the first event it
 * matches, so run on the whole sentence it would return exactly one of these
 * and drop the other — the original defect at a finer grain. So the sentence is
 * split on the connectives that separate requirements, and each clause is read.
 *
 * Within a clause the rule is NOT first-match-wins, with one deliberate
 * exception. "recently funded companies hiring SDRs" is one clause naming two
 * independent requirements, and both are emitted. But a post or a comment is a
 * CONTAINER: in "posted about US expansion", the expansion is what the content
 * is ABOUT, not a second thing to be proven. Emitting an expansion requirement
 * there would claim the company expanded when all that was asked is that
 * someone talked about expanding — which is precisely the conflation the
 * subject/topic split exists to prevent. So when a clause names a post or a
 * comment, that clause yields exactly one requirement and the rest of it is
 * read as the topic.
 */
export function readSignalsFromQuery(query: string): MissionSignalDescriptor[] {
  const raw = String(query ?? "");
  if (!raw.trim()) return [];

  // Connectives that separate requirements. Kept narrow: splitting on every
  // comma would sever "Series A, B and C" and other legitimate single phrases.
  const clauses = raw
    .split(/\s+(?:and\s+(?:whose|who|that|which)|and\s+are|,\s*and|\bwhose\b|\bwho\s+(?:are|have|has|recently)?)\s+|\s+and\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const out: MissionSignalDescriptor[] = [];
  for (const clause of clauses.length ? clauses : [raw]) {
    const t = lc(clause);

    // A social clause is one requirement, whatever else it mentions.
    const social = EVENT_MARKERS.find(([e, re]) =>
      (e === "post" || e === "comment") && re.test(t));
    if (social) {
      const d = readSignalPhrase(clause, raw);
      if (d) addRequirement(out, d);
      continue;
    }

    // Otherwise every event the clause names is its own requirement.
    let matched = false;
    for (const [event, re] of EVENT_MARKERS) {
      if (event === "post" || event === "comment") continue;
      if (!re.test(t)) continue;
      matched = true;
      // Re-read the clause AS that event, so qualifiers are extracted for the
      // right one rather than for whichever happened to match first.
      const d = readSignalAs(clause, event, raw);
      if (d) addRequirement(out, d);
    }
    if (!matched) continue;
  }
  return out;
}

/** Read a phrase as a NAMED event, extracting that event's own qualifiers. */
export function readSignalAs(
  phrase: string, event: SignalEvent, sentence?: string,
): MissionSignalDescriptor | null {
  const t = lc(phrase);
  if (!t) return null;

  const subject = subjectFor(event, t, sentence);

  const qualifier: SignalQualifier = {};
  if (event === "post" || event === "comment") {
    const m = t.match(TOPIC_RE);
    if (m) qualifier.topic = m[1].trim();
    const r = (qualifier.topic ?? t).match(SIGNAL_REGION_RE);
    if (r) qualifier.region = r[1];
  }
  if (event === "hiring") Object.assign(qualifier, extractRoleQualifier(t));
  if (event === "expansion") {
    const r = t.match(SIGNAL_REGION_RE);
    if (r) qualifier.region = r[1];
  }
  if (event === "funding") {
    const r = t.match(ROUND_RE);
    if (r) qualifier.round_type = r[1];
  }
  if (event === "headcount_change") {
    qualifier.direction = /\b(?:shrink|reduc|layoff|cut)\w*\b/.test(t) ? "decrease" : "increase";
  }

  return describeSignal(event, subject, qualifier, { phrase: String(phrase).trim() });
}

/**
 * Is this descriptor the same REQUIREMENT as that one?
 *
 * Event and subject must match; qualifiers are compared as a set so that a
 * descriptor carrying a topic is not silently deduplicated against one that
 * does not. Two readings of the same sentence should collapse; a company post
 * and a leadership post never should.
 */
export function sameRequirement(
  a: MissionSignalDescriptor, b: MissionSignalDescriptor,
): boolean {
  if (a.event !== b.event || a.subject !== b.subject) return false;
  for (const k of QUALIFIER_KEYS) {
    const x = a.qualifier[k];
    const y = b.qualifier[k];
    const sx = Array.isArray(x) ? [...x].sort().join(",") : (x ?? "");
    const sy = Array.isArray(y) ? [...y].sort().join(",") : (y ?? "");
    if (sx !== sy) return false;
  }
  return true;
}

/** Add a descriptor unless the list already carries the same requirement. */
export function addRequirement(
  into: MissionSignalDescriptor[], sig: MissionSignalDescriptor,
): MissionSignalDescriptor[] {
  if (!into.some((x) => sameRequirement(x, sig))) into.push(sig);
  return into;
}

/** A short, user-legible statement of what a descriptor requires. */
export function describeRequirement(s: MissionSignalDescriptor): string {
  const who = s.subject === "company" ? "the company"
    : s.subject === "leadership" ? "a company leader"
    : "an employee";
  const q = s.qualifier;
  const about = q.topic ? ` about "${q.topic}"` : "";
  const role = q.role_terms?.length
    ? ` for ${q.role_terms.join(" / ")}`
    : q.role_families?.length ? ` in ${q.role_families.join(" / ")}` : "";
  const region = q.region && s.event === "expansion" ? ` into ${q.region}` : "";
  const round = q.round_type ? ` (${q.round_type})` : "";
  const when = s.timeframe_days ? ` within ${s.timeframe_days} days` : "";

  switch (s.event) {
    case "post": return `${who} published a post${about}${when}`;
    case "comment": return `${who} commented on someone else's post${about}${when}`;
    case "hiring": return `${who} has an open role${role}${when}`;
    case "funding": return `${who} raised funding${round}${when}`;
    case "expansion": return `${who} stated an expansion${region}${when}`;
    case "product_launch": return `${who} launched a product${when}`;
    case "technology": return `${who} adopted a named technology${when}`;
    case "leadership_change": return `${who} changed leadership${when}`;
    case "headcount_change":
      return `${who} showed a headcount ${q.direction ?? "increase"}${when}`;
  }
}
