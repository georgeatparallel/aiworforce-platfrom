// A REQUIREMENT MUST SURVIVE THE JOURNEY.
//
// Phase 0 measured what a scalar `MissionSignal.type` costs. Three facts reach
// this system in every real B2B request — WHAT happened, TO WHOM, and ABOUT
// WHAT — and one string can hold the first. So:
//
//   "enterprise sales hiring"              -> "hiring"      role gone
//   "leadership posted about US expansion" -> unrecognised, then dropped
//   "US expansion"                         -> "expansion", topic gone, and the
//                                             US booked as a COMPANY location,
//                                             inverting the request
//
// These tests pin the distinctions the descriptor exists to keep. They assert
// SEMANTICS — that two different requirements stay different — never a
// particular regex.
import {
  assert, assertEquals, assertFalse, assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  readSignalPhrase, readSignalsFromQuery, readSignalAs, describeSignal,
  sameRequirement, isPersonSubject, describeRequirement,
  SIGNAL_EVENTS, SIGNAL_SUBJECTS, isSignalEvent,
} from "../../../supabase/functions/_shared/missionSignalDescriptor.ts";
import {
  parseLeadMissionDeterministic,
} from "../../../supabase/functions/_shared/leadMission.ts";
import {
  signalToEvidenceCategory,
} from "../../../supabase/functions/_shared/evidenceContract.ts";

const one = (q: string) => {
  const ds = readSignalsFromQuery(q);
  assertEquals(ds.length, 1, `expected one requirement from "${q}", got ${ds.length}`);
  return ds[0];
};

// ══════════════════════════ 1-3. hiring is not one thing ════════════════════

Deno.test("1. role-specific hiring keeps its role; generic hiring claims none", () => {
  const generic = one("companies currently hiring");
  assertEquals(generic.event, "hiring");
  // "currently" is WHEN, not WHO. Capturing it as a role would narrow the gate
  // to a term matching no job title in existence.
  assertEquals(generic.qualifier.role_terms, undefined);

  const sellers = one("companies hiring enterprise sellers");
  assertEquals(sellers.event, "hiring");
  assertEquals(sellers.qualifier.role_families, ["gtm_sales"]);
  assertEquals(sellers.qualifier.role_terms, ["enterprise sellers"]);

  // The requirement is strictly narrower than the generic one, so the two must
  // never be treated as the same thing.
  assertFalse(sameRequirement(generic, sellers));
});

Deno.test("2. sales hiring and engineering hiring are different requirements", () => {
  const sales = one("companies hiring enterprise AEs");
  const eng = one("companies hiring software engineers");

  assertEquals(sales.qualifier.role_families, ["gtm_sales"]);
  assertEquals(eng.qualifier.role_families, ["engineering"]);
  assertFalse(sameRequirement(sales, eng),
    "a sales-hiring requirement must never match an engineering one");
});

Deno.test("3. a Sales-Operations request is NOT widened into quota-carrying sales", () => {
  // `roleFamilies.ts` states this at its own `sales_operations` entry: such a
  // request "must never be widened into SDR/BDR/AE quota-carrying roles".
  //
  // Plain substring matching broke it — "Revenue Operations" contains
  // "Revenue", a `gtm_sales` alias — so the longest matching alias wins and a
  // family shadowed by a longer one is dropped.
  const ops = one("companies hiring Revenue Operations");
  const fams = ops.qualifier.role_families ?? [];
  assert(fams.includes("sales_operations"), `expected sales_operations, got ${fams}`);
  assertFalse(fams.includes("gtm_sales"),
    "a Sales/Revenue Operations request must not widen into gtm_sales");
});

// ═══════════════════ 4-6. company vs leadership vs comment ══════════════════

Deno.test("4. a company post, a leadership post and a comment are three requirements", () => {
  const companyPost = one("companies whose company page recently posted about hiring");
  const leaderPost = one("companies whose CEO recently posted about hiring");
  const comment = one("companies whose CEO recently commented on a post about hiring");

  assertEquals(companyPost.event, "post");
  assertEquals(companyPost.subject, "company");

  assertEquals(leaderPost.event, "post");
  assertEquals(leaderPost.subject, "leadership");

  // A comment is engagement with someone ELSE's content. The clause contains
  // the word "post", and reading it as a post would claim the CEO authored
  // content they only replied to.
  assertEquals(comment.event, "comment");
  assertEquals(comment.subject, "leadership");

  // No two of them are the same requirement.
  assertFalse(sameRequirement(companyPost, leaderPost));
  assertFalse(sameRequirement(leaderPost, comment));
  assertFalse(sameRequirement(companyPost, comment));
});

Deno.test("5. only a person-authored event takes a person subject", () => {
  // A person noun in the sentence does NOT make a company event person-level.
  // "founders of startups hiring X" is a company hiring signal — the founders
  // are who the user wants to contact, not who is doing the hiring.
  for (const q of [
    "founders of startups hiring SDRs",
    "founders of recently funded companies",
    "CEOs of companies expanding into Europe",
    "founders of companies that launched a new product",
  ]) {
    for (const d of readSignalsFromQuery(q)) {
      assertEquals(d.subject, "company",
        `"${q}" -> ${d.event} must stay company-level: a company hires, raises and expands`);
      assertFalse(isPersonSubject(d.subject));
    }
  }

  // But an authored event does take the person.
  assertEquals(one("founders who posted about AI").subject, "leadership");
  assert(isPersonSubject(one("founders who posted about AI").subject));
});

Deno.test("6. a post ABOUT expansion is not an expansion requirement", () => {
  // The conflation that would let "someone talked about moving to the US" be
  // proven by "the company moved to the US" — or worse, reported as satisfied
  // when only the talk was found.
  const ds = readSignalsFromQuery("companies whose leadership posted about US expansion");
  assertEquals(ds.length, 1, "a social clause states ONE requirement");
  assertEquals(ds[0].event, "post");
  assertEquals(ds[0].qualifier.topic, "us expansion");
  assertFalse(ds.some((d) => d.event === "expansion"),
    "the expansion is the TOPIC of the post, not a second thing to prove");
});

// ══════════════════════ 7-9. the other events stay apart ════════════════════

Deno.test("7. funding, expansion, product launch and headcount are distinct", () => {
  const funding = one("recently funded companies");
  const expansion = one("companies expanding into the US");
  const launch = one("companies that recently launched a new product");
  const headcount = one("companies showing headcount growth");

  assertEquals(funding.event, "funding");
  assertEquals(expansion.event, "expansion");
  assertEquals(launch.event, "product_launch");
  assertEquals(headcount.event, "headcount_change");

  const all = [funding, expansion, launch, headcount];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assertFalse(sameRequirement(all[i], all[j]),
        `${all[i].event} and ${all[j].event} must not be the same requirement`);
    }
  }
});

Deno.test("8. one clause may state two independent requirements", () => {
  // "recently funded companies hiring SDRs" is two things to prove, and taking
  // the first match would silently drop whichever lost.
  const ds = readSignalsFromQuery("recently funded companies hiring SDRs");
  const events = ds.map((d) => d.event).sort();
  assertEquals(events, ["funding", "hiring"]);
  assertEquals(ds.find((d) => d.event === "hiring")!.qualifier.role_families, ["gtm_sales"]);
});

Deno.test("9. qualifiers are carried: topic, region, round, direction, recency", () => {
  assertEquals(one("companies raising a series a").qualifier.round_type, "series a");
  assertEquals(one("companies expanding into the US").qualifier.region, "us");
  assertEquals(one("founders posting about AI adoption").qualifier.topic, "ai adoption");
  assertEquals(one("companies showing headcount growth").qualifier.direction, "increase");

  // Recency reaches the descriptor from the mission, not invented by the reader.
  const m = parseLeadMissionDeterministic("Find recently funded companies");
  assertEquals(m.required_signals[0].timeframe_days, 180);
});

// ═════════════════════════ 10-12. the invariants ════════════════════════════

Deno.test("10. `type` never diverges from `event`", () => {
  // `type` is the alias every existing `=== \"hiring\"` comparison reads. If the
  // two could differ, half the lead path would be matching on a stale value.
  for (const ev of SIGNAL_EVENTS) {
    for (const su of SIGNAL_SUBJECTS) {
      const d = describeSignal(ev, su);
      assertEquals(d.type, d.event);
      assertEquals(d.type, ev);
    }
  }
  for (const q of [
    "companies hiring SDRs", "recently funded companies",
    "founders who posted about AI", "CEOs commenting on sales",
  ]) {
    for (const d of readSignalsFromQuery(q)) assertEquals(d.type, d.event);
  }
});

Deno.test("11. every event maps to an evidence category, and social events split by subject", () => {
  // `signalToEvidenceCategory` returned null for `leadership_change` and
  // `technology` — both members of the mission's own vocabulary — so a mission
  // could require them while the compiled contract held no requirement at all.
  for (const ev of SIGNAL_EVENTS) {
    assert(isSignalEvent(ev));
    assert(signalToEvidenceCategory(ev) !== null,
      `${ev} has no evidence category, so no contract can require it`);
  }

  // The split that keeps a company post from satisfying a leadership post.
  assertNotEquals(
    signalToEvidenceCategory("post", "company"),
    signalToEvidenceCategory("post", "leadership"),
  );
  assertEquals(signalToEvidenceCategory("post", "leadership"), "founder_activity_signal");
  assertEquals(signalToEvidenceCategory("post", "company"), "company_activity_signal");
});

Deno.test("12. an unreadable phrase yields null, never the nearest event", () => {
  // Rounding to the nearest event is the original defect. A phrase naming no
  // event must produce nothing, so the caller records it as unrepresented.
  assertEquals(readSignalPhrase("cybersecurity"), null);
  assertEquals(readSignalPhrase(""), null);
  assertEquals(readSignalPhrase("companies in Europe"), null);
});

// ═══════════════ 13-14. geography is the company's, or the signal's ═════════

Deno.test("13. THE INVERSION: a signal's region is not the company's location", () => {
  // "Find 15 cybersecurity companies in Europe … posted about US expansion"
  // produced `locations: ["United States", "Europe"]` — a geography gate
  // pointing at the wrong continent, from a request that plainly said Europe.
  const m = parseLeadMissionDeterministic(
    "Find 15 cybersecurity companies in Europe hiring enterprise sellers " +
    "and whose leadership has recently posted about US expansion.");

  assertEquals(m.company_profile.locations, ["Europe"]);

  const post = m.required_signals.find((s) => s.event === "post")!;
  assertEquals(post.qualifier?.region, "us",
    "the US belongs to the signal, and must still be recorded there");
});

Deno.test("14. 'European companies expanding into the US' reads both correctly", () => {
  const m = parseLeadMissionDeterministic("Find European SaaS companies expanding into the US.");
  assertEquals(m.company_profile.locations, ["Europe"]);
  const exp = m.required_signals.find((s) => s.event === "expansion")!;
  assertEquals(exp.qualifier?.region, "us");
});

// ═════════════════════════ 15. both readers agree ═══════════════════════════

Deno.test("15. the deterministic path and a model phrase produce the same requirement", () => {
  // The two paths used to disagree by construction: one ran marker tables over
  // the sentence, the other ran `canonicalSignalType` over the model's prose
  // and kept only the head word. One reader means one answer.
  const fromSentence = readSignalsFromQuery("companies hiring enterprise sellers")[0];
  const fromModelPhrase = readSignalPhrase("hiring enterprise sellers")!;

  assert(sameRequirement(fromSentence, fromModelPhrase),
    `${JSON.stringify(fromSentence.qualifier)} vs ${JSON.stringify(fromModelPhrase.qualifier)}`);
});

Deno.test("16. reading a phrase AS a named event extracts that event's qualifiers", () => {
  // Used when a clause names several events: each is re-read as itself, so the
  // qualifiers land on the right requirement instead of on whichever matched
  // first.
  const asHiring = readSignalAs("recently funded companies hiring SDRs", "hiring")!;
  assertEquals(asHiring.event, "hiring");
  assertEquals(asHiring.qualifier.role_families, ["gtm_sales"]);

  const asFunding = readSignalAs("recently funded companies hiring SDRs", "funding")!;
  assertEquals(asFunding.event, "funding");
  assertEquals(asFunding.qualifier.role_families, undefined,
    "a role belongs to the hiring requirement, never to the funding one");
});

Deno.test("17. every requirement can state itself in a sentence a person can read", () => {
  // The plan and the shortfall both show these to a user, so an empty or
  // templated string is a reporting failure rather than a cosmetic one.
  for (const ev of SIGNAL_EVENTS) {
    const text = describeRequirement(describeSignal(ev, "company"));
    assert(text.length > 12, `${ev} describes itself as "${text}"`);
  }
  // `readSignalsFromQuery` states what the SENTENCE said; the 180-day default
  // is applied by the mission parser, so the bare reader carries no window.
  assertEquals(
    describeRequirement(one("companies whose CEO posted about US expansion")),
    'a company leader published a post about "us expansion"',
  );
});

// ═══════════ 18. a JOB posting is an opening, a person posting is a post ═════
//
// The discovery smoke's own request compiled "an open Account Executive
// posting" into a leadership POST: the noun for an opening read as social
// content, so the mission carried a requirement nothing it bought could
// answer, and no company could qualify.

Deno.test("18a. the noun 'posting' after 'job' or 'open <role>' is hiring, never a post", () => {
  const smoke = readSignalsFromQuery(
    "Find 1 US B2B software company with a current declared 11–50 employee band and an open Account Executive posting dated within 30 days.");
  assertEquals(smoke.map((d) => d.event), ["hiring"], "the smoke request asks for one opening and nothing social");
  for (const q of [
    "companies with an open Account Executive posting",
    "companies with open SDR postings",
    // A recognised role that begins with a content noun (Codex review, PR #96).
    "companies with an open Content Marketing posting",
    "companies with an open senior SDR posting",
    "companies with a job posting for SDRs",
    "companies with recent job postings",
  ]) {
    const events = readSignalsFromQuery(q).map((d) => d.event);
    assert(events.includes("hiring"), `${q}: ${events}`);
    assertFalse(events.includes("post"), `${q} read as a social post`);
  }
});

Deno.test("18b. a PERSON posting is unchanged: still a post, with its subject and topic", () => {
  assertEquals(one("companies whose CEO is posting about AI").event, "post");
  assertEquals(one("companies whose CEO is posting about AI").subject, "leadership");
  const founders = one("founders posting on LinkedIn about fundraising");
  assertEquals([founders.event, founders.subject], ["post", "leadership"]);
  // "open" followed by a preposition is not an opening.
  assertEquals(one("founders who are open to posting about hiring").event, "post");
  // A channel or a kind of content is not a role (Codex review, PR #96).
  // Read exactly as before the fix: a leadership post, and no hiring requirement.
  const ceo = one("companies whose CEO has an open LinkedIn posting about AI");
  assertEquals([ceo.event, ceo.subject], ["post", "leadership"]);
  const blog = one("founders with an open blog posting about pricing");
  assertEquals([blog.event, blog.subject, blog.qualifier.topic], ["post", "leadership", "pricing"]);
  // "open source" is software, never an opening.
  assertEquals(one("open source maintainers posting about Rust").event, "post");
  assertEquals(one("companies whose leadership posted about US expansion").event, "post");
  // A posted JOB was already hiring; it stays hiring.
  assertEquals(one("companies that posted SDR jobs").event, "hiring");
});

Deno.test("18c. the canonical reader agrees: an open-role posting is a REAL hiring cue (the P5 hiring check stays hard)", async () => {
  const { readCanonicalSignals } = await import("../../../supabase/functions/_shared/signalKinds.ts");
  const kinds = (q: string) => readCanonicalSignals(q).map((r) => r.kind);
  assertEquals(kinds(
    "Find 1 US B2B software company with a current declared 11–50 employee band and an open Account Executive posting dated within 30 days."),
    ["hiring"]);
  assertEquals(kinds("companies with a job posting for SDRs"), ["hiring"]);
  assertEquals(kinds("companies whose CEO is posting about AI"), ["social_activity"]);
  assertEquals(kinds("open source maintainers posting about Rust"), ["social_activity"]);
  assertEquals(kinds("companies whose CEO has an open LinkedIn posting about AI"), ["social_activity"]);
});
