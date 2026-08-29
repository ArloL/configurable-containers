import { describeDecision } from "../resolver/decision-label";
import { DEFAULT_STORE_ID } from "./port";
import type {
  BrowserPort, Clock, ContextualIdentity, CreateIdentityProps, CreateTabProps, RegisteredContentScript, Tab,
} from "./port";

function mapTab(t: browser.tabs.Tab): Tab {
  return {
    id: t.id!,
    url: t.url ?? "",
    cookieStoreId: t.cookieStoreId ?? DEFAULT_STORE_ID,
    index: t.index,
    active: t.active,
    openerTabId: t.openerTabId,
    windowId: t.windowId!,
  };
}

// The extension id the harness build echoes notifications to, so an e2e can observe a toast
// that lives in no DOM. "" in every shipped build, which esbuild folds away.
declare const __CC_NOTIFY_ECHO_TO__: string;

// The same, one level up: the id a test build echoes DECISIONS to, so an e2e can read what
// CC decided rather than inferring it from the tab that did or did not appear. "" in every
// shipped build.
//
// A second define is the honest price of this, and it is a second rather than a first —
// `launch()` already sets the notify echo unconditionally, so no test build has ever been
// byte-equivalent to a packaged one. What matters is the other rule: this is READ-ONLY.
// CLAUDE.md forbids a build-time seed that ARMS a container, because that would make the
// shipped extension capable of starting up with routing disabled; an echo changes no routing
// and can only describe what already happened.
declare const __CC_DECISION_ECHO_TO__: string;

// Keep this logic-free: every decision belongs in resolve() or the engine. One Firefox
// note — a blocking onBeforeRequest listener may return a Promise<BlockingResponse>, which
// Firefox awaits before the request proceeds.
export function createBrowserPort(): BrowserPort {
  // Set once on first use, not at construction: the colour never changes, but constructing
  // the port must stay free of browser.* calls, or any caller that has not stubbed
  // browserAction breaks.
  let badgeColoured = false;

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

    onBeforeNavigate(handler) {
      browser.webNavigation.onBeforeNavigate.addListener((d) =>
        handler({ tabId: d.tabId, frameId: d.frameId, url: d.url })
      );
    },

    async getTab(tabId): Promise<Tab | null> {
      try {
        const t = await browser.tabs.get(tabId);
        return mapTab(t);
      } catch {
        return null; // gone — the engine fails open
      }
    },

    async createTab(p: CreateTabProps): Promise<Tab> {
      const t = await browser.tabs.create({
        // `url` is spread in only when there is one: see supersede().
        ...(p.url === undefined ? {} : { url: p.url }),
        cookieStoreId: p.cookieStoreId, windowId: p.windowId,
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

    async registerContentScript(details): Promise<RegisteredContentScript> {
      const reg = await browser.contentScripts.register(details);
      return { unregister: () => reg.unregister() };
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
      // AFTER the create resolves, never before: a missing "notifications" permission must
      // fail the e2e, not pass with the toast broken. `!== ""` rather than bare truthiness so
      // esbuild folds this to a literal `false` in shipped bundles — the build does not
      // minify (an AMO reviewer reads this file), so `if (false)` is readable proof the
      // branch is dead.
      /* v8 ignore else -- the else IS the shipped build, and no run that measures coverage
         has it: the identifier is a compile-time constant, so the two arms belong to two
         different bundles rather than two paths through one. `test/extension/package.test.ts`
         is what pins the shipped side, asserting the packaged bundle contains `if (false)`
         and not the probe's id. */
      if (__CC_NOTIFY_ECHO_TO__ !== "") {
        await browser.runtime.sendMessage(__CC_NOTIFY_ECHO_TO__, { cmd: "cc-notification", ...n });
      }
    },

    echoDecision(e) {
      /* v8 ignore else -- the else IS the shipped build, and no run that measures coverage
         has it: the identifier is a compile-time constant, so the two arms belong to two
         different bundles rather than two paths through one, exactly as `notify`'s echo
         does. `test/extension/package.test.ts` pins the shipped side. */
      if (__CC_DECISION_ECHO_TO__ !== "") {
        // Floated, never awaited, and the formatting happens INSIDE the guard: the caller is
        // the blocking handler, so neither the message nor the words it carries may cost a
        // shipped navigation anything. A rejected send (no probe installed) is swallowed for
        // the same reason a failed toast is — saying what happened must not change it.
        void browser.runtime
          .sendMessage(__CC_DECISION_ECHO_TO__, {
            cmd: "cc-decision",
            url: e.url,
            method: e.method,
            tabId: e.tabId,
            decision: e.decision ? describeDecision(e.decision) : null,
            outcome: e.outcome,
          })
          .catch(() => {});
      }
    },

    onActionClicked(handler) {
      browser.browserAction.onClicked.addListener((tab) => handler(mapTab(tab)));
    },

    async setBadge(text) {
      if (!badgeColoured) {
        badgeColoured = true;
        await browser.browserAction.setBadgeBackgroundColor({ color: "#c1361a" });
      }
      await browser.browserAction.setBadgeText({ text });
    },

    async readStored(key) {
      return (await browser.storage.local.get(key))[key];
    },

    async writeStored(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
  };
}

// `now` is wall-clock on purpose: a stored deadline is compared against it after a restart
// a monotonic counter would not have been running for.
export const realClock: Clock = {
  setTimeout: (fn, ms) => {
    globalThis.setTimeout(fn, ms);
  },
  now: () => Date.now(),
};
