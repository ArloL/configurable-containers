import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

// A config with one rule: example.com opens the permanent "Work" container.
function workConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work"] } }], groups: [] };
}

const noop = () => {};

describe("engine — reopen/stay/leaveAlone + F1 guard", () => {
  it("reopens a plain nav into the target container, preserving placement", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: old.id }));

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1);
    const created = mp.calls.createTab[0];
    const work = (await mp.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(created.cookieStoreId).toBe(work.cookieStoreId);
    expect(created).toMatchObject({ url: "https://example.com/", index: 3, active: true, openerTabId: 7 });
    expect(mp.calls.removeTab).toEqual([old.id]);
  });

  it("F1: a re-fire of the same request+url does not open a second tab", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: old.id }));
    const again = await mp.fire(req({ tabId: old.id })); // same requestId + url

    expect(again).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1); // still just one
  });

  it("F1 termination: the reopened tab (now in target) yields stay, no further effects", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: old.id }));
    const newTab = [...mp.tabs.values()].find((t) => t.id !== old.id)!;
    const res = await mp.fire(req({ requestId: "2", tabId: newTab.id }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(1); // no second reopen
  });

  it("F2: a tab already in the target container stays (no effects)", async () => {
    const mp = createMockPort();
    const work = mp.addIdentity({ name: "Work" });
    const tab = mp.addTab({ url: "https://example.com/old", cookieStoreId: work.cookieStoreId });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
    expect(mp.calls.removeTab).toHaveLength(0);
  });

  it("no matching rule reopens into a fresh tmp-prefixed container", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: { rules: [], groups: [] }, deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, url: "https://unmatched.test/" }));

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createIdentity[0].name).toMatch(/^tmp/);
  });

  it("skips non-http(s) navigations", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, url: "about:preferences" }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("skips sub_frame requests", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, type: "sub_frame" }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("fails open when the tab has raced away (getTab null)", async () => {
    const mp = createMockPort();
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: 999 }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("fails open (no cancel) when createTab throws, and clears the guard for retry", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    mp.setCreateTabThrows(true);
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    expect(res).toBeUndefined(); // NOT { cancel: true }

    mp.setCreateTabThrows(false);
    const retry = await mp.fire(req({ tabId: tab.id })); // same key retried
    expect(retry).toEqual({ cancel: true }); // guard was cleared, retry works
  });
});
