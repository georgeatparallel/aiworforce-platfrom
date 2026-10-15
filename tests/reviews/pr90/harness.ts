// Independent review fixtures. Execute only against a disposable localhost DB.
import postgres from "npm:postgres@3.4.5";
import { pathToFileURL as toFileUrl } from "node:url";
export const root = Deno.env.get("PR90_REVIEW_ROOT");
export const pgUrl = Deno.env.get("PR90_REVIEW_PG_URL");
if (!root || !pgUrl) {
  throw new Error(
    "Set PR90_REVIEW_ROOT to the pinned read-only archive and PR90_REVIEW_PG_URL to a scratch DB",
  );
}
const u = new URL(pgUrl);
if (
  !["127.0.0.1", "localhost"].includes(u.hostname) ||
  !/^\/contract_pr90_[a-z_]+$/.test(u.pathname)
) throw new Error("Refusing a non-local/non-scratch database");
export const read = (p: string) => Deno.readTextFileSync(root + "/" + p);
const pins = JSON.parse(
  Deno.readTextFileSync(new URL("./source-pins.json", import.meta.url)),
);
for (const [path, expected] of Object.entries(pins.sha256)) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      Deno.readFileSync(root + "/" + path),
    ),
  );
  const actual = Array.from(digest, (n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== expected) {
    throw new Error(`Source differs from reviewed PR90 ${pins.head}: ${path}`);
  }
}
export const admission = await import(
  toFileUrl(root + "/supabase/functions/_shared/smokeAdmission.ts").href
);
export const tools = await import(
  toFileUrl(root + "/supabase/functions/_shared/toolRegistry.ts").href
);
export const gpt = await import(
  toFileUrl(root + "/supabase/functions/_shared/gptProvider.ts").href
);
export const ai = await import(
  toFileUrl(root + "/supabase/functions/_shared/aiProvider.ts").href
);
export const strategist = await import(
  toFileUrl(
    root + "/supabase/functions/_shared/leadStrategy/adapters/shared.ts",
  ).href
);
export const credits = await import(
  toFileUrl(root + "/supabase/functions/_shared/creditAuthorization.ts").href
);
export const sqlText = read(
  "supabase/migrations-held/20261015140000_discovery_smoke_admission.sql",
);
export const WS = "11111111-1111-4111-8111-111111111111";
export const TASK = "22222222-2222-4222-8222-222222222222";
export const QUEUE = "33333333-3333-4333-8333-333333333333";
export const WORKER = "44444444-4444-4444-8444-444444444444";
export const MODEL = "openai:gpt-4.1-mini",
  JOBS = "apify:curious_coder~linkedin-jobs-scraper",
  DETAILS = "apify:harvestapi~linkedin-company",
  SCRAPE = "firecrawl:scrape",
  MAP = "firecrawl:map";
export const hex = (n: number) => n.toString(16).padStart(64, "0");
export function catalog() {
  const evidence = {
    source: "synthetic review control",
    liability_bound_ref: "not a vendor price",
    observed_at: new Date(Date.now() - 1000).toISOString(),
  };
  const t = (
    kind: string,
    actor: string,
    max: number,
    request_limits: unknown,
    page = false,
  ) => ({
    allowed_kinds: [kind],
    allowed_actors: [actor],
    maximum_microusd: max,
    request_limits,
    discovery_page: page,
    ...evidence,
  });
  return {
    model: t("model", MODEL, 30000, {
      max_request_bytes: 20000,
      max_output_tokens: 1000,
    }),
    jobs: t("provider", JOBS, 60000, { max_request_bytes: 4096 }, true),
    details: t("provider", DETAILS, 40000, { max_request_bytes: 4096 }),
    scrape: t("provider", SCRAPE, 10000, { max_request_bytes: 4096 }),
    map: t("provider", MAP, 10000, { max_request_bytes: 4096 }),
    polls: { ...t("poll", JOBS, 0, {}), allowed_actors: [JOBS, DETAILS] },
  };
}
export interface Op {
  key: string;
  kind: string;
  actor: string;
  template: string;
  hash: string;
  parent?: string | null;
  generation?: number;
  queue?: string;
  worker?: string;
  task?: string;
}
export async function open(
  over: Record<string, unknown> = {},
  source = sqlText,
) {
  const schema = "review90_" + crypto.randomUUID().replaceAll("-", "");
  const admin = postgres(pgUrl!, {
    max: 1,
    onnotice: () => {},
    idle_timeout: 1,
  });
  const a = postgres(pgUrl!, {
    max: 1,
    onnotice: () => {},
    idle_timeout: 1,
    connection: { application_name: schema + "_a", statement_timeout: 5000 },
  });
  const b = postgres(pgUrl!, {
    max: 1,
    onnotice: () => {},
    idle_timeout: 1,
    connection: { application_name: schema + "_b", statement_timeout: 5000 },
  });
  const rewrite = (s: string) =>
    s.replaceAll("public.", schema + ".").replaceAll(
      "pg_catalog, public",
      "pg_catalog, " + schema,
    ).replaceAll("search_path to 'public'", "search_path to " + schema)
      .replaceAll("search_path TO 'public'", "search_path TO " + schema);
  await admin.unsafe(
    `create schema ${schema}; grant usage on schema ${schema} to service_role,anon,authenticated;
 create table ${schema}.workspaces(id uuid primary key);
 create table ${schema}.tasks(id uuid primary key,workspace_id uuid,status text,checkpoint_version integer,lineage_id uuid);
 create table ${schema}.lead_lineages(lineage_id uuid primary key,workspace_id uuid,status text,lease_holder uuid,lease_expires_at timestamptz);
 create table ${schema}.lead_mission_queue(id uuid primary key,workspace_id uuid,request jsonb,status text,claimed_by uuid,
 lease_expires_at timestamptz,task_id uuid,lineage_id uuid,created_at timestamptz default clock_timestamp());
 insert into ${schema}.workspaces values('${WS}');
 insert into ${schema}.tasks values('${TASK}','${WS}','running',3,'${TASK}');
 insert into ${schema}.lead_lineages values('${TASK}','${WS}','running','${TASK}',clock_timestamp()+interval '1 hour');
 insert into ${schema}.lead_mission_queue(id,workspace_id,request,status,claimed_by,lease_expires_at,task_id,lineage_id)
 values('${QUEUE}','${WS}','{"instruction":"synthetic controlled mission"}','running','${WORKER}',clock_timestamp()+interval '1 hour','${TASK}','${TASK}');`,
  );
  await admin.unsafe(rewrite(source));
  const q = { ...catalog(), ...over };
  await admin.unsafe(
    `select ${schema}.authorize_discovery_smoke($1,'synthetic-v1',$2,$3,300)`,
    [
      QUEUE,
      admin.json(q as postgres.JSONValue),
      admin.json({ [JOBS]: 2, [DETAILS]: 1, [SCRAPE]: 1, [MAP]: 1 }),
    ],
  );
  const op = (key: string, changes: Partial<Op> = {}): Op => ({
    key,
    kind: "model",
    actor: MODEL,
    template: "model",
    hash: hex(key.split("").reduce((a, b) => a + b.charCodeAt(0), 0)),
    ...changes,
  });
  const admit = async (o: Op, client = a) =>
    (await client.unsafe(
      `select ${schema}.admit_discovery_smoke($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result`,
      [
        o.queue ?? QUEUE,
        o.worker ?? WORKER,
        o.task ?? TASK,
        o.generation ?? 3,
        o.key,
        o.kind,
        o.actor,
        o.template,
        o.hash,
        o.parent ?? null,
      ],
    ))[0].result as Record<string, unknown>;
  const close = async () => {
    await Promise.all([a.end(), b.end()]);
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
  };
  const blocked = async () => {
    for (let i = 0; i < 300; i++) {
      const r =
        await admin`select wait_event_type from pg_stat_activity where application_name=${
          schema + "_b"
        }`;
      if (r.some((x) => x.wait_event_type === "Lock")) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("worker B did not block");
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    const vals = keys.map((k) =>
      typeof args[k] === "object" && args[k] !== null
        ? admin.json(args[k] as postgres.JSONValue)
        : args[k] as string | number | null
    );
    try {
      const r = await a.unsafe(
        `select ${schema}.${fn}(${
          keys.map((k, i) => k + "=> $" + (i + 1)).join(",")
        }) as result`,
        vals,
      );
      return { data: r[0].result, error: null };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
  };
  const db = {
    rpc,
    from: (table: string) => ({
      select: (_cols: string) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return chain;
          },
          maybeSingle: async () => {
            try {
              const r = await a.unsafe(
                `select * from ${schema}.${table} where ${
                  filters.map(([k], i) => k + "=$" + (i + 1)).join(" and ")
                }`,
                filters.map(([, v]) => v as string),
              );
              return { data: r[0] ?? null, error: null };
            } catch (e) {
              return { data: null, error: { message: String(e) } };
            }
          },
        };
        return chain;
      },
    }),
  };
  const ctx = { queueId: QUEUE, workerId: WORKER, taskId: TASK, generation: 3 };
  const rows = () =>
    admin.unsafe(`select * from ${schema}.discovery_smoke_operations`);
  return {
    admin,
    a,
    b,
    schema,
    rewrite,
    q,
    op,
    admit,
    close,
    blocked,
    db,
    ctx,
    rows,
  };
}
export type H = Awaited<ReturnType<typeof open>>;
export function definition(src: string, fn: string) {
  const start = src.indexOf("CREATE FUNCTION public." + fn + "(");
  if (start < 0) throw new Error("missing " + fn);
  const end = src.indexOf("$$;", src.indexOf("AS $$", start)) + 3;
  return src.slice(start, end);
}
export async function installCredits(h: H) {
  const base = read(
    "supabase/migrations-held/20260816120000_baseline_schema.sql",
  );
  const table = (name: string) => {
    const i = base.indexOf("CREATE TABLE public." + name + " (");
    return base.slice(i, base.indexOf("\n);", i) + 4);
  };
  await h.admin.unsafe(
    h.rewrite(
      table("credit_transactions") + "\n" + table("workspace_credit_balances"),
    ),
  );
  await h.admin.unsafe(
    `alter table ${h.schema}.credit_transactions add primary key(id),add unique(workspace_id,idempotency_key);
 alter table ${h.schema}.workspace_credit_balances add primary key(workspace_id);`,
  );
  await h.admin.unsafe(
    h.rewrite(
      read("supabase/migrations/20260822130000_credit_kind_provider_call.sql"),
    ),
  );
  await h.admin.unsafe(h.rewrite(definition(base, "credits_finalize")));
  await h.admin.unsafe(
    h.rewrite(
      read(
        "supabase/migrations-held/20261015130000_credits_rearm_settled_key.sql",
      ),
    ),
  );
  await h.admin.unsafe(
    `insert into ${h.schema}.workspace_credit_balances(workspace_id,balance_credits)values($1,10)`,
    [WS],
  );
}
