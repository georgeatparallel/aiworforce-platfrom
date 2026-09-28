// A CHECKPOINT IS A COMPLETE RECORD, OR IT IS A STUCK ROW.
//
// ── THE RUN THIS REPRODUCES ────────────────────────────────────────────────
//
// Task 5c461aa3, 2026-08-28 16:36. The first run to complete real provider
// work: `harvestapi/linkedin-company-search` returned 30 companies,
// `harvestapi/linkedin-company` enriched 4, and the engine checkpointed at the
// stage boundary — 30 discovered, 10 shortlisted, 2 credits charged.
//
// The hiring search then started (`nyjSdju8xF7IEcgoc`), ran 116 seconds, and
// SUCCEEDED with 74 job items. The edge function's wall clock expired at ~186s
// and the platform killed the isolate mid-poll.
//
// The checkpoint had written `result` and nothing else. `tasks.status` stayed
// `running` forever, so the execution card spun; the terminal guard that exists
// to prevent exactly this could not help, because its `finally` does not run
// when an isolate is hard-killed. And because the row never became resumable,
// the ledger-based pending-run recovery — which already exists and would have
// adopted that finished dataset — was never reached.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { projectStatus } from "../../../supabase/functions/_shared/taskStatusContract.ts";
import { recoverPendingRuns } from "../../../supabase/functions/_shared/pendingRunRecovery.ts";
import { continuingCheckpointContent } from "../../../supabase/functions/_shared/runNotices.ts";

const SRC = await Deno.readTextFile(
  new URL("../../../supabase/functions/run-agent/index.ts", import.meta.url));

Deno.test("1. a checkpoint writes the row status, not only the result", () => {
  const i = SRC.indexOf('terminal_status: "continuation_required"');
  assert(i > 0, "the checkpoint write must exist");
  // The update object runs from here to the `.eq("id", task.id)` that closes it.
  const write = SRC.slice(i, SRC.indexOf('.eq("id", task.id)', i));
  assert(write.includes('status: projectStatus("continuation_required").rowStatus'),
    "status must be written with the result, from the shared mapping");
});

Deno.test("2. that status is the resumable one, not a terminal one", () => {
  const p = projectStatus("continuation_required");
  assertEquals(p.rowStatus, "ready", "the row must advertise itself as resumable");
  assertEquals(p.taskStatus, "partial", "and the workflow as unfinished");
});

Deno.test("3. the plan stops saying it is executing", () => {
  const i = SRC.indexOf('terminal_status: "continuation_required"');
  const after = SRC.slice(i, i + 9000);
  assert(after.includes('.update({ status: "partial" })'),
    "a checkpointed plan must not stay `executing` beside a resumable task");
  assert(after.includes('.eq("status", "executing")'),
    "and it must not overwrite a plan that already reached a verdict");
});

Deno.test("4. the checkpoint says so in the conversation", () => {
  // LIVE: the last thing the user saw was "I created a 1-step plan", then five
  // minutes of nothing while 30 companies sat saved behind a spinner.
  const i = SRC.indexOf('kind: "run_checkpoint"');
  assert(i > 0, "a checkpoint must announce itself");
  // Same widening as 4b, for the same reason: the ledger read sits between the
  // guard and the insert now.
  const notice = SRC.slice(Math.max(0, i - 6000), i);
  // ── A SAVE POINT, NOT A TIME LIMIT (2026-09-28) ─────────────────────────
  //
  // This required "hit its time limit". The notice is written at EVERY stage
  // boundary, so it said so 34 seconds into canary 11 while the slice carried
  // on — and the sentence outlived the lineage. The intent stands (the user is
  // told the work is saved); the wording is now true whatever happens next.
  assert(notice.includes("continuingCheckpointContent({"),
    "the wording comes from the notice builder the run's end also resolves");
  const said = continuingCheckpointContent({ queueOwned: false, resumable: true, cannotResume: "",
    summary: "30 companies found, 10 shortlisted", spendClause: "2 credits across 3 provider calls." });
  assert(said.startsWith("Progress saved — 30 companies found, 10 shortlisted."), said);
  assert(!/time limit|failed/.test(said), "a save point states neither a timeout nor a failure");
  // ── EXPLICIT ABOUT COST — FROM THE LEDGER, NOT FROM A CONSTANT ─────────
  //
  // This used to require the literal "Nothing is lost and nothing extra was
  // charged", which is the right INTENT expressed as the wrong implementation.
  // The sentence was unconditional and false every time a slice had bought
  // anything: at 11:13:03 on 2026-08-29 it was written while ten charged credit
  // rows existed on that lineage, two of them seconds old. The user this test
  // was written to protect — "because the user has already been charged twice"
  // — was being told the opposite of what the ledger said.
  assert(notice.includes("checkpointSpend"),
    "the card must state cost from a rendered figure, not a fixed phrase");
  assert(notice.includes("readSpendFacts("),
    "and that figure must be read from the ledger");
  // ANCHORED ON THE BLOCK, NOT ON A BYTE DISTANCE. This used to slice a fixed
  // window backwards from the metadata, so any comment added between the guard
  // and the insert failed it — a test that measures the length of prose rather
  // than the property it is about.
  const guard = SRC.lastIndexOf("if (!already)", i);
  assert(guard > 0, "the insert must be guarded");
  assert(SRC.slice(0, guard).includes('filter("metadata->>kind", "eq", "run_checkpoint")'),
    "one notice per plan, not one per checkpoint");
});

Deno.test("4b. and it only PROMISES a resume the gate will honour", () => {
  // Task 43355471: this notice said "Nothing is lost and nothing extra was
  // charged. Use Continue below" beside a button that answered "That run has no
  // stored company dataset to continue from." The sentence and the gate must be
  // decided by the same function.
  const i = SRC.indexOf('kind: "run_checkpoint"');
  // WIDENED. The card now reads the ledger before composing itself, and that
  // pushed `assessCheckpointResume` out of a 4200-character window. The
  // property is unchanged; the block containing it grew.
  // WIDENED AGAIN for the Lead V2 queue-owned notice, which sits in the same
  // block and says the worker continues automatically.
  const notice = SRC.slice(Math.max(0, i - 9000), i);
  assert(notice.includes("assessCheckpointResume("),
    "the wording must be derived from the same verdict `continue-workflow` uses");
  assert(notice.includes("resume.resumable"),
    "and branch on it rather than promising unconditionally");
  assert(notice.includes("queueOwned, resumable: resume.resumable, cannotResume,"),
    "the builder is handed the gate's verdict and its reason");
  assert(continuingCheckpointContent({ queueOwned: false, resumable: false,
    cannotResume: "the search itself had not finished", summary: null, spendClause: "" })
    .includes("it can't be picked up where it left off: the search itself had not finished"),
    "an unresumable checkpoint must say so plainly");
  assert(SRC.includes('assessCheckpointResume,\n} from "../_shared/workflowContinuation.ts"'),
    "imported from the gate's own module, not reimplemented");
});

Deno.test("5. a killed run's provider run is still recoverable from the ledger", () => {
  // The recovery already existed; the stuck row is what kept it unreachable.
  // These are the exact ledger fields the killed call left behind.
  //
  // `capability` here is the ACTOR key, which is what `pending_runs.provider`
  // holds — and `request_input.input` is what the fingerprint is built from, so
  // an adopted run can only satisfy a call asking the same thing. Both are
  // present on the production row; this is that row.
  const recovered = recoverPendingRuns([{
    capability: "apify_linkedin_job_search",
    provider_id: "apify",
    provider_run_id: "nyjSdju8xF7IEcgoc",
    dataset_id: "AoKBKfAtWGepM18rR",
    status: "started",
    started_at: "2026-08-28T16:37:40.700Z",
    request_input: { input: { company: ["acme"], sortBy: "date" } },
    // deno-lint-ignore no-explicit-any
  } as any]);
  assertEquals(recovered.length, 1,
    "a started run with an id, a dataset and a recorded input must be adoptable");
  assertEquals(recovered[0].run_id, "nyjSdju8xF7IEcgoc");
  assertEquals(recovered[0].dataset_id, "AoKBKfAtWGepM18rR");
  assert(recovered[0].input_fingerprint,
    "and it must carry a fingerprint, so it cannot satisfy a different call");

  // A run with no recorded input stays unadopted — the fingerprint is what
  // stops a batch of one inheriting a batch of ten's dataset.
  assertEquals(recoverPendingRuns([{
    capability: "apify_linkedin_job_search", provider_id: "apify",
    provider_run_id: "x", dataset_id: "y", status: "started",
    // deno-lint-ignore no-explicit-any
  } as any]).length, 0);
});

// ══ 6. RESUMING IS AN ACTION, NOT A SENTENCE ═══════════════════════════════

Deno.test("6. the checkpoint carries the ids a resume needs, and no typing instruction", () => {
  // LIVE, 16:49: the notice ended `say "continue" and I'll pick it up from
  // here`. Nothing was on the other end. The user did exactly that, Chat Brain
  // read "continue" against a conversation full of the original request and
  // returned `objective: source, route_reason: discovery`, and the product
  // previewed and ran a BRAND NEW sourcing job — re-buying 30 companies and the
  // enrichment the checkpoint already held. Two credits, immediately after a
  // message saying nothing extra would be charged.
  const i = SRC.indexOf('kind: "run_checkpoint"');
  assert(i > 0);
  // +1200: the metadata now also states `continuation_owner` (Lead V2).
  const notice = SRC.slice(Math.max(0, i - 3000), i + 1200);

  // THE SENTENCE ITSELF, not the comment explaining why it changed — that
  // comment quotes the old wording on purpose, and matching the whole region
  // would make the history of the fix look like the fix being absent.
  // A Lead V2 queue-owned checkpoint gets its own notice first (the worker
  // continues it — no button); every other checkpoint branches on the verdict.
  // The wording now lives in `continuingCheckpointContent`; the call site
  // hands it the gate's verdict and the ledger's figure.
  assert(notice.includes("content: noticeContent,"),
    "the notice's wording must depend on whether a resume is possible");
  const call = SRC.slice(SRC.indexOf("const noticeContent = continuingCheckpointContent({"),
    SRC.indexOf("const alreadyMsg", SRC.indexOf("const noticeContent")));
  assert(call.includes("resumable: resume.resumable"), "branched on the verdict, not promised");
  const v2 = continuingCheckpointContent({ queueOwned: true, resumable: true, cannotResume: "", summary: null, spendClause: "" });
  assertEquals(v2.includes("Continue"), false,
    "a mission the V2 queue continues must not invite a Continue click");
  const sentence = continuingCheckpointContent({ queueOwned: false, resumable: true, cannotResume: "", summary: null, spendClause: "" });
  assertEquals(/say "continue"/.test(sentence), false,
    "the notice must not instruct the user to type a word nothing interprets");
  assert(sentence.includes("Continue below"),
    "it must point at an affordance that exists");
  assert(sentence.includes("instead of searching again"),
    "and say what continuing avoids paying for");
  // The comment at the top of this test says it exactly: "Two credits,
  // immediately after a message saying nothing extra would be charged." Every
  // branch states the ledger's figure rather than a comforting constant.
  assert(call.includes("spendClause: checkpointSpend"),
    "the notice must state what was actually charged");
  assert(notice.includes("task_id: task.id") && notice.includes("plan_id"),
    "and carry the two ids `continue-workflow` takes");
  assert(notice.includes("checkpoint_summary"),
    "with what was saved, so the button can say what it will reuse");
});

Deno.test("7. a new paid preview discloses a paused run in the same conversation", () => {
  const pilot = Deno.readTextFileSync(new URL(
    "../../../supabase/functions/pilot-chat/index.ts", import.meta.url));
  const i = pilot.indexOf("const pausedRun = await");
  assert(i > 0, "the lead route must look for a paused run before previewing");

  const preview = pilot.indexOf("brainRoute.requires_confirmation && !isPreConfirmed");
  assert(i < preview, "the check must run before the preview is written");

  const block = pilot.slice(preview, preview + 1400);
  assert(block.includes("paused run in this conversation"),
    "the card must say the work already exists");
  assert(block.includes("reuses work you've already paid for"),
    "and say plainly which option costs nothing extra");

  // IT DISCLOSES, IT DOES NOT BLOCK. A genuinely new search stays one Start
  // away — refusing it would be a different kind of wrong.
  const guard = pilot.slice(i, i + 1800);
  assert(guard.includes('!== "ready"'),
    "a checkpoint already continued or finished must not be advertised");
  assert(guard.includes("return null;"),
    "and a disclosure that cannot be read must never fail the run");
});
