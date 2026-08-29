// The narrow browser.* facade the L3 engine depends on. The real adapter is L4
// (browser-port.ts); L3 tests use a mock.
//
// The seam covers the ENGINE AND ITS SIBLINGS — everything under src/engine/ — not the
// whole extension: src/extension/{config,config-sync,options,choice}.ts touch browser.*
// directly by design, being storage plumbing and page scripts the L3 harness never drives.
// Routing those four through here would buy nothing and put them behind a mock built for
// navigation.

import type { Decision } from "../resolver/types";
import type { HttpHeader } from "../overlays/cookies";
export type { HttpHeader };

// Firefox's cookieStoreId for "no container". A Firefox fact, so it lives at the seam that
// owns Firefox facts rather than in each module that asks — it was spelled independently in
// four of them (`registry`, `pause`, `auto-temp`, `browser-port`), none importing another,
// and two must be identical for routing to answer at all: `registry.toRef` reads it as
// `{kind:"default"}` and `pause.arm` refuses to arm it. A typo in either is silent.
export const DEFAULT_STORE_ID = "firefox-default";

export interface WebRequestDetails {
  requestId: string;
  tabId: number;
  url: string;
  // webRequest's resourceType. Not a union: the dozen values Firefox can send make any
  // partial one collapse to `string` anyway. Only "main_frame" is acted on.
  type: string;
  method: string;
  originUrl?: string | undefined;
  documentUrl?: string | undefined;
}

// A top-level navigation ABOUT to start, from webNavigation.onBeforeNavigate. The one place
// an extension sees the url the tab is really going to: a `view-source:https://…` load
// reports the wrapped url here and only the inner `https://…` through webRequest (see the
// engine's view-source guard). `frameId` is 0 for the top-level frame.
export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
}

export interface HeadersDetails {
  requestId: string;
  tabId: number;
  url: string;
  type: string; // as WebRequestDetails.type
  requestHeaders: HttpHeader[]; // present only because the listener opts into them
}

export interface BlockingHeadersResponse {
  requestHeaders?: HttpHeader[];
}

// CookieSpec plus storeId, which is required here: the seeder always sets it to the tab's
// own store (F11).
export interface SetCookieDetails {
  url: string;
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string };
  storeId: string;
}

export interface GetCookieDetails {
  url: string;
  name: string;
  storeId: string;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string };
}

export interface Cookie {
  name: string;
  value: string;
}

export interface NotificationSpec {
  title: string;
  message: string;
}

export type RunAt = "document_start" | "document_end" | "document_idle";

// A narrow slice of Firefox's RegisteredContentScriptOptions: only what the script-injector
// uses. cookieStoreId is OMITTED so the seam cannot scope a script to a container (F11:
// scripts run wherever the URL loads).
export interface RegisterContentScriptDetails {
  matches: string[];
  js: { code: string }[];
  runAt: RunAt;
}

export interface RegisteredContentScript {
  unregister(): Promise<void>;
}

// What the pause recorder is told about one navigation. Derived from `WebRequestDetails`
// rather than restated, so the engine hands `d` over as it stands; passing the two strings
// positionally instead is a swap the compiler cannot catch, and it would put the method
// where the URL is read.
//
// It sits at the seam rather than in `engine.ts` because `engine/pause.ts` is its other
// consumer, and a type-only import upward was the last thing making the pause module know
// the engine exists.
export type RecordedNav = Pick<WebRequestDetails, "url" | "method">;

// One navigation's REASONING, for a test build to echo to the e2e probe.
//
// The e2e boundary is the highest-distance one in the test suite, and until now it carried
// CC's EFFECTS and never its CAUSES: the probe reports the tab CC opened, and nothing
// reports the decision CC made. So one signal — `timed out after 30000ms` — covered a
// POST-guard regression that wedged the tab, a dead window handle, an unanswered probe
// relay, a config that never applied, a load-dependent hydration race, and genuine flake.
// Six candidate causes past the four a person holds at once, which is why diagnosis is the
// most expensive activity in this repository even though each hazard is documented.
//
// `decision` is what `resolve()` answered; `outcome` is what the engine DID about it, which
// is not the same question and is the half a decline or a guard lives in. Both are needed:
// "reopen -> Work" plus "declined: the navigation has a body" is a diagnosis, and either
// alone is half of one.
export interface DecisionEcho {
  url: string;
  method: string;
  tabId: number;
  // Absent where the engine returned BEFORE resolving — a view-source load, a re-fire it
  // had already acted on, an absorbed redirect hop. Those exits are exactly the ones a
  // reader mistakes for "CC never saw this navigation", so they are echoed too.
  decision?: Decision | undefined;
  outcome: string;
}


export interface TabUpdateInfo {
  status?: "loading" | "complete" | undefined;
}

export interface Tab {
  id: number;
  url: string; // "" / about:blank for a fresh tab
  cookieStoreId: string; // DEFAULT_STORE_ID | "firefox-container-N"
  index: number;
  active: boolean;
  openerTabId?: number | undefined;
  // Required, not optional. Without it every reopen lands in the last focused NORMAL
  // window: a window.open popup (pre-commit, so replaced rather than kept) loses its window
  // and closes, and a tab in any unfocused window teleports to the focused one.
  windowId: number;
}

export interface ContextualIdentity {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

export interface BlockingResponse {
  cancel?: boolean;
}

// `tabId` is absent when the sender is not a tab (another extension page, a background
// context). The picker declines those.
export interface MessageSender {
  tabId?: number | undefined;
}

export interface CreateTabProps {
  // Omit to open the browser's own new-tab page. Required for auto-temp: Firefox rejects
  // `tabs.create({ url: "about:newtab" })` with "Illegal URL", so passing no url at all is
  // the only way to land there.
  url?: string;
  cookieStoreId: string;
  openerTabId?: number | undefined;
  index?: number;
  active?: boolean;
  // Omitted means "the current window". Every reopen passes the source tab's own, so the
  // replacement lands where the original was.
  windowId?: number;
}

export interface CreateIdentityProps {
  name: string;
  color: string;
  icon: string;
}

export interface BrowserPort {
  // Bound to webRequest.onBeforeRequest with {blocking, main_frame}.
  onBeforeRequest(
    handler: (d: WebRequestDetails) => Promise<BlockingResponse | void>
  ): void;

  // webNavigation.onBeforeNavigate. Non-blocking and synchronous by contract: the handler
  // only writes down what a tab is navigating to, and onBeforeRequest reads it back without
  // an await.
  onBeforeNavigate(handler: (d: NavigationDetails) => void): void;

  getTab(tabId: number): Promise<Tab | null>;
  createTab(props: CreateTabProps): Promise<Tab>;
  removeTab(tabId: number): Promise<void>;

  queryIdentities(): Promise<ContextualIdentity[]>;
  createIdentity(props: CreateIdentityProps): Promise<ContextualIdentity>;
  getIdentity(cookieStoreId: string): Promise<ContextualIdentity | null>;

  // MAC coexistence handshake (F7).
  sendExternalMessage(extensionId: string, message: unknown): Promise<unknown>;

  // For the disposer (F10) and auto-temp.
  onTabCreated(handler: (tab: Tab) => void): void;
  onTabRemoved(handler: (tabId: number) => void): void;
  onTabUpdated(handler: (tab: Tab, info: TabUpdateInfo) => void): void;
  queryTabs(filter: { cookieStoreId?: string }): Promise<Tab[]>;
  removeIdentity(cookieStoreId: string): Promise<void>;

  // Blocking, main_frame. The seeder writes into the tab's OWN store and rewrites the
  // outgoing Cookie header (F11/F12).
  onBeforeSendHeaders(
    handler: (d: HeadersDetails) => Promise<BlockingHeadersResponse | void>
  ): void;
  setCookie(details: SetCookieDetails): Promise<void>;
  getCookie(details: GetCookieDetails): Promise<Cookie | null>;

  // Registered by the script-injector, which keeps the handle and unregisters through it:
  // a config is applied more than once — every Save and every adopted config re-registers
  // the whole set — and since a save stopped restarting the extension, nothing else would
  // ever drop a registration. Firefox injects at runAt for matching pages (F12).
  registerContentScript(details: RegisterContentScriptDetails): Promise<RegisteredContentScript>;

  // Returns the handler's result, so the choice page gets {ok:true}/{ok:false} and can fail
  // open. The sender is how the picker learns which tab spoke: the page cannot name a tab
  // it is not.
  onMessage(handler: (msg: unknown, sender: MessageSender) => unknown): void;

  // Reopen picker keyboard command (manifest "commands").
  onCommand(handler: (name: string) => void): void;

  // browser_action clicks. Firefox hands the handler the ACTIVE TAB, so the toolbar button
  // can arm the container the user is in with no popup, message or payload to validate —
  // no page is involved, so nothing craftable reaches it. WebDriver cannot click a
  // browser_action, so a handler here has no end-to-end coverage: keep it a thin caller.
  onActionClicked(handler: (tab: Tab) => void): void;

  getActiveTab(): Promise<Tab | null>;

  getURL(path: string): string;

  notify(n: NotificationSpec): Promise<void>;

  // What CC decided about one navigation and what it did, for a test build to hand the e2e
  // suite. Synchronous and void by contract, exactly as `PauseRecorder.record` is: it is
  // called from the blocking handler, so it must add no round trip in front of a page load
  // and a failure to say what happened must never change what happens.
  //
  // In every shipped build the implementation folds to `if (false)` — the echo target is a
  // compile-time constant and the build does not minify, so the dead branch is readable
  // proof for an AMO reviewer. It is READ-ONLY, which is what separates it from the
  // build-time seed CLAUDE.md forbids: a seed that armed a container would make the shipped
  // extension capable of starting up with routing disabled, while this changes no routing at
  // all.
  echoDecision(e: DecisionEcho): void;

  // Text only, because the colour never changes: the real adapter sets it once at startup
  // rather than on every arm/disarm. Empty string clears it.
  setBadge(text: string): Promise<void>;

  // The one thing on this seam that outlives the background context — a pending timer does
  // not, and the context dies with the browser. So a deadline that must survive a restart is
  // stored as a FACT ("empty since T") and re-derived on the next startup, never held in a
  // closure. It is also how the wiring reads the config a Save has just written. Untyped:
  // each caller owns the shape under its key.
  readStored(key: string): Promise<unknown>;
  writeStored(key: string, value: unknown): Promise<void>;
}

// The disposer only schedules, never cancels — keep-alive is the empty re-check — so a
// void return is enough, and it avoids @types/node timer-handle friction.
//
// `now` belongs here for the same reason the storage does: a grace surviving a restart is
// arithmetic on two timestamps, and a test clock supplying one half would disagree with the
// stored time.
export interface Clock {
  setTimeout(fn: () => void, ms: number): void;
  now(): number;
}
