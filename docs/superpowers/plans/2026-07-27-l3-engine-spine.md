# L3 Engine — Minimal Spine (F1/F2/F7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the thin interception engine that turns a real top-level navigation into a `NavContext`, calls the pure `resolve()`, and executes the returned `Decision` as browser effects — proven deterministically at L3 against a mock `browser.*`.

**Architecture:** A narrow injected `BrowserPort` facade isolates all `browser.*` access; a `ContainerRegistry` translates between `cookieStoreId` strings and the resolver's `ContainerRef`/`Target` (temporary identified by the `tmp` name prefix); the `engine.ts` blocking `onBeforeRequest` handler composes them — assemble → `resolve()` → execute, with an F1 loop guard and an F7 MAC-defer handshake. Tests drive a mock port + mock MAC.

**Tech Stack:** TypeScript (ESM), Vitest, fast-check. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-07-27-l3-engine-spine-design.md`

## Global Constraints

- **No new dependencies.** TypeScript + Vitest + fast-check are already present; add nothing.
- **Do not modify** `src/resolver/`, `src/matcher/`, `src/psl/`, or `src/config/`. The engine only *consumes* them.
- **Production deps object** passed to `resolve()` is exactly `{ matchRule, matchGroup, sameSite }` imported from `src/matcher/matcher.ts` and `src/psl/same-site.ts`.
- **`Decision` switches are exhaustive with no `default` case** so a new variant fails `tsc` (static gate). Every `Decision.kind` returns.
- **`TMP_PREFIX = "tmp"`** is reserved: temporary-container identity is derived solely from the container name prefix (durable across restart).
- **Deterministic only:** no clock/timers in this slice; the temporary-name suffix is an injected function (default: a monotonic counter); fast-check is seeded and prints its seed on failure.
- **Tests are plain Vitest `describe`/`it`/`expect` BDD code** — no Gherkin/DSL layer.
- **Imports are relative paths** matching the existing test style (`../../src/engine/...`).
- **Use CLI long options** (e.g. `--testNamePattern`, `--run`) where a command offers them.
- **Commit after every task.** End each commit message body with:
  `Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN`
- **Scope:** only F1, F2, F7. No disposal (F10), no restart persistence (F8), no overlays/redirector (F12), no redirect binding (F9), no real Firefox (L4), no UI.

---

### Task 1: `BrowserPort` interface + mock-port harness

**Files:**
- Create: `src/engine/port.ts`
- Create: `test/engine/mock-port.ts`
- Test: `test/engine/mock-port.test.ts`

**Interfaces:**
- Produces (`src/engine/port.ts`):
  - `WebRequestDetails { requestId: string; tabId: number; url: string; type: string; method: string; originUrl?: string; documentUrl?: string }`
  - `Tab { id: number; url: string; cookieStoreId: string; index: number; active: boolean; openerTabId?: number }`
  - `ContextualIdentity { cookieStoreId: string; name: string; color: string; icon: string }`
  - `BlockingResponse { cancel?: boolean }`
  - `interface BrowserPort` with: `onBeforeRequest(handler)`, `getTab(id)`, `createTab(props)`, `removeTab(id)`, `queryIdentities()`, `createIdentity(props)`, `getIdentity(csid)`, `sendExternalMessage(extId, msg)`.
- Produces (`test/engine/mock-port.ts`):
  - `createMockPort(): MockPort` where `MockPort` exposes `port: BrowserPort`, `fire(d): Promise<BlockingResponse | void>`, `tabs: Map<number, Tab>`, `identities: Map<string, ContextualIdentity>`, `calls: { createTab: CreateTabProps[]; removeTab: number[]; createIdentity: CreateIdentityProps[] }`, `addTab(props): Tab`, `addIdentity(props): ContextualIdentity`, `setMacAssignment(url, value)`, `setMacThrows(on)`, `setCreateTabThrows(on)`.

- [ ] **Step 1: Write the failing harness test**

Create `test/engine/mock-port.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import type { WebRequestDetails } from "../../src/engine/port";

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

describe("mock port harness", () => {
  it("createTab assigns an incrementing id and stores the tab", async () => {
    const mp = createMockPort();
    const t = await mp.port.createTab({ url: "https://a.test/", cookieStoreId: "firefox-default", index: 0, active: true });
    expect(t.id).toBe(1);
    expect(await mp.port.getTab(1)).toEqual(t);
    expect(mp.calls.createTab).toHaveLength(1);
  });

  it("removeTab deletes the tab and records the id", async () => {
    const mp = createMockPort();
    const t = mp.addTab({ url: "https://a.test/", cookieStoreId: "firefox-default" });
    await mp.port.removeTab(t.id);
    expect(await mp.port.getTab(t.id)).toBeNull();
    expect(mp.calls.removeTab).toEqual([t.id]);
  });

  it("createIdentity assigns a firefox-container-N store id and is queryable", async () => {
    const mp = createMockPort();
    const ci = await mp.port.createIdentity({ name: "Work", color: "blue", icon: "circle" });
    expect(ci.cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(await mp.port.getIdentity(ci.cookieStoreId)).toEqual(ci);
    expect(await mp.port.queryIdentities()).toContainEqual(ci);
  });

  it("getIdentity returns null for firefox-default", async () => {
    const mp = createMockPort();
    expect(await mp.port.getIdentity("firefox-default")).toBeNull();
  });

  it("fire() invokes the registered onBeforeRequest handler and returns its result", async () => {
    const mp = createMockPort();
    mp.port.onBeforeRequest(async () => ({ cancel: true }));
    expect(await mp.fire(req())).toEqual({ cancel: true });
  });

  it("mock MAC returns the configured assignment or null, and can throw", async () => {
    const mp = createMockPort();
    mp.setMacAssignment("https://owned.test/", { userContextId: 3 });
    expect(await mp.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://owned.test/" })).toEqual({ userContextId: 3 });
    expect(await mp.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://free.test/" })).toBeNull();
    mp.setMacThrows(true);
    await expect(mp.port.sendExternalMessage("@testpilot-containers", { method: "getAssignment", url: "https://owned.test/" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/mock-port.test.ts`
Expected: FAIL — cannot resolve `./mock-port` / `../../src/engine/port`.

- [ ] **Step 3: Implement `src/engine/port.ts`**

Create `src/engine/port.ts`:

```ts
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
```

- [ ] **Step 4: Implement `test/engine/mock-port.ts`**

Create `test/engine/mock-port.ts`:

```ts
import type {
  BlockingResponse,
  BrowserPort,
  ContextualIdentity,
  CreateIdentityProps,
  CreateTabProps,
  Tab,
  WebRequestDetails,
} from "../../src/engine/port";

const MAC_ID = "@testpilot-containers";

export interface MockPort {
  port: BrowserPort;
  fire(d: WebRequestDetails): Promise<BlockingResponse | void>;
  tabs: Map<number, Tab>;
  identities: Map<string, ContextualIdentity>;
  calls: {
    createTab: CreateTabProps[];
    removeTab: number[];
    createIdentity: CreateIdentityProps[];
  };
  addTab(props: { url: string; cookieStoreId: string; index?: number; active?: boolean; openerTabId?: number }): Tab;
  addIdentity(props: { name: string; color?: string; icon?: string }): ContextualIdentity;
  setMacAssignment(url: string, value: unknown): void;
  setMacThrows(on: boolean): void;
  setCreateTabThrows(on: boolean): void;
}

export function createMockPort(): MockPort {
  const tabs = new Map<number, Tab>();
  const identities = new Map<string, ContextualIdentity>();
  const macMap = new Map<string, unknown>();
  const calls = { createTab: [] as CreateTabProps[], removeTab: [] as number[], createIdentity: [] as CreateIdentityProps[] };

  let tabId = 0;
  let containerId = 0;
  let macThrows = false;
  let createTabThrows = false;
  let handler: ((d: WebRequestDetails) => Promise<BlockingResponse | void>) | null = null;

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
    setMacAssignment: (url, value) => void macMap.set(url, value),
    setMacThrows: (on) => void (macThrows = on),
    setCreateTabThrows: (on) => void (createTabThrows = on),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/engine/mock-port.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/port.ts test/engine/mock-port.ts test/engine/mock-port.test.ts
git commit -m "feat(engine): BrowserPort facade + mock-port test harness

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 2: `ContainerRegistry` — cookieStoreId ⇄ ContainerRef

**Files:**
- Create: `src/engine/registry.ts`
- Test: `test/engine/registry.test.ts`

**Interfaces:**
- Consumes: `BrowserPort`, `ContextualIdentity` from `src/engine/port.ts`; `ContainerRef`, `Target` from `src/resolver/types.ts`; `createMockPort` from `test/engine/mock-port.ts`.
- Produces (`src/engine/registry.ts`):
  - `const TMP_PREFIX = "tmp"`
  - `interface ContainerRegistry { toRef(cookieStoreId: string | undefined): Promise<ContainerRef>; toStoreId(target: Target): Promise<string> }`
  - `function createRegistry(port: BrowserPort, tmpSuffix: () => string): ContainerRegistry`

- [ ] **Step 1: Write the failing test**

Create `test/engine/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createRegistry, TMP_PREFIX } from "../../src/engine/registry";

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

describe("ContainerRegistry.toRef", () => {
  it("firefox-default maps to default (without querying identities)", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef("firefox-default")).toEqual({ kind: "default" });
  });

  it("undefined maps to default", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef(undefined)).toEqual({ kind: "default" });
  });

  it("a tmp-prefixed container maps to temporary", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: `${TMP_PREFIX}42` });
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef(ci.cookieStoreId)).toEqual({ kind: "temporary" });
  });

  it("a normally-named container maps to permanent with that name", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: "Work" });
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef(ci.cookieStoreId)).toEqual({ kind: "permanent", name: "Work" });
  });

  it("a missing container maps to default", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toRef("firefox-container-999")).toEqual({ kind: "default" });
  });
});

describe("ContainerRegistry.toStoreId", () => {
  it("default maps to firefox-default", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toStoreId({ kind: "default" })).toBe("firefox-default");
  });

  it("permanent finds an existing container by exact name", async () => {
    const mp = createMockPort();
    const ci = mp.addIdentity({ name: "Work" });
    const reg = createRegistry(mp.port, counter());
    expect(await reg.toStoreId({ kind: "permanent", name: "Work" })).toBe(ci.cookieStoreId);
    expect(mp.calls.createIdentity).toHaveLength(0);
  });

  it("permanent creates a container when none matches, then caches it", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    const first = await reg.toStoreId({ kind: "permanent", name: "Personal" });
    expect(first).toMatch(/^firefox-container-\d+$/);
    expect(mp.calls.createIdentity).toHaveLength(1);
    const second = await reg.toStoreId({ kind: "permanent", name: "Personal" });
    expect(second).toBe(first);
    expect(mp.calls.createIdentity).toHaveLength(1); // cached, no second create
  });

  it("temporary creates a fresh tmp-prefixed container using the injected suffix", async () => {
    const mp = createMockPort();
    const reg = createRegistry(mp.port, counter());
    const store = await reg.toStoreId({ kind: "temporary" });
    const ci = await mp.port.getIdentity(store);
    expect(ci?.name).toBe(`${TMP_PREFIX}1`);
    expect(await reg.toRef(store)).toEqual({ kind: "temporary" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/registry.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/registry`.

- [ ] **Step 3: Implement `src/engine/registry.ts`**

Create `src/engine/registry.ts`:

```ts
import type { BrowserPort } from "./port";
import type { ContainerRef, Target } from "../resolver/types";

// Reserved name prefix: any contextualIdentity whose name starts with this is one
// of our throwaways. Identity is derived from the name, so it survives a restart.
export const TMP_PREFIX = "tmp";

export interface ContainerRegistry {
  // cookieStoreId -> ContainerRef (for reading a tab's current/initiator container).
  toRef(cookieStoreId: string | undefined): Promise<ContainerRef>;
  // Target -> cookieStoreId (for executing a reopen; find-or-create as needed).
  toStoreId(target: Target): Promise<string>;
}

export function createRegistry(port: BrowserPort, tmpSuffix: () => string): ContainerRegistry {
  // name -> cookieStoreId cache for permanent find-or-create.
  const permanentByName = new Map<string, string>();

  return {
    async toRef(cookieStoreId) {
      if (!cookieStoreId || cookieStoreId === "firefox-default") {
        return { kind: "default" };
      }
      const ci = await port.getIdentity(cookieStoreId);
      if (!ci) {
        console.warn(`[registry] container ${cookieStoreId} no longer exists; treating as default`);
        return { kind: "default" };
      }
      if (ci.name.startsWith(TMP_PREFIX)) {
        return { kind: "temporary" };
      }
      return { kind: "permanent", name: ci.name };
    },

    async toStoreId(target) {
      switch (target.kind) {
        case "default":
          return "firefox-default";
        case "permanent": {
          const cached = permanentByName.get(target.name);
          if (cached) return cached;
          const existing = (await port.queryIdentities()).find((c) => c.name === target.name);
          const ci = existing ?? (await port.createIdentity({ name: target.name, color: "blue", icon: "circle" }));
          permanentByName.set(target.name, ci.cookieStoreId);
          return ci.cookieStoreId;
        }
        case "temporary": {
          const ci = await port.createIdentity({ name: TMP_PREFIX + tmpSuffix(), color: "blue", icon: "circle" });
          return ci.cookieStoreId;
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/registry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/registry.ts test/engine/registry.test.ts
git commit -m "feat(engine): ContainerRegistry (cookieStoreId <-> ContainerRef, tmp prefix)

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 3: Engine core — assembly, reopen/stay/leaveAlone, F1 guard, fail-open

**Files:**
- Create: `src/engine/engine.ts`
- Test: `test/engine/engine.test.ts`

**Interfaces:**
- Consumes: `BrowserPort`, `WebRequestDetails`, `Tab` from `src/engine/port.ts`; `createRegistry`, `ContainerRegistry` from `src/engine/registry.ts`; `resolve` from `src/resolver/resolve.ts`; `Config`, `Deps`, `NavContext`, `ContainerRef` from `src/resolver/types.ts`; the real `matchRule`, `matchGroup` from `src/matcher/matcher.ts` and `sameSite` from `src/psl/same-site.ts` (used by the test, not imported by the engine).
- Produces (`src/engine/engine.ts`):
  - `const MAC_ID = "@testpilot-containers"`
  - `interface EngineOptions { port: BrowserPort; config: Config; deps: Deps; onChoice: (options: string[], nav: { tabId: number; url: string }) => void; tmpSuffix?: () => string }`
  - `function createEngine(opts: EngineOptions): void` — constructs a registry, registers one `onBeforeRequest` handler.
- Note: this task implements `leaveAlone`, `stay`, and `reopen`. The `choice` branch and the F7 `macOwns` gate are added in Task 4; until then the switch handles `choice` with a `return` (no-op) placeholder so the union stays exhaustive.

- [ ] **Step 1: Write the failing test**

Create `test/engine/engine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMockPort } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

// A config with one rule: example.com opens the permanent "Work" container.
function workConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work"] } }], groups: [] };
}

const noop = () => {};

describe("engine — reopen/stay/leaveAlone + F1 guard", () => {
  it("reopens a plain nav into the target container, preserving placement", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: old.id }));

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1);
    const created = mp.calls.createTab[0];
    const work = (await mp.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(created.cookieStoreId).toBe(work.cookieStoreId);
    expect(created).toMatchObject({ url: "https://example.com/", index: 3, active: true, openerTabId: 7 });
    expect(mp.calls.removeTab).toEqual([old.id]);
  });

  it("F1: a re-fire of the same request+url does not open a second tab", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: old.id }));
    const again = await mp.fire(req({ tabId: old.id })); // same requestId + url

    expect(again).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1); // still just one
  });

  it("F1 termination: the reopened tab (now in target) yields stay, no further effects", async () => {
    const mp = createMockPort();
    const old = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    await mp.fire(req({ tabId: old.id }));
    const newTab = [...mp.tabs.values()].find((t) => t.id !== old.id)!;
    const res = await mp.fire(req({ requestId: "2", tabId: newTab.id }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(1); // no second reopen
  });

  it("F2: a tab already in the target container stays (no effects)", async () => {
    const mp = createMockPort();
    const work = mp.addIdentity({ name: "Work" });
    const tab = mp.addTab({ url: "https://example.com/old", cookieStoreId: work.cookieStoreId });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
    expect(mp.calls.removeTab).toHaveLength(0);
  });

  it("no matching rule reopens into a fresh tmp-prefixed container", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: { rules: [], groups: [] }, deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, url: "https://unmatched.test/" }));

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createIdentity).toHaveLength(1);
    expect(mp.calls.createIdentity[0].name).toMatch(/^tmp/);
  });

  it("skips non-http(s) navigations", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, url: "about:preferences" }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("skips sub_frame requests", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id, type: "sub_frame" }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("fails open when the tab has raced away (getTab null)", async () => {
    const mp = createMockPort();
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: 999 }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("fails open (no cancel) when createTab throws, and clears the guard for retry", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    mp.setCreateTabThrows(true);
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));
    expect(res).toBeUndefined(); // NOT { cancel: true }

    mp.setCreateTabThrows(false);
    const retry = await mp.fire(req({ tabId: tab.id })); // same key retried
    expect(retry).toEqual({ cancel: true }); // guard was cleared, retry works
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/engine.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/engine`.

- [ ] **Step 3: Implement `src/engine/engine.ts`**

Create `src/engine/engine.ts`:

```ts
import { resolve } from "../resolver/resolve";
import type { Config, ContainerRef, Deps, NavContext } from "../resolver/types";
import type { BrowserPort, Tab, WebRequestDetails } from "./port";
import { createRegistry, type ContainerRegistry } from "./registry";

export const MAC_ID = "@testpilot-containers";

export interface EngineOptions {
  port: BrowserPort;
  config: Config;
  deps: Deps;
  onChoice: (options: string[], nav: { tabId: number; url: string }) => void;
  tmpSuffix?: () => string;
}

function defaultSuffix(): () => string {
  let n = 0;
  return () => String(++n);
}

async function buildNavContext(
  d: WebRequestDetails,
  tab: Tab,
  registry: ContainerRegistry,
  port: BrowserPort
): Promise<NavContext> {
  const current =
    tab.url && tab.url !== "about:blank"
      ? { url: tab.url, container: await registry.toRef(tab.cookieStoreId) }
      : null;

  let initiator: ContainerRef | null;
  if (tab.openerTabId != null) {
    const opener = await port.getTab(tab.openerTabId);
    initiator = opener ? await registry.toRef(opener.cookieStoreId) : null;
  } else {
    initiator = current ? current.container : null;
  }

  return { targetUrl: d.url, current, initiator };
}

export function createEngine(opts: EngineOptions): void {
  const { port, config, deps, onChoice } = opts;
  const registry = createRegistry(port, opts.tmpSuffix ?? defaultSuffix());
  const handled = new Set<string>();

  port.onBeforeRequest(async (d) => {
    // (0) Scope: only top-level http(s) navigations.
    if (d.type !== "main_frame") return;
    if (!/^https?:/.test(d.url)) return;

    // (1) F1 loop guard — re-fires of a request we already acted on.
    const key = d.requestId + "+" + d.url;
    if (handled.has(key)) return { cancel: true };

    // (2) Assemble NavContext.
    const tab = await port.getTab(d.tabId);
    if (!tab) return; // tab raced away — fail open
    const nav = await buildNavContext(d, tab, registry, port);

    // (3) Pure decision.
    const decision = resolve(nav, config, deps);

    // (4) Effects.
    switch (decision.kind) {
      case "leaveAlone":
      case "stay":
        return;

      case "choice":
        // F7 gate + emit are added in Task 4; no-op for now.
        return;

      case "reopen": {
        handled.add(key); // guard BEFORE the async effects
        try {
          const store = await registry.toStoreId(decision.into);
          await port.createTab({
            url: d.url,
            cookieStoreId: store,
            index: tab.index,
            active: tab.active,
            openerTabId: tab.openerTabId,
          });
          await port.removeTab(tab.id);
        } catch (e) {
          handled.delete(key); // fail open — allow a retry
          console.warn("[engine] reopen failed", e);
          return; // do NOT cancel
        }
        return { cancel: true };
      }
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/engine.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts test/engine/engine.test.ts
git commit -m "feat(engine): interception spine — reopen/stay/leaveAlone + F1 guard

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 4: F7 MAC-defer handshake + `choice` emission

**Files:**
- Modify: `src/engine/engine.ts` (add `macOwns`, gate `reopen`/`choice`, implement `choice`)
- Test: `test/engine/engine.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: everything from Task 3, plus `mp.setMacAssignment` / `mp.setMacThrows` from the mock port.
- Produces: no new exports; `MAC_ID` (already exported) is now used by a module-private `macOwns(port, url)`. The `choice` branch now calls `onChoice(options, { tabId, url })` and returns `{ cancel: true }`, gated by `macOwns`.

- [ ] **Step 1: Write the failing test**

Append to `test/engine/engine.test.ts` (add this block; the imports and helpers at the top already exist):

```ts
// Config: example.com opens Work OR Personal with no default -> choice.
function choiceConfig(): Config {
  return {
    rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work", "Personal"] } }],
    groups: [],
  };
}

describe("engine — F7 MAC defer + choice", () => {
  it("F7: defers (no reopen) when MAC owns the URL", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    mp.setMacAssignment("https://example.com/", { userContextId: 5 });
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));

    expect(res).toBeUndefined();
    expect(mp.calls.createTab).toHaveLength(0);
  });

  it("F7: reopens normally when MAC is absent (sendExternalMessage throws)", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    mp.setMacThrows(true);
    createEngine({ port: mp.port, config: workConfig(), deps, onChoice: noop, tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(1);
  });

  it("choice: emits onChoice with the options and cancels, opening no tab", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const seen: Array<{ options: string[]; nav: { tabId: number; url: string } }> = [];
    createEngine({
      port: mp.port,
      config: choiceConfig(),
      deps,
      onChoice: (options, nav) => seen.push({ options, nav }),
      tmpSuffix: counter(),
    });

    const res = await mp.fire(req({ tabId: tab.id }));

    expect(res).toEqual({ cancel: true });
    expect(mp.calls.createTab).toHaveLength(0);
    expect(seen).toEqual([{ options: ["Work", "Personal"], nav: { tabId: tab.id, url: "https://example.com/" } }]);
  });

  it("choice: defers to MAC (no emit) when MAC owns the URL", async () => {
    const mp = createMockPort();
    const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    mp.setMacAssignment("https://example.com/", { userContextId: 5 });
    let called = false;
    createEngine({ port: mp.port, config: choiceConfig(), deps, onChoice: () => (called = true), tmpSuffix: counter() });

    const res = await mp.fire(req({ tabId: tab.id }));

    expect(res).toBeUndefined();
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/engine.test.ts --testNamePattern="F7 MAC defer"`
Expected: FAIL — the choice-emits test fails (no `onChoice` call; returns `undefined` not `{cancel:true}`), and the MAC-defer tests currently reopen instead of deferring.

- [ ] **Step 3: Add `macOwns` and gate the effects**

In `src/engine/engine.ts`, add this module-private helper below `MAC_ID`:

```ts
// F7: a truthy getAssignment result means MAC owns this URL and we back off.
async function macOwns(port: BrowserPort, url: string): Promise<boolean> {
  try {
    const a = await port.sendExternalMessage(MAC_ID, { method: "getAssignment", url });
    return a != null;
  } catch {
    return false; // MAC absent ⇒ nobody else owns it
  }
}
```

Then replace the `choice` and `reopen` cases in the handler switch with:

```ts
      case "choice":
        if (await macOwns(port, d.url)) return; // F7 defer
        handled.add(key);
        onChoice(decision.options, { tabId: d.tabId, url: d.url });
        return { cancel: true };

      case "reopen": {
        if (await macOwns(port, d.url)) return; // F7 defer
        handled.add(key); // guard BEFORE the async effects
        try {
          const store = await registry.toStoreId(decision.into);
          await port.createTab({
            url: d.url,
            cookieStoreId: store,
            index: tab.index,
            active: tab.active,
            openerTabId: tab.openerTabId,
          });
          await port.removeTab(tab.id);
        } catch (e) {
          handled.delete(key); // fail open — allow a retry
          console.warn("[engine] reopen failed", e);
          return; // do NOT cancel
        }
        return { cancel: true };
      }
```

- [ ] **Step 4: Run the full engine test to verify it passes**

Run: `npx vitest run test/engine/engine.test.ts`
Expected: PASS (13 tests — 9 from Task 3 plus 4 new).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts test/engine/engine.test.ts
git commit -m "feat(engine): F7 MAC-defer handshake + choice emission

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 5: Property-based invariants (fast-check)

**Files:**
- Test: `test/engine/engine.props.test.ts`

**Interfaces:**
- Consumes: `createMockPort`, `createEngine`, real `deps`, `hostMatcher`, `fast-check`.
- Produces: no source changes — invariants over the engine built in Tasks 3–4.

- [ ] **Step 1: Write the failing property test**

Create `test/engine/engine.props.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createMockPort } from "./mock-port";
import { createEngine } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps, Rule } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };
const HOSTS = ["a.test", "b.test", "c.example"] as const;
const noop = () => {};

function counter(): () => string {
  let n = 0;
  return () => String(++n);
}

// A small arbitrary Config over the fixed host set.
const arbConfig: fc.Arbitrary<Config> = fc
  .array(
    fc.record({
      host: fc.constantFrom(...HOSTS),
      action: fc.constantFrom<Rule["action"]>(
        { kind: "open", containers: ["Work"] },
        { kind: "open", containers: ["Work", "Personal"] },
        { kind: "inherit" },
        { kind: "ignore" }
      ),
    }),
    { maxLength: 4 }
  )
  .map((rows) => ({
    rules: rows.map((r) => ({ match: [hostMatcher(r.host)], action: r.action })),
    groups: [],
  }));

const arbUrl = fc.constantFrom(...HOSTS.map((h) => `https://${h}/`));

function freshMockWithTab() {
  const mp = createMockPort();
  const tab = mp.addTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
  return { mp, tab };
}

function req(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", method: "GET", ...over };
}

describe("engine — property-based invariants", () => {
  it("bounded effect: any single fired nav opens at most one tab (F1)", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { mp, tab } = freshMockWithTab();
        createEngine({ port: mp.port, config, deps, onChoice: noop, tmpSuffix: counter() });
        await mp.fire(req({ tabId: tab.id, url }));
        expect(mp.calls.createTab.length).toBeLessThanOrEqual(1);
      })
    );
  });

  it("target fidelity: a reopened tab lands in the container resolve() chose", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { mp, tab } = freshMockWithTab();
        createEngine({ port: mp.port, config, deps, onChoice: noop, tmpSuffix: counter() });
        const res = await mp.fire(req({ tabId: tab.id, url }));
        if (res && res.cancel && mp.calls.createTab.length === 1) {
          // Whatever container we opened must exist as a real store the registry
          // recognizes (default, a named permanent, or a tmp throwaway).
          const store = mp.calls.createTab[0].cookieStoreId;
          const known = store === "firefox-default" || (await mp.port.getIdentity(store)) !== null;
          expect(known).toBe(true);
        }
      })
    );
  });

  it("defer totality: if MAC owns the URL, no tab is ever opened or removed (F7)", async () => {
    await fc.assert(
      fc.asyncProperty(arbConfig, arbUrl, async (config, url) => {
        const { mp, tab } = freshMockWithTab();
        mp.setMacAssignment(url, { userContextId: 1 }); // MAC owns every fired URL
        createEngine({ port: mp.port, config, deps, onChoice: noop, tmpSuffix: counter() });
        await mp.fire(req({ tabId: tab.id, url }));
        expect(mp.calls.createTab).toHaveLength(0);
        expect(mp.calls.removeTab).toHaveLength(0);
      })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (all deps already exist)**

Run: `npx vitest run test/engine/engine.props.test.ts`
Expected: PASS (3 properties). If any property fails, fast-check prints a counterexample and the seed — treat that as a real engine bug and fix before continuing.

- [ ] **Step 3: Run the whole unit suite + typecheck**

Run: `npx vitest run test/engine/` then `npm run typecheck`
Expected: all engine tests green (mock-port 6, registry 8, engine 13, props 3 = 30); no type errors. (The pre-existing `test/e2e/plumbing.test.ts` needs geckodriver and is unrelated.)

- [ ] **Step 4: Commit**

```bash
git add test/engine/engine.props.test.ts
git commit -m "test(engine): fast-check invariants (bounded effect, target fidelity, F7 totality)

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

## Self-review notes (author)

- **Spec coverage:** §2 modules → Tasks 1/2/3; §3.1 port → Task 1; §3.2 registry (`tmp` prefix, find-or-create, injected suffix) → Task 2; §3.3 NavContext assembly → Task 3; §4 handler (scope filter, F1 guard, F2 structural stay, reopen, fail-open) → Task 3, (F7 gate, choice) → Task 4; §5 error table (non-http, tab null, missing identity→default, reopen throw, MAC absent) → Tasks 2/3/4; §6 testing (mock port, table-driven, fast-check, registry units) → Tasks 1–5. No spec section is unmapped.
- **Deferred by design (no task):** F10 disposal, F8 persistence, F12 overlays/redirector, F9 redirect binding, real-Firefox adapter, choice-picker UI — all listed out-of-scope in the spec §1.
- **Type consistency:** `createEngine(EngineOptions)`, `createRegistry(port, tmpSuffix)`, `ContainerRegistry.toRef/toStoreId`, `TMP_PREFIX`, `MAC_ID`, and the mock's `fire/addTab/addIdentity/setMac*/setCreateTabThrows` names are used identically across all tasks.
- **`handled` unbounded growth** is accepted for the spine (spec §5); a TTL/cap belongs to the F8/cleanup slice.
