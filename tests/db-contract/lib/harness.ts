// Database-contract harness: the REAL Supabase client (the exact specifier
// run-agent and the worker import) against a REAL PostgREST in front of a REAL
// Postgres built from the repository's migrations — see ../run.sh.
//
// Everything is disposable. The URLs must be localhost and the only key is a
// service-role JWT minted here from the per-run secret run.sh generated.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const need = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`${k} is not set — run through tests/db-contract/run.sh`);
  return v;
};
const localOnly = (k: string, v: string): string => {
  const host = new URL(v.replace(/^postgres(ql)?:/, "http:")).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`${k} must be localhost, got ${host}`);
  return v;
};

export const REST_URL = localOnly("DB_CONTRACT_REST_URL", need("DB_CONTRACT_REST_URL"));
const JWT_SECRET = need("DB_CONTRACT_JWT_SECRET");
const PG_URL = localOnly("DB_CONTRACT_PG_URL", need("DB_CONTRACT_PG_URL"));

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** An HS256 JWT for `role`, signed with this run's secret (what Supabase keys are). */
export async function mintJwt(role: "service_role" | "anon" | "authenticated", sub?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ role, iss: "db-contract", iat: now, exp: now + 3600, ...(sub ? { sub } : {}) }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/**
 * supabase-js addresses PostgREST at `<url>/rest/v1/…` (Supabase's gateway
 * path); a bare PostgREST serves at `/`. The client is otherwise untouched —
 * its query builder, headers and response parsing are what production runs.
 */
const gatewayFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return fetch(url.replace(`${REST_URL}/rest/v1`, REST_URL), init);
};

let service: SupabaseClient | null = null;
/** The service-role client, built the way run-agent and the worker build theirs. */
export async function serviceClient(): Promise<SupabaseClient> {
  if (service) return service;
  const key = await mintJwt("service_role");
  service = createClient(REST_URL, key, { auth: { persistSession: false }, global: { fetch: gatewayFetch } });
  return service;
}

/** Direct SQL, for seeding rows and asserting what actually landed. */
export const sql = postgres(PG_URL, { max: 2, onnotice: () => {}, idle_timeout: 2 });

export const uuid = () => crypto.randomUUID();

export async function seedWorkspace(): Promise<string> {
  const id = uuid();
  await sql`insert into public.workspaces (id, name) values (${id}, ${"contract " + id.slice(0, 8)})`;
  return id;
}

export async function seedLineage(workspaceId: string, over: Partial<{
  lineage_id: string; status: string; state_version: number; current_state: unknown; terminal_reason: string | null; mission_hash: string | null;
}> = {}): Promise<string> {
  const id = over.lineage_id ?? uuid();
  await sql`insert into public.lead_lineages (lineage_id, workspace_id, status, state_version, current_state, terminal_reason, mission_hash)
    values (${id}, ${workspaceId}, ${over.status ?? "active"}, ${over.state_version ?? 0},
            ${over.current_state === undefined ? null : sql.json(over.current_state as never)}, ${over.terminal_reason ?? null}, ${over.mission_hash ?? null})`;
  return id;
}

export async function seedTask(workspaceId: string, over: Partial<{
  id: string; status: string; result: unknown; checkpoint_version: number; lineage_id: string | null; payload: unknown; agent_slug: string;
}> = {}): Promise<string> {
  const id = over.id ?? uuid();
  await sql`insert into public.tasks (id, workspace_id, status, result, checkpoint_version, lineage_id, payload, agent_slug)
    values (${id}, ${workspaceId}, ${over.status ?? "running"}, ${sql.json((over.result ?? {}) as never)},
            ${over.checkpoint_version ?? 0}, ${over.lineage_id ?? null}, ${sql.json((over.payload ?? {}) as never)}, ${over.agent_slug ?? "lead-sourcer"})`;
  return id;
}

export async function taskRow(id: string): Promise<{ status: string; result: Record<string, unknown>; checkpoint_version: number }> {
  const [r] = await sql`select status, result, checkpoint_version from public.tasks where id = ${id}`;
  return r as never;
}

/** Close the SQL pool at the end of a test file (Deno's leak check is per file). */
export async function closeHarness(): Promise<void> {
  await sql.end({ timeout: 2 });
}
