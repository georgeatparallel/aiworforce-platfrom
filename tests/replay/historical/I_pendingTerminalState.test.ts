// HISTORICAL I — "STILL BEING CHECKED" FOREVER (Query B a9a6791a, production 2026-10-12).
//
// The lineage ended search_exhausted with four companies pending — Shift
// Group, SonicJobs, RemoteHunter, TalentHop — and the Workbench said "4 still
// being checked". Nothing was checking them: the open-role route had already
// answered for each, so no executable route could prove the hiring claim, and
// none ever would. Pending, but not under investigation.
//
// The fix is deliberately conservative. Nothing is rejected and no job-board
// list is introduced: the company stays `pending` (a hard claim is unknown,
// never disproven), the counts and tabs are unchanged, and each pending lead
// now says WHICH kind of pending it is:
//
//   verifying     every unknown hard claim still has an executable route
//   unverifiable  nothing more will be bought for it in this run: some unknown
//                 hard claim has no executable route (every route that could
//                 prove it was already tried, none exists, or the budget closed
//                 it), or triage withheld paid verification — the caveats say
//                 which. Exactly the complement of `with_executable_route`.
//
// ZERO network, ZERO models, ZERO providers.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canStillQualify } from "../../../supabase/functions/_shared/evidenceGapRouter.ts";
import { countsAreExclusive } from "../../../supabase/functions/_shared/workbenchMissionView.ts";
import { canonicalView } from "../lib/verification.ts";
import { queryBFixture, replayLineage } from "../lib/queryB.ts";

const fx = queryBFixture();

async function finalView() {
  const { s3 } = await replayLineage(fx);
  return canonicalView({ companies: s3.companies }, s3.mission, fx.provenance.task_id) as unknown as {
    counts: Record<string, number>; pending_unverifiable?: number;
    evidence_gaps: { pending: number; with_executable_route: number };
    leads: Array<{ company: { name: string | null }; bucket: string; pending_state?: string | null;
      evidence_gaps: Array<{ next: string; considered: Array<{ budget_closed?: boolean }> }> }>;
  };
}

Deno.test("[historical] I every pending lead says whether anything can still prove it", async () => {
  const v = await finalView();
  const pending = v.leads.filter((l) => l.bucket === "pending");
  assert(pending.length > 0);
  for (const l of pending) {
    const want = canStillQualify(l.evidence_gaps as never) ? "verifying" : "unverifiable";
    assertEquals(l.pending_state, want, `${l.company.name}: ${JSON.stringify(l.evidence_gaps.map((g) => g.next))}`);
  }
  for (const l of v.leads.filter((x) => x.bucket !== "pending")) assertEquals(l.pending_state ?? null, null);
});

Deno.test("[historical] I the job boards with an answered open-role route are unverifiable, not 'still being checked'", async () => {
  const v = await finalView();
  const state = (n: string) => v.leads.find((l) => l.company.name === n)?.pending_state;
  for (const n of ["Shift Group", "SonicJobs", "RemoteHunter", "TalentHop"]) {
    assertEquals(state(n), "unverifiable", n);
  }
});

Deno.test("[historical] I conservative: still pending (never rejected), buckets unchanged, the count is a subset", async () => {
  const v = await finalView();
  assert(countsAreExclusive(v.counts as never), "buckets still sum to discovered");
  const unverifiable = v.leads.filter((l) => l.pending_state === "unverifiable");
  assert(unverifiable.every((l) => l.bucket === "pending"), "unverifiable is a kind of pending, not a rejection");
  assertEquals(v.pending_unverifiable, unverifiable.length);
  assertEquals(v.counts.pending - (v.pending_unverifiable ?? 0), v.evidence_gaps.with_executable_route,
    "pending = still verifiable + unverifiable");
});
