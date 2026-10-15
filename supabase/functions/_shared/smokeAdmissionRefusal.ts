// How a smoke-admission refusal looks to the transports (smokeAdmission.ts).
// Kept apart, with no imports, so the edge bundles that read it carry nothing
// of the worker-only gate.

export const ADMISSION_REFUSED_STATUS = 409;
export const ADMISSION_REFUSED_TYPE = "mission_admission_refused";

/** True for a gate refusal as the transports read it back (`{ status, data }`). */
export function isAdmissionRefusal(r: { status?: number; data?: unknown } | null | undefined): boolean {
  const e = (r?.data as { error?: { type?: unknown } } | null | undefined)?.error;
  return r?.status === ADMISSION_REFUSED_STATUS && e?.type === ADMISSION_REFUSED_TYPE;
}
