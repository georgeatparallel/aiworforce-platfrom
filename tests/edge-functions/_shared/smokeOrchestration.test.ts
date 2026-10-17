// The discovery smoke's minimal orchestration is opt-in AND smoke-only: the
// flag alone, or the admission gate alone, leaves the customer path unchanged.
// The full mission under it is rehearsed in
// tests/db-contract/offlineSmokeProgress.contract.test.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADMISSION_GATE_MARK, SMOKE_ORCHESTRATION_ENV, smokeMinimalOrchestration,
} from "../../../supabase/functions/_shared/smokeAdmissionRefusal.ts";

const env = (v: string | undefined) => (k: string) => (k === SMOKE_ORCHESTRATION_ENV ? v : undefined);

async function withGate<T>(fn: () => T): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(((() => Promise.reject(new Error("no network"))) as unknown) as typeof fetch,
    { [ADMISSION_GATE_MARK]: true });
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("smoke orchestration: minimal only with the opt-in AND the admission gate installed", async () => {
  assertEquals(smokeMinimalOrchestration(env("minimal")), false, "the flag alone is the customer path");
  assertEquals(await withGate(() => smokeMinimalOrchestration(env(undefined))), false, "the gate alone is the full smoke");
  assertEquals(await withGate(() => smokeMinimalOrchestration(env("full"))), false, "any other value");
  assertEquals(await withGate(() => smokeMinimalOrchestration(env(" Minimal "))), true);
});
