# F10 — Temporary-Container Disposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispose a `tmp…` container once it has no tabs, after a keep-alive grace, plus a GC sweep for orphans — proven at L3 (mock + fake clock) and confirmed once in real Firefox.

**Architecture:** A new `createDisposer` module, a sibling of the engine wired at the extension entry (`background.ts`). Tab-close (targeted, grace-delayed) and an interval/startup sweep (GC) both funnel into one "remove if still empty" path, driven by an injected `Clock`. Mirrors TCP's `cleanup.ts`.

**Tech Stack:** TypeScript (ESM), Vitest, Selenium/geckodriver, esbuild.

**Design spec:** `docs/superpowers/specs/2026-07-27-f10-temp-disposal-design.md`

## Global Constraints

- **Only `tmp…`-named containers are ever removed.** Never touch `firefox-default`, permanent, or user containers.
- **`engine.ts`, `registry.ts`, `resolver/`, `matcher/`, `psl/`, `config/` do not change.** F10 adds a sibling disposer + port methods.
- **Keep-alive is the grace delay; cancel-on-reentry is the empty re-check** in `tryRemove` (no timer cancellation needed).
- **The `queryTabs` re-check is authoritative**; the `tabContainer` map is a best-effort trigger only.
- **Determinism:** all timing goes through the injected `Clock`; tests use a fake clock and never wait on wall-clock.
- **Probe `CSID:<store>` title format is unchanged** — the container list is a separate DOM attribute; plumbing/routing e2e must stay green.
- **Tests are plain Vitest `describe`/`it`/`expect`** — no Gherkin.
- **`GC_INTERVAL_MS = 600000` (10 min); default production grace `300000` (5 min).**
- **Commit after every task.** End each commit message body with:
  `Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN`

---

### Task 1: Port additions, `Clock`, mock support + fake clock

**Files:**
- Modify: `src/engine/port.ts`
- Modify: `test/engine/mock-port.ts`
- Test: `test/engine/mock-port.test.ts`

**Interfaces:**
- Produces (`port.ts`): `BrowserPort` gains `onTabCreated(handler: (tab: Tab) => void): void`, `onTabRemoved(handler: (tabId: number) => void): void`, `queryTabs(filter: { cookieStoreId?: string }): Promise<Tab[]>`, `removeIdentity(cookieStoreId: string): Promise<void>`; new `interface Clock { setTimeout(fn: () => void, ms: number): void }`.
- Produces (`mock-port.ts`): mock `port` implements the 4 new methods; `MockPort` gains `emitTabCreated(props): Promise<Tab>`, `emitTabRemoved(tabId): Promise<void>`, `calls.removeIdentity: string[]`; new `export function createFakeClock(): { clock: Clock; advance(ms: number): Promise<void>; pending(): number }`.

- [ ] **Step 1: Add the port methods + Clock to `src/engine/port.ts`**

Add the four methods inside the `BrowserPort` interface (after `sendExternalMessage`):

```ts
  // F10 — temp-container disposal.
  onTabCreated(handler: (tab: Tab) => void): void;
  onTabRemoved(handler: (tabId: number) => void): void;
  queryTabs(filter: { cookieStoreId?: string }): Promise<Tab[]>;
  removeIdentity(cookieStoreId: string): Promise<void>;
```

Add the `Clock` interface at the end of the file. It is a single method returning
`void` — the disposer only ever *schedules* timers (it never cancels; keep-alive is
the empty re-check, not a cancellation), and a `void` return avoids the
`@types/node` `setTimeout`-returns-`Timeout` friction in `realClock`. (This
simplifies the spec's two-method sketch — `clearTimeout` is unused.)

```ts
// Injected timing seam so grace/GC delays are deterministic in tests.
export interface Clock {
  setTimeout(fn: () => void, ms: number): void;
}
```

- [ ] **Step 2: Write the failing mock/clock test**

Append to `test/engine/mock-port.test.ts`:

```ts
import { createFakeClock } from "./mock-port";

describe("mock port — disposal support", () => {
  it("emitTabCreated adds a tab and fires onTabCreated; queryTabs filters by store", async () => {
    const mp = createMockPort();
    const seen: number[] = [];
    mp.port.onTabCreated((t) => seen.push(t.id));
    const t = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: "firefox-container-1" });
    expect(seen).toEqual([t.id]);
    expect(await mp.port.queryTabs({ cookieStoreId: "firefox-container-1" })).toHaveLength(1);
    expect(await mp.port.queryTabs({ cookieStoreId: "firefox-container-2" })).toHaveLength(0);
    expect(await mp.port.queryTabs({})).toHaveLength(1);
  });

  it("emitTabRemoved removes the tab and fires onTabRemoved", async () => {
    const mp = createMockPort();
    const removed: number[] = [];
    mp.port.onTabRemoved((id) => removed.push(id));
    const t = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: "firefox-default" });
    await mp.emitTabRemoved(t.id);
    expect(removed).toEqual([t.id]);
    expect(await mp.port.queryTabs({})).toHaveLength(0);
  });

  it("removeIdentity deletes the identity and records the call", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: "tmp1" });
    await mp.port.removeIdentity(ci.cookieStoreId);
    expect(await mp.port.getIdentity(ci.cookieStoreId)).toBeNull();
    expect(mp.calls.removeIdentity).toEqual([ci.cookieStoreId]);
  });

  it("fake clock fires timers only once their delay elapses", async () => {
    const fc = createFakeClock();
    const fired: string[] = [];
    fc.clock.setTimeout(() => fired.push("a"), 100);
    await fc.advance(99);
    expect(fired).toEqual([]);
    await fc.advance(1);
    expect(fired).toEqual(["a"]);
  });

  it("fake clock fires re-scheduled timers within the same advance window", async () => {
    const fc = createFakeClock();
    const fired: number[] = [];
    const tick = () => { fired.push(fired.length); if (fired.length < 3) fc.clock.setTimeout(tick, 10); };
    fc.clock.setTimeout(tick, 10);
    await fc.advance(100);
    expect(fired).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/engine/mock-port.test.ts`
Expected: FAIL — `createFakeClock` / `emitTabCreated` not exported.

- [ ] **Step 4: Implement the mock additions in `test/engine/mock-port.ts`**

Add this module-level helper near the top (after the imports):

```ts
import type { /* existing… */ BrowserPort, Clock } from "../../src/engine/port";

// Resolve after pending microtasks so floated async callbacks (maybeQueue/tryRemove) settle.
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
```

In `createMockPort`, add handler slots and the call log entry:

```ts
  let onTabCreatedH: ((tab: Tab) => void) | null = null;
  let onTabRemovedH: ((tabId: number) => void) | null = null;
```
and extend the `calls` object with `removeIdentity: [] as string[]`.

Add these to the `port` object:

```ts
    onTabCreated(h) { onTabCreatedH = h; },
    onTabRemoved(h) { onTabRemovedH = h; },
    async queryTabs(filter) {
      const all = [...tabs.values()];
      return filter.cookieStoreId ? all.filter((t) => t.cookieStoreId === filter.cookieStoreId) : all;
    },
    async removeIdentity(cookieStoreId) {
      calls.removeIdentity.push(cookieStoreId);
      identities.delete(cookieStoreId);
    },
```

Add these to the returned `MockPort` object (and to the `MockPort` interface):

```ts
    async emitTabCreated(props) {
      const tab = makeTab(props);
      onTabCreatedH?.(tab);
      await flushMicrotasks();
      return tab;
    },
    async emitTabRemoved(tabId) {
      tabs.delete(tabId);
      onTabRemovedH?.(tabId);
      await flushMicrotasks();
    },
```

`MockPort` interface additions:
```ts
  emitTabCreated(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Promise<Tab>;
  emitTabRemoved(tabId: number): Promise<void>;
```
and in `calls`: `removeIdentity: string[];`.

Append the fake clock at the end of `mock-port.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/engine/mock-port.test.ts`
Expected: PASS (all mock-port tests, including the 5 new ones).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/port.ts test/engine/mock-port.ts test/engine/mock-port.test.ts
git commit -m "feat(engine): BrowserPort tab-lifecycle methods + Clock; mock fake clock

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 2: Disposer core — targeted grace disposal

**Files:**
- Create: `src/engine/disposer.ts`
- Test: `test/engine/disposer.test.ts`

**Interfaces:**
- Consumes: `BrowserPort`, `Clock`, `Tab` from `port.ts`; `TMP_PREFIX` from `registry.ts`; `createMockPort`, `createFakeClock` from `mock-port.ts`.
- Produces: `interface DisposerOptions { port: BrowserPort; clock: Clock; graceMs: number }`; `function createDisposer(opts: DisposerOptions): void`.
- Note: this task implements tab tracking + the targeted tab-close path (`maybeQueue`/`tryRemove`/`isTmp`). The GC `sweep` + startup are added in Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/engine/disposer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort, createFakeClock } from "./mock-port";
import { createDisposer } from "../../src/engine/disposer";

const GRACE = 300_000;

function setup() {
  const mp = createMockPort();
  const fc = createFakeClock();
  return { mp, fc };
}

describe("disposer — targeted grace disposal", () => {
  it("removes a tmp container after its last tab closes + grace elapses", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });

    await mp.emitTabRemoved(tab.id);
    await fc.advance(GRACE - 1);
    expect(mp.calls.removeIdentity).toEqual([]); // not yet
    await fc.advance(1);
    expect(mp.calls.removeIdentity).toEqual([tmp.cookieStoreId]);
  });

  it("keep-alive: a tab returning within the grace prevents removal", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });

    await mp.emitTabRemoved(tab.id);
    await fc.advance(GRACE / 2);
    await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId }); // reopened
    await fc.advance(GRACE);
    expect(mp.calls.removeIdentity).toEqual([]); // still has a tab
  });

  it("never removes a permanent/user container", async () => {
    const { mp, fc } = setup();
    const work = mp.addIdentity({ name: "Work" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: work.cookieStoreId });

    await mp.emitTabRemoved(tab.id);
    await fc.advance(GRACE * 2);
    expect(mp.calls.removeIdentity).toEqual([]);
  });

  it("does not remove while other tabs remain in the container", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    const a = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });
    await mp.emitTabCreated({ url: "https://b.test/", cookieStoreId: tmp.cookieStoreId });

    await mp.emitTabRemoved(a.id);
    await fc.advance(GRACE * 2);
    expect(mp.calls.removeIdentity).toEqual([]); // one tab still there
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/disposer.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/disposer`.

- [ ] **Step 3: Implement `src/engine/disposer.ts`**

Create `src/engine/disposer.ts`:

```ts
import type { BrowserPort, Clock } from "./port";
import { TMP_PREFIX } from "./registry";

export interface DisposerOptions {
  port: BrowserPort;
  clock: Clock;
  graceMs: number; // keep-alive window
}

// Removes tmp containers once empty. A sibling of the engine — no routing. GC sweep
// + startup are added in a later step; this is the targeted tab-close path.
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
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/disposer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/disposer.ts test/engine/disposer.test.ts
git commit -m "feat(engine): disposer — targeted grace disposal of empty tmp containers

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 3: Disposer — GC sweep + startup

**Files:**
- Modify: `src/engine/disposer.ts`
- Test: `test/engine/disposer.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 2, plus `port.queryIdentities`.
- Produces: `createDisposer` now also seeds `tabContainer` from `queryTabs({})` at startup, immediately sweeps orphans (`skipDelay`), and starts a self-rescheduling GC sweep every `GC_INTERVAL_MS`.

- [ ] **Step 1: Write the failing test**

Append to `test/engine/disposer.test.ts`:

```ts
const GC_INTERVAL_MS = 600_000;

describe("disposer — GC sweep + startup", () => {
  it("startup sweep removes a pre-existing empty tmp container immediately", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" }); // exists, no tabs
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    await fc.advance(0); // startup sweep uses skipDelay (0ms)
    expect(mp.calls.removeIdentity).toEqual([tmp.cookieStoreId]);
  });

  it("startup sweep leaves a permanent container alone", async () => {
    const { mp, fc } = setup();
    mp.addIdentity({ name: "Work" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    await fc.advance(0);
    expect(mp.calls.removeIdentity).toEqual([]);
  });

  it("periodic GC removes an orphaned empty tmp container after the interval", async () => {
    const { mp, fc } = setup();
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    await fc.advance(0); // clear startup sweep (nothing to remove)
    const tmp = mp.addIdentity({ name: "tmp9" }); // appears later, no tab-close event
    await fc.advance(GC_INTERVAL_MS + GRACE);
    expect(mp.calls.removeIdentity).toEqual([tmp.cookieStoreId]);
  });

  it("dedup: a tab-close and a GC tick on the same container remove it once", async () => {
    const { mp, fc } = setup();
    const tmp = mp.addIdentity({ name: "tmp1" });
    createDisposer({ port: mp.port, clock: fc.clock, graceMs: GRACE });
    await fc.advance(0);
    const tab = await mp.emitTabCreated({ url: "https://a.test/", cookieStoreId: tmp.cookieStoreId });
    await mp.emitTabRemoved(tab.id);
    await fc.advance(GC_INTERVAL_MS + GRACE); // both the grace timer and a GC tick elapse
    expect(mp.calls.removeIdentity).toEqual([tmp.cookieStoreId]); // exactly one
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/disposer.test.ts`
Expected: FAIL — the startup/GC tests fail (no sweep yet; `removeIdentity` empty).

- [ ] **Step 3: Add sweep + startup to `src/engine/disposer.ts`**

Add the constant at the top (below imports):

```ts
const GC_INTERVAL_MS = 600_000; // 10 min, matches TCP
```

Add `sweep` inside `createDisposer` (after `tryRemove`):

```ts
  async function sweep(skipDelay: boolean): Promise<void> {
    const ids = (await port.queryIdentities())
      .filter((c) => c.name.startsWith(TMP_PREFIX))
      .map((c) => c.cookieStoreId);
    for (const csid of ids) void maybeQueue(csid, skipDelay ? 0 : graceMs);
  }
```

Add the startup block at the very end of `createDisposer`:

```ts
  void (async () => {
    for (const tab of await port.queryTabs({})) tabContainer.set(tab.id, tab.cookieStoreId);
    await sweep(true); // orphans from a previous session go now
    const tick = (): void => {
      void sweep(false);
      clock.setTimeout(tick, GC_INTERVAL_MS);
    };
    clock.setTimeout(tick, GC_INTERVAL_MS);
  })();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/disposer.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/disposer.ts test/engine/disposer.test.ts
git commit -m "feat(engine): disposer — GC sweep + startup orphan cleanup

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 4: Real `browser-port` additions + `realClock`

**Files:**
- Modify: `src/engine/browser-port.ts`
- Test: `test/engine/browser-port.test.ts` (append)

**Interfaces:**
- Produces: `createBrowserPort()` now implements `onTabCreated`, `onTabRemoved`, `queryTabs`, `removeIdentity`; new `export const realClock: Clock`.

- [ ] **Step 1: Write the failing test**

Append to `test/engine/browser-port.test.ts` — extend the `fakeBrowser()` object (add to its `tabs` and `contextualIdentities`):

```ts
// add inside fakeBrowser().tabs:
      onCreated: { addListener: (fn: (t: unknown) => void) => { f.tabs.onCreated_fn = fn; }, onCreated_fn: null as unknown },
      onRemoved: { addListener: (fn: (id: number) => void) => { f.tabs.onRemoved_fn = fn; }, onRemoved_fn: null as unknown },
      query: async (info: { cookieStoreId?: string }) => (info.cookieStoreId === "firefox-container-2"
        ? [{ id: 3, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true }]
        : []),
// add inside fakeBrowser().contextualIdentities:
      remove: async (csid: string) => { f.contextualIdentities.removed = csid; return { cookieStoreId: csid, name: "tmp1", color: "blue", icon: "circle" }; },
```
(Add matching `removed: null as unknown` and the `onCreated_fn`/`onRemoved_fn` fields to the fake object literal so TypeScript knows them.)

Then add a describe block:

```ts
describe("createBrowserPort — disposal methods", () => {
  it("onTabCreated forwards a mapped tab; onTabRemoved forwards the id", async () => {
    const port = createBrowserPort();
    const created: number[] = [];
    const removed: number[] = [];
    port.onTabCreated((t) => created.push(t.id));
    port.onTabRemoved((id) => removed.push(id));
    (f.tabs.onCreated_fn as (t: unknown) => void)({ id: 5, url: "https://a/", cookieStoreId: "firefox-default", index: 0, active: true });
    (f.tabs.onRemoved_fn as (id: number) => void)(5);
    expect(created).toEqual([5]);
    expect(removed).toEqual([5]);
  });

  it("queryTabs maps results; removeIdentity delegates", async () => {
    const port = createBrowserPort();
    expect(await port.queryTabs({ cookieStoreId: "firefox-container-2" })).toHaveLength(1);
    expect(await port.queryTabs({ cookieStoreId: "firefox-container-9" })).toHaveLength(0);
    await port.removeIdentity("firefox-container-2");
    expect(f.contextualIdentities.removed).toBe("firefox-container-2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/browser-port.test.ts`
Expected: FAIL — the new methods aren't implemented.

- [ ] **Step 3: Implement in `src/engine/browser-port.ts`**

Add a shared `mapTab` helper at module scope (above `createBrowserPort`) and reuse it in `getTab`/`createTab` (replace their inline object literals with `return mapTab(t, ...)` where a fallback url/store is needed — keep the existing fallback semantics):

```ts
function mapTab(t: browser.tabs.Tab): Tab {
  return {
    id: t.id!, url: t.url ?? "", cookieStoreId: t.cookieStoreId ?? "firefox-default",
    index: t.index, active: t.active, openerTabId: t.openerTabId,
  };
}
```

Add the four methods to the returned object:

```ts
    onTabCreated(handler) {
      browser.tabs.onCreated.addListener((t) => handler(mapTab(t)));
    },
    onTabRemoved(handler) {
      browser.tabs.onRemoved.addListener((tabId) => handler(tabId));
    },
    async queryTabs(filter) {
      return (await browser.tabs.query(filter)).map(mapTab);
    },
    async removeIdentity(cookieStoreId) {
      try {
        await browser.contextualIdentities.remove(cookieStoreId);
      } catch {
        /* already gone — fine */
      }
    },
```

Add `Clock` to the import and export `realClock` at the end of the file:

```ts
import type {
  BrowserPort, Clock, ContextualIdentity, CreateIdentityProps, CreateTabProps, Tab, WebRequestDetails,
} from "./port";

// Production clock: schedules on the extension's global timer (return value unused).
export const realClock: Clock = {
  setTimeout: (fn, ms) => {
    globalThis.setTimeout(fn, ms);
  },
};
```

Note: keep `getTab`/`createTab` using `mapTab` but preserve the `t.url ?? p.url` / `t.cookieStoreId ?? p.cookieStoreId` fallback in `createTab` (map then overwrite, or inline) — do not regress the existing browser-port tests.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/browser-port.test.ts`
Expected: PASS (existing 6 + 2 new).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/browser-port.ts test/engine/browser-port.test.ts
git commit -m "feat(engine): real BrowserPort tab-lifecycle methods + realClock

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 5: esbuild `graceMs` define + wire disposer into background

**Files:**
- Modify: `harness/build-extension.ts`
- Modify: `src/extension/background.ts`
- Test: `test/extension/build.test.ts` (append)

**Interfaces:**
- Produces: `buildExtension(opts?: { graceMs?: number }): Promise<string>` — injects `define: { __CC_GRACE_MS__: String(opts?.graceMs ?? 300000) }`.
- Consumes: `createDisposer` from `disposer.ts`; `realClock` from `browser-port.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/extension/build.test.ts`:

```ts
it("injects the grace constant and bundles the disposer", async () => {
  const outfile = await buildExtension({ graceMs: 1234 });
  const code = readFileSync(outfile, "utf8");
  expect(code).toContain("1234"); // __CC_GRACE_MS__ substituted
  expect(code).toContain("removeIdentity"); // disposer wired in
});

it("defaults the grace to 300000 when unspecified", async () => {
  const outfile = await buildExtension();
  expect(readFileSync(outfile, "utf8")).toContain("300000");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extension/build.test.ts`
Expected: FAIL — `buildExtension` takes no options; `__CC_GRACE_MS__`/disposer not present.

- [ ] **Step 3: Update `harness/build-extension.ts`**

```ts
export async function buildExtension(opts: { graceMs?: number } = {}): Promise<string> {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: OUTFILE,
    format: "iife",
    platform: "browser",
    target: "firefox115",
    logLevel: "silent",
    define: { __CC_GRACE_MS__: String(opts.graceMs ?? 300000) },
  });
  return OUTFILE;
}
```

- [ ] **Step 4: Update `src/extension/background.ts`**

Replace its contents with:

```ts
import { createEngine } from "../engine/engine";
import { createDisposer } from "../engine/disposer";
import { createBrowserPort, realClock } from "../engine/browser-port";
import { parseConfig } from "../config/parse";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { BUNDLED_CONFIG_YAML } from "./config";

// Injected at bundle time by esbuild (harness/build-extension.ts).
declare const __CC_GRACE_MS__: number;

const port = createBrowserPort();

createEngine({
  port,
  config: parseConfig(BUNDLED_CONFIG_YAML),
  deps: { matchRule, matchGroup, sameSite },
  onChoice: () => {}, // no picker UI in this slice; the bundled config has no choice rule
});

createDisposer({ port, clock: realClock, graceMs: __CC_GRACE_MS__ });
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run test/extension/build.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add harness/build-extension.ts src/extension/background.ts test/extension/build.test.ts
git commit -m "feat(extension): wire disposer into background; esbuild grace define

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 6: Harness — short-grace build option + container-list observation

**Files:**
- Modify: `harness/firefox.ts`
- Modify: `extensions/probe/background.js`

**Interfaces:**
- Produces (`firefox.ts`): `launch(opts?: { extensions?: ("probe"|"cc")[]; ccGraceMs?: number })` (the `ccGraceMs` is passed to `buildExtension` for the cc build); `readContainerList(driver: WebDriver): Promise<string[]>`.

- [ ] **Step 1: Thread `ccGraceMs` through `launch` in `harness/firefox.ts`**

Extend `LaunchOptions` and `buildXpiFor`:

```ts
export interface LaunchOptions {
  extensions?: ("probe" | "cc")[];
  ccGraceMs?: number; // grace passed to the cc build (default: production 300000)
}
```

Change `buildXpiFor` to accept the grace and pass it to `buildExtension`:

```ts
async function buildXpiFor(ext: "probe" | "cc", ccGraceMs?: number): Promise<{ xpiPath: string; cleanup: () => void }> {
  if (ext === "cc") await buildExtension({ graceMs: ccGraceMs });
  return zipDir(EXT_DIRS[ext]);
}
```

In `launch`, pass it through:

```ts
  for (const ext of extensions) {
    xpis.push(await buildXpiFor(ext, opts.ccGraceMs));
  }
```

Add the observation helper (near `readContainerName`):

```ts
// Read the live container-name list the probe wrote into the current tab's DOM.
export async function readContainerList(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-containers') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}
```

- [ ] **Step 2: Extend the probe to report the container list**

In `extensions/probe/background.js`, update `reportTab` to also query and write the full container-name list (the `CSID:` title stays unchanged):

```js
async function reportTab(tabId, cookieStoreId) {
  let name = "";
  try {
    name = (await browser.contextualIdentities.get(cookieStoreId)).name;
  } catch (_e) {
    // firefox-default has no identity — leave name empty.
  }
  let list = "";
  try {
    list = (await browser.contextualIdentities.query({})).map((c) => c.name).join(",");
  } catch (_e) {
    // ignore
  }
  try {
    await browser.tabs.executeScript(tabId, {
      code:
        "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";" +
        "document.documentElement.setAttribute('data-cc-container', " + JSON.stringify(name) + ");" +
        "document.documentElement.setAttribute('data-cc-containers', " + JSON.stringify(list) + ");",
    });
  } catch (_e) {
    // non-injectable page — ignore.
  }
}
```

- [ ] **Step 3: Typecheck + regression (plumbing & routing unaffected)**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run test/e2e/plumbing.test.ts test/e2e/routing.test.ts`
Expected: PASS (probe title format + default launch unchanged; needs system Firefox — defer to CI if geckodriver unavailable locally).

- [ ] **Step 4: Commit**

```bash
git add harness/firefox.ts extensions/probe/background.js
git commit -m "feat(harness): short-grace cc build option + container-list observation

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 7: L4 disposal e2e

**Files:**
- Test: `test/e2e/disposal.test.ts`

**Interfaces:**
- Consumes: `launch`, `awaitContainerTab`, `readContainerList`, `type Session` from `harness/firefox.ts`.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/disposal.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, readContainerList, type Session } from "../../harness/firefox";

describe("temp disposal (real Firefox)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    // Short grace so the keep-alive window elapses quickly in the test.
    session = await launch({ extensions: ["probe", "cc"], ccGraceMs: 500 });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("removes a tmp container after its last tab closes", async () => {
    // Route an unmatched host into a fresh tmp container.
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(`http://nomatch.example:${port}/`);
    } catch {
      /* CC reopened the tab away */
    }
    const { name } = await awaitContainerTab(session.driver, `http://nomatch.example:${port}/`);
    expect(name).toMatch(/^tmp/);

    // Close the tmp tab (we are currently switched to it via awaitContainerTab).
    await session.driver.close();

    // Poll: re-navigate a default tab to refresh the probe's list until the tmp is gone.
    const deadline = Date.now() + 15_000;
    let gone = false;
    while (Date.now() < deadline) {
      await session.driver.switchTo().newWindow("tab");
      await session.driver.get(session.serverUrl); // 127.0.0.1 — no rule matches, but default store; probe reports the list
      if (!(await readContainerList(session.driver)).includes(name)) {
        gone = true;
        break;
      }
      await session.driver.sleep(500);
    }
    expect(gone).toBe(true);
  });
});
```

- [ ] **Step 2: Run the L4 test**

Run: `npx vitest run test/e2e/disposal.test.ts`
Expected: PASS. This launches real Firefox with a 500 ms grace; the tmp container should disappear within a couple of seconds of closing its tab. If it flakes, widen the poll deadline or confirm the probe list refreshes (the `session.serverUrl` nav is `127.0.0.1`, which has no rule — it will itself reopen into a *new* tmp, but that's a different name; the assertion only checks the original `tmp` name is absent). Do not weaken the assertion.

Note: `session.serverUrl` (`127.0.0.1`) is unmatched, so refreshing the list also spawns a throwaway. If that proves noisy, refresh instead by navigating to a **matched** host (`http://work.example:${port}/`, which lands in the permanent "Work" container) so the refresh tab does not create tmps.

- [ ] **Step 3: Full suite (regression)**

Run: `npx vitest run`
Expected: all suites pass — L1–L3 units, disposer unit tests, extension unit tests, plumbing, routing, and the new disposal e2e.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/disposal.test.ts
git commit -m "test(e2e): L4 — tmp container disposed after its last tab closes

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

## Self-review notes (author)

- **Spec coverage:** §2 model → Tasks 2/3; §3 port + Clock → Tasks 1/4; §4 algorithm (tab tracking, maybeQueue, tryRemove, sweep, startup) → Tasks 2/3; §5 testing (mock+fake clock, L3 scenarios, L4) → Tasks 1/2/3/7; §6 files → all tasks; probe list + short-grace build → Tasks 5/6/7. No spec section unmapped.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `createDisposer`/`DisposerOptions`, `Clock`, `realClock`, `buildExtension({graceMs})`, `launch({ccGraceMs})`, `readContainerList`, `emitTabCreated`/`emitTabRemoved`/`createFakeClock`, `__CC_GRACE_MS__` are used identically across tasks.
- **Refresh-tab caveat (Task 7):** navigating `127.0.0.1` to refresh the probe list itself spawns a tmp; the assertion checks only the *original* tmp name's absence, and the fallback (refresh via `work.example`) avoids the noise if needed.
- **Determinism:** L3 (Tasks 1–5) is fully deterministic (fake clock); Tasks 6–7 need real Firefox and defer to CI where geckodriver is unavailable.
```
