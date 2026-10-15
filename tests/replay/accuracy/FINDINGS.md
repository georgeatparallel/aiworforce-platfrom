# Discovery accuracy sprint — offline evidence investigation

Base inspected: `fec34976d1d88a2539a9aaf8a8e27e5fe2be923a`, latest
`launch/hardening` at investigation time. No production service, provider,
model, database, deployment or live mission was used.

## Delivery and dependencies

The runtime change is in `codex/discovery-evidence-accuracy`: only
`businessModelMatch.ts` and its essential regression tests. This benchmark PR is
stacked on that branch and contains only this directory. Merge/rebase the
runtime PR first, then retarget this PR to `launch/hardening` so its diff stays
test-only. Neither PR copies the unmerged files from #74 or #75. Their findings
are referenced below; #75 remains the owner of its 21-company label set and
funding interruption reproduction. Claude's #77 owns funding recovery and #76
owns database-contract CI. None of those branches were modified.

## What the 1/8 industry result means

PR #75's diagnostic compares the raw `matchBusinessModel` primitive against
manually assigned B2B-software labels. It does not replay the production
grounder's full answers, source registry, facet completion and eligibility. Of
21 descriptions, 8 were MATCH, 8 NON_MATCH and 5 UNKNOWN. Its known-label
precision was 1/1 (100%), recall 1/8 (12.5%), decision coverage 6/21 (28.57%),
and unknown ground truth 5/21 (23.81%). UNKNOWN predictions were 15/21 (71.43%).
One additional positive had UNKNOWN truth and was outside the precision
denominator. Those single-annotator, selected historical descriptions are not a
production accuracy sample. This sprint does not report an invented before/after
improvement for those companies.

The full grounder validates excerpts against company-specific source text and
requires the facets asserted by the proposed business-model code. It already
reuses verbatim lines on validated claims' cited pages through `completeFacets`
without purchasing additional evidence (`facetCompletion.test.ts` covers real
cached Fuse pricing lines). Broad LinkedIn tags, a platform tagline, unstated
SaaS delivery, negated excerpts and contradictory offerings are appropriately
unresolved. General verticals beyond the controlled vocabulary also remain
unresolved; a software-business-model test is not a vertical precision test.

## Reproduced runtime defect and fix

An explicit buyer phrase contributed the customer's delivery and AI words to the
vendor's offering. For example, “Our cloud-based SaaS software is built for
staffing agencies” incorrectly became `mixed_delivery`. A consultant serving
SaaS companies was similarly read as both services and SaaS. AI customers could
also contribute an unsupported vendor AI facet.

The fix masks only the existing bounded explicit business-buyer relation while
reading offering facets. The original quote remains intact for source checking,
audience and negation. No new vocabulary, inferred software/SaaS/AI facts,
confidence threshold or qualification/routing rule was added. Genuine mixed
delivery and missing/contradictory evidence still require review. The six
runtime regressions ran against the original implementation: 1 passed and 5
failed. With the fix: 6 passed and 0 failed.

These reproduced quotes are **synthetic controls**, not purported production
companies or model answers. The actual production defect is the deterministic
reader's treatment of these otherwise valid quoted inputs. No production-wide
incidence or savings can be established from them.

## Requirement interpretation and efficiency

`missionCriteria.ts` separates mandatory requirements, preferences, signals and
hypotheses; unhedged user hiring requests are hard requirements, while hedged
preferences remain targets. `candidateEligibility.ts` uses proven current
evidence for hard pass/fail; missing, expired, merely reported or conflicting
evidence remains UNKNOWN. Geography is evaluated through geography claims.
Funding uses verified round kind, requested stage and recency semantics;
non-equity assistance is not venture-stage proof. Hiring uses employer-owned
postings, requested role families and dates. Industry acceptance cannot replace
any missing geography, funding or hiring proof (new end-to-end checks cover
these gaps). No interpretation policy was changed.

The LinkedIn job-search actor does not provide the equivalent company-size
filter available to company search. Jobs are therefore capable of surfacing
employers of many sizes. Existing `leadGenericPrequalification.ts` already
rejects a clearly disjoint directly declared band on a strong company identity
before buying enrichment, unless conflicts, stale sources or weak identity
prevent the rejection. Partial overlap and missing bands are appropriately
retained. Existing provider input/spec deduplication, evidence reuse and durable
purchase recovery cover redundant calls; this investigation did not establish an
additional safe runtime efficiency defect.

The current Query B replay's first-page regression asserts 21 employers, 15/21
(71.43%) disjoint-band early exclusions, 6/21 (28.57%) admitted, and one batched
company-details fixture call. Its provenance includes synthetic postings/pages
and its evaluator is stubbed. Those are replay invariants, **not measured
production qualification yield or routing savings**. No routing change was
activated and no efficacy claim is based on its stubbed qualifiers.

## Benchmark methodology

`synthetic-evidence.json` holds invented reserved-domain source rows, fixed
observation dates, imposed employee bands and simulated model proposals.
`synthetic-labels.json` holds separately authored expectations based on the
offering/customer evidence. Labels were assigned before running the classifier
but have only one annotator (Codex); they are not externally adjudicated.
`baseline.synthetic.json` was generated by executing these exact controls
against the pre-fix implementation at the pinned base commit. Fixture hashes
prevent silently changing the cohort while retaining its baseline.

`benchmark.ts` runs the real evidence registry, excerpt verifier,
`groundedBusinessModelItem`, evidence graph and eligibility. Its synthetic
mission requires B2B software and a matching 11–50 declared band. “Qualified”
means eligible for **that two-requirement synthetic mission only**. Positive
proof still has a cited source, observation date and medium confidence. A
separate safeguard test adds mandatory geography/funding/hiring individually;
all remain pending without their proof.

Precision = supported positive predictions / positive predictions with known
truth. Recall = supported positive predictions / all known MATCH labels,
including abstentions. UNKNOWN truth is never forced into MATCH/NON_MATCH and is
reported separately, including any positive prediction on UNKNOWN truth. False
exclusions mean a hard NON_MATCH on MATCH truth; unresolved known matches are
counted separately. Coverage reports answered checks / all checks; support
coverage counts passing checks only. Every percentage carries its numerator and
denominator; a zero denominator yields null, not zero or infinity.

| Synthetic controls only (10 rows)                   | Before      | After       |
| --------------------------------------------------- | ----------- | ----------- |
| Known labels                                        | 6/10        | 6/10        |
| UNKNOWN truth                                       | 4/10 (40%)  | 4/10 (40%)  |
| UNKNOWN predictions                                 | 8/10 (80%)  | 4/10 (40%)  |
| Industry precision                                  | 1/1 (100%)  | 4/4 (100%)  |
| Industry recall                                     | 1/4 (25%)   | 4/4 (100%)  |
| Industry decision coverage                          | 2/10 (20%)  | 6/10 (60%)  |
| Supported positives                                 | 1           | 4           |
| Unsupported positives; positives with UNKNOWN truth | 0; 0        | 0; 0        |
| False exclusions; unresolved known matches          | 0; 3        | 0; 0        |
| Synthetic qualified yield                           | 1/10 (10%)  | 4/10 (40%)  |
| Mandatory decision coverage                         | 12/20 (60%) | 16/20 (80%) |
| Mandatory support coverage                          | 11/20 (55%) | 14/20 (70%) |

These targeted controls isolate the reader defect; they do not estimate real
model recall, candidate yield, provider savings or production-wide accuracy.

## Recorded measurements and unavailable comparisons

Recorded inputs are read in place from existing sanitized fixtures, separately
from synthetic controls. The 2026-09-24 size snapshot contains 11 companies: 7
company-record bands and 4 discovery-only bands. Band evidence sufficient to
answer 11–50 is 7/11 (63.64%), with 4/11 (36.36%) UNKNOWN. Evidence sufficient
to answer 11–20 or 40–70 is 0/11 (0%), with 11/11 (100%) UNKNOWN for each range.
Exact staff-count coverage is 0/11 (0%); associated LinkedIn members are not
headcount. Original observation dates and confidence were not preserved and
remain null; snapshot date is reported separately. This is structural evidence
coverage, not a live freshness certification. Recorded size precision is null:
there are no independent headcount/size labels against which to score it.
Synthetic size fixtures in #75 test semantics separately, not real precision.

The interrupted recorded task `4250f181` reports 10 discovered companies, 0
qualification evaluations, 0/10 (0%) qualified yield and 20 provider calls.
Calls per qualified company is undefined (zero qualified). The historical USD
reported is $0.059; per-call pricing/estimate evidence is absent, so estimated
USD and estimated USD per qualified company remain null. This unfinished,
identity-unresolved run does not establish industry accuracy or completed-run
performance.

Recorded mandatory-requirement coverage is also unavailable: this interrupted
run lacks an aligned per-candidate canonical proof table for the benchmark. Only
the synthetic cohort's actual eligibility checks are scored above.

There are 0 matched recorded job-first/company-first pairs: no comparison is
valid. Needed: the same compiled mission/size requirements, equivalent dated
candidate and evidence snapshots, equivalent completion boundary, canonical
hard-check outcomes, and priced call traces for both strategies. #75's hand cost
plans remain synthetic; this batch does not relabel them as measured results.
Similarly there are 0 paired independently labeled **full grounded** recorded
industry answers in this benchmark. Production precision/recall and cost/yield
improvements remain unavailable.

## Validation and recommendations

Runtime validation: 8,569 backend tests passed; existing Replay Lab 191 passed
with one documented ignored gap; targeted regression suite 295 passed. Runtime
type checks and focused lint passed (excluding `no-import-prefix`, matching the
repository's existing URL-based test imports). New benchmark assertions cover
metrics, UNKNOWN denominators, cited proof, mandatory gaps, band coverage,
missing staff counts and unavailable routing/cost results: 5 passed. The full
Replay Lab with this extension passed 196 tests with the same one ignored
display-only NEA headline gap. Benchmark type checks, focused lint and
formatting passed. All replay/test commands omit network permission.

Run the benchmark and its tests:

```sh
deno run --cached-only --allow-read tests/replay/accuracy/benchmark.ts
deno test --cached-only --allow-read --allow-env tests/replay/accuracy/
npm run test:lead-v2-regression
```

The baseline can be regenerated in a checkout at the documented base, with these
benchmark files available, using `benchmark.ts --snapshot`; never pass synthetic
baseline output off as recorded production evidence.

A size-filtered company-first experiment is plausible when the requirement
matches a supported whole employee band, but approval and matched evidence are
needed before activating a new routing policy. Narrow partially overlapping
ranges need stronger headcount evidence or an explicit user-approved change to
the requested range; do not silently widen them. Broader vertical mapping,
sentence-level negation handling and new evidence purchases require their own
evidence evaluation/policy review. Continue retaining UNKNOWN.

Later authorized live validation should measure real full-grounder answers with
independently reviewed product/customer/activity labels, exact versus band
evidence, complete canonical qualification and settled provider costs on matched
missions. This sprint performs none of those live operations. Funding
interruption recovery should be validated through Claude's #77 independently;
the #75 reproduction is retained without competing production changes here.
