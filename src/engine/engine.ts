import { resolve } from "../resolver/resolve";
import type { Config, ContainerRef, Deps, NavContext, Target } from "../resolver/types";
import type { BrowserPort, Tab, WebRequestDetails } from "./port";
import { createRegistry, type ContainerRegistry } from "./registry";

export const MAC_ID = "@testpilot-containers";

export interface Engine {
  // The F1-guarded reopen effect. Reopens `tab`'s `url` into `target`, preserving
  // placement (index/active/opener), and leaves the reopened tab's whole navigation
  // alone via the `reopenedNav` guard. Throws on failure (callers react).
  reopen(tab: Tab, url: string, target: Target): Promise<void>;
}

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

// F7: a truthy getAssignment result means MAC owns this URL and we back off.
async function macOwns(port: BrowserPort, url: string): Promise<boolean> {
  try {
    const a = await port.sendExternalMessage(MAC_ID, { method: "getAssignment", url });
    return a != null;
  } catch {
    return false; // MAC absent ⇒ nobody else owns it
  }
}

async function buildNavContext(
  d: WebRequestDetails,
  tab: Tab,
  registry: ContainerRegistry,
  port: BrowserPort
): Promise<NavContext> {
  // A pre-commit tab ("about:blank" until its navigation commits, "" when brand new)
  // reports no `current` even though its container is known: what the disposable path
  // needs is the site the tab was ON, and that is genuinely unknown here. Reporting
  // the container instead would keep a middle-clicked link in its opener's throwaway.
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

export function createEngine(opts: EngineOptions): Engine {
  const { port, config, deps, onChoice } = opts;
  const registry = createRegistry(port, opts.tmpSuffix ?? defaultSuffix());
  const handled = new Set<string>();
  // The navigation each tab we reopened is still performing: tabId -> the requestId
  // once its first request arrives, or null until then. That whole navigation must be
  // left alone: in a real browser onBeforeRequest fires before the new tab's url
  // commits, so it still reads as about:blank and resolve() cannot tell it is already
  // correctly contained — without this it would reopen forever (F1).
  //
  // Tracking the requestId, not just "the first request", is what makes the guard
  // cover a REDIRECT CHAIN: every hop reuses the requestId and the tab stays
  // pre-commit throughout, so a one-shot guard let hop 2 look like an unrouted
  // navigation and bought it another throwaway (tmp2 -> tmp3 on a single click).
  // Keying on the requestId also keeps the guard off tabs we did NOT route: a
  // middle-clicked link inherits its opener's container and is pre-commit too, and
  // it must still be isolated into a throwaway of its own.
  const reopenedNav = new Map<number, string | null>();

  // The F1-guarded reopen effect. Shared by the engine's own `case "reopen"` and the
  // picker (choice screen / reopen picker). Throws on failure — callers decide whether
  // to swallow (the engine's request-time path clears `handled` and fails open) or to
  // surface the result (the picker reports {ok:false} to the choice page).
  async function reopen(tab: Tab, url: string, target: Target): Promise<void> {
    const store = await registry.toStoreId(target);
    const created = await port.createTab({
      url,
      cookieStoreId: store,
      index: tab.index,
      active: tab.active,
      openerTabId: tab.openerTabId,
    });
    reopenedNav.set(created.id, null); // leave its whole navigation alone (see 1b)
    await port.removeTab(tab.id);
  }

  port.onBeforeRequest(async (d) => {
    // (0) Scope: only top-level http(s) navigations.
    if (d.type !== "main_frame") return;
    if (!/^https?:/.test(d.url)) return;

    // (1) F1 loop guard — re-fires of a request we already acted on.
    const key = d.requestId + "+" + d.url;
    if (handled.has(key)) return { cancel: true };

    // (1b) F1 loop guard — the navigation we reopened this tab to perform, from its
    // first request through every redirect hop of it.
    if (reopenedNav.has(d.tabId)) {
      const ours = reopenedNav.get(d.tabId);
      if (ours == null) {
        reopenedNav.set(d.tabId, d.requestId); // first request: this is the one
        return;
      }
      if (ours === d.requestId) return; // a hop of it — same navigation, still ours
      reopenedNav.delete(d.tabId); // a later navigation in that tab: route it normally
    }

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
        if (await macOwns(port, d.url)) return; // F7 defer
        handled.add(key);
        onChoice(decision.options, { tabId: d.tabId, url: d.url });
        return { cancel: true };

      case "reopen": {
        if (await macOwns(port, d.url)) return; // F7 defer
        handled.add(key); // guard BEFORE the async effects
        try {
          await reopen(tab, d.url, decision.into);
        } catch (e) {
          handled.delete(key); // fail open — allow a retry
          console.warn("[engine] reopen failed", e);
          return; // do NOT cancel
        }
        return { cancel: true };
      }
    }
  });

  return { reopen };
}
