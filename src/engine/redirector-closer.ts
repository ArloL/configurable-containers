import type { Config, Deps } from "../resolver/types";
import type { BrowserPort, Clock } from "./port";
import { isRedirectorUrl } from "../overlays/redirector";

const REDIRECTOR_DELAY_MS = 2000; // matches TCP's closeRedirectorTabs.delay

export interface RedirectorCloserOptions {
  port: BrowserPort;
  clock: Clock;
  config: Config;
  deps: Pick<Deps, "matchRule">;
  delayMs?: number;
}

// Mirrors TCP's maybeCloseRedirectorTab: when a tab finishes loading on a redirector domain,
// wait the delay, then close it — but ONLY if it is still on one. The re-check is the safety
// mechanism, not timer cancellation, so a tab that redirected onward in place is left alone
// (F12 conditional close).
export function createRedirectorCloser(opts: RedirectorCloserOptions): void {
  const { port, clock, config, deps, delayMs = REDIRECTOR_DELAY_MS } = opts;

  port.onTabUpdated((tab, info) => {
    if (info.status !== "complete") return;
    if (!/^https?:/.test(tab.url)) return;
    if (!isRedirectorUrl(tab.url, config, deps.matchRule)) return;

    const tabId = tab.id;
    clock.setTimeout(async () => {
      // Re-check: the tab may have redirected onward or been closed since.
      const current = await port.getTab(tabId);
      if (!current) return;
      if (!isRedirectorUrl(current.url, config, deps.matchRule)) return;
      await port.removeTab(tabId);
    }, delayMs);
  });
}
