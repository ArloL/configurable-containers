import type { BrowserPort, Tab } from "./port";

export interface SupersedeProps {
  // Omit for the browser's own new-tab page (Firefox rejects an explicit "about:newtab" —
  // see CreateTabProps.url).
  url?: string;
  cookieStoreId: string;
}

// Open a tab that takes over from `source`, in the window `source` is actually in.
//
// A source tab that is ON a page is KEPT (the caller cancels its navigation) and the new
// tab opens right after it, as MAC does (assignManager.js, `removeTab`): session history
// does not span containers, so replacing it would destroy what the user was reading with no
// way back.
//
// A tab with nothing to lose — a new-tab page, the choice page, a tab pre-commit on
// about:blank, which is what a middle-clicked or target=_blank link is — is replaced. That
// is required, not merely harmless: keeping them strands an empty tab beside every link
// opened in a new tab.
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
  const keep = /^https?:/.test(source.url);

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
