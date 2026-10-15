import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installCredits, open, tools } from "./harness.ts";
import { jobsInput, toolContext, withTool } from "./runtimeHarness.ts";
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
for (const finishAfter of [0, 2, 5, 8]) {
  Deno.test(`PR90 mocked Apify: finish after ${finishAfter} status reads with five global polls`, async () => {
    const h = await open();
    const originalTimer = globalThis.setTimeout;
    let statuses = 0, datasets = 0, posts = 0;
    try {
      await installCredits(h);
      // Accelerate only the production loop's 3s sleeps, not admission/RPC timers.
      globalThis.setTimeout = ((
        fn: Parameters<typeof setTimeout>[0],
        ms?: number,
        ...args: unknown[]
      ) =>
        Reflect.apply(originalTimer, globalThis, [
          fn,
          ms === 3000 ? 0 : ms,
          ...args,
        ])) as typeof setTimeout;
      const vendor: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "POST") {
          posts++;
          return Promise.resolve(
            json(201, {
              data: {
                id: "synthetic-run",
                defaultDatasetId: "synthetic-ds",
                status: finishAfter === 0 ? "SUCCEEDED" : "RUNNING",
              },
            }),
          );
        }
        if (url.pathname.includes("/actor-runs/")) {
          statuses++;
          return Promise.resolve(
            json(200, {
              data: {
                id: "synthetic-run",
                defaultDatasetId: "synthetic-ds",
                status: statuses >= finishAfter ? "SUCCEEDED" : "RUNNING",
              },
            }),
          );
        }
        if (url.pathname.includes("/datasets/")) {
          datasets++;
          return Promise.resolve(
            json(200, [{ companyName: "synthetic control" }]),
          );
        }
        throw new Error("unexpected mock request " + url.pathname);
      };
      await withTool(h, vendor, async () => {
        const result = await tools.runTool(
          "source_with_apify",
          jobsInput,
          toolContext(h),
        );
        assertEquals(posts, 1);
        const rows = await h.rows();
        const polls = rows.filter((r) => r.kind === "poll");
        assert(polls.length <= 5);
        if (finishAfter < 5) {
          assertEquals(datasets, 1);
          assertEquals(polls.length, finishAfter + 1);
          assertEquals(result.ok, true);
        } else {
          assertEquals(datasets, 0);
          assertEquals(polls.length, 5);
          assertEquals(result.ok, false);
        }
        console.log(
          JSON.stringify({
            synthetic: true,
            finish_after_status_reads: finishAfter,
            status_reads: statuses,
            dataset_reads: datasets,
            physical_polls: statuses + datasets,
            result_ok: result.ok,
            error: result.error ?? null,
            nominal_status_wait_ms: statuses * 3000,
            actual_vendor_cost: null,
          }),
        );
      });
    } finally {
      globalThis.setTimeout = originalTimer;
      await h.close();
    }
  });
}
