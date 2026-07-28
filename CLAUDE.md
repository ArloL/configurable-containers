# CLAUDE.md — Configurable Containers

A Firefox WebExtension that routes each site into the right container from one
user config. Orientation lives elsewhere: `README.md` (goals), `CONFIG.md` (config
format + feature list F1–F12), `TESTING.md` (the test pyramid), and
`docs/superpowers/specs/` + `plans/` (per-slice design of record). This file only
records what the code and those docs *don't* say — the things a cold start gets
wrong.

## Where logic lives — don't misplace it

The routing decision is a **pure function**: `resolve(nav, config, deps)` in
`src/resolver/`. The **engine** (`src/engine/engine.ts`) is a *thin adapter* — it
turns real `browser.*` events into a `NavContext`, calls `resolve()`, and executes
the returned `Decision`. Put routing/matching logic in the resolver or matcher,
**never** in the engine. `src/engine/port.ts` (`BrowserPort`) is the only seam that
touches `browser.*`; every dependency is injected so the core is testable without a
browser.

Layers (mirror TESTING.md): L1 `src/resolver/` (pure) · L2 `src/matcher/` · PSL
`src/psl/` · config `src/config/` · L3 `src/engine/` (interception engine +
disposer, tested against a mock `browser.*` + a fake clock) · L4 real Firefox
(`harness/`, `test/e2e/`, Selenium/geckodriver). The engine, auto-temp,
disposer, cookie-seeder, script-injector, redirector-closer, and picker are all
**siblings**, wired at the extension entry `src/extension/background.ts` — none is
nested in `createEngine`. The choice screen / reopen-picker UI lives in `src/extension/choice.ts`
(a separate esbuild entry point bundled to `extensions/cc/choice.js`, loaded by
`choice.html`); the pure protocol it shares with `src/engine/picker.ts` is
`src/extension/picker-protocol.ts`.

`createEngine` returns `{ reopen }` — the F1-guarded reopen effect. The picker calls
`engine.reopen` (injected) so its choice-driven reopen goes through the
`freshlyReopened` guard; never reopen a tab by hand in the picker, and don't make
`createEngine` return `void` again — the picker's correctness depends on reusing the
engine's reopen, not duplicating it.

## Firefox extension constraints (learned through debugging)

- **Keep the `cookies` permission** in `extensions/cc/manifest.json`. Firefox throws
  `No permission for cookieStoreId` on `tabs.create({ cookieStoreId })` without it,
  so every container reopen silently fails and nothing routes. Any code opening a tab
  into a container needs it.
- **Auto-temp (`createAutoTemp` in `src/engine/auto-temp.ts`) containerizes `about:newtab`
  / `about:home` into a fresh temporary immediately on `tabs.onCreated`.** It is wired
  alongside the other siblings (engine, disposer, cookie-seeder, script-injector,
  redirector-closer, picker) in `src/extension/background.ts` — not nested in
  `createEngine`. It uses a `creating` flag to guard its own replacement tab. It shares a
  `tmpSuffix` counter with the engine so temp-container names never collide. The
  first http(s) navigation from an auto-temp tab goes through normal engine routing —
  auto-temp is purely about containerizing the new-tab page itself. Don't remove the
  engine's non-http guard: it still keeps the F1 reopen loop safe (the engine must not
  try to reopen non-http navigations).
  **Crucially, auto-temp listens on BOTH `onTabCreated` AND `onTabUpdated`.** In real
  Firefox, `tabs.onCreated` sometimes fires with `about:blank` (bug 1586612), so the
  real URL only appears via a subsequent `onTabUpdated`. An early draft that listened
  only on `onCreated` passed the L3 mock test (which fires events with `about:newtab`
  directly) but silently failed in real Firefox. A `processed` set of tab IDs
  deduplicates between the two events so a tab caught early by `onCreated` is not
  re-containerized by a later `onUpdated`.
- **Never pass `about:newtab` (or `about:home`) to `tabs.create`.** Firefox rejects it
  with `Error: Illegal URL: about:newtab` — an extension can only *land* on the new-tab
  page by passing **no url at all** (hence `CreateTabProps.url` is optional). Auto-temp
  shipped once with `url: tab.url` and every `containerize()` threw *after* creating the
  tmp identity: orphan `tmp…` containers, no tab ever moved, and the only symptom was a
  swallowed `console.warn`. TCP dodges this by passing url only when it matches
  `/^https?:/`.
- **`about:blank` must NOT be an auto-temp candidate.** A Firefox tab reads as
  `about:blank` for its entire *pre-commit* life, so a tab en route to a real page is
  indistinguishable from a blank one at `onCreated`/early-`onUpdated` time (verified:
  `tabs.create({url:"http://…"})` fires `onCreated url="about:blank" csid=firefox-default`,
  and the url appears only in a later `onUpdated`). Containerizing it would destroy
  target=_blank / window.open / engine-reopen tabs before they load. Cost of the rule:
  users with `browser.newtabpage.enabled=false` get `about:blank` on Ctrl+T and are not
  auto-containerized — same limitation as TCP.
- **The engine's `freshlyReopened` tab-id guard is load-bearing.** When the engine
  reopens a tab, the *new* tab's `onBeforeRequest` fires **before its url commits**
  (it still reads as `about:blank`), so `resolve()` can't tell it is already in the
  target container and would reopen forever (the F1 loop). The guard leaves a
  reopened tab's first navigation alone. Preserve it across any engine/MV3 rework.
- Temporary containers are identified **by the `tmp` name prefix** (`TMP_PREFIX` in
  `src/engine/registry.ts`), not a stored set — durable across a background restart.
  The disposer removes only `tmp…` containers; it never touches permanent/user ones.

## Config lives in storage, not in the bundle

- **`__CC_CONFIG_YAML__` is the first-run SEED, not the live config.** `src/extension/config.ts`
  exports it as `SEED_CONFIG_YAML`; the live config is `browser.storage.local.configYaml`,
  written on first run and truth from then on. A later version shipping a different seed
  **never** overrides an edited config — that is the point, not a bug. Three builds inject
  three different seeds: e2e gets `TEST_CONFIG_YAML` (`harness/build-extension.ts`),
  `npm run manual` gets the author's `configurable-containers.config.yaml`, and
  `npm run package` gets the shipped `src/config/default.yaml`.
- **First run seeds storage even when the seed does not parse.** Storing the broken text is
  what lets the editor CC opens for it show that text *and* its parse error. An earlier
  draft wrote storage only on a clean parse, and the editor came up blank and valid — the
  config apparently vanished, with nothing to fix. `test/e2e/options.test.ts` covers this.
- **A broken stored config must never fall back to the seed.** `loadConfig` (`src/config/load.ts`)
  returns the *empty* config plus the error, so everything opens in a throwaway and the
  editor is opened. Falling back would route against months-stale rules — a silent wrong
  answer where temporary-only is a loud one. Note `parseConfig("")` does not throw: an
  empty config is legal and means "nothing matches".
- **Every `browser.*` listener must be registered SYNCHRONOUSLY as `background.ts`
  evaluates — never after an `await`.** The storage read is async, and wiring the siblings
  inside an async IIFE (as the 2026-07-28 design spec originally proposed) loses the
  session's **first navigation** outright: Firefox dispatches it before
  `webRequest.onBeforeRequest` exists, so that tab is never routed and sits in
  `firefox-default` forever. It is not a millisecond window and not flake — all four
  event-driven cases in `test/e2e/auto-temp.test.ts` went red, deterministically. Two
  devices keep registration synchronous, and both are load-bearing:
  1. `config` is a **single object filled in place** (`Object.assign`) once storage
     resolves. Every sibling but the script-injector reads `config.rules` / `config.groups`
     at *event* time, so they all observe the load through that shared reference. Don't
     "clean this up" by passing a fresh parsed object — the siblings would keep the empty one.
  2. `gatedPort` wraps `onBeforeRequest` so the blocking handler `await`s a `configReady`
     promise. An early navigation is therefore **delayed**, not routed against the empty
     config. This is safe only because Firefox awaits a blocking listener's returned
     promise before the request proceeds (see `src/engine/browser-port.ts`).
  `createScriptInjector` is the one sibling that consumes config eagerly, so it is the one
  that legitimately waits.
- **Saving reloads the extension** (`browser.runtime.reload()`), which is why the
  `tmpSuffix` counter is raised past existing container names via `highestTmpSuffix`
  (`src/engine/registry.ts`) instead of restarting at 0 — otherwise every save reissues
  `tmp1` alongside a live `tmp1`.

## Testing reality

- `npm test` runs everything (unit **and** e2e) under Vitest; `npm run typecheck`
  for tsc. `tsconfig.json` typechecks `test/` too, so test code must type-clean.
- **e2e launches a real system Firefox via Selenium/geckodriver.** CI installs
  Firefox and sets `FIREFOX_BIN`; Selenium Manager provisions geckodriver. `npm test`
  skips nothing — expect Firefox windows to open.
- **Unsigned extensions load on *release* Firefox via *temporary* install**
  (`installAddon(xpi, true)`), which grants `webRequest`/`webRequestBlocking` and all
  permissions. Do **not** reach for Developer Edition, Nightly, or AMO signing to
  "fix" a load failure — `xpinstall.signatures.required=false` is ignored on release
  and only *permanent* install needs signing. (A long detour blamed signing; it was
  actually the missing `cookies` perm plus the F1 loop.)
- **Keep `fileParallelism: false` in `vitest.config.ts`.** Several tests bundle the
  CC extension to the same `extensions/cc/background.js`; parallel files race on that
  artifact and flake the disposal e2e. Don't re-enable parallelism.
- esbuild constant-folds numbers in the bundle (`300000` → `3e5`); assert against
  esbuild's form, not the source literal.
- **Revert-verify every new regression test: confirm it FAILS with the fix backed out.**
  This suite has shipped false greens twice over — three e2e tests that passed with
  auto-temp entirely broken (they reached a `tmp` container via the engine instead),
  and L3 tests that asserted the bug itself. Both looked fine. Back the fix out, watch
  the test go red, restore it — and restore from an editor edit or a copy, **not**
  `git checkout`, which silently discards uncommitted work.
- **`test/engine/mock-port.ts` fidelity is load-bearing.** When L3 is green but real
  Firefox misbehaves, suspect the mock accepts something Firefox rejects. It now fires
  `onTabCreated` from `createTab` (as Firefox does, which is what makes a listener
  re-enter its own handler) and throws on privileged `about:` URLs. Never relax those
  to make a test pass.
- **The auto-temp ↔ resolver coupling has no test in `test/resolver/` alone.**
  `disposablePath` keeps a throwaway only on same-site/same-group, so it must special-case
  a `current.url` that is not http(s) — an auto-temp tab sits on `about:newtab`, and
  without that check the user's *first* navigation is thrown into a second temp
  container (`tmp1` → `tmp2`). The e2e that catches a regression lives in
  `test/e2e/auto-temp.test.ts`, not the resolver tests.
- **WebDriver cannot make a new-tab page — use the probe.** `switchTo().newWindow("tab")`
  produces `about:blank` (which auto-temp ignores by design), and `driver.get("about:newtab")`
  fails with *"Navigation to about:newtab is not allowed in this context"*. So the probe
  exposes `newTab` (`browser.tabs.create({})` — exactly what Ctrl+T does), `tabs`
  (a `browser.tabs.query` dump) and `nav` (navigate a tab **by id** — WebDriver drives
  only the tab it is switched to and cannot map a handle to a tab id, so an
  `about:newtab` tab is otherwise unaddressable), reached from a test via
  `openRealNewTab` / `listTabs` / `navigateTab` / `probeCommand` in
  `harness/firefox.ts`. The relay is a `cc-probe-cmd` DOM event the
  probe listens for in its injected script, so **the driver must be parked on a
  probe-reported http(s) page** before issuing one. `listTabs` is also the only way to
  observe a new-tab page's container at all — `about:` pages take no content script, so
  the probe's usual title/attribute reporting can't see them.
- **WebDriver cannot navigate to a `moz-extension://` URL** either — `driver.get` fails with
  *"Navigation to moz-extension://… is not allowed in this context"*, Marionette's
  non-web-scheme restriction, the same one that blocks `about:newtab`. Pinning the uuid
  does not help. The driver can only *operate* an extension page something else opened.
- **The probe opens extension pages; `extensions.webextensions.uuids` pins the origin.**
  `launch()` sets that pref so CC's origin is the constant `ccExtensionUrl()` builds, and
  the probe's `open` command does the `tabs.create`; `switchToUrl` then moves the driver
  onto it. Firefox gates `web_accessible_resources` on *web content*, not on other
  extensions, so CC must **not** list `options.html` there — doing so would expose the
  config editor to every website, and it buys nothing for tests.
- **An auto-temp e2e must not navigate.** Any unmatched http URL lands in a `tmp`
  container via the *engine's* disposable path, so "open a tab, navigate, assert tmp"
  passes whether or not auto-temp exists — three e2e tests once did exactly that. The
  signal that isolates auto-temp is a tab sitting in a `tmp` container **while still on
  `about:newtab`, before any navigation**. `launch({ startupUrl: "about:newtab" })`
  covers the startup-sweep path (Marionette otherwise always starts at `about:blank`);
  it is also what makes `npm run manual` greet you with a `tmp1` tab like a real profile
  would. When the sweep fires it discards the driver's own starting tab — re-`switchTo`
  a surviving handle before doing anything else, and observe from a *fresh* tab, since
  navigating the swept tab consumes the evidence.
- **`commands.onCommand` can't be driven by Selenium.** Firefox fires keyboard-command
  shortcuts at the browser-*chrome* level; Selenium's W3C actions deliver keys to web
  *content*, so the reopen-picker command (`Ctrl+Shift+O`, manifest `commands`) is
  L3-tested only. Its `test/e2e/choice.test.ts` case is `it.skip` for this reason —
  don't "fix" the skip by enabling it or swapping drivers; the handler logic is covered
  at L3 and the shared choice page + reopen are L4-proven by the choice-screen cases.

## e2e harness (`harness/`, `extensions/probe/`)

- Observation is the **probe** — a *separate* MV2 test-agent extension, not CC. On
  each page load it writes the tab's `cookieStoreId` into `document.title`
  (`CSID:<store>`), the container name into a `data-cc-container` attribute, and the
  full container-name list into `data-cc-containers`. `launch({ extensions:
  ["probe","cc"] })` loads both; read via `readCookieStoreId` / `readContainerName` /
  `readContainerList` / `awaitContainerTab`.
- Host-based routing in tests uses fake domains resolved to loopback with the Firefox
  pref `network.dns.localDomains` (set in `launch`), e.g. `work.example` /
  `nomatch.example`.
- Firefox ships **four built-in containers** (Personal, Work, Banking, Shopping) —
  container-list assertions must expect them alongside `probe` and any `tmp…`.
- Selenium gotchas: closing the *active* tab leaves the driver with no window
  (re-`switchTo` a surviving handle); a CC reopen tears down the navigated tab so
  `driver.get` throws (tolerate, then `awaitContainerTab`); to read *fresh* container
  state, navigate a **matched** host (stays in its permanent container, no reopen)
  with a **cache-busting** query param so the probe re-reports into a new document.
- **Debug a real-Firefox extension** by running geckodriver manually with
  `--log trace`, connecting Selenium via `usingServer`, and setting the pref
  `devtools.console.stdout.content=true`; the extension's `console.error` then shows
  up in geckodriver's log. `MOZ_LOG` did *not* surface addon/JS errors here.

## tcp/ and mac/

Git submodules tracking upstream Temporary Containers and Multi-Account Containers as
**read-only reference** (we re-implement both). Consult them for patterns — TCP's
`src/background/cleanup.ts` shaped the disposer; its `getAssignment` handshake shaped
the F7 MAC-defer logic. `submodule.*.ignore=dirty` hides their CRLF↔LF working-tree
churn; don't "fix" those files.
