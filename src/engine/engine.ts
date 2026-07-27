import { resolve } from "../resolver/resolve";
import type { Config, ContainerRef, Deps, NavContext } from "../resolver/types";
import type { BrowserPort, Tab, WebRequestDetails } from "./port";
import { createRegistry, type ContainerRegistry } from "./registry";

export const MAC_ID = "@testpilot-containers";

export interface EngineOptions {
  port: BrowserPort;
  config: Config;
  deps: Deps;
  onChoice: (options: string[], nav: { tabId: number; url: string }) => void;
  tmpSuffix?: () => string;
}

function defaultSuffix(): () => string {
  let n = 0;
  return () => String(++n);
}

async function buildNavContext(
  d: WebRequestDetails,
  tab: Tab,
  registry: ContainerRegistry,
  port: BrowserPort
): Promise<NavContext> {
  const current =
    tab.url && tab.url !== "about:blank"
      ? { url: tab.url, container: await registry.toRef(tab.cookieStoreId) }
      : null;

  let initiator: ContainerRef | null;
  if (tab.openerTabId != null) {
    const opener = await port.getTab(tab.openerTabId);
    initiator = opener ? await registry.toRef(opener.cookieStoreId) : null;
  } else {
    initiator = current ? current.container : null;
  }

  return { targetUrl: d.url, current, initiator };
}

export function createEngine(opts: EngineOptions): void {
  const { port, config, deps, onChoice } = opts;
  const registry = createRegistry(port, opts.tmpSuffix ?? defaultSuffix());
  const handled = new Set<string>();

  // onChoice is wired in Task 4 (choice emission); referenced here to keep the
  // option in use while the choice branch is still a no-op.
  void onChoice;

  port.onBeforeRequest(async (d) => {
    // (0) Scope: only top-level http(s) navigations.
    if (d.type !== "main_frame") return;
    if (!/^https?:/.test(d.url)) return;

    // (1) F1 loop guard — re-fires of a request we already acted on.
    const key = d.requestId + "+" + d.url;
    if (handled.has(key)) return { cancel: true };

    // (2) Assemble NavContext.
    const tab = await port.getTab(d.tabId);
    if (!tab) return; // tab raced away — fail open
    const nav = await buildNavContext(d, tab, registry, port);

    // (3) Pure decision.
    const decision = resolve(nav, config, deps);

    // (4) Effects.
    switch (decision.kind) {
      case "leaveAlone":
      case "stay":
        return;

      case "choice":
        // F7 gate + emit are added in Task 4; no-op for now.
        return;

      case "reopen": {
        handled.add(key); // guard BEFORE the async effects
        try {
          const store = await registry.toStoreId(decision.into);
          await port.createTab({
            url: d.url,
            cookieStoreId: store,
            index: tab.index,
            active: tab.active,
            openerTabId: tab.openerTabId,
          });
          await port.removeTab(tab.id);
        } catch (e) {
          handled.delete(key); // fail open — allow a retry
          console.warn("[engine] reopen failed", e);
          return; // do NOT cancel
        }
        return { cancel: true };
      }
    }
  });
}
