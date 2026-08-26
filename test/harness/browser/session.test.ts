import { describe, it, expect } from "vitest";
import { BrowserSession } from "../../../harness/browser/session";
import { fakeDriver } from "./fake-driver";

describe("BrowserSession", () => {
  it("hands out a page per window handle", async () => {
    const { driver } = fakeDriver({ elements: () => [], handles: ["w1", "w2", "w3"] });
    const pages = await new BrowserSession(driver).pages();
    expect(pages.map((p) => p.handle)).toEqual(["w1", "w2", "w3"]);
  });

  it("finds the page showing a url", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2"],
      url: "moz-extension://cc/options.html",
    });
    const page = await new BrowserSession(driver, 500, 0).pageAt("moz-extension://cc/options.html");
    expect(page.handle).toBe("w1");
  });

  it("says what it saw when no page shows the url", async () => {
    const { driver } = fakeDriver({ elements: () => [], handles: ["w1"], url: "http://x.test/" });
    await expect(new BrowserSession(driver, 0, 0).pageAt("moz-extension://cc/")).rejects.toThrow(
      /moz-extension:\/\/cc\/.*http:\/\/x\.test\//s,
    );
  });

  // A tab can go while the walk is in progress — CC closes one per reopen — and that handle
  // is passed over rather than failing the search.
  it("passes over a tab that closed while it was walking the list", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2"],
      dead: ["w1"],
      url: "moz-extension://cc/options.html",
    });
    const page = await new BrowserSession(driver, 500, 0).pageAt("moz-extension://cc/");
    expect(page.handle).toBe("w2");
  });

  // …but only that. `retry.ts` is explicit that a driver which has died is not something to
  // wait out, and `newPage` already draws this line. This loop caught everything, so a dead
  // session was polled for the full budget and then reported as "no page at <url>" — the
  // driver's own error thrown away once per interval until a timeout replaced it.
  it("lets a driver failure out instead of polling a dead session to its deadline", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1"],
      failSwitch: () => new Error("invalid session id"),
    });
    await expect(new BrowserSession(driver, 5_000, 0).pageAt("moz-extension://cc/")).rejects.toThrow(
      "invalid session id",
    );
  });

  // The driver can be left with no current window — the extension discards the tab it was
  // on — and `newWindow` needs a context to run in. Anchoring first is what stops opening a
  // tab from depending on where the driver happened to be.
  it("anchors on a surviving window before opening a fresh tab", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [], handles: ["w1"] });
    const page = await new BrowserSession(driver).newPage();
    expect(calls).toEqual(["switchTo(w1)", "newWindow"]);
    expect(page.handle).toBe("w2");
  });

  // A handle can be LISTED and already gone: getAllWindowHandles answered a moment ago and
  // the extension closes tabs on its own schedule. Measured in CI on the auto-temp startup
  // sweep, which replaces the very tab Firefox opened — one run in three, as the first line
  // of a case whose own comment says nothing has to be re-anchored for it.
  it("passes over a window that closed between the listing and the switch", async () => {
    const { driver, calls } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2"],
      dead: ["w1"],
    });
    const page = await new BrowserSession(driver, 500, 0).newPage();
    expect(calls).toEqual(["switchTo(w1)", "switchTo(w2)", "newWindow"]);
    expect(page.handle).toBe("w3");
  });

  // …and asks the browser again rather than retrying the handles it has, because the whole
  // reason the first list was wrong is that it was a snapshot.
  it("re-reads the handle list when every window in it has gone", async () => {
    const { driver, calls } = fakeDriver({
      elements: () => [],
      handles: (call) => (call === 1 ? ["w1"] : ["w9"]),
      dead: ["w1"],
    });
    const page = await new BrowserSession(driver, 500, 0).newPage();
    expect(calls).toEqual(["switchTo(w1)", "switchTo(w9)", "newWindow"]);
    expect(page.handle).toBe("w2");
  });

  it("says which handles it kept finding closed when none of them opens", async () => {
    const { driver } = fakeDriver({ elements: () => [], handles: ["w1", "w2"], dead: ["w1", "w2"] });
    await expect(new BrowserSession(driver, 0, 0).newPage()).rejects.toThrow(
      /a window to open a tab from.*\["w1","w2"\]/s,
    );
  });
});
