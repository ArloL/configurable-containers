import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };
const noop = () => {};

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "POST", ...over };
}

// example.com opens the permanent "Work" container.
function workConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work"] } }], groups: [] };
}

// example.com offers two containers and no default — resolve() returns a choice.
function choiceConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Personal", "Work"] } }], groups: [] };
}

describe("engine — a non-GET navigation is never reopened (F9)", () => {
  it("declines to reopen a POST into a permanent container, and says where it stayed", async () => {
    const mp = createMockPort();
    const tmp = mp.addIdentity({ name: "tmp1" });
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: tmp.cookieStoreId });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    // tabs.create can only issue a GET, so reopening would drop the body. The POST
    // proceeds where it is: no cancel, no new tab.
    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toEqual([]);
    expect(mp.calls.removeTab).toEqual([]);
    expect(mp.calls.notify).toHaveLength(1);
    expect(mp.calls.notify[0].message).toBe(
      "A form submission to example.com stayed in tmp1 instead of Work — moving it would have dropped the form data.",
    );
  });

  it("declines a POST that would have bought a fresh throwaway", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: { rules: [], groups: [] }, deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toEqual([]);
    expect(mp.calls.notify[0].message).toContain("stayed in the default container instead of a new temporary container");
  });

  it("declines a POST that would have raised the choice screen", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const offered: string[][] = [];
    createEngine({ port: mp.port, config: choiceConfig(), deps, onChoice: (o) => void offered.push(o), tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    // The choice screen reopens through engine.reopen too, so it drops the body just
    // as surely — decline before showing it.
    expect(res).toBeUndefined();
    expect(offered).toEqual([]);
    expect(mp.calls.updates).toEqual([]);
    expect(mp.calls.notify[0].message).toContain("instead of one of: Personal, Work");
  });

  it("leaves a POST that was already going to stay put alone, and stays silent", async () => {
    const mp = createMockPort();
    const work = mp.addIdentity({ name: "Work" });
    const tab = mp.addTab({ url: "https://example.com/a", cookieStoreId: work.cookieStoreId });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    await mp.flush();

    expect(res).toBeUndefined();
    expect(mp.calls.notify).toEqual([]);
  });

  it("still reopens a GET", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, method: "GET" }));
    await mp.flush();

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1);
    expect(mp.calls.notify).toEqual([]);
  });

  it("warns once per host, not once per attempt", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: tab.id, requestId: "1" }));
    await mp.fire(req({ tabId: tab.id, requestId: "2", url: "https://example.com/other" }));
    await mp.flush();

    expect(mp.calls.notify).toHaveLength(1);
  });

  it("says nothing about a POST inside a navigation the engine itself reopened", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: tab.id, method: "GET" })); // reopens into Work
    const created = mp.calls.createTab[0];
    const openedTab = [...mp.tabs.values()].find((t) => t.cookieStoreId === created.cookieStoreId)!;

    // A form POST arriving as the reopened tab's own first request is ours already —
    // it returns at the reopenedNav guard and never reaches the F9 check.
    const res = await mp.fire(req({ tabId: openedTab.id, requestId: "2" }));
    await mp.flush();

    expect(res).toBeUndefined();
    expect(mp.calls.notify).toEqual([]);
  });
});
