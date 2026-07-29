import type {
  BrowserPort, Clock, ContextualIdentity, CreateIdentityProps, CreateTabProps, RegisteredContentScript, Tab, TabUpdateInfo, WebRequestDetails,
} from "./port";

function mapTab(t: browser.tabs.Tab): Tab {
  return {
    id: t.id!,
    url: t.url ?? "",
    cookieStoreId: t.cookieStoreId ?? "firefox-default",
    index: t.index,
    active: t.active,
    openerTabId: t.openerTabId,
    windowId: t.windowId!,
  };
}

// The extension id the harness build echoes notifications to, so an e2e can observe a
// toast that lives in no DOM. "" in every shipped build, which esbuild folds away.
declare const __CC_NOTIFY_ECHO_TO__: string;

// Counter behind the userScripts registration ids in registerContentScript below.
let userScriptSeq = 0;

// Real BrowserPort over browser.*. Mechanical, logic-free — all decisions come from
// resolve() inside the engine. The only Firefox-specific note: a blocking
// onBeforeRequest listener may return a Promise<BlockingResponse>, which Firefox
// awaits before the request proceeds.
export function createBrowserPort(): BrowserPort {
  return {
    onBeforeRequest(handler) {
      browser.webRequest.onBeforeRequest.addListener(
        (d) =>
          handler({
            requestId: d.requestId, tabId: d.tabId, url: d.url, type: d.type,
            method: d.method, originUrl: d.originUrl, documentUrl: d.documentUrl,
          }).then((r) => r ?? {}), // void -> empty response (proceed)
        { urls: ["<all_urls>"], types: ["main_frame"] },
        ["blocking"]
      );
    },

    async getTab(tabId): Promise<Tab | null> {
      try {
        const t = await browser.tabs.get(tabId);
        return mapTab(t);
      } catch {
        return null; // tab gone — engine treats as fail-open
      }
    },

    async createTab(p: CreateTabProps): Promise<Tab> {
      const t = await browser.tabs.create({
        url: p.url, cookieStoreId: p.cookieStoreId, windowId: p.windowId,
        index: p.index, active: p.active, openerTabId: p.openerTabId,
      });
      return {
        id: t.id!, url: t.url ?? p.url ?? "", cookieStoreId: t.cookieStoreId ?? p.cookieStoreId,
        index: t.index, active: t.active, openerTabId: t.openerTabId,
        windowId: t.windowId!,
      };
    },

    async removeTab(tabId) {
      await browser.tabs.remove(tabId);
    },

    async queryIdentities(): Promise<ContextualIdentity[]> {
      return (await browser.contextualIdentities.query({})).map((c) => ({
        cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon,
      }));
    },

    async createIdentity(p: CreateIdentityProps): Promise<ContextualIdentity> {
      const c = await browser.contextualIdentities.create({ name: p.name, color: p.color, icon: p.icon });
      return { cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon };
    },

    async getIdentity(cookieStoreId): Promise<ContextualIdentity | null> {
      try {
        const c = await browser.contextualIdentities.get(cookieStoreId);
        return { cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon };
      } catch {
        return null; // firefox-default or a removed container — registry treats as default
      }
    },

    sendExternalMessage(extensionId, message) {
      return browser.runtime.sendMessage(extensionId, message);
    },

    onTabCreated(handler) {
      browser.tabs.onCreated.addListener((t) => handler(mapTab(t)));
    },

    onTabRemoved(handler) {
      browser.tabs.onRemoved.addListener((tabId) => handler(tabId));
    },

    onTabUpdated(handler) {
      browser.tabs.onUpdated.addListener((_id, info, tab) => {
        const status = info.status === "loading" || info.status === "complete" ? info.status : undefined;
        handler(mapTab(tab), { status });
      });
    },

    async queryTabs(filter) {
      return (await browser.tabs.query(filter)).map(mapTab);
    },

    async removeIdentity(cookieStoreId) {
      try {
        await browser.contextualIdentities.remove(cookieStoreId);
      } catch {
        /* already gone — fine */
      }
    },

    onBeforeSendHeaders(handler) {
      browser.webRequest.onBeforeSendHeaders.addListener(
        (d) =>
          handler({
            requestId: d.requestId, tabId: d.tabId, url: d.url, type: d.type,
            requestHeaders: d.requestHeaders ?? [],
          }).then((r) => r ?? {}), // void -> empty response (proceed)
        { urls: ["<all_urls>"], types: ["main_frame"] },
        ["blocking", "requestHeaders"]
      );
    },

    async setCookie(details) {
      await browser.cookies.set(details);
    },

    async getCookie(details) {
      const c = await browser.cookies.get(details);
      return c ? { name: c.name, value: c.value } : null;
    },

    // MV3 removed contentScripts.register (addons-linter: UNSUPPORTED_API), and its
    // successor scripting.registerContentScripts takes FILE paths only — there is no
    // inline-code form, so it cannot carry a `run:` string out of the user's config.
    // userScripts is the one MV3 API that still accepts code, which is what it exists
    // for. Two deliberate consequences:
    //   - The default world is USER_SCRIPT, not the extension's content-script world.
    //     Same DOM, separate JS globals, and a CSP that forbids eval. The overlay only
    //     ever needed page DOM (F11 is unaffected: still no cookieStoreId, so the script
    //     runs wherever the URL loads), and user-supplied code has no business holding
    //     extension-adjacent privileges.
    //   - Registrations now need an `id`. It is ours to generate and must be stable
    //     enough to unregister by; the injector registers once per startup, so a
    //     per-call counter is sufficient and collision-free within a session.
    async registerContentScript(details): Promise<RegisteredContentScript> {
      // "userScripts" is an OptionalOnlyPermission in Firefox: it cannot sit in
      // `permissions`, so at startup we may simply not have it. Registering without it
      // throws, and this runs inside background.ts's floated async tail where a throw
      // would be swallowed — so check first and fail LOUDLY but harmlessly, leaving the
      // rest of routing untouched. Asking for it needs a user gesture, which a
      // background script does not have; that request belongs on the options page.
      if (!(await browser.permissions.contains({ permissions: ["userScripts"] }))) {
        console.error(
          "[cc] the config declares scripts: overlays, but the \"userScripts\" permission " +
            "has not been granted — no scripts were injected. Grant it in the add-on's " +
            "preferences.",
        );
        return { unregister: () => Promise.resolve() };
      }
      const id = `cc-${++userScriptSeq}`;
      await browser.userScripts.register([
        {
          id,
          matches: details.matches,
          js: details.js.map((s) => ({ code: s.code })),
          runAt: details.runAt,
        },
      ]);
      return { unregister: () => browser.userScripts.unregister({ ids: [id] }) };
    },

    onMessage(handler) {
      browser.runtime.onMessage.addListener((msg, sender) => handler(msg, { tabId: sender.tab?.id }) as never);
    },

    onCommand(handler) {
      browser.commands.onCommand.addListener((name) => handler(name));
    },

    async getActiveTab(): Promise<Tab | null> {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const t = tabs[0];
      return t ? mapTab(t) : null;
    },

    getURL(path) {
      return browser.runtime.getURL(path);
    },

    async notify(n) {
      await browser.notifications.create({ type: "basic", title: n.title, message: n.message });
      // AFTER the create resolves, never before: a missing "notifications" permission
      // must make the e2e assertion fail, not pass with the notification broken.
      // `!== ""` rather than a bare truthiness check so esbuild folds the condition to
      // a literal `false` in shipped bundles — the build does not minify (an AMO
      // reviewer reads this file), so the branch itself survives either way, and
      // `if (false)` is the readable proof that it is dead.
      if (__CC_NOTIFY_ECHO_TO__ !== "") {
        await browser.runtime.sendMessage(__CC_NOTIFY_ECHO_TO__, { cmd: "cc-notification", ...n });
      }
    },

    async readStored(key) {
      return (await browser.storage.local.get(key))[key];
    },

    async writeStored(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
  };
}

// Production clock: schedules on the extension's global timer (return value unused).
// `now` is wall-clock on purpose — a stored deadline is compared against it after a
// background restart that a monotonic counter would not have been running for.
export const realClock: Clock = {
  setTimeout: (fn, ms) => {
    globalThis.setTimeout(fn, ms);
  },
  now: () => Date.now(),
};
