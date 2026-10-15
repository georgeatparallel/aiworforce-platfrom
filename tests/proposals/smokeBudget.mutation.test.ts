// Each invariant below holds for the proposal SQL and fails after one critical
// check is removed. This does not simulate multi-session locking in PGlite.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  ADMIT,
  APPROVED_QUOTES,
  args,
  type Decision,
  HASH,
  LINEAGE,
  PRELUDE,
  quote,
  type Request,
  request,
  UP,
  WS,
} from "./smokeBudgetHarness.ts";
type DB = { db: PGlite; id: string; admit: (r: Request) => Promise<Decision> };
async function exercise(sql: string, invariant: (h: DB) => Promise<void>) {
  const db = new PGlite();
  try {
    await db.exec(PRELUDE);
    await db.exec(sql);
    const id = (await db.query<{ id: string }>(
      "select public.authorize_discovery_smoke($1,$2,$3,$4,$5) as id",
      [WS, LINEAGE, HASH, "synthetic-v1", APPROVED_QUOTES],
    )).rows[0].id;
    const admit = async (r: Request) =>
      (await db.query<{ result: Decision }>(ADMIT, args(r))).rows[0].result;
    await invariant({ db, id, admit });
  } finally {
    await db.close();
  }
}
function mutant(
  name: string,
  from: string,
  to: string,
  invariant: (h: DB) => Promise<void>,
) {
  Deno.test(`proposal mutation killed: ${name}`, async () => {
    assert(UP.includes(from), "mutation anchor must exist");
    await exercise(UP, invariant);
    await assertRejects(() => exercise(UP.replace(from, to), invariant), Error);
  });
}
mutant(
  "shared total dollars",
  "v_total + p_committed_microusd > a.total_microusd",
  "false",
  async (h) => {
    await h.db.exec(
      "update public.discovery_smoke_authorizations set total_microusd=210000",
    );
    assertEquals(
      (await h.admit(
        request(h.id, "p", { amount: 200000, quote: quote(200000) }),
      )).decision,
      "admitted",
    );
    assertEquals(
      (await h.admit(
        request(h.id, "m", {
          kind: "model",
          actor: "m",
          amount: 20000,
          quote: quote(20000),
        }),
      )).decision,
      "usd_limit",
    );
  },
);
mutant(
  "provider dollars",
  "p_kind <> 'model' and v_provider + p_committed_microusd > a.provider_microusd",
  "false",
  async (h) => {
    assertEquals(
      (await h.admit(
        request(h.id, "p", { amount: 200001, quote: quote(200001) }),
      )).decision,
      "usd_limit",
    );
  },
);
mutant(
  "model dollars",
  "p_kind = 'model' and v_model + p_committed_microusd > a.model_microusd",
  "false",
  async (h) => {
    assertEquals(
      (await h.admit(
        request(h.id, "m", {
          kind: "model",
          actor: "m",
          amount: 50001,
          quote: quote(50001),
        }),
      )).decision,
      "usd_limit",
    );
  },
);
mutant(
  "provider purchase count",
  "v_paid and n_provider >= a.provider_purchases",
  "false",
  async (h) => {
    await h.db.exec(
      "update public.discovery_smoke_authorizations set provider_purchases=1",
    );
    assertEquals((await h.admit(request(h.id, "p1"))).decision, "admitted");
    assertEquals(
      (await h.admit(request(h.id, "p2"))).decision,
      "purchase_limit",
    );
  },
);
mutant(
  "all model attempts",
  "p_kind = 'model' and n_model >= a.model_attempts",
  "false",
  async (h) => {
    for (let i = 0; i < 4; i++) {
      await h.admit(
        request(h.id, `m${i}`, {
          kind: "model",
          actor: "m",
          amount: 0,
          quote: quote(0),
        }),
      );
    }
    assertEquals(
      (await h.admit(
        request(h.id, "m5", {
          kind: "model",
          actor: "m",
          amount: 0,
          quote: quote(0),
        }),
      )).decision,
      "purchase_limit",
    );
  },
);
mutant(
  "actor limit",
  "if v_paid and n_actor >= (a.actor_limits->>p_actor)::integer then",
  "if false then",
  async (h) => {
    for (const key of ["p1", "p2"]) await h.admit(request(h.id, key));
    assertEquals((await h.admit(request(h.id, "p3"))).decision, "actor_limit");
  },
);
mutant(
  "global page count",
  "p_kind = 'page' and n_page >= a.discovery_pages",
  "false",
  async (h) => {
    await h.admit(
      request(h.id, "page1", { kind: "page", amount: 0, quote: quote(0) }),
    );
    assertEquals(
      (await h.admit(
        request(h.id, "page2", { kind: "page", amount: 0, quote: quote(0) }),
      )).decision,
      "transport_limit",
    );
  },
);
mutant(
  "global poll count",
  "p_kind = 'poll' and n_poll >= a.provider_polls",
  "false",
  async (h) => {
    await h.admit(request(h.id, "p"));
    for (let i = 0; i < 5; i++) {
      await h.admit(
        request(h.id, `poll${i}`, {
          kind: "poll",
          parent: "p",
          amount: 0,
          quote: quote(0),
        }),
      );
    }
    assertEquals(
      (await h.admit(
        request(h.id, "poll6", {
          kind: "poll",
          parent: "p",
          amount: 0,
          quote: quote(0),
        }),
      )).decision,
      "transport_limit",
    );
  },
);
mutant("persistent deadline", "a.deadline_at <= v_now", "false", async (h) => {
  await h.db.exec(
    "update public.discovery_smoke_authorizations set authorized_at=authorized_at-interval '6 minutes',deadline_at=deadline_at-interval '6 minutes'",
  );
  assertEquals((await h.admit(request(h.id, "late"))).decision, "stopped");
});
mutant(
  "generation fence",
  "t.checkpoint_version is distinct from p_generation",
  "false",
  async (h) => {
    await h.db.exec("update public.tasks set checkpoint_version=2");
    assertEquals(
      (await h.admit(request(h.id, "stale"))).decision,
      "stale_generation",
    );
  },
);
mutant(
  "duplicate cannot receive a new dispatch permit",
  "then 'adopt' else 'uncertain' end",
  "then 'admitted' else 'admitted' end",
  async (h) => {
    const r = request(h.id, "same");
    await h.admit(r);
    assertEquals((await h.admit(r)).decision, "uncertain");
  },
);
mutant(
  "unknown pricing fails closed",
  "p_quote->>'basis' is distinct from 'verified_upper_bound'",
  "p_quote->>'basis' is distinct from 'estimated'",
  async (h) => {
    assertEquals(
      (await h.admit(
        request(h.id, "unknown", {
          quote: quote(10000, { basis: "estimated" }),
        }),
      )).decision,
      "unknown_quote",
    );
  },
);
