// LEAD V2 REPLAY LAB — THE FIXTURE.
//
// A fixture is a production canary frozen at one or more instants: the mission,
// the spend ledger as it stood, the company records as the checkpoint held them,
// the provider runs still in flight, the provider answers the replay may give,
// and the numbers production logged (anchors) that prove the reconstruction is
// faithful before anything is asserted about the fix.
//
// Fixtures are sanitized production data. `assertSanitized` refuses one that
// carries anything shaped like a credential.

import type { Ceilings, SpendReservation } from "../../../supabase/functions/_shared/budgetPolicy.ts";
import type { PendingVerifierRun } from "../../../supabase/functions/_shared/claimVerifier.ts";
import type { CompanyResumeRecord } from "../../../supabase/functions/_shared/leadResumeState.ts";
import type { FixtureSlice } from "./continuation.ts";

export const FIXTURE_SCHEMA = "lead-v2-replay-fixture-v1" as const;

export interface FixtureProviderResponse {
  actor: string;
  /** Matched against the compiled spec's candidate keys (order-insensitive). */
  candidate_keys?: string[];
  /** Or an exact match on the input hash the production `hashInput` gives. */
  input_hash?: string;
  /** Or a subset match on the call's input fields (e.g. `{ "startPage": 2 }`); `null` = field absent. */
  input_match?: Record<string, unknown>;
  /** Answer only the rows for the companies asked: `row_field` ∈ `input[input_field]` (trailing "/" ignored). */
  select?: { input_field: string; row_field: string };
  rows: Record<string, unknown>[];
  /**
   * The provider is still running when first asked (a Pvalyou cold read
   * outliving its slice): the first call reports a pending run; the adoption
   * (`resumeRunId`) returns the rows. Never a second purchase.
   */
  pending_once?: boolean;
  /**
   * With `pending_once`: the run is STILL executing for this many adoptions
   * (`resumeRunId`) before it returns its rows — a run that outlives several
   * slices (D3's wait bound). Absent: the first adoption returns the rows.
   */
  still_running_polls?: number;
  /** Where the rows came from: a production dataset, or why they are synthetic. */
  provenance: string;
}

export interface FixtureCheckpoint {
  /** The instant the checkpoint stands at (ISO). The ledger is rebuilt to it. */
  at: string;
  note: string;
  /** Company records exactly as `toResumeRecord` writes them, trimmed to `at`. */
  companies: CompanyResumeRecord[];
  verifier_pending_runs: PendingVerifierRun[];
}

export interface ReplayFixture {
  fixture: string;
  schema: typeof FIXTURE_SCHEMA;
  provenance: {
    environment: "production" | "test";
    task_id: string;
    sources: string[];
    sanitization: string[];
    [k: string]: unknown;
  };
  mission: Record<string, unknown>;
  ceilings: Ceilings;
  /** Every reservation, with the instant its call row was written. */
  ledger_reservations: Array<{ at: string; settled_at?: string | null; r: SpendReservation }>;
  checkpoints: Record<string, FixtureCheckpoint>;
  provider_responses: FixtureProviderResponse[];
  /** A lineage's slices, as run-agent folded them (continuation fixtures). */
  slices?: FixtureSlice[];
  /** Figures production logged — checked before any expectation. */
  anchors: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const FIXTURES = new URL("../fixtures/", import.meta.url);

/** Shapes that must never appear in a fixture. */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["apify token", /apify_api_[A-Za-z0-9]{10,}/],
  ["openai key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["bearer", /Bearer\s+[A-Za-z0-9._-]{16,}/i],
  ["supabase service key name", /service_role_key|SUPABASE_SERVICE_ROLE/i],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

export function assertSanitized(name: string, text: string): void {
  for (const [what, re] of SECRET_SHAPES) {
    const m = text.match(re);
    if (m) throw new Error(`fixture ${name} carries a ${what} (${m[0].slice(0, 12)}…) — sanitize it`);
  }
}

export function loadFixture(name: string): ReplayFixture {
  const text = Deno.readTextFileSync(new URL(`${name}.json`, FIXTURES));
  assertSanitized(name, text);
  const fx = JSON.parse(text) as ReplayFixture;
  if (fx.schema !== FIXTURE_SCHEMA) throw new Error(`fixture ${name}: schema ${fx.schema} is not ${FIXTURE_SCHEMA}`);
  return fx;
}

export function listFixtures(): string[] {
  return [...Deno.readDirSync(FIXTURES)].filter((e) => e.isFile && e.name.endsWith(".json"))
    .map((e) => e.name.replace(/\.json$/, "")).sort();
}
