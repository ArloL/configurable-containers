import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readCookieNamesHere, readCookieNamesDefault, readSeenCookie, type Session,
} from "../../harness/firefox";

describe("cookies overlay (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC cancels + reopens into Work,
  // tearing down the original tab mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("seeds the cookie into the routed container, not the default store, and onto the first request", async () => {
    const url = `http://work.example:${serverPort}/`;
    await navFreshTab(url);

    // The routed Work tab (awaitContainerTab leaves the driver focused on it).
    const { name: containerName } = await awaitContainerTab(firefox.driver, url);
    expect(containerName).toBe("Work");

    // F11 boundary: present in this container's store for this URL, absent from default.
    expect(await readCookieNamesHere(firefox.driver)).toContain("seed");
    expect(await readCookieNamesDefault(firefox.driver)).not.toContain("seed");

    // F12 wire side: the very first request into the Work container already carried it.
    expect(await readSeenCookie(firefox.driver)).toContain("seed=1");
  });
});
