import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import type { WebRequestDetails } from "../../src/engine/port";

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

describe("mock port harness", () => {
  it("createTab assigns an incrementing id and stores the tab", async () => {
    const mp = createMockPort();
    const t = await mp.port.createTab({ url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true });
    expect(t.id).toBe(1);
    expect(await mp.port.getTab(1)).toEqual(t);
    expect(mp.calls.createTab).toHaveLength(1);
  });

  it("removeTab deletes the tab and records the id", async () => {
    const mp = createMockPort();
    const t = mp.addTab({ url: "https://a.test/", cookieStoreId: "firefox-default" });
    await mp.port.removeTab(t.id);
    expect(await mp.port.getTab(t.id)).toBeNull();
    expect(mp.calls.removeTab).toEqual([t.id]);
  });

  it("createIdentity assigns a firefox-container-N store id and is queryable", async () => {
    const mp = createMockPort();
    const ci = await mp.port.createIdentity({ name: "Work", color: "blue", icon: "circle" });
    expect(ci.cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(await mp.port.getIdentity(ci.cookieStoreId)).toEqual(ci);
    expect(await mp.port.queryIdentities()).toContainEqual(ci);
  });

  it("getIdentity returns null for firefox-default", async () => {
    const mp = createMockPort();
    expect(await mp.port.getIdentity("firefox-default")).toBeNull();
  });

  it("fire() invokes the registered onBeforeRequest handler and returns its result", async () => {
    const mp = createMockPort();
    mp.port.onBeforeRequest(async () => ({ cancel: true }));
    expect(await mp.fire(req())).toEqual({ cancel: true });
  });

  it("mock MAC returns the configured assignment or null, and can throw", async () => {
    const mp = createMockPort();
    mp.setMacAssignment("https://owned.test/", { userContextId: 3 });
    expect(await mp.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://owned.test/" })).toEqual({ userContextId: 3 });
    expect(await mp.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://free.test/" })).toBeNull();
    mp.setMacThrows(true);
    await expect(mp.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://owned.test/" })).rejects.toThrow();
  });
});
