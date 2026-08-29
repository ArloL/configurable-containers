import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readCookieNamesHere, readCookieNamesDefault, readSeenCookie, type Session,
} from "../../harness/firefox";

describe("cookies overlay (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC cancels + reopens into Work,
  // tearing down the original tab mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    const tab = await firefox.browser.newPage();
    try {
      await tab.goto(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("seeds the cookie into the routed container, not the default store, and onto the first request", async () => {
    const url = `http://work.example:${serverPort}/`;
    await navFreshTab(url);

    // The routed Work tab, named rather than assumed: every read below says which
    // page it is reading.
    const { page, name: containerName } = await awaitContainerTab(firefox.browser, url);
    expect(containerName).toBe("Work");

    // F11 boundary: present in this container's store for this URL, absent from default.
    expect(await readCookieNamesHere(page)).toContain("seed");
    expect(await readCookieNamesDefault(page)).not.toContain("seed");

    // F12 wire side: the very first request into the Work container already carried it.
    expect(await readSeenCookie(page)).toContain("seed=1");
  });
});
