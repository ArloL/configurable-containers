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

  it("renders the report as something a failure can carry", async () => {
    const { driver } = fakeDriver({ elements: () => [], url: "http://x.test/", title: "x" });
    expect(await new Page(driver, "w1").diagnose()).toMatch(/http:\/\/x\.test\/.*ids=\[\]/s);
  });

  // A diagnosis that throws would replace the real failure with its own, which is how a
  // useful error message becomes "Cannot read properties of undefined".
  it("still says something when it cannot describe itself", async () => {
    const { driver } = fakeDriver({
      elements: () => {
        throw new Error("window gone");
      },
    });
    expect(await new Page(driver, "w1").diagnose()).toMatch(/could not be described.*window gone/s);
  });
});
