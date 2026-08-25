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

  // The driver can be left with no current window — the extension discards the tab it was
  // on — and `newWindow` needs a context to run in. Anchoring first is what stops opening a
  // tab from depending on where the driver happened to be.
  it("anchors on a surviving window before opening a fresh tab", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [], handles: ["w1"] });
    const page = await new BrowserSession(driver).newPage();
    expect(calls).toEqual(["switchTo(w1)", "newWindow"]);
    expect(page.handle).toBe("w2");
  });
});
