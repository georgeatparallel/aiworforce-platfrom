// LEAD V2 — AN OPERATOR'S HARD MISSION CAP, ENFORCED BEFORE EVERY PAID CALL.
//
// ── WHY THIS EXISTS (CANARY 4, 2026-10-03, task 382de52c) ──────────────────
//
// The canary's stop rules were "provider spend > $0.80" and "credits > 40".
// Neither reached the server. The spend ledger already refuses any call whose
// estimate would breach `mission_provider_usd` (`budgetPolicy.reserve`, before
// the network call, at all three reservation sites), and that ceiling is
// lineage-wide because the ledger travels in the checkpoint. But the ceiling was
// the $2.00 default: a Pilot Start sends no `run_budget`, and nothing else could
// lower it. The only stop was a human cancelling the queue row inside the two
// minutes between slices — the write was blocked, and the lineage ran to its
// tenth slice. Credits had no per-mission ceiling at all.
//
// ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
//
// A server-side cap the operator sets in the worker's environment:
//
//   LEAD_V2_MISSION_PROVIDER_USD_CAP   e.g. 0.80 — the mission's provider dollars
//   LEAD_V2_MISSION_CREDIT_CAP         e.g. 40   — the mission's paid calls
//   LEAD_V2_MISSION_CAP_WORKSPACES     optional comma list; unset or "*" = all
//
// TIGHTEN-ONLY. Combined with the existing ceilings by `min`, so a cap can make
// a mission buy less and never more. Re-applied at the start of EVERY slice, so
// lowering it reaches a lineage already in flight on its next slice. Raising it
// does not: the lowered ceilings are stored in that lineage's ledger. (A worker
// environment change needs a redeploy before any slice reads it.)
//
// FAIL CLOSED. A set-but-unparseable value ("0.8O", "-1", "") is a cap of ZERO,
// not an absent one: an operator who meant to cap spend and mistyped must not
// get an uncapped run. A cap of zero refuses every paid call.
//
// UNSET: nothing changes. No ceiling is touched, no floor is read, and the
// continuation decision never sees a budget stop.
//
// Pure, apart from `readLineageSpendFloor`'s one injected query.

import type { Ceilings, SpendFloor } from "./budgetPolicy.ts";
import { tightenCeilings } from "./runBudget.ts";

export const MISSION_PROVIDER_USD_CAP_ENV = "LEAD_V2_MISSION_PROVIDER_USD_CAP";
export const MISSION_CREDIT_CAP_ENV = "LEAD_V2_MISSION_CREDIT_CAP";
export const MISSION_CAP_WORKSPACES_ENV = "LEAD_V2_MISSION_CAP_WORKSPACES";

export type EnvReader = (key: string) => string | undefined;

export interface MissionSpendCap {
  /** Provider dollars this mission may commit. null: no dollar cap from the operator. */
  provider_usd: number | null;
  /** Paid provider calls (= credits) this mission may commit. null: no credit cap. */
  credits: number | null;
  /** Names any variable that was set but unreadable (and therefore read as 0). */
  invalid: string[];
}

/**
 * Read one cap variable. Absent → null. Present → a finite number ≥ 0, else 0
 * (fail closed) with the variable named in `invalid`.
 */
function readCap(read: EnvReader, key: string, integer: boolean, invalid: string[]): number | null {
  const raw = read(key);
  if (raw === undefined) return null;
  const s = raw.trim();
  const n = s === "" ? NaN : Number(s);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    invalid.push(key);
    return 0;
  }
  return n;
}

/**
 * The operator's cap for this workspace's missions, or null when none applies.
 *
 * Scoped by `LEAD_V2_MISSION_CAP_WORKSPACES` when it names workspaces; a run in
 * a workspace it does not name is uncapped here (its other ceilings still hold).
 */
export function resolveMissionSpendCap(
  read: EnvReader, workspaceId: string | null | undefined,
): MissionSpendCap | null {
  const invalid: string[] = [];
  const provider_usd = readCap(read, MISSION_PROVIDER_USD_CAP_ENV, false, invalid);
  const credits = readCap(read, MISSION_CREDIT_CAP_ENV, true, invalid);
  if (provider_usd === null && credits === null) return null;
  const scope = (read(MISSION_CAP_WORKSPACES_ENV) ?? "").trim();
  if (scope !== "" && scope !== "*") {
    const allowed = new Set(scope.split(",").map((s) => s.trim()).filter(Boolean));
    if (!workspaceId || !allowed.has(workspaceId)) return null;
  }
  return { provider_usd, credits, invalid };
}

/**
 * The ceilings a capped mission is held to. `tightenCeilings` lowers the dollar
 * ceilings (mission, routes, calls, candidate) to the cap; the credit ceiling is
 * the smaller of any already set and the cap. Never raises anything.
 */
export function capCeilings(c: Ceilings, cap: MissionSpendCap | null): Ceilings {
  if (!cap) return c;
  // A zero dollar cap passes through `tightenCeilings` (it skips only null) and
  // lowers every dollar ceiling to 0: the fail-closed "buy nothing".
  const usd = tightenCeilings(c, { provider_usd: cap.provider_usd, max_candidates: null });
  const credits = cap.credits === null
    ? (c.mission_credits ?? null)
    : Math.min(c.mission_credits ?? Number.POSITIVE_INFINITY, cap.credits);
  return { ...usd, mission_credits: credits };
}

// ── THE DATABASE FLOOR ──────────────────────────────────────────────────────

/** The `lead_execution_calls` columns the floor reads. */
export interface ExecutionCallCostRow {
  status: string | null;
  provider_call_id: string | null;
  settled_usd: number | string | null;
  actual_cost_usd: number | string | null;
  /** `request_input->provider_call_spec->cost->>estimate_usd`. */
  estimate_usd: number | string | null;
  /**
   * `request_input->>resume_run_id`: this row RE-READ a run an earlier row
   * started. Optional so rows read without it keep their old meaning.
   */
  resumed_from?: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * What the lineage's ledger rows commit: every spec-governed paid call
 * (`provider_call_id` set) that was not an adoption, at its settled cost, else
 * its actual cost, else the estimate it was reserved at. A row still `started`
 * is in flight and counts at its estimate — the same rule the spend ledger uses.
 */
export function spendFloorFromRows(rows: readonly ExecutionCallCostRow[]): SpendFloor {
  let usd = 0, calls = 0;
  for (const r of rows) {
    // A RE-READ IS NOT A PURCHASE. A finished adoption is recorded `reused`; one
    // that finds the run STILL executing is recorded `timed_out` (it is not
    // resolved, and `reused` would read as resolved) — and was counted as one
    // more paid call per re-read. D3 re-asks a pending run every slice it is
    // awaited, so the floor would have grown by one call per poll.
    if (!r.provider_call_id || r.status === "reused" || r.resumed_from) continue;
    calls++;
    usd += num(r.settled_usd) ?? num(r.actual_cost_usd) ?? num(r.estimate_usd) ?? 0;
  }
  return { committed_usd: Math.round(usd * 10000) / 10000, paid_calls: calls, source: "lead_execution_calls" };
}

/** A floor that refuses everything: what an unreadable ledger means under a cap. */
export const UNREADABLE_FLOOR: SpendFloor = Object.freeze({
  committed_usd: 1e9, paid_calls: 1e9, source: "unreadable",
}) as SpendFloor;

export interface FloorDb {
  from(table: string): {
    select(cols: string): {
      like(col: string, pattern: string): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

/**
 * Read the lineage's committed spend from `lead_execution_calls`. Every paid
 * call's `logical_call_key` begins with the lineage root (`logicalCallKey`), so
 * one prefix match covers every task in the lineage.
 *
 * FAIL CLOSED: an error, or anything that is not a list of rows, is the
 * UNREADABLE floor — under a cap, "we cannot tell what was spent" refuses.
 */
export async function readLineageSpendFloor(db: FloorDb, lineageRootId: string): Promise<SpendFloor> {
  if (!lineageRootId) return UNREADABLE_FLOOR;
  try {
    const { data, error } = await db.from("lead_execution_calls")
      .select("status,provider_call_id,settled_usd,actual_cost_usd,estimate_usd:request_input->provider_call_spec->cost->>estimate_usd,resumed_from:request_input->>resume_run_id")
      .like("logical_call_key", `${lineageRootId}:%`);
    if (error || !Array.isArray(data)) return UNREADABLE_FLOOR;
    return spendFloorFromRows(data as ExecutionCallCostRow[]);
  } catch {
    return UNREADABLE_FLOOR;
  }
}
