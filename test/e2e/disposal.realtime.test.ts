import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, navigateToContainerTab, listContainers, type Session } from "../../harness/firefox";
import { PRODUCTION_GRACE_MS } from "../../harness/build-extension";

// NIGHTLY ONLY. `npm test` excludes *.realtime.test.ts (vitest.config.ts) and
// `npm run test:realtime` runs it; this case waits out the real five-minute grace, so
// it costs more wall clock than the entire rest of the suite.
//
// Everything else about disposal is proven on a shortened grace: test/engine/disposer.test.ts
// on a fake clock, test/e2e/disposal.test.ts on a real one wound down to 500ms. Both would
// stay green if a real five-minute setTimeout in a background page never fired — the fake
// clock cannot lie about a duration it invents, and 500ms is too short to be throttled,
// suspended or coalesced the way Firefox may treat a long-idle background timer. That
// gap is the whole reason this case exists, and it is why the grace here is NOT passed
// to launch(): the build gets the same constant `npm run package` ships.
const POLL_MS = 5_000;
// The window the shortened-grace tests live inside, by two orders of magnitude. A
// throwaway still present this long after its last tab closed cannot have been built
// with a test grace.
const NOT_YET_MS = 60_000;
// Room past the grace for a timer Firefox delayed rather than dropped — enough to tell
// "late" from "never", which are different bugs.
const SLACK_MS = 180_000;

describe("temp disposal at the shipped grace (real Firefox, real time)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] }); // no ccGraceMs: production value
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("keeps a throwaway for the whole grace after its last tab closes, then removes it", async () => {
    // A stable observation tab first. work.example is matched, so it settles in the
    // permanent Work container and stays there — nothing reopens or tears it down for
    // the rest of the test, and the probe's command relay lives in its document.
    const observer = await navigateToContainerTab(
      firefox.browser,
      `http://work.example:${serverPort}/`,
    );

    // Route an unmatched host into a fresh throwaway.
    const throwaway = await navigateToContainerTab(
      firefox.browser,
      `http://nomatch.example:${serverPort}/`,
    );
    expect(throwaway.name).toMatch(/^tmp/);

    // Close its only tab — the event the grace is measured from.
    await throwaway.page.close();
    const closedAt = Date.now();

    // Ask the browser for the live container list until the throwaway is gone. Polling
    // this way touches nothing: no navigation, no new tab, nothing that could itself
    // keep a container alive or hurry it along.
    let removedAfterMs = Number.NaN;
    let lastSeenAfterMs = 0;
    const deadline = closedAt + PRODUCTION_GRACE_MS + SLACK_MS;
    while (Date.now() < deadline) {
      if (!(await listContainers(observer.page)).includes(throwaway.name)) {
        removedAfterMs = Date.now() - closedAt;
        break;
      }
      lastSeenAfterMs = Date.now() - closedAt;
      // A real sleep, deliberately: this is the sampling interval of a measurement, not a
      // wait for a condition. Everything else in the suite waits through the browser layer.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    // It outlived a window the shortened-grace tests would have expired in many times
    // over: the bundle carries the production constant, and nothing fires it early.
    expect(lastSeenAfterMs).toBeGreaterThan(NOT_YET_MS);
    // And it did fire: a five-minute real timer in a background page is not throttled
    // or dropped, which is the one thing a fake clock can never tell us.
    expect(
      removedAfterMs,
      `${throwaway.name} was still present ${lastSeenAfterMs}ms after its last tab closed`,
    ).not.toBeNaN();
    // Within a poll of the grace at the earliest: closedAt is read just after the close
    // returns, so the disposer's timer starts a hair either side of it.
    expect(removedAfterMs).toBeGreaterThanOrEqual(PRODUCTION_GRACE_MS - POLL_MS);
  });
});
