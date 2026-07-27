import type { BrowserPort, Clock } from "./port";
import { TMP_PREFIX } from "./registry";

const GC_INTERVAL_MS = 600_000; // 10 min, matches TCP

export interface DisposerOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number; // keep-alive window
}

// Removes tmp containers once empty. A sibling of the engine — no routing. The GC
// sweep + startup are added in a later step; this is the targeted tab-close path.
export function createDisposer(opts: DisposerOptions): void {
  const { port, clock, graceMs } = opts;
  const tabContainer = new Map<number, string>(); // tabId -> cookieStoreId (best-effort trigger)
  const queued = new Set<string>(); // dedup

  port.onTabCreated((tab) => tabContainer.set(tab.id, tab.cookieStoreId));
  port.onTabRemoved((tabId) => {
    const csid = tabContainer.get(tabId);
    tabContainer.delete(tabId);
    if (csid) void maybeQueue(csid, graceMs);
  });

  async function isTmp(cookieStoreId: string): Promise<boolean> {
    if (cookieStoreId === "firefox-default") return false;
    const ci = await port.getIdentity(cookieStoreId);
    return !!ci && ci.name.startsWith(TMP_PREFIX);
  }

  async function maybeQueue(cookieStoreId: string, delayMs: number): Promise<void> {
    if (queued.has(cookieStoreId)) return;
    if (!(await isTmp(cookieStoreId))) return; // never touch default/permanent/user
    queued.add(cookieStoreId);
    clock.setTimeout(() => {
      queued.delete(cookieStoreId);
      void tryRemove(cookieStoreId);
    }, delayMs);
  }

  async function tryRemove(cookieStoreId: string): Promise<void> {
    const tabs = await port.queryTabs({ cookieStoreId });
    if (tabs.length === 0) await port.removeIdentity(cookieStoreId);
  }

  // GC: queue every tmp container (removed only if empty). skipDelay => immediate
  // (startup / orphans from a previous session or a missed event).
  async function sweep(skipDelay: boolean): Promise<void> {
    const ids = (await port.queryIdentities())
      .filter((c) => c.name.startsWith(TMP_PREFIX))
      .map((c) => c.cookieStoreId);
    for (const csid of ids) void maybeQueue(csid, skipDelay ? 0 : graceMs);
  }

  void (async () => {
    for (const tab of await port.queryTabs({})) tabContainer.set(tab.id, tab.cookieStoreId);
    await sweep(true); // orphans from a previous session go now
    const tick = (): void => {
      void sweep(false);
      clock.setTimeout(tick, GC_INTERVAL_MS);
    };
    clock.setTimeout(tick, GC_INTERVAL_MS);
  })();
}
