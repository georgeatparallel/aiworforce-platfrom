// WHAT IS PRODUCTION ACTUALLY RUNNING?
//
// Edge functions are deployed by hand, one at a time, so no single place said
// which commit each one was built from. Every critical function now answers
// every request — including an unauthenticated OPTIONS preflight — with
//
//   x-agentory-build: <git sha>@<built_at>
//
// The values come from buildStamp.generated.ts, which `scripts/deploy/stamp-build.sh`
// writes immediately before `supabase functions deploy` and restores after. A
// function deployed without stamping says "unstamped" — which is itself the answer
// "nobody recorded what this is", rather than a guess.
//
// The Railway worker reports the same through /health, from the commit Railway
// itself injects (RAILWAY_GIT_COMMIT_SHA) when the stamp is absent.

import { BUILD } from "./buildStamp.generated.ts";

export interface BuildInfo { sha: string; built_at: string; source: string }

export function buildInfo(env: (k: string) => string | undefined = (k) => {
  try { return Deno.env.get(k); } catch { return undefined; }
}): BuildInfo {
  if (BUILD.sha !== "unstamped") return { sha: BUILD.sha, built_at: BUILD.built_at, source: "stamp" };
  const railway = env("RAILWAY_GIT_COMMIT_SHA");
  if (railway) return { sha: railway, built_at: "unknown", source: "railway" };
  // A LOCAL RUN SAYS SO. The temporary local production worker (Railway down,
  // 2026-10-12) reported "unstamped"; an operator who starts one from a checkout
  // sets this to that checkout's commit, and it is labelled `local`, never Railway.
  const local = env("AGENTORY_LOCAL_GIT_SHA");
  if (local && /^[0-9a-f]{7,40}$/i.test(local)) return { sha: local, built_at: "unknown", source: "local" };
  return { sha: "unstamped", built_at: "unknown", source: "none" };
}

export const BUILD_HEADER = "x-agentory-build";

export function buildHeaderValue(b: BuildInfo = buildInfo()): string {
  return `${b.sha}@${b.built_at}`;
}

/** Wrap a function's handler so every response names the build it came from. */
export function withBuildStamp(
  handler: (req: Request) => Response | Promise<Response>,
  info: BuildInfo = buildInfo(),
): (req: Request) => Promise<Response> {
  const value = buildHeaderValue(info);
  return async (req) => {
    const res = await handler(req);
    try {
      res.headers.set(BUILD_HEADER, value);
      // A browser may read it too (CORS exposes only listed headers).
      const exposed = res.headers.get("Access-Control-Expose-Headers");
      res.headers.set("Access-Control-Expose-Headers", exposed ? `${exposed}, ${BUILD_HEADER}` : BUILD_HEADER);
      return res;
    } catch {
      // Immutable headers (a fetched Response passed through): copy once.
      const h = new Headers(res.headers);
      h.set(BUILD_HEADER, value);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
  };
}
