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
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC cancels + reopens into a
  // throwaway, tearing down the original tab mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("does not carry a cookie from one throwaway into the next visit to the same site", async () => {
    // Distinct paths, not query params: awaitContainerTab matches on url PREFIX, so
    // "?visit=1" would also match "?visit=1b" and could hand back the wrong tab.
    const first = `http://nomatch.example:${port}/first`;
    const again = `http://nomatch.example:${port}/again`;
    const second = `http://nomatch.example:${port}/second`;

    // GIVEN an unmatched site routed into a throwaway, holding a cookie.
    await navFreshTab(first);
    const a = await awaitContainerTab(session.driver, first);
    expect(a.name).toMatch(/^tmp/);
    await session.driver.executeScript("document.cookie = 'f11=secret; path=/';");

    // Control arm — without it a vacuous "cookie absent" green proves nothing, which
    // is exactly how this suite has shipped false greens before. Same site, so the
    // throwaway is kept (continuity) and the server itself must see the cookie: the
    // boundary is being tested on the wire, not just in document.cookie.
    await session.driver.get(again);
    expect(await readSeenCookie(session.driver)).toContain("f11=secret");
    expect(await readCookieNamesHere(session.driver)).toContain("f11");

    // WHEN the same site is visited afresh, it lands in a DIFFERENT throwaway.
    await navFreshTab(second);
    const b = await awaitContainerTab(session.driver, second);
    expect(b.name).toMatch(/^tmp/);
    expect(b.store).not.toBe(a.store);

    // THEN the cookie did not cross: not on the request, not in this container's jar,
    // and never deposited in the default store on the way through.
    expect(await readSeenCookie(session.driver)).not.toContain("f11");
    expect(await readCookieNamesHere(session.driver)).not.toContain("f11");
    expect(await readCookieNamesDefault(session.driver)).not.toContain("f11");
  });
});
