// New cases remain separate from the immutable SAF-001..007 / 43-check baseline.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { admission, catalog, open } from "./harness.ts";

const CHARACTERIZE = Deno.env.get("PR90_CHARACTERIZE_NEW") === "1";
for (const body of [null, ""]) {
  Deno.test(`SAF-008 [P1] mandatory provider fields cannot be bypassed with ${body === null ? "absent" : "empty"} body`, async () => {
    const base = catalog().jobs;
    const h = await open({
      jobs: {
        ...base,
        request_limits: {
          max_request_bytes: 4096,
          max_fields: { maxItems: 3 },
        },
      },
    });
    let physicalPurchases = 0;
    try {
      const gate = admission.createAdmissionFetch({
        db: h.db,
        ownApi: "https://project.invalid",
        log: () => {},
        baseFetch: () => {
          physicalPurchases++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  id: "synthetic-unbounded-start",
                  status: "RUNNING",
                },
              }),
              { status: 201 },
            ),
          );
        },
      });
      const response = await admission.missionAdmission.run(
        { ...h.ctx },
        () =>
          gate(
            "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
            { method: "POST", body },
          ),
      );
      await response.body?.cancel();
      assertEquals(
        physicalPurchases,
        CHARACTERIZE ? 1 : 0,
        "A purchase without the quote's mandatory maxItems must never reach the vendor",
      );
      assertEquals((await h.rows()).length, CHARACTERIZE ? 1 : 0);
      assertEquals(response.status, CHARACTERIZE ? 201 : 409);
    } finally {
      await h.close();
    }
  });
}

Deno.test("SAF-008 control: populated object missing required maxItems refuses before purchase", async () => {
  const h = await open({
    jobs: {
      ...catalog().jobs,
      request_limits: { max_request_bytes: 4096, max_fields: { maxItems: 3 } },
    },
  });
  let calls = 0;
  try {
    const gate = admission.createAdmissionFetch({
      db: h.db,
      ownApi: "https://project.invalid",
      log: () => {},
      baseFetch: () => {
        calls++;
        return Promise.resolve(new Response("{}", { status: 201 }));
      },
    });
    const response = await admission.missionAdmission.run(
      { ...h.ctx },
      () =>
        gate(
          "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
          { method: "POST", body: "{}" },
        ),
    );
    const refusal = await response.json();
    assertEquals(calls, 0);
    assertEquals((await h.rows()).length, 0);
    assertEquals(response.status, 409);
    assertEquals(refusal.error.decision, "request_limits");
    assertEquals(refusal.error.detail, "field_unbounded:maxItems");
  } finally {
    await h.close();
  }
});

Deno.test("SAF-008 control: a request containing the approved bound can purchase once", async () => {
  const h = await open({
    jobs: {
      ...catalog().jobs,
      request_limits: { max_request_bytes: 4096, max_fields: { maxItems: 3 } },
    },
  });
  let calls = 0;
  try {
    const gate = admission.createAdmissionFetch({
      db: h.db,
      ownApi: "https://project.invalid",
      log: () => {},
      baseFetch: () => {
        calls++;
        return Promise.resolve(new Response("{}", { status: 201 }));
      },
    });
    const r = await admission.missionAdmission.run({ ...h.ctx }, () =>
      gate(
        "https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/runs",
        { method: "POST", body: '{"maxItems":3}' },
      ));
    await r.body?.cancel();
    assertEquals(r.status, 201);
    assertEquals(calls, 1);
    assertEquals((await h.rows()).length, 1);
  } finally {
    await h.close();
  }
});
