import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBrowserPort } from "../../src/engine/browser-port";
import type { WebRequestDetails } from "../../src/engine/port";

// A hand-rolled fake of the browser.* surface the adapter touches. Installed as the
// global `browser` for the duration of each test.
function fakeBrowser() {
  return {
    webRequest: {
      onBeforeRequest: {
        addListener(fn: (d: unknown) => unknown, filter: unknown, extra: unknown) {
          f.webRequest.onBeforeRequest.onBeforeRequest_last = { fn, filter, extra };
        },
        onBeforeRequest_last: null as unknown,
      },
      onBeforeSendHeaders: {
        addListener(fn: (d: unknown) => unknown, filter: unknown, extra: unknown) {
          f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last = { fn, filter, extra };
        },
        onBeforeSendHeaders_last: null as unknown,
      },
    },
    tabs: {
      get: async (id: number) => {
        if (id === 404) throw new Error("no such tab");
        return { id, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true, openerTabId: 9 };
      },
      create: async (props: Record<string, unknown>) => ({ id: 77, url: props.url, cookieStoreId: props.cookieStoreId, index: props.index ?? 0, active: props.active ?? true, openerTabId: props.openerTabId }),
      remove: async (_id: number) => {},
      query: async (info: { cookieStoreId?: string }) =>
        info.cookieStoreId === "firefox-container-2"
          ? [{ id: 3, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true }]
          : [],
      onCreated: {
        addListener: (fn: (t: unknown) => void) => { f.tabs.onCreated_fn = fn; },
        onCreated_fn: null as unknown,
      },
      onRemoved: {
        addListener: (fn: (id: number) => void) => { f.tabs.onRemoved_fn = fn; },
        onRemoved_fn: null as unknown,
      },
      onCreated_fn: null as unknown,
      onRemoved_fn: null as unknown,
    },
    contextualIdentities: {
      query: async (_d: object) => [{ cookieStoreId: "firefox-container-2", name: "Work", color: "blue", icon: "circle" }],
      create: async (p: { name: string; color: string; icon: string }) => ({ cookieStoreId: "firefox-container-9", ...p }),
      get: async (csid: string) => {
        if (csid === "firefox-default") throw new Error("no identity");
        return { cookieStoreId: csid, name: "Work", color: "blue", icon: "circle" };
      },
      remove: async (csid: string) => { f.contextualIdentities.removed = csid; return { cookieStoreId: csid, name: "tmp1", color: "blue", icon: "circle" }; },
      removed: null as unknown,
    },
    cookies: {
      set: async (d: Record<string, unknown>) => {
        f.cookies._set = d;
        return { name: d.name, value: d.value ?? "" };
      },
      get: async (d: { name: string; storeId: string }) => {
        if (d.name === "absent") return null;
        return { name: d.name, value: "V", storeId: d.storeId };
      },
      _set: null as unknown,
    },
    runtime: { sendMessage: async (_ext: string, msg: unknown) => ({ echoed: msg }) },
  };
}
let f: ReturnType<typeof fakeBrowser>;

beforeEach(() => {
  f = fakeBrowser();
  (globalThis as unknown as { browser: unknown }).browser = f;
});
afterEach(() => {
  delete (globalThis as unknown as { browser?: unknown }).browser;
});

describe("createBrowserPort", () => {
  it("registers a blocking main_frame onBeforeRequest listener and forwards mapped details", async () => {
    const seen: WebRequestDetails[] = [];
    const port = createBrowserPort();
    port.onBeforeRequest(async (d) => { seen.push(d); return { cancel: true }; });

    const reg = f.webRequest.onBeforeRequest.onBeforeRequest_last as { fn: (d: unknown) => Promise<unknown>; filter: unknown; extra: unknown };
    expect(reg.filter).toEqual({ urls: ["<all_urls>"], types: ["main_frame"] });
    expect(reg.extra).toEqual(["blocking"]);

    const result = await reg.fn({ requestId: "5", tabId: 3, url: "https://a.test/", type: "main_frame", method: "GET" });
    expect(seen[0]).toMatchObject({ requestId: "5", tabId: 3, url: "https://a.test/", type: "main_frame", method: "GET" });
    expect(result).toEqual({ cancel: true });
  });

  it("coerces a void handler result to an empty (non-blocking) response", async () => {
    const port = createBrowserPort();
    port.onBeforeRequest(async () => undefined);
    const reg = f.webRequest.onBeforeRequest.onBeforeRequest_last as { fn: (d: unknown) => Promise<unknown> };
    expect(await reg.fn({ requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", method: "GET" })).toEqual({});
  });

  it("getTab maps fields (incl. openerTabId) and returns null when the tab is gone", async () => {
    const port = createBrowserPort();
    expect(await port.getTab(3)).toEqual({ id: 3, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true, openerTabId: 9 });
    expect(await port.getTab(404)).toBeNull();
  });

  it("getIdentity returns null for the default store (get throws) and maps a real container", async () => {
    const port = createBrowserPort();
    expect(await port.getIdentity("firefox-default")).toBeNull();
    expect(await port.getIdentity("firefox-container-2")).toEqual({ cookieStoreId: "firefox-container-2", name: "Work", color: "blue", icon: "circle" });
  });

  it("createTab passes props through and maps the result", async () => {
    const port = createBrowserPort();
    const t = await port.createTab({ url: "https://a.test/", cookieStoreId: "firefox-container-9", index: 2, active: false, openerTabId: 5 });
    expect(t).toEqual({ id: 77, url: "https://a.test/", cookieStoreId: "firefox-container-9", index: 2, active: false, openerTabId: 5 });
  });

  it("sendExternalMessage delegates to runtime.sendMessage", async () => {
    const port = createBrowserPort();
    expect(await port.sendExternalMessage("@mac", { method: "getAssignment" })).toEqual({ echoed: { method: "getAssignment" } });
  });

  it("registers a blocking main_frame onBeforeSendHeaders listener and maps details", async () => {
    const port = createBrowserPort();
    let seen: unknown;
    port.onBeforeSendHeaders(async (d) => { seen = d; return { requestHeaders: d.requestHeaders }; });

    const reg = f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last as { fn: (d: unknown) => Promise<unknown>; filter: unknown; extra: unknown };
    expect(reg.filter).toEqual({ urls: ["<all_urls>"], types: ["main_frame"] });
    expect(reg.extra).toEqual(["blocking", "requestHeaders"]);

    const result = await reg.fn({ requestId: "7", tabId: 2, url: "https://a.test/", type: "main_frame", requestHeaders: [{ name: "Cookie", value: "a=1" }] });
    expect(seen).toMatchObject({ requestId: "7", tabId: 2, url: "https://a.test/", type: "main_frame", requestHeaders: [{ name: "Cookie", value: "a=1" }] });
    expect(result).toEqual({ requestHeaders: [{ name: "Cookie", value: "a=1" }] });
  });

  it("coerces a void onBeforeSendHeaders result to an empty response", async () => {
    const port = createBrowserPort();
    port.onBeforeSendHeaders(async () => undefined);
    const reg = f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last as { fn: (d: unknown) => Promise<unknown> };
    expect(await reg.fn({ requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", requestHeaders: [] })).toEqual({});
  });

  it("setCookie delegates to browser.cookies.set with the storeId", async () => {
    const port = createBrowserPort();
    await port.setCookie({ name: "s", url: "https://a.test/", value: "1", storeId: "firefox-container-2" });
    expect(f.cookies._set).toMatchObject({ name: "s", url: "https://a.test/", value: "1", storeId: "firefox-container-2" });
  });

  it("getCookie maps a hit and returns null for a miss", async () => {
    const port = createBrowserPort();
    expect(await port.getCookie({ name: "s", url: "https://a.test/", storeId: "firefox-container-2" })).toEqual({ name: "s", value: "V" });
    expect(await port.getCookie({ name: "absent", url: "https://a.test/", storeId: "firefox-container-2" })).toBeNull();
  });
});

describe("createBrowserPort — disposal methods", () => {
  it("onTabCreated forwards a mapped tab; onTabRemoved forwards the id", async () => {
    const port = createBrowserPort();
    const created: number[] = [];
    const removed: number[] = [];
    port.onTabCreated((t) => created.push(t.id));
    port.onTabRemoved((id) => removed.push(id));
    (f.tabs.onCreated_fn as (t: unknown) => void)({ id: 5, url: "https://a/", cookieStoreId: "firefox-default", index: 0, active: true });
    (f.tabs.onRemoved_fn as (id: number) => void)(5);
    expect(created).toEqual([5]);
    expect(removed).toEqual([5]);
  });

  it("queryTabs maps results; removeIdentity delegates", async () => {
    const port = createBrowserPort();
    expect(await port.queryTabs({ cookieStoreId: "firefox-container-2" })).toHaveLength(1);
    expect(await port.queryTabs({ cookieStoreId: "firefox-container-9" })).toHaveLength(0);
    await port.removeIdentity("firefox-container-2");
    expect(f.contextualIdentities.removed).toBe("firefox-container-2");
  });
});
