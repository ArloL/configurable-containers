import type { Config, Deps } from "../resolver/types";
import type { BrowserPort } from "./port";
import { cookiesFor, parseCookieHeader, writeCookieHeader } from "../overlays/cookies";

export interface CookieSeederOptions {
  port: BrowserPort;
  config: Config;
  deps: Pick<Deps, "matchRule">;
}

// Mirrors TCP's maybeSetAndAddToHeader: set each configured cookie into the tab's OWN store
// (F11) and, unless it is already on the wire, splice it into the outgoing Cookie header
// (F12). Never moves a tab.
export function createCookieSeeder(opts: CookieSeederOptions): void {
  const { port, config, deps } = opts;

  port.onBeforeSendHeaders(async (d) => {
    if (d.type !== "main_frame") return;

    const specs = cookiesFor(d.url, config, deps.matchRule);
    if (specs.length === 0) return; // before any await, so the common case costs nothing

    const tab = await port.getTab(d.tabId);
    if (!tab) return; // tab raced away — fail open

    const store = tab.cookieStoreId;
    const jar = parseCookieHeader(d.requestHeaders);
    let changed = false;

    for (const c of specs) {
      await port.setCookie({ ...c, storeId: store }); // unconditional, for TC parity
      if (jar[c.name] === (c.value ?? "")) continue;
      const got = await port.getCookie({ name: c.name, url: d.url, storeId: store });
      if (got) {
        jar[got.name] = got.value;
        changed = true;
      }
    }

    if (!changed) return;
    return { requestHeaders: writeCookieHeader(d.requestHeaders, jar) };
  });
}
