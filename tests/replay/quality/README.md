# Discovery quality measurement batch

This is an offline, test-only benchmark on a **small, selected historical
fixture sample**. It does not estimate production-wide accuracy. No service,
paid model, provider, deployment, mission worker or production database is
invoked.

```sh
# Reproducible JSON with counts and denominators on every percentage.
deno run --allow-read tests/replay/quality/benchmark.ts > /tmp/discovery-quality.json
# Metric/provenance controls and current-code interruption characterization.
deno test --allow-read --allow-env tests/replay/quality/
# Explicit red specification of the unfixed recovery behavior (expected exit 1).
RUN_FUNDING_SCREEN_RECOVERY_SPEC=1 deno test --allow-read --allow-env \
  tests/replay/quality/fundingInterruption.test.ts
```

The report is deterministic. Dates, requirements and budgets are explicit; the
interruption replay freezes Date at 2026-10-14T12:00Z and disables `fetch`.
Neither command grants application network permission.

## Dataset and labels

Separate files prevent mixing provenance:

- `recorded-evidence.json`: 21 captured descriptions from existing committed
  sources. Eleven are rebuilt normalized company-size canary snapshots from
  2026-09-24; ten are normalized company descriptions in task `4250f181`'s
  2026-09-13 snapshot. Source file and row key are preserved. Descriptions are
  copied, capped at 2,000 characters and email strings redacted; company
  statements have not been independently fact-checked.
- `independent-labels.json`: evidence-interpretation annotations assigned before
  executing the predictor, using product, customer and business activity
  statements. These are single-annotator Codex labels, **not production model
  outputs**, external ground truth, or an inter-rater reliability study. Every
  label carries a rationale and confidence. Review is possible by joining the id
  to the separate evidence file.
- `recorded-verifier-outputs.json`: an explicitly empty recorded-output dataset.
  The runner can join future captured predictions to the independent labels by
  id, requires source references and recorded provenance, and rejects
  duplicates. Missing output is excluded from verifier evaluation, never
  fabricated as an UNKNOWN prediction. Real captured UNKNOWN predictions remain
  explicit.
- `synthetic-controls.json`: hand-written controls for MATCH/NON_MATCH/UNKNOWN,
  exact headcount, band overlap, and accounting/comparability. They do not enter
  recorded sample metrics.

The industry target is **B2B software**, not the stricter B2B SaaS requirement.
MATCH requires stated product delivery and a business customer/use. NON_MATCH
requires affirmative evidence of a different primary offering. UNKNOWN remains
explicit for missing or ambiguous information. Lab0's product-versus-custom
implementation, Every's product-versus-services delivery, a bare How to AI link,
Psychology Today's mixed magazine/directory activity and DeepLearning.AI's
customer/product mix stay UNKNOWN. Names and LinkedIn industry categories are
not used to manufacture a label.

### What the industry number actually measures

The predictor is the production `matchBusinessModel` **evidence-facet
primitive** applied to the saved description text. This is a diagnostic of that
primitive's controlled vocabulary over these texts, **not the model-grounded
industry verifier**, end-to-end discovery, or the engine's decision to qualify a
company. The normal engine supplies grounded normalized claims to this primitive
rather than treating an entire description as verified proof. No fresh model
output or synthetic grounder answer is disguised as recorded inference.

There are **0/21 (0%)** complete recorded model-verifier output pairs for this
cohort. End-to-end verifier precision/recall is therefore unavailable. To
measure it, obtain sanctioned offline captures of validated claims, supporting
page excerpts, unknown/negative outcomes and observation times for these same
labeled companies. No live extraction is requested in this PR.

## Metrics and denominators

Every percentage is serialized as `{ numerator, denominator, percentage }`. Zero
denominators produce `null`, not zero or perfect accuracy. Precision excludes
UNKNOWN truth; predicted positives on UNKNOWN truth are disclosed separately.
Recall includes every known MATCH in its denominator, including prediction
abstentions. Those abstentions are counted separately from NON_MATCH errors.

| Recorded diagnostic                         | Result                                                                   | Important limit                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Industry labels                             | 8 MATCH, 8 NON_MATCH, 5 UNKNOWN; total 21                                | Single-annotator, selected examples                                                                     |
| Industry label coverage                     | 16/21 (76.19%); UNKNOWN 5/21 (23.81%)                                    | UNKNOWN is excluded from precision/recall                                                               |
| Evidence-facet primitive precision          | 1/1 (100%)                                                               | Only **one** decidable predicted positive; not a robust accuracy estimate                               |
| Primitive recall                            | 1/8 (12.50%)                                                             | Six true matches abstained; one predicted NON_MATCH                                                     |
| Primitive prediction coverage               | 6/21 (28.57%); UNKNOWN predictions 15/21 (71.43%)                        | One of two positive predictions is on UNKNOWN truth: 1/2 (50%)                                          |
| Declared 11–50 band precision               | 7/7 (100%)                                                               | No labeled negatives in this selected band cohort                                                       |
| Band-level sufficient-evidence coverage     | 7/11 (63.64%); UNKNOWN 4/11 (36.36%)                                     | Four search-only bands are not company-record proof                                                     |
| Narrow 11–20 and 40–70 range proof          | Each 0/11 (0%) coverage; UNKNOWN 11/11 (100%); precision 0/0 (undefined) | Overlap/coarse bands do not prove the narrower range                                                    |
| Exact staff-count availability              | 0/11 (0%); evaluation count 0, precision 0/0 (undefined)                 | LinkedIn associated members are not staff headcount                                                     |
| Original provider observation-date coverage | 0/11 (0%)                                                                | Snapshot capture-date coverage is 11/11 (100%); these dates are not substituted                         |
| Captured task 4250f181 discovery yield      | 0/10 (0%) qualified/discovered                                           | One unfinished captured task, not a complete lineage or route population                                |
| Task provider calls per qualified company   | 20/0 (undefined)                                                         | Twenty distinct captured provider run ids; matches the saved summary                                    |
| Provider estimate coverage                  | 0/20 (0%)                                                                | Provider estimates are missing; the $0.059 historical reported total is not substituted for an estimate |
| Estimated cost per qualified company        | Missing estimate / 0 qualified (undefined)                               | No fabricated free, refunded or receipt-settled cost                                                    |

An exact count and a band are separate evidence types. Each evidence row records
source, original observation date (null when missing), snapshot date, type and
confidence. The band diagnostic tests compatibility at the captured snapshot; it
does not assess original observation freshness. A broad band supports a matching
band-level requirement; a partial overlap or narrow range remains UNKNOWN.

The low primitive recall illustrates why vocabulary/description diagnostics must
not be called end-to-end verifier performance. For example, Gojiberry's recorded
product description says it replaces agencies; matching the raw text can
interpret the mention of agencies as service delivery. The independently
assigned product/customer label remains unchanged. This is a diagnostic input
limitation, not proof that the grounded production verifier rejects Gojiberry.

## Routing and synthetic accounting

**A valid recorded routing comparison is unavailable: 0 matched pairs.**
Existing job-first and company-first captures differ in mission, date, budget,
population and accounting boundary. The comparator rejects differences in any of
those fields; it does not turn two different canaries into an experiment.

Synthetic cost-model plans impose the same four-company population and one
qualified result with matching requirements, date and budget. The production
actor cost estimator prices the explicit mock inputs. These plans test
comparability and accounting only: they are hand-written plans with imposed
outcomes, **not executed routing-engine results or real performance**. Their
estimates and calls/qualified ratios are emitted in `synthetic_controls`, never
pooled with recorded measurements. Synthetic exact-count controls likewise do
not create exact-count evidence for real companies.

## Funding-screen investigation and recommendation

See `FUNDING_SCREEN_RECOVERY.md`. Current production code reproduces a lost
Atomus screen result even after D3's discovery-run adoption fix. Two controls
pass; the separate recovery specification is skipped in normal suites and was
explicitly executed to produce its deterministic failure. The report does not
claim that this red specification passed or that recovery is implemented.

Before broad performance conclusions, review the label rubric and annotations,
add dated exact-headcount sources if exact requirements are needed, and supply
matched route captures with provider estimates/receipts and full-lineage
outcomes. More source data can be supplied offline. No routing, qualification,
billing or production recovery changes are made by this batch.
