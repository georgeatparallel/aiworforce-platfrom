# Research efficiency and evidence reuse — offline sprint

Base: `fec34976d1d88a2539a9aaf8a8e27e5fe2be923a`, the latest `launch/hardening`
inspected. Claude owns integration of #76/#77/#79/#81/#78/#80 and the
database/funding recovery work. Those branches and their files were not
modified. This sprint adds one independent runtime fix and a separate stacked
benchmark PR. No production service, paid API, live mission, migration,
configuration change, routing activation, merge or deployment was performed.

## Workflow audited

1. `missionCriteria.ts` derives mandatory requirements, preferences and windows
   from the mission. It keeps unrepresentable constraints explicit.
2. Discovery inputs go through actor contracts and the execution spine. Job
   discovery does not have company search's declared-size filter. The pool is
   deduplicated, prequalified, triaged and admitted under investigation budgets.
3. `leadGenericPrequalification.ts` excludes clearly disjoint declared bands
   only with enforceable size requirements, strong identity and suitable source
   authority, without stale/conflicting evidence. Partial overlap stays open.
4. Identity resolution establishes the employer; company-details enrichment
   batches unique LinkedIn URLs. Successful records and terminal outcomes are
   checkpointed. The defect below was in the reopened enrichment batch.
5. Qualification constructs company-scoped evidence and canonical eligibility.
   Fresh proven hard checks decide; UNKNOWN is not a match or disproof.
6. The gap router and claim verification phase use cheap hard checks first and
   re-evaluate between verifiers, so disproven candidates do not buy expensive
   downstream hiring/funding verification. Current evidence closes individual
   gaps, rather than bypassing the remaining mandatory requirements.
7. First-party collection uses URL-keyed workspace cache, intent TTLs, same-site
   and missing-page guards, map selection memory and immediate page writes.
   Grounding validates quoted source text and already completes missing facets
   from cited page lines. Canonical decisions and continuation read that proof.

The legacy conditional enrichment planner is not the live V2 stage and was not
used as evidence of a production optimization. No new routing or qualification
policy was introduced.

## Verified runtime defect: answered-empty enrichment lifecycle

An empty company-details response is already terminal **for this mission**, but
the live batch selector checked only `!c.enriched`. When another company still
needed enrichment, the reopened stage included previously answered-empty
companies. A partial success also changes the batch membership/idempotency key,
so an identical-call guard cannot prevent every repeated purchase.

A second part of the same lifecycle defect retained `provider_error` or
`deferred` after a later successful empty response. The old condition wrote
`empty` only for `not_attempted`, leaving the company incorrectly retryable.

The minimal fix excludes existing `empty` outcomes from enrichment batches and
records a newly successful empty answer as terminal, clearing only that stage's
old block. A local `lastCallAnswered` flag distinguishes a returned/adopted
answer from a guard skip: a skipped or guarded unanswered purchase must **not**
become an empty answer. Failure/deferral handling, provider-run recovery,
reservation/settlement code and all qualification rules remain unchanged.

Empty is never positive or negative qualification evidence. It does not become
MATCH or NON_MATCH. No cached fact is promoted, no TTL is widened, and no
cross-mission or cross-workspace reuse is added. A fresh independent mission
still makes its own first request. Older checkpoints without the outcome field
still get their first owed request.

The eight essential regressions fail on the original implementation and pass
with the fix. They cover reopened stages, error/deferred/first-attempt outcomes,
old checkpoints, still-failing retries, successful record retries and the
enforced execution spine retaining the original unanswered purchase guard.

## Before/after measurement

`emptyEnrichmentReplay.ts` executes the actual engine, checkpoints, restores,
execution spine, evidence graph and eligibility. Provider transports and
discovery selection are scripted: these companies and responses are synthetic,
not recorded production rows. The default benchmark explicitly enables the
execution spine; merely disabling it would overstate current V2 savings.

The 12-company enforced-spine cohort initially has one successful record, nine
answered-empty companies, and two companies in a failed batch. Before the fix,
reopening enrichment builds new batches containing the nine already-answered
companies. Those changed inputs start two additional scripted transports.
Afterward only the original unanswered batch remains; its existing reservation
continues to guard it. Those two companies remain unresolved, not answered.

| Enforced-spine synthetic cohort, 12 unique companies             | Before           | After           |
| ---------------------------------------------------------------- | ---------------- | --------------- |
| Company-details transport calls, three slices                    | 2 + 2 + 0 = 4    | 2 + 0 + 0 = 2   |
| Company URL query slots                                          | 12 + 11 + 0 = 23 | 12 + 0 + 0 = 12 |
| Repeated queries for the nine initially answered-empty companies | 9                | 0               |
| Evidence-supported qualified yield                               | 0/12 (0%)        | 0/12 (0%)       |
| UNKNOWN canonical outcomes                                       | 12/12 (100%)     | 12/12 (100%)    |
| UNKNOWN independently assigned truth                             | 12/12 (100%)     | 12/12 (100%)    |
| Known MATCH labels for false-exclusion scoring                   | 0                | 0               |
| Unsupported positives; positives with UNKNOWN truth              | 0; 0             | 0; 0            |

Two of four transport calls are avoided (2/4, 50%); nine repeated answered-empty
queries and eleven URL query slots are eliminated. These are deterministic
**synthetic** invocation counts, not measured production savings. The initial
failure's real billing is unknown. No recorded per-call pricing or settled
receipt is available, so estimated USD and cost per qualified company are null.
Zero qualified also makes the cost denominator undefined.

All canonical checks are identical before and after. False-exclusion percentage
is null (0 known MATCH denominator), not a claimed zero production error rate.
UNKNOWN labels are authored separately in `synthetic-labels.json`; the absence
of mandatory industry/hiring proof never forces a false ground-truth label.
Labels have one annotator (Codex), not external adjudication.

The 11-company legacy-mode essential control additionally reproduces 6 → 3
transport invocations and 20 → 0 initially answered-empty repeat queries. That
is kept as a separate compatibility control and is **not** the headline V2
measurement. In the enforced mode, identical completed inputs are already
blocked; the new optimization addresses changed batch composition.

`baseline.synthetic.json` was executed against the pinned original engine, not
hand-filled. Cohort/helper and label hashes prevent silently changing the
scenario while retaining old numbers. The report keeps saved source
observations, independent labels and synthetic execution results separate.

## Company-size and historical evidence audit

Existing sanitized 2026-09-24 snapshots contain 11 companies, seven with company
record bands and four with discovery-only bands. Structural matching-band
coverage for 11–50 is 7/11 (63.64%). For 11–20, 40–70 and exactly 27 it is 0/11
(0%) for each requirement; broad/partial bands cannot settle those ranges. Exact
staff evidence is 0/11 (0%). Associated LinkedIn members are not staff. Original
dates/confidence and independent staff labels are missing; they stay null. This
is neither size precision nor certification of live freshness.

The recorded interrupted `4250f181` task reports 10 discovered companies, zero
actual qualification evaluations, 0/10 (0%) qualified yield, 20 provider calls
and $0.059 historically reported USD. That reported amount is not a
reconstructed price estimate. Calls/cost per qualified remain undefined. These
selected, incomplete snapshots are not production-wide performance.

Existing Query B's regression already checks 15/21 (71.43%) disjoint-band early
exclusions and 6/21 (28.57%) admitted employers. Its mixed recorded/synthetic
posts and stubbed evaluator cannot establish real routing yield. Missing,
conflicting, stale or partially overlapping bands appropriately remain open;
there is no supported additional size exclusion or guessed-headcount fix here.

## Routing evaluation harness

`routing-recordings.json` contains zero matched recorded runs. No valid
job-first/company-first comparison is currently available.

`matchedRouting.ts` scores supplied evidence using the production evidence graph
and eligibility. A pair must have identical compiled mission hash (including
requested output/count), execution policy fingerprint (actor versions, discovery
limits and credit/candidate caps), compiled criteria, policy version,
independently reviewed evidence/opportunity snapshot, observation cutoff,
completion boundary and USD budget. It rejects missing requirements, ambiguous
multiple runs and synthetic records. Unique company/call IDs are required;
adoption/cache operations never count as new purchases. UNKNOWN truth is
separate from known labels; expired evidence stays pending. Estimated cost
requires recorded price evidence for every purchase, with a source fixture and
observation date. Dataset provenance and price references must be reviewed
before importing real records; the harness does not independently authenticate
provider receipts or annotations.

Needed observations: paired sanitized discovery responses from the same dated
opportunity universe, resolved company identities, source-backed fresh evidence,
independent mission-fit labels, canonical criteria/outcomes, completion/budget
boundaries, and execution/purchase/adoption traces with cited actual pricing. Do
not infer a purchase from a final `reused` status or silently pair merely
similar user queries. Unit inputs exercising the gate are synthetic controls
even when their flags simulate a recorded import; they are not dataset rows.

## Further verified limitation and proposals

Two different missing URLs of the same intent have empty stored text and the
same `content_hash`. The current upsert/index identity
`workspace_id,domain,page_intent,content_hash` can preserve only one of them.
The offline two-URL control confirms that collision. URL-keyed reads then lack
one negative observation, which can invite another fetch. No live prevalence,
cost or calls-avoided estimate is claimed. Resolving durable page identity needs
a reviewed schema/data compatibility proposal; no migration or production cache
identity change was made, and Claude's database work was not edited.

Other hypotheses requiring matched/live evidence: savings from company-first
size filtering, cache-first re-grounding before additional page discovery, and
closing cheap firmographic gaps before all enrichment. Skipping collection
merely because a business-model item is proven can hide an unresolved requested
vertical; URL-only re-grounding dedupe also cannot detect changed page content.
Those are not safely implemented on this fixture evidence alone.

Priorities: integrate the narrow empty-answer fix; gather matched completed
missions and real prices; review URL-aware negative-cache identity separately;
then measure early company-first filtering without activating it from synthetic
results. Keep all hard requirements and missing-evidence states intact.

## Validation

On the base plus this sprint: backend 8,571 passed; Replay Lab 199 passed, zero
failed, one pre-existing ignored display-only funding-headline gap; targeted
regression 295 passed. Eight essential runtime tests and eight benchmark
controls passed, with relevant types, focused lint and formatting clean
(URL-import lint rule excluded consistently with existing tests).

A disposable patch-combined checkout also applied this sprint cleanly beside
Claude's #76 (`4665e617`), #77 (`096a03df`), #79 (`2936092e`), #81 (`bb7b5364`),
#78 (`151af184`) and #80 (`ecffb8c0`). Backend 8,620 passed; Replay Lab 214
passed with the same one ignored display gap; targeted regression 326 passed; 49
combined type-check targets passed. The final matched-routing guards were then
rerun in that checkout as focused benchmark tests. No Claude branch or PR was
edited. Real database-contract integration checks remain with Claude; this
sprint did not run a production or local Supabase service as a substitute.

Run offline:

```sh
deno test --cached-only --allow-read --allow-env tests/edge-functions/_shared/emptyEnrichmentReuse.test.ts
deno test --cached-only --allow-read --allow-env tests/replay/efficiency/
deno run --cached-only --allow-read --allow-env tests/replay/efficiency/researchBenchmark.ts
npm run test:lead-v2-regression
```

Delivery: the runtime PR changes only the engine's empty-answer lifecycle and
its essential replay/tests. This benchmark PR is stacked on the runtime branch
and changes only this directory. After the runtime change is integrated,
rebase/retarget the benchmark without duplicating its ancestor. #78/#80 remain
Claude's integration work; no files from their branches were copied.
