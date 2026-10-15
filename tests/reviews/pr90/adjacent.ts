// Separate from the immutable seven-bug suite and the original 43 checks.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { admission, catalog, JOBS, open, QUEUE, sqlText } from "./harness.ts";

const REQUIRE_SAFE = Deno.env.get("PR90_REQUIRE_ADJACENT_SAFE") === "1";
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.test("ADJ-001 [P1] initial Apify usage must be observed before another purchase", async () => {
  const h = await open();
  try {
    const gate = admission.createAdmissionFetch({
      db: h.db,
      ownApi: "https://project.invalid",
      log: () => {},
      baseFetch: () =>
        Promise.resolve(json(201, {
          data: {
            id: "synthetic-start-receipt",
            defaultDatasetId: "synthetic-dataset",
            status: "SUCCEEDED",
            usageTotalUsd: 1,
          },
        })),
    });
    const response = await admission.missionAdmission.run(
      { ...h.ctx },
      () =>
        gate(
          "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
          { method: "POST", body: "{}" },
        ),
    );
    await response.body?.cancel();
    const row = (await h.rows())[0];
    assertEquals(
      row.reported_microusd === null ? null : Number(row.reported_microusd),
      REQUIRE_SAFE ? 1000000 : null,
    );
    assertEquals(
      (await h.admit(h.op("after-initial-overrun"))).decision,
      REQUIRE_SAFE ? "stopped" : "admitted",
    );
  } finally {
    await h.close();
  }
});

Deno.test("ADJ-002 late receipts remain monotonic after deadline, cancellation and lost generation", async () => {
  const h = await open();
  try {
    const op = h.op("late", {
      kind: "provider",
      actor: JOBS,
      template: "jobs",
    });
    const start = await h.admit(op);
    assertEquals(start.decision, "admitted");
    await h.admin.unsafe(`update ${h.schema}.tasks set checkpoint_version=4;
      update ${h.schema}.lead_mission_queue set status='cancelled';
      update ${h.schema}.discovery_smoke_authorizations
        set authorized_at=clock_timestamp()-interval '600 seconds',
            deadline_at=clock_timestamp()-interval '301 seconds'`);
    for (const charge of [70000, 50000]) {
      assertEquals(
        await admission.recordReceipt(h.db, {
          queueId: QUEUE,
          key: op.key,
          token: start.reservation_token as string,
          runId: "synthetic-late-run",
          datasetId: "synthetic-late-dataset",
          reportedMicrousd: charge,
          source: "synthetic late control",
        }),
        true,
      );
    }
    const row = (await h.rows())[0];
    assertEquals(Number(row.reported_microusd), 70000);
    assertEquals(Number(row.committed_microusd), 60000);
    assertEquals(row.provider_run_id, "synthetic-late-run");
    assertEquals(
      (await h.admit(h.op("after-late-receipt"))).decision,
      "stopped",
    );
    assertEquals(
      await admission.recordReceipt(h.db, {
        queueId: QUEUE,
        key: op.key,
        token: start.reservation_token as string,
        runId: "different-run",
        reportedMicrousd: 0,
        source: "synthetic",
      }),
      false,
    );
    assertEquals(Number((await h.rows())[0].reported_microusd), 70000);
  } finally {
    await h.close();
  }
});

Deno.test("ADJ-003 native late-overrun receipt serializes ahead of waiting admission", async () => {
  const h = await open();
  let pending: Promise<Record<string, unknown>> | undefined;
  try {
    const op = h.op("receipt-lock", {
      kind: "provider",
      actor: JOBS,
      template: "jobs",
    });
    const start = await h.admit(op);
    await h.a.begin(async (tx) => {
      await tx.unsafe(
        `select id from ${h.schema}.discovery_smoke_authorizations for update`,
      );
      pending = h.admit(h.op("waiting-after-receipt"), h.b);
      await h.blocked();
      const rows = await tx.unsafe(
        `select ${h.schema}.record_discovery_smoke_receipt(
        $1,$2,$3,null,null,70000,'synthetic contention receipt') as recorded`,
        [QUEUE, op.key, start.reservation_token as string],
      );
      assertEquals(rows[0].recorded, true);
    });
    assertEquals((await pending!).decision, "stopped");
    assertEquals((await h.rows()).length, 1);
  } finally {
    if (pending) await pending.catch(() => {});
    await h.close();
  }
});

Deno.test("ADJ-004 [P1/SAF-005 extension] paid transport must preserve redirect rejection", async () => {
  const h = await open();
  let redirect: RequestRedirect | undefined;
  try {
    const gate = admission.createAdmissionFetch({
      db: h.db,
      ownApi: "https://project.invalid",
      log: () => {},
      baseFetch: (_url: RequestInfo | URL, init?: RequestInit) => {
        redirect = init?.redirect;
        return Promise.resolve(
          json(201, { data: { id: "synthetic-redirect-control" } }),
        );
      },
    });
    const r = await admission.missionAdmission.run({ ...h.ctx }, () =>
      gate(
        "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
        { method: "POST", body: "{}", redirect: "error" },
      ));
    await r.body?.cancel();
    if (REQUIRE_SAFE) assert(redirect === "error" || redirect === "manual");
    else assertEquals(redirect, undefined);
    assertEquals((await h.rows()).length, 1);
  } finally {
    await h.close();
  }
});

Deno.test("POLL-001 current held schema rejects twelve polls; no setting can silently raise five", async () => {
  const h = await open();
  try {
    let refused = false;
    try {
      await h.admin.unsafe(
        `update ${h.schema}.discovery_smoke_authorizations set provider_polls=12`,
      );
    } catch (e) {
      refused = String(e).includes("check constraint");
    }
    assert(refused);
  } finally {
    await h.close();
  }
});

Deno.test("POLL-002 synthetic twelve-read policy has no reserved receipt lane", async () => {
  const original = "provider_polls between 0 and 5";
  assert(sqlText.includes(original));
  // Deliberate synthetic policy experiment in a new local schema only.
  const h = await open(
    {},
    sqlText.replace(original, "provider_polls between 0 and 12"),
  );
  try {
    await h.admin.unsafe(
      `update ${h.schema}.discovery_smoke_authorizations set provider_polls=12`,
    );
    const parent = h.op("twelve-read-parent", {
      kind: "provider",
      actor: JOBS,
      template: "jobs",
    });
    assertEquals((await h.admit(parent)).decision, "admitted");
    for (let i = 0; i < 12; i++) {
      assertEquals(
        (await h.admit(h.op("status-" + i, {
          kind: "poll",
          actor: JOBS,
          template: "polls",
          parent: parent.key,
        }))).decision,
        "admitted",
      );
    }
    assertEquals(
      (await h.admit(h.op("receipt-read", {
        kind: "poll",
        actor: JOBS,
        template: "polls",
        parent: parent.key,
      }))).decision,
      "poll_limit",
    );
    console.log(
      JSON.stringify({
        synthetic: true,
        poll_cap: 12,
        unreserved_status_reads: 12,
        remaining_dataset_and_receipt_reads: 0,
        vendor_spend_usd: null,
        implemented_policy: false,
      }),
    );
  } finally {
    await h.close();
  }
});

Deno.test("PAGE-001 discovery-page classification depends on reviewed template metadata", async () => {
  const h = await open({ jobs: { ...catalog().jobs, discovery_page: false } });
  try {
    for (const key of ["search-one", "search-two"]) {
      assertEquals(
        (await h.admit(h.op(key, {
          kind: "provider",
          actor: JOBS,
          template: "jobs",
        }))).decision,
        "admitted",
      );
    }
    const rows = await h.rows();
    assertEquals(rows.length, 2);
    assertEquals(rows.filter((r) => r.discovery_page).length, 0);
    // This is trusted catalog misclassification, not a worker privilege bypass.
    assertEquals(
      rows.reduce((sum, r) => sum + Number(r.committed_microusd), 0),
      120000,
    );
  } finally {
    await h.close();
  }
});
