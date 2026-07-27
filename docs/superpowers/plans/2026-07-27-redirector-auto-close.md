# Redirector Auto-Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close a `redirector`-rule tab after a short delay (~2s) **iff it is still
stranded on the shim domain** — the third TC carry-over alongside the `cookies` and
`scripts` overlays (F12 redirector side). Full parity with TCP's
`maybeCloseRedirectorTab`.

**Architecture:** A new **`redirector-closer`** owns one `tabs.onUpdated` listener,
wired at `background.ts` as a **sibling** of the engine, disposer, cookie-seeder, and
script-injector (not nested). A pure `isRedirectorUrl(url, config, matchRule)` decides
whether a URL is on a shim domain; the closer schedules a delayed close and re-checks
the tab's URL before closing — only a tab *still* on a redirector domain is closed.
Routing (`resolve`/`engine.ts`) is untouched — the `redirector` action already returns
`stay`, so the tab loads normally and the closer independently observes the result.

**Tech Stack:** TypeScript (ESM), Vitest, esbuild, Selenium/geckodriver, `@types/firefox-webext-browser`.

**Design spec:** `docs/superpowers/specs/2026-07-27-redirector-auto-close-design.md`

## Global Constraints

- **Do not change** `src/resolver/resolve.ts`, `src/engine/engine.ts`,
  `src/engine/registry.ts`, `src/engine/disposer.ts`, `src/engine/cookie-seeder.ts`,
  or `src/engine/script-injector.ts`. This slice **adds** a pure overlay module + a
  closer sibling + a port seam; it does not alter routing, disposal, or cookie/script
  overlays.
- **F12 (timing):** the close fires on `clock.setTimeout` after `status: 'complete'`;
  the close **never** fires before the delay, and the re-check after the delay skips the
  close if the tab navigated onward.
- **Conditional close:** the close is the *only* effect, and only when the tab is still
  on a redirector domain. A tab that redirected onward in-place is never closed.
- **No manifest change:** `tabs` permission is already in `extensions/cc/manifest.json`.
- **No parser change:** `redirector: true` is already parsed into `{ kind: "redirector" }`
  by `src/config/parse.ts`.
- **Keep `fileParallelism: false`** (do not touch `vitest.config.ts`).
- **Use CLI long options** (`--run`, `--save-dev`).
- **Commit after every task.**

---

### Task 1: Pure overlay core (`isRedirectorUrl`)

**Files:**
- Create: `src/overlays/redirector.ts`
- Test: `test/overlays/redirector.test.ts`

**Interfaces:**
- Consumes: `Config`, `Deps` from `src/resolver/types`.
- Produces: `isRedirectorUrl(url: string, config: Config, matchRule: Deps["matchRule"]): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/overlays/redirector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isRedirectorUrl } from "../../src/overlays/redirector";
import { matchRule } from "../../src/matcher/matcher";
import { parseConfig } from "../../src/config/parse";

const config = parseConfig(`
rules:
  - match: t.co
    redirector: true
  - match: pocket.example
    ignore: true
  - match: login.example
    inherit: true
  - match: work.example
    open: Work
  - match: example
    open: Broad
`);

describe("isRedirectorUrl", () => {
  it("returns true for a URL matching a redirector rule", () => {
    expect(isRedirectorUrl("https://t.co/abc", config, matchRule)).toBe(true);
  });

  it("returns false for a URL matching no rule", () => {
    expect(isRedirectorUrl("https://nomatch.test/", config, matchRule)).toBe(false);
  });

  it("returns false for a URL matching an ignore rule", () => {
    expect(isRedirectorUrl("https://pocket.example/", config, matchRule)).toBe(false);
  });

  it("returns false for a URL matching an inherit rule", () => {
    expect(isRedirectorUrl("https://login.example/", config, matchRule)).toBe(false);
  });

  it("returns false for a URL matching an open rule", () => {
    expect(isRedirectorUrl("https://work.example/", config, matchRule)).toBe(false);
  });

  it("honours first-match precedence (redirector above broad open)", () => {
    // t.co is a redirector rule above the broad `example` open rule; redirector wins.
    expect(isRedirectorUrl("https://t.co/abc", config, matchRule)).toBe(true);
  });

  it("returns false when a broad open rule shadows a redirector below it", () => {
    const c = parseConfig(`
rules:
  - match: example
    open: Broad
  - match: t.co
    redirector: true
`);
    // `example` matches t.co? No — bare-host `example` matches *.example, not t.co.
    // So t.co still hits the redirector rule. This is just first-match precedence:
    // a URL that matches BOTH a broad open (above) and a redirector (below) resolves
    // to the broad open (first-match) → false.
    expect(isRedirectorUrl("https://sub.example/", c, matchRule)).toBe(false);
    expect(isRedirectorUrl("https://t.co/x", c, matchRule)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run test/overlays/redirector.test.ts`
Expected: FAIL — cannot resolve `../../src/overlays/redirector`.

- [ ] **Step 3: Implement `src/overlays/redirector.ts`**

```ts
// Pure overlay core: does this URL match a redirector rule? No browser, no I/O.
// Consumed by the redirector-closer (src/engine/redirector-closer.ts). Routed through
// the SAME injected matchRule as the router, so the auto-close can never drift from
// routing precedence. See the redirector-auto-close design spec §3.
import type { Config, Deps } from "../resolver/types";

// True iff the first matching rule's action is `redirector`. Returns false for
// no-match and for every other action (open / inherit / ignore).
export function isRedirectorUrl(
  url: string,
  config: Config,
  matchRule: Deps["matchRule"],
): boolean {
  const rule = matchRule(url, config.rules);
  return !!rule && rule.action.kind === "redirector";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run test/overlays/redirector.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/overlays/redirector.ts test/overlays/redirector.test.ts
git commit -m "feat(overlays): pure isRedirectorUrl check for the redirector auto-close"
```

---

### Task 2: Port seam — `onTabUpdated` + `TabUpdateInfo`

**Files:**
- Modify: `src/engine/port.ts`
- Modify: `src/engine/browser-port.ts`
- Modify: `test/engine/mock-port.ts`
- Test: `test/engine/browser-port.test.ts`

**Interfaces:**
- Produces types in `port.ts`: `TabUpdateInfo`.
- Produces (on `BrowserPort`): `onTabUpdated(handler: (tab: Tab, info: TabUpdateInfo) => void): void`.
- Produces on the mock (`test/engine/mock-port.ts`): `emitTabUpdated(tab: Tab, info: TabUpdateInfo): Promise<void>`.

- [ ] **Step 1: Add the seam type + method to `src/engine/port.ts`**

Add the `TabUpdateInfo` interface just before the `Tab` interface:

```ts
// The subset of tabs.onUpdated's changeInfo the port surface exposes.
export interface TabUpdateInfo {
  status?: "loading" | "complete";
}
```

Add the method to the `BrowserPort` interface (after `onTabRemoved`, in the F10 block):

```ts
  onTabUpdated(handler: (tab: Tab, info: TabUpdateInfo) => void): void;
```

- [ ] **Step 2: Write the failing adapter test (extend `test/engine/browser-port.test.ts`)**

First extend the `fakeBrowser()` factory in `test/engine/browser-port.test.ts`. Add an
`onUpdated` block inside the existing `tabs` object (alongside the `onCreated` /
`onRemoved` listeners the disposer wired). Find the `tabs:` block and add `onUpdated`
beside the existing `onCreated`/`onRemoved`:

```ts
      onUpdated: {
        addListener(fn: (id: number, info: unknown, tab: unknown) => void) {
          f.tabs.onUpdated_last = fn;
        },
        onUpdated_last: null as unknown,
      },
```

Then add this test case inside the `describe("createBrowserPort", ...)` block:

```ts
  it("onTabUpdated maps tab + changeInfo to the handler", () => {
    const port = createBrowserPort();
    let seen: { tab: unknown; info: unknown } | null = null;
    port.onTabUpdated((tab, info) => { seen = { tab, info }; });

    const fn = f.tabs.onUpdated_last as (id: number, info: unknown, raw: unknown) => void;
    fn(3, { status: "complete" }, { id: 3, url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true });

    expect(seen).toEqual({
      tab: { id: 3, url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true, openerTabId: undefined },
      info: { status: "complete" },
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest --run test/engine/browser-port.test.ts`
Expected: FAIL — `port.onTabUpdated` is not implemented.

- [ ] **Step 4: Implement the method in `src/engine/browser-port.ts`**

Add `TabUpdateInfo` to the existing `import type { … } from "./port"` block, then add
the method to the object returned by `createBrowserPort()` (after `onTabRemoved`):

```ts
    onTabUpdated(handler) {
      browser.tabs.onUpdated.addListener((_id, info, tab) => handler(mapTab(tab), { status: info.status }));
    },
```

- [ ] **Step 5: Implement the method in the mock (`test/engine/mock-port.ts`)**

Add `TabUpdateInfo` to the existing `import type { … } from "../../src/engine/port"` block.

Add `emitTabUpdated` to the `MockPort` interface (after `emitTabRemoved`):

```ts
  emitTabUpdated(tab: Tab, info: TabUpdateInfo): Promise<void>;
```

Inside `createMockPort()`, add state near the other `let`s:

```ts
  let onTabUpdatedH: ((tab: Tab, info: TabUpdateInfo) => void) | null = null;
```

add the method to the `port` object (after `onTabRemoved`):

```ts
    onTabUpdated(h) {
      onTabUpdatedH = h;
    },
```

and expose the driver in the returned object (after `emitTabRemoved`):

```ts
    async emitTabUpdated(tab, info) {
      // Reflect the updated tab into the mock's tabs map so getTab sees the new URL.
      tabs.set(tab.id, tab);
      onTabUpdatedH?.(tab, info);
      await flushMicrotasks();
    },
```

- [ ] **Step 6: Run the adapter test + typecheck**

Run: `npx vitest --run test/engine/browser-port.test.ts`
Expected: PASS (original tests + 1 new).

Run: `npm run typecheck`
Expected: no errors. (The mock now satisfies the widened `BrowserPort`; the existing
engine/disposer/seeder tests that build a mock are unaffected.)

- [ ] **Step 7: Run the engine + disposer + seeder + injector suites (no regression)**

Run: `npx vitest --run test/engine`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/port.ts src/engine/browser-port.ts test/engine/mock-port.ts test/engine/browser-port.test.ts
git commit -m "feat(engine): port seam for tabs.onUpdated"
```

---

### Task 3: The redirector-closer (L3)

**Files:**
- Create: `src/engine/redirector-closer.ts`
- Test: `test/engine/redirector-closer.test.ts`

**Interfaces:**
- Consumes: `BrowserPort`, `Clock`, `Tab`, `TabUpdateInfo` from `src/engine/port`;
  `Config`, `Deps` from `src/resolver/types`; `isRedirectorUrl` from
  `src/overlays/redirector`.
- Produces: `createRedirectorCloser(opts: RedirectorCloserOptions): void` where
  `RedirectorCloserOptions = { port: BrowserPort; clock: Clock; config: Config; deps: Pick<Deps, "matchRule">; delayMs?: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/engine/redirector-closer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort, createFakeClock } from "./mock-port";
import { createRedirectorCloser } from "../../src/engine/redirector-closer";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";
import type { Tab } from "../../src/engine/port";

const DELAY = 2000;

const config = parseConfig(`
rules:
  - match: t.co
    redirector: true
  - match: work.example
    open: Work
`);

function makeTab(over: Partial<Tab> = {}): Tab {
  return { id: 1, url: "https://t.co/abc", cookieStoreId: "firefox-default", index: 0, active: true, ...over };
}

describe("redirector-closer", () => {
  it("closes a redirector tab after the delay if it is still on the shim", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "complete" });
    await fc.advance(DELAY - 1);
    expect(mp.calls.removeTab).toEqual([]); // not yet
    await fc.advance(1);
    expect(mp.calls.removeTab).toEqual([tab.id]); // closed after the delay
  });

  it("does NOT close a tab that navigated onward before the delay", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "complete" });
    // Tab navigates onward to work.example (non-redirector) before the delay fires.
    await mp.emitTabUpdated(makeTab({ id: tab.id, url: "https://work.example/" }), { status: "complete" });
    await fc.advance(DELAY * 2);
    expect(mp.calls.removeTab).toEqual([]); // never closed — moved on
  });

  it("does NOT close a non-redirector tab", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "https://work.example/", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "complete" });
    await fc.advance(DELAY * 2);
    expect(mp.calls.removeTab).toEqual([]); // not a redirector — no timer
  });

  it("does NOT close when the tab is gone before the timer fires", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "complete" });
    await mp.emitTabRemoved(tab.id); // tab closed (e.g. by the engine's reopen) before the delay
    await fc.advance(DELAY * 2);
    expect(mp.calls.removeTab).toEqual([tab.id]); // the emitTabRemoved removal, not the closer's
  });

  it("ignores loading status", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "loading" });
    await fc.advance(DELAY * 2);
    expect(mp.calls.removeTab).toEqual([]);
  });

  it("ignores non-http(s) URLs", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "complete" });
    await fc.advance(DELAY * 2);
    expect(mp.calls.removeTab).toEqual([]);
  });

  it("schedules no double-close when complete fires twice on the same redirector tab", async () => {
    const mp = createMockPort();
    const fc = createFakeClock();
    const tab = mp.addTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    createRedirectorCloser({ port: mp.port, clock: fc.clock, config, deps: { matchRule }, delayMs: DELAY });

    await mp.emitTabUpdated(tab, { status: "complete" });
    await mp.emitTabUpdated(tab, { status: "complete" }); // reload — second timer
    await fc.advance(DELAY);
    // The first timer to fire closes the tab; the second finds getTab → null and returns.
    expect(mp.calls.removeTab).toEqual([tab.id]); // exactly one close
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest --run test/engine/redirector-closer.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/redirector-closer`.

- [ ] **Step 3: Implement `src/engine/redirector-closer.ts`**

```ts
import type { Config, Deps } from "../resolver/types";
import type { BrowserPort, Clock } from "./port";
import { isRedirectorUrl } from "../overlays/redirector";

const REDIRECTOR_DELAY_MS = 2000; // ~2s, matches TCP's closeRedirectorTabs.delay

export interface RedirectorCloserOptions {
  port: BrowserPort;
  clock: Clock;
  config: Config;
  deps: Pick<Deps, "matchRule">;
  delayMs?: number;
}

// A sibling of the engine, disposer, cookie-seeder, and script-injector (wired at
// background.ts, not nested). Owns one tabs.onUpdated listener. Mirrors TCP's
// maybeCloseRedirectorTab: when a tab completes loading on a redirector domain, wait
// the delay, then close it — but ONLY if it is still on a redirector domain (the re-check
// is the safety mechanism, not timer cancellation). A tab that redirected onward
// in-place is left alone (F12 conditional close).
export function createRedirectorCloser(opts: RedirectorCloserOptions): void {
  const { port, clock, config, deps, delayMs = REDIRECTOR_DELAY_MS } = opts;

  port.onTabUpdated((tab, info) => {
    if (info.status !== "complete") return;
    if (!/^https?:/.test(tab.url)) return;
    if (!isRedirectorUrl(tab.url, config, deps.matchRule)) return; // pure early-out

    const tabId = tab.id;
    clock.setTimeout(async () => {
      // Re-check: the tab may have redirected onward or been closed since.
      const current = await port.getTab(tabId);
      if (!current) return; // tab already closed — fine
      if (!isRedirectorUrl(current.url, config, deps.matchRule)) return; // moved on — leave it
      await port.removeTab(tabId); // still stranded — close
    }, delayMs);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest --run test/engine/redirector-closer.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/redirector-closer.ts test/engine/redirector-closer.test.ts
git commit -m "feat(engine): redirector-closer — TC-parity delayed conditional close"
```

---

### Task 4: Wire the closer into the extension + bundled redirector rule

**Files:**
- Modify: `src/extension/background.ts`
- Modify: `src/extension/config.ts`
- Modify: `test/extension/config.test.ts`
- Modify: `harness/build-extension.ts`
- Modify: `harness/firefox.ts`

- [ ] **Step 1: Add a redirector rule to the bundled config**

In `src/extension/config.ts`, change `BUNDLED_CONFIG_YAML` from:

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script', '1');" }
`;
```

to:

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script', '1');" }
  - match: redirect.example
    redirector: true
`;
```

- [ ] **Step 2: Extend the bundled-config test**

In `test/extension/config.test.ts`, add this test inside the `describe("bundled extension config", …)` block:

```ts
  it("carries a redirector rule on redirect.example", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    const rule = matchRule("https://redirect.example/", config.rules);
    expect(rule!.action).toEqual({ kind: "redirector" });
  });
```

- [ ] **Step 3: Run the config test**

Run: `npx vitest --run test/extension/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the redirector-delay define to the harness build**

In `harness/build-extension.ts`, change the `define` from:

```ts
    define: { __CC_GRACE_MS__: String(opts.graceMs ?? 300000) },
```

to:

```ts
    define: {
      __CC_GRACE_MS__: String(opts.graceMs ?? 300000),
      __CC_REDIRECTOR_DELAY_MS__: String(opts.redirectorDelayMs ?? 2000),
    },
```

and change the signature from:

```ts
export async function buildExtension(opts: { graceMs?: number } = {}): Promise<string> {
```

to:

```ts
export async function buildExtension(
  opts: { graceMs?: number; redirectorDelayMs?: number } = {},
): Promise<string> {
```

- [ ] **Step 5: Add `ccRedirectorDelayMs` to the harness launch options + resolve the shim domain**

In `harness/firefox.ts`, change `LaunchOptions` from:

```ts
export interface LaunchOptions {
  extensions?: ("probe" | "cc")[];
  ccGraceMs?: number; // grace passed to the cc build (default: production 300000)
}
```

to:

```ts
export interface LaunchOptions {
  extensions?: ("probe" | "cc")[];
  ccGraceMs?: number; // grace passed to the cc build (default: production 300000)
  ccRedirectorDelayMs?: number; // redirector-close delay (default: production 2000)
}
```

Change the `buildXpiFor` call inside `launch` from:

```ts
    if (ext === "cc") await buildExtension({ graceMs: opts.ccGraceMs });
```

to:

```ts
    if (ext === "cc") await buildExtension({ graceMs: opts.ccGraceMs, redirectorDelayMs: opts.ccRedirectorDelayMs });
```

Change the `localDomains` preference from:

```ts
  options.setPreference("network.dns.localDomains", "work.example,nomatch.example");
```

to:

```ts
  options.setPreference("network.dns.localDomains", "work.example,nomatch.example,redirect.example");
```

- [ ] **Step 6: Wire the closer in `src/extension/background.ts`**

Add the import:

```ts
import { createRedirectorCloser } from "../engine/redirector-closer";
```

Add the `declare` for the esbuild define beside `__CC_GRACE_MS__`:

```ts
declare const __CC_REDIRECTOR_DELAY_MS__: number;
```

and add the wiring after `createDisposer(...)`:

```ts
createRedirectorCloser({ port, clock: realClock, config, deps: { matchRule }, delayMs: __CC_REDIRECTOR_DELAY_MS__ });
```

- [ ] **Step 7: Typecheck (covers the background wiring + harness changes)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/extension/background.ts src/extension/config.ts test/extension/config.test.ts harness/build-extension.ts harness/firefox.ts
git commit -m "feat(extension): wire redirector-closer + redirector rule in bundled config"
```

---

### Task 5: L4 real-Firefox e2e (F12 redirector conditional close)

**Files:**
- Test: `test/e2e/redirector.test.ts`

**Interfaces:**
- Consumes: `launch`, `awaitContainerTab`, `type Session` from `harness/firefox`.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/redirector.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

describe("redirector auto-close (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"], ccRedirectorDelayMs: 200 });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  async function navFreshTab(url: string): Promise<void> {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC may reopen the tab away — expected for non-redirector hosts.
    }
  }

  // Poll window handles until none shows `url` (the tab was closed), or time out.
  async function waitForTabGone(url: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const handles = await session.driver.getAllWindowHandles();
      let present = false;
      for (const handle of handles) {
        try {
          await session.driver.switchTo().window(handle);
          if ((await session.driver.getCurrentUrl()).startsWith(url)) {
            present = true;
            break;
          }
        } catch {
          // handle closed mid-loop — skip.
        }
      }
      if (!present) return true; // gone
      await session.driver.sleep(100);
    }
    return false;
  }

  it("closes a redirector tab after the delay when it stays on the shim domain", async () => {
    const url = `http://redirect.example:${port}/`;
    await navFreshTab(url);
    // The redirector tab stays in whatever container it opened in (redirector → stay),
    // so it loads normally. After the short delay (200ms) the closer closes it.
    const gone = await waitForTabGone(url, 5000);
    expect(gone).toBe(true);
  });

  it("does NOT close a non-redirector tab after the same delay", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);
    // work.example routes to the Work container — awaitContainerTab leaves the driver
    // focused on the reopened Work tab.
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");
    // Wait well past the redirector delay; the Work tab must survive.
    await session.driver.sleep(1000);
    const stillThere = (await session.driver.getCurrentUrl()).startsWith(url);
    expect(stillThere).toBe(true);
  });
});
```

- [ ] **Step 2: Run the L4 test**

Run: `npx vitest --run test/e2e/redirector.test.ts`
Expected: PASS (2 tests). It launches real Firefox with CC + probe (short 200ms delay).
If it fails, debug against the spec §8 risks: confirm `network.dns.localDomains` resolves
`redirect.example`; confirm the closer's `onTabUpdated` fires on `complete`; confirm the
200ms delay + 5s poll window is enough. Do **not** weaken the assertions to make it pass.

- [ ] **Step 3: Run the full suite (regression)**

Run: `npx vitest --run`
Expected: all suites pass — unit (config, overlays, engine, matcher, psl, resolver),
extension unit, and the e2e (plumbing, routing, disposal, cookies, scripts, redirector).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/redirector.test.ts
git commit -m "test(e2e): L4 redirector auto-close — shim tab closed, non-redirector kept"
```

---

## Self-review notes (author)

- **Spec coverage:** §1 module/scope → Tasks 1,3,4; §2 sibling closer on `tabs.onUpdated`
  with re-check → Tasks 2,3,4; §3 pure core (`isRedirectorUrl`) → Task 1; §4 TC-parity
  algorithm (delayed conditional close, re-check is the safety mechanism) → Task 3 (incl.
  the "navigated onward" and "tab gone" tests); §5 port seam (`onTabUpdated` +
  `TabUpdateInfo`) → Task 2; §6 wiring (sibling, `realClock`, esbuild define) → Task 4;
  §7 testing (pure, L3 closer, L4 F12 redirector) → Tasks 1,3,5; §8 risks (close-before-
  delay, close-onward, cheap early-out, multiple timers, L4 timing) → Tasks 3,5. No spec
  section is unmapped.
- **F12 at L4 — mechanism:** the L4 test navigates to `redirect.example` (a redirector
  rule) and polls window handles until the tab is gone (within 5s of the 200ms delay).
  The negative case navigates to `work.example` (non-redirector, routes to Work) and
  asserts the tab survives 1s past the delay. This is the concrete realization of "close
  iff still stranded on the shim" — the only thing mocks can't prove is that real Firefox
  fires `tabs.onUpdated` with `status: 'complete'` and that `tabs.remove` actually closes
  the window handle.
- **Coexistence with the other siblings:** the bundled `redirect.example` rule carries
  ONLY `redirector: true` (no cookies/scripts), and `work.example` carries cookies +
  scripts but no redirector. The L4 test asserts the redirector tab closes AND the Work
  tab (with its overlays) survives — proving the closer doesn't interfere with the other
  siblings.
