import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  readCookieStoreId,
  collectStoresUntilContainer,
  awaitContainerTab,
  readDecisions,
  type ProbeDecision,
  type Session,
} from "../../harness/firefox";
import { poll, RETRY } from "../../harness/browser/retry";

describe("harness plumbing", () => {
  let firefox: Session;

  beforeAll(async () => {
    firefox = await launch();
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("reads the default cookieStoreId end-to-end", async () => {
    const page = await firefox.browser.newPage();
    await page.goto(firefox.serverUrl);
    expect(await readCookieStoreId(page)).toBe("firefox-default");
  });

  it("observes a non-default container store", async () => {
    const stores = await collectStoresUntilContainer(firefox.browser, firefox.serverUrl);
    expect(stores).toContain("firefox-default");
    expect(stores.some((s) => /^firefox-container-\d+$/.test(s))).toBe(true);
  });
});

// The channel that carries CC's CAUSES to this level, as opposed to its effects.
//
// Everything else the e2e suite observes is a consequence — a tab exists, in this container,
// with these cookies. Nothing said what CC DECIDED, so one signal (a poll running out) stood
// for a POST-guard regression, a dead window handle, an unanswered relay, a config that never
// applied, and two load-dependent races. This is the channel that tells them apart, and like
// every other diagnostic it is worth exactly as much as its own coverage: if it silently
// carried nothing, every timeout report in the suite would go back to naming a selector while
// looking like it had improved.
//
// Its own session, because the assertion is about what CC decided in THIS profile and a
// neighbouring case's navigations would be in the list too.
describe("the decision echo (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("reports the decision CC made and the outcome it acted on, not just the tab it left", async () => {
    const matched = `http://work.example:${serverPort}/`;

    // Drive it the way every routing case does — from a fresh tab, because a cancelled
    // navigation never returns to WebDriver.
    const fresh = await firefox.browser.newPage();
    try {
      await fresh.goto(matched);
    } catch {
      // CC reopened the tab away, which is the effect. The cause is what this case is about.
    }
    // Park on the routed tab: the probe's relay lives on http(s) pages, and this one is
    // reported and stays put.
    const { page } = await awaitContainerTab(firefox.browser, matched);

    // The echo is delivered by a floated sendMessage, so it lands independently of the tab
    // that provoked it — polled rather than read once, which is the same rule as every other
    // probe reading here.
    const routed = await poll<ProbeDecision>(
      {
        timeout: 15_000,
        interval: 300,
        what: `a decision for ${matched}`,
        diagnose: async () => `  saw ${JSON.stringify(await readDecisions(page))}`,
      },
      async () => {
        const seen = await readDecisions(page);
        return seen.find((d) => d.url.startsWith(matched) && d.outcome === "reopened") ?? RETRY;
      },
    );

    // The half no effect could have shown: the rule that fired, in the resolver's own words.
    expect(routed.decision).toBe("reopen -> Work");
    expect(routed.method).toBe("GET");
  });
});
