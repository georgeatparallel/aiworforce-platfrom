// THE WRITES THAT END A SLICE SURVIVE A TRANSIENT DATABASE TIMEOUT.
//
// Query B d22d9ee6, end of slice 5: claim release and run-outcome write hit
// statement timeouts (57014), the lineage release came back
// `release_unavailable`, the claim stayed held, and slice 6 was refused (409).
//
// PURE.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { retryTransient } from "../../../supabase/functions/_shared/retryTransient.ts";
import { installTimestampedConsole } from "../../../worker/logTimestamps.ts";

const noSleep = () => Promise.resolve();

Deno.test("a transient failure is retried and the later success is returned", async () => {
  const answers = [{ ok: false, transient: true }, { ok: true, transient: false }];
  let i = 0;
  const r = await retryTransient(() => Promise.resolve(answers[i++]), (a) => !a.ok && a.transient,
    { attempts: 3, delaysMs: [10, 30], sleep: noSleep });
  assertEquals([r.result.ok, r.attempts], [true, 2]);
});

Deno.test("a permanent answer (not the holder, version conflict) is returned at once", async () => {
  let calls = 0;
  const r = await retryTransient(() => { calls++; return Promise.resolve({ ok: false, transient: false }); },
    (a) => !a.ok && a.transient, { attempts: 3, delaysMs: [10], sleep: noSleep });
  assertEquals([r.attempts, calls], [1, 1]);
});

Deno.test("retries are bounded by the attempt cap", async () => {
  let calls = 0;
  await retryTransient(() => { calls++; return Promise.resolve(false); }, (ok) => !ok, { attempts: 3, delaysMs: [1], sleep: noSleep });
  assertEquals(calls, 3);
});

Deno.test("no retry starts when its wait would not fit in the slice's remaining time", async () => {
  let calls = 0;
  await retryTransient(() => { calls++; return Promise.resolve(false); }, (ok) => !ok,
    { attempts: 5, delaysMs: [2_000], remainingMs: () => 1_500, sleep: noSleep });
  assertEquals(calls, 1);
});

Deno.test("worker console lines carry an ISO timestamp; arguments and order are unchanged; idempotent", () => {
  const seen: unknown[][] = [];
  const fake = { log: (...a: unknown[]) => seen.push(a), info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const now = () => new Date("2026-10-12T14:19:33.000Z");
  installTimestampedConsole(fake as never, now);
  installTimestampedConsole(fake as never, now);
  fake.log("[worker] claimed mission", { queue: "q" });
  assertEquals(seen[0], ["2026-10-12T14:19:33.000Z", "[worker] claimed mission", { queue: "q" }]);
});

Deno.test("the worker installs it at startup, and run-agent retries both slice-end releases", async () => {
  const main = await Deno.readTextFile(new URL("../../../worker/main.ts", import.meta.url));
  const ra = await Deno.readTextFile(new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));
  assert(main.includes("installTimestampedConsole("));
  assert(/retryTransient\(\s*\(\) => releaseContinuationViaRpc\(/.test(ra), "the claim release is retried");
  assert(/retryTransient\(\s*\(\) => releaseLineageLease\(/.test(ra), "the lineage release is retried");
  assert(ra.includes('"[run-agent][phase]"'), "phase timings are logged");
});
