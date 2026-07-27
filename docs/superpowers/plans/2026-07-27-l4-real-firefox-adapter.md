# L4 — Real Firefox Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the mock-tested L3 engine in real Firefox: implement the `BrowserPort` over `browser.*`, package it as an MV2 extension, and prove via Selenium that a matching host reopens into its named container and an unmatched host into a throwaway.

**Architecture:** A new `createBrowserPort()` implements the existing `BrowserPort` interface over `browser.*` (mechanical, logic-free). A small `src/extension/background.ts` wires the real port + a bundled fixed config + real deps into `createEngine`. esbuild bundles that (with `tldts`/`yaml`) into `extensions/cc/background.js`. The harness loads CC alongside the probe; the probe (extended to also report the container name) is the observation channel.

**Tech Stack:** TypeScript (ESM), Vitest, Selenium/geckodriver, esbuild, `@types/firefox-webext-browser`.

**Design spec:** `docs/superpowers/specs/2026-07-27-l4-real-firefox-adapter-design.md`

## Global Constraints

- **Target Firefox, MV2, blocking `webRequest`.** Firefox supports blocking `webRequest` in MV2.
- **Do not change** `src/engine/engine.ts`, `src/engine/registry.ts`, `src/engine/port.ts`, or `src/resolver/`, `src/matcher/`, `src/psl/`, `src/config/`. L4 only adds a real port + packaging + a test.
- **Do not change the probe's `CSID:<store>` title format** — `harness/firefox.ts` `readCookieStoreId` and the plumbing tests match `^CSID:(.+)$`. The container name is reported via a **separate DOM attribute**.
- **`launch()` default stays `["probe"]`** so the plumbing tests are unaffected; L4 opts into `["probe","cc"]`.
- **The bundled config is fixed** (`src/extension/config.ts`); no storage/UI in this slice.
- **`extensions/cc/background.js` is a build artifact** — gitignored, built at launch by esbuild.
- **New devDeps:** `esbuild` (already present transitively — pin it directly) and `@types/firefox-webext-browser` (types only). `tsconfig.json` `types` must be widened to include `firefox-webext-browser`.
- **Real-browser e2e is less deterministic** than L1–L3: poll with timeouts, tolerate window-handle churn. This is expected at L4.
- **Use CLI long options** (`--save-dev`, `--run`, `--testNamePattern`).
- **Commit after every task.** End each commit message body with:
  `Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN`

---

### Task 1: Tooling & config setup

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `tsconfig.json:10` (`types`)
- Modify: `.gitignore`

**Interfaces:**
- Produces: the `browser` global type (via `@types/firefox-webext-browser`) and a usable `esbuild` direct dependency for later tasks.

- [ ] **Step 1: Install the dev dependencies**

Run: `npm install --save-dev esbuild @types/firefox-webext-browser`
Expected: installs/pins both; `package.json` `devDependencies` now lists `esbuild` and `@types/firefox-webext-browser`.

- [ ] **Step 2: Widen the tsconfig `types` allowlist**

In `tsconfig.json`, change:

```json
    "types": ["node"],
```

to:

```json
    "types": ["node", "firefox-webext-browser"],
```

- [ ] **Step 3: Gitignore the extension build artifact**

Append to `.gitignore`:

```
# Built CC extension background (esbuild output; produced at test launch)
extensions/cc/background.js
```

- [ ] **Step 4: Verify typecheck still passes and esbuild is available**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx esbuild --version`
Expected: prints a version number (e.g. `0.x.y`).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore
git commit -m "build: add esbuild + firefox-webext-browser types; gitignore cc bundle

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 2: Real `BrowserPort` adapter

**Files:**
- Create: `src/engine/browser-port.ts`
- Test: `test/engine/browser-port.test.ts`

**Interfaces:**
- Consumes: `BrowserPort`, `Tab`, `ContextualIdentity`, `CreateTabProps`, `CreateIdentityProps`, `WebRequestDetails` from `src/engine/port.ts`; the global `browser` namespace from `@types/firefox-webext-browser`.
- Produces: `function createBrowserPort(): BrowserPort`.

- [ ] **Step 1: Write the failing test**

Create `test/engine/browser-port.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBrowserPort } from "../../src/engine/browser-port";
import type { WebRequestDetails } from "../../src/engine/port";

// A hand-rolled fake of the browser.* surface the adapter touches. Installed as the
// global `browser` for the duration of each test.
function fakeBrowser() {
  return {
    _listener: null as null | ((d: unknown) => unknown),
    _addFilter: null as unknown,
    _addExtra: null as unknown,
    webRequest: {
      onBeforeRequest: {
        addListener(fn: (d: unknown) => unknown, filter: unknown, extra: unknown) {
          f.webRequest.onBeforeRequest_last = { fn, filter, extra };
        },
        onBeforeRequest_last: null as unknown,
      },
    },
    tabs: {
      get: async (id: number) => {
        if (id === 404) throw new Error("no such tab");
        return { id, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true, openerTabId: 9 };
      },
      create: async (props: Record<string, unknown>) => ({ id: 77, url: props.url, cookieStoreId: props.cookieStoreId, index: props.index ?? 0, active: props.active ?? true, openerTabId: props.openerTabId }),
      remove: async (_id: number) => {},
    },
    contextualIdentities: {
      query: async (_d: object) => [{ cookieStoreId: "firefox-container-2", name: "Work", color: "blue", icon: "circle" }],
      create: async (p: { name: string; color: string; icon: string }) => ({ cookieStoreId: "firefox-container-9", ...p }),
      get: async (csid: string) => {
        if (csid === "firefox-default") throw new Error("no identity");
        return { cookieStoreId: csid, name: "Work", color: "blue", icon: "circle" };
      },
    },
    runtime: { sendMessage: async (_ext: string, msg: unknown) => ({ echoed: msg }) },
  };
}
let f: ReturnType<typeof fakeBrowser>;

beforeEach(() => {
  f = fakeBrowser();
  (globalThis as unknown as { browser: unknown }).browser = f;
});
afterEach(() => {
  delete (globalThis as unknown as { browser?: unknown }).browser;
});

describe("createBrowserPort", () => {
  it("registers a blocking main_frame onBeforeRequest listener and forwards mapped details", async () => {
    const seen: WebRequestDetails[] = [];
    const port = createBrowserPort();
    port.onBeforeRequest(async (d) => { seen.push(d); return { cancel: true }; });

    const reg = f.webRequest.onBeforeRequest.onBeforeRequest_last as { fn: (d: unknown) => Promise<unknown>; filter: unknown; extra: unknown };
    expect(reg.filter).toEqual({ urls: ["<all_urls>"], types: ["main_frame"] });
    expect(reg.extra).toEqual(["blocking"]);

    const result = await reg.fn({ requestId: "5", tabId: 3, url: "https://a.test/", type: "main_frame", method: "GET" });
    expect(seen[0]).toMatchObject({ requestId: "5", tabId: 3, url: "https://a.test/", type: "main_frame", method: "GET" });
    expect(result).toEqual({ cancel: true });
  });

  it("coerces a void handler result to an empty (non-blocking) response", async () => {
    const port = createBrowserPort();
    port.onBeforeRequest(async () => undefined);
    const reg = f.webRequest.onBeforeRequest.onBeforeRequest_last as { fn: (d: unknown) => Promise<unknown> };
    expect(await reg.fn({ requestId: "1", tabId: 1, url: "https://a.test/", type: "main_frame", method: "GET" })).toEqual({});
  });

  it("getTab maps fields (incl. openerTabId) and returns null when the tab is gone", async () => {
    const port = createBrowserPort();
    expect(await port.getTab(3)).toEqual({ id: 3, url: "https://x.test/", cookieStoreId: "firefox-container-2", index: 4, active: true, openerTabId: 9 });
    expect(await port.getTab(404)).toBeNull();
  });

  it("getIdentity returns null for the default store (get throws) and maps a real container", async () => {
    const port = createBrowserPort();
    expect(await port.getIdentity("firefox-default")).toBeNull();
    expect(await port.getIdentity("firefox-container-2")).toEqual({ cookieStoreId: "firefox-container-2", name: "Work", color: "blue", icon: "circle" });
  });

  it("createTab passes props through and maps the result", async () => {
    const port = createBrowserPort();
    const t = await port.createTab({ url: "https://a.test/", cookieStoreId: "firefox-container-9", index: 2, active: false, openerTabId: 5 });
    expect(t).toEqual({ id: 77, url: "https://a.test/", cookieStoreId: "firefox-container-9", index: 2, active: false, openerTabId: 5 });
  });

  it("sendExternalMessage delegates to runtime.sendMessage", async () => {
    const port = createBrowserPort();
    expect(await port.sendExternalMessage("@mac", { method: "getAssignment" })).toEqual({ echoed: { method: "getAssignment" } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/engine/browser-port.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/browser-port`.

- [ ] **Step 3: Implement `src/engine/browser-port.ts`**

Create `src/engine/browser-port.ts`:

```ts
import type {
  BrowserPort, ContextualIdentity, CreateIdentityProps, CreateTabProps, Tab, WebRequestDetails,
} from "./port";

// Real BrowserPort over browser.*. Mechanical, logic-free — all decisions come from
// resolve() inside the engine. The only Firefox-specific note: a blocking
// onBeforeRequest listener may return a Promise<BlockingResponse>, which Firefox
// awaits before the request proceeds.
export function createBrowserPort(): BrowserPort {
  return {
    onBeforeRequest(handler) {
      browser.webRequest.onBeforeRequest.addListener(
        (d) =>
          handler({
            requestId: d.requestId, tabId: d.tabId, url: d.url, type: d.type,
            method: d.method, originUrl: d.originUrl, documentUrl: d.documentUrl,
          }).then((r) => r ?? {}), // void -> empty response (proceed)
        { urls: ["<all_urls>"], types: ["main_frame"] },
        ["blocking"]
      );
    },

    async getTab(tabId): Promise<Tab | null> {
      try {
        const t = await browser.tabs.get(tabId);
        return {
          id: t.id!, url: t.url ?? "", cookieStoreId: t.cookieStoreId ?? "firefox-default",
          index: t.index, active: t.active, openerTabId: t.openerTabId,
        };
      } catch {
        return null; // tab gone — engine treats as fail-open
      }
    },

    async createTab(p: CreateTabProps): Promise<Tab> {
      const t = await browser.tabs.create({
        url: p.url, cookieStoreId: p.cookieStoreId,
        index: p.index, active: p.active, openerTabId: p.openerTabId,
      });
      return {
        id: t.id!, url: t.url ?? p.url, cookieStoreId: t.cookieStoreId ?? p.cookieStoreId,
        index: t.index, active: t.active, openerTabId: t.openerTabId,
      };
    },

    async removeTab(tabId) {
      await browser.tabs.remove(tabId);
    },

    async queryIdentities(): Promise<ContextualIdentity[]> {
      return (await browser.contextualIdentities.query({})).map((c) => ({
        cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon,
      }));
    },

    async createIdentity(p: CreateIdentityProps): Promise<ContextualIdentity> {
      const c = await browser.contextualIdentities.create({ name: p.name, color: p.color, icon: p.icon });
      return { cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon };
    },

    async getIdentity(cookieStoreId): Promise<ContextualIdentity | null> {
      try {
        const c = await browser.contextualIdentities.get(cookieStoreId);
        return { cookieStoreId: c.cookieStoreId, name: c.name, color: c.color, icon: c.icon };
      } catch {
        return null; // firefox-default or a removed container — registry treats as default
      }
    },

    sendExternalMessage(extensionId, message) {
      return browser.runtime.sendMessage(extensionId, message);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/engine/browser-port.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If tsc flags the `extraInfoSpec` array or the listener return, the `.then((r) => r ?? {})` coercion and the direct array-literal argument are already written to satisfy the `@types` signatures — do not cast.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/browser-port.ts test/engine/browser-port.test.ts
git commit -m "feat(engine): real BrowserPort over browser.* (L4 adapter)

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 3: Extension entry + bundled config

**Files:**
- Create: `src/extension/config.ts`
- Create: `src/extension/background.ts`
- Test: `test/extension/config.test.ts`

**Interfaces:**
- Consumes: `createEngine` from `src/engine/engine.ts`; `createBrowserPort` from `src/engine/browser-port.ts`; `parseConfig` from `src/config/parse.ts`; `matchRule`, `matchGroup` from `src/matcher/matcher.ts`; `sameSite` from `src/psl/same-site.ts`.
- Produces: `export const BUNDLED_CONFIG_YAML: string`; `src/extension/background.ts` (side-effecting entry, no exports).

- [ ] **Step 1: Write the failing test**

Create `test/extension/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/config/parse";
import { matchRule } from "../../src/matcher/matcher";
import { BUNDLED_CONFIG_YAML } from "../../src/extension/config";

describe("bundled extension config", () => {
  it("parses and routes work.example to the Work container", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    const rule = matchRule("https://work.example/", config.rules);
    expect(rule).not.toBeNull();
    expect(rule!.action).toEqual({ kind: "open", containers: ["Work"] });
  });

  it("does not match an unrelated host", () => {
    const config = parseConfig(BUNDLED_CONFIG_YAML);
    expect(matchRule("https://nomatch.example/", config.rules)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extension/config.test.ts`
Expected: FAIL — cannot resolve `../../src/extension/config`.

- [ ] **Step 3: Implement `src/extension/config.ts`**

Create `src/extension/config.ts`:

```ts
// Fixed config bundled into the L4 extension. Config-from-storage / the editor UI
// are a later slice; this is enough to prove routing end-to-end in real Firefox.
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/extension/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `src/extension/background.ts`**

Create `src/extension/background.ts`:

```ts
import { createEngine } from "../engine/engine";
import { createBrowserPort } from "../engine/browser-port";
import { parseConfig } from "../config/parse";
import { matchRule, matchGroup } from "../matcher/matcher";
import { sameSite } from "../psl/same-site";
import { BUNDLED_CONFIG_YAML } from "./config";

createEngine({
  port: createBrowserPort(),
  config: parseConfig(BUNDLED_CONFIG_YAML),
  deps: { matchRule, matchGroup, sameSite },
  onChoice: () => {}, // no picker UI in this slice; the bundled config has no choice rule
});
```

- [ ] **Step 6: Typecheck (covers background.ts wiring)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/extension/config.ts src/extension/background.ts test/extension/config.test.ts
git commit -m "feat(extension): bundled config + background entry wiring createEngine

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 4: MV2 manifest + esbuild build

**Files:**
- Create: `extensions/cc/manifest.json`
- Create: `harness/build-extension.ts`
- Test: `test/extension/build.test.ts`

**Interfaces:**
- Consumes: `esbuild`'s `build`; `src/extension/background.ts` as the entry point.
- Produces: `async function buildExtension(): Promise<string>` — bundles the entry to `extensions/cc/background.js` and returns that path.

- [ ] **Step 1: Create the manifest**

Create `extensions/cc/manifest.json`:

```json
{
  "manifest_version": 2,
  "name": "configurable-containers",
  "version": "0.0.1",
  "browser_specific_settings": { "gecko": { "id": "cc@configurable-containers.test" } },
  "permissions": ["webRequest", "webRequestBlocking", "cookies", "tabs", "contextualIdentities", "<all_urls>"],
  "background": { "scripts": ["background.js"] }
}
```

> **`cookies` is required:** Firefox throws `No permission for cookieStoreId` on
> `tabs.create({ cookieStoreId })` without it, so every reopen fails. (Discovered
> during L4 — see the design spec §9.)

- [ ] **Step 2: Write the failing test**

Create `test/extension/build.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildExtension } from "../../harness/build-extension";

describe("extension bundle", () => {
  it("bundles background.ts into a single self-contained background.js", async () => {
    const outfile = await buildExtension();
    expect(existsSync(outfile)).toBe(true);
    const code = readFileSync(outfile, "utf8");
    // non-trivial, references the browser.* API our real port uses, and is bundled
    // (no top-level ESM import survives — deps like tldts/yaml are inlined).
    expect(code.length).toBeGreaterThan(1000);
    expect(code).toContain("onBeforeRequest");
    expect(code).toContain("contextualIdentities");
    expect(code).not.toMatch(/^\s*import\s.+\sfrom\s/m);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/extension/build.test.ts`
Expected: FAIL — cannot resolve `../../harness/build-extension`.

- [ ] **Step 4: Implement `harness/build-extension.ts`**

Create `harness/build-extension.ts`:

```ts
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../src/extension/background.ts");
const OUTFILE = path.resolve(HERE, "../extensions/cc/background.js");

// Bundle the extension background (engine + real port + tldts + yaml) into one
// classic script Firefox can load as an MV2 background. Returns the output path.
export async function buildExtension(): Promise<string> {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: OUTFILE,
    format: "iife",
    platform: "browser",
    target: "firefox115",
    logLevel: "silent",
  });
  return OUTFILE;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/extension/build.test.ts`
Expected: PASS (1 test). This actually runs esbuild and writes `extensions/cc/background.js`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add extensions/cc/manifest.json harness/build-extension.ts test/extension/build.test.ts
git commit -m "build(extension): MV2 manifest + esbuild bundler for cc background

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 5: Probe name-reporting + harness supports CC

**Files:**
- Modify: `extensions/probe/background.js`
- Modify: `harness/firefox.ts` (full replacement below)

**Interfaces:**
- Consumes: `buildExtension` from `harness/build-extension.ts`.
- Produces (from `harness/firefox.ts`):
  - `launch(opts?: { extensions?: ("probe" | "cc")[] }): Promise<Session>` (default `["probe"]`)
  - `readContainerName(driver: WebDriver): Promise<string>`
  - `awaitContainerTab(driver: WebDriver, url: string, timeoutMs?: number): Promise<{ store: string; name: string }>`
  - unchanged: `readCookieStoreId`, `collectStoresUntilContainer`, `type Session`.

- [ ] **Step 1: Extend the probe to also report the container name**

Replace the `reportTab` function in `extensions/probe/background.js` with (the `CSID:` title is unchanged; a DOM attribute carries the name):

```js
// Surface a tab's cookieStoreId into document.title (CSID:<store>, unchanged) AND
// its container name into a data attribute, so an external driver can read both.
async function reportTab(tabId, cookieStoreId) {
  let name = "";
  try {
    name = (await browser.contextualIdentities.get(cookieStoreId)).name;
  } catch (_e) {
    // firefox-default has no identity — leave name empty.
  }
  try {
    await browser.tabs.executeScript(tabId, {
      code:
        "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";" +
        "document.documentElement.setAttribute('data-cc-container', " + JSON.stringify(name) + ");",
    });
  } catch (_e) {
    // about:, view-source:, moz-extension: pages cannot be injected — ignore.
  }
}
```

- [ ] **Step 2: Replace `harness/firefox.ts`**

Replace the entire contents of `harness/firefox.ts` with:

```ts
import { Builder, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startServer, type TestServer } from "./server";
import { buildExtension } from "./build-extension";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIRS: Record<"probe" | "cc", string> = {
  probe: path.resolve(HERE, "../extensions/probe"),
  cc: path.resolve(HERE, "../extensions/cc"),
};

export interface Session {
  driver: WebDriver;
  serverUrl: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensions?: ("probe" | "cc")[];
}

// Zip an unpacked extension directory into a temporary .xpi (geckodriver's
// installAddon wants a file, not a directory).
function zipDir(dir: string): { xpiPath: string; cleanup: () => void } {
  const out = mkdtempSync(path.join(tmpdir(), "cc-e2e-xpi-"));
  const xpiPath = path.join(out, "addon.xpi");
  execFileSync("zip", ["-r", "-FS", xpiPath, ".", "-x", ".*"], { cwd: dir });
  return { xpiPath, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

// Build (cc only) then zip the given extension into an installable .xpi.
async function buildXpiFor(ext: "probe" | "cc"): Promise<{ xpiPath: string; cleanup: () => void }> {
  if (ext === "cc") await buildExtension();
  return zipDir(EXT_DIRS[ext]);
}

export async function launch(opts: LaunchOptions = {}): Promise<Session> {
  const extensions = opts.extensions ?? ["probe"];
  const server: TestServer = await startServer();

  const xpis: { xpiPath: string; cleanup: () => void }[] = [];
  for (const ext of extensions) {
    xpis.push(await buildXpiFor(ext));
  }
  const cleanupXpis = () => xpis.forEach((x) => x.cleanup());

  const options = new firefox.Options();
  options.addArguments("-headless");
  options.setPreference("privacy.userContext.enabled", true);
  options.setPreference("xpinstall.signatures.required", false);
  // Resolve the test's fake domains straight to loopback (cross-platform, no DNS).
  options.setPreference("network.dns.localDomains", "work.example,nomatch.example");

  const firefoxBin = process.env.FIREFOX_BIN;
  if (firefoxBin) {
    options.setBinary(firefoxBin);
  }

  let driver: WebDriver;
  try {
    driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
    for (const { xpiPath } of xpis) {
      await (driver as unknown as firefox.Driver).installAddon(xpiPath, true);
    }
  } catch (err) {
    await server.close();
    cleanupXpis();
    throw err;
  }

  return {
    driver,
    serverUrl: server.url,
    async close() {
      await driver.quit();
      await server.close();
      cleanupXpis();
    },
  };
}

// Poll the CURRENT window's title until the probe has written "CSID:<store>".
export async function readCookieStoreId(driver: WebDriver, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = "";
  while (Date.now() < deadline) {
    lastTitle = await driver.getTitle();
    const m = lastTitle.match(/^CSID:(.+)$/);
    if (m) return m[1];
    await driver.sleep(100);
  }
  throw new Error(`Timed out waiting for probe report; last title: ${JSON.stringify(lastTitle)}`);
}

// Read the container name the probe wrote into the current tab's DOM.
export async function readContainerName(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-container') || '';"
  )) as string;
}

// Poll window handles (WITHOUT re-navigating them — CC does the reopening) until a
// tab shows `url` in a non-default container; return its store + reported name.
export async function awaitContainerTab(
  driver: WebDriver,
  url: string,
  timeoutMs = 15_000,
): Promise<{ store: string; name: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const handle of await driver.getAllWindowHandles()) {
      try {
        await driver.switchTo().window(handle);
        const m = (await driver.getTitle()).match(/^CSID:(.+)$/);
        if (m && /^firefox-container-\d+$/.test(m[1]) && (await driver.getCurrentUrl()).startsWith(url)) {
          return { store: m[1], name: await readContainerName(driver) };
        }
      } catch {
        // A handle may have closed mid-loop; skip it this round.
      }
    }
    await driver.sleep(300);
  }
  throw new Error(`no container tab for ${url} within ${timeoutMs}ms`);
}

// Navigate every window handle to `url` (triggering a probe report on each) and
// collect their cookieStoreIds. Retries until a container store appears or the
// deadline passes, tolerating the probe's container tab arriving asynchronously.
export async function collectStoresUntilContainer(
  driver: WebDriver,
  url: string,
  timeoutMs = 15_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let stores: string[] = [];
  while (Date.now() < deadline) {
    stores = [];
    const handles = await driver.getAllWindowHandles();
    for (const handle of handles) {
      try {
        await driver.switchTo().window(handle);
        await driver.get(url);
        stores.push(await readCookieStoreId(driver, 2000));
      } catch {
        // A handle may have closed mid-loop; skip it this round.
      }
    }
    if (stores.some((s) => /^firefox-container-\d+$/.test(s))) return stores;
    await driver.sleep(500);
  }
  return stores;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Verify no plumbing regression (probe title format + default launch unchanged)**

Run: `npx vitest run test/e2e/plumbing.test.ts`
Expected: PASS (2 tests). Requires system Firefox + geckodriver; if `FIREFOX_BIN` is needed in your environment, set it as the existing CI does. If geckodriver is unavailable locally, note it and defer this check to CI.

- [ ] **Step 5: Commit**

```bash
git add extensions/probe/background.js harness/firefox.ts
git commit -m "feat(harness): load CC alongside probe; report container name; await helpers

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

### Task 6: L4 routing e2e test

**Files:**
- Test: `test/e2e/routing.test.ts`

**Interfaces:**
- Consumes: `launch`, `awaitContainerTab`, `type Session` from `harness/firefox.ts`.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/routing.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, type Session } from "../../harness/firefox";

describe("routing (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  // Open a fresh firefox-default tab and navigate it; CC will cancel + reopen, so
  // the original tab may be torn down mid-nav — tolerate that.
  async function navFreshTab(url: string) {
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopened the tab away — expected.
    }
  }

  it("routes a matching host into its named container", async () => {
    const url = `http://work.example:${port}/`;
    await navFreshTab(url);
    const { store, name } = await awaitContainerTab(session.driver, url);
    expect(store).toMatch(/^firefox-container-\d+$/);
    expect(name).toBe("Work");
  });

  it("routes an unmatched host into a fresh temporary container", async () => {
    const url = `http://nomatch.example:${port}/`;
    await navFreshTab(url);
    const { store, name } = await awaitContainerTab(session.driver, url);
    expect(store).toMatch(/^firefox-container-\d+$/);
    expect(name).toMatch(/^tmp/);
  });
});
```

- [ ] **Step 2: Run the L4 test**

Run: `npx vitest run test/e2e/routing.test.ts`
Expected: PASS (2 tests). This is the integration proof; it launches real Firefox with CC + probe. If it fails, debug against the §6 risks in the spec (verify `network.dns.localDomains` resolves the fake domains; confirm the async blocking listener actually cancels; widen `awaitContainerTab` timeouts for slow headless startup). Do not weaken the assertions to make it pass.

- [ ] **Step 3: Run the full suite (regression)**

Run: `npx vitest run`
Expected: all suites pass — the L1–L3 unit tests, the extension unit tests (Tasks 2–4), the plumbing e2e, and the new routing e2e.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/routing.test.ts
git commit -m "test(e2e): L4 routing — matching host -> named container, unmatched -> tmp

Claude-Session: https://claude.ai/code/session_01Fa1Xynv6ApRiYQXXtR2WJN"
```

---

## Self-review notes (author)

- **Spec coverage:** §2 file layout → all tasks; §3 real port → Task 2; §3 types (@types + tsconfig) → Task 1; §4 manifest/config/background/esbuild → Tasks 3–4; §4 loading both extensions → Task 5; §5 host routing (`network.dns.localDomains`) → Task 5; §5 probe name-reporting → Task 5; §5 helpers (`readContainerName`, `awaitContainerTab`) → Task 5; §5 test flow → Task 6; §7 testing scope (match→named, unmatched→tmp) → Task 6; regression guard (plumbing + L1–L3) → Tasks 5–6. No spec section is unmapped.
- **Deferred by design (no task):** MAC/F7-in-browser, in-browser F2, F10, F12, F9, F8, config-from-storage/editor, the `TESTING.md` L4/L5 line correction — all listed out-of-scope in the spec §1/§8.
- **Type friction pre-empted:** the adapter's `onBeforeRequest` wrapper coerces `void -> {}` (`.then((r) => r ?? {})`) so the async listener satisfies the `@types` blocking-return type; the `filter` and `["blocking"]` args are passed as array/object literals so they are contextually typed (no casts).
- **Type consistency:** `createBrowserPort`, `buildExtension`, `BUNDLED_CONFIG_YAML`, `launch({extensions})`, `readContainerName`, `awaitContainerTab` are named identically across tasks and match the harness `Session` type.
- **Non-determinism:** Tasks 5–6 depend on real Firefox/geckodriver; where unavailable locally, those checks defer to CI (the L1–L4 unit + build tests in Tasks 2–4 are fully deterministic and run anywhere).
```
