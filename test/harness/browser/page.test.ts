import { describe, it, expect } from "vitest";
import { Page } from "../../../harness/browser/page";
import { fakeDriver, anElement } from "./fake-driver";

describe("Page", () => {
  it("switches to its own window before acting, whatever the driver was on", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [], handles: ["w1", "w2"] });
    await new Page(driver, "w2").goto("http://example.test/");
    expect(calls).toEqual(["switchTo(w2)", "get(http://example.test/)"]);
  });

  it("sends a key to whatever has focus, in its own window", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [] });
    await new Page(driver, "w1").keyboard.press("Enter");
    expect(calls).toEqual(["switchTo(w1)", "sendKeys(Enter)"]);
  });

  it("makes a locator that belongs to it", async () => {
    const { driver, calls } = fakeDriver({
      elements: () => [anElement({ getText: async () => "Save" })],
    });
    const page = new Page(driver, "w2");
    expect(await page.locator("#cc-save").innerText()).toBe("Save");
    expect(calls[0]).toBe("switchTo(w2)");
  });

  // What a failure gets to say. The ids are the useful half: "the element was missing" and
  // "the document had not parsed" look identical without them.
  it("describes itself with the ids that were actually there", async () => {
    const { driver } = fakeDriver({
      elements: () => [
        anElement({ getDomAttribute: async () => "cc-config" }),
        anElement({ getDomAttribute: async () => "cc-save" }),
      ],
      url: "moz-extension://cc/options.html",
      title: "config",
      handles: ["w1", "w2"],
    });
    const report = await new Page(driver, "w1").describe();
    expect(report).toEqual({
      url: "moz-extension://cc/options.html",
      title: "config",
      ids: ["cc-config", "cc-save"],
      tabs: ["moz-extension://cc/options.html", "moz-extension://cc/options.html"],
    });
  });

  // The snapshot assumption `384cdfb` took out of `close` and `newPage` and left here: a
  // handle can be LISTED and already gone. `describe` switched to each one unguarded, and
  // `diagnose` catches the throw and answers "could not be described" — so the report
  // vanished exactly when the extension was churning tabs, which is when a poll times out
  // and when the tab list is most worth reading.
  it("keeps walking the tab list when a handle has gone, and records that it had", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2", "w3"],
      dead: ["w2"],
      url: "http://x.test/",
    });
    const report = await new Page(driver, "w1").describe();
    // Recorded, not skipped: a list that quietly got shorter would hide the churn.
    expect(report.tabs).toEqual(["http://x.test/", "<gone>", "http://x.test/"]);
    expect(report.url).toBe("http://x.test/");
  });

  // The half that matters most, because the tab a poll was waiting on is the likeliest one
  // for the extension to have closed. Its own url is unreadable; the browser's other tabs
  // are not, and they are the answer the reader actually wants.
  it("still lists the other tabs when its OWN tab has gone", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2"],
      dead: ["w1"],
      url: "http://survivor.test/",
    });
    const report = await new Page(driver, "w1").describe();
    expect(report.url).toBeNull();
    expect(report.title).toBeNull();
    expect(report.ids).toEqual([]);
    expect(report.tabs).toEqual(["<gone>", "http://survivor.test/"]);
  });

  it("says a tab has gone in words, rather than printing null at the reader", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2"],
      dead: ["w1"],
      url: "http://survivor.test/",
    });
    const text = await new Page(driver, "w1").diagnose();
    expect(text).toContain("page: this tab (w1) has gone");
    expect(text).toContain('tabs=["<gone>","http://survivor.test/"]');
    expect(text).not.toContain("could not be described");
  });

  // Closing the active tab leaves Selenium with no current window, and the failure then
  // lands on whatever the next command happens to be. A page owns its own lifetime.
  it("re-attaches to a survivor after closing itself", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [], handles: ["w1", "w2"] });
    await new Page(driver, "w2").close();
    expect(calls).toEqual(["switchTo(w2)", "close", "switchTo(w1)"]);
  });

  // The listing is a snapshot, and the extension closes tabs on its own schedule: a handle
  // can be named and already gone. Same race as BrowserSession.newPage, where it cost a CI
  // run — here it must not turn a close into a failure, since every Page operation switches
  // to its own handle first and the re-attach is a courtesy to the NEXT caller.
  it("keeps looking when the survivor it was offered has gone too", async () => {
    const { driver, calls } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w3", "w2"],
      dead: ["w1"],
    });
    await new Page(driver, "w2").close();
    expect(calls).toEqual(["switchTo(w2)", "close", "switchTo(w1)", "switchTo(w3)"]);
  });

  it("does not fail a close just because nothing is left to attach to", async () => {
    // This page is w2 and closes cleanly; w1 is all that is left and it has gone too.
    const { driver } = fakeDriver({ elements: () => [], handles: ["w1"], dead: ["w1"] });
    await expect(new Page(driver, "w2").close()).resolves.toBeUndefined();
  });

  it("renders the report as something a failure can carry", async () => {
    const { driver } = fakeDriver({ elements: () => [], url: "http://x.test/", title: "x" });
    expect(await new Page(driver, "w1").diagnose()).toMatch(/http:\/\/x\.test\/.*ids=\[\]/s);
  });

  // A document that will not answer costs its own half of the report and nothing else. It
  // used to cost all of it: `findElements` threw, `describe` threw, and `diagnose` said
  // "could not be described" — discarding the tab list, which needs no document at all.
  it("keeps the tab list when the document cannot be read", async () => {
    const { driver } = fakeDriver({
      elements: () => {
        throw new Error("document not ready");
      },
      handles: ["w1", "w2"],
      url: "http://x.test/",
    });
    const report = await new Page(driver, "w1").describe();
    expect(report.ids).toEqual([]);
    expect(report.tabs).toEqual(["http://x.test/", "http://x.test/"]);
  });

  // A diagnosis that throws would replace the real failure with its own, which is how a
  // useful error message becomes "Cannot read properties of undefined". A browser that will
  // not even list its windows is the one shape left where there is nothing to say.
  it("still says something when the driver itself will not answer", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      failHandles: () => new Error("invalid session id"),
    });
    expect(await new Page(driver, "w1").diagnose()).toMatch(
      /could not be described.*invalid session id/s,
    );
  });
});
