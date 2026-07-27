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
(`harness/`, `test/e2e/`, Selenium/geckodriver). The engine, disposer,
cookie-seeder, script-injector, redirector-closer, and picker are all **siblings**,
wired at the extension entry `src/extension/background.ts` — none is nested in
`createEngine`. The choice screen / reopen-picker UI lives in `src/extension/choice.ts`
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
- **Automatic mode (blank/newtab → immediate temp) is a known gap, not a design
  decision.** The engine today skips non-`http(s)` URLs (`src/engine/engine.ts`), so a
  freshly-opened tab stays in `firefox-default` until its first navigation. TCP's
  `maybeReopenInTmpContainer` containerizes `about:blank` / `about:newtab` /
  `about:home` on `tabs.onCreated` *immediately*; CC does not, and this is a real
  regression for a TCP migrant. It is the one remaining Temporary Containers
  carry-over — deferred to a future slice (a `tabs.onCreated` sibling), not declined.
  Don't assume the `about:blank` skip is intentional or out of scope; don't remove the
  non-http guard without it (that guard is also what keeps the F1 reopen loop safe).
  See CONFIG.md §"Temporary Containers parity — outstanding".
- **The engine's `freshlyReopened` tab-id guard is load-bearing.** When the engine
  reopens a tab, the *new* tab's `onBeforeRequest` fires **before its url commits**
  (it still reads as `about:blank`), so `resolve()` can't tell it is already in the
  target container and would reopen forever (the F1 loop). The guard leaves a
  reopened tab's first navigation alone. Preserve it across any engine/MV3 rework.
- Temporary containers are identified **by the `tmp` name prefix** (`TMP_PREFIX` in
  `src/engine/registry.ts`), not a stored set — durable across a background restart.
  The disposer removes only `tmp…` containers; it never touches permanent/user ones.

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
