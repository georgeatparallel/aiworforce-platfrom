// D1 — A STALE GENERATION NEVER OVERWRITES A NEWER ONE'S RESULT.
//
// The fence is the write itself: one conditional UPDATE on the generation the
// slice's claim set (`tasks.checkpoint_version`) and, before the slice's own
// verdict, on an open row. The chaos lab (tests/replay/failure) drives the same
// function against the production claim SQL. ZERO network, ZERO database.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type FencedTaskQuery, fencedTaskUpdate, OPEN_RESULT_FILTER, resolveSliceGeneration,
} from "../../../supabase/functions/_shared/fencedTaskWrite.ts";

function fakeDb(rows: unknown[] | null, error: { message: string } | null = null) {
  const sent: Array<[string, unknown]> = [];
  let patch: Record<string, unknown> | null = null;
  const q: FencedTaskQuery = {
    eq: (c, v) => { sent.push([c, v]); return q; },
    or: (f) => { sent.push(["or", f]); return q; },
    // PostgREST's `count: "exact"` answer: the number of rows updated.
    then: (resolve, reject) => { sent.push(["count", "exact"]); return Promise.resolve({ error, count: rows === null ? null : rows.length }).then(resolve, reject); },
  };
  return {
    db: { from: (t: string) => { sent.push(["from", t]); return { update: (p: Record<string, unknown>, o: { count: "exact" }) => { patch = p; sent.push(["update", o.count]); return q; } }; } },
    sent, patch: () => patch,
  };
}

Deno.test("D1 the write is ONE conditional update: this task, this generation, and (before the verdict) an open row", async () => {
  const f = fakeDb([{ id: "t1" }]);
  const out = await fencedTaskUpdate(f.db, "t1", { generation: 7 }, { requireOpen: true }, { result: { a: 1 }, status: "ready" });
  assertEquals(out, { written: true, fenced: false, error: null });
  // Counted, never `select`ed: PostgREST applies `or` to the RETURNING projection,
  // so `select=id` beside this filter fails 42703 (verified on PostgREST 12.2.3).
  assertEquals(f.sent, [["from", "tasks"], ["update", "exact"], ["id", "t1"], ["checkpoint_version", 7], ["or", OPEN_RESULT_FILTER], ["count", "exact"]]);
  assertEquals(f.patch(), { result: { a: 1 }, status: "ready" });
  assertEquals(OPEN_RESULT_FILTER, "result->>terminal_status.is.null,result->>terminal_status.eq.continuation_required");
});

Deno.test("D1 zero rows changed is a REFUSAL, reported — never a silent success; a database error stays an error", async () => {
  assertEquals(await fencedTaskUpdate(fakeDb([]).db, "t1", { generation: 7 }, { requireOpen: true }, {}),
    { written: false, fenced: true, error: null });
  const err = await fencedTaskUpdate(fakeDb(null, { message: "57014" }).db, "t1", { generation: 7 }, { requireOpen: false }, {});
  assertEquals([err.written, err.fenced, err.error?.message], [false, false, "57014"]);
});

Deno.test("D1 a follow-up to the slice's own verdict is fenced on the generation alone; an unreadable generation falls back to the open-row fence", async () => {
  const follow = fakeDb([{ id: "t1" }]);
  await fencedTaskUpdate(follow.db, "t1", { generation: 3 }, { requireOpen: false }, {});
  assertEquals(follow.sent.filter(([k]) => k === "or"), [], "its own terminal verdict must not refuse it");
  const blind = fakeDb([{ id: "t1" }]);
  await fencedTaskUpdate(blind.db, "t1", { generation: null }, { requireOpen: true }, {});
  assertEquals(blind.sent.map(([k]) => k), ["from", "update", "id", "or", "count"]);
});

Deno.test("D1 the generation: the claim's version wins; a first slice reads the row's; an unreadable row gives none", async () => {
  const row = (data: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data, error }) }) }) }),
  });
  assertEquals(await resolveSliceGeneration(row({ checkpoint_version: 9 }), "t", 4), 4);
  assertEquals(await resolveSliceGeneration(row({ checkpoint_version: 0 }), "t", null), 0);
  assertEquals(await resolveSliceGeneration(row(null, { message: "x" }), "t", undefined), null);
  assertEquals(await resolveSliceGeneration(row({ checkpoint_version: "1" }), "t", null), null);
});

Deno.test("D1 run-agent: every slice result write goes through the fence, the generation comes from the claim, and nothing writes `result` unfenced", () => {
  const src = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  for (const [path, open] of [
    ["paid_preflight", false], ["progress_publish", true], ["stage_checkpoint", true], ["stage_boundary", true],
    ["final_snapshot", true], ["slice_result", true], ["run_outcome", false], ["continuation_mark", false], ["failed_handoff", false],
  ] as const) {
    const g = src.indexOf(`guardResult("${path}"`);
    assert(g > 0, path);
    const call = src.lastIndexOf("fencedTaskUpdate(supabase as unknown as FencedTaskDb, task.id, sliceFence,", g);
    assert(call > 0 && g - call < 3000 && !src.slice(call, g).includes("supabase.from(\"tasks\").update("), `${path} is not written through fencedTaskUpdate`);
    assert(src.slice(call, g).includes(`{ requireOpen: ${open} }`), `${path}: requireOpen should be ${open}`);
  }
  assert(src.includes('checkpointVersion: "checkpointVersion" in rpc ? rpc.checkpointVersion : null,'));
  assert(src.includes("generation: await resolveSliceGeneration(supabase as never, task.id, heldClaim?.checkpointVersion ?? null),"));
  // No other write replaces a task's result through a guard path.
  const unfenced = [...src.matchAll(/supabase\.from\("tasks"\)\s*\.update\(\{\s*(?:\/\/[^\n]*\n\s*)*result: guardResult\(/g)];
  assertEquals(unfenced.length, 0);
});
