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

// What a test says to conjure a tab. windowId is opt-in: only window cases mention one.
export interface TabProps {
  url?: string | undefined;
  cookieStoreId: string;
  index?: number | undefined;
  active?: boolean | undefined;
  openerTabId?: number | undefined;
  windowId?: number | undefined;
}

// Resolve after pending microtasks so floated async callbacks (maybeQueue/tryRemove) settle.
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export interface MockPort {
  port: BrowserPort;

  /** Fires webRequest.onBeforeRequest and returns the blocking response. */
  navigates(d: WebRequestDetails): Promise<BlockingResponse | void>;
  /**
   * Fires webNavigation.onBeforeNavigate — announced before the request a navigation issues,
   * and the only event that names a `view-source:` url. Defaults to the top-level frame, the
   * only one the engine looks at.
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
  badgeText: string;

  // The engine floats its notification rather than awaiting it, so a test asserting on
  // notifications must settle first.
  settle(): Promise<void>;

  /** Arranged, not performed: fires nothing, unlike opensTab. */
  existingTab(props: TabProps & { url: string }): Tab;
  /** Arranged, not performed: fires nothing. */
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
  /** Firefox rejects contentScripts.register — a bad match pattern, a missing permission. */
  scriptRegistrationFails(message: string | null): void;
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
  let registerScriptThrows: string | null = null;
  // Listeners are LISTS, one per event, because `browser.*.addListener` is additive: Firefox
  // calls every listener, in registration order. The mock held one slot per event until
  // 2026-08-24, and it cost what a "last registration wins" mock would be expected to cost —
  // `wireBackground` registers onTabRemoved twice (pause, then the disposer) and onTabUpdated
  // twice (auto-temp, then the redirector-closer), so at L3 the first of each pair was never
  // called and two behaviours of the composed background were silently unwired.
  //
  // Retiring a dead session's listeners on restart, the other job the single slot did, is now
  // `aSessionPort` in restart.ts, beside the clock facade that already did it for timers.
  const beforeRequestHs: ((d: WebRequestDetails) => Promise<BlockingResponse | void>)[] = [];
  const beforeNavigateHs: ((d: NavigationDetails) => void)[] = [];
  const onTabCreatedHs: ((tab: Tab) => void)[] = [];
  const onTabRemovedHs: ((tabId: number) => void)[] = [];
  const onTabUpdatedHs: ((tab: Tab, info: TabUpdateInfo) => void)[] = [];
  const headersHs: ((d: HeadersDetails) => Promise<BlockingHeadersResponse | void>)[] = [];
  const messageHs: ((msg: unknown, sender: MessageSender) => unknown)[] = [];
  const commandHs: ((name: string) => void)[] = [];
  const actionClickedHs: ((tab: Tab) => void)[] = [];
  let activeTab: Tab | null = null;
  let badgeText = "";
  const cookieStore = new Map<string, Map<string, Cookie>>(); // storeId -> name -> cookie
  const registeredScripts: RegisterContentScriptDetails[] = [];
  // storage.local. Lives on the BROWSER, not the background session — it is what a restart
  // is allowed to still find. Held as JSON text, as the real one is.
  const stored = new Map<string, string>();

  function makeTab(props: TabProps): Tab {
    const id = ++tabId;
    const tab: Tab = {
      id,
      // No url means "the browser's new-tab page", as the real tabs.create does, and the
      // only legal way to land on about:newtab.
      url: props.url ?? "about:newtab",
      cookieStoreId: props.cookieStoreId,
      index: props.index ?? id,
      active: props.active ?? true,
      openerTabId: props.openerTabId,
      // Firefox always reports a window; a test that does not care gets the one window. A
      // tab created WITHOUT a windowId lands in the current window, which was the popup bug:
      // the reopen omitted it and the replacement left the popup.
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
      beforeRequestHs.push(h);
    },
    onBeforeNavigate(h) {
      beforeNavigateHs.push(h);
    },
    async getTab(id) {
      return openTabs.get(id) ?? null;
    },
    async createTab(props) {
      openedTabs.push(props);
      if (createTabThrows) throw new Error("createTab failed");
      // Fidelity guard: Firefox refuses privileged about: URLs from an extension ("Illegal
      // URL: about:newtab"), about:blank excepted. A mock that accepted them let auto-temp
      // ship a containerize() that always threw in Firefox while L3 stayed green.
      if (props.url?.startsWith("about:") && props.url !== "about:blank") {
        throw new Error(`Illegal URL: ${props.url}`);
      }
      const tab = makeTab(props);
      // real Firefox fires onCreated synchronously during tabs.create
      for (const h of onTabCreatedHs) h(tab);
      return tab;
    },
    async removeTab(id) {
      closedTabIds.push(id);
      const wasOpen = openTabs.delete(id);
      // Firefox fires tabs.onRemoved for a tab closed through tabs.remove just as for one
      // the user closed. Without this a tab CC itself closed — a reopen superseding its
      // source, a stranded redirector — was invisible to every onTabRemoved listener, so the
      // disposer never learned the container it emptied had gone empty.
      if (wasOpen) for (const h of onTabRemovedHs) h(id);
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
      onTabCreatedHs.push(h);
    },
    onTabRemoved(h) {
      onTabRemovedHs.push(h);
    },
    onTabUpdated(h) {
      onTabUpdatedHs.push(h);
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
      headersHs.push(h);
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
      if (registerScriptThrows !== null) throw new Error(registerScriptThrows);
      registeredScripts.push(details);
      // Removed by identity rather than by value: a config may name the same snippet twice,
      // and unregistering one handle must leave the other injecting.
      return {
        unregister: async () => {
          const at = registeredScripts.indexOf(details);
          if (at !== -1) registeredScripts.splice(at, 1);
        },
      };
    },
    onMessage(h) {
      messageHs.push(h);
    },
    onCommand(h) {
      commandHs.push(h);
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
      actionClickedHs.push(h);
    },
    async setBadge(text) {
      badgeText = text;
    },
    async readStored(key) {
      // Round-trips through JSON like the real storage, so a test cannot pass by handing
      // back the object the caller still holds.
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
      if (beforeRequestHs.length === 0) throw new Error("no onBeforeRequest handler registered");
      // Firefox calls every blocking listener and merges the results, a cancel from any one
      // winning. CC registers exactly one effective handler — the engine's, through wiring's
      // gate, pinned by `test/fitness/listeners.test.ts` — so "first listener with something
      // to say answers" is a faithful enough merge, and it lets a retired session's gated
      // handler return undefined and stand aside.
      let response: BlockingResponse | void = undefined;
      for (const h of beforeRequestHs) {
        const r = await h(d);
        if (r && response === undefined) response = r;
      }
      return response;
    },
    startsNavigating(d) {
      if (beforeNavigateHs.length === 0) throw new Error("no onBeforeNavigate handler registered");
      for (const h of beforeNavigateHs) h({ frameId: 0, ...d });
    },
    async sendsHeaders(d) {
      if (headersHs.length === 0) throw new Error("no onBeforeSendHeaders handler registered");
      let edits: BlockingHeadersResponse | void = undefined;
      for (const h of headersHs) {
        const r = await h(d);
        if (r && edits === undefined) edits = r;
      }
      return edits;
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
    // A getter: `badgeText` is reassigned on every set, so exposing its value here would
    // freeze a test's view at construction time.
    get badgeText() {
      return badgeText;
    },
    existingTab: makeTab,
    addContainerNamed: (props) => makeIdentity({ name: props.name, color: props.color ?? "blue", icon: props.icon ?? "circle" }),
    async opensTab(props) {
      const tab = makeTab(props);
      for (const h of onTabCreatedHs) h(tab);
      await flushMicrotasks();
      return tab;
    },
    async closesTab(tab) {
      openTabs.delete(tab.id);
      for (const h of onTabRemovedHs) h(tab.id);
      await flushMicrotasks();
    },
    async updatesTab(tab, info) {
      // Reflect the updated tab into the mock's map so getTab sees the new URL.
      openTabs.set(tab.id, tab);
      for (const h of onTabUpdatedHs) h(tab, info);
      await flushMicrotasks();
    },
    macAssigns: (url, value) => void macMap.set(url, value),
    macIsAbsent: (on) => void (macThrows = on),
    tabCreationFails: (on) => void (createTabThrows = on),
    scriptRegistrationFails: (message) => void (registerScriptThrows = message),
    cookieIn: (storeId, name) => cookieStore.get(storeId)?.get(name) ?? null,
    async receivesMessage(msg, from) {
      if (messageHs.length === 0) throw new Error("no onMessage handler registered");
      // The one event where a second listener is a bug in Firefox too: an async handler
      // returns a Promise for EVERY message it sees and claims the reply channel from the
      // sibling that was addressed. Hence `wireBackground`'s single registration and its
      // synchronous `undefined`, modelled here as "the first listener with an answer replies".
      for (const h of messageHs) {
        const reply = await h(msg, { tabId: from?.id });
        if (reply !== undefined) return reply;
      }
      return undefined;
    },
    async receivesCommand(name) {
      for (const h of commandHs) h(name);
      await flushMicrotasks();
    },
    async clicksAction(tab) {
      for (const h of actionClickedHs) h(tab);
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
    // The same `now` the timers are scheduled against, so a stored deadline and a fired timer
    // cannot disagree about the time.
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
