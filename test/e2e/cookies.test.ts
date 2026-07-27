import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readCookieNamesHere, readCookieNamesDefault, readSeenCookie, type Session,
} from "../../harness/firefox";

describe("cookies overlay (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC cancels + reopens into Work,
  // tearing down the original tab mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("seeds the cookie into the routed container, not the default store, and onto the first request", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);

    // The routed Work tab (awaitContainerTab leaves the driver focused on it).
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");

    // F11 boundary: present in this container's store for this URL, absent from default.
    expect(await readCookieNamesHere(session.driver)).toContain("seed");
    expect(await readCookieNamesDefault(session.driver)).not.toContain("seed");

    // F12 wire side: the very first request into the Work container already carried it.
    expect(await readSeenCookie(session.driver)).toContain("seed=1");
  });
});
