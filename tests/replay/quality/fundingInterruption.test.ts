import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fixedClock, interruptedScreen } from "./fundingInterruption.ts";
const atomus = "apify_funding_atomus",
  acme = "https://www.linkedin.com/company/acme";
Deno.test("[failure] quality funding screen control: delivered answer passes and is never purchased again", () =>
  fixedClock(async () => {
    const { first, second } = await interruptedScreen(false);
    assertEquals(first.result.state.funding_screen?.verdicts[acme], "pass");
    assertEquals(first.outcomes, ["ok"]);
    assertEquals(
      second.provider.calls.filter((c) => c.actor === atomus).length,
      0,
    );
  }));
Deno.test("[failure] quality funding screen defect characterization: pending read is consumed and its ready answer is never adopted", () =>
  fixedClock(async () => {
    const { first, second, availableOnAdoption, durableAdoption } =
      await interruptedScreen();
    const call = first.provider.calls.find((c) => c.actor === atomus)!;
    assert(call.pending, "a paid provider run really started");
    assertEquals(
      availableOnAdoption.length,
      1,
      "the fixture can deliver the purchased funding answer on adoption",
    );
    assertEquals(
      durableAdoption?.kind,
      "adopt",
      "D2 has the paid run id, but the screen never invokes recovery",
    );
    assertEquals(first.outcomes, ["running"]);
    assertEquals(first.result.state.funding_screen?.screened, true);
    assertEquals(first.result.state.funding_screen?.verdicts[acme], "pending");
    assertEquals(first.result.state.verifier_pending_runs?.length ?? 0, 0);
    assertEquals(second.screenCalls, 0);
    assertEquals(
      second.provider.calls.filter((c) => c.actor === atomus && c.adopted)
        .length,
      0,
    );
    assertEquals(second.result.state.funding_screen?.verdicts[acme], "pending");
  }));
Deno.test({
  name:
    "[known-gap] funding screen must adopt its interrupted Atomus run and process the delivered funding answer",
  ignore: Deno.env.get("RUN_FUNDING_SCREEN_RECOVERY_SPEC") !== "1",
  fn: () =>
    fixedClock(async () => {
      const { first, second, availableOnAdoption, durableAdoption } =
        await interruptedScreen();
      assert(first.provider.calls.some((c) => c.actor === atomus && c.pending));
      assertEquals(availableOnAdoption.length, 1);
      assertEquals(durableAdoption?.kind, "adopt");
      assertEquals(
        second.result.state.funding_screen?.verdicts[acme],
        "pass",
        "the recorded run has a decisive answer on adoption, but the screen never consumes it",
      );
      assertEquals(
        second.provider.calls.filter((c) => c.actor === atomus && !c.adopted)
          .length,
        0,
        "recovery must not buy another run",
      );
    }),
});
