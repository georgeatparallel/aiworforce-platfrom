// WHAT A CHECKPOINT STORES FOR ONE COMPANY — slim, and read back as it was.
//
// Query B canaries d22d9ee6 and eb0d520f: companies closed at discovery were
// most of a 2 MB task result. `slimResumeRecord` stores a closed company with
// one statement per dimension (every distinct size band) and no job rows, and
// every company with no more observations than the reader restores;
// `compactCheckpointCompanies` then stores each repeated snapshot value once.
// These tests pin the record- and checkpoint-level rules; the
// lineage-level proof that decisions do not change is
// tests/replay/historical/M_checkpointSlimming.test.ts.
//
// PURE.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCheckpoint, CHECKPOINT_COMPACT_VERSION, CHECKPOINT_RESULT_KEY, compactCheckpointCompanies, compactObservation,
  type CompanyResumeRecord, expandObservation, expandSnapshotRefs, internSnapshots, MAX_SNAPSHOT_OBSERVATIONS,
  newCompanyRecord, readCheckpointCompanies, recordIsClosed, RESUME_STATE_VERSION, slimResumeRecord,
} from "../../../supabase/functions/_shared/leadResumeState.ts";
import { readFactsFromResult } from "../../../supabase/functions/_shared/runOutcome.ts";
import { mergeLineageState } from "../../../supabase/functions/_shared/lineageStateMerge.ts";
import { discoverySizeRejectBlocker } from "../../../supabase/functions/_shared/leadGenericPrequalification.ts";

const AT = "2026-10-13T07:30:00.000Z";
const ev = (dimension: string, value: unknown, o: Record<string, unknown> = {}) => ({
  evidence_id: `ev_${dimension}_${JSON.stringify(value).length}_${o.n ?? 0}`,
  company_key: "https://www.linkedin.com/company/outband-001",
  dimension, value, status: o.status ?? "plausible",
  source: { provider: "apify", actor: "apify_linkedin_job_search", provider_call_id: `pc_${o.call ?? 1}`, url: null, excerpt: null },
  method: o.method ?? "provider_field", observed_at: AT, valid_until: null, confidence: "medium",
  derived_from: [], mission_id: "d22d9ee6", origin: "lead_mission",
  ...(o.authority ? { authority: { version: "evidence-authority-v1", claim: dimension, level: "plausible" } } : {}),
});
const band = (min: number, max: number) => ({ min, max, source: "linkedin_job_company" });
/** One sighting: one job row, restating the company facts. */
const sighting = (n: number, title: string, sizeBand = band(1001, 5000)) => ({
  version: "candidate-observation-v1", observation_id: `obs_${n}`, capability: "job_discovery",
  actor_key: "apify_linkedin_job_search", provider: "apify", route_id: "job_discovery:apify_linkedin_job_search",
  plan_version: 1, provider_call_id: `pc_${n}`, source_record_id: `job-${n}`, source_url: "https://www.linkedin.com/company/outband-001",
  observed_at: AT, entity_hint: { linkedin_company_url: "https://www.linkedin.com/company/outband-001", name: "Outband Software 001" },
  evidence: [
    ev("identity", { name: "Outband Software 001" }, { status: "proven", call: n }),
    ev("geography", "Austin, TX, United States", { authority: true, call: n }),
    ev("company_size_band", sizeBand, { authority: true, call: n }),
    ev("industry", "Software Development", { authority: true, call: n }),
    ev("job", { title }, { status: "proven", call: n, n }),
    ev("hiring", true, { status: "proven", method: "deterministic_derivation", call: n }),
  ],
});

function closedRecord(observations: Record<string, unknown>[]): CompanyResumeRecord {
  return {
    ...newCompanyRecord("outband-001.example", "Outband Software 001"),
    snapshot: {
      company: { company_name: "Outband Software 001", canonical_domain: "outband-001.example" },
      yc_open_jobs: [{ job_id: "li_job:job-1", title: "Account Executive" }],
      prequalified: { eligible: false, exclusion: "employee_size", size_status: "above_max" },
      prequal_key: "outband-001.example", shortlisted: false,
      investigation_state: "excluded_permanently",
      shortlist_exclusion: "mission_constraint:employee_size_disjoint_at_discovery",
      investigation_rank: null, triage: null, enriched: null, enrichment_outcome: null, identity: null,
      hiring_assessment: null, hiring_jobs: [], brain: null, mission_evaluation: null,
      found_by: [], observations, identity_conflicts: [],
    },
  } as CompanyResumeRecord;
}
const openRecord = (observations: Record<string, unknown>[]): CompanyResumeRecord => {
  const r = closedRecord(observations);
  return { ...r, snapshot: { ...r.snapshot!, investigation_state: "investigated", identity: { status: "resolved" } } };
};
const readBack = (records: CompanyResumeRecord[]) =>
  readCheckpointCompanies(JSON.parse(JSON.stringify({
    [CHECKPOINT_RESULT_KEY]: buildCheckpoint({
      now: 0, deadlineAt: 0, remainingMs: 0, lastCompletedCapability: null, nextPendingCapability: null,
      companies: records, reason: "execution_deadline_checkpoint",
    }),
  })));

Deno.test("only a company closed before any paid stage is slimmed as closed", () => {
  assert(recordIsClosed(closedRecord([])));
  assertFalse(recordIsClosed(openRecord([])), "a resolved identity was paid for");
  const pending = closedRecord([]);
  assertFalse(recordIsClosed({ ...pending, snapshot: { ...pending.snapshot!, investigation_state: "pending_investigation" } }));
});

Deno.test("a closed company keeps one statement per dimension, every distinct size band, and no job rows", () => {
  const obs = [sighting(1, "Account Executive"), sighting(2, "SDR", band(11, 50)), sighting(3, "BDR")];
  const slim = slimResumeRecord(closedRecord(obs));
  assertEquals(slim.snapshot!.yc_open_jobs, []);
  const kept = slim.snapshot!.observations!.map(expandObservation)
    .flatMap((o) => (o.evidence as Array<Record<string, unknown>>));
  const dims = kept.map((e) => String(e.dimension));
  assertEquals(new Set(dims), new Set(["identity", "geography", "company_size_band", "industry", "job", "hiring"]), "every dimension survives");
  assertEquals(dims.filter((d) => d !== "company_size_band").length, new Set(dims.filter((d) => d !== "company_size_band")).size, "once each");
  assertEquals(kept.filter((e) => e.dimension === "company_size_band").map((e) => e.value), [band(1001, 5000), band(11, 50)], "both bands");
  assertEquals(kept.find((e) => e.dimension === "job")!.value, { title: "Account Executive" }, "the first statement is the one kept");
  assertEquals(slim.snapshot!.observations!.map((o) => o.observation_id), ["obs_1", "obs_2", "obs_3"], "every observation keeps its identity");
  assert(JSON.stringify(slim).length < JSON.stringify(closedRecord(obs)).length * 0.6);
});

Deno.test("a later sighting's DIFFERENT size band is a different fact: the discovery-time reject stays blocked", () => {
  const obs = [sighting(1, "AE"), sighting(2, "SDR", band(11, 50))];
  const back = readBack([closedRecord(obs)])[0];
  assertEquals(discoverySizeRejectBlocker({ observations: back.snapshot!.observations! } as never), "size_band_disagreement");
  assertEquals(discoverySizeRejectBlocker({ observations: obs } as never), "size_band_disagreement");
});

Deno.test("compaction is an exact inverse — key order included, optional fields included", () => {
  for (const o of [sighting(1, "AE"), sighting(2, "SDR", band(11, 50))]) {
    const c = compactObservation(o);
    assert("evidence_shared" in c, "provenance shared by every item is written once");
    assertEquals(JSON.stringify(expandObservation(c)), JSON.stringify(o));
  }
  const single = { ...sighting(1, "AE"), evidence: [ev("job", { title: "AE" })] };
  assertEquals(compactObservation(single), single, "nothing to share with one item");
});

Deno.test("an open company is stored whole, bounded to what the reader restores", () => {
  const obs = Array.from({ length: MAX_SNAPSHOT_OBSERVATIONS + 3 }, (_, i) => sighting(i + 1, `Role ${i}`));
  const slim = slimResumeRecord(openRecord(obs));
  assertEquals(slim.snapshot!.observations!, obs.slice(0, MAX_SNAPSHOT_OBSERVATIONS));
  assertEquals(slim.snapshot!.yc_open_jobs, openRecord(obs).snapshot!.yc_open_jobs);
  assertEquals(readBack([openRecord(obs)])[0].snapshot!.observations!, obs.slice(0, MAX_SNAPSHOT_OBSERVATIONS));
});

Deno.test("slimming is idempotent, and a slim checkpoint read back and slimmed again is unchanged", () => {
  const r = closedRecord([sighting(1, "AE"), sighting(2, "SDR")]);
  const once = slimResumeRecord(r);
  assertEquals(slimResumeRecord(once), once);
  const back = readBack([r]);
  assertEquals(JSON.stringify(slimResumeRecord(back[0]).snapshot), JSON.stringify(once.snapshot));
});

Deno.test("a checkpoint the previous writer stored (no compaction) still reads exactly as before", () => {
  const obs = [sighting(1, "AE"), sighting(2, "SDR")];
  const old = { [CHECKPOINT_RESULT_KEY]: { version: RESUME_STATE_VERSION, companies: [closedRecord(obs)] } };
  assertEquals(readCheckpointCompanies(JSON.parse(JSON.stringify(old)))[0].snapshot!.observations!, obs);
});

Deno.test("the lineage state's copy is slim too — the merge does not re-expand it", () => {
  const r = closedRecord([sighting(1, "AE"), sighting(2, "SDR"), sighting(3, "BDR")]);
  const cp = (records: CompanyResumeRecord[]) => ({
    [CHECKPOINT_RESULT_KEY]: buildCheckpoint({ now: 0, deadlineAt: 0, remainingMs: 0, lastCompletedCapability: null, nextPendingCapability: null, companies: records, reason: "execution_deadline_checkpoint" }),
  });
  const first = mergeLineageState(null, cp([r])).state;
  const second = mergeLineageState(JSON.parse(JSON.stringify(first)), cp([r])).state;
  const stored = (second[CHECKPOINT_RESULT_KEY] as { companies: CompanyResumeRecord[] }).companies[0];
  assertEquals((second[CHECKPOINT_RESULT_KEY] as { version: string }).version, CHECKPOINT_COMPACT_VERSION);
  assertEquals(readCheckpointCompanies(second)[0].snapshot!.yc_open_jobs, []);
  // The reader normalises a record (field order, `invalidated_stages`), so the
  // copies are compared as read back, and the merged copy must not grow.
  assertEquals(readCheckpointCompanies(second), readCheckpointCompanies(first));
  const bytes = (st: Record<string, unknown>) => JSON.stringify((st[CHECKPOINT_RESULT_KEY] as { companies: unknown[] }).companies).length;
  assert(bytes(second) <= bytes(first) + 64, `${bytes(second)} vs ${bytes(first)}`);
});

// ── the dictionary ──────────────────────────────────────────────────────────

const many = () => Array.from({ length: 6 }, (_, i) => ({
  ...closedRecord([sighting(1, "AE"), sighting(2, "SDR")]),
  company_key: `outband-00${i}.example`,
}));

Deno.test("dictionary: a repeated snapshot value is stored once, and the checkpoint reads back exactly", () => {
  const records = many().map(slimResumeRecord);
  const { companies, dictionary } = internSnapshots(records);
  assert(dictionary.length > 0);
  assert(JSON.stringify({ companies, dictionary }).length < JSON.stringify(records).length * 0.6);
  for (let i = 0; i < records.length; i++) {
    assertEquals(JSON.stringify(expandSnapshotRefs(companies[i].snapshot, dictionary)), JSON.stringify(records[i].snapshot));
  }
  assertEquals(readBack(many()), readBack(many()).map((r) => r), "deterministic");
});

Deno.test("dictionary: every reference is rebuilt as its own copy — editing one company never edits another", () => {
  const back = readBack(many());
  const a = back[0].snapshot!.observations![0] as Record<string, unknown>;
  (a.entity_hint as Record<string, unknown>).name = "edited";
  assertEquals((back[1].snapshot!.observations![0].entity_hint as Record<string, unknown>).name, "Outband Software 001");
});

Deno.test("dictionary: the stage labels outside the snapshot stay plain — runOutcome reads them unexpanded", () => {
  const hired = many().map((r, i) => i === 0 ? { ...r, hiring: "verified_from_existing_evidence" as const } : r);
  const result = JSON.parse(JSON.stringify({ [CHECKPOINT_RESULT_KEY]: buildCheckpoint({ now: 0, deadlineAt: 0, remainingMs: 0, lastCompletedCapability: null, nextPendingCapability: null, companies: [...hired, { ...hired[0], company_key: "x.example" }], reason: "execution_deadline_checkpoint" }) }));
  const stored = result[CHECKPOINT_RESULT_KEY].companies as Array<Record<string, unknown>>;
  assertEquals(stored.filter((c) => c.hiring === "verified_from_existing_evidence").length, 2);
  assertEquals(readFactsFromResult(result, 3).requested, 3);
});

Deno.test("dictionary: a literal `$ref` key in the data is never mistaken for a reference", () => {
  const odd = many().map((r) => ({ ...r, snapshot: { ...r.snapshot!, triage: { $ref: 0 } } }));
  const out = compactCheckpointCompanies(odd);
  assertEquals(out.snapshot_dictionary, []);
  assertEquals(readCheckpointCompanies(JSON.parse(JSON.stringify({ [CHECKPOINT_RESULT_KEY]: out })))[0].snapshot!.triage, { $ref: 0 });
});

Deno.test("dictionary: a compacted checkpoint carries its own version, which a reader accepting only RESUME_STATE_VERSION (86ac1b92) refuses", () => {
  const stored = JSON.parse(JSON.stringify({ [CHECKPOINT_RESULT_KEY]: buildCheckpoint({ now: 0, deadlineAt: 0, remainingMs: 0, lastCompletedCapability: null, nextPendingCapability: null, companies: many(), reason: "execution_deadline_checkpoint" }) }));
  // The previous reader accepted exactly RESUME_STATE_VERSION.
  assert(stored[CHECKPOINT_RESULT_KEY].version !== RESUME_STATE_VERSION);
  assertEquals(stored[CHECKPOINT_RESULT_KEY].version, CHECKPOINT_COMPACT_VERSION);
  assertEquals(readCheckpointCompanies(stored).length, 6, "this reader accepts it");
});
