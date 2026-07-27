import type {
  BlockingResponse,
  BrowserPort,
  Clock,
  ContextualIdentity,
  CreateIdentityProps,
  CreateTabProps,
  Tab,
  WebRequestDetails,
} from "../../src/engine/port";

const MAC_ID = "@testpilot-containers";

// Resolve after pending microtasks so floated async callbacks (maybeQueue/tryRemove) settle.
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export interface MockPort {
  port: BrowserPort;
  fire(d: WebRequestDetails): Promise<BlockingResponse | void>;
  tabs: Map<number, Tab>;
  identities: Map<string, ContextualIdentity>;
  calls: {
    createTab: CreateTabProps[];
    removeTab: number[];
    createIdentity: CreateIdentityProps[];
    removeIdentity: string[];
  };
  addTab(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Tab;
  addIdentity(props: { name: string; color?: string; icon?: string }): ContextualIdentity;
  emitTabCreated(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Promise<Tab>;
  emitTabRemoved(tabId: number): Promise<void>;
  setMacAssignment(url: string, value: unknown): void;
  setMacThrows(on: boolean): void;
  setCreateTabThrows(on: boolean): void;
}

export function createMockPort(): MockPort {
  const tabs = new Map<number, Tab>();
  const identities = new Map<string, ContextualIdentity>();
  const macMap = new Map<string, unknown>();
  const calls = {
    createTab: [] as CreateTabProps[],
    removeTab: [] as number[],
    createIdentity: [] as CreateIdentityProps[],
    removeIdentity: [] as string[],
  };

  let tabId = 0;
  let containerId = 0;
  let macThrows = false;
  let createTabThrows = false;
  let handler: ((d: WebRequestDetails) => Promise<BlockingResponse | void>) | null = null;
  let onTabCreatedH: ((tab: Tab) => void) | null = null;
  let onTabRemovedH: ((tabId: number) => void) | null = null;

  function makeTab(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Tab {
    const id = ++tabId;
    const tab: Tab = {
      id,
      url: props.url,
      cookieStoreId: props.cookieStoreId,
      index: props.index ?? id,
      active: props.active ?? true,
      openerTabId: props.openerTabId,
    };
    tabs.set(id, tab);
    return tab;
  }

  function makeIdentity(props: CreateIdentityProps): ContextualIdentity {
    const cookieStoreId = `firefox-container-${++containerId}`;
    const ci: ContextualIdentity = { cookieStoreId, name: props.name, color: props.color, icon: props.icon };
    identities.set(cookieStoreId, ci);
    return ci;
  }

  const port: BrowserPort = {
    onBeforeRequest(h) {
      handler = h;
    },
    async getTab(id) {
      return tabs.get(id) ?? null;
    },
    async createTab(props) {
      calls.createTab.push(props);
      if (createTabThrows) throw new Error("createTab failed");
      return makeTab(props);
    },
    async removeTab(id) {
      calls.removeTab.push(id);
      tabs.delete(id);
    },
    async queryIdentities() {
      return [...identities.values()];
    },
    async createIdentity(props) {
      calls.createIdentity.push(props);
      return makeIdentity(props);
    },
    async getIdentity(cookieStoreId) {
      return identities.get(cookieStoreId) ?? null;
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
    async queryTabs(filter) {
      const all = [...tabs.values()];
      return filter.cookieStoreId ? all.filter((t) => t.cookieStoreId === filter.cookieStoreId) : all;
    },
    async removeIdentity(cookieStoreId) {
      calls.removeIdentity.push(cookieStoreId);
      identities.delete(cookieStoreId);
    },
  };

  return {
    port,
    async fire(d) {
      if (!handler) throw new Error("no onBeforeRequest handler registered");
      return handler(d);
    },
    tabs,
    identities,
    calls,
    addTab: makeTab,
    addIdentity: (props) => makeIdentity({ name: props.name, color: props.color ?? "blue", icon: props.icon ?? "circle" }),
    async emitTabCreated(props) {
      const tab = makeTab(props);
      onTabCreatedH?.(tab);
      await flushMicrotasks();
      return tab;
    },
    async emitTabRemoved(id) {
      tabs.delete(id);
      onTabRemovedH?.(id);
      await flushMicrotasks();
    },
    setMacAssignment: (url, value) => void macMap.set(url, value),
    setMacThrows: (on) => void (macThrows = on),
    setCreateTabThrows: (on) => void (createTabThrows = on),
  };
}

export function createFakeClock(): { clock: Clock; advance(ms: number): Promise<void>; pending(): number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { dueAt: number; fn: () => void }>();
  const clock: Clock = {
    setTimeout(fn, ms) {
      timers.set(++seq, { dueAt: now + ms, fn });
    },
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
