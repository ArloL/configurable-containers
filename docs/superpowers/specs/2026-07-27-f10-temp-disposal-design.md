# F10 — Temporary-Container Disposal — Design

**Date:** 2026-07-27
**Status:** Implemented
**Topic:** Dispose a throwaway (`tmp…`) container when its last tab closes, after a
keep-alive grace, plus a garbage-collect sweep for orphans — mirroring TCP's
`cleanup.ts`. Proven at L3 (mock `browser.*` + fake clock) and confirmed once in
real Firefox (L4).

## 1. Goal & scope

The L3 engine creates temporary containers (reopen into `tmp…`) but never disposes
them — L4 confirmed they pile up. This slice adds the missing half of the temp
lifecycle: **remove a `tmp…` container once it has no tabs**, without ever touching
permanent or user containers.

Disposal is **keep-alive**: when a temp's last tab closes it is *not* removed
immediately; it lingers for a grace window (~5 min) so a reopened-closed-tab
(Ctrl+Shift+T restores the tab into its original `cookieStoreId`) lands back in a
live container. Only if it is still empty when the grace elapses is it removed. This
matches how TCP behaves today; there is **no active reuse** (a brand-new navigation
is not routed back into a recently-closed temp — that would be an L1 change and is
out of scope).

### In scope

- A new `disposer` module (`src/engine/disposer.ts`), a sibling of the engine wired
  at the extension entry.
- Two triggers → one removal path: **targeted** (last tab of a temp closes → grace →
  remove if still empty) and **GC sweep** (interval + startup → queue every temp,
  remove the empty ones; catches orphans).
- `BrowserPort` additions (`onTabCreated`, `onTabRemoved`, `queryTabs`,
  `removeIdentity`) and an injected `Clock` for deterministic timing.
- L3 table-driven tests against the mock port + a fake clock.
- One L4 real-Firefox confirmation (short-grace build).

### Out of scope (deferred)

- **Active reuse** — routing a new navigation back into a recently-closed temp (L1).
- **Configurable grace** via user config — fixed/injected constant here.
- **MV3 timer persistence** (F8) — MV2's background is persistent, so timers survive
  between events; the GC startup sweep is the orphan safety net.
- **History / cookie clearing on disposal** — TCP does it; we only remove the container.

## 2. Architecture & model

A new **`disposer`** owns temp-container lifecycle. It makes no routing decisions and
only ever removes `tmp…`-named containers. It is a **sibling** of the interception
engine — both are wired at the extension entry (`background.ts`), not nested — which
keeps `engine.ts` untouched and lets routing and lifecycle be tested independently.

```
   tabs.onCreated  ─────────────►  tabContainer: Map<tabId, cookieStoreId>   (best-effort)
   tabs.onRemoved  ──┐                       │ which container did the closed tab leave?
                     ▼                        ▼
              maybeQueue(csid) ── tmp? ──►  addToRemoveQueue(csid, GRACE)
                                                 │ injected clock: wait GRACE (~5 min)
   clock (interval) ──► sweep() ──────────────► │ (startup sweep uses skipDelay=0)
   (+ startup sweep)     (all tmp ids)           ▼
                                              tryRemove(csid):
                                                queryTabs({csid}) still empty?
                                                  → removeIdentity(csid)   else no-op (kept alive)
```

**Two triggers, one removal path:**
- **Targeted (tab close):** last tab leaves a `tmp` container → queue it with the
  grace delay. Keep-alive *is* the delay; cancel-on-reentry *is* the empty re-check
  in `tryRemove`.
- **GC sweep (interval + startup):** queue every `tmp` container; each removed only if
  empty. Catches orphans (restart lost the in-memory timers/map, or a missed event).
  Startup uses `skipDelay` so stale temps from a previous session go immediately.

**Dedup:** a `queued: Set<cookieStoreId>` prevents double-queuing (a tab-close and a
sweep racing on the same container).

**Determinism:** an injected `Clock` drives the grace delay and the GC interval, so
L3 tests `advance(ms)` instead of waiting.

## 3. `BrowserPort` additions + the `Clock`

```ts
export interface BrowserPort {
  // … existing methods …
  onTabCreated(handler: (tab: Tab) => void): void;      // tabs.onCreated
  onTabRemoved(handler: (tabId: number) => void): void; // tabs.onRemoved
  queryTabs(filter: { cookieStoreId?: string }): Promise<Tab[]>; // tabs.query
  removeIdentity(cookieStoreId: string): Promise<void>; // contextualIdentities.remove
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}
```

Real adapter (`browser-port.ts`), all mechanical:
```ts
onTabCreated(h)       → browser.tabs.onCreated.addListener((t) => h(mapTab(t)));
onTabRemoved(h)       → browser.tabs.onRemoved.addListener((id) => h(id));
queryTabs(f)          → (await browser.tabs.query(f)).map(mapTab);
removeIdentity(csid)  → { try { await browser.contextualIdentities.remove(csid); } catch {} }
```
`removeIdentity` swallows "already gone". `mapTab` is the field-mapping the existing
`getTab`/`createTab` already do, factored into a shared helper.

**Default `Clock`** (production, in `browser-port.ts`): thin wrappers over the global
`setTimeout`/`clearTimeout`. **Test clock:** records `{ dueAt, fn }` per timer and
exposes `advance(ms)` that fires everything due in order, including timers a fired
callback re-schedules (so the self-rescheduling GC loop advances). The GC **interval**
is a self-rescheduling `setTimeout`, so `Clock` stays two methods.

## 4. Disposer algorithm (`disposer.ts`)

```ts
import type { BrowserPort, Clock, Tab } from "./port";
import { TMP_PREFIX } from "./registry";

const GC_INTERVAL_MS = 600_000; // 10 min, matches TCP

export interface DisposerOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number; // keep-alive window (~5 min)
}

export function createDisposer(opts: DisposerOptions): void {
  const { port, clock, graceMs } = opts;
  const tabContainer = new Map<number, string>(); // tabId -> cookieStoreId (best-effort trigger)
  const queued = new Set<string>();               // dedup

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

  async function sweep(skipDelay: boolean): Promise<void> {
    const ids = (await port.queryIdentities())
      .filter((c) => c.name.startsWith(TMP_PREFIX))
      .map((c) => c.cookieStoreId);
    for (const csid of ids) void maybeQueue(csid, skipDelay ? 0 : graceMs);
  }

  void (async () => {
    for (const tab of await port.queryTabs({})) tabContainer.set(tab.id, tab.cookieStoreId);
    await sweep(true); // orphans from a previous session go now
    const tick = () => { void sweep(false); clock.setTimeout(tick, GC_INTERVAL_MS); };
    clock.setTimeout(tick, GC_INTERVAL_MS);
  })();
}
```

Key cases: last-tab-close → grace → remove; reopen-closed-tab within grace → re-check
non-empty → kept; reopen flow's abandoned temp → removed; restart orphan → startup
`sweep(true)` removes immediately; non-tmp → never queued; double trigger → `queued`
dedup.

**Accepted edge:** the `createIdentity`→`createTab` window during a reopen leaves a
brand-new temp momentarily empty; with the grace delay the tab exists long before the
timer fires, and only a `skipDelay` sweep (startup) is immediate — and startup is
never mid-reopen. Safe.

## 5. Testing

**Mock additions** (`mock-port.ts`): `onTabCreated`/`onTabRemoved` handlers +
`emitTabCreated(tab)` / `emitTabRemoved(id)` drivers; `queryTabs({cookieStoreId?})`
filtering the tabs map; `removeIdentity(csid)` (delete + record). Plus
`createFakeClock(): { clock, advance(ms), pending() }`.

**L3** (`test/engine/disposer.test.ts`):
- **grace disposal** — one tmp tab; `emitTabRemoved`; `advance(graceMs-1)` → not
  removed; `advance(1)` → `removeIdentity` once.
- **keep-alive / reentry** — remove the tmp tab; before grace, `addTab` back into the
  container; `advance(graceMs)` → not removed.
- **only tmp** — last tab of a permanent/user container closes → never removed.
- **not-yet-empty** — two tabs; remove one; `advance` → not removed.
- **GC orphan** — seed an empty tmp; no tab-close; `advance(GC_INTERVAL_MS)` → removed.
- **startup sweep** — pre-existing empty tmp at construction; `advance(0)` → removed.
- **dedup** — tab-close + GC tick on the same container → exactly one `removeIdentity`.

**L4** (`test/e2e/disposal.test.ts`): needs (1) to observe removal — extend the probe
to also write the live container-name list into a `data-cc-containers` DOM attribute
(harness `readContainerList(driver)`); and (2) a short grace —
`buildExtension({ graceMs })` injects an esbuild `define` (`__CC_GRACE_MS__`, default
300000), the test builds CC with `graceMs: 500`.

Flow: `launch({extensions:["probe","cc"]})` → nav `nomatch.example` →
`awaitContainerTab` gives the `tmp` store+name → **close that tab** → poll
(re-navigate the default tab to refresh the probe's list) until the `tmp` name is gone
from `readContainerList`, within a few seconds.

Regression guard: all L1–L3 units, the routing e2e, and plumbing stay green.

## 6. File structure

```
src/engine/
  disposer.ts        NEW — createDisposer()
  port.ts            MODIFY — +onTabCreated/onTabRemoved/queryTabs/removeIdentity, +Clock
  browser-port.ts    MODIFY — implement the 4 methods; default Clock; shared mapTab
  engine.ts          UNCHANGED
src/extension/
  background.ts      MODIFY — also createDisposer({ port, clock: realClock, graceMs: __CC_GRACE_MS__ })
harness/
  build-extension.ts MODIFY — buildExtension({ graceMs? }) → define __CC_GRACE_MS__ (default 300000)
  firefox.ts         MODIFY — +readContainerList(driver)
extensions/probe/
  background.js       MODIFY — also write the container-name list into data-cc-containers
test/engine/
  mock-port.ts        MODIFY — tab emitters, queryTabs, removeIdentity, createFakeClock
  disposer.test.ts    NEW — L3 scenarios
test/e2e/
  disposal.test.ts    NEW — L4 confirmation
```

`realClock` (default in `browser-port.ts`) wraps the global `setTimeout`/`clearTimeout`;
`background.ts` declares `declare const __CC_GRACE_MS__: number;` (esbuild substitutes it).

## 7. Risks

| Risk | Mitigation |
|---|---|
| **L4 real timing** — `contextualIdentities.remove` + `queryTabs`-after-close propagation | Short test grace (500 ms) + poll `readContainerList` with a timeout; assert eventual absence. |
| **Production timers on MV2** | MV2 background is persistent; grace/GC timers survive between events. On a future MV3 migration they'd be lost — the GC startup sweep is the safety net (F8). |
| **`removeIdentity` racing a tab about to enter** | The `queryTabs` re-check in `tryRemove` is authoritative; the reopen's `createTab` completes long before any grace timer. |
| **Probe list report breaking CSID title** | Only a new DOM attribute is added; the `CSID:` title format is untouched. |

## 8. What this slice does *not* prove

Active reuse of recently-closed temps (L1), configurable grace, MV3 timer persistence
(F8), and history/cookie clearing on disposal. It proves the temp lifecycle is now
*closed*: throwaways are removed once empty, after a keep-alive grace, without touching
permanent or user containers — deterministically (L3) and once for real (L4).
