// A LOCAL WORKER REPORTS ITS OWN COMMIT, LABELLED LOCAL — NEVER AS RAILWAY.
//
// The temporary local production worker (Railway down, 2026-10-12) reported
// `build: unstamped`. An operator who starts one from a checkout sets
// AGENTORY_LOCAL_GIT_SHA to that checkout's commit. The repository's own
// stamp is "unstamped" outside a CI build (`stamp-build.sh` writes it there).
//
// PURE.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildInfo } from "../../../supabase/functions/_shared/buildStamp.ts";

const env = (vars: Record<string, string>) => (k: string) => vars[k];

Deno.test("AGENTORY_LOCAL_GIT_SHA is reported with source 'local'", () => {
  assertEquals(buildInfo(env({ AGENTORY_LOCAL_GIT_SHA: "e2e8014e916ba2502bc61e4c8529e23e8890ea8a" })),
    { sha: "e2e8014e916ba2502bc61e4c8529e23e8890ea8a", built_at: "unknown", source: "local" });
});

Deno.test("Railway's own commit still wins over a local value", () => {
  assertEquals(buildInfo(env({ RAILWAY_GIT_COMMIT_SHA: "abc1234", AGENTORY_LOCAL_GIT_SHA: "def5678" })).source, "railway");
});

Deno.test("a value that is not a commit SHA is ignored", () => {
  assertEquals(buildInfo(env({ AGENTORY_LOCAL_GIT_SHA: "not a sha; rm -rf" })).source, "none");
});
