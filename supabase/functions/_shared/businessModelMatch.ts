// LEAD V2 P5.2 — DOES THIS EVIDENCE SAY THE COMPANY IS WHAT THE MISSION REQUIRES?
//
// Eligibility compared an industry/business-model requirement with evidence by
// SUBSTRING: every requirement token only had to occur somewhere in the
// evidence text. "AI" therefore matched "Retail" (re-t-AI-l), and a value the
// evidence plainly contradicted — a verified "consumer" company against a
// "B2B SaaS" requirement — could only ever be "unknown", so a company the
// mission had ruled out sat in `pending` forever.
//
// This module reads both sides into a small CONTROLLED VOCABULARY of facets and
// compares facets, never characters:
//
//   audience   b2b | consumer
//   delivery   saas | software | service
//   ai         present or not stated
//
// Tokens are whole words after normalisation, and aliases are listed, not
// guessed. A requirement word outside the vocabulary ("fintech", "founder-led")
// can only be satisfied by the same whole word in the evidence — it can never
// be contradicted, because nothing here knows what it excludes.
//
//   pass     every required facet is stated by the evidence with a compatible
//            value, and every unrecognised requirement word is in the evidence
//   fail     some required facet is stated by the evidence with a value that
//            excludes it (b2b vs consumer; saas/software vs service)
//   unknown  anything else — the evidence neither shows nor rules it out
//
// "or" in a requirement is a disjunction: any alternative passing passes, all
// alternatives failing fails.
//
// Pure. Code owns this; GPT never reaches it.

export const BUSINESS_MODEL_MATCH_VERSION = "business-model-match-v1" as const;

export type MatchResult = "pass" | "fail" | "unknown";

type Audience = "b2b" | "consumer";
type Delivery = "saas" | "software" | "service";

export interface ModelFacets {
  audience: Audience | null;
  delivery: Delivery | null;
  ai: boolean;
  /** Whole words the vocabulary does not know. */
  other: string[];
}

/** Multi-word aliases, rewritten to one controlled token before tokenising. */
const PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/\bsoftware[\s-]+as[\s-]+a[\s-]+service\b/g, " saas "],
  [/\bbusiness[\s-]+to[\s-]+business\b/g, " b2b "],
  [/\bbusiness[\s-]+to[\s-]+consumers?\b/g, " b2c "],
  [/\bdirect[\s-]+to[\s-]+consumers?\b/g, " b2c "],
  [/\bartificial[\s-]+intelligence\b/g, " ai "],
  [/\bgen[\s-]?ai\b/g, " ai "],
];

const AUDIENCE: Readonly<Record<string, Audience>> = {
  b2b: "b2b", enterprise: "b2b",
  b2c: "consumer", consumer: "consumer", consumers: "consumer", dtc: "consumer", d2c: "consumer",
};
const DELIVERY: Readonly<Record<string, Delivery>> = {
  saas: "saas",
  software: "software",
  service: "service", services: "service", agency: "service", agencies: "service",
  consulting: "service", consultancy: "service",
};
const AI = new Set(["ai"]);

/** Words that name the kind of thing, not what it is — ignored on both sides. */
const FILLER = new Set([
  "a", "an", "the", "of", "for", "and", "&", "in", "with",
  "company", "companies", "business", "businesses", "firm", "firms",
  "startup", "startups", "vendor", "vendors", "provider", "providers", "platform", "platforms",
]);

function normalise(text: unknown): string {
  let s = ` ${String(text ?? "").toLowerCase().replace(/_/g, " ")} `;
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s;
}

function tokens(text: string): string[] {
  return text.split(/[^a-z0-9&]+/).filter((t) => t.length > 0 && !FILLER.has(t));
}

/** One phrase, read into facets. */
export function readFacets(text: unknown): ModelFacets {
  const f: ModelFacets = { audience: null, delivery: null, ai: false, other: [] };
  for (const t of tokens(normalise(text))) {
    if (AUDIENCE[t]) f.audience = f.audience ?? AUDIENCE[t];
    // Delivery and AI in an explicit buyer phrase describe the customer.
    else if (!DELIVERY[t] && !AI.has(t) && !f.other.includes(t)) f.other.push(t);
  }
  for (const t of tokens(ownOfferingText(normalise(text)))) {
    if (DELIVERY[t]) {
      // "saas software" is SaaS: the narrower delivery wins.
      const d = DELIVERY[t];
      f.delivery = f.delivery === null || d === "saas" ? d : f.delivery;
    }
    if (AI.has(t)) f.ai = true;
  }
  return f;
}

/** True when every word of the phrase is in the controlled vocabulary. */
export function isControlledPhrase(text: unknown): boolean {
  const f = readFacets(text);
  return f.other.length === 0 && (f.audience !== null || f.delivery !== null || f.ai);
}

function deliverySatisfies(required: Delivery, got: Delivery): MatchResult {
  if (required === got) return "pass";
  if (required === "service" || got === "service") return "fail";
  // SaaS is software. Software is not necessarily SaaS, and says nothing against it.
  if (required === "software" && got === "saas") return "pass";
  return "unknown";
}

function matchOne(required: ModelFacets, evidence: ModelFacets, evidenceWords: ReadonlySet<string>): MatchResult {
  const parts: MatchResult[] = [];
  if (required.audience) {
    parts.push(evidence.audience === null ? "unknown" : evidence.audience === required.audience ? "pass" : "fail");
  }
  if (required.delivery) {
    parts.push(evidence.delivery === null ? "unknown" : deliverySatisfies(required.delivery, evidence.delivery));
  }
  // AI is never contradicted by silence: a B2B SaaS company may well be an AI one.
  if (required.ai) parts.push(evidence.ai ? "pass" : "unknown");
  // Words outside the vocabulary: satisfied by the same whole word, never refuted.
  for (const w of required.other) parts.push(evidenceWords.has(w) ? "pass" : "unknown");
  if (parts.length === 0) return "unknown";
  if (parts.includes("fail")) return "fail";
  return parts.every((p) => p === "pass") ? "pass" : "unknown";
}

/**
 * The requirement against one evidence value. Deterministic, facet-based,
 * whole-word only.
 */
export function matchBusinessModel(required: unknown, evidence: unknown): MatchResult {
  const ev = readFacets(evidence);
  const evWords = new Set(tokens(normalise(evidence)));
  const alternatives = normalise(required).split(/\bor\b|\//).map((s) => s.trim()).filter(Boolean);
  if (alternatives.length === 0) return "unknown";
  const results = alternatives.map((a) => matchOne(readFacets(a), ev, evWords));
  if (results.includes("pass")) return "pass";
  return results.every((r) => r === "fail") ? "fail" : "unknown";
}

// ── THE GROUNDER'S ANSWER, READ INTO ITS VOCABULARY (P5.2) ──────────────────
//
// The grounding prompts asked for `business_model.value` as a bare "string" and
// never named the allowed values, while the parser accepted only the exact
// codes. Canary e4da3d5a: 4 of 5 companies carried a VALIDATED business-model
// claim at 0.86–0.96 confidence and every one parsed as "unknown" — so no
// business-model evidence ever reached eligibility. The prompts now name the
// codes; this reads whatever still arrives as free text ("B2B SaaS",
// "B2B SaaS platform for financial firms") through the same controlled
// vocabulary, and refuses anything it cannot read unambiguously.

export type BusinessModelCode =
  | "b2b_saas" | "ai_saas" | "b2b_software" | "b2b_service" | "consumer" | "unknown";

export const BUSINESS_MODEL_CODES: readonly BusinessModelCode[] =
  ["b2b_saas", "ai_saas", "b2b_software", "b2b_service", "consumer", "unknown"];

const NEGATION = new Set(["not", "non", "no", "neither", "nor", "without", "never", "isn't", "isnt"]);

/**
 * A model's business-model answer as one code. Exact codes pass through;
 * free text is read by facets. Ambiguous or negated text is `unknown`:
 *
 *   b2b + saas → b2b_saas        b2b + software → b2b_software
 *   b2b + service → b2b_service  consumer (alone) → consumer
 *   ai + saas, no audience → ai_saas
 *   both audiences, service beside saas/software, any negation → unknown
 */
export function canonicalBusinessModel(raw: unknown): BusinessModelCode {
  const exact = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((BUSINESS_MODEL_CODES as readonly string[]).includes(exact)) return exact as BusinessModelCode;
  const words = tokens(normalise(raw));
  if (words.length === 0 || words.some((w) => NEGATION.has(w))) return "unknown";
  const audiences = new Set(words.map((w) => AUDIENCE[w]).filter(Boolean));
  const offeringWords = tokens(ownOfferingText(normalise(raw)));
  const deliveries = new Set(offeringWords.map((w) => DELIVERY[w]).filter(Boolean));
  const ai = offeringWords.some((w) => AI.has(w));
  if (audiences.size > 1) return "unknown";
  if (deliveries.has("service") && (deliveries.has("saas") || deliveries.has("software"))) return "unknown";
  const audience = [...audiences][0] ?? null;
  const delivery: Delivery | null = deliveries.has("saas") ? "saas" : deliveries.has("software") ? "software"
    : deliveries.has("service") ? "service" : null;
  if (audience === "consumer") return "consumer";
  if (audience === "b2b") {
    return delivery === "saas" ? "b2b_saas" : delivery === "software" ? "b2b_software"
      : delivery === "service" ? "b2b_service" : "unknown";
  }
  return ai && delivery === "saas" ? "ai_saas" : "unknown";
}

// ── DOES THE COMPANY'S OWN QUOTE SUPPORT THE CODE? (P5.2) ──────────────────
//
// Canary d7012ba5: dot.cards was accepted as b2b_saas on its own words —
// "We operate across consumer software, B2B SaaS, subscriptions, ecommerce,
// and connected hardware". The quote was real and correctly cited; it simply
// did not say the company IS a B2B SaaS business. The verifier checks that a
// quote exists; this checks that the quote does not argue against the code.
//
// Read with the same vocabulary, whole words:
//
//   mixed_audience       a quote names both B2B and consumer
//   mixed_delivery       a quote names services beside SaaS/software
//   contradicts_value    the quotes name an audience or delivery the code
//                        excludes, and never the one it claims
//
// A quote that names no facet ("a collaborative platform for event
// organizers") says nothing against the code and leaves the reading standing.
// A quote with a negation ("not an agency") is not read for facets at all —
// silence, never a contradiction. The direction of every error here is
// review, never a false proof.

const VALUE_FACETS: Readonly<Record<BusinessModelCode, { audience: Audience | null; delivery: Delivery | null }>> = {
  b2b_saas: { audience: "b2b", delivery: "saas" },
  ai_saas: { audience: null, delivery: "saas" },
  b2b_software: { audience: "b2b", delivery: "software" },
  b2b_service: { audience: "b2b", delivery: "service" },
  consumer: { audience: "consumer", delivery: null },
  unknown: { audience: null, delivery: null },
};

export type ExcerptInconsistency = "mixed_audience" | "mixed_delivery" | "contradicts_value";

export function excerptInconsistency(
  code: BusinessModelCode, excerpts: readonly string[],
): ExcerptInconsistency | null {
  const audiences = new Set<Audience>();
  const deliveries = new Set<Delivery>();
  for (const e of excerpts) {
    const words = tokens(normalise(e));
    if (words.length === 0 || words.some((w) => NEGATION.has(w))) continue;
    for (const w of words) {
      if (AUDIENCE[w]) audiences.add(AUDIENCE[w]);
    }
    for (const w of tokens(ownOfferingText(normalise(e)))) {
      if (DELIVERY[w]) deliveries.add(DELIVERY[w]);
    }
  }
  if (audiences.size > 1) return "mixed_audience";
  if (deliveries.has("service") && (deliveries.has("saas") || deliveries.has("software"))) return "mixed_delivery";
  const want = VALUE_FACETS[code];
  if (want.audience && audiences.size > 0 && !audiences.has(want.audience)) return "contradicts_value";
  if (want.delivery && deliveries.size > 0) {
    const software = want.delivery === "saas" || want.delivery === "software";
    const said = software ? (deliveries.has("saas") || deliveries.has("software")) : deliveries.has(want.delivery);
    if (!said) return "contradicts_value";
  }
  return null;
}

// ── THE QUOTES MUST STATE WHAT THE CODE ASSERTS (P5 evidence-first) ─────────
//
// Canary 9b1b70a2. Feathery was accepted as `b2b_saas` on "an agentic data
// intake platform for financial firms" — a quote that shows business customers
// and a platform, and says nothing about SaaS delivery. Outsmart was accepted as
// `consumer` — a verified FAIL — on "Rebuilding higher education for the AI
// era", which names no audience at all. `excerptInconsistency` let both stand,
// by design: it only rejects a quote that ARGUES AGAINST the code. Silence was
// read as consent, and a model's inference became a hard PASS or FAIL.
//
// B2B SaaS is not one fact. It is four, each of which the company's own words
// must state (the plan, §10):
//
//   business_customer   who buys it: businesses, not consumers
//   software_product    what it is: software
//   saas_delivery       how it is delivered: hosted / subscription / cloud
//   service_primary     whether people-delivered services are the business
//
// A code asserts the facets below; every one must be STATED by the claim's
// quotes, read deterministically, or the business model is `review` and the
// hard rule stays PENDING. Nothing here guesses: "platform" alone is not
// software, software is not SaaS, "AI" is not an audience, and a quote with a
// negation is not read for facets at all. The direction of every error is
// pending, never a false proof.

export type BusinessModelFacet =
  | "business_customer" | "consumer_customer" | "software_product" | "saas_delivery" | "service_primary" | "ai";

export const FACETS_ASSERTED: Readonly<Record<BusinessModelCode, readonly BusinessModelFacet[]>> = {
  b2b_saas: ["business_customer", "saas_delivery"],
  ai_saas: ["ai", "saas_delivery"],
  b2b_software: ["business_customer", "software_product"],
  b2b_service: ["business_customer", "service_primary"],
  consumer: ["consumer_customer"],
  unknown: [],
};

/** A plural buyer noun: who a business product is sold to. */
const BUSINESS_BUYER =
  "(?:businesses|companies|firms|enterprises|organi[sz]ations|teams|institutions|banks|lenders|insurers|carriers|" +
  "retailers|merchants|brands|agencies|hospitals|clinics|providers|practices|schools|universities|governments|" +
  "manufacturers|distributors|operators|employers|recruiters|marketers|sales\\s+teams|finance\\s+teams)";
const BUYER_VERB = "(?:for|serving|serves|serve|helps?|help|used\\s+by|trusted\\s+by|built\\s+for|designed\\s+for|sells?\\s+to|sold\\s+to)";
const BUSINESS_CUSTOMER_RE = new RegExp(`\\b${BUYER_VERB}\\b(?:\\s+[\\w&',-]+){0,6}?\\s+${BUSINESS_BUYER}\\b`);
/**
 * An explicit buyer relation ("SaaS for staffing agencies", "consulting for
 * software companies") says who buys, not what the vendor delivers. Keep the
 * original text for audience/negation checks and quoted provenance; mask only
 * this bounded relation when reading offering facets. The marker prevents
 * accidentally joining words on opposite sides of the customer phrase.
 */
function ownOfferingText(text: string): string {
  return text.replace(new RegExp(BUSINESS_CUSTOMER_RE.source, "g"), " __buyer_context__ ");
}

const CONSUMER_CUSTOMER_RE =
  /\b(?:for|serving|serves|helps?|used\s+by|built\s+for|designed\s+for)\b(?:\s+[\w&',-]+){0,4}?\s+(?:individuals|families|parents|shoppers|consumers|everyday\s+people|households)\b/;
const SOFTWARE_WORDS = new Set([
  "software", "saas", "app", "apps", "application", "applications", "api", "apis", "sdk", "sdks",
  "erp", "crm", "ehr", "emr", "plugin", "plugins", "dashboard", "dashboards",
]);
const SAAS_PHRASE_RE =
  /\bcloud[\s-]?(?:based|native|hosted)?\s+(?:platform|software|app|application|solution)s?\b|\bhosted\s+(?:platform|software|solution)\b|\bweb[\s-]?based\s+(?:platform|software|app|application)\b/;
/**
 * Seat-based pricing is software licensed as a service: SaaS on its own.
 *
 * Hyphenated too — "per-user licensing", "per-seat pricing" — which is how most
 * pricing pages write it. MintMCP's own pricing line ("Per-user licensing with
 * scalable platform fees.") stated nothing when only "per user" matched.
 */
const SEAT_PRICING_RE = /\bper[\s-]+(?:seat|user)s?\b|\/\s?(?:user|seat)\b/;
/** Subscription language proves SaaS only beside software — a subscription box is not SaaS. */
const SUBSCRIPTION_RE =
  /\bsubscriptions?\b|\bper\s+month\b|\/\s?(?:mo|month)\b|\bfree\s+trial\b|\bself[\s-]?serve\b|\bsign\s+up\b/;
const SERVICE_WORDS = new Set([
  "service", "services", "agency", "agencies", "consulting", "consultancy", "staffing", "outsourcing", "outsourced",
]);
const AI_WORDS = new Set(["ai", "agentic", "llm", "llms", "genai"]);

/** Which facets the quotes STATE. A negated quote states nothing. */
export function statedFacets(excerpts: readonly string[]): Set<BusinessModelFacet> {
  const out = new Set<BusinessModelFacet>();
  let subscription = false;
  for (const e of excerpts) {
    const text = normalise(e);
    const words = tokens(text);
    if (words.length === 0 || words.some((w) => NEGATION.has(w))) continue;
    const plain = ` ${text.replace(/\s+/g, " ")} `;
    const offering = ownOfferingText(plain);
    const offeringWords = tokens(offering);
    if (words.some((w) => AUDIENCE[w] === "b2b") || BUSINESS_CUSTOMER_RE.test(plain)) out.add("business_customer");
    if (words.some((w) => AUDIENCE[w] === "consumer") || CONSUMER_CUSTOMER_RE.test(plain)) out.add("consumer_customer");
    if (offeringWords.some((w) => SOFTWARE_WORDS.has(w))) out.add("software_product");
    if (offeringWords.includes("saas") || SAAS_PHRASE_RE.test(offering) || SEAT_PRICING_RE.test(offering)) out.add("saas_delivery");
    if (SUBSCRIPTION_RE.test(offering)) subscription = true;
    if (offeringWords.some((w) => SERVICE_WORDS.has(w))) out.add("service_primary");
    if (offeringWords.some((w) => AI_WORDS.has(w))) out.add("ai");
  }
  if (out.has("saas_delivery")) out.add("software_product");
  if (subscription && out.has("software_product")) out.add("saas_delivery");
  return out;
}

/** The facets a code asserts that the quotes do not state. Empty ⇒ the quotes carry the code. */
export function unstatedFacets(code: BusinessModelCode, excerpts: readonly string[]): BusinessModelFacet[] {
  const stated = statedFacets(excerpts);
  return FACETS_ASSERTED[code].filter((f) => !stated.has(f));
}

/**
 * A business-model value, plus the AUDIENCE its own verified quotes state when
 * the code names none.
 *
 * The code list makes "AI" and "B2B" alternatives — `ai_saas` or `b2b_saas` —
 * though they are independent: an AI product sold to businesses is both. So an
 * AI company whose pages say "Built for teams… 50/seat" was coded `ai_saas`,
 * and `ai saas` can never pass a "B2B SaaS" requirement (production Fuse AI,
 * task d2d15d7e, 2026-09-26). The quotes already state who buys; this writes
 * that into the value the requirement is matched against.
 *
 * Only when exactly ONE audience is stated. Neither, or both (a mixed audience —
 * "for creators and teams"), adds nothing: silence is not support. Whether the
 * value may prove anything is still the claim's decision (accepted ⇒ proven).
 */
export function valueWithStatedAudience(value: string, stated: Iterable<BusinessModelFacet>): string {
  if (readFacets(value).audience !== null) return value;
  const s = new Set(stated);
  const b2b = s.has("business_customer"), consumer = s.has("consumer_customer");
  if (b2b === consumer) return value;
  return `${b2b ? "b2b" : "consumer"} ${value}`;
}
