// THE SWEEPER THE CONTINUATION PATH ALWAYS ASSUMED EXISTED.
//
// `leadContinuationDispatch` fires the next slice in process and documents the
// trade: "a slice which dies between writing its checkpoint and firing the next
// one stalls the chain… the existing claim/lease means a sweeper (or a user
// pressing Continue) can pick it up later without racing anything." This is
// that sweeper.
//
// ── A SCHEDULER ENTRY POINT, AND NOTHING ELSE ──────────────────────────────
//
// Modelled on `run-monitoring-tick`, for the same reason it gives: a scheduled
// resume and a manual one must be the SAME resume, or the thing that runs
// unattended is not the thing anybody tested. So this owns no provider, no
// engine, no mission and no writer. It selects, and it calls `run-agent` —
// the endpoint the in-process handoff and the Continue button both call.
//
// ── AND IT INVENTS NO LOCK ─────────────────────────────────────────────────
//
// Mutual exclusion is `claim_sourcing_continuation`, which `run-agent` already
// takes on every resume: `SELECT … FOR UPDATE`, a lease with an expiry, a
// terminal check and an optimistic `checkpoint_version`. Two sweepers racing
// the same task produce one claim and one 409 — and the 409 is a correct,
// quiet outcome here, not an error.
//
// Spend is bounded by the ceilings that already bound it: `continuations_used`,
// `cost_units_used`, and the credit authorisation at the provider boundary.
// `eligibleForAutoResume` reads them rather than adding any of its own.

import { withBuildStamp } from "../_shared/buildStamp.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { excludeV2OwnedTasks, loadV2OwnedTaskIdsStrict } from "../_shared/leadMissionV2Request.ts";
import {
  eligibleForAutoResume, resumeRequestFor, STALE_AFTER_MS, MAX_RESUMABLE_AGE_MS,
  type StalledTaskRow,
  resumeScanSkip, STALLED_SCAN_COLUMNS, type StalledScanRow,
} from "../_shared/stalledLeadResume.ts";
import { dispatchContinuation } from "../_shared/leadContinuationDispatch.ts";
import {
  lineageLeaseEnforced, lineageRootOf, readLineageLease, type SelectDb,
} from "../_shared/lineageLease.ts";
import { LEAD_EXECUTION_CALLS_TABLE } from "../_shared/executionLedger.ts";
import { functionUrl } from "../_shared/functionEndpoints.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

/** How many stalled tasks one tick may nudge. A ceiling on fan-out, not on work. */
const MAX_PER_TICK = 5;

/**
 * End a run that will never proceed, and say so where the user will see it.
 *
 * ── WHY THE SWEEPER IS ALLOWED TO DO THIS ──────────────────────────────────
 *
 * It is not asserting an outcome it did not observe. Every `terminate` verdict
 * is drawn from the row's own persisted counters — barren slices, continuations
 * used, cost units used, the restorability of its own checkpoint — so this
 * writes down a conclusion the row already contained and nobody had read.
 *
 * `already_terminal` is deliberately NOT a terminate verdict: something else
 * gave that row its status, and overwriting it would be exactly the
 * overreach this comment exists to rule out.
 *
 * THE SAVED STATE IS KEPT. Terminating means "this will not resume itself",
 * never "this is deleted". The checkpoint stays in `result`, the lineage row
 * keeps its `current_state`, and a person may still pick it up deliberately.
 *
 * Best-effort throughout: a sweeper that can fail a tick because a message
 * insert failed is worse than one that occasionally reports less.
 */
type Maybe = Promise<{ data: unknown; error: { code?: string } | null }>;

/**
 * Only what `endLineage` uses.
 *
 * Structural rather than `ReturnType<typeof createClient>`, which resolves its
 * schema generics to `never` without a generated Database type and rejects every
 * literal passed to `update` or `insert`. Same shape of cast the lease read
 * already uses in this file.
 */
interface SweeperDb {
  from(table: string): {
    select(cols: string): {
      // Chainable: the guarded read narrows on id AND status, so the row cannot
      // be ended after something else has already moved it out of `ready`.
      eq(c: string, v: string): {
        maybeSingle(): Maybe;
        eq(c2: string, v2: string): { maybeSingle(): Maybe };
      };
      filter(c: string, op: string, v: string): {
        order(c: string, o: { ascending: boolean }): {
          limit(n: number): { maybeSingle(): Maybe };
        };
      };
    };
    update(values: Record<string, unknown>): {
      eq(c: string, v: string): { eq(c2: string, v2: string): Maybe };
    };
    insert(values: Record<string, unknown>): Maybe;
  };
}

async function endLineage(
  admin: SweeperDb,
  row: StalledTaskRow,
  verdict: { reason: string; detail?: string },
): Promise<string> {
  const { data: current } = await admin.from("tasks")
    .select("result").eq("id", row.id).eq("status", "ready").maybeSingle();
  if (!current) return "not_ready_anymore";
  const prior = ((current as { result?: Record<string, unknown> }).result ?? {});

  const { error } = await admin.from("tasks").update({
    // `complete` plus a terminal status that is no longer `continuation_required`
    // — the pair `taskStatusContract` calls contradictory, and which three rows
    // in production hold today.
    status: "complete",
    finished_at: new Date().toISOString(),
    result: {
      ...prior,
      terminal_status: verdict.reason,
      terminated_by: {
        version: "stalled-lead-resume-v1",
        actor: "resume-stalled-leads",
        reason: verdict.reason,
        detail: verdict.detail ?? null,
        at: new Date().toISOString(),
      },
    },
  }).eq("id", row.id).eq("status", "ready");
  if (error) return `update_failed:${error.code ?? "unknown"}`;

  // ── AND TELL THE PERSON WHO ASKED ────────────────────────────────────────
  //
  // The conversation is reachable from the plan the run belongs to; nothing on
  // the task row carries it directly. No conversation is not a failure — an
  // internally triggered run may have none — it just means there is nobody to
  // tell.
  if (row.plan_id) {
    const { data: anchorMsg } = await admin.from("messages")
      .select("conversation_id").filter("metadata->>plan_id", "eq", row.plan_id)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    const conversationId = (anchorMsg as { conversation_id?: string } | null)?.conversation_id;
    if (conversationId) {
      await admin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        agent_slug: "pilot",
        content: STOP_NOTICE[verdict.reason] ??
          "This run has stopped and will not continue on its own. " +
          "What it found is saved.",
        metadata: {
          plan_id: row.plan_id, task_id: row.id, agent_id: "pilot",
          kind: "run_stopped", terminal_status: verdict.reason,
          detail: verdict.detail ?? null,
        },
      });
    }
  }
  return verdict.reason;
}

/**
 * What a stopped run says.
 *
 * No claim about spend or about what was evaluated — this function has read
 * neither ledger, and the audit's standing finding is that summaries asserting
 * either without reading them is how the product came to tell users "No credits
 * charged" while credits were being charged. These sentences describe the
 * SCHEDULING outcome only, which is the one thing the sweeper does know.
 */
const STOP_NOTICE: Readonly<Record<string, string>> = Object.freeze({
  no_progress:
    "I stopped this run: the last few passes examined nobody new, so continuing " +
    "would spend without finding anything. What it found is saved.",
  continuation_ceiling:
    "This run reached its continuation limit and has stopped. What it found is saved.",
  cost_ceiling:
    "This run reached its spending limit for this request and has stopped. " +
    "What it found is saved.",
  abandoned:
    "This run has been idle too long to pick itself up again, so I've stopped it. " +
    "Nothing was lost — what it found is saved.",
  nothing_to_resume:
    "This run has nothing left to pick up, so I've closed it. What it found is saved.",
});

Deno.serve(withBuildStamp(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // THE SCHEDULER IS THE ONLY CALLER. A person who wants to continue a run has
  // the Continue button, which goes to `run-agent` directly. A tick a browser
  // could trigger would be a way to spend a workspace's credits from outside.
  const authz = req.headers.get("Authorization") ?? "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!SERVICE_KEY || token !== SERVICE_KEY) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* a cron POST may send nothing */ }
  // A DRY RUN DECIDES AND DISPATCHES NOTHING — what the sweeper WOULD do,
  // before it is allowed to do it. This is how the live proof is taken.
  const dryRun = body.dry_run === true;
  const onlyTask = typeof body.task_id === "string" ? body.task_id : null;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = Date.now();

  // THE COARSE FILTER IS SQL; THE DECISION IS `eligibleForAutoResume`. Keeping
  // the rules in one pure function is what makes them testable — the query
  // only narrows, it never decides.
  // ── THE SCAN NARROWS. IT NO LONGER HIDES. ─────────────────────────────────
  //
  // This filtered on `created_at >= now - MAX_RESUMABLE_AGE_MS`, so a task that
  // was not picked up within two hours of being CREATED became invisible to the
  // sweeper for ever. Task 43355471 was scanned every three minutes for two
  // hours, refused `nothing_to_resume` each time, and then vanished from the
  // query holding 50 restorable companies and $0.153 of paid discovery. The log
  // went from `scanned: 1` to `scanned: 0` and nothing ever said why.
  //
  // A row the sweeper cannot SEE is a row it cannot END. The age rule belongs to
  // `eligibleForAutoResume`, which now abandons a task by terminating it rather
  // than by falling silent; the bound here exists only to keep the query
  // sensible and is deliberately far wider than any decision horizon.
  const SCAN_HORIZON_MS = 30 * 24 * 60 * 60_000;
  // ── THE SCAN DOES NOT CARRY THE RESULT (egress) ─────────────────────────
  //
  // This ran every three minutes over up to 50 rows and pulled `tasks.result`
  // with each one — 150-500 kB of engine resume state per row, for a decision
  // that starts with three short strings. `STALLED_SCAN_COLUMNS` projects those
  // three; the full result is fetched below, per row, only for rows that are
  // still candidates — so `eligibleForAutoResume` still sees exactly what it
  // saw before, and V2-owned rows (excluded moments later) are never fetched.
  let q = admin.from("tasks")
    .select(STALLED_SCAN_COLUMNS)
    // ── THE ROW STATES A STALLED CONTINUATION MAY BE FOUND IN ──────────────
    //
    // `ready` is the healthy checkpoint state and still the normal case. The
    // rest are rows a later writer stamped over the top of a valid checkpoint —
    // task a7a9371d, whose successor wrote `complete` on a row that still said
    // `terminal_status: continuation_required` with 22 candidates unexamined.
    // A row this query cannot SEE is a row nothing can ever recover.
    //
    // This is the set `isResumableRowStatus` and `claim_sourcing_continuation`
    // already accept, not a new one, and it is NOT "resume all complete tasks":
    // `eligibleForAutoResume` refuses anything whose terminal status is present
    // and not `continuation_required`, so `quota_met`, `frontier_exhausted` and
    // `cancelled` are still terminal, and a non-`ready` row must carry the
    // continuation claim EXPLICITLY to be considered at all.
    // `complete` ONLY, not the whole legacy set. `running` and `partial` belong
    // to `tasks_sweep_stuck_runs`, which moves a stuck row to `ready` before
    // this sweeper is meant to see it — two sweepers, one subject at a time —
    // and widening to them would put both on the same row.
    //
    // ── AND A `complete` ROW MUST CARRY THE CLAIM, IN SQL, NOT ONLY IN CODE ──
    //
    // This was `.in("status", ["ready", "complete"])`, and `eligibleForAutoResume`
    // was left to refuse the finished ones. It does refuse them — correctly, as
    // `already_terminal` — but a refusal changes nothing about the row, so it
    // matches again on the next tick, and the next, for ever.
    //
    // Measured on production the day it shipped: 72 rows in the window, 54 of
    // them finished runs that could never leave it. Ordered oldest-first with
    // `limit 50`, those permanent residents held the ENTIRE window, and the
    // lineages that genuinely needed resuming — which sort newest — were never
    // reached. Tasks a7a9371d, e01ad74f and 633ad466 all sat unswept behind
    // them, and every one had to be continued by hand.
    //
    // The predicate is the one `eligibleForAutoResume` and
    // `claim_sourcing_continuation` already enforce, moved to where it can
    // actually keep the window small: `ready`, or `complete` that still says
    // `continuation_required`. Same 14 candidates either way — the 54 simply
    // stop being fetched.
    .or(
      "status.eq.ready," +
        "and(status.eq.complete," +
        "result->>terminal_status.eq.continuation_required)",
    )
    .gte("created_at", new Date(now - SCAN_HORIZON_MS).toISOString())
    .lte("updated_at", new Date(now - STALE_AFTER_MS).toISOString())
    .order("updated_at", { ascending: true })
    .limit(50);
  if (onlyTask) q = q.eq("id", onlyTask);

  const { data, error } = await q;
  if (error) return json({ error: "tasks_unavailable", detail: error.message }, 500);
  const rows = ((data ?? []) as unknown) as StalledTaskRow[];

  // ── LEADMISSION V2 ISOLATION ──────────────────────────────────────────────
  // A task the V2 worker executes is resumed ONLY by that worker, which re-claims
  // its own queue row. Two resumers on one task is how a round gets paid twice,
  // and V1 finishing V2 missions would contaminate the V1/V2 comparison.
  // With no queue table or no V2 rows this excludes nothing. A read that FAILED
  // is not "no V2 tasks": the pass is skipped rather than resume — and possibly
  // end — a lineage the V2 worker owns. The next tick tries again.
  const v2Owned = await loadV2OwnedTaskIdsStrict(admin as never, rows.map((r) => r.id));
  if (v2Owned === null) {
    console.error("[resume-stalled-leads] V2 ownership unreadable: pass skipped", { candidates: rows.length });
    return json({ skipped: "v2_ownership_unreadable", candidates: rows.length });
  }
  const sweepable = excludeV2OwnedTasks(rows, v2Owned);

  const considered: Array<Record<string, unknown>> = [];
  let dispatched = 0;

  for (const scanned of sweepable) {
    // THE SKIPS THAT NEED NO RESULT: not ready, suppressed, already terminal —
    // the same three checks, in the same order, that `eligibleForAutoResume`
    // applies first, decided from the projected keys.
    const cheap = resumeScanSkip(scanned as unknown as StalledScanRow);
    if (cheap) {
      considered.push({ task_id: scanned.id, eligible: false, reason: cheap, result_read: false });
      continue;
    }
    // A CANDIDATE: now the whole result, for this row alone, so every decision
    // below — ceilings, checkpoint, mission, dispatch — reads what it always did.
    const { data: full } = await admin.from("tasks")
      .select("result").eq("id", scanned.id).maybeSingle();
    const row: StalledTaskRow = {
      ...(scanned as unknown as StalledTaskRow),
      result: ((full as { result?: Record<string, unknown> | null } | null)?.result) ?? null,
    };
    // PAID WORK WAITING TO BE ADOPTED — the strongest reason to come back, and
    // the one `recoverPendingRuns` will turn into a `GET` rather than a second
    // POST once the slice runs.
    // ── ASKED FOR EVERY ROW, NOT ONLY THE ONES ALREADY LABELLED RESUMABLE ──
    //
    // This was guarded on `terminal_status === "continuation_required"`, so any
    // row wearing another label reported `false` regardless of what the ledger
    // actually held — and `eligibleForAutoResume` then had no way to know a
    // paid call was still running.
    //
    // The guard was circular: the label is what the sweeper is deciding, and a
    // row mislabelled by an earlier slice could never present the one fact that
    // would have corrected it. Whether a provider is mid-sentence is a question
    // about the LEDGER, and the ledger answers it the same way whatever the row
    // says about itself.
    //
    // One indexed lookup per scanned row, on a window the query above already
    // keeps to fourteen.
    let hasStartedProviderRun = false;
    {
      const { data: started } = await admin.from(LEAD_EXECUTION_CALLS_TABLE)
        .select("provider_run_id")
        .eq("task_id", row.id).eq("workspace_id", row.workspace_id ?? "")
        .eq("status", "started").not("provider_run_id", "is", null).limit(1);
      hasStartedProviderRun = (started ?? []).length > 0;
    }

    const verdict = eligibleForAutoResume(row, now, { hasStartedProviderRun });
    const entry: Record<string, unknown> = {
      task_id: row.id, eligible: verdict.eligible, reason: verdict.reason,
      ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
      has_started_provider_run: hasStartedProviderRun,
    };

    // ── A DECISION, NOT A SHRUG ───────────────────────────────────────────
    //
    // `terminate` means this row will never proceed: its ceilings are spent, it
    // has gone barren, it has been silent past the horizon, or there is nothing
    // left to pick up. Leaving it `ready` is what produced nine permanently
    // stranded tasks, four of which the sweeper had personally refused dozens of
    // times.
    if (verdict.disposition === "terminate") {
      entry.terminated = dryRun
        ? "dry_run"
        : await endLineage(admin as unknown as SweeperDb, row, verdict);
      considered.push(entry);
      continue;
    }
    if (!verdict.eligible) { considered.push(entry); continue; }

    const request = resumeRequestFor(row);
    if (!request) {
      considered.push({ ...entry, eligible: false, reason: "incomplete_row" });
      continue;
    }
    entry.continuation_index = request.continuationIndex;

    // ── IS A GENERATION OF THIS LINEAGE ALREADY RUNNING? ──────────────────
    //
    // `eligibleForAutoResume` asks whether the TASK looks resumable. It cannot
    // ask whether the LINEAGE is busy, because until now nothing tracked that —
    // and a sweeper that dispatches into a live lineage is a third way to
    // produce the concurrent generations of 2026-08-29, alongside the two in
    // `continue-workflow`.
    //
    // Advisory, like the check in `continue-workflow`: run-agent's own acquire
    // is the authority. Reads as "not leased" when the table is absent, so this
    // is inert until the migration lands.
    const lineageId = lineageRootOf(row.id, row.result ?? null);
    const lineage = await readLineageLease(admin as unknown as SelectDb, lineageId, now);
    if (lineage.leased) {
      const enforced = lineageLeaseEnforced();
      considered.push({
        ...entry, eligible: !enforced, lineage_id: lineageId,
        reason: enforced ? "lineage_busy" : verdict.reason,
        lineage_lease: { held_by: lineage.heldBy, held_until: lineage.heldUntil, enforced },
      });
      if (enforced) continue;
    }

    if (dryRun) { considered.push({ ...entry, dispatched: "dry_run" }); continue; }
    if (dispatched >= MAX_PER_TICK) {
      considered.push({ ...entry, dispatched: "deferred_to_next_tick" });
      continue;
    }

    const outcome = await dispatchContinuation(request, {
      fetch: (url, init) => fetch(url, init),
      functionsBaseUrl: `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1`,
      // The resume path dispatches to run-agent, which may have moved.
      runAgentUrl: functionUrl("run-agent", (k) => Deno.env.get(k)),
      serviceRoleKey: SERVICE_KEY,
      log: (m, meta) => console.log(`[resume-stalled-leads] ${m}`, meta ?? ""),
    });
    // A 409 IS THE CLAIM WORKING, NOT A FAULT. Another worker got there first,
    // which is exactly what the lease is for.
    considered.push({ ...entry, dispatch: outcome });
    if (outcome.dispatched) dispatched++;
  }

  const terminated = considered.filter((c) => c.terminated && c.terminated !== "dry_run").length;
  console.log("[resume-stalled-leads] tick", {
    scanned: rows.length, dispatched, terminated, dry_run: dryRun,
  });
  return json({
    version: "resume-stalled-leads-v1",
    scanned: rows.length, dispatched, terminated, dry_run: dryRun, considered,
  });
}));
