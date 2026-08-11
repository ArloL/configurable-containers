// The narrow browser.* facade the L3 engine depends on. The ONLY module aware
// that browser.* exists. Real adapter is an L4 concern; L3 tests use a mock.

import type { HttpHeader } from "../overlays/cookies";
export type { HttpHeader };

export interface WebRequestDetails {
  requestId: string;
  tabId: number;
  url: string; // target of the navigation
  type: "main_frame" | "sub_frame" | string;
  method: string; // "GET" | "POST" | … (spine routes main_frame only)
  originUrl?: string;
  documentUrl?: string;
}

// A top-level navigation ABOUT to start, from webNavigation.onBeforeNavigate. The one
// place an extension is told the url the tab is really going to: for a
// `view-source:https://…` load this reports the wrapped url, while the webRequest that
// same load issues reports only the inner `https://…` (see the engine's view-source
// guard). `frameId` is 0 for the top-level frame; the engine ignores the rest.
export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
}

export interface HeadersDetails {
  requestId: string;
  tabId: number;
  url: string;
  type: "main_frame" | "sub_frame" | string;
  requestHeaders: HttpHeader[]; // present because the listener asks for "requestHeaders"
}

export interface BlockingHeadersResponse {
  requestHeaders?: HttpHeader[]; // returned to apply header edits
}

// The browser.cookies.set surface (complete minus nothing) — storeId is REQUIRED and
// the seeder always sets it to the tab's own store (F11). Mirrors CookieSpec + storeId.
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

// A desktop notification. CC raises one when it declines to perform a routing action
// it cannot perform losslessly — today, reopening a non-GET navigation (F9).
export interface NotificationSpec {
  title: string;
  message: string;
}

export type RunAt = "document_start" | "document_end" | "document_idle";

// A deliberately narrow slice of Firefox's RegisteredContentScriptOptions: only the
// fields the script-injector uses. cookieStoreId is OMITTED so the seam can't scope a
// script to a container (F11: scripts run wherever the URL loads).
export interface RegisterContentScriptDetails {
  matches: string[];
  js: { code: string }[];
  runAt: RunAt;
}

export interface RegisteredContentScript {
  unregister(): Promise<void>;
}

// The subset of tabs.onUpdated's changeInfo the port surface exposes.
export interface TabUpdateInfo {
  status?: "loading" | "complete";
}

export interface Tab {
  id: number;
  url: string; // "" / about:blank for a fresh tab
  cookieStoreId: string; // "firefox-default" | "firefox-container-N"
  index: number; // preserved across a reopen
  active: boolean; // preserved across a reopen
  openerTabId?: number; // set when opened from another tab
  // The window the tab lives in — preserved across a reopen. Without it every
  // reopen lands in the last focused NORMAL window: a window.open popup (which is
  // pre-commit, so it is replaced rather than kept) loses its window and closes,
  // and a tab reopened in any unfocused window teleports to the focused one.
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

// Who sent a runtime message. `tabId` is absent when the sender is not a tab (another
// extension page, a background context) — the picker declines those.
export interface MessageSender {
  tabId?: number;
}

export interface CreateTabProps {
  // Omit to open the browser's own new-tab page. Required for auto-temp: Firefox
  // rejects `tabs.create({ url: "about:newtab" })` with "Illegal URL" — extensions
  // may not name that page explicitly, only get it by passing no url at all.
  url?: string;
  cookieStoreId: string;
  openerTabId?: number;
  index?: number;
  active?: boolean;
  // Omit for "the current window" (tabs.create's own default). Every reopen passes
  // the source tab's window so the new tab replaces it where it actually was.
  windowId?: number;
}

export interface CreateIdentityProps {
  name: string;
  color: string;
  icon: string;
}

export interface BrowserPort {
  // The engine registers ONE handler. The real port binds it to
  // webRequest.onBeforeRequest {blocking, main_frame}; the mock stores it so a
  // test can fire scripted details and inspect the BlockingResponse.
  onBeforeRequest(
    handler: (d: WebRequestDetails) => Promise<BlockingResponse | void>
  ): void;

  // webNavigation.onBeforeNavigate. Non-blocking and synchronous by contract: the
  // engine's handler for it only writes down what a tab is navigating to, and the
  // blocking onBeforeRequest reads that back without an await.
  onBeforeNavigate(handler: (d: NavigationDetails) => void): void;

  getTab(tabId: number): Promise<Tab | null>;
  createTab(props: CreateTabProps): Promise<Tab>;
  removeTab(tabId: number): Promise<void>;

  queryIdentities(): Promise<ContextualIdentity[]>;
  createIdentity(props: CreateIdentityProps): Promise<ContextualIdentity>;
  getIdentity(cookieStoreId: string): Promise<ContextualIdentity | null>;

  // MAC coexistence handshake (F7).
  sendExternalMessage(extensionId: string, message: unknown): Promise<unknown>;

  // F10 — temp-container disposal.
  onTabCreated(handler: (tab: Tab) => void): void;
  onTabRemoved(handler: (tabId: number) => void): void;
  onTabUpdated(handler: (tab: Tab, info: TabUpdateInfo) => void): void;
  queryTabs(filter: { cookieStoreId?: string }): Promise<Tab[]>;
  removeIdentity(cookieStoreId: string): Promise<void>;

  // Cookies overlay — a blocking main_frame onBeforeSendHeaders listener plus
  // cookie read/write. The seeder seeds into the tab's OWN store and rewrites the
  // outgoing Cookie header (F11/F12).
  onBeforeSendHeaders(
    handler: (d: HeadersDetails) => Promise<BlockingHeadersResponse | void>
  ): void;
  setCookie(details: SetCookieDetails): Promise<void>;
  getCookie(details: GetCookieDetails): Promise<Cookie | null>;

  // Scripts overlay — register a content script (inline code) at a runAt. The injector
  // registers once at startup; Firefox injects at runAt for matching pages (F12).
  registerContentScript(details: RegisterContentScriptDetails): Promise<RegisteredContentScript>;

  // Choice page → background: the selection message. Returns the handler's result so the
  // choice page gets a response ({ok:true}/{ok:false}) for fail-open. The sender says
  // which tab spoke, which is how the picker knows the choice tab to consume — the page
  // cannot name a tab it is not.
  onMessage(handler: (msg: unknown, sender: MessageSender) => unknown | Promise<unknown>): void;

  // Reopen picker keyboard command (manifest "commands").
  onCommand(handler: (name: string) => void): void;

  // browser_action clicks. Firefox hands the handler the ACTIVE TAB, which is the whole
  // reason the toolbar button can arm the container the user is in without a popup, a
  // message, or a payload to validate — no page is involved, so nothing craftable can
  // reach it. WebDriver cannot click a browser_action, so a handler registered here has
  // no end-to-end coverage: keep it a caller of logic that lives elsewhere.
  onActionClicked(handler: (tab: Tab) => void): void;

  // The active tab in the current window (for the reopen picker). Null if none.
  getActiveTab(): Promise<Tab | null>;

  // The full moz-extension:// URL for a bundled resource (e.g. "choice.html").
  getURL(path: string): string;

  // Loud surface for a routing action CC declined to take (F9). The real port raises a
  // desktop notification; the mock records the call.
  notify(n: NotificationSpec): Promise<void>;

  // The armed-pause indicator. Text only — the real adapter sets the background colour
  // once at startup, since the colour never changes and this is called on every
  // arm/disarm. Empty string clears it. It is on the seam at all because a pause with no
  // visible sign is an isolation hole the user has no way to notice.
  setBadge(text: string): Promise<void>;

  // Durable key/value, backed by storage.local. The ONE thing here that outlives the
  // background context, which is what makes it worth a seam: a pending timer does not,
  // and `options.ts` calls runtime.reload() on every config save. Any deadline that has
  // to be honoured across one of those must be stored as a FACT ("empty since T") and
  // re-derived on the next startup, rather than held in a closure that dies with the
  // page. Deliberately untyped: the seam stores plain JSON, and each caller owns the
  // shape under its own key.
  readStored(key: string): Promise<unknown>;
  writeStored(key: string, value: unknown): Promise<void>;
}

// Injected timing seam so grace/GC delays are deterministic in tests. The disposer
// only ever schedules (never cancels — keep-alive is the empty re-check), so a single
// void-returning method is enough and avoids @types/node timer-handle friction.
//
// `now` is part of the seam for the same reason the storage is: a grace that survives a
// background restart is arithmetic on two timestamps, and the test clock has to supply
// both halves or the fake time and the stored time would disagree.
export interface Clock {
  setTimeout(fn: () => void, ms: number): void;
  now(): number;
}
