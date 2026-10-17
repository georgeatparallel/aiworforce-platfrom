// Required-safe assertions. Unfixed risks deliberately FAIL; never reinterpret red as PASS.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  priceModelCall,
  readModelUsage,
} from "../../../supabase/functions/_shared/modelCostModel.ts";
import { buildCompanyEvidence } from "../../../supabase/functions/_shared/leadCompanyEvidence.ts";
import { buildEvidenceRegistry } from "../../../supabase/functions/_shared/leadEvidenceRegistry.ts";
import { jobEmployerToCompany } from "../../../supabase/functions/_shared/hiringActorNormalizers.ts";
import {
  type AdmissionDb,
  missionAdmission,
} from "../../../supabase/functions/_shared/smokeAdmission.ts";
import {
  planSmokeStatusRead,
  SMOKE_READ_STATE_MARK,
} from "../../../supabase/functions/_shared/smokeAdmissionRefusal.ts";
import { authorizeSmoke } from "../../db-contract/lib/smokeMission.ts";
import {
  actorLimits,
  catalog,
  fixture,
  options,
  seed,
  serviceClient,
  sql,
} from "./fixture.ts";
for (const detail of ["prompt_tokens_details", "input_tokens_details"]) {
  Deno.test(`P2 telemetry: ${detail} cache writes use their own rate instead of ordinary input`, () => {
    const usage = readModelUsage({
      usage: {
        prompt_tokens: 12000,
        completion_tokens: 400,
        [detail]: { cached_tokens: 0, cache_write_tokens: 12000 },
      },
    });
    const priced = priceModelCall({ model: "gpt-5.6-luna", usage });
    console.log(
      "CACHE_WRITE",
      JSON.stringify({
        detail,
        usage,
        observed: priced.estimated_usd,
        required: 0.00348,
      }),
    );
    assertEquals(
      priced.estimated_usd,
      0.00348,
      "12000 cache writes at $0.25/M + 400 output at $1.20/M",
    );
  });
}
Deno.test("telemetry control: cache hits remain a subset, never double counted", () => {
  const usage = readModelUsage({
    usage: {
      prompt_tokens: 12000,
      completion_tokens: 800,
      prompt_tokens_details: { cached_tokens: 10000, cache_write_tokens: 0 },
    },
  });
  assertEquals(
    priceModelCall({ model: "gpt-5.6-luna", usage }).estimated_usd,
    0.00156,
  );
});
Deno.test(
  "P2 read availability: an unknown Apify read count refuses a new purchase before dispatch",
  options,
  async () => {
    const m = await seed();
    const real = await serviceClient();
    const db = {
      rpc: (fn: string, args: Record<string, unknown>) => real.rpc(fn, args),
      from: (table: string) => ({
        select: (cols: string) => {
          if (
            table === "discovery_smoke_operations" && cols === "operation_key"
          ) {
            const unavailable = {
              eq: () => unavailable,
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({
                  data: null,
                  error: { message: "independent read-count outage" },
                }).then(resolve),
            };
            return unavailable;
          }
          return real.from(table).select(cols);
        },
      }),
    } as unknown as AdmissionDb;
    const f = await fixture(m, db);
    const response = await f.send("provider");
    const body = await response.json();
    const read = (f.gate as unknown as Record<
      symbol,
      (
        actor: string,
      ) => Promise<{ readsLeft: number | null; remainingMs: number | null }>
    >)[SMOKE_READ_STATE_MARK];
    const state = await missionAdmission.run({
      queueId: m.queueId,
      workerId: m.workerId,
      taskId: m.taskId,
      generation: m.generation,
    }, () => read("apify:harvestapi~linkedin-job-search"));
    console.log(
      "UNKNOWN_READ_COUNT",
      JSON.stringify({
        http_status: response.status,
        body,
        state,
        status_plan: planSmokeStatusRead(state),
        physical_purchases: f.seen.length,
        operations: await f.operations(),
      }),
    );
    assertEquals(
      f.seen.length,
      0,
      "unknown retrieval capacity must not buy an unusable run",
    );
    assertEquals((await f.operations()).length, 0);
  },
);
Deno.test(
  "P2 first-smoke prerequisite: a populated Company Brain prevents authorization",
  options,
  async () => {
    const m = await seed(false);
    await sql`insert into public.company_brain(workspace_id,profile,onboarding_completed) values(${m.ws},${
      sql.json({ icp: { industries: ["Business software"] } })
    },true)`;
    await assertRejects(
      () => authorizeSmoke(m.queueId, { quotes: catalog(), actorLimits }),
      Error,
      undefined,
      "the no-Brain prerequisite must be enforced before the first paid request",
    );
  },
);
Deno.test(
  "Brain control: an empty reviewed workspace may be authorized",
  options,
  async () => {
    const m = await seed();
    const [{ n }] =
      await sql`select count(*)::int as n from public.company_brain where workspace_id=${m.ws}`;
    assertEquals(n, 0);
    assert(m.authorizationId);
  },
);
Deno.test("P2 provenance: discovery-only description is not relabelled authoritative verified company details", () => {
  const company = jobEmployerToCompany({
    id: "job",
    company: {
      id: "co",
      name: "Example Software",
      linkedinUrl: "https://www.linkedin.com/company/offline-software",
      website: "https://offline-software.example",
      description:
        "We sell sales software for revenue teams at mid-size companies.",
      employeeCountRange: { start: 11, end: 50 },
      locations: [{ country: "United States" }],
    },
  })!;
  assert(company);
  assertEquals(company.source_provenance, "harvestapi/linkedin-job-search");
  const evidence = buildCompanyEvidence({
    company_key: "co",
    source_capability: "job_discovery",
    company,
    enriched: null,
    identity_state: "resolved",
  });
  const registry = buildEvidenceRegistry({ evidence });
  const description = registry.items.find((i) =>
    i.evidence_type === "company_description"
  );
  console.log(
    "DISCOVERY_PROVENANCE",
    JSON.stringify({
      actual_source: company.source_provenance,
      enriched: false,
      description,
    }),
  );
  assert(description);
  assertEquals(
    description.verification_state,
    "reported",
    "resolved identity does not verify the description as a fetched company record",
  );
});
