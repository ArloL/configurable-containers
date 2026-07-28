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

export interface CreateTabProps {
  // Omit to open the browser's own new-tab page. Required for auto-temp: Firefox
  // rejects `tabs.create({ url: "about:newtab" })` with "Illegal URL" — extensions
  // may not name that page explicitly, only get it by passing no url at all.
  url?: string;
  cookieStoreId: string;
  openerTabId?: number;
  index?: number;
  active?: boolean;
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

  // Choice screen / reopen picker — navigate the triggering tab to the choice page.
  updateTab(tabId: number, props: { url: string }): Promise<void>;

  // Choice page → background: the selection message. Returns the handler's result so the
  // choice page gets a response ({ok:true}/{ok:false}) for fail-open.
  onMessage(handler: (msg: unknown) => unknown | Promise<unknown>): void;

  // Reopen picker keyboard command (manifest "commands").
  onCommand(handler: (name: string) => void): void;

  // The active tab in the current window (for the reopen picker). Null if none.
  getActiveTab(): Promise<Tab | null>;

  // The full moz-extension:// URL for a bundled resource (e.g. "choice.html").
  getURL(path: string): string;
}

// Injected timing seam so grace/GC delays are deterministic in tests. The disposer
// only ever schedules (never cancels — keep-alive is the empty re-check), so a single
// void-returning method is enough and avoids @types/node timer-handle friction.
export interface Clock {
  setTimeout(fn: () => void, ms: number): void;
}
