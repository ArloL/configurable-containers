# L4 — Real Firefox Adapter — Design

**Date:** 2026-07-27
**Status:** Implemented
**Topic:** The first real execution of the L3 engine in Firefox: a real
`BrowserPort` over `browser.*`, packaged as an MV2 extension, proven with a
Selenium/geckodriver L4 test that a matching host is reopened into its named
container and an unmatched host into a throwaway.

## 1. Goal & scope

The pure core (L1 resolver, L2 matcher, PSL same-site, config parser) and the L3
interception engine are done and mock-tested. This slice adds the **real edge** —
an implementation of the `BrowserPort` interface over `browser.*` — packages the
engine as a loadable MV2 extension, and proves it runs once in real Firefox.

The engine (`src/engine/engine.ts`), registry (`registry.ts`), port interface
(`port.ts`), and the resolver/matcher/psl/config modules **do not change**. L4 only
adds a real port, packaging, and a real-browser test.

### In scope

- `src/engine/browser-port.ts` — the real `BrowserPort` over `browser.*`.
- An MV2 CC extension: manifest, a bundled background entry, a bundled fixed config.
- esbuild packaging (bundles the TS + `tldts` + `yaml` into one `background.js`).
- Harness changes: `launch()` loads probe-only by default or `probe+cc` for L4;
  build+zip the CC xpi; new `readContainerName` / `awaitContainerTab` helpers.
- Probe change: also report the container **name** via a DOM attribute (the
  `CSID:<store>` title format is untouched).
- Two Selenium/geckodriver e2e tests: match → named container; unmatched → tmp.

### Out of scope (deferred)

- **MAC interop / F7 in real Firefox** — installing the actual Multi-Account
  Containers add-on and asserting the defer handshake.
- **In-browser F2** (already-contained stays), **F10** disposal, **F12**
  overlays/redirector, **F9** redirect binding, **F8** MV3 restart.
- **Config from storage / the config editor UI** — the config is bundled and fixed
  for this slice.
- **MV3** — deliberately MV2 now (F8 restart semantics deferred).

## 2. Architecture & file layout

Nothing in the pure core or the L3 engine changes. L4 adds a real implementation of
the existing `BrowserPort` interface plus packaging and a real-browser test.

```
                     ┌──────────── Firefox (headless, Selenium) ────────────┐
  test/e2e/          │  extensions/cc/ (MV2, loaded)      extensions/probe/  │
  routing.test.ts ───┼─► background.js (esbuild bundle)     (observer,       │
  (drives + asserts) │    = createEngine({ realPort,          reports store  │
        ▲            │        parseConfig(BUNDLED_YAML),        + name)       │
        │ store+name │        deps, onChoice:noop })              │          │
        │            │           │ browser.webRequest/tabs/       │          │
        └────────────┼───────────┴── contextualIdentities ─► new tab ────────┘
                     │                 reopen              probe writes
  harness/firefox.ts ┘  builds+zips CC.xpi & probe.xpi,    CSID:<store> title
  (loads BOTH,          installs both, starts server,      + data-cc-container attr
   esbuild build)       sets network.dns.localDomains
```

New / changed files:

```
src/engine/browser-port.ts       Real BrowserPort over browser.* (the L4 adapter)
src/extension/background.ts       Entry: real port + parseConfig(config) + createEngine
src/extension/config.ts           Bundled fixed config (YAML string) for this slice
extensions/cc/manifest.json       MV2 manifest
extensions/cc/background.js        esbuild OUTPUT (gitignored; built at launch)
harness/build-extension.ts        esbuild bundle of background.ts -> extensions/cc/background.js
harness/firefox.ts (modify)       launch({extensions}); readContainerName; awaitContainerTab;
                                  set network.dns.localDomains
extensions/probe/background.js (modify)  also report container name via a DOM attribute
test/e2e/routing.test.ts          L4 tests: match -> named container; unmatched -> tmp
package.json (modify)             add esbuild + @types/firefox-webext-browser devDeps
tsconfig.json (modify)            types: ["node", "firefox-webext-browser"]
.gitignore (modify)               ignore extensions/cc/background.js
```

Boundary decisions:

- The real port is the **only new production code**; a mechanical, logic-free
  mapping. All decisions still come from `resolve()`.
- `launch()` stays **probe-only by default** so the plumbing tests are untouched;
  L4 opts into `probe+cc`.
- The CC background is **built at launch** (esbuild) into a gitignored
  `background.js`, then zipped — same pattern as `buildProbeXpi`, no committed
  artifact.

## 3. The real `BrowserPort` (browser-port.ts)

A mechanical mapping. The one Firefox-specific capability: a **blocking
`onBeforeRequest` listener may return a `Promise`** of the `BlockingResponse` —
Firefox awaits it before the request proceeds, which is what the async handler
needs.

```ts
import type {
  BrowserPort, ContextualIdentity, CreateIdentityProps, CreateTabProps, Tab, WebRequestDetails,
} from "./port";

export function createBrowserPort(): BrowserPort {
  return {
    onBeforeRequest(handler) {
      browser.webRequest.onBeforeRequest.addListener(
        (d) => handler({
          requestId: d.requestId, tabId: d.tabId, url: d.url, type: d.type,
          method: d.method, originUrl: d.originUrl, documentUrl: d.documentUrl,
        }),
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

    async removeTab(tabId) { await browser.tabs.remove(tabId); },

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

**Types:** `@types/firefox-webext-browser` (a types-only devDependency) supplies the
global `browser` namespace, so the mapping type-checks against the real
signatures. Because `tsconfig.json` currently pins `types: ["node"]` (which excludes
every other `@types` package), it must be widened to
`types: ["node", "firefox-webext-browser"]`. esbuild strips types and bundles the
runtime, where the real `browser.*` exists.

## 4. Extension packaging & build

`extensions/cc/manifest.json` (MV2):

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

**`cookies` is required, not optional:** Firefox rejects `tabs.create({ cookieStoreId })`
into a container with `Error: No permission for cookieStoreId: …` unless the
extension holds the `cookies` permission. Without it every reopen throws, the
engine fail-opens, and nothing is routed. (The probe has `cookies` for the same
reason.)

`src/extension/config.ts` — the bundled fixed config, a YAML string run through the
real parser (so L4 exercises parser → matcher → resolver → engine end-to-end):

```ts
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
`;
```

`src/extension/background.ts` — the entry esbuild compiles:

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

`harness/build-extension.ts` — esbuild's JS API bundles `background.ts` →
`extensions/cc/background.js`:

```ts
import { build } from "esbuild";
// build({ entryPoints: [<src/extension/background.ts>], bundle: true,
//         outfile: <extensions/cc/background.js>, format: "iife",
//         target: "firefox115", platform: "browser" })
```

Called by `launch()` before zipping, exactly like `buildProbeXpi` — the output is
gitignored and always fresh.

**Loading both extensions.** `launch()` gains an options arg:

```ts
launch({ extensions?: ("probe" | "cc")[] })   // default ["probe"] — plumbing unchanged
```

For L4: `launch({ extensions: ["probe", "cc"] })`. It builds/zips each requested
extension and calls `installAddon` for each. CC intercepts navigations; the probe
observes.

## 5. Observation, host routing, and the L4 test flow

**Host routing.** Distinct loopback IPs fail on macOS (127.0.0.2 is not a loopback
alias without `sudo`), so use the Firefox pref **`network.dns.localDomains`** — a
comma-separated list Firefox resolves straight to 127.0.0.1, deterministically and
cross-platform:

- `launch()` sets `network.dns.localDomains = "work.example,nomatch.example"`.
- the server keeps listening on `127.0.0.1`.
- the bundled rule matches `work.example`; navs go to `http://work.example:PORT/`
  (→ Work) and `http://nomatch.example:PORT/` (no rule → tmp).

**Observation — extend the probe to report the container name.** The title
`CSID:<store>` format is untouched (plumbing tests keep passing); a DOM attribute is
added:

```js
// extensions/probe/background.js — reportTab resolves the container name too
async function reportTab(tabId, cookieStoreId) {
  let name = "";
  try { name = (await browser.contextualIdentities.get(cookieStoreId)).name; }
  catch (_e) { /* firefox-default has no identity */ }
  try {
    await browser.tabs.executeScript(tabId, {
      code:
        "document.title = " + JSON.stringify(REPORT_PREFIX + cookieStoreId) + ";" +
        "document.documentElement.setAttribute('data-cc-container', " + JSON.stringify(name) + ");",
    });
  } catch (_e) { /* non-injectable page */ }
}
```

**Harness helpers** (`harness/firefox.ts`):

```ts
export async function readContainerName(driver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-container') || '';"
  )) as string;
}

// Poll window handles (WITHOUT re-navigating them — CC does the reopening) until a
// tab shows `url` in a non-default container; return its store + reported name.
export async function awaitContainerTab(driver, url, timeoutMs = 15_000):
  Promise<{ store: string; name: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const h of await driver.getAllWindowHandles()) {
      try {
        await driver.switchTo().window(h);
        const m = (await driver.getTitle()).match(/^CSID:(.+)$/);
        if (m && /^firefox-container-\d+$/.test(m[1]) &&
            (await driver.getCurrentUrl()).startsWith(url)) {
          return { store: m[1], name: await readContainerName(driver) };
        }
      } catch { /* handle closed mid-loop */ }
    }
    await driver.sleep(300);
  }
  throw new Error(`no container tab for ${url} within ${timeoutMs}ms`);
}
```

**L4 test flow** (`test/e2e/routing.test.ts`): each case opens a fresh
`firefox-default` tab (`driver.switchTo().newWindow("tab")`), navigates it
(tolerating the old tab being torn down when CC cancels+reopens), then awaits the
resulting container tab:

```
match:  newWindow → get(http://work.example:PORT/)    [CC cancels + reopens into Work]
        awaitContainerTab(work.example) → expect name === "Work"
tmp:    newWindow → get(http://nomatch.example:PORT/)  [CC reopens into a fresh tmp]
        awaitContainerTab(nomatch.example) → expect name starts with "tmp",
        and store differs from the Work case
```

Because CC cancels the main_frame request, the page never loads in the old tab —
only the reopened container tab ever reports for that URL, so `awaitContainerTab`
cannot be fooled by the pre-reopen tab. The probe's self-provisioned `about:blank`
container tab never matches (wrong URL, no `CSID:` title).

## 6. Risks (verify live during implementation)

| Risk | Mitigation |
|---|---|
| **Async blocking listener** — the handler awaits `getTab`/`getIdentity`/`sendExternalMessage`, so `onBeforeRequest` returns a `Promise<BlockingResponse>`; Firefox must await it before proceeding. | Documented Firefox behavior; confirm the cancel truly blocks (no wrong-container flash). The decision core is synchronous — only port lookups are async — so a cached fast-path is possible if ever needed. |
| **`network.dns.localDomains`** may not resolve the fake domains on the pinned Firefox. | Verify first; fallback to `*.localhost` (Firefox loopback) or a tiny PAC/proxy. |
| **Selenium tab-handle churn** — CC removes the navigated tab; `driver.get`/handle ops can throw. | `awaitContainerTab` tolerates closed handles and polls; the initial `get` is wrapped. Main flake source — tune timeouts. |
| **Two extensions loaded** — probe reports on CC-created tabs (intended); CC ignores the probe's `about:blank` tab. | `launch()` stays probe-only by default so plumbing is unaffected; only L4 opts into `probe+cc`. |
| **CI** — needs system Firefox (`FIREFOX_BIN`) already; esbuild now runs as a build step. | esbuild is a normal devDep installed by `npm ci`; the build runs inside `launch()`. No new browser infra. |

## 7. Testing scope (L4)

Two Vitest e2e tests in `test/e2e/routing.test.ts` sharing one launched `probe+cc`
session (mirrors `plumbing.test.ts`):

1. **match → named container** — nav `work.example` ⇒ reopened tab's reported name
   is `"Work"`.
2. **unmatched → tmp** — nav `nomatch.example` ⇒ reopened tab's name starts with
   `"tmp"`, and its store differs from case 1.

Regression guard: the plumbing tests and all L1–L3 unit tests must stay green (the
probe title format and the engine code are untouched).

## 8. What this slice does *not* prove

MAC interop / F7 in real Firefox (deferred), in-browser F2, disposal (F10),
overlays/redirector (F12), redirect binding (F9), MV3 restart (F8), and
config-from-storage / editor. It proves exactly one thing, end-to-end in real
Firefox: **the mock-tested engine, wired through the real `BrowserPort` and packaged
as an MV2 extension, routes a matching host into its named container and an
unmatched host into a throwaway** — de-risking the adapter, the packaging/build, and
the observation mechanism for everything above it.

**Follow-up (noted, not in scope):** the e2e spike flagged that `TESTING.md`'s
L4/L5 "web-ext + Playwright" line is stale (the driver is Selenium/geckodriver).
Since this slice is the first real L4, updating that row is a natural tag-along but
not required here.

## 9. Findings from real Firefox (what the mocks missed)

L4 did its job — running the mock-tested engine in real Firefox 153 (release,
unsigned temporary install) surfaced two defects the L3 mocks could not:

1. **Missing `cookies` permission** (§4) — `tabs.create({ cookieStoreId })` throws
   `No permission for cookieStoreId` without it. Fix: add `cookies` to the manifest.
   The mock port never enforced this, so L3 was blind to it.

2. **F1 reopen loop — the reopened tab re-reopens forever.** When CC creates the new
   container tab, its `onBeforeRequest` fires **before the tab's `url` commits**, so
   the tab still reads as `about:blank`. `buildNavContext` mapped that to
   `current = null`, `resolve()` could not tell the tab was *already* in the target
   container, and it reopened again — spawning/closing tabs endlessly. The structural
   F2 "already-contained → stay" guard the L3 spine relied on never triggered because
   it keys off `current`, which was null. The L3 mocks missed this because the mock
   `createTab` set the new tab's `url` to the target immediately; real event ordering
   does not.

   **Fix (engine):** track the tab id of every tab we create by reopening, and leave
   its **first** navigation alone (`freshlyReopened` set + a one-shot guard in the
   handler). This is the tab-scoped F1 guard the spine deferred as "the
   different-requestId-same-tab case"; the reopen-into-a-new-tab path makes it
   mandatory, not optional. Covered by a new L3 mock test that models the
   blank-url reopened tab.

Note this required editing `src/engine/engine.ts` — the slice's original assumption
that the engine would not change was wrong. That is the expected value of L4: the
deterministic levels prove logic, the real browser proves the logic survives real
event ordering.

**Not needed:** the extension loads and uses blocking `webRequest` on **release**
Firefox via unsigned temporary install — no Firefox Developer/Nightly/ESR build,
signing, or pre-seeded profile is required. (An earlier mis-bisection pointed at
`webRequest`/signing; it was the `cookies` gap plus the reopen loop.)
