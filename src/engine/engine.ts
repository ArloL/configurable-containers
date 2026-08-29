import { resolve } from "../resolver/resolve";
// Saying a decision in words is the resolver's, not the engine's: the pause record and the
// F9 toast must use one wording, and pause.ts reaching up here for it was the only edge
// that made the pause module — and the options bundle behind it — depend on the engine.
import { namesAConfiguredContainer, targetLabel, type Declinable } from "../resolver/decision-label";
import type { Config, ContainerRef, Decision, Deps, NavContext, Target } from "../resolver/types";
import type { BlockingResponse, BrowserPort, RecordedNav, Tab, WebRequestDetails } from "./port";
import { createRegistry, type ContainerRegistry } from "./registry";
import { supersede } from "./supersede";

export const MAC_ID = "@testpilot-containers";

export interface Engine {
  // Placement is `supersede`'s; `reopenedNav` then leaves the new tab's navigation alone
  // (F1). Throws, so callers decide whether to fail open.
  reopen(tab: Tab, url: string, target: Target): Promise<void>;
}

// The pause seam, synchronous by contract: `isPaused` runs inside the blocking webRequest
// handler, where an await would cost every navigation latency, and `record` returns void so
// a navigation never waits on bookkeeping. Required, not optional: a mock forgets to set an
// optional field and coverage stops silently.
export interface PauseRecorder {
  isPaused(cookieStoreId: string): boolean;
  record(cookieStoreId: string, nav: RecordedNav, decision: Decision): void;
}

export interface EngineOptions {
  port: BrowserPort;
  config: Config;
  deps: Deps;
  onChoice: (options: string[], nav: { tabId: number; url: string }) => void;
  pause: PauseRecorder;
  // Required, not optional. Auto-temp mints throwaways from a counter of its own, and the
  // two must be ONE counter or both start at tmp1 and collide on the name identity is
  // derived from. A default here is a second counter that nothing in the extension asks
  // for, and an optional field is one a caller forgets to pass.
  tmpSuffix: () => string;
}

// F7: a truthy getAssignment means MAC owns this URL, so we back off.
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
  port: BrowserPort,
  // The url a tab we reopened is mid-navigation to, on a redirect hop of that navigation.
  // Such a tab reads about:blank like any other pre-commit tab, but unlike one we know both
  // halves of `current`: the container is ours, and the page it stands for is the url we
  // opened the tab to load. Supplying it is what lets `resolve` answer "already correctly
  // contained" for a hop within one rule (github.com -> github.dev), instead of reopening a
  // tab into the container it is already in.
  guardedFrom?: string
): Promise<NavContext> {
  // A pre-commit tab ("about:blank", or "" when brand new) has no `current`, even though
  // its container is known: the disposable path needs the site the tab was ON, and that is
  // genuinely unknown here. Naming the container instead parks a middle-clicked link in its
  // opener's throwaway.
  const standsOn = tab.url && tab.url !== "about:blank" ? tab.url : guardedFrom;
  const current = standsOn ? { url: standsOn, container: await registry.toRef(tab.cookieStoreId) } : null;

  // Read once for both questions below, and only while the tab is pre-commit: after that
  // it is the stale pointer F14 is about.
  const opener = current === null && tab.openerTabId != null ? await port.getTab(tab.openerTabId) : null;

  // Which container did this navigation come FROM? The page the tab is on, whenever it has
  // one. The opener answers only while the tab has nothing of its own — a target=_blank or
  // middle-clicked link, pre-commit on about:blank.
  //
  // Asking the opener FIRST reads a tab the user left behind: `openerTabId` outlives the
  // click and `supersede` carries it across every reopen, so a routed tab points at one in a
  // different container. `inherit` sends the tab back there, the next reopen makes it the
  // opener again, and the tab alternates between two containers forever (F14).
  let initiator: ContainerRef | null;
  if (current) {
    initiator = current.container;
  } else {
    initiator = opener ? await registry.toRef(opener.cookieStoreId) : null;
  }

  // Which PAGE did this tab's container come from? Only the disposable path asks, so that
  // "open link in a new tab" answers like clicking in place: without it a new tab failed
  // every same-site and same-group comparison, so a video opened from a YouTube search
  // result landed in its own throwaway, logged out.
  //
  // Both conditions matter. The tab must really be IN the opener's container, since
  // `tabs.create` can name an opener in any container and CC's reopens do. And the opener
  // must be on http(s), because the disposable path reads a non-http url as "a throwaway
  // nobody has browsed in yet" and would park every middle-clicked link in it.
  const inheritedFrom =
    opener && initiator && opener.cookieStoreId === tab.cookieStoreId && /^https?:/.test(opener.url)
      ? { url: opener.url, container: initiator }
      : null;

  return { targetUrl: d.url, current, initiator, inheritedFrom };
}

async function containerLabel(port: BrowserPort, cookieStoreId: string): Promise<string> {
  const ci = await port.getIdentity(cookieStoreId);
  return ci ? ci.name : "the default container";
}

// May a redirect hop of a navigation we reopened a tab for be acted on?
//
// Only when it names a container of its own. A hop crossing to an unmatched site resolves,
// like any unmatched site, to a fresh throwaway — and one click must not buy one per hop:
// that is `tmp1 -> tmp2 -> tmp3` on a single redirect chain, the bug the requestId latch was
// added for. The user never sees an intermediate hop, so there is no browsing session there
// to isolate; there is only the one the tab was opened with.
//
// A configured container is the other case. The chain's destination is a page the user WILL
// see, and its rule says where that site's session lives — the SSO return hop
// (sonarcloud.io -> github.com/login/oauth -> back) landing in the identity provider's
// container, logged out, is what ignoring it costs. `temporary` is excluded whether it came
// from the disposable path or from an explicit `open: Temporary`: both mean "isolate from
// what came before", and within one navigation there is nothing yet to isolate from.
function aHopBuysNoThrowaway(decision: Decision): boolean {
  if (decision.kind === "choice") return false;
  return !(decision.kind === "reopen" && decision.into.kind !== "temporary");
}

export function createEngine(opts: EngineOptions): Engine {
  const { port, config, deps, onChoice, pause } = opts;
  const registry = createRegistry(port, opts.tmpSuffix);
  const handled = new Set<string>();
  // Hosts already warned about a declined non-GET. Lives as long as the background context,
  // which since a config save stopped restarting the extension means until the browser does:
  // one host per site that posted cross-container, which a long session prices in bytes.
  const warnedHosts = new Set<string>();
  // The navigation each tab we reopened is still performing: tabId -> the requestId once
  // its first request arrives, or the url we are waiting for until then. onBeforeRequest
  // fires before the new tab's url commits, so the tab still reads as about:blank and
  // resolve() cannot tell it is already correctly contained. Without this: reopens forever
  // (F1).
  //
  // Three details, each paid for by a bug:
  //   requestId, not "the first request" — a redirect chain reuses one requestId while the
  //     tab stays pre-commit, so a one-shot guard read hop 2 as unrouted (tmp2 -> tmp3 on
  //     one click). Keying on it also keeps the guard off tabs we did NOT route.
  //   the awaited url, not a bare "not yet" — a reopened tab whose request never arrives
  //     (load aborted, user typed elsewhere) would let the guard absorb the next navigation,
  //     leaving that site unrouted inside the container we reopened INTO.
  //   matched by site, not exact url — Firefox rewrites the url first on an HSTS upgrade.
  //
  // The site is kept alongside the requestId, because the two answer different halves of a
  // hop. A hop that stays on the awaited site is absorbed outright. A hop that LEAVES it is
  // still the same navigation, but it is also a different site arriving in a container that
  // was chosen for the old one, so it is resolved like any other navigation — with one thing
  // the engine adds on top, `aHopBuysNoThrowaway` below.
  const reopenedNav = new Map<number, { awaiting: string; requestId?: string }>();

  // Tabs whose pending top-level navigation is a `view-source:` load.
  //
  // "View Page Source" fetches the document it prints, so webRequest sees an ordinary
  // main_frame GET under the INNER url: `view-source:https://site/` arrives as plain
  // `https://site/`, tab still pre-commit on about:blank. Nothing says otherwise, so the
  // engine used to route it — dropping the `view-source:` wrapper (a reopen issues a plain
  // GET) and, the tab being pre-commit, replacing it. Ctrl+U destroyed its own tab and
  // rendered the page in a throwaway. MAC has the same bug open
  // (mozilla/multi-account-containers#2582).
  //
  // webNavigation is the one place the wrapped url is visible, and Firefox fires
  // onBeforeNavigate before that navigation's webRequest (measured in FF153, for the
  // view-source tab and every ordinary navigation beside it). So the mark is written there
  // and read, without an await, inside the blocking handler.
  //
  // Nothing expires it: the next top-level navigation in the tab overwrites it, and a
  // redirect of the view-source load keeps it, which that hop needs. A tab closed while
  // showing source leaks one integer — not worth a third listener on an event `pause` and
  // the disposer already share.
  const viewSourceNav = new Set<number>();

  // One top-level navigation at a time per tab.
  //
  // Deciding a navigation is a read-then-act across four awaits — `getTab`, the MAC
  // handshake, `createIdentity`, `createTab` — and Firefox can deliver a SECOND main_frame
  // request for the same tab inside that window. Run concurrently, both read the same
  // pre-commit `about:blank` tab, both decide "isolate into a throwaway", and one "Open Link
  // in New Tab" opens two tabs in two containers (F1: seen on YouTube and on links out of
  // daringfireball.net to x.com). `handled` cannot catch that pair — it keys on the
  // requestId, and these are two requestIds for one navigation.
  //
  // Serialised, the second is decided after `supersede` replaced the tab it belonged to, so
  // `getTab` returns null and it falls open. The ordering is the whole fix.
  //
  // Per TAB: one global queue would put an unrelated tab's navigation behind this one's MAC
  // roundtrip, which is latency in front of every navigation.
  const routing = new Map<number, Promise<unknown>>();

  async function inTurn<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const ahead = routing.get(tabId);
    const mine = ahead ? ahead.then(work) : work();
    // What the next request waits on swallows the outcome: a throw goes to ITS caller
    // (Firefox, which fails the navigation open) and must not take the next one down.
    const settled = mine.then(() => {}, () => {});
    routing.set(tabId, settled);
    try {
      return await mine;
    } finally {
      if (routing.get(tabId) === settled) routing.delete(tabId);
    }
  }

  port.onBeforeNavigate((d) => {
    if (d.frameId !== 0) return; // sub-frames are not routed at all
    if (d.url.startsWith("view-source:")) viewSourceNav.add(d.tabId);
    else viewSourceNav.delete(d.tabId);
  });

  // Shared by the engine's own `case "reopen"` and the picker. Throws on failure: the
  // engine's request path clears `handled` and fails open, the picker reports {ok:false}
  // to the choice page.
  async function reopen(tab: Tab, url: string, target: Target): Promise<void> {
    const store = await registry.toStoreId(target);
    await supersede(port, tab, { url, cookieStoreId: store }, (created) => {
      reopenedNav.set(created.id, { awaiting: url }); // see the reopenedNav guard below
    });
  }

  async function announceDeclined(d: WebRequestDetails, tab: Tab, decision: Declinable): Promise<void> {
    const host = new URL(d.url).host;
    if (warnedHosts.has(host)) return;
    warnedHosts.add(host);
    await port.notify({
      title: "Configurable Containers",
      message:
        `A form submission to ${host} stayed in ${await containerLabel(port, tab.cookieStoreId)} ` +
        `instead of ${targetLabel(decision)} — moving it would have dropped the form data.`,
    });
  }

  port.onBeforeRequest((d) => inTurn(d.tabId, () => navigate(d)));

  // F1: is this request the navigation we reopened this tab to perform?
  //
  // Three answers, and each is a shipped bug if it comes back wrong. `absorb` means the
  // request IS that navigation — its own first request, or a redirect hop still on the site
  // it was reopened for — and letting it route again is `tmp1 -> tmp2 -> tmp3` on one click.
  // A `from` means it WAS that navigation and has since LEFT that site: it is resolved like
  // any other, but as a hop, with the awaited url standing in for the `about:blank` the tab
  // still reads as. Absorbing that case outright left every SSO return hop unrouted in the
  // identity provider's container. Neither means the marker is not about this request.
  //
  // Stays here rather than in a sibling: it is a `Map` the blocking handler reads, keyed on
  // a navigation, and its life is that of `handled` and `viewSourceNav`.
  function ourNavigation(d: WebRequestDetails): { absorb: boolean; from?: string } {
    const ours = reopenedNav.get(d.tabId);
    if (!ours) return { absorb: false };

    if (!deps.sameSite(ours.awaiting, d.url)) {
      // Off the awaited site. Still ours if it is the same navigation; otherwise the one we
      // were waiting for never came, and the marker would load the NEXT navigation unrouted
      // inside the container we had just reopened into.
      if (ours.requestId === d.requestId) return { absorb: false, from: ours.awaiting };
      reopenedNav.delete(d.tabId);
      return { absorb: false };
    }

    // Its own first request: adopt the requestId, so the hops of THIS navigation are told
    // apart from a later navigation to the same site.
    if (ours.requestId === undefined) {
      reopenedNav.set(d.tabId, { awaiting: ours.awaiting, requestId: d.requestId });
      return { absorb: true };
    }
    if (ours.requestId === d.requestId) return { absorb: true }; // a redirect hop, still on our site
    reopenedNav.delete(d.tabId); // a later navigation: route it normally
    return { absorb: false };
  }

  // F9 — `tabs.create` can only issue a GET, so reopening a navigation with a body drops it
  // silently. Leave it where it is and say so. The routing answer was right; the EFFECT is
  // what cannot be performed losslessly.
  //
  // The decline is unconditional; only the toast is selective. Tying the two together would
  // make "say less" mean "route differently".
  function declinePost(d: WebRequestDetails, tab: Tab, decision: Decision): boolean {
    if (decision.kind !== "reopen" && decision.kind !== "choice") return false;
    if (d.method === "GET") return false;
    if (namesAConfiguredContainer(decision)) {
      // Floated, never awaited: a navigation must not wait on a toast, and a toast that
      // cannot be raised must not break routing.
      void announceDeclined(d, tab, decision).catch((e) => console.warn("[engine] notify failed", e));
    }
    return true;
  }

  // Everything above this is deciding; this is doing. Both effects defer to MAC first (F7)
  // and take `handled` BEFORE the async effect, so a re-fire of the same request cancels
  // rather than acting twice.
  async function perform(
    d: WebRequestDetails,
    tab: Tab,
    key: string,
    decision: Decision,
  ): Promise<BlockingResponse | void> {
    switch (decision.kind) {
      case "leaveAlone":
      case "stay":
        return;

      case "choice":
        if (await macOwns(port, d.url)) return; // F7 defer
        handled.add(key);
        onChoice(decision.options, { tabId: d.tabId, url: d.url });
        return { cancel: true };

      case "reopen":
        if (await macOwns(port, d.url)) return; // F7 defer
        handled.add(key); // guard BEFORE the async effects
        try {
          await reopen(tab, d.url, decision.into);
        } catch (e) {
          handled.delete(key); // fail open, so the navigation can be retried
          console.warn("[engine] reopen failed", e);
          return;
        }
        return { cancel: true };
    }
  }

  async function navigate(d: WebRequestDetails): Promise<BlockingResponse | void> {
    if (d.type !== "main_frame") return;
    if (!/^https?:/.test(d.url)) return;
    // …and not the document fetch behind a `view-source:` load, which arrives wearing the
    // inner url. Same question as the scheme test: is the user navigating to this page, or
    // is the request only raw material for something else. Adds no state and never cancels,
    // so a missing mark just routes as before.
    if (viewSourceNav.has(d.tabId)) return;

    // F1: a re-fire of a request we already acted on.
    const key = d.requestId + "+" + d.url;
    if (handled.has(key)) return { cancel: true };

    const ours = ourNavigation(d);
    if (ours.absorb) return;
    const guardedFrom = ours.from;

    const tab = await port.getTab(d.tabId);
    if (!tab) return; // raced away — fail open
    const nav = await buildNavContext(d, tab, registry, port, guardedFrom);

    const decision = resolve(nav, config, deps);

    // Before the pause record, which describes what routing WOULD have done: a hop we are
    // not going to act on has no counterfactual to report.
    if (guardedFrom !== undefined) {
      if (aHopBuysNoThrowaway(decision)) return; // the chain stays where it was opened
      reopenedNav.delete(d.tabId); // acted on: the tab it guarded is about to be superseded
    }

    // The user armed this container: record what routing would have done, do nothing. Each
    // boundary is required by something specific:
    //
    //   after resolve()      — the record's value is the COUNTERFACTUAL. "would have been
    //                          reopened into a new temporary container" says the rule was
    //                          needed; "no action" says it was not.
    //   before the decline   — a paused POST must raise no toast. F9 announces a rule that
    //                          went UNAPPLIED; under a pause the user turned routing off.
    //   after reopenedNav    — that guard still runs, so arming one hop after a reopen
    //                          cannot orphan its state.
    //
    // Adds nothing to `handled` and never cancels: no state a later navigation inherits.
    if (pause.isPaused(tab.cookieStoreId)) {
      pause.record(tab.cookieStoreId, d, decision);
      return;
    }

    // Before macOwns (no reason to ask about a navigation we will not act on) and before
    // handled.add (adds no state, so it fails open).
    if (declinePost(d, tab, decision)) return; // no cancel — the POST proceeds where it is

    return await perform(d, tab, key, decision);
  }

  return { reopen };
}
