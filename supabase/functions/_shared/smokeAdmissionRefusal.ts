// How a smoke-admission refusal looks to the transports (smokeAdmission.ts).
// Kept apart, with no imports, so the edge bundles that read it carry nothing
// of the worker-only gate.

export const SMOKE_ADMISSION_ENV = "DISCOVERY_SMOKE_ADMISSION";

/** Only omission or an explicit "off" disables it; any other value enforces. */
export function smokeAdmissionEnforced(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "" && raw.trim().toLowerCase() !== "off";
}

/** Carried by the gate function (smokeAdmission.ts `createAdmissionFetch`). */
export const ADMISSION_GATE_MARK = Symbol.for("agentory.smokeAdmissionGate");

/**
 * True when the process's `fetch` IS the admission gate — which the worker
 * installs only when DISCOVERY_SMOKE_ADMISSION is enforced. Read at call time.
 */
export function smokeAdmissionActive(): boolean {
  const f = globalThis.fetch as unknown as Record<symbol, unknown> | undefined;
  return f?.[ADMISSION_GATE_MARK] === true;
}

/**
 * A Firecrawl purchase whose outcome is unknown, IN SMOKE MODE ONLY: the POST
 * reached Firecrawl (or may have) and no document came back — a 5xx, a lost
 * connection, or a replay the gate refused as possibly already bought.
 * Settled like `apify_start_uncertain`: the credit is HELD, never refunded on
 * the strength of a missing answer (Codex review R2). Outside smoke mode the
 * error codes, and customer billing, are unchanged.
 */
export const FIRECRAWL_UNCERTAIN = "firecrawl_uncertain";

export const ADMISSION_REFUSED_STATUS = 409;
export const ADMISSION_REFUSED_TYPE = "mission_admission_refused";

/** True for a gate refusal as the transports read it back (`{ status, data }`). */
export function isAdmissionRefusal(r: { status?: number; data?: unknown } | null | undefined): boolean {
  const e = (r?.data as { error?: { type?: unknown } } | null | undefined)?.error;
  return r?.status === ADMISSION_REFUSED_STATUS && e?.type === ADMISSION_REFUSED_TYPE;
}
