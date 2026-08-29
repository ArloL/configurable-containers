import { TMP_PREFIX } from "../resolver/types";
import { supersede } from "./supersede";
import { DEFAULT_STORE_ID, type BrowserPort, type Tab } from "./port";

function defaultSuffix(): () => string {
  let n = 0;
  return () => String(++n);
}

export interface AutoTempOptions {
  port: BrowserPort;
  tmpSuffix?: () => string;
}

function isAutoTempCandidate(tab: Tab): boolean {
  if (tab.cookieStoreId !== DEFAULT_STORE_ID) return false;
  return tab.url === "about:newtab" || tab.url === "about:home";
}

// Reopens about:newtab / about:home tabs (which start in firefox-default) into a fresh
// temporary container, as TCP's `maybeReopenInTmpContainer` does. Listens on BOTH
// tabs.onCreated and tabs.onUpdated, because a tab's url is not final at onCreated:
//   onCreated  url="about:blank"  csid=DEFAULT_STORE_ID
//   onUpdated  url="about:blank"  csid=DEFAULT_STORE_ID
//   onUpdated  url="http://…"     <- the url only appears here
//
// about:blank is deliberately NOT a candidate: a tab reads as about:blank for its whole
// pre-commit life, so one on its way to a real page looks identical to a blank one, and
// containerizing it removes the original before the navigation commits — target=_blank
// links, window.open and CC's own reopens would all open an empty tab instead of the page.
// Cost: with the new-tab page disabled (browser.newtabpage.enabled=false) Ctrl+T gives
// about:blank and is not containerized. TCP has the same limitation.
export function createAutoTemp(opts: AutoTempOptions): void {
  const { port } = opts;
  const suffix = opts.tmpSuffix ?? defaultSuffix();
  const processed = new Set<number>();

  async function containerize(tab: Tab): Promise<void> {
    const ci = await port.createIdentity({
      name: TMP_PREFIX + suffix(),
      color: "blue",
      icon: "circle",
    });
    // Placement is `supersede`'s: window, index, active and openerTabId come from the tab
    // being taken over, and a candidate is always about:newtab or about:home, both of which
    // `supersede` lists among the pages with nothing to lose, so it takes the replace
    // branch. Keep the two in step. This used to be a hand-rolled copy of that rule; the
    // same duplication had already drifted once in the picker.
    //
    // No url on purpose. Firefox rejects `tabs.create({ url: "about:newtab" })` ("Illegal
    // URL"), and about:home too, so passing the tab's own url made every containerize throw
    // AFTER creating the identity: orphan tmp containers, tab never moved. Omitting url
    // gives the user's real new-tab page anyway, as TCP does.
    await supersede(port, tab, { cookieStoreId: ci.cookieStoreId });
  }

  // Tabs opened before the extension loaded, usually the window's first.
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

  // `processed` is the WHOLE guard, and it is per tab because that is what the invariant is:
  // containerize each candidate tab once. There used to be a module-wide `creating` boolean
  // in front of it, checked before `processed.add`, and it was a mutex over an invariant that
  // is not global — a second about:newtab arriving while the first was parked on
  // `createIdentity` was dropped entirely, neither containerized nor recorded, so nothing
  // retried it. Two Ctrl+T in quick succession is the shape.
  //
  // What it looked like it was preventing — the replacement tab being containerized again —
  // is not reachable: `supersede` creates that tab in the tmp container just minted, and
  // `isAutoTempCandidate` rejects any tab whose cookieStoreId is not firefox-default. The
  // double-event case (bug 1586612, onCreated then onUpdated for one tab) is `processed`'s.
  // Do not reintroduce it per tab either: a per-tab flag is `processed` again.
  function maybeAutoTemp(tab: Tab): void {
    if (processed.has(tab.id)) return;
    if (!isAutoTempCandidate(tab)) return;

    processed.add(tab.id);
    void (async () => {
      try {
        await containerize(tab);
      } catch (e) {
        console.warn("[auto-temp] failed", e);
      }
    })();
  }

  port.onTabCreated(maybeAutoTemp);
  port.onTabUpdated((tab) => maybeAutoTemp(tab));
}
