// LEAD V2 PAYLOAD BENCHMARK — what a slice writes, before and after slimming.
//
// Replays a recorded lineage twice through the persisted checkpoint
// (tests/replay/lib/slim.ts): once storing what the previous writer stored,
// once storing what this code stores. Per slice it measures the
// engine-derived parts of the task result as run-agent assembles them
// (engine state, resume checkpoint, research fabric, Workbench view), the
// lineage state the release writes, and how many times the whole task result
// is rewritten.
//
//   deno run -A tests/replay/bench/payloadBench.ts [fixture] [--breakdown] [--json]
//
// PURE. Zero provider calls, zero model calls. Byte counts, not database
// latency: what a write costs the database is not measurable offline.

import { buildCheckpoint, CHECKPOINT_RESULT_KEY, readCheckpointCompanies } from "../../../supabase/functions/_shared/leadResumeState.ts";
import { mergeLineageState } from "../../../supabase/functions/_shared/lineageStateMerge.ts";
import { projectResearchFabric, researchFabricSummary } from "../../../supabase/functions/_shared/leadCapabilityEngine.ts";
import { largestFields, payloadBytes } from "../../../supabase/functions/_shared/payloadSize.ts";
import { loadFixture } from "../lib/fixture.ts";
import { type LineageFixture, replayLineage } from "../lib/lineage.ts";
import { missionOf, type EngineSlice } from "../lib/engine.ts";
import { companyIsClosed, persistedCarrier, previousWriter } from "../lib/slim.ts";
import { canonicalView } from "../lib/verification.ts";

type Rec = Record<string, unknown>;

/**
 * Whole-task-result rewrites in one slice besides the stage-boundary writes:
 * paid preflight, the company-first sourcing checkpoint, the slice result and
 * the run outcome (canary eb0d520f slice 2, 2026-10-13).
 */
export const FIXED_REWRITES_PER_SLICE = 4;

export interface SliceSizes {
  slice: number;
  continuing: boolean;
  companies: number;
  closed: number;
  stage_boundaries: number;
  checkpoint: number;
  state: number;
  research_fabric: number;
  canonical_view: number;
  task_result: number;
  lineage_state: number;
  rewrites: number;
  bytes_rewritten: number;
  serialize_ms: number;
  parse_ms: number;
  /** Companies the stored checkpoint carries whole. */
  retained_whole: number;
  /** Companies stored as a closed record (no job rows, one statement per dimension). */
  tombstoned: number;
  /** Evidence items in the stored checkpoint restating a fact the same company already states. */
  duplicate_evidence: number;
  breakdown: Rec;
}

function medianMs(f: () => unknown): number {
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    f();
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  return Math.round(runs[2] * 100) / 100;
}

/** Evidence items restating a fact (dimension, status, method, value) their company already states. */
function duplicateEvidence(storedCheckpoint: Rec): number {
  let dup = 0;
  for (const r of readCheckpointCompanies({ [CHECKPOINT_RESULT_KEY]: storedCheckpoint })) {
    const seen = new Set<string>();
    for (const o of r.snapshot?.observations ?? []) {
      for (const e of (o.evidence ?? []) as Rec[]) {
        const f = `${e.dimension}|${e.status}|${e.method}|${JSON.stringify(e.value)}`;
        if (seen.has(f)) dup++;
        seen.add(f);
      }
    }
  }
  return dup;
}

/** Bytes of a checkpoint's companies, by bucket and snapshot field. */
function checkpointBreakdown(companies: Rec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of companies) {
    const snap = (r.snapshot ?? {}) as Rec;
    const closed = snap.investigation_state === "excluded_permanently" && !snap.identity && !snap.enriched &&
      !snap.hiring_assessment && !snap.brain;
    const b = closed ? "closed" : "open";
    for (const [k, v] of Object.entries(snap)) out[`${b}.${k}`] = (out[`${b}.${k}`] ?? 0) + (payloadBytes(v) ?? 0);
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 10));
}

export async function benchLineage(name: string, mode: "before" | "after"): Promise<{ slices: SliceSizes[]; terminal: string | null }> {
  const fx = loadFixture(name) as LineageFixture;
  const mission = missionOf(fx);
  const before = mode === "before";
  let boundaries = 0;
  let lineageState: Rec | null = null;
  const slices: SliceSizes[] = [];
  const run = await replayLineage(fx, {
    maxSlices: 10,
    carry: persistedCarrier({ full: before }),
    deps: { onCheckpoint: () => { boundaries++; return Promise.resolve({ written: true }); } },
    onSlice: (n, s: EngineSlice, outcome) => {
      const built = buildCheckpoint({
        now: 0, deadlineAt: 0, remainingMs: 0, lastCompletedCapability: null, nextPendingCapability: null,
        companies: s.resume_records as never, reason: "execution_deadline_checkpoint",
        discoverySourceState: (s.state.discovery_source_state ?? null) as never,
      });
      // The previous writer stored the engine's records as they were.
      const checkpoint = (before ? previousWriter(built as unknown as Rec, s.resume_records) : built) as Rec;
      const fabric = projectResearchFabric({ companies: s.companies, state: s.state as never }, { missionId: fx.provenance.task_id });
      const view = canonicalView({ companies: s.companies }, mission, fx.provenance.task_id, "job_discovery");
      const result: Rec = {
        capability_execution_state: s.state,
        [CHECKPOINT_RESULT_KEY]: checkpoint,
        research_fabric: before || !outcome.continue ? fabric : researchFabricSummary(fabric),
        workbench_mission_view: view,
      };
      const merged = mergeLineageState(lineageState, { capability_execution_state: s.state, [CHECKPOINT_RESULT_KEY]: checkpoint }).state;
      // The previous merge stored the records it read back, unslimmed.
      lineageState = before
        ? { ...merged, [CHECKPOINT_RESULT_KEY]: previousWriter(merged[CHECKPOINT_RESULT_KEY] as Rec, s.resume_records) }
        : merged;
      const taskResult = payloadBytes(result) ?? 0;
      const rewrites = (before ? 2 : 1) * boundaries + FIXED_REWRITES_PER_SLICE;
      slices.push({
        slice: n,
        continuing: outcome.continue,
        companies: s.companies.length,
        closed: s.companies.filter(companyIsClosed).length,
        stage_boundaries: boundaries,
        checkpoint: payloadBytes(checkpoint) ?? 0,
        state: payloadBytes(s.state) ?? 0,
        research_fabric: payloadBytes(result.research_fabric) ?? 0,
        canonical_view: payloadBytes(view) ?? 0,
        task_result: taskResult,
        lineage_state: payloadBytes(lineageState) ?? 0,
        rewrites,
        bytes_rewritten: rewrites * taskResult,
        serialize_ms: medianMs(() => JSON.stringify(result)),
        parse_ms: (() => { const text = JSON.stringify(result); return medianMs(() => JSON.parse(text)); })(),
        retained_whole: before ? s.companies.length : s.companies.filter((c) => !companyIsClosed(c)).length,
        tombstoned: before ? 0 : s.companies.filter(companyIsClosed).length,
        duplicate_evidence: duplicateEvidence(JSON.parse(JSON.stringify(checkpoint))),
        breakdown: {
          task_result: Object.fromEntries(largestFields(result, 6)),
          checkpoint_companies: checkpointBreakdown(checkpoint.companies as Rec[]),
        },
      });
      boundaries = 0;
    },
  });
  return { slices, terminal: run.terminal };
}

if (import.meta.main) {
  const name = Deno.args.find((a) => !a.startsWith("--")) ?? "queryBd22d9ee6.loop";
  const before = await benchLineage(name, "before");
  const after = await benchLineage(name, "after");
  if (Deno.args.includes("--json")) {
    console.log(JSON.stringify({ fixture: name, before, after }, null, 1));
  } else {
    const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
    const pct = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}%`;
    console.log(`fixture ${name}: terminal before=${before.terminal} after=${after.terminal}`);
    for (let i = 0; i < before.slices.length; i++) {
      const a = before.slices[i], b = after.slices[i];
      console.log(`\nslice ${a.slice} (${a.continuing ? "continuing" : "ends the lineage"}): ${a.companies} companies, ${a.closed} closed, ${a.stage_boundaries} stage boundaries`);
      for (const k of ["checkpoint", "state", "research_fabric", "canonical_view", "task_result", "lineage_state", "bytes_rewritten"] as const) {
        console.log(`  ${k.padEnd(16)} ${kb(a[k]).padStart(9)} → ${kb(b[k]).padStart(9)}  (−${pct(a[k], b[k])})`);
      }
      console.log(`  ${"rewrites".padEnd(16)} ${String(a.rewrites).padStart(9)} → ${String(b.rewrites).padStart(9)}`);
      for (const k of ["serialize_ms", "parse_ms", "retained_whole", "tombstoned", "duplicate_evidence"] as const) {
        console.log(`  ${k.padEnd(16)} ${String(a[k]).padStart(9)} → ${String(b[k]).padStart(9)}`);
      }
      if (Deno.args.includes("--breakdown")) {
        console.log("  before:", JSON.stringify(a.breakdown));
        console.log("  after: ", JSON.stringify(b.breakdown));
      }
    }
  }
}
