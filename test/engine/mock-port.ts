import type {
  BlockingHeadersResponse,
  BlockingResponse,
  BrowserPort,
  Clock,
  Cookie,
  ContextualIdentity,
  CreateIdentityProps,
  CreateTabProps,
  GetCookieDetails,
  HeadersDetails,
  MessageSender,
  NavigationDetails,
  NotificationSpec,
  RegisterContentScriptDetails,
  RegisteredContentScript,
  SetCookieDetails,
  Tab,
  TabUpdateInfo,
  WebRequestDetails,
} from "../../src/engine/port";

const MAC_ID = "@testpilot-containers";

// The window a tab belongs to unless a test says otherwise — Firefox's "current window".
export const DEFAULT_WINDOW_ID = 1;

// What a test says to conjure a tab. windowId is opt-in: only the cases about windows
// mention one.
export interface TabProps {
  url?: string;
  cookieStoreId: string;
  index?: number;
  active?: boolean;
  openerTabId?: number;
  windowId?: number;
}

// Resolve after pending microtasks so floated async callbacks (maybeQueue/tryRemove) settle.
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export interface MockPort {
  port: BrowserPort;

  /** Fires webRequest.onBeforeRequest and returns the blocking response. */
  navigates(d: WebRequestDetails): Promise<BlockingResponse | void>;
  /**
   * Fires webNavigation.onBeforeNavigate — what Firefox announces before the request a
   * navigation issues, and the only event that names a `view-source:` url. Defaults to
   * the top-level frame, which is the only one the engine looks at.
   */
  startsNavigating(d: { tabId: number; url: string; frameId?: number }): void;
  /** Fires webRequest.onBeforeSendHeaders and returns the header edits. */
  sendsHeaders(d: HeadersDetails): Promise<BlockingHeadersResponse | void>;

  openTabs: Map<number, Tab>;
  containers: Map<string, ContextualIdentity>;

  // What the extension did, in the order it did it.
  openedTabs: CreateTabProps[];
  closedTabIds: number[];
  createdContainers: CreateIdentityProps[];
  removedContainers: string[];
  seededCookies: SetCookieDetails[];
  notifications: NotificationSpec[];
  registeredScripts: RegisterContentScriptDetails[];
  /** Current browser_action badge text; "" when cleared. */
  badgeText: string;

  // The engine floats its notification rather than awaiting it (a navigation must not
  // wait on a toast), so a test asserting on notifications must settle first.
  settle(): Promise<void>;

  /** A tab that is already open. Fires nothing. */
  existingTab(props: TabProps & { url: string }): Tab;
  /** A container that already exists. Fires nothing. */
  addContainerNamed(props: { name: string; color?: string; icon?: string }): ContextualIdentity;

  /** Fires browser.tabs.onCreated, as a real tabs.create does. */
  opensTab(props: TabProps & { url: string }): Promise<Tab>;
  /** Fires browser.tabs.onRemoved. */
  closesTab(tab: Tab): Promise<void>;
  /** Fires browser.tabs.onUpdated. */
  updatesTab(tab: Tab, info: TabUpdateInfo): Promise<void>;
  /**
   * Fires browser.runtime.onMessage and returns the handler's reply. `from` is the tab
   * the message came from; omit it for a sender that is not a tab.
   */
  receivesMessage(msg: unknown, from?: Tab): Promise<unknown>;
  /** Fires browser.commands.onCommand. */
  receivesCommand(name: string): Promise<void>;
  /** Fires browser.browserAction.onClicked with the tab Firefox would hand it. */
  clicksAction(tab: Tab): Promise<void>;

  // Arranged conditions.
  macAssigns(url: string, value: unknown): void;
  macIsAbsent(on: boolean): void;
  tabCreationFails(on: boolean): void;
  activeTabIs(tab: Tab): void;
  cookieIn(storeId: string, name: string): Cookie | null;
}

export function aFakeBrowser(): MockPort {
  const openTabs = new Map<number, Tab>();
  const containers = new Map<string, ContextualIdentity>();
  const macMap = new Map<string, unknown>();
  const openedTabs: CreateTabProps[] = [];
  const closedTabIds: number[] = [];
  const createdContainers: CreateIdentityProps[] = [];
  const removedContainers: string[] = [];
  const seededCookies: SetCookieDetails[] = [];
  const notifications: NotificationSpec[] = [];

  let tabId = 0;
  let containerId = 0;
  let macThrows = false;
  let createTabThrows = false;
  let handler: ((d: WebRequestDetails) => Promise<BlockingResponse | void>) | null = null;
  let beforeNavigateH: ((d: NavigationDetails) => void) | null = null;
  let onTabCreatedH: ((tab: Tab) => void) | null = null;
  let onTabRemovedH: ((tabId: number) => void) | null = null;
  let onTabUpdatedH: ((tab: Tab, info: TabUpdateInfo) => void) | null = null;
  let headersHandler: ((d: HeadersDetails) => Promise<BlockingHeadersResponse | void>) | null = null;
  let messageHandler: ((msg: unknown, sender: MessageSender) => unknown | Promise<unknown>) | null = null;
  let commandHandler: ((name: string) => void) | null = null;
  let activeTab: Tab | null = null;
  let badgeText = "";
  let actionClickedH: ((tab: Tab) => void) | null = null;
  const cookieStore = new Map<string, Map<string, Cookie>>(); // storeId -> name -> cookie
  const registeredScripts: RegisterContentScriptDetails[] = [];
  // storage.local. Lives on the BROWSER, not the background session, which is the whole
  // point: it is what a restart is allowed to still find. Values are held as JSON text
  // for the same reason the real one does.
  const stored = new Map<string, string>();

  function makeTab(props: TabProps): Tab {
    const id = ++tabId;
    const tab: Tab = {
      id,
      // No url means "the browser's new-tab page" — that is how the real
      // tabs.create behaves, and the only legal way to land on about:newtab.
      url: props.url ?? "about:newtab",
      cookieStoreId: props.cookieStoreId,
      index: props.index ?? id,
      active: props.active ?? true,
      openerTabId: props.openerTabId,
      // Firefox always reports a window; a test that doesn't care gets the one window.
      // A tab created WITHOUT a windowId lands in the current window — which is what
      // the popup bug was: the reopen omitted it and the replacement left the popup.
      windowId: props.windowId ?? DEFAULT_WINDOW_ID,
    };
    openTabs.set(id, tab);
    return tab;
  }

  function makeIdentity(props: CreateIdentityProps): ContextualIdentity {
    const cookieStoreId = `firefox-container-${++containerId}`;
    const ci: ContextualIdentity = { cookieStoreId, name: props.name, color: props.color, icon: props.icon };
    containers.set(cookieStoreId, ci);
    return ci;
  }

  const port: BrowserPort = {
    onBeforeRequest(h) {
      handler = h;
    },
    onBeforeNavigate(h) {
      beforeNavigateH = h;
    },
    async getTab(id) {
      return openTabs.get(id) ?? null;
    },
    async createTab(props) {
      openedTabs.push(props);
      if (createTabThrows) throw new Error("createTab failed");
      // Fidelity guard: Firefox refuses privileged about: URLs from an extension
      // ("Illegal URL: about:newtab"). about:blank is the one exception. A mock that
      // accepted them let auto-temp ship a containerize() that always threw in real
      // Firefox while L3 stayed green — never relax this.
      if (props.url?.startsWith("about:") && props.url !== "about:blank") {
        throw new Error(`Illegal URL: ${props.url}`);
      }
      const tab = makeTab(props);
      onTabCreatedH?.(tab); // real Firefox fires onCreated synchronously during tabs.create
      return tab;
    },
    async removeTab(id) {
      closedTabIds.push(id);
      const wasOpen = openTabs.delete(id);
      // Firefox fires tabs.onRemoved for a tab closed through tabs.remove, exactly as it
      // does for one the user closed — the same reason createTab fires onTabCreated here.
      // Without this a tab CC itself closed (a reopen superseding its source, a stranded
      // redirector) was invisible to every onTabRemoved listener, so the disposer never
      // learned that the container it emptied had gone empty.
      if (wasOpen) onTabRemovedH?.(id);
    },
    async queryIdentities() {
      return [...containers.values()];
    },
    async createIdentity(props) {
      createdContainers.push(props);
      return makeIdentity(props);
    },
    async getIdentity(cookieStoreId) {
      return containers.get(cookieStoreId) ?? null;
    },
    async sendExternalMessage(extId, message) {
      if (macThrows) throw new Error("MAC not installed");
      const m = message as { method?: string; url?: string };
      if (extId === MAC_ID && m?.method === "getAssignment") {
        return macMap.get(m.url ?? "") ?? null;
      }
      return null;
    },
    onTabCreated(h) {
      onTabCreatedH = h;
    },
    onTabRemoved(h) {
      onTabRemovedH = h;
    },
    onTabUpdated(h) {
      onTabUpdatedH = h;
    },
    async queryTabs(filter) {
      const all = [...openTabs.values()];
      return filter.cookieStoreId ? all.filter((t) => t.cookieStoreId === filter.cookieStoreId) : all;
    },
    async removeIdentity(cookieStoreId) {
      removedContainers.push(cookieStoreId);
      containers.delete(cookieStoreId);
    },
    onBeforeSendHeaders(h) {
      headersHandler = h;
    },
    async setCookie(details) {
      seededCookies.push(details);
      const jar = cookieStore.get(details.storeId) ?? new Map<string, Cookie>();
      jar.set(details.name, { name: details.name, value: details.value ?? "" });
      cookieStore.set(details.storeId, jar);
    },
    async getCookie(details: GetCookieDetails) {
      return cookieStore.get(details.storeId)?.get(details.name) ?? null;
    },
    async registerContentScript(details: RegisterContentScriptDetails): Promise<RegisteredContentScript> {
      registeredScripts.push(details);
      return { unregister: async () => { /* no-op for tests */ } };
    },
    onMessage(h) {
      messageHandler = h;
    },
    onCommand(h) {
      commandHandler = h;
    },
    async getActiveTab() {
      return activeTab;
    },
    getURL(path) {
      return `moz-extension://test/${path}`;
    },
    async notify(n) {
      notifications.push(n);
    },
    onActionClicked(h) {
      actionClickedH = h;
    },
    async setBadge(text) {
      badgeText = text;
    },
    async readStored(key) {
      // Round-trips through JSON like the real storage does, so a test cannot pass by
      // handing back the very object the caller still holds a reference to.
      const raw = stored.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async writeStored(key, value) {
      stored.set(key, JSON.stringify(value));
    },
  };

  return {
    port,
    async navigates(d) {
      if (!handler) throw new Error("no onBeforeRequest handler registered");
      return handler(d);
    },
    startsNavigating(d) {
      if (!beforeNavigateH) throw new Error("no onBeforeNavigate handler registered");
      beforeNavigateH({ frameId: 0, ...d });
    },
    async sendsHeaders(d) {
      if (!headersHandler) throw new Error("no onBeforeSendHeaders handler registered");
      return headersHandler(d);
    },
    openTabs,
    containers,
    openedTabs,
    closedTabIds,
    createdContainers,
    removedContainers,
    seededCookies,
    notifications,
    registeredScripts,
    // A getter: `badgeText` is reassigned on every set, so exposing the binding's value
    // here would freeze a test's view at construction time.
    get badgeText() {
      return badgeText;
    },
    existingTab: makeTab,
    addContainerNamed: (props) => makeIdentity({ name: props.name, color: props.color ?? "blue", icon: props.icon ?? "circle" }),
    async opensTab(props) {
      const tab = makeTab(props);
      onTabCreatedH?.(tab);
      await flushMicrotasks();
      return tab;
    },
    async closesTab(tab) {
      openTabs.delete(tab.id);
      onTabRemovedH?.(tab.id);
      await flushMicrotasks();
    },
    async updatesTab(tab, info) {
      // Reflect the updated tab into the mock's map so getTab sees the new URL.
      openTabs.set(tab.id, tab);
      onTabUpdatedH?.(tab, info);
      await flushMicrotasks();
    },
    macAssigns: (url, value) => void macMap.set(url, value),
    macIsAbsent: (on) => void (macThrows = on),
    tabCreationFails: (on) => void (createTabThrows = on),
    cookieIn: (storeId, name) => cookieStore.get(storeId)?.get(name) ?? null,
    async receivesMessage(msg, from) {
      if (!messageHandler) throw new Error("no onMessage handler registered");
      return messageHandler(msg, { tabId: from?.id });
    },
    async receivesCommand(name) {
      commandHandler?.(name);
      await flushMicrotasks();
    },
    async clicksAction(tab) {
      actionClickedH?.(tab);
      await flushMicrotasks();
    },
    activeTabIs(tab) {
      activeTab = tab;
    },
    settle: flushMicrotasks,
  };
}

export function aFakeClock(): { clock: Clock; advance(ms: number): Promise<void>; pending(): number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { dueAt: number; fn: () => void }>();
  const clock: Clock = {
    setTimeout(fn, ms) {
      timers.set(++seq, { dueAt: now + ms, fn });
    },
    // The same `now` the timers are scheduled against, so a stored deadline and a fired
    // timer can never disagree about what time it is.
    now: () => now,
  };
  return {
    clock,
    async advance(ms) {
      await flushMicrotasks(); // let pending async work (e.g. the startup sweep) schedule its timers
      const target = now + ms;
      for (;;) {
        let next: [number, { dueAt: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].dueAt <= target && (!next || entry[1].dueAt < next[1].dueAt)) next = entry;
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].fn();
        await flushMicrotasks(); // let async callbacks (queryTabs/removeIdentity) settle
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}
