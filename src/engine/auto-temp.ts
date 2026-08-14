import { TMP_PREFIX } from "./registry";
import { supersede } from "./supersede";
import type { BrowserPort, Tab } from "./port";

function defaultSuffix(): () => string {
  let n = 0;
  return () => String(++n);
}

export interface AutoTempOptions {
  port: BrowserPort;
  tmpSuffix?: () => string;
}

function isAutoTempCandidate(tab: Tab): boolean {
  if (tab.cookieStoreId !== "firefox-default") return false;
  return tab.url === "about:newtab" || tab.url === "about:home";
}

// Listens on tabs.onCreated / tabs.onUpdated and immediately reopens
// about:newtab / about:home tabs (which start in firefox-default) into a fresh
// temporary container. Mirrors TCP's `maybeReopenInTmpContainer` automatic-mode
// path. We listen on BOTH events because a tab's url is not final at onCreated.
//
// about:blank is deliberately NOT a candidate, and the reason is crucial: in
// Firefox a tab reads as about:blank for its whole pre-commit life, so a tab that is
// on its way to a real page is indistinguishable from a genuinely blank one. Observed
// event stream for `tabs.create({ url: "http://…" })` with no container:
//   onCreated  url="about:blank"  csid="firefox-default"
//   onUpdated  url="about:blank"  csid="firefox-default"
//   onUpdated  url="http://…"     <- the url only appears here
// Treating about:blank as a candidate would destroy that tab (containerize removes
// the original) before its navigation ever commits, so target=_blank links,
// window.open, and the engine's own reopens would silently open an empty new tab
// instead of the page. Known cost: a user who has disabled the new-tab page
// (browser.newtabpage.enabled=false) gets about:blank on Ctrl+T and is not
// auto-containerized. TCP has the same limitation.
export function createAutoTemp(opts: AutoTempOptions): void {
  const { port } = opts;
  const suffix = opts.tmpSuffix ?? defaultSuffix();
  const processed = new Set<number>();
  let creating = false;

  async function containerize(tab: Tab): Promise<void> {
    const ci = await port.createIdentity({
      name: TMP_PREFIX + suffix(),
      color: "blue",
      icon: "circle",
    });
    // Placement is `supersede`'s, not ours — window, index, active and openerTabId
    // all come from the tab being taken over, and a candidate here is always an
    // about: page, so it takes supersede's replace branch (create, then remove the
    // original). This was a hand-rolled second copy of that rule until it was folded
    // in; the same duplication had already drifted once in the picker.
    //
    // No url on purpose. Firefox refuses `tabs.create({ url: "about:newtab" })`
    // ("Illegal URL") — and about:home likewise — so passing the tab's own url here
    // made every containerize throw *after* the tmp identity was created: orphan tmp
    // containers, tab never moved. Omitting url gives the user's real new-tab page,
    // which is what we want anyway. TCP does the same (it passes url only when it
    // matches /^https?:/).
    await supersede(port, tab, { cookieStoreId: ci.cookieStoreId });
  }

  // Startup sweep: containerize pre-existing about:newtab / about:home tabs
  // that were opened before the extension loaded (most commonly the first tab).
  void (async () => {
    try {
      const tabs = await port.queryTabs({});
      for (const tab of tabs) {
        if (!isAutoTempCandidate(tab)) continue;
        if (processed.has(tab.id)) continue;
        processed.add(tab.id);
        await containerize(tab);
      }
    } catch (e) {
      console.warn("[auto-temp] startup sweep failed", e);
    }
  })();

  // Event listeners for future tabs.
  function maybeAutoTemp(tab: Tab): void {
    if (creating) return;
    if (processed.has(tab.id)) return;
    if (!isAutoTempCandidate(tab)) return;

    processed.add(tab.id);
    creating = true;
    void (async () => {
      try {
        await containerize(tab);
      } catch (e) {
        console.warn("[auto-temp] failed", e);
      } finally {
        creating = false;
      }
    })();
  }

  port.onTabCreated(maybeAutoTemp);
  port.onTabUpdated((tab) => maybeAutoTemp(tab));
}
