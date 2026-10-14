// LEAD V2 REPLAY LAB — THE PROVIDER BOUNDARY.
//
// The ONLY thing replay replaces is the network. Production:
//
//   ProviderCallSpec → guardedInvoker → capabilityInvoke → Apify / Firecrawl
//
// Replay:
//
//   ProviderCallSpec → guardedInvoker → FixtureProvider.invoke → recorded rows
//
// Everything before (spec compile, readiness, ledger reservation) and after
// (normalizers, observations, claims, eligibility, continuation) is the
// production code. The provider is STRICT: a call the fixture has no answer
// for throws, so a replay can never silently "succeed" on a call production
// would have made differently. `fetch` is disabled for the whole process.

import type { ProviderCallSpec } from "../../../supabase/functions/_shared/providerCallSpec.ts";
import type { FixtureProviderResponse } from "./fixture.ts";

/** Any network attempt is a replay bug: zero provider calls, zero production writes. */
export function noNetwork(): void {
  globalThis.fetch = (input: RequestInfo | URL) => {
    throw new Error(`replay must not reach the network (attempted ${String(input).slice(0, 80)})`);
  };
}

export interface RecordedProviderCall {
  actor: string;
  capability: string | null;
  candidate_keys: string[];
  input_hash: string;
  estimate_usd: number | null;
  idempotency_key: string | null;
  rows: number;
  input: Record<string, unknown>;
  /** A run reported still executing (`pending_once`). */
  pending?: boolean;
  /** An adoption of an earlier run: nothing new bought. */
  adopted?: boolean;
}

export class UnrecordedProviderCall extends Error {
  constructor(actor: string, keys: string[]) {
    super(`replay has no recorded answer for ${actor} [${keys.join(", ")}] — add it to the fixture or this call is a regression`);
    this.name = "UnrecordedProviderCall";
  }
}

const norm = (v: unknown) => String(v).replace(/\/$/, "");

/** Every field the response names must equal the call's (`null` = absent). */
function inputMatches(input: Record<string, unknown>, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([k, v]) =>
    v === null ? input[k] === undefined || input[k] === null : JSON.stringify(input[k]) === JSON.stringify(v));
}

function selectRows(rows: readonly Record<string, unknown>[], input: Record<string, unknown>,
  sel: { input_field: string; row_field: string }): Record<string, unknown>[] {
  const asked = new Set(((input[sel.input_field] as unknown[]) ?? []).map(norm));
  return rows.filter((r) => asked.has(norm(r[sel.row_field])));
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((k, i) => k === [...b].sort()[i]);

export class FixtureProvider {
  readonly calls: RecordedProviderCall[] = [];
  /**
   * `runIdPrefix` makes run ids unique across slices (each slice builds its own
   * provider): a lineage-wide ledger keyed by run id needs them distinct.
   */
  constructor(private readonly responses: readonly FixtureProviderResponse[], private readonly opts: { runIdPrefix?: string } = {}) {}

  /** The `invoke` the guarded invoker wraps — same call shape `ledgerBoundCall` and the engine send. */
  invoke = (call: {
    actorKey: string; capabilityId?: string; inputHash?: string; providerCallSpec?: ProviderCallSpec;
    input?: Record<string, unknown>; onProviderRun?: (r: { run_id: string; dataset_id: string | null }) => void;
    resumeRunId?: string;
  }): Promise<Record<string, unknown>[]> => {
    const spec = call.providerCallSpec;
    const keys = [...(spec?.candidate_keys ?? [])];
    const input = (call.input ?? {}) as Record<string, unknown>;
    const hit = this.responses.find((r) => r.actor === call.actorKey &&
      (r.input_hash ? r.input_hash === call.inputHash
        : r.input_match ? inputMatches(input, r.input_match)
        : r.candidate_keys ? sameKeys(r.candidate_keys, keys) : true));
    if (!hit) return Promise.reject(new UnrecordedProviderCall(call.actorKey, keys.length ? keys : [JSON.stringify(input).slice(0, 120)]));
    const rows = hit.select ? selectRows(hit.rows, input, hit.select) : hit.rows;
    if (hit.pending_once && !call.resumeRunId) {
      // The run started (it is paid for) and has not finished: the shape the
      // guarded invoker surfaces, so `ledgerBoundCall` records it as running.
      const run_id = `${this.opts.runIdPrefix ?? ""}replay-pending-${this.calls.length + 1}`;
      call.onProviderRun?.({ run_id, dataset_id: null });
      this.calls.push({
        actor: call.actorKey, capability: call.capabilityId ?? spec?.capability ?? null, candidate_keys: keys,
        input_hash: call.inputHash ?? "", estimate_usd: spec?.cost.estimate_usd ?? null,
        idempotency_key: spec?.idempotency_key ?? null, rows: 0, input, pending: true,
      });
      return Promise.reject(Object.assign(new Error("provider run still executing"), { toolResult: { run_id, pending: true } }));
    }
    // A recorded run id, as the provider would report it — so the ledger and adoption paths run.
    call.onProviderRun?.({ run_id: call.resumeRunId ?? `${this.opts.runIdPrefix ?? ""}replay-${this.calls.length + 1}`, dataset_id: null });
    this.calls.push({
      actor: call.actorKey, capability: call.capabilityId ?? spec?.capability ?? null, candidate_keys: keys,
      input_hash: call.inputHash ?? "", estimate_usd: spec?.cost.estimate_usd ?? null,
      idempotency_key: spec?.idempotency_key ?? null, rows: rows.length, input,
      ...(call.resumeRunId ? { adopted: true } : {}),
    });
    return Promise.resolve(structuredClone(rows));
  };
}
