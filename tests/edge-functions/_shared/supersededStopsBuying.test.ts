// A SUPERSEDED SLICE STOPS BUYING. When a mid-slice write is fenced (another
// generation owns the task row), run-agent revokes the worker's deadline, so
// every paid boundary — the engine's and the verifiers' — answers "no room"
// from that moment, through the path a lost queue lease already takes.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { revocableDeadline } from "../../../supabase/functions/_shared/revocableDeadline.ts";
import { createExecutionDeadline } from "../../../supabase/functions/_shared/leadExecutionFinalizer.ts";
import { classifyRevocation, verificationStopGate } from "../../../supabase/functions/_shared/verificationStop.ts";

const SRC = Deno.readTextFileSync(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));

Deno.test("superseded: the revocation run-agent issues stops every paid boundary and reads as a lost lease", () => {
  const d = revocableDeadline(createExecutionDeadline({ budgetMs: 300_000 }));
  assertEquals(d.expired(), false);
  const reason = "lease superseded: a newer generation owns the task row (stage_boundary)";
  d.revoke(reason);
  assertEquals([d.expired(), d.expiredForDurableStart(), d.remainingMs()], [true, true, 0], "no room for any paid work");
  assertEquals(classifyRevocation(reason), "lease_lost");
  assertEquals(verificationStopGate(d).check()?.reason, "lease_lost", "the verifiers stop too");
});

Deno.test("superseded: run-agent revokes on a fenced progress, stage-checkpoint or stage-boundary write — once, and only a revocable deadline", () => {
  assert(SRC.includes("const supersedeOnFence = (w: { fenced: boolean }, where: string) => {"));
  const helper = SRC.slice(SRC.indexOf("const supersedeOnFence ="), SRC.indexOf("const supersedeOnFence =") + 700);
  assert(helper.includes('if (typeof d.revoke !== "function" || d.revokedReason) return;'), "a no-op on the edge default, and only once");
  assert(helper.includes("d.revoke(`lease superseded: a newer generation owns the task row (${where})`);"));
  for (const [path, marker] of [
    ["progress_publish", '}), "progress_publish");'],
    ["stage_checkpoint", '}), "stage_checkpoint");'],
    ["stage_boundary", 'supersedeOnFence(stageWrite, "stage_boundary");'],
  ] as const) {
    const g = SRC.indexOf(`guardResult("${path}"`);
    const wrapped = SRC.lastIndexOf("supersedeOnFence(", SRC.indexOf(marker, g) + marker.length);
    assert(g > 0 && SRC.indexOf(marker, g) > g && wrapped > 0, `${path}: a fenced write must revoke the deadline`);
  }
  // The deadline it revokes is the one the engine and the verifiers ask.
  assert(SRC.includes("deadline: terminalGuard.deadline,"));
  assert(SRC.includes("verificationStopGate(terminalGuard.deadline)"));
});
