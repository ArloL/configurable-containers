# E2E Harness Plumbing Spike — Design

**Date:** 2026-07-09
**Status:** Approved, pending implementation plan
**Topic:** Prove the L4/L5 test-harness plumbing before Configurable Containers (CC) exists.

## 1. Goal & scope

Before building CC itself, prove the single foundational capability every later
E2E test depends on:

> A TypeScript test can launch **headless Firefox**, load an **unsigned
> extension**, drive a tab, and read that tab's **`cookieStoreId`** back from the
> driver — including a *non-default* container store, so there is no doubt the
> read path carries real container values.

`cookieStoreId` is a WebExtension-internal value. It is **not** exposed to
page-level DOM automation, so the entire risk in this spike is *how the value
gets from inside the browser out to the test*. Proving that path is the whole
point.

### In scope

- Launch headless Firefox from a TS test.
- Load an unsigned extension (the "probe") via Playwright + `playwright-webextext`.
- Observe a tab's `cookieStoreId` — both the default store and a real container store.

### Explicitly out of scope (deferred to later levels)

- MAC + Temporary Containers coexistence (the future MAC-interop contract, TESTING.md L4).
- Disposal timing / lifecycle (F10).
- Cookie-boundary assertions (F11).
- The full `TESTS.md` acceptance suite (L5).
- Loading any third-party extension, building any `.xpi`, or any network fetch —
  the spike is **self-contained**.

## 2. Stack & decision record

| Concern | Choice | Rationale |
|---|---|---|
| Language | **TypeScript** | Matches TESTING.md's recommended stack. |
| Test runner | **Vitest** | TESTING.md's L1–L3 choice; one runner across all levels. |
| Browser | **Firefox (release), headless** | The extension target. |
| Launcher | **Playwright `firefox` + [`playwright-webextext`](https://github.com/ueokande/playwright-webextext)** | Loads unsigned extensions over Firefox's remote debugging protocol (same mechanism as `web-ext`). Keeps TESTING.md's documented Playwright stack. Brings built-in network interception (needed later for F9 redirect/POST-binding) and failure artifacts (trace/video/screenshot — the CI sketch wants screenshots on failure). |
| Observation | **Probe extension → DOM** | `cookieStoreId` is invisible to page automation; a small helper extension surfaces it via `document.title`, read with plain `page.title()`. Uses the same public `browser.*` API the future CC tests assert against — no privileged/internal Firefox APIs. |

### Why not the alternatives

- **Playwright core alone** — cannot load extensions in Firefox (Chromium-only
  feature). `playwright-webextext` is the bridge.
- **Selenium/geckodriver `installAddon`** — solid and first-party, but weaker page
  ergonomics, no built-in network interception or trace artifacts, and would
  require rewriting TESTING.md's stack. **Retained as the documented fallback**
  if the spike shows `playwright-webextext` is unreliable.
- **Marionette / chrome-context observation** — reads Firefox internals directly
  (no probe ext), but brittle across versions and transfers poorly to L4/L5,
  which speak `browser.*`.

### Dependency risk (accepted, with mitigation)

`playwright-webextext` is early (v0.0.5, ~32★, single maintainer, ~71 commits).
It is a thin RDP shim, MIT-licensed, and easily vendored/forked if it breaks. Its
one documented caveat — an MV3 content-script permission prompt — **does not
affect this spike**, because the probe is MV2. Validating that the wrapper
reliably loads an unsigned extension headlessly is itself an explicit deliverable
of the spike (see §6).

## 3. Repository layout

```
package.json          # deps: playwright, playwright-webextext, vitest, typescript
tsconfig.json
vitest.config.ts
extensions/probe/     # the probe extension
  manifest.json       # MV2
  background.js
harness/
  firefox.ts          # launch / load probe / navigate / read cookieStoreId / teardown
test/e2e/
  plumbing.test.ts    # the two proofs
```

## 4. The probe extension (MV2)

The one component that bridges WebExtension-internal state → observable DOM. It is
deliberately the germ of the general **test-agent** extension that L4/L5 will grow
(later exposing `contextualIdentities.query`, `cookies.getAll` per store,
lifecycle events).

- **Manifest:** MV2 (simplest; sidesteps the MV3 content-script caveat and
  service-worker restart concerns, which are irrelevant to plumbing).
- **Permissions:** `tabs`, `contextualIdentities`, `<all_urls>` (for
  `tabs.executeScript`). A stable `browser_specific_settings.gecko.id` is set.
- **Passive reporting:** on `tabs.onUpdated` `status === 'complete'`, the
  background reads `tab.cookieStoreId` and writes `CSID:<cookieStoreId>` into that
  tab's `document.title` via `tabs.executeScript`. Any driver can then read it
  with a plain title lookup. (Runs only on `http(s)` pages — `tabs.executeScript`
  cannot inject into `about:` pages.)
- **Self-provisioning a container:** at startup the background creates a
  `contextualIdentity` (name `probe`) and opens a tab into it
  (`tabs.create({ cookieStoreId })`). Only an extension can open a tab into a
  container, so the probe does it — this is what yields a *non-default* store to
  observe with **zero external dependencies**.

## 5. Harness API (`harness/firefox.ts`)

Thin, typed wrapper over Playwright + `playwright-webextext`:

- `launch()` → `withExtension(firefox, probePath).launch({ headless: true })`,
  returns a browser/context with the probe loaded and a fresh profile.
- `navigate(page, url)` → `page.goto(url)`.
- `readCookieStoreId(page)` → poll `page.title()` until it matches `/^CSID:/`,
  return the captured store id.
- `tabsWithStores(context)` → iterate `context.pages()`, collect
  `{ page, cookieStoreId }`.
- `teardown(browser)`.

## 6. The proofs (`test/e2e/plumbing.test.ts`)

Two Vitest tests, sharing one launched browser:

1. **Default store — end-to-end read path.** Load probe, `navigate` a page to a
   real `http(s)` URL (e.g. `https://example.com`), assert `readCookieStoreId`
   returns `firefox-default`. Proves the entire load → observe → read chain.
2. **Non-default container store.** Enumerate `context.pages()`, find the probe's
   self-provisioned container tab, assert its store matches
   `/^firefox-container-\d+$/` and differs from `firefox-default`. Removes any
   doubt the path carries real container values.

## 7. Data flow

```
Vitest test
  └─ harness.launch()  ──(playwright-webextext, RDP)──►  headless Firefox + probe
       probe (startup): create contextualIdentity → tabs.create({cookieStoreId})
  └─ harness.navigate(page, https://example.com)
       probe (onUpdated complete): tab.cookieStoreId → tabs.executeScript →
         document.title = "CSID:firefox-default"
  └─ harness.readCookieStoreId(page)  ◄── page.title()  ==  "CSID:firefox-default"
  └─ harness.tabsWithStores(context)  ◄── container tab title "CSID:firefox-container-N"
```

## 8. Risks / verify live during the spike

- **First check:** confirm `playwright-webextext` loads the unsigned probe
  **headlessly** on the pinned Firefox + Playwright versions. This is the spike's
  primary de-risking deliverable; if it fails or is flaky, fall back to
  Selenium/geckodriver `installAddon` (§2).
- Confirm RDP temporary-install (via `playwright-webextext`) doesn't require
  Nightly or `xpinstall.signatures.required=false` on release Firefox.
- `tabs.executeScript` won't run on `about:` pages — the proofs use real
  `http(s)` pages accordingly. (`https://example.com` needs network; if CI
  isolation forbids egress, serve a trivial local page instead — decide during
  implementation.)

## 9. CI

Headless + a stock GitHub Actions Firefox runner, no extra driver setup
(`playwright-webextext` uses Playwright's bundled Firefox). On failure, upload
Playwright trace/screenshot artifacts.

## 10. What this spike does *not* prove (be honest)

It proves the read path, not the assertions that ride it. Container
create/dispose timing, cookie isolation, MAC interop, and redirect binding are all
future levels. The value delivered is a **validated, reusable observation
mechanism** (the probe) and a **validated launcher** (Playwright +
`playwright-webextext`) — the foundation the rest of the L4/L5 pyramid is built
on.
