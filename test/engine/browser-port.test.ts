import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBrowserPort, realClock } from "../../src/engine/browser-port";
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
    webNavigation: {
      onBeforeNavigate: {
        addListener(fn: (d: unknown) => void) {
          f.webNavigation.onBeforeNavigate.onBeforeNavigate_fn = fn;
        },
        onBeforeNavigate_fn: null as unknown,
      },
    },
    tabs: {
      get: async (id: number) => {
        if (id === 404) throw new Error("no such tab");
        return { id, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true, openerTabId: 9 };
      },
      create: async (props: Record<string, unknown>) => {
        f.tabs._created = props;
        const created: Record<string, unknown> = { id: 77, url: props.url, cookieStoreId: props.cookieStoreId, index: props.index ?? 0, active: props.active ?? true, openerTabId: props.openerTabId };
        // Firefox answers a create for the default store with no cookieStoreId at all.
        if (f.tabs._createOmitsStore) delete created.cookieStoreId;
        return created;
      },
      _createOmitsStore: false,
      _created: {} as Record<string, unknown>,
      remove: async (id: number) => { f.tabs._removed.push(id); },
      query: async (info: { cookieStoreId?: string; active?: boolean }) => {
        // getActiveTab asks by activity, the disposer by container; one fake, two shapes.
        if (info.active === true) return f.tabs._active;
        return info.cookieStoreId === "firefox-container-2"
          ? [{ id: 3, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true }]
          : [];
      },
      _active: [
        { id: 8, url: "https://active.test/", cookieStoreId: "firefox-container-2", index: 0, active: true, windowId: 1 },
      ] as unknown[],
      _removed: [] as number[],
      onCreated: {
        addListener: (fn: (t: unknown) => void) => { f.tabs.onCreated_fn = fn; },
        onCreated_fn: null as unknown,
      },
      onRemoved: {
        addListener: (fn: (id: number) => void) => { f.tabs.onRemoved_fn = fn; },
        onRemoved_fn: null as unknown,
      },
      onUpdated: {
        addListener(fn: (id: number, info: unknown, tab: unknown) => void) {
          f.tabs.onUpdated_fn = fn;
        },
        onUpdated_fn: null as unknown,
      },
      onCreated_fn: null as unknown,
      onRemoved_fn: null as unknown,
      onUpdated_fn: null as unknown,
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
    contentScripts: {
      register: async (d: unknown) => {
        f.contentScripts._registered = d;
        return { unregister: async () => { f.contentScripts._unregistered = true; } };
      },
      _registered: null as unknown,
      _unregistered: false,
    },
    notifications: {
      create: async (opts: Record<string, unknown>) => {
        if (f.notifications._throws) throw new Error("No permission for notifications");
        f.notifications._created.push(opts);
        return "id-1";
      },
      _created: [] as Record<string, unknown>[],
      _throws: false,
    },
    runtime: {
      onMessage: {
        addListener: (fn: (msg: unknown, sender: unknown) => unknown) => {
          f.runtime._onMessage = fn;
        },
      },
      _onMessage: null as ((msg: unknown, sender: unknown) => unknown) | null,
      getURL: (path: string) => `moz-extension://uuid/${path}`,
      sendMessage: async (ext: string, msg: unknown) => {
        f.runtime._sent.push({ ext, msg });
        if (f.runtime._sendRejects) throw new Error("Could not establish connection");
        return { echoed: msg };
      },
      _sent: [] as { ext: string; msg: unknown }[],
      // What Firefox answers when nobody is listening at that id — the probe not installed,
      // or a `npm run manual` run where it never is.
      _sendRejects: false,
    },
    commands: {
      onCommand: {
        addListener: (fn: (name: string) => void) => {
          f.commands._onCommand = fn;
        },
      },
      _onCommand: null as ((name: string) => void) | null,
    },
    storage: {
      local: {
        get: async (key: string) => (key in f.storage._local ? { [key]: f.storage._local[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(f.storage._local, items);
        },
      },
      _local: {} as Record<string, unknown>,
    },
    browserAction: {
      onClicked: {
        addListener: (fn: (tab: unknown) => void) => {
          f.browserAction._clicked = fn;
        },
      },
      _clicked: null as ((tab: unknown) => void) | null,
      setBadgeText: async (d: { text: string }) => {
        f.browserAction._texts.push(d.text);
      },
      setBadgeBackgroundColor: async (d: { color: string }) => {
        f.browserAction._colors.push(d.color);
      },
      _texts: [] as string[],
      _colors: [] as string[],
    },
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

  it("forwards onBeforeNavigate with the url Firefox is really navigating to", () => {
    const seen: { tabId: number; frameId: number; url: string }[] = [];
    const port = createBrowserPort();
    port.onBeforeNavigate((d) => void seen.push(d));

    const fn = f.webNavigation.onBeforeNavigate.onBeforeNavigate_fn as (d: unknown) => void;
    // The whole reason this seam exists: `view-source:` survives here, and nowhere in
    // the webRequest the same load goes on to issue.
    fn({ tabId: 3, frameId: 0, url: "view-source:https://a.test/", timeStamp: 1 });

    expect(seen).toEqual([{ tabId: 3, frameId: 0, url: "view-source:https://a.test/" }]);
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

  // The listener is registered with the "requestHeaders" opt-in, so this is a defence
  // against losing it: an empty list is a request with no headers, `undefined` is a crash
  // inside a blocking handler, which is a navigation that never completes.
  it("reads a request Firefox sent no headers for as an empty header list", async () => {
    const port = createBrowserPort();
    let seen: unknown;
    port.onBeforeSendHeaders(async (d) => { seen = d.requestHeaders; return undefined; });
    const reg = f.webRequest.onBeforeSendHeaders.onBeforeSendHeaders_last as { fn: (d: unknown) => Promise<unknown> };
    await reg.fn({ requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame" });
    expect(seen).toEqual([]);
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

  it("registerContentScript delegates to browser.contentScripts.register and returns a handle", async () => {
    const port = createBrowserPort();
    const handle = await port.registerContentScript({
      matches: ["*://work.example/*"],
      js: [{ code: "localStorage.setItem('cc_script','1');" }],
      runAt: "document_start",
    });
    expect(f.contentScripts._registered).toMatchObject({
      matches: ["*://work.example/*"],
      js: [{ code: "localStorage.setItem('cc_script','1');" }],
      runAt: "document_start",
    });
    expect(f.contentScripts._unregistered).toBe(false);
    await handle.unregister();
    expect(f.contentScripts._unregistered).toBe(true);
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

  it("onTabUpdated maps tab + changeInfo to the handler", () => {
    const port = createBrowserPort();
    const seen: { tab: unknown; info: unknown }[] = [];
    port.onTabUpdated((tab, info) => { seen.push({ tab, info }); });

    const fn = f.tabs.onUpdated_fn as (id: number, info: unknown, raw: unknown) => void;
    fn(3, { status: "complete" }, { id: 3, url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true });

    expect(seen).toEqual([
      {
        tab: { id: 3, url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true, openerTabId: undefined },
        info: { status: "complete" },
      },
    ]);
  });

  it("queryTabs maps results; removeIdentity delegates", async () => {
    const port = createBrowserPort();
    expect(await port.queryTabs({ cookieStoreId: "firefox-container-2" })).toHaveLength(1);
    expect(await port.queryTabs({ cookieStoreId: "firefox-container-9" })).toHaveLength(0);
    await port.removeIdentity("firefox-container-2");
    expect(f.contextualIdentities.removed).toBe("firefox-container-2");
  });

  it("notify raises a basic notification", async () => {
    const port = createBrowserPort();
    await port.notify({ title: "T", message: "M" });
    expect(f.notifications._created).toEqual([{ type: "basic", title: "T", message: "M" }]);
  });

  it("notify echoes to the probe AFTER the notification is created", async () => {
    const port = createBrowserPort();
    await port.notify({ title: "T", message: "M" });
    expect(f.runtime._sent).toEqual([
      { ext: "probe@configurable-containers.test", msg: { cmd: "cc-notification", title: "T", message: "M" } },
    ]);
  });

  // The ordering is the whole design: a missing "notifications" permission must make
  // the e2e assertion fail. Echo first and the suite reports green with the
  // notification entirely broken.
  it("does not echo when the notification itself failed", async () => {
    f.notifications._throws = true;
    const port = createBrowserPort();
    await expect(port.notify({ title: "T", message: "M" })).rejects.toThrow(/No permission/);
    expect(f.runtime._sent).toEqual([]);
  });

  // The other half of the boundary the 2026-08-29 modularity review named: until this echo
  // the e2e layer could see CC's EFFECTS and never its CAUSES, so one timeout stood for six
  // possible causes.
  it("echoDecision sends what CC decided and what it did, in words", () => {
    const port = createBrowserPort();

    port.echoDecision({
      url: "https://work.example/",
      method: "POST",
      tabId: 4,
      decision: { kind: "reopen", into: { kind: "permanent", name: "Work" } },
      outcome: "declined: POST has a body and tabs.create can only issue a GET (F9)",
    });

    expect(f.runtime._sent).toEqual([
      {
        ext: "probe@configurable-containers.test",
        msg: {
          cmd: "cc-decision",
          url: "https://work.example/",
          method: "POST",
          tabId: 4,
          // Rendered here rather than shipped as an object: the probe stores what it is
          // given and the reader reads it, so the WORDS are the contract, and they are the
          // resolver's own (`describeDecision`) so a diagnosis and an F9 toast cannot come
          // to describe the same decision differently.
          decision: "reopen -> Work",
          outcome: "declined: POST has a body and tabs.create can only issue a GET (F9)",
        },
      },
    ]);
  });

  // An exit that returned before resolving has no decision, and says so rather than
  // inventing one: "CC never got as far as deciding" and "CC decided to leave it alone" are
  // different bugs, and the first is the one a reader mistakes for "CC never saw this".
  it("echoDecision says so when there was no decision yet", () => {
    createBrowserPort().echoDecision({
      url: "https://work.example/",
      method: "GET",
      tabId: 4,
      outcome: "not routed: a view-source: load",
    });

    expect((f.runtime._sent[0]!.msg as { decision: unknown }).decision).toBeNull();
  });

  // Synchronous and void BY CONTRACT: the caller is the blocking onBeforeRequest handler, so
  // saying what happened must neither delay a navigation nor be able to break one. A probe
  // that is not installed answers with a rejection, and the only correct response to it here
  // is nothing at all.
  it("echoDecision survives a send nobody is listening for", async () => {
    f.runtime._sendRejects = true;
    const port = createBrowserPort();

    expect(port.echoDecision({ url: "https://x.test/", method: "GET", tabId: 1, outcome: "left where it is" }))
      .toBeUndefined();

    // The floated rejection settles on the microtask queue; an unhandled one here would be
    // an unhandled rejection in the background context.
    await Promise.resolve();
  });

  it("setBadge writes the text and colours the badge exactly once", async () => {
    const port = createBrowserPort();

    await port.setBadge("1");
    await port.setBadge("2");
    await port.setBadge("");

    expect(f.browserAction._texts).toEqual(["1", "2", ""]);
    // The colour never changes, so setting it per update would be one wasted call on
    // every arm and disarm. Constructing the port must not do it either: every other
    // method here touches browser.* only when invoked.
    expect(f.browserAction._colors).toEqual(["#c1361a"]);
  });

  it("onActionClicked hands on the tab Firefox supplied, mapped", () => {
    const port = createBrowserPort();
    const seen: { id: number; cookieStoreId: string }[] = [];
    port.onActionClicked((tab) => void seen.push({ id: tab.id, cookieStoreId: tab.cookieStoreId }));

    // Firefox passes the ACTIVE tab, which is what lets the button arm the container the
    // user is in with no popup and no payload to validate. WebDriver cannot click a
    // browser_action, so this is the only place the mapping is exercised at all.
    f.browserAction._clicked!({ id: 5, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 1, active: true, windowId: 3 });

    expect(seen).toEqual([{ id: 5, cookieStoreId: "firefox-container-2" }]);
  });

  it("constructing the port touches no browser.* API", () => {
    createBrowserPort();

    expect(f.browserAction._texts).toEqual([]);
    expect(f.browserAction._colors).toEqual([]);
  });
});

// The rest of the adapter: delegations with no decision in them, which is exactly why
// nothing had reached them (FOLLOWUPS.md, "The impure shells are where coverage stops").
// What they can still get wrong is the SHAPE — a field dropped in the mapping, an argument
// forwarded in the wrong position — and that is what these pin.
describe("createBrowserPort — remaining delegations", () => {
  it("removeTab, queryIdentities and createIdentity map both ways", async () => {
    const port = createBrowserPort();

    await port.removeTab(5);
    expect(f.tabs._removed).toEqual([5]);

    expect(await port.queryIdentities()).toEqual([
      { cookieStoreId: "firefox-container-2", name: "Work", color: "blue", icon: "circle" },
    ]);

    expect(await port.createIdentity({ name: "tmp1", color: "toolbar", icon: "circle" })).toEqual({
      cookieStoreId: "firefox-container-9", name: "tmp1", color: "toolbar", icon: "circle",
    });
  });

  // The sender's tab is the ONLY place the choice page's pick may take a tab id from: a
  // crafted moz-extension://…/choice.html# link is attacker-reachable, and the id it
  // carries would go on to port.createTab. Dropping it here is what makes that safe.
  it("onMessage hands on the message with the SENDER's tab id, undefined when there is none", () => {
    const port = createBrowserPort();
    const seen: { msg: unknown; sender: unknown }[] = [];
    port.onMessage((msg, sender) => {
      seen.push({ msg, sender });
      return undefined;
    });

    const fn = f.runtime._onMessage!;
    fn({ type: "cc-pick" }, { tab: { id: 4 } });
    fn({ type: "cc-pick" }, {});

    expect(seen).toEqual([
      { msg: { type: "cc-pick" }, sender: { tabId: 4 } },
      { msg: { type: "cc-pick" }, sender: { tabId: undefined } },
    ]);
  });

  it("onCommand forwards the command name", () => {
    const port = createBrowserPort();
    const seen: string[] = [];
    port.onCommand((name) => void seen.push(name));

    f.commands._onCommand!("cc-reopen");

    expect(seen).toEqual(["cc-reopen"]);
  });

  it("getActiveTab maps the first result and answers null when there is none", async () => {
    const port = createBrowserPort();
    expect(await port.getActiveTab()).toMatchObject({ id: 8, cookieStoreId: "firefox-container-2" });

    // `tabs.query` is typed as a non-empty array nowhere: a window with no tab, or one
    // whose only tab is closing, answers [].
    f.tabs._active = [];
    expect(await port.getActiveTab()).toBeNull();
  });

  it("getURL delegates to runtime.getURL", () => {
    expect(createBrowserPort().getURL("choice.html")).toBe("moz-extension://uuid/choice.html");
  });

  // The seam the disposer's grace is built on: a pending setTimeout dies with the
  // background context, so emptiness is a STORED fact (F10).
  it("readStored answers undefined for a key never written, and round-trips one that was", async () => {
    const port = createBrowserPort();
    expect(await port.readStored("ccEmptySince")).toBeUndefined();

    await port.writeStored("ccEmptySince", { "firefox-container-9": 1000 });

    expect(await port.readStored("ccEmptySince")).toEqual({ "firefox-container-9": 1000 });
  });

  // Firefox reports neither on a tab that is still pre-commit, and the engine reads
  // `about:blank` and the default store as meaningful states rather than as absence.
  it("maps a tab with no url and no cookieStoreId to the empty url and the default store", () => {
    const port = createBrowserPort();
    const seen: { url: string; cookieStoreId: string }[] = [];
    port.onTabCreated((t) => void seen.push({ url: t.url, cookieStoreId: t.cookieStoreId }));

    (f.tabs.onCreated_fn as (t: unknown) => void)({ id: 5, index: 0, active: true, windowId: 1 });

    expect(seen).toEqual([{ url: "", cookieStoreId: "firefox-default" }]);
  });

  // `about:newtab` is an "Illegal URL" to tabs.create, so landing there means passing NO
  // url at all — `url: undefined` is a different request and does not.
  it("createTab omits the url key entirely when there is none", async () => {
    const port = createBrowserPort();
    await port.createTab({ cookieStoreId: "firefox-container-9", index: 2, active: true, windowId: 1 });
    expect("url" in f.tabs._created).toBe(false);
  });

  // Firefox answers a create for the default store without naming it. Falling back to
  // what was ASKED for keeps the caller's own record of where the tab went honest.
  it("createTab falls back to the requested store when the created tab does not name one", async () => {
    f.tabs._createOmitsStore = true;
    const port = createBrowserPort();
    const t = await port.createTab({ cookieStoreId: "firefox-default", index: 0, active: true, windowId: 1 });
    expect(t.cookieStoreId).toBe("firefox-default");
  });

  it("onTabUpdated drops a status Firefox does not define", () => {
    const port = createBrowserPort();
    const seen: unknown[] = [];
    port.onTabUpdated((_tab, info) => void seen.push(info));

    const fn = f.tabs.onUpdated_fn as (id: number, info: unknown, raw: unknown) => void;
    fn(3, { favIconUrl: "https://a.test/f.ico" }, { id: 3, url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true });

    expect(seen).toEqual([{ status: undefined }]);
  });
});

describe("realClock", () => {
  it("schedules through the platform timer", async () => {
    let fired = false;
    realClock.setTimeout(() => { fired = true; }, 0);
    await new Promise((r) => setTimeout(r, 1));
    expect(fired).toBe(true);
  });

  // Wall clock on purpose: a stored deadline is compared against it after a restart a
  // monotonic counter would not have been running for.
  it("reads wall-clock time", () => {
    const before = Date.now();
    const now = realClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
