import type { BrowserPort, Tab } from "./port";

export interface SupersedeProps {
  // Omit for the browser's own new-tab page (Firefox rejects an explicit "about:newtab" —
  // see CreateTabProps.url).
  url?: string;
  cookieStoreId: string;
}

// The pages that hold nothing a user would miss. This is an ALLOW-LIST for replacing, not a
// test for "not a website": the rule used to be `/^https?:/`, which swept CC's own options
// page in with the blanks and destroyed a half-written config whenever the editor's tab was
// navigated — the text lives in a textarea and is not in storage until Save, and since the
// tab is removed rather than kept there is no back button either.
//
// Being an allow-list, it has to stay complete: a page Firefox parks a fresh tab on that is
// missing here is kept, and keeping a blank tab strands an empty one beside every link
// opened in a new tab. Each entry earns its place —
//
//   ""                      Tab.url is documented as `"" / about:blank for a fresh tab`
//   about:blank             every pre-commit tab: middle-click, target=_blank, window.open
//   about:newtab/home       the new-tab page, and exactly what auto-temp containerizes
//   about:privatebrowsing   the same page in a private window
//
const EMPTY_PAGES = new Set(["", "about:blank", "about:newtab", "about:home", "about:privatebrowsing"]);

// The choice page is the one CC page that must be replaced: picking a container IS this
// page being navigated away, so keeping it strands the picker beside the tab it just
// opened. Matched by prefix because it carries its payload in a fragment.
function hasNothingToLose(port: BrowserPort, url: string): boolean {
  if (EMPTY_PAGES.has(url)) return true;
  // Only one of our own pages can match, and every port call is on the blocking path's
  // round-trip budget (test/fitness/decision-cost.test.ts counts them all, round trip or
  // not). Ordinary navigations — the overwhelming majority — leave here without one.
  return url.startsWith("moz-extension://") && url.startsWith(port.getURL("choice.html"));
}

// Open a tab that takes over from `source`, in the window `source` is actually in.
//
// A source tab showing anything of its own is KEPT (the caller cancels its navigation) and
// the new tab opens right after it, as MAC does (assignManager.js, `removeTab`): session
// history does not span containers, so replacing it would destroy what the user was looking
// at with no way back. A tab on one of the pages above is replaced instead — required, not
// merely harmless: keeping them strands an empty tab beside every link opened in a new tab.
//
// `windowId` matters for the same reason `index` does: a window.open popup is pre-commit,
// so it takes the replace branch, and without its window the replacement lands in the last
// focused normal window and the popup closes. It also stops a reopen in an unfocused window
// from teleporting to the focused one.
//
// `onCreated` runs between the create and the removal, so a caller can register guard state
// (the engine's `reopenedNav`) before the old tab goes away.
export async function supersede(
  port: BrowserPort,
  source: Tab,
  props: SupersedeProps,
  onCreated?: (created: Tab) => void
): Promise<Tab> {
  const keep = !hasNothingToLose(port, source.url);

  const created = await port.createTab({
    // Spread, not `url: props.url`: "no url" has to reach Firefox as a create call with no
    // url in it (CreateTabProps.url). That an explicit `undefined` happens to be tolerated
    // is not something to build the new-tab path on.
    ...(props.url === undefined ? {} : { url: props.url }),
    cookieStoreId: props.cookieStoreId,
    windowId: source.windowId,
    index: keep ? source.index + 1 : source.index,
    active: source.active,
    openerTabId: keep ? source.id : source.openerTabId,
  });
  onCreated?.(created);
  if (!keep) await port.removeTab(source.id);
  return created;
}
