// WHICH ENGINE RUNS A LEAD MISSION — V1 edge (default) or the V2 worker.
//
// SAFE BY DEFAULT. The allowlist is empty unless LEAD_V2_WORKER_WORKSPACES names
// workspaces explicitly. Empty ⇒ every mission resolves to v1_edge ⇒ V2 is
// disabled. There is no global on switch; a workspace opts in by id, one at a
// time. Enqueue preserves the approved mission count.
//
// No Deno/edge coupling: env is read through an injected reader so this resolves
// identically in an edge function, the worker, and a unit test.

export type LeadExecutionEngine = "v1_edge" | "v2_worker";

export const LEAD_V2_WORKSPACES_ENV = "LEAD_V2_WORKER_WORKSPACES";

/**
 * LONG-RUNNING IS NOT UNLIMITED.
 *
 * The default is five minutes of wall clock per worker run — already twice the
 * edge limit, and ample for the canary's single lead. The HARD CAP is twenty
 * minutes because `release-stale-credit-reservations` (every 10 min) refunds any
 * credit reservation older than 30 minutes: a run allowed to exceed that would
 * have reservations for calls still in flight released underneath it. A run
 * that reaches its ceiling checkpoints and ends resumable; it is never killed.
 */
export const LEAD_WORKER_DEFAULT_RUNTIME_MS = 5 * 60_000;
export const LEAD_WORKER_MAX_RUNTIME_CAP_MS = 20 * 60_000;
export const LEAD_WORKER_MAX_RUNTIME_ENV = "LEAD_WORKER_MAX_RUNTIME_MS";

export type EnvReader = (key: string) => string | undefined;

function defaultReader(key: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
      .Deno?.env.get(key);
  } catch {
    return undefined; // env access denied ⇒ treat as unset ⇒ V2 disabled
  }
}

export function v2WorkspaceAllowlist(read: EnvReader = defaultReader): Set<string> {
  const raw = read(LEAD_V2_WORKSPACES_ENV) ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** TRUE only when at least one workspace is explicitly allowlisted. */
export function v2Enabled(read: EnvReader = defaultReader): boolean {
  return v2WorkspaceAllowlist(read).size > 0;
}

/**
 * The engine for a given workspace. Unknown/absent workspace ⇒ v1_edge.
 * A workspace is v2_worker ONLY if it appears in the allowlist.
 */
export function resolveLeadExecutionEngine(
  workspaceId: string | null | undefined,
  read: EnvReader = defaultReader,
): LeadExecutionEngine {
  if (!workspaceId) return "v1_edge";
  return v2WorkspaceAllowlist(read).has(workspaceId) ? "v2_worker" : "v1_edge";
}

/** Any unusable value falls back to the default; anything larger is capped. */
export function clampWorkerCeilingMs(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return LEAD_WORKER_DEFAULT_RUNTIME_MS;
  return Math.min(Math.floor(n), LEAD_WORKER_MAX_RUNTIME_CAP_MS);
}
