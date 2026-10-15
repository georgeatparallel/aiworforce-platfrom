// D1 against a real PostgREST: every slice result write is ONE conditional
// UPDATE fenced on the claim's generation (`tasks.checkpoint_version`) and,
// before the slice's own verdict, on an open row. The production module
// (`fencedTaskWrite.ts`) is called with the production client.
//
// REGRESSION: the first D1 version asked for `select=id` on the update; PostgREST
// applies the `or` filter to the RETURNING projection and the request failed
// with 42703 "column tasks.result does not exist" — every open-row write would
// have errored. The offline fakes could not see it. This file fails on that
// version (CI's mutation step proves it: tests/db-contract/mutants/).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fencedTaskUpdate, OPEN_RESULT_FILTER, resolveSliceGeneration, type FencedTaskDb,
} from "../../supabase/functions/_shared/fencedTaskWrite.ts";
import { claimContinuationViaRpc } from "../../supabase/functions/_shared/continuationClaim.ts";
import { seedTask, seedWorkspace, serviceClient, sql, taskRow, uuid } from "./lib/harness.ts";

const opts = { sanitizeResources: false, sanitizeOps: false };
const db = async () => (await serviceClient()) as unknown as FencedTaskDb;

const OPEN = { terminal_status: "continuation_required", marker: "open" };
const FINAL = { terminal_status: "search_exhausted", marker: "final" };

Deno.test("own generation, open row: the write lands and is reported written", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 3, result: OPEN });
  const out = await fencedTaskUpdate(await db(), id, { generation: 3 }, { requireOpen: true }, { result: { ...OPEN, marker: "slice" } });
  assertEquals(out, { written: true, fenced: false, error: null });
  assertEquals((await taskRow(id)).result.marker, "slice");
});

Deno.test("stale generation: refused as fenced, the newer row is untouched", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 4, result: OPEN });
  const out = await fencedTaskUpdate(await db(), id, { generation: 3 }, { requireOpen: true }, { result: { marker: "stale" } });
  assertEquals(out, { written: false, fenced: true, error: null });
  assertEquals((await taskRow(id)).result.marker, "open");
});

Deno.test("finalized row: an open-row write is fenced even on its own generation", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 2, status: "complete", result: FINAL });
  const out = await fencedTaskUpdate(await db(), id, { generation: 2 }, { requireOpen: true }, { result: { marker: "stale" } });
  assertEquals(out, { written: false, fenced: true, error: null });
  assertEquals((await taskRow(id)).result, FINAL);
});

Deno.test("unknown generation: the open-row fence alone still protects a finalized row", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 2, status: "complete", result: FINAL });
  const out = await fencedTaskUpdate(await db(), id, { generation: null }, { requireOpen: true }, { result: { marker: "stale" } });
  assertEquals(out.fenced, true);
  assertEquals((await taskRow(id)).result, FINAL);
});

Deno.test("an empty result and a result without terminal_status are open", opts, async () => {
  const ws = await seedWorkspace();
  const a = await seedTask(ws, { checkpoint_version: 1, result: {} });
  const b = await seedTask(ws, { checkpoint_version: 1, result: { company_first_state: { round: 1 } } });
  for (const id of [a, b]) {
    const out = await fencedTaskUpdate(await db(), id, { generation: 1 }, { requireOpen: true }, { result: { marker: "first" } });
    assertEquals(out, { written: true, fenced: false, error: null }, id);
  }
});

Deno.test("a follow-up to the slice's own verdict writes on its finalized row; a stale one is fenced", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 5, status: "complete", result: FINAL });
  const own = await fencedTaskUpdate(await db(), id, { generation: 5 }, { requireOpen: false }, { status: "complete", result: { ...FINAL, outcome: "run" } });
  assertEquals(own, { written: true, fenced: false, error: null });
  const stale = await fencedTaskUpdate(await db(), id, { generation: 4 }, { requireOpen: false }, { result: { marker: "stale" } });
  assertEquals(stale, { written: false, fenced: true, error: null });
  assertEquals((await taskRow(id)).result.outcome, "run");
});

Deno.test("a missing task is fenced, not an error", opts, async () => {
  const out = await fencedTaskUpdate(await db(), uuid(), { generation: 1 }, { requireOpen: true }, { result: { marker: "x" } });
  assertEquals(out, { written: false, fenced: true, error: null });
});

Deno.test("a database error is reported as an error, never as fenced or written", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 1, result: OPEN });
  // `status` is text, `checkpoint_version` integer: a non-integer is a real 22P02.
  const out = await fencedTaskUpdate(await db(), id, { generation: 1 }, { requireOpen: true }, { checkpoint_version: "not-a-number" });
  assertEquals(out.written, false);
  assertEquals(out.fenced, false);
  assert(out.error, "a rejected write carries its error");
});

Deno.test("resolveSliceGeneration: the claim's version, else the row's own, else null", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 7, result: OPEN });
  const client = await serviceClient();
  assertEquals(await resolveSliceGeneration(client as never, id, 9), 9);
  assertEquals(await resolveSliceGeneration(client as never, id, null), 7);
  assertEquals(await resolveSliceGeneration(client as never, uuid(), null), null);
});

Deno.test("end to end: a newer claim's generation fences the older slice's write (the D1 scenario)", opts, async () => {
  const ws = await seedWorkspace();
  const checkpoint = { terminal_status: "continuation_required", company_first_state: { round: 1 } };
  const id = await seedTask(ws, { status: "ready", checkpoint_version: 0, result: checkpoint });
  const client = await serviceClient();
  const first = await claimContinuationViaRpc({ db: client as never, taskId: id, workspaceId: ws, claimId: uuid() });
  assert(first.available && first.claimed, JSON.stringify(first));
  const gen1 = first.checkpointVersion!;
  // The first holder stalls; its lease is taken over (the claim expired) by a second claim.
  await sql`update public.tasks set continuation_claim_expires_at = now() - interval '1 minute', status = 'ready' where id = ${id}`;
  const second = await claimContinuationViaRpc({ db: client as never, taskId: id, workspaceId: ws, claimId: uuid() });
  assert(second.available && second.claimed, JSON.stringify(second));
  const gen2 = second.checkpointVersion!;
  assertEquals(gen2, gen1 + 1, "every claim advances the generation");

  const newer = await fencedTaskUpdate(client as never, id, { generation: gen2 }, { requireOpen: true }, { result: { ...checkpoint, marker: "newer" } });
  assertEquals(newer.written, true);
  const stale = await fencedTaskUpdate(client as never, id, { generation: gen1 }, { requireOpen: true }, { result: { ...checkpoint, marker: "stale" } });
  assertEquals(stale, { written: false, fenced: true, error: null });
  assertEquals((await taskRow(id)).result.marker, "newer");
});

Deno.test("documents the 42703 the first D1 version hit: `or` + a representation fails in PostgREST", opts, async () => {
  const ws = await seedWorkspace();
  const id = await seedTask(ws, { checkpoint_version: 1, result: OPEN });
  const client = await serviceClient();
  const { error } = await client.from("tasks").update({ result: { marker: "x" } }).eq("id", id).or(OPEN_RESULT_FILTER).select("id");
  // If PostgREST ever accepts this, the comment in fencedTaskWrite.ts is stale —
  // not a reason to switch back: the counted form is correct either way.
  assertEquals(error?.code, "42703", JSON.stringify(error));
  assertEquals((await taskRow(id)).result.marker, "open", "the rejected request wrote nothing");
});
