import type { Config, Deps } from "../resolver/types";
import type { BrowserPort } from "./port";
import { cookiesFor, parseCookieHeader, writeCookieHeader } from "../overlays/cookies";

export interface CookieSeederOptions {
  port: BrowserPort;
  config: Config;
  deps: Pick<Deps, "matchRule">;
}

// A sibling of the engine and disposer (wired at background.ts, not nested). Owns one
// blocking main_frame onBeforeSendHeaders listener. Mirrors TCP's maybeSetAndAddToHeader:
// set each configured cookie into the tab's OWN store (F11) and, if it isn't already on
// the wire, splice it into the outgoing Cookie header (F12). Never routes/moves a tab.
export function createCookieSeeder(opts: CookieSeederOptions): void {
  const { port, config, deps } = opts;

  port.onBeforeSendHeaders(async (d) => {
    if (d.type !== "main_frame") return;

    const specs = cookiesFor(d.url, config, deps.matchRule);
    if (specs.length === 0) return; // pure early-out — the common case, before any await

    const tab = await port.getTab(d.tabId);
    if (!tab) return; // tab raced away — fail open

    const store = tab.cookieStoreId;
    const jar = parseCookieHeader(d.requestHeaders);
    let changed = false;

    for (const c of specs) {
      await port.setCookie({ ...c, storeId: store }); // unconditional (TC parity), into the tab's own store
      if (jar[c.name] === (c.value ?? "")) continue; // already on the wire with this value
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
