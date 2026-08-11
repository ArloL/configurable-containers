import { resolve } from "../resolver/resolve";
import type { Config, ContainerRef, Decision, Deps, NavContext, Target } from "../resolver/types";
import type { BrowserPort, Tab, WebRequestDetails } from "./port";
import { createRegistry, type ContainerRegistry } from "./registry";
import { supersede } from "./supersede";

export const MAC_ID = "@testpilot-containers";

export interface Engine {
  // The F1-guarded reopen effect. Opens `url` in `target` beside `tab` — keeping `tab`
  // when it is on a page, replacing it when it has nothing to lose — and leaves the
  // reopened tab's whole navigation alone via `reopenedNav`. Throws (callers react).
  reopen(tab: Tab, url: string, target: Target): Promise<void>;
}

// The pause seam. Narrow and SYNCHRONOUS by contract: `isPaused` is consulted inside the
// blocking webRequest handler, where an await would sit in every navigation's latency,
// and `record` returns void so a navigation never waits on bookkeeping. Required, not
// optional — an optional field is one a mock forgets to set, and the coverage quietly
// stops.
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

// The two decisions the engine executes by opening a tab — and therefore the two it
// cannot execute for a request that carries a body. Exported because the pause record
// describes a declined action in the SAME words as the F9 notification: one function, so
// the toast and the record cannot drift apart.
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

export function createEngine(opts: EngineOptions): Engine {
  const { port, config, deps, onChoice, pause } = opts;
  const registry = createRegistry(port, opts.tmpSuffix ?? defaultSuffix());
  const handled = new Set<string>();
  // Hosts already warned about a declined non-GET. Session-scoped: the
  // runtime.reload() a config save triggers clears it, which is what we want — the
  // rules just changed, so the user should hear about them again.
  const warnedHosts = new Set<string>();
  // The navigation each tab we reopened is still performing: tabId -> the requestId
  // once its first request arrives, or the url we are still waiting for until then.
  // That whole navigation must be left alone: in a real browser onBeforeRequest fires
  // before the new tab's url commits, so it still reads as about:blank and resolve()
  // cannot tell it is already correctly contained — without this it would reopen
  // forever (F1).
  //
  // Tracking the requestId, not just "the first request", is what makes the guard
  // cover a REDIRECT CHAIN: every hop reuses the requestId and the tab stays
  // pre-commit throughout, so a one-shot guard let hop 2 look like an unrouted
  // navigation and bought it another throwaway (tmp2 -> tmp3 on a single click).
  // Keying on the requestId also keeps the guard off tabs we did NOT route: a
  // middle-clicked link inherits its opener's container and is pre-commit too, and
  // it must still be isolated into a throwaway of its own.
  //
  // Holding the awaited URL, rather than a bare "not yet" marker, bounds the wait: a
  // reopened tab whose own request never arrives (load aborted, user typed elsewhere
  // first) would otherwise let the guard absorb whatever navigation came next, which
  // leaves that site unrouted in the container we reopened INTO — an unmatched site
  // riding in a permanent container's cookie jar. Matched by site, not exact url,
  // because Firefox can legitimately rewrite the url before the first request (HSTS
  // upgrades the scheme); the site is what survives that and what routing turns on.
  const reopenedNav = new Map<number, { awaiting: string } | { requestId: string }>();

  // Tabs whose pending top-level navigation is a `view-source:` load.
  //
  // "View Page Source" fetches the document it is about to print, so it issues an
  // ordinary main_frame GET — and webRequest reports that request under the INNER url:
  // `view-source:https://site/` arrives here as plain `https://site/`, with the tab
  // still pre-commit on about:blank. Nothing in the details says otherwise, so the
  // engine used to route it like any other navigation: cancel, and reopen `https://site/`
  // elsewhere. That drops the `view-source:` wrapper (a reopen can only issue a plain
  // GET, exactly as it cannot carry a POST body), and because the tab Firefox just made
  // is pre-commit, `supersede` replaces it rather than keeping it. Ctrl+U therefore
  // destroyed its own tab and rendered the page in a throwaway instead of showing the
  // source. Multi-Account Containers carries the same report unresolved
  // (mozilla/multi-account-containers#2582).
  //
  // webNavigation is the one place the wrapped url is visible, and Firefox fires
  // onBeforeNavigate before the webRequest that navigation issues — measured in
  // Firefox 153, for the view-source tab and for every ordinary navigation in the same
  // session (test/e2e/view-source.test.ts pins the outcome end to end). So the mark is
  // written there and read, without an await, inside the blocking handler.
  //
  // Nothing has to expire it: every top-level navigation in a tab announces itself here
  // first, so the next one clears the mark, and a redirect of the view-source load
  // itself keeps it — which is what that hop needs. A tab closed while still showing
  // source leaves its id behind; that is one integer, and NOT worth an onTabRemoved
  // listener, because `mock-port` holds a single handler slot per event and a second
  // registration would silently displace the disposer's.
  const viewSourceNav = new Set<number>();

  port.onBeforeNavigate((d) => {
    if (d.frameId !== 0) return; // sub-frames are not routed at all
    if (d.url.startsWith("view-source:")) viewSourceNav.add(d.tabId);
    else viewSourceNav.delete(d.tabId);
  });

  // The F1-guarded reopen effect. Shared by the engine's own `case "reopen"` and the
  // picker (choice screen / reopen picker). Throws on failure — callers decide whether
  // to swallow (the engine's request-time path clears `handled` and fails open) or to
  // surface the result (the picker reports {ok:false} to the choice page).
  async function reopen(tab: Tab, url: string, target: Target): Promise<void> {
    const store = await registry.toStoreId(target);
    // `supersede` owns the keep-or-replace rule and the window; the picker's choice tab
    // goes through the same function, so the two cannot drift.
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

  port.onBeforeRequest(async (d) => {
    // (0) Scope: only top-level http(s) navigations.
    if (d.type !== "main_frame") return;
    if (!/^https?:/.test(d.url)) return;
    // …and not the document fetch behind a `view-source:` load, which arrives here
    // wearing the inner url. Sits with the scheme test because it is the same
    // question — is this a page the user is navigating to, or something else this
    // request is only the raw material for. Adds no state and never cancels, so it is
    // fail-open by construction: if the mark is somehow missing, routing carries on
    // exactly as it did before.
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

    // (3a) The user armed this container: record what routing would have done, and do
    // nothing. Three boundaries, each required by something specific:
    //
    //   after (3)  — the record's value is the COUNTERFACTUAL. "would have been reopened
    //                into a new temporary container" is what tells the user the rule was
    //                needed; "no action" is what tells them it was not. resolve() is pure
    //                and cheap, so computing a decision we then decline costs nothing.
    //   before (3b)— a paused POST must raise no declination toast. F9 announces a
    //                routing rule that went UNAPPLIED; under a pause nothing went
    //                unapplied, the user turned routing off.
    //   after (1b) — the reopenedNav guard still runs, so arming one hop after a reopen
    //                cannot orphan its state.
    //
    // Adds nothing to `handled` and never cancels, so like (3b) it is fail-open by
    // construction: it accumulates no state a later navigation could inherit.
    if (pause.isPaused(tab.cookieStoreId)) {
      pause.record(tab.cookieStoreId, d.url, decision);
      return;
    }

    // (3b) F9 — tabs.create can only issue a GET, so reopening a navigation that
    // carries a body would drop it silently. Leave it where it is and say so. Placed
    // before macOwns (no reason to ask MAC about a navigation we will not act on) and
    // before handled.add (this path adds no state, so it is fail-open by construction).
    // The reopenedNav guard has already returned for navigations that are ours.
    if ((decision.kind === "reopen" || decision.kind === "choice") && d.method !== "GET") {
      // Floated, never awaited: a navigation must not wait on a toast, and a
      // notification that cannot be raised must not break routing.
      void announceDeclined(d, tab, decision).catch((e) => console.warn("[engine] notify failed", e));
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
  });

  return { reopen };
}
