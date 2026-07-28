import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, readCookieNamesHere, readCookieNamesDefault, readSeenCookie,
  type Session,
} from "../../harness/firefox";

// F11, the one thing containers must prevent: a cookie set in one throwaway is
// invisible to the next, and no routing action ever carries it across a
// cookieStoreId. Own session — a cookie from a neighbouring test's container would
// make the negative assertions meaningless.
describe("cookie boundary (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC cancels + reopens into a
  // throwaway, tearing down the original tab mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("does not carry a cookie from one throwaway into the next visit to the same site", async () => {
    // Distinct paths, not query params: awaitContainerTab matches on url PREFIX, so
    // "?visit=1" would also match "?visit=1b" and could hand back the wrong tab.
    const firstThrowawayUrl = `http://nomatch.example:${serverPort}/firstThrowawayUrl`;
    const again = `http://nomatch.example:${serverPort}/again`;
    const secondThrowawayUrl = `http://nomatch.example:${serverPort}/secondThrowawayUrl`;

    // GIVEN an unmatched site routed into a throwaway, holding a cookie.
    await navFreshTab(firstThrowawayUrl);
    const a = await awaitContainerTab(firefox.driver, firstThrowawayUrl);
    expect(a.name).toMatch(/^tmp/);
    await firefox.driver.executeScript("document.cookie = 'f11=secret; path=/';");

    // Control arm — without it a vacuous "cookie absent" green proves nothing, which
    // is exactly how this suite has shipped false greens before. Same site, so the
    // throwaway is kept (continuity) and the server itself must see the cookie: the
    // boundary is being tested on the wire, not just in document.cookie.
    await firefox.driver.get(again);
    expect(await readSeenCookie(firefox.driver)).toContain("f11=secret");
    expect(await readCookieNamesHere(firefox.driver)).toContain("f11");

    // WHEN the same site is visited afresh, it lands in a DIFFERENT throwaway.
    await navFreshTab(secondThrowawayUrl);
    const b = await awaitContainerTab(firefox.driver, secondThrowawayUrl);
    expect(b.name).toMatch(/^tmp/);
    expect(b.store).not.toBe(a.store);

    // THEN the cookie did not cross: not on the request, not in this container's jar,
    // and never deposited in the default store on the way through.
    expect(await readSeenCookie(firefox.driver)).not.toContain("f11");
    expect(await readCookieNamesHere(firefox.driver)).not.toContain("f11");
    expect(await readCookieNamesDefault(firefox.driver)).not.toContain("f11");
  });
});
