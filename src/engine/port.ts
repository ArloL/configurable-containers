// The narrow browser.* facade the L3 engine depends on. The ONLY module aware
// that browser.* exists. Real adapter is an L4 concern; L3 tests use a mock.

export interface WebRequestDetails {
  requestId: string;
  tabId: number;
  url: string; // target of the navigation
  type: "main_frame" | "sub_frame" | string;
  method: string; // "GET" | "POST" | … (spine routes main_frame only)
  originUrl?: string;
  documentUrl?: string;
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
  url: string;
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
}
