# E2E Harness Plumbing Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a TypeScript test can launch headless Firefox, load an unsigned extension, and read a tab's `cookieStoreId` back — including a real container store.

**Architecture:** A tiny MV2 "probe" extension surfaces each http(s) tab's `cookieStoreId` into `document.title`. A Playwright harness (extension loaded via `playwright-webextext` over Firefox's remote debugging protocol) navigates tabs against a throwaway local HTTP server and reads the titles back. No network egress, no third-party extension, no `.xpi` build.

**Tech Stack:** TypeScript, Playwright (Firefox, headless), `playwright-webextext`, Vitest, Node's built-in `http`.

**Spec:** `docs/superpowers/specs/2026-07-09-e2e-harness-plumbing-spike-design.md`

**Spike nature — read before starting:** This is a de-risking spike. Tasks 4–5 exercise APIs whose exact behavior is *what the spike verifies* (`playwright-webextext` loading headlessly; whether `firefoxUserPrefs` propagates; whether extension-opened tabs appear in `context.pages()`). Each such step has an explicit **Observe** note and a **Contingency**. If a primary path fails, follow the contingency or stop and report — do not silently paper over it.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json` | Deps + `test` script. |
| `tsconfig.json` | TS config (type-check only; Vitest runs TS directly). |
| `vitest.config.ts` | Single-fork runner, long timeouts for Firefox. |
| `harness/server.ts` | Throwaway local HTTP server serving one static page. Pure Node, unit-tested. |
| `harness/firefox.ts` | Launch headless Firefox + probe; read `cookieStoreId` from tab titles; teardown. |
| `extensions/probe/manifest.json` | MV2 probe manifest. |
| `extensions/probe/background.js` | Reports `cookieStoreId` → title; self-provisions one container tab. |
| `test/harness/server.test.ts` | Unit test for the local server. |
| `test/e2e/plumbing.test.ts` | The two proofs. |

---

## Task 1: Project scaffold & toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "configurable-containers-e2e-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "playwright": "^1.48.0",
    "playwright-webextext": "^0.0.5",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["harness", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

Firefox must launch once and not race across workers, so pin a single fork with generous timeouts.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

- [ ] **Step 4: Ensure build/test artifacts are git-ignored**

Read the existing `.gitignore`. If any of these lines are missing, append them:

```
node_modules/
test-results/
.playwright/
```

- [ ] **Step 5: Install dependencies and the Firefox browser binary**

Run:
```bash
npm install
npx playwright install firefox
```
Expected: install completes; `npx playwright install firefox` downloads the Playwright Firefox build (used by `playwright-webextext`).

- [ ] **Step 6: Verify the toolchain type-checks**

Run: `npm run typecheck`
Expected: exits 0 with no output (no `.ts` source files yet, so nothing to complain about).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold e2e spike toolchain (playwright + vitest + ts)"
```

---

## Task 2: Local static HTTP server

A throwaway page for tabs to load. Pure Node — fully unit-testable without Firefox, so we TDD it first. Uses port `0` (OS-assigned) so there is never a port conflict; the harness (not the probe) drives all navigation, so a dynamic port is fine.

**Files:**
- Create: `harness/server.ts`
- Test: `test/harness/server.test.ts`

- [ ] **Step 1: Write the failing test**

`test/harness/server.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { startServer } from "../../harness/server";

describe("startServer", () => {
  it("serves an http page with a title and closes cleanly", async () => {
    const server = await startServer();
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const res = await fetch(server.url);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<title>probe-target</title>");
    } finally {
      await server.close();
    }
    // After close, the port is released — a second connect should fail.
    await expect(fetch(server.url)).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/harness/server.test.ts`
Expected: FAIL — cannot resolve `../../harness/server`.

- [ ] **Step 3: Write minimal implementation**

`harness/server.ts`:
```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const HTML =
  "<!doctype html><html><head><title>probe-target</title></head>" +
  "<body>ok</body></html>";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/harness/server.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add harness/server.ts test/harness/server.test.ts
git commit -m "feat: throwaway local http server for e2e targets"
```

---

## Task 3: The probe extension

MV2 helper. It (a) writes each http(s) tab's `cookieStoreId` into that tab's `document.title`, and (b) creates one container at startup and opens a tab into it (only an extension can open a tab into a container), giving a non-default store to observe. The harness later navigates that tab to the local server to trigger a report.

**Files:**
- Create: `extensions/probe/manifest.json`, `extensions/probe/background.js`

- [ ] **Step 1: Create `extensions/probe/manifest.json`**

`contextualIdentities` requires both the `contextualIdentities` and `cookies` permissions; `tabs.executeScript` requires an `<all_urls>` host permission. A stable `gecko.id` is set (some `playwright-webextext` paths need it).

```json
{
  "manifest_version": 2,
  "name": "cc-e2e-probe",
  "version": "0.0.1",
  "browser_specific_settings": {
    "gecko": { "id": "probe@configurable-containers.test" }
  },
  "permissions": [
    "tabs",
    "contextualIdentities",
    "cookies",
    "<all_urls>"
  ],
  "background": { "scripts": ["background.js"] }
}
```

- [ ] **Step 2: Create `extensions/probe/background.js`**

```js
const REPORT_PREFIX = "CSID:";

// Surface a tab's cookieStoreId into its document.title so an external driver
// (Playwright) can read it via page.title(). Only http(s) pages are injectable.
async function reportTab(tabId, cookieStoreId) {
  try {
    await browser.tabs.executeScript(tabId, {
      code: "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";",
    });
  } catch (_e) {
    // about:, view-source:, moz-extension: pages cannot be injected — ignore.
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && /^https?:/.test(tab.url || "")) {
    reportTab(tabId, tab.cookieStoreId);
  }
});

// Self-provision one container so a non-default cookieStoreId exists to observe.
// Opens about:blank; the harness navigates this tab to the local server, which
// triggers the onUpdated report above with the container's cookieStoreId.
(async () => {
  const identity = await browser.contextualIdentities.create({
    name: "probe",
    color: "blue",
    icon: "circle",
  });
  await browser.tabs.create({
    cookieStoreId: identity.cookieStoreId,
    url: "about:blank",
  });
})();
```

- [ ] **Step 3: Verify the manifest is valid JSON**

Run: `node --input-type=module -e "import('node:fs').then(fs => JSON.parse(fs.readFileSync('extensions/probe/manifest.json','utf8')) && console.log('manifest ok'))"`
Expected: prints `manifest ok`.

- [ ] **Step 4: Commit**

```bash
git add extensions/probe/manifest.json extensions/probe/background.js
git commit -m "feat: mv2 probe extension exposing cookieStoreId via document.title"
```

---

## Task 4: Harness + default-store proof (first headless load)

This is the spike's primary de-risking step: does `playwright-webextext` load the unsigned probe headlessly, and can we read a tab's `cookieStoreId` end-to-end? We write the proof test first (TDD), then implement the harness.

**Files:**
- Create: `harness/firefox.ts`
- Test: `test/e2e/plumbing.test.ts`

- [ ] **Step 1: Write the failing proof test (default store only for now)**

`test/e2e/plumbing.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, readCookieStoreId, type Session } from "../../harness/firefox";

describe("harness plumbing", () => {
  let session: Session;

  beforeAll(async () => {
    session = await launch();
  });

  afterAll(async () => {
    await session?.close();
  });

  it("reads the default cookieStoreId end-to-end", async () => {
    const page = await session.context.newPage();
    await page.goto(session.serverUrl);
    expect(await readCookieStoreId(page)).toBe("firefox-default");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e/plumbing.test.ts`
Expected: FAIL — cannot resolve `../../harness/firefox`.

- [ ] **Step 3: Implement `harness/firefox.ts`**

```ts
import { firefox, type BrowserContext, type Page } from "playwright";
import { withExtension } from "playwright-webextext";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startServer, type TestServer } from "./server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.resolve(HERE, "../extensions/probe");

export interface Session {
  context: BrowserContext;
  serverUrl: string;
  close(): Promise<void>;
}

export async function launch(): Promise<Session> {
  const server: TestServer = await startServer();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "cc-e2e-"));

  const browserType = withExtension(firefox, PROBE_PATH);
  const context = await browserType.launchPersistentContext(userDataDir, {
    headless: true,
    // The contextualIdentities API is only available when the containers
    // feature is enabled; enable it explicitly so the probe can create one.
    firefoxUserPrefs: { "privacy.userContext.enabled": true },
  });

  return {
    context,
    serverUrl: server.url,
    async close() {
      await context.close();
      await server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

// Poll a tab's title until the probe has written "CSID:<cookieStoreId>".
export async function readCookieStoreId(page: Page, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = "";
  while (Date.now() < deadline) {
    lastTitle = await page.title();
    const m = lastTitle.match(/^CSID:(.+)$/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for probe report; last title: ${JSON.stringify(lastTitle)}`);
}
```

- [ ] **Step 4: Run the proof and OBSERVE**

Run: `npx vitest run test/e2e/plumbing.test.ts`
Expected: PASS — the title reads `CSID:firefox-default`, so `readCookieStoreId` returns `firefox-default`.

**Observe / Contingency (this is the spike's crux):**
- If it fails at `launch()` (extension not loaded, or hang): confirm `npx playwright install firefox` ran. Try `headless: false` once locally to watch what happens.
- If the pref did not take effect (relevant to Task 5, not this test): as a fallback, write `user.js` into `userDataDir` before launch with `user_pref("privacy.userContext.enabled", true);` instead of relying on `firefoxUserPrefs`.
- If `launchPersistentContext` is not supported by the wrapper: fall back to `withExtension(firefox, PROBE_PATH).launch({ headless: true, firefoxUserPrefs: {...} })`, then `const context = browser.contexts()[0] ?? await browser.newContext();`. Adjust `Session` to also hold `browser` and close it.
- If the wrapper cannot load an unsigned extension headlessly **at all**: stop and report. The documented fallback (spec §2) is Selenium/geckodriver `installAddon(path, true)` — that is a separate, larger change; do not build it silently.

- [ ] **Step 5: Verify types**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add harness/firefox.ts test/e2e/plumbing.test.ts
git commit -m "feat: playwright harness reads default cookieStoreId via probe"
```

---

## Task 5: Non-default container-store proof

Prove the read path carries a real container store, not just the default. The probe already created a container tab at startup; the harness navigates every open tab to the local server and collects the reported stores, asserting a `firefox-container-N` appears.

**Files:**
- Modify: `harness/firefox.ts` (add `collectStoresUntilContainer`)
- Modify: `test/e2e/plumbing.test.ts` (add the second proof)

- [ ] **Step 1: Add the failing test**

Append inside the `describe` block in `test/e2e/plumbing.test.ts`:
```ts
  it("observes a non-default container store", async () => {
    const stores = await collectStoresUntilContainer(session.context, session.serverUrl);
    expect(stores).toContain("firefox-default");
    expect(stores.some((s) => /^firefox-container-\d+$/.test(s))).toBe(true);
  });
```

And extend the import at the top of the file:
```ts
import {
  launch,
  readCookieStoreId,
  collectStoresUntilContainer,
  type Session,
} from "../../harness/firefox";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e/plumbing.test.ts`
Expected: FAIL — `collectStoresUntilContainer` is not exported.

- [ ] **Step 3: Implement `collectStoresUntilContainer` in `harness/firefox.ts`**

Add this export (after `readCookieStoreId`):
```ts
// Navigate every open tab to `url` (triggering a probe report on each) and
// collect their cookieStoreIds. Retries until a container store appears or the
// deadline passes, tolerating the probe's container tab arriving asynchronously.
export async function collectStoresUntilContainer(
  context: BrowserContext,
  url: string,
  timeoutMs = 15_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let stores: string[] = [];
  while (Date.now() < deadline) {
    stores = [];
    for (const page of context.pages()) {
      try {
        await page.goto(url, { waitUntil: "load" });
        stores.push(await readCookieStoreId(page, 2000));
      } catch {
        // A tab may have closed/navigated mid-loop; skip it this round.
      }
    }
    if (stores.some((s) => /^firefox-container-\d+$/.test(s))) return stores;
    await new Promise((r) => setTimeout(r, 500));
  }
  return stores;
}
```

- [ ] **Step 4: Run the proof and OBSERVE**

Run: `npx vitest run test/e2e/plumbing.test.ts`
Expected: PASS (2 tests) — collected stores include both `firefox-default` and a `firefox-container-N`.

**Observe / Contingency:**
- If no container store ever appears, the probe's `contextualIdentities.create` likely failed (containers feature disabled). Apply the `user.js` pref fallback from Task 4 Step 4, then re-run.
- If extension-opened tabs never show up in `context.pages()`, the container tab exists but is invisible to this Playwright context. Confirm `launchPersistentContext` was used (not `launch()`); if a `launch()` fallback is in force, enumerate `browser.contexts()[0].pages()` instead.

- [ ] **Step 5: Commit**

```bash
git add harness/firefox.ts test/e2e/plumbing.test.ts
git commit -m "feat: observe non-default container cookieStoreId via probe"
```

---

## Task 6: Record the outcome & correct TESTING.md

The spike's deliverable is a *validated* mechanism plus an honest record of what held up.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-09-e2e-harness-plumbing-spike-design.md` (append outcome)
- Modify: `TESTING.md` (correct the L4 driver claim with evidence)

- [ ] **Step 1: Append a "Spike outcome" section to the spec**

Add to the end of the spec file, filling in the real answers observed while running Tasks 4–5:
```markdown
## 11. Spike outcome (2026-07-09)

- `playwright-webextext` loaded the unsigned MV2 probe headlessly: **<yes/no>**.
- `firefoxUserPrefs` propagated the containers pref: **<yes / needed user.js fallback>**.
- Extension-opened tabs were visible in `context.pages()` via
  `launchPersistentContext`: **<yes/no>**.
- Selenium fallback needed: **<no / yes — reason>**.
- Both proofs green: **<yes/no>**.
```

- [ ] **Step 2: Correct the L4 driver line in TESTING.md**

In `TESTING.md`, the L4 section and the "Recommended stack" line describe L4/L5 as "web-ext + Playwright". Replace the mention of the L4/L5 driver with the validated approach. Change:
> **web-ext + Playwright (Firefox)** for L4 and L5

to:
> **Playwright + `playwright-webextext` (Firefox)** for L4 and L5 — Playwright core cannot load Firefox extensions, so `playwright-webextext` installs them over Firefox's remote debugging protocol (validated by the plumbing spike, 2026-07-09; Selenium/geckodriver `installAddon` is the fallback)

- [ ] **Step 3: Run the full suite once more**

Run: `npm test`
Expected: all tests green (`server.test.ts` + `plumbing.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-09-e2e-harness-plumbing-spike-design.md TESTING.md
git commit -m "docs: record spike outcome; correct TESTING.md L4 driver"
```

---

## Out of scope for this plan (deferred, per spec)

- CI wiring (spec §9) — the proofs run locally; a GitHub Actions job is a follow-up.
- MAC + Temporary Containers coexistence, disposal timing, cookie-boundary, and the full `TESTS.md` acceptance suite — later levels of the TESTING.md pyramid.
