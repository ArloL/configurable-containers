import type {
  BrowserPort, ContextualIdentity, CreateIdentityProps, CreateTabProps, Tab, WebRequestDetails,
} from "./port";

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
        return {
          id: t.id!, url: t.url ?? "", cookieStoreId: t.cookieStoreId ?? "firefox-default",
          index: t.index, active: t.active, openerTabId: t.openerTabId,
        };
      } catch {
        return null; // tab gone — engine treats as fail-open
      }
    },

    async createTab(p: CreateTabProps): Promise<Tab> {
      const t = await browser.tabs.create({
        url: p.url, cookieStoreId: p.cookieStoreId,
        index: p.index, active: p.active, openerTabId: p.openerTabId,
      });
      return {
        id: t.id!, url: t.url ?? p.url, cookieStoreId: t.cookieStoreId ?? p.cookieStoreId,
        index: t.index, active: t.active, openerTabId: t.openerTabId,
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
  };
}
