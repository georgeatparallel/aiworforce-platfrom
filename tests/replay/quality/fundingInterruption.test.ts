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
// FIXED by #77. This was the defect characterization: the pending read was
// consumed as "unavailable", the screen marked complete, and its paid answer
// never adopted. It now pins the fix, and the former known-gap spec below is
// an ordinary test.
Deno.test("[failure] quality funding screen interrupted: the pending read is carried, the screen holds, and the next slice adopts it", () =>
  fixedClock(async () => {
    const { first, second, availableOnAdoption, durableAdoption } =
      await interruptedScreen();
    const call = first.provider.calls.find((c) => c.actor === atomus)!;
    assert(call.pending, "a paid provider run really started");
    assertEquals(availableOnAdoption.length, 1);
    assertEquals(durableAdoption?.kind, "adopt");
    assertEquals(first.outcomes, ["running"]);
    assert(first.result.state.funding_screen?.screened !== true, "an unanswered screen is not complete");
    assertEquals(first.result.state.funding_screen?.verdicts[acme], undefined, "no verdict before the paid read answers");
    assertEquals(first.result.state.funding_screen?.pending?.map((p) => p.stage), ["atomus"], "the run is carried");
    assertEquals(second.screenCalls, 1, "the next slice resumes the screen");
    assertEquals(second.provider.calls.filter((c) => c.actor === atomus && c.adopted).length, 1, "by adoption");
    assertEquals(second.result.state.funding_screen?.screened, true);
  }));
Deno.test("[failure] funding screen adopts its interrupted Atomus run and processes the delivered funding answer", () =>
  fixedClock(async () => {
    const { first, second, availableOnAdoption, durableAdoption } =
      await interruptedScreen();
    assert(first.provider.calls.some((c) => c.actor === atomus && c.pending));
    assertEquals(availableOnAdoption.length, 1);
    assertEquals(durableAdoption?.kind, "adopt");
    assertEquals(
      second.result.state.funding_screen?.verdicts[acme],
      "pass",
      "the recorded run has a decisive answer on adoption, and the screen consumes it",
    );
    assertEquals(
      second.provider.calls.filter((c) => c.actor === atomus && !c.adopted)
        .length,
      0,
      "recovery must not buy another run",
    );
  }));
