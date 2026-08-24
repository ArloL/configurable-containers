import { resolve } from "../resolver/resolve";
import type { Config, ContainerRef, Decision, Deps, NavContext, Target } from "../resolver/types";
import type { BlockingResponse, BrowserPort, Tab, WebRequestDetails } from "./port";
import { createRegistry, type ContainerRegistry } from "./registry";
import { supersede } from "./supersede";

export const MAC_ID = "@testpilot-containers";

export interface Engine {
  // Opens `url` in `target` beside `tab`: keeps `tab` if it is on a page, replaces it if
  // it has nothing to lose. `reopenedNav` then leaves the new tab's navigation alone (F1).
  // Throws; callers react.
  reopen(tab: Tab, url: string, target: Target): Promise<void>;
}

// The pause seam, synchronous by contract: `isPaused` runs inside the blocking webRequest
// handler, where an await would cost every navigation latency, and `record` returns void so
// a navigation never waits on bookkeeping. Required, not optional: a mock forgets to set an
// optional field and coverage stops silently.
export interface PauseRecorder {
  isPaused(cookieStoreId: string): boolean;
  record(cookieStoreId: string, url: string, decision: Decision): void;
}

export interface EngineOptions {
  port: BrowserPort;
  config: Config;
  deps: Deps;
  onChoice: (options: string[], nav: { tabId: number; url: string }) => void;
  pause: PauseRecorder;
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
  // A pre-commit tab ("about:blank", or "" when brand new) has no `current`, even though
  // its container is known: the disposable path needs the site the tab was ON, and that is
  // genuinely unknown here. Naming the container instead parks a middle-clicked link in its
  // opener's throwaway.
  const current =
    tab.url && tab.url !== "about:blank"
      ? { url: tab.url, container: await registry.toRef(tab.cookieStoreId) }
      : null;

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

// The two decisions the engine performs by opening a tab, and so the two it cannot perform
// for a request with a body. Exported because the pause record describes a declined action
// in the same words as the F9 notification: one function, so the two cannot drift.
export type Declinable = Extract<Decision, { kind: "reopen" } | { kind: "choice" }>;

// How the notification names where the tab is, and where the rules wanted it.
async function containerLabel(port: BrowserPort, cookieStoreId: string): Promise<string> {
  const ci = await port.getIdentity(cookieStoreId);
  return ci ? ci.name : "the default container";
}

export function targetLabel(decision: Declinable): string {
  if (decision.kind === "choice") return `one of: ${decision.options.join(", ")}`;
  switch (decision.into.kind) {
    case "permanent":
      return decision.into.name;
    case "temporary":
      return "a new temporary container";
    case "default":
      return "the default container";
  }
}

// Whether a declined navigation is worth interrupting the user for. Narrows the
// NOTIFICATION only; the decline is unconditional, since the body would be dropped anyway.
//
// A toast earns its interruption by naming a container the config names: *stayed in tmp9
// instead of Haeger* says the login landed where it cannot work and points at the rule to
// fix. That is the SSO case this exists for.
//
// A temporary target cannot say that. *Stayed in tmp9 instead of a new temporary container*
// names two throwaways the user can neither tell apart nor act on — and that is the COMMON
// case: a card payment at an unmatched site, where the 3-D Secure host posts back cross-site
// and staying put is what makes checkout work. Silenced with it: a POST out of a permanent
// container that would have been isolated. It still names no unapplied rule and nothing to
// do, which is the line this draws. `default` sits with `temporary` — it is Firefox's
// no-container, not a rule's target.
export function namesAConfiguredContainer(decision: Declinable): boolean {
  // A choice always lists containers straight out of the config, `Temporary` among them
  // or not.
  return decision.kind === "choice" || decision.into.kind === "permanent";
}

export function createEngine(opts: EngineOptions): Engine {
  const { port, config, deps, onChoice, pause } = opts;
  const registry = createRegistry(port, opts.tmpSuffix ?? defaultSuffix());
  const handled = new Set<string>();
  // Hosts already warned about a declined non-GET. Session-scoped: the runtime.reload() a
  // config save triggers clears it, which is right — the rules changed, so warn again.
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
  const reopenedNav = new Map<number, { awaiting: string } | { requestId: string }>();

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
    // `supersede` owns the keep-or-replace rule and the window; the picker goes through
    // the same function, so the two cannot drift.
    await supersede(port, tab, { url, cookieStoreId: store }, (created) => {
      reopenedNav.set(created.id, { awaiting: url }); // leave its whole navigation alone (see 1b)
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

  async function navigate(d: WebRequestDetails): Promise<BlockingResponse | void> {
    // (0) Scope: only top-level http(s) navigations.
    if (d.type !== "main_frame") return;
    if (!/^https?:/.test(d.url)) return;
    // …and not the document fetch behind a `view-source:` load, which arrives wearing the
    // inner url. Same question as the scheme test: is the user navigating to this page, or
    // is the request only raw material for something else. Adds no state and never cancels,
    // so a missing mark just routes as before.
    if (viewSourceNav.has(d.tabId)) return;

    // (1) F1 loop guard — re-fires of a request we already acted on.
    const key = d.requestId + "+" + d.url;
    if (handled.has(key)) return { cancel: true };

    // (1b) F1 loop guard — the navigation we reopened this tab to perform, from its
    // first request through every redirect hop of it.
    const ours = reopenedNav.get(d.tabId);
    if (ours) {
      if ("requestId" in ours) {
        if (ours.requestId === d.requestId) return; // a hop of it — same navigation, still ours
        reopenedNav.delete(d.tabId); // a later navigation in that tab: route it normally
      } else if (deps.sameSite(ours.awaiting, d.url)) {
        reopenedNav.set(d.tabId, { requestId: d.requestId }); // first request: this is the one
        return;
      } else {
        reopenedNav.delete(d.tabId); // the awaited navigation never came — route this one
      }
    }

    // (2) Assemble NavContext.
    const tab = await port.getTab(d.tabId);
    if (!tab) return; // tab raced away — fail open
    const nav = await buildNavContext(d, tab, registry, port);

    // (3) Pure decision.
    const decision = resolve(nav, config, deps);

    // (3a) The user armed this container: record what routing would have done, do nothing.
    // Each boundary is required by something specific:
    //
    //   after (3)   — the record's value is the COUNTERFACTUAL. "would have been reopened
    //                 into a new temporary container" says the rule was needed; "no action"
    //                 says it was not. resolve() is pure and cheap.
    //   before (3b) — a paused POST must raise no declination toast. F9 announces a rule
    //                 that went UNAPPLIED; under a pause the user turned routing off.
    //   after (1b)  — the reopenedNav guard still runs, so arming one hop after a reopen
    //                 cannot orphan its state.
    //
    // Adds nothing to `handled` and never cancels: no state a later navigation inherits.
    if (pause.isPaused(tab.cookieStoreId)) {
      pause.record(tab.cookieStoreId, d.url, decision);
      return;
    }

    // (3b) F9 — tabs.create can only issue a GET, so reopening a navigation with a body
    // drops it silently. Leave it where it is and say so. Before macOwns (no reason to ask
    // about a navigation we will not act on) and before handled.add (adds no state, so it
    // fails open). reopenedNav has already returned for navigations that are ours.
    if ((decision.kind === "reopen" || decision.kind === "choice") && d.method !== "GET") {
      // The decline is unconditional; only the toast is selective. Tying the two together
      // would make "say less" mean "route differently".
      if (namesAConfiguredContainer(decision)) {
        // Floated, never awaited: a navigation must not wait on a toast, and a toast that
        // cannot be raised must not break routing.
        void announceDeclined(d, tab, decision).catch((e) => console.warn("[engine] notify failed", e));
      }
      return; // no cancel — the POST proceeds in the tab's current container
    }

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
  }

  return { reopen };
}
