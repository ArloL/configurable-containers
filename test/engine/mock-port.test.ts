import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import type { WebRequestDetails } from "../../src/engine/port";

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

describe("mock port harness", () => {
  it("createTab assigns an incrementing id and stores the tab", async () => {
    const browser = aFakeBrowser();
    const t = await browser.port.createTab({ url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true });
    expect(t.id).toBe(1);
    expect(await browser.port.getTab(1)).toEqual(t);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("removeTab deletes the tab and records the id", async () => {
    const browser = aFakeBrowser();
    const t = browser.existingTab({ url: "https://a.test/", cookieStoreId: "firefox-default" });
    await browser.port.removeTab(t.id);
    expect(await browser.port.getTab(t.id)).toBeNull();
    expect(browser.closedTabIds).toEqual([t.id]);
  });

  it("createIdentity assigns a firefox-container-N store id and is queryable", async () => {
    const browser = aFakeBrowser();
    const ci = await browser.port.createIdentity({ name: "Work", color: "blue", icon: "circle" });
    expect(ci.cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(await browser.port.getIdentity(ci.cookieStoreId)).toEqual(ci);
    expect(await browser.port.queryIdentities()).toContainEqual(ci);
  });

  it("getIdentity returns null for firefox-default", async () => {
    const browser = aFakeBrowser();
    expect(await browser.port.getIdentity("firefox-default")).toBeNull();
  });

  it("navigates() invokes the registered onBeforeRequest handler and returns its result", async () => {
    const browser = aFakeBrowser();
    browser.port.onBeforeRequest(async () => ({ cancel: true }));
    expect(await browser.navigates(req())).toEqual({ cancel: true });
  });

  it("mock MAC returns the configured assignment or null, and can throw", async () => {
    const browser = aFakeBrowser();
    browser.macAssigns("https://owned.test/", { userContextId: 3 });
    expect(await browser.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://owned.test/" })).toEqual({ userContextId: 3 });
    expect(await browser.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://free.test/" })).toBeNull();
    browser.macIsAbsent(true);
    await expect(browser.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://owned.test/" })).rejects.toThrow();
  });
});

describe("mock port — disposal support", () => {
  it("opensTab adds a tab and fires onTabCreated; queryTabs filters by store", async () => {
    const browser = aFakeBrowser();
    const seen: number[] = [];
    browser.port.onTabCreated((t) => seen.push(t.id));
    const t = await browser.opensTab({ url: "https://a.test/", cookieStoreId: "firefox-container-1" });
    expect(seen).toEqual([t.id]);
    expect(await browser.port.queryTabs({ cookieStoreId: "firefox-container-1" })).toHaveLength(1);
    expect(await browser.port.queryTabs({ cookieStoreId: "firefox-container-2" })).toHaveLength(0);
    expect(await browser.port.queryTabs({})).toHaveLength(1);
  });

  it("closesTab removes the tab and fires onTabRemoved", async () => {
    const browser = aFakeBrowser();
    const removed: number[] = [];
    browser.port.onTabRemoved((id) => removed.push(id));
    const t = await browser.opensTab({ url: "https://a.test/", cookieStoreId: "firefox-default" });
    await browser.closesTab(t);
    expect(removed).toEqual([t.id]);
    expect(await browser.port.queryTabs({})).toHaveLength(0);
  });

  it("removeIdentity deletes the container and records it", async () => {
    const browser = aFakeBrowser();
    const ci = browser.addContainerNamed({ name: "tmp1" });
    await browser.port.removeIdentity(ci.cookieStoreId);
    expect(await browser.port.getIdentity(ci.cookieStoreId)).toBeNull();
    expect(browser.removedContainers).toEqual([ci.cookieStoreId]);
  });

  it("drops a content script from the live list when it is unregistered", async () => {
    const browser = aFakeBrowser();
    const reg = await browser.port.registerContentScript({
      matches: ["*://a.example/*"],
      js: [{ code: "a();" }],
      runAt: "document_start",
    });
    expect(browser.registeredScripts).toHaveLength(1);

    await reg.unregister();

    // Firefox stops injecting into new page loads. A mock that kept the entry would let a
    // snippet a config no longer names look registered forever, which is the one thing an
    // apply has to get right and the one thing no level below L4 could otherwise see.
    expect(browser.registeredScripts).toEqual([]);
  });

  it("fake clock fires timers only once their delay elapses", async () => {
    const { clock, advance } = aFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("a"), 100);
    await advance(99);
    expect(fired).toEqual([]);
    await advance(1);
    expect(fired).toEqual(["a"]);
  });

  it("fake clock fires re-scheduled timers within the same advance window", async () => {
    const { clock, advance } = aFakeClock();
    const fired: number[] = [];
    const tick = () => { fired.push(fired.length); if (fired.length < 3) clock.setTimeout(tick, 10); };
    clock.setTimeout(tick, 10);
    await advance(100);
    expect(fired).toEqual([0, 1, 2]);
  });
});
