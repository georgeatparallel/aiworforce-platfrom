import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as http from "node:http";
import { admission } from "./harness.ts";
const REQUIRE_SAFE = Deno.env.get("PR90_REQUIRE_SAFE") === "1";
const unusedDb = {
  rpc: () =>
    Promise.resolve({
      data: null,
      error: { message: "no admission should be requested" },
    }),
  from: () => {
    throw new Error("unexpected lookup");
  },
};
Deno.test("SAF-005 [P1] PR90 DEFECT characterization: an allowed API redirect reaches a denied host without admission", async () => {
  let calls = 0;
  const vendor = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (req) => {
    await req.arrayBuffer();
    calls++;
    return new Response("mock billable response");
  });
  const vendorUrl = `http://127.0.0.1:${vendor.addr.port}`;
  const own = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      await req.arrayBuffer();
      return new Response(null, {
        status: 307,
        headers: { location: vendorUrl + "/billable" },
      });
    },
  );
  const ownUrl = `http://127.0.0.1:${own.addr.port}`;
  try {
    const gate = admission.createAdmissionFetch({
      baseFetch: fetch,
      db: unusedDb,
      ownApi: ownUrl,
      log: () => {},
    });
    const refused = await gate(vendorUrl + "/billable", {
      method: "POST",
      body: "control",
    });
    assertEquals(refused.status, 409);
    await refused.body?.cancel();
    const redirected = await gate(ownUrl + "/rest/v1/rpc/synthetic_redirect", {
      method: "POST",
      body: "synthetic request",
    });
    const body = await redirected.text();
    if (REQUIRE_SAFE) assertEquals(redirected.status, 409);
    else assertEquals(body, "mock billable response");
    assertEquals(calls, REQUIRE_SAFE ? 0 : 1);
  } finally {
    await Promise.all([own.shutdown(), vendor.shutdown()]);
  }
});
Deno.test("PR90 LIMITATION characterization: node:http bypasses patched global fetch", async () => {
  let calls = 0;
  const vendor = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (req) => {
    await req.arrayBuffer();
    calls++;
    return new Response("mock");
  });
  const url = `http://127.0.0.1:${vendor.addr.port}/billable`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = admission.createAdmissionFetch({
      baseFetch: original,
      db: unusedDb,
      ownApi: "https://project.invalid",
      log: () => {},
    });
    const refused = await globalThis.fetch(url);
    assertEquals(refused.status, 409);
    await refused.body?.cancel();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, { method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end("synthetic");
    });
    assertEquals(status, 200);
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = original;
    await vendor.shutdown();
  }
});
