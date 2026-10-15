import { admission, type H, TASK, WS } from "./harness.ts";
export function noopQuery(): unknown {
  const q: Record<string, unknown> = {};
  for (
    const k of [
      "select",
      "insert",
      "update",
      "upsert",
      "delete",
      "eq",
      "in",
      "is",
      "not",
      "order",
      "limit",
      "match",
      "filter",
      "single",
      "maybeSingle",
      "range",
      "contains",
    ]
  ) q[k] = () => q;
  q.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return q;
}
export const jobsInput = {
  actor_id: "curious_coder/linkedin-jobs-scraper",
  source_type: "jobs",
  query: "synthetic account executive",
  max_results: 3,
  defer_persistence: true,
  allow_disabled: true,
};
export const toolContext = (h: H) => ({
  workspace_id: WS,
  task_id: TASK,
  lineage_root: TASK,
  agent_slug: "scout",
  agent_id: null,
  admin: { from: () => noopQuery(), rpc: h.db.rpc },
});
export async function withTool(
  h: H,
  vendor: typeof fetch,
  fn: () => Promise<void>,
  db = h.db,
) {
  const original = globalThis.fetch;
  const names = [
    "APIFY_API_TOKEN",
    "FIRECRAWL_API_KEY",
    "LEAD_CREDIT_ENFORCEMENT",
  ];
  const saved = names.map((k) => Deno.env.get(k));
  try {
    Deno.env.set("APIFY_API_TOKEN", "synthetic");
    Deno.env.set("FIRECRAWL_API_KEY", "synthetic");
    Deno.env.set("LEAD_CREDIT_ENFORCEMENT", "enforce");
    globalThis.fetch = admission.createAdmissionFetch({
      db,
      baseFetch: vendor,
      ownApi: "https://project.invalid",
      log: () => {},
    });
    await admission.missionAdmission.run({ ...h.ctx }, fn);
  } finally {
    globalThis.fetch = original;
    names.forEach((k, i) =>
      saved[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[i]!)
    );
  }
}
