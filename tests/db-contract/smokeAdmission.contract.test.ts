// Durable smoke admission against real Postgres + real PostgREST, through the
// runtime's own RPC wrappers (smokeAdmission.ts) and the worker's role
// (`service_role`). Held migration:
// supabase/migrations-held/20261015140000_discovery_smoke_admission.sql.
//
// Every limit is exercised at its edge, every refusal by name, and the races
// on real concurrent sessions: PostgREST's own connection pool, plus a second
// SQL session holding the authorization lock.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  admitOperation, findParent, loadAuthorization, recordReceipt, type AdmitArgs, type AdmissionDb,
} from "../../supabase/functions/_shared/smokeAdmission.ts";
import { mintJwt, REST_URL, serviceClient, sql, uuid } from "./lib/harness.ts";
import {
  authorizeSmoke, CLAUDE, DETAILS, GPT, hex, JOBS, MAP, SCRAPE, seedSmokeMission, syntheticActorLimits,
  syntheticQuotes, type SmokeMission,
} from "./lib/smokeMission.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const opts = { sanitizeResources: false, sanitizeOps: false };
const db = async () => (await serviceClient()) as unknown as AdmissionDb;
/** A fresh 64-hex payload digest. */
const h = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

function op(m: SmokeMission, over: Partial<AdmitArgs> = {}): AdmitArgs {
  return {
    queueId: m.queueId, workerId: m.workerId, taskId: m.taskId, generation: m.generation,
    key: `k-${uuid()}`, kind: "model", actor: GPT, templateId: "gpt", payloadHash: h(), ...over,
  };
}
const admit = async (a: AdmitArgs) => admitOperation(await db(), a);
const provider = (m: SmokeMission, actor: string, templateId: string, over: Partial<AdmitArgs> = {}) =>
  op(m, { kind: "provider", actor, templateId, key: `provider:${actor}:${uuid()}`, ...over });
async function ops(m: SmokeMission) {
  return await sql`select o.* from public.discovery_smoke_operations o
    join public.discovery_smoke_authorizations a on a.id = o.authorization_id where a.queue_id = ${m.queueId}`;
}

// ── admission and its charge ────────────────────────────────────────────────

Deno.test("admission: the template's maximum is charged, durably, before anything is sent", opts, async () => {
  const m = await seedSmokeMission();
  const d = await admit(provider(m, JOBS, "apify_jobs"));
  assertEquals(d.decision, "admitted");
  assertEquals((d as { committed_microusd: number }).committed_microusd, 60000);
  const rows = await ops(m);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].committed_microusd, "60000");
  assertEquals(rows[0].discovery_page, true);
  assertEquals(rows[0].generation, m.generation);
  const auth = await loadAuthorization(await db(), m.queueId);
  assert(auth && auth !== "unavailable");
  assertEquals(auth.status, "active", "the worker can read its authorization");
});

Deno.test("admission: a template that does not name this kind and actor is an unknown price", opts, async () => {
  const m = await seedSmokeMission();
  assertEquals((await admit(op(m, { templateId: "nope" }))).decision, "unknown_quote");
  assertEquals((await admit(op(m, { actor: "openai:gpt-5" }))).decision, "unknown_quote");
  assertEquals((await admit(provider(m, JOBS, "gpt"))).decision, "unknown_quote");
  assertEquals((await admit(provider(m, "apify:someone~else", "apify_jobs"))).decision, "unknown_quote");
  assertEquals((await ops(m)).length, 0, "nothing was reserved for an unknown price");
});

// ── combined money, counts, actors, pages, polls ────────────────────────────

/** Model templates cheap enough that the attempt count, not the dollars, binds. */
function cheapModels() {
  const q = syntheticQuotes();
  (q.gpt as { maximum_microusd: number }).maximum_microusd = 10000;
  (q.claude as { maximum_microusd: number }).maximum_microusd = 10000;
  return q;
}

Deno.test("model: four attempts, then refused; failed attempts keep their slot", opts, async () => {
  const m = await seedSmokeMission({ quotes: cheapModels() });
  for (let i = 0; i < 4; i++) assertEquals((await admit(op(m))).decision, "admitted", `attempt ${i + 1}`);
  assertEquals((await admit(op(m, { actor: CLAUDE, templateId: "claude" }))).decision, "model_attempt_limit",
    "a fallback model is another attempt, not a free retry");
});

Deno.test("model: the $0.05 model ceiling binds before the attempt count", opts, async () => {
  const quotes = syntheticQuotes();
  (quotes.gpt as { maximum_microusd: number }).maximum_microusd = 20000;
  const m = await seedSmokeMission({ quotes });
  assertEquals((await admit(op(m))).decision, "admitted");
  assertEquals((await admit(op(m))).decision, "admitted");
  assertEquals((await admit(op(m))).decision, "usd_limit", "60000 > 50000: refused with attempts to spare");
});

Deno.test("money: provider $0.20 and combined $0.25 are shared by every kind", opts, async () => {
  const quotes = syntheticQuotes();
  (quotes.apify_details as { maximum_microusd: number }).maximum_microusd = 150000;
  const limits = { ...syntheticActorLimits, [DETAILS]: 2 };
  const m = await seedSmokeMission({ quotes, actorLimits: limits });
  assertEquals((await admit(provider(m, JOBS, "apify_jobs"))).decision, "admitted");       // 60000
  assertEquals((await admit(provider(m, DETAILS, "apify_details"))).decision, "usd_limit", "60000 + 150000 > provider 200000");
  const m2 = await seedSmokeMission({ quotes });
  assertEquals((await admit(provider(m2, DETAILS, "apify_details"))).decision, "admitted"); // 150000
  for (let i = 0; i < 4; i++) assertEquals((await admit(op(m2))).decision, "admitted", `model ${i + 1}`); // 48000
  // 150000 + 48000 = 198000; a 10000 scrape fits the provider cap (160000) and the combined cap (208000).
  assertEquals((await admit(provider(m2, SCRAPE, "fc_scrape"))).decision, "admitted");
  const total = (await ops(m2)).reduce((s, r) => s + Number(r.committed_microusd), 0);
  assert(total <= 250000, `combined ${total} stays within $0.25`);
  // The per-kind caps sum to exactly $0.25, so the combined cap only binds on
  // its own when an administrator sets it lower. It is checked all the same.
  const m3 = await seedSmokeMission();
  await sql`update public.discovery_smoke_authorizations set total_microusd = 70000 where queue_id = ${m3.queueId}`;
  assertEquals((await admit(provider(m3, JOBS, "apify_jobs"))).decision, "admitted");          // 60000
  assertEquals((await admit(op(m3))).decision, "usd_limit", "60000 + 12000 > combined 70000, within both per-kind caps");
});

Deno.test("counts: per-actor limits, one discovery page, five purchases", opts, async () => {
  const m = await seedSmokeMission();
  assertEquals((await admit(provider(m, JOBS, "apify_jobs"))).decision, "admitted");
  assertEquals((await admit(provider(m, JOBS, "apify_jobs"))).decision, "page_limit", "the second discovery page is refused");
  assertEquals((await admit(provider(m, SCRAPE, "fc_scrape"))).decision, "admitted");
  assertEquals((await admit(provider(m, SCRAPE, "fc_scrape"))).decision, "actor_limit", "one scrape");
  assertEquals((await admit(provider(m, MAP, "fc_map"))).decision, "admitted");
  assertEquals((await admit(provider(m, DETAILS, "apify_details"))).decision, "admitted");
  assertEquals((await admit(provider(m, "firecrawl:crawl", "polls"))).decision, "unknown_quote", "crawl has no purchase template");
  // Four purchases so far; the fifth would need an actor with room left.
  const q = syntheticQuotes({ fc_extra: { ...syntheticQuotes().fc_map as object, allowed_actors: ["firecrawl:extra"] } });
  const m2 = await seedSmokeMission({ quotes: q, actorLimits: { ...syntheticActorLimits, "firecrawl:extra": 5 } });
  for (let i = 0; i < 5; i++) assertEquals((await admit(provider(m2, "firecrawl:extra", "fc_extra"))).decision, "admitted");
  assertEquals((await admit(provider(m2, "firecrawl:extra", "fc_extra"))).decision, "purchase_limit");
});

Deno.test("polls: five across the whole mission, each tied to a purchase this mission made", opts, async () => {
  const m = await seedSmokeMission();
  const buy = provider(m, JOBS, "apify_jobs");
  const d = await admit(buy);
  assertEquals(d.decision, "admitted");
  const poll = (parentKey: string | null) => op(m, { kind: "poll", actor: JOBS, templateId: "polls", key: `poll:${uuid()}`, parentKey });
  assertEquals((await admit(poll(`provider:${JOBS}:nothing`))).decision, "missing_parent");
  assertEquals((await admit(op(m, { kind: "poll", actor: DETAILS, templateId: "polls", key: `poll:${uuid()}`, parentKey: buy.key }))).decision,
    "missing_parent", "a poll belongs to its parent's actor");
  for (let i = 0; i < 5; i++) assertEquals((await admit(poll(buy.key))).decision, "admitted", `poll ${i + 1}`);
  assertEquals((await admit(poll(buy.key))).decision, "poll_limit");
  // The worker finds a poll's parent by the run id the purchase recorded.
  const tok = (d as { reservation_token: string }).reservation_token;
  assert(await recordReceipt(await db(), { queueId: m.queueId, key: buy.key, token: tok, runId: "run-1", datasetId: "ds-1" }));
  const auth = await loadAuthorization(await db(), m.queueId);
  assert(auth && auth !== "unavailable");
  assertEquals((await findParent(await db(), auth.id, { runId: "run-1" }))?.operation_key, buy.key);
  assertEquals((await findParent(await db(), auth.id, { datasetId: "ds-1" }))?.operation_key, buy.key);
  assertEquals(await findParent(await db(), auth.id, { runId: "someone-elses-run" }), null);
});

// ── replays never buy twice ─────────────────────────────────────────────────

Deno.test("replay: the same key, or the same payload under a new key, is never a second purchase", opts, async () => {
  const m = await seedSmokeMission();
  const buy = provider(m, JOBS, "apify_jobs");
  const first = await admit(buy);
  assertEquals(first.decision, "admitted");
  assertEquals((await admit(buy)).decision, "uncertain", "no run id yet: may already exist, never sent again");
  const rekeyed = await admit({ ...buy, key: `provider:${JOBS}:${uuid()}` });
  assertEquals(rekeyed.decision, "uncertain");
  assertEquals((rekeyed as { operation_key: string }).operation_key, buy.key, "the original operation answers");
  assertEquals((await admit({ ...buy, payloadHash: h() })).decision, "operation_mismatch", "a key is never reused for another payload");
  const tok = (first as { reservation_token: string }).reservation_token;
  assert(await recordReceipt(await db(), { queueId: m.queueId, key: buy.key, token: tok, runId: "run-a" }));
  const adopt = await admit(buy);
  assertEquals(adopt.decision, "adopt");
  assertEquals((adopt as { provider_run_id: string }).provider_run_id, "run-a");
  assertEquals((await ops(m)).length, 1, "one operation, however often it is asked");
});

Deno.test("receipt: wrong token refused; run id immutable; an over-quote charge stops the mission", opts, async () => {
  const m = await seedSmokeMission();
  const buy = provider(m, JOBS, "apify_jobs");
  const d = await admit(buy) as { reservation_token: string };
  assertEquals(await recordReceipt(await db(), { queueId: m.queueId, key: buy.key, token: uuid(), runId: "x" }), false);
  assert(await recordReceipt(await db(), { queueId: m.queueId, key: buy.key, token: d.reservation_token, runId: "run-1" }));
  assertEquals(await recordReceipt(await db(), { queueId: m.queueId, key: buy.key, token: d.reservation_token, runId: "run-2" }), false);
  assert(await recordReceipt(await db(), { queueId: m.queueId, key: buy.key, token: d.reservation_token, runId: "run-1" }), "the same id again is fine");
  assert(await recordReceipt(await db(), {
    queueId: m.queueId, key: buy.key, token: d.reservation_token, reportedMicrousd: 60001, source: "apify_run.usageTotalUsd",
  }));
  const [a] = await sql`select status, stop_reason from public.discovery_smoke_authorizations where queue_id = ${m.queueId}`;
  assertEquals(a.status, "stopped");
  assert(String(a.stop_reason).startsWith("reported_charge_exceeded_quote"));
  assertEquals((await admit(op(m))).decision, "stopped", "a wrong bound stops all further spending");
  const [o] = await ops(m);
  assertEquals(o.committed_microusd, "60000", "the commitment is never repriced or released");
});

// ── ownership, generation, cancellation, deadline ───────────────────────────

Deno.test("ownership: queue claim, queue lease, lineage lease, task binding and generation all fence", opts, async () => {
  const cases: Array<[string, (m: SmokeMission) => Promise<unknown>, string]> = [
    ["another worker holds the queue row", (m) => sql`update public.lead_mission_queue set claimed_by = ${uuid()} where id = ${m.queueId}`, "lost_ownership"],
    ["the queue lease expired", (m) => sql`update public.lead_mission_queue set lease_expires_at = now() - interval '1 second' where id = ${m.queueId}`, "lost_ownership"],
    ["the lineage lease moved", (m) => sql`update public.lead_lineages set lease_holder = ${uuid()} where lineage_id = ${m.taskId}`, "lost_ownership"],
    ["the lineage lease expired", (m) => sql`update public.lead_lineages set lease_expires_at = now() - interval '1 second' where lineage_id = ${m.taskId}`, "lost_ownership"],
    ["a newer claim bumped the generation", (m) => sql`update public.tasks set checkpoint_version = checkpoint_version + 1 where id = ${m.taskId}`, "stale_generation"],
    ["the task finished", (m) => sql`update public.tasks set status = 'complete' where id = ${m.taskId}`, "stale_generation"],
    ["the task failed", (m) => sql`update public.tasks set status = 'failed' where id = ${m.taskId}`, "stale_generation"],
    ["re-claimed after a checkpoint", (m) => sql`update public.tasks set status = 'ready', checkpoint_version = checkpoint_version + 1 where id = ${m.taskId}`, "stale_generation"],
    ["the lineage ended", (m) => sql`update public.lead_lineages set status = 'terminal', terminal_reason = 'cancelled' where lineage_id = ${m.taskId}`, "stopped"],
    ["the mission was cancelled", (m) => sql`select * from public.cancel_lead_mission(${m.queueId}, ${m.ws})`, "stopped"],
    ["the request was edited after approval", (m) => sql`update public.lead_mission_queue set request = request || '{"lead_count": 500}' where id = ${m.queueId}`, "identity_mismatch"],
  ];
  for (const [why, mutate, want] of cases) {
    const m = await seedSmokeMission();
    assertEquals((await admit(op(m))).decision, "admitted", `${why}: admitted before`);
    await mutate(m);
    assertEquals((await admit(op(m))).decision, want, why);
  }
  // The slice's own stage-boundary checkpoint writes the row `ready` mid-run
  // (offline rehearsal on PR #94: every admission after the first checkpoint
  // was refused). Same generation, leases held: still this slice's.
  const c = await seedSmokeMission();
  await sql`update public.tasks set status = 'ready' where id = ${c.taskId}`;
  assertEquals((await admit(op(c))).decision, "admitted", "a checkpoint is not a release");
  const m = await seedSmokeMission();
  assertEquals((await admit(op(m, { taskId: uuid() }))).decision, "lost_ownership", "a task not bound to the queue row");
  assertEquals((await admit(op(m, { workerId: uuid() }))).decision, "lost_ownership", "a worker that is not the claimant");
});

Deno.test("stop: one-way; the worker can stop its authorization but never restart it", opts, async () => {
  const m = await seedSmokeMission();
  const svc = await serviceClient();
  const { data } = await svc.rpc("stop_discovery_smoke", { p_queue: m.queueId, p_reason: "operator" });
  assertEquals(data, true);
  assertEquals((await admit(op(m))).decision, "stopped");
  const { error } = await svc.from("discovery_smoke_authorizations").update({ status: "active", stop_reason: null }).eq("queue_id", m.queueId);
  assert(error, "service_role cannot write the authorization");
  assertEquals((await admit(op(m))).decision, "stopped");
});

Deno.test("deadline: absolute, from the queue row, read after the lock, never renewed", opts, async () => {
  // A row enqueued 299 s ago has one second left.
  const m = await seedSmokeMission({ ageSeconds: 299 });
  const [a] = await sql`select deadline_at, (select created_at from public.lead_mission_queue where id = ${m.queueId}) + interval '300 seconds' as want
                        from public.discovery_smoke_authorizations where queue_id = ${m.queueId}`;
  assertEquals(String(a.deadline_at), String(a.want), "deadline = queue created_at + 300 s");
  await new Promise((r) => setTimeout(r, 1500));
  assertEquals((await admit(op(m))).decision, "stopped");

  // Approving too late is refused rather than starting a fresh window.
  const late = await seedSmokeMission({ ageSeconds: 301, authorize: false });
  await assertRejects(() => authorizeSmoke(late.queueId), Error, "window has already passed");

  // A second approval returns the same row and deadline; a different one refuses.
  const quotes = syntheticQuotes();
  const again = await seedSmokeMission({ quotes });
  assertEquals(await authorizeSmoke(again.queueId, { quotes }), again.authorizationId);
  await assertRejects(() => authorizeSmoke(again.queueId, { quotes: syntheticQuotes({ extra: syntheticQuotes().gpt }) }), Error, "cannot be replaced");
  await assertRejects(() => authorizeSmoke(again.queueId, { quotes, windowSeconds: 600 }), Error);
});

Deno.test("deadline: an admission that waited on the lock past the deadline is refused", opts, async () => {
  const m = await seedSmokeMission({ ageSeconds: 298 });   // two seconds left
  const svc = await db();
  // Session A holds the authorization row across the deadline; B's admission waits on it.
  const holder = sql.begin(async (tx) => {
    await tx`select id from public.discovery_smoke_authorizations where queue_id = ${m.queueId} for update`;
    await new Promise((r) => setTimeout(r, 3000));
  });
  await new Promise((r) => setTimeout(r, 200));
  const waited = await admitOperation(svc, op(m));
  await holder;
  assertEquals(waited.decision, "stopped", "the clock is read after the lock, not at transaction start");
});

// ── restart, re-enqueue, re-claim ───────────────────────────────────────────

Deno.test("restart: a new worker and a new generation inherit every counter; a new queue row inherits nothing", opts, async () => {
  const m = await seedSmokeMission({ quotes: cheapModels() });
  for (let i = 0; i < 3; i++) assertEquals((await admit(op(m))).decision, "admitted");
  assertEquals((await admit(provider(m, JOBS, "apify_jobs"))).decision, "admitted");
  // The worker dies; another claims the row and the handler's resume claim bumps the generation.
  const worker2 = uuid();
  await sql`update public.lead_mission_queue set claimed_by = ${worker2} where id = ${m.queueId}`;
  await sql`update public.tasks set checkpoint_version = checkpoint_version + 1 where id = ${m.taskId}`;
  const m2 = { ...m, workerId: worker2, generation: m.generation + 1 };
  assertEquals((await admit(op(m))).decision, "lost_ownership", "the dead worker's credentials buy nothing");
  assertEquals((await admit(op(m2))).decision, "admitted", "4th model attempt");
  assertEquals((await admit(op(m2))).decision, "model_attempt_limit", "the restart did not reset the count");
  assertEquals((await admit(provider(m2, JOBS, "apify_jobs"))).decision, "page_limit");
  // Re-enqueueing the same request is a new queue row with no authorization.
  const fresh = uuid();
  await sql`insert into public.lead_mission_queue (id, workspace_id, request, status, claimed_by, lease_expires_at, task_id, lineage_id)
            select ${fresh}, workspace_id, request, 'running', ${worker2}, now() + interval '3 minutes', task_id, lineage_id
              from public.lead_mission_queue where id = ${m.queueId}`;
  assertEquals((await admit({ ...op(m2), queueId: fresh })).decision, "not_authorized");
});

// ── races on real concurrent sessions ───────────────────────────────────────

Deno.test("race: an admission still in flight holds the last slot until it commits", opts, async () => {
  // Deterministic: session A takes the 4th model attempt and holds its
  // transaction open; session B asks for a 5th meanwhile. B must wait on the
  // authorization row and then see A's reservation, never the count before it.
  const m = await seedSmokeMission({ quotes: cheapModels() });
  for (let i = 0; i < 3; i++) assertEquals((await admit(op(m))).decision, "admitted");
  const a4 = op(m);
  let bDecision = "";
  await sql.begin(async (tx) => {
    const [r] = await tx`select public.admit_discovery_smoke(${m.queueId}, ${m.workerId}, ${m.taskId}, ${m.generation},
      ${a4.key}, 'model', ${GPT}, 'gpt', ${a4.payloadHash}, null) as d`;
    assertEquals((r.d as { decision: string }).decision, "admitted");
    const b = admitOperation(await db(), op(m)).then((d) => { bDecision = d.decision; });
    await new Promise((res) => setTimeout(res, 800));
    assertEquals(bDecision, "", "B is still waiting on A's lock");
    void b;
  });
  for (let i = 0; i < 50 && !bDecision; i++) await new Promise((res) => setTimeout(res, 50));
  assertEquals(bDecision, "model_attempt_limit");
  assertEquals((await ops(m)).length, 4);
});

Deno.test("race: twelve simultaneous model admissions, exactly four admitted", opts, async () => {
  const m = await seedSmokeMission();
  const svc = await db();
  const res = await Promise.all(Array.from({ length: 12 }, () => admitOperation(svc, op(m))));
  assertEquals(res.filter((r) => r.decision === "admitted").length, 4, JSON.stringify(res.map((r) => r.decision)));
  assertEquals((await ops(m)).length, 4);
});

Deno.test("race: two purchases racing for the last provider dollars cannot both win", opts, async () => {
  // After a 60000 job search, 140000 provider dollars remain: either 80000
  // purchase fits alone, both together (160000) do not. The combined cap
  // (250000) would admit both, so only the provider cap decides.
  const quotes = syntheticQuotes();
  (quotes.apify_details as { maximum_microusd: number }).maximum_microusd = 80000;
  (quotes.fc_scrape as { maximum_microusd: number }).maximum_microusd = 80000;
  for (let round = 0; round < 5; round++) {
    const m = await seedSmokeMission({ quotes });
    assertEquals((await admit(provider(m, JOBS, "apify_jobs"))).decision, "admitted");
    const svc = await db();
    const [a, b] = await Promise.all([
      admitOperation(svc, provider(m, DETAILS, "apify_details")),
      admitOperation(svc, provider(m, SCRAPE, "fc_scrape")),
    ]);
    const provider$ = (await ops(m)).reduce((s, r) => s + Number(r.committed_microusd), 0);
    assert(provider$ <= 200000, `round ${round}: ${a.decision}/${b.decision} committed ${provider$}`);
    assertEquals([a.decision, b.decision].filter((d) => d === "admitted").length, 1, `round ${round}`);
    assert([a.decision, b.decision].includes("usd_limit"));
  }
});

Deno.test("race: duplicate dispatch of one purchase from two sessions admits exactly one", opts, async () => {
  const m = await seedSmokeMission();
  const svc = await db();
  const payloadHash = h();
  const res = await Promise.all(Array.from({ length: 6 }, () =>
    admitOperation(svc, provider(m, JOBS, "apify_jobs", { payloadHash }))));
  assertEquals(res.filter((r) => r.decision === "admitted").length, 1, JSON.stringify(res.map((r) => r.decision)));
  assert(res.every((r) => r.decision === "admitted" || r.decision === "uncertain"));
});

// ── the worker's credentials cannot widen, reset or recreate ────────────────

Deno.test("privileges: service_role reads and admits; it cannot authorize, insert, update or delete", opts, async () => {
  const m = await seedSmokeMission();
  await admit(op(m));
  const svc = await serviceClient();
  const quotes = syntheticQuotes();
  const { error: authErr } = await svc.rpc("authorize_discovery_smoke", {
    p_queue: m.queueId, p_pricing_version: "x", p_approved_quotes: quotes, p_actor_limits: {}, p_window_seconds: 300,
  });
  assert(authErr, "the worker cannot mint an authorization");
  assert(/permission denied/i.test(authErr.message), authErr.message);
  const { error: ins } = await svc.from("discovery_smoke_authorizations").insert({
    queue_id: m.queueId, workspace_id: m.ws, criteria_hash: hex("a"), pricing_version: "x",
    approved_quotes: quotes, actor_limits: {}, deadline_at: new Date(Date.now() + 60000).toISOString(),
  });
  assert(ins, "no insert");
  const { error: upd } = await svc.from("discovery_smoke_authorizations").update({ deadline_at: "2099-01-01T00:00:00Z", model_attempts: 4 }).eq("queue_id", m.queueId);
  assert(upd, "no update");
  const { error: del } = await svc.from("discovery_smoke_operations").delete().eq("task_id", m.taskId);
  assert(del, "no delete of a reservation");
  const { error: opIns } = await svc.from("discovery_smoke_operations").insert({ authorization_id: m.authorizationId, operation_key: "forged" });
  assert(opIns, "no forged operation");
  assertEquals((await ops(m)).length, 1, "the one real reservation is intact");
  for (const role of ["anon", "authenticated"] as const) {
    const c = createClient(REST_URL, await mintJwt(role, uuid()), {
      auth: { persistSession: false },
      global: { fetch: (u, i) => fetch(String(u).replace(`${REST_URL}/rest/v1`, REST_URL), i) },
    });
    const { error } = await c.rpc("admit_discovery_smoke", {
      p_queue: m.queueId, p_worker: m.workerId, p_task: m.taskId, p_generation: m.generation,
      p_key: "x", p_kind: "model", p_actor: GPT, p_template: "gpt", p_payload_hash: h(), p_parent_key: null,
    });
    assert(error, `${role} cannot admit`);
    const { data } = await c.from("discovery_smoke_authorizations").select("id");
    assertEquals(data ?? [], [], `${role} reads nothing`);
  }
});

Deno.test("authorize: refuses stale, future, unbounded or evidence-free prices", opts, async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["stale observation", { gpt: { ...syntheticQuotes().gpt as object, observed_at: new Date(Date.now() - 25 * 3600e3).toISOString() } }],
    ["future observation", { gpt: { ...syntheticQuotes().gpt as object, observed_at: new Date(Date.now() + 3600e3).toISOString() } }],
    ["no source", { gpt: { ...syntheticQuotes().gpt as object, source: "" } }],
    ["no bound reference", { gpt: { ...syntheticQuotes().gpt as object, liability_bound_ref: " " } }],
    ["maximum above the mission", { gpt: { ...syntheticQuotes().gpt as object, maximum_microusd: 250001 } }],
    ["fractional maximum", { gpt: { ...syntheticQuotes().gpt as object, maximum_microusd: 1.5 } }],
    ["unknown kind", { gpt: { ...syntheticQuotes().gpt as object, allowed_kinds: ["page"] } }],
    ["no request limits", { gpt: { ...syntheticQuotes().gpt as object, request_limits: null } }],
  ];
  for (const [why, over] of bad) {
    const m = await seedSmokeMission({ authorize: false });
    await assertRejects(() => authorizeSmoke(m.queueId, { quotes: syntheticQuotes(over) }), Error, undefined, why);
  }
  const m = await seedSmokeMission({ authorize: false });
  await assertRejects(() => authorizeSmoke(m.queueId, { actorLimits: { [JOBS]: -1 } as never }), Error, "actor limit");
});

// ── rollback refuses while there is anything to account for ────────────────

Deno.test("rollback: refuses while any authorization exists, and changes nothing", opts, async () => {
  const m = await seedSmokeMission();
  await admit(op(m));
  const down = await Deno.readTextFile(new URL(
    "../../supabase/migrations-held/rollback/20261015140000_discovery_smoke_admission.down.sql", import.meta.url));
  // One reserved connection, rolled back after, so the pool never keeps an aborted transaction.
  const one = await sql.reserve();
  try {
    await assertRejects(() => one.unsafe(down), Error, "audit rows exist");
  } finally {
    await one`rollback`.catch(() => {});
    one.release();
  }
  const [{ n }] = await sql`select count(*)::int as n from public.discovery_smoke_operations`;
  assert(n >= 1, "the audit survives");
  assertEquals((await admit(op(m))).decision, "admitted", "the RPCs still exist");
});

// ── Codex review R8: ownership is fenced through the admission's commit ──────
//
// An admission is paused just before its reservation is written (a trigger
// waits on an advisory lock this test holds). While it is in flight, a
// cancellation, a generation bump or a lease change must NOT be able to commit
// (it waits on the admission's FOR SHARE locks; `lock_timeout` makes the wait
// observable instead of hanging). Released, the admission commits ordered
// BEFORE the change; once the change commits, the next admission is refused.
const R8_CHANGES: Array<[string, (m: SmokeMission) => string, string]> = [
  ["cancellation", (m) => `update public.lead_mission_queue set status = 'cancelled' where id = '${m.queueId}'`, "stopped"],
  ["a newer generation", (m) => `update public.tasks set checkpoint_version = checkpoint_version + 1 where id = '${m.taskId}'`, "stale_generation"],
  ["a moved lineage lease", (m) => `update public.lead_lineages set lease_holder = gen_random_uuid() where lineage_id = '${m.taskId}'`, "lost_ownership"],
];
for (const [why, change, refusedAs] of R8_CHANGES) {
  Deno.test(`R8: ${why} cannot commit while an admission is in flight, and refuses every admission after it`, opts, async () => {
    const m = await seedSmokeMission({ quotes: cheapModels() });
    const key = 900_000 + Math.floor(Math.random() * 99_999);
    await sql.unsafe(`create or replace function public.r8_pause() returns trigger language plpgsql as $f$
      begin perform pg_advisory_xact_lock(${key}); return new; end $f$`);
    await sql.unsafe(`create trigger r8_pause before insert on public.discovery_smoke_operations
      for each row execute function public.r8_pause()`);
    const holder = await sql.reserve();
    try {
      await holder`select pg_advisory_lock(${key})`;
      const inFlight = admitOperation(await db(), op(m));
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const r = await sql`select 1 from pg_stat_activity where wait_event_type = 'Lock'
          and query ilike '%admit_discovery_smoke%' and pid <> pg_backend_pid()`;
        waiting = r.length > 0;
        if (!waiting) await new Promise((res) => setTimeout(res, 10));
      }
      assert(waiting, "the admission is paused before its reservation commits");
      await assertRejects(
        () => sql.begin(async (tx) => {
          await tx`set local lock_timeout = '300ms'`;
          await tx.unsafe(change(m));
        }),
        Error, "lock timeout", `${why} must wait for the in-flight admission`,
      );
      await holder`select pg_advisory_unlock(${key})`;
      assertEquals((await inFlight).decision, "admitted", "the in-flight admission is ordered before the change");
      await sql.unsafe(change(m));
      assertEquals((await admit(op(m))).decision, refusedAs, "after the change commits, nothing is admitted");
    } finally {
      await holder`select pg_advisory_unlock_all()`.catch(() => {});
      holder.release();
      await sql.unsafe(`drop trigger if exists r8_pause on public.discovery_smoke_operations`);
      await sql.unsafe(`drop function if exists public.r8_pause()`);
    }
  });
}

// ── reconciliation: no new smoke over unreconciled liability ────────────────

const tokenOf = (d: unknown) => (d as { reservation_token: string }).reservation_token;
const reconcile = (m: SmokeMission, key: string, usd: number, ref = "apify run history: synthetic") =>
  sql`select public.reconcile_discovery_smoke_operation(${m.queueId}, ${key}, ${usd}, ${ref}) as r`;

Deno.test("reconciliation: an unsettled purchase blocks the next authorization until a person reconciles it", opts, async () => {
  const first = await seedSmokeMission();
  const buy = provider(first, JOBS, "apify_jobs");
  const d = await admit(buy);
  assertEquals(d.decision, "admitted");
  // A preliminary figure (the deferred final receipt) is evidence, not settlement.
  assert(await recordReceipt(await db(), { queueId: first.queueId, key: buy.key, token: tokenOf(d),
    runId: `run-${uuid()}`, reportedMicrousd: 4000, source: "apify_run(status).receipt" }));

  const next = await seedSmokeMission({ authorize: false });
  await assertRejects(() => authorizeSmoke(next.queueId, { keepPriorLiability: true }), Error, "unreconciled");
  assertEquals((await sql`select count(*)::int as n from public.discovery_smoke_authorizations where queue_id = ${next.queueId}`)[0].n, 0);

  // The worker can never close it.
  const svc = await serviceClient();
  const { error } = await svc.rpc("reconcile_discovery_smoke_operation",
    { p_queue: first.queueId, p_key: buy.key, p_vendor_microusd: 0, p_vendor_ref: "worker" });
  assert(error, "service_role cannot reconcile");

  const [{ r }] = await reconcile(first, buy.key, 3800);
  assertEquals(r.exceeded, false);
  // Liability as authorized is untouched: the commitment and the evidence stay.
  const [row] = await ops(first);
  assertEquals([row.committed_microusd, row.reported_microusd, row.report_source], ["60000", "4000", "apify_run(status).receipt"]);
  assert(await authorizeSmoke(next.queueId, { keepPriorLiability: true }), "reconciled: the next smoke may be authorized");
});

Deno.test("reconciliation: immutable, provider purchases only, and a figure above the quote stops the authorization", opts, async () => {
  const m = await seedSmokeMission();
  const buy = provider(m, JOBS, "apify_jobs");
  assertEquals((await admit(buy)).decision, "admitted");
  const model = op(m);
  assertEquals((await admit(model)).decision, "admitted");
  await assertRejects(() => reconcile(m, model.key, 0), Error, "not a provider purchase");
  await assertRejects(() => reconcile(m, buy.key, -1), Error, "required");
  await assertRejects(() => reconcile(m, buy.key, 1, " "), Error, "required");
  const [{ r }] = await reconcile(m, buy.key, 70000);
  assertEquals(r.exceeded, true, "above the 60000 committed maximum");
  const [a] = await sql`select status, stop_reason from public.discovery_smoke_authorizations where queue_id = ${m.queueId}`;
  assertEquals([a.status, a.stop_reason], ["stopped", `reconciled_charge_exceeded_quote:${buy.key}`]);
  assertEquals((await reconcile(m, buy.key, 70000))[0].r.vendor_microusd, 70000, "the same record again is a no-op");
  await assertRejects(() => reconcile(m, buy.key, 60000), Error, "already reconciled differently");
});

Deno.test("reconciliation: a worker-written 'settled' label is not a reconciliation (Codex review, PR #96)", opts, async () => {
  const first = await seedSmokeMission();
  const buy = provider(first, JOBS, "apify_jobs");
  const d = await admit(buy);
  const token = tokenOf(d);
  // The worker can write any label with its token: first the preliminary
  // figure, then the same figure re-labelled as settled.
  assert(await recordReceipt(await db(), { queueId: first.queueId, key: buy.key, token,
    runId: `run-${uuid()}`, reportedMicrousd: 4000, source: "apify_run(status).receipt" }));
  assert(await recordReceipt(await db(), { queueId: first.queueId, key: buy.key, token,
    reportedMicrousd: 4000, source: "apify_run(settled).receipt" }));
  const next = await seedSmokeMission({ authorize: false });
  await assertRejects(() => authorizeSmoke(next.queueId, { keepPriorLiability: true }), Error, "unreconciled");
  await reconcile(first, buy.key, 4000);
  assert(await authorizeSmoke(next.queueId, { keepPriorLiability: true }), "only a person's record closes it");
});

Deno.test("reconciliation: an earlier authorization cannot spend over another's open liability (Codex review, PR #96)", opts, async () => {
  // Both authorized before either buys: the authorization check passed for both.
  const a = await seedSmokeMission();
  const b = await seedSmokeMission();
  const buy = provider(a, JOBS, "apify_jobs");
  assertEquals((await admit(buy)).decision, "admitted");
  // A spends within its own liability; B may not spend at all while A's is open.
  assertEquals((await admit(op(a))).decision, "admitted", "a mission is not blocked by its own purchases");
  assertEquals((await admit(op(b))).decision, "prior_liability_unreconciled", "no model attempt");
  assertEquals((await admit(provider(b, JOBS, "apify_jobs"))).decision, "prior_liability_unreconciled", "no purchase");
  assertEquals((await ops(b)).length, 0, "nothing was admitted, so nothing is owed");
  await reconcile(a, buy.key, 5000);
  assertEquals((await admit(op(b))).decision, "admitted", "reconciled: B may spend");
});

Deno.test("reconciliation: two smokes racing to buy first — exactly one purchase is admitted", opts, async () => {
  for (let round = 0; round < 3; round++) {
    const a = await seedSmokeMission();
    const b = await seedSmokeMission();
    const [da, dbb] = await Promise.all([admit(provider(a, JOBS, "apify_jobs")), admit(provider(b, JOBS, "apify_jobs"))]);
    const decisions = [da.decision, dbb.decision].sort();
    assertEquals(decisions, ["admitted", "prior_liability_unreconciled"], `round ${round}`);
  }
});

Deno.test("proposal: the two-actor catalog cannot be authorized as written (no invented price; live stays blocked)", opts, async () => {
  const proposal = JSON.parse(Deno.readTextFileSync(
    new URL("../../docs/launch/proposals/smoke-catalog-two-actor.json", import.meta.url)));
  assertEquals(proposal.live_execution, "blocked");
  assertEquals(proposal.approved_quotes.details.maximum_microusd, null, "no figure is invented for the company-details price");
  const authorize = (quotes: unknown) => async () => {
    const m = await seedSmokeMission({ authorize: false });
    await authorizeSmoke(m.queueId, { quotes: quotes as Record<string, unknown>, actorLimits: proposal.actor_limits });
  };
  // As written: placeholders are not observations.
  await assertRejects(authorize(proposal.approved_quotes), Error);
  // Even with every OTHER template freshly observed, the unpriced one refuses it.
  const now = new Date(Date.now() - 60_000).toISOString();
  const observed = Object.fromEntries(Object.entries(proposal.approved_quotes as Record<string, Record<string, unknown>>)
    .map(([k, t]) => [k, k === "details" ? t : { ...t, source: "observed", observed_at: now }]));
  await assertRejects(authorize(observed), Error, "template details is malformed");
});

Deno.test("reconciliation: a pre-authorized mission cannot spend over a CANCELLED mission's uncertain purchase (independent repro, PR #96)", opts, async () => {
  // Both authorized before either purchases; same workspace is irrelevant to the rule.
  const a = await seedSmokeMission();
  const b = await seedSmokeMission();
  const buy = provider(a, JOBS, "apify_jobs");
  assertEquals((await admit(buy)).decision, "admitted");
  // No run id, no receipt: an uncertain start, committed at 60000.
  assertEquals([(await ops(a))[0].provider_run_id, (await ops(a))[0].report_source], [null, null]);
  await sql`select * from public.cancel_lead_mission(${a.queueId}, ${a.ws})`;
  assertEquals((await admit(op(b))).decision, "prior_liability_unreconciled", "B's first paid model operation is refused");
  assertEquals((await ops(b)).length, 0);
  // The cancelled mission's purchase can still be closed by a person; then B may spend.
  await reconcile(a, buy.key, 60000);
  assertEquals((await admit(op(b))).decision, "admitted");
});
