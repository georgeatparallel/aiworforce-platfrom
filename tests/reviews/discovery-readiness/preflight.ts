import { assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { options, seed, sql } from "./fixture.ts";
const script = Deno.readTextFileSync(
  new URL(
    "../../../scripts/test-project/discovery-smoke-preflight.sql",
    import.meta.url,
  ),
);
const block = script.slice(
  script.indexOf("do $preflight$"),
  script.indexOf("rollback;"),
);
async function preflight(ws: string) {
  // Transactional settings disappear on rollback; no persistent preflight writes.
  const one = await sql.reserve();
  try {
    await one`begin read only`;
    await one`select set_config('agentory.preflight_workspace',${ws},true)`;
    await one.unsafe(block);
  } finally {
    await one`rollback`;
    one.release();
  }
}
Deno.test(
  "preflight guard: an existing Brain is rejected before any authorization",
  options,
  async () => {
    const m = await seed(false);
    await sql`insert into public.company_brain(workspace_id,profile) values(${m.ws},'{}')`;
    await assertRejects(
      () => preflight(m.ws),
      Error,
      "Company Brain must be absent",
    );
  },
);
Deno.test(
  "preflight guard: a scheduled hosted call blocks readiness",
  options,
  async () => {
    const m = await seed(false);
    await assertRejects(
      () => preflight(m.ws),
      Error,
      "cron can call a hosted project",
    );
  },
);
Deno.test(
  "preflight guard: a clean isolated workspace passes read-only checks",
  options,
  async () => {
    const m = await seed(false);
    // The local bootstrap records cron commands in a non-executing shim.
    // Match the hosted test-builder's detachment before asserting readiness.
    await sql.unsafe(
      Deno.readTextFileSync(
        new URL(
          "../../../scripts/local-supabase/01-local-cron-detach.sql",
          import.meta.url,
        ),
      ),
    );
    await preflight(m.ws);
  },
);
