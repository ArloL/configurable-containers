# CLAUDE.md — Configurable Containers

A Firefox WebExtension that routes each site into the right container from one
user config. Orientation lives elsewhere: `README.md` (goals), `CONFIG.md` (config
format + feature list F1–F12), `TESTING.md` (the test pyramid), `test/` (the
behaviour spec — there is no prose one; the tests are named for what they pin), and
`docs/superpowers/specs/` + `plans/` (per-slice design of record). `FOLLOWUPS.md`
lists what was deliberately left needing a re-check. This file only records what
the code and those docs *don't* say — the things a cold start gets wrong.

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
**siblings**, wired by `wireBackground` (`src/extension/wiring.ts`) — none is
nested in `createEngine`. The extension entry `src/extension/background.ts` is only that
call plus the async config tail; the wiring is a separate function so the L3 restart
harness drives the *real* startup path instead of a second copy of it. The choice screen / reopen-picker UI lives in `src/extension/choice.ts`
(a separate esbuild entry point bundled to `extensions/cc/choice.js`, loaded by
`choice.html`); the pure protocol it shares with `src/engine/picker.ts` is
`src/extension/picker-protocol.ts`. **Neither the hash payload nor the `cc-pick` message
carries a tab id**: the background takes the tab from the message *sender*, because the
hash a choice page renders from is reachable by anyone who can get the user to a crafted
`moz-extension://<id>/choice.html#…` link, and so is anything derived from it. The url in
that message is re-checked for http(s) at the same boundary — it goes on to
`port.createTab`, where a `javascript:` url would run in a privileged origin.

`createEngine` returns `{ reopen }` — the F1-guarded reopen effect. The picker calls
`engine.reopen` (injected) so its choice-driven reopen goes through the
`reopenedNav` guard; never reopen a tab by hand in the picker, and don't make
`createEngine` return `void` again — the picker's correctness depends on reusing the
engine's reopen, not duplicating it.

**Where a new tab goes is `supersede` (`src/engine/supersede.ts`), and it has three
callers for a reason.** It owns one rule — keep a source tab that is on a page and open
beside it, replace one with nothing to lose — plus the window, index, opener and active
flag that go with it. `engine.reopen`, `picker.showChoice` and (for its own placement)
auto-temp all go through it. The rule was duplicated in the picker once and immediately
drifted: the choice page was loaded into the *triggering* tab, so a multi-container rule
destroyed the page the user was on before they had chosen anything, while a
single-container rule kept it. Add a caller rather than a second copy.

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
- **The engine's `reopenedNav` guard is load-bearing.** When the engine reopens a tab,
  the *new* tab's `onBeforeRequest` fires **before its url commits** (it still reads as
  `about:blank`), so `resolve()` can't tell it is already in the target container and
  would reopen forever (the F1 loop). The guard leaves the navigation the engine
  reopened the tab to perform alone. Preserve it across any engine/MV3 rework.
- **That guard is keyed on the *navigation*, not on "the first request".**
  `reopenedNav` (tabId → `{awaiting: url}` before that navigation's first request,
  `{requestId}` after) holds a reopened tab through its whole navigation, because **a
  redirect chain keeps one requestId and the tab stays `about:blank` for every hop of
  it**. The original one-shot version guarded only hop 1; hop 2 then looked like an
  unrouted navigation in a blank tab and bought another throwaway, so a single click on
  a 30x-ing link walked `tmp1` → `tmp2` → `tmp3`. Covered at L3 and by the
  redirect-chain case in `test/e2e/routing.test.ts` (the harness server answers 302 on
  `/redirect?to=`).
- **The guard's wait is bounded by the url it awaits, and matched by SITE.** An earlier
  version seeded `null` and let the *first* request in that tab claim it. When the
  reopened tab's own request never arrived (load aborted, user typed elsewhere first),
  that stale marker absorbed whatever navigation came next — returning no `cancel`, so
  the site loaded **unrouted inside the container we had just reopened into**: an
  unmatched site in a permanent container's cookie jar, F11 by way of F1 machinery.
  Comparing by site rather than by exact url is load-bearing in the other direction:
  Firefox rewrites the url *before* `onBeforeRequest` when **HSTS upgrades the scheme**,
  so the tab's own first request legitimately arrives on a url we never asked for, and
  exact-url matching bought a second throwaway on every such reopen. Both directions
  have an L3 test; revert-verified against each other.
- **A reopen carries the source tab's `windowId`, and Firefox honours it even for a popup
  window.** A share button (`window.open(url, "name", "width=640,height=480")`) gets a
  window of its own whose tab is pre-commit, so it takes the *replace* branch; with no
  window on the `tabs.create` the replacement landed in the last focused **normal** window
  and removing the original then closed the popup, taking the navigation with it. The open
  question was whether Firefox would put a tab into a popup window at all — **it does**,
  verified in Firefox 153 by the popup case in `test/e2e/routing.test.ts`, which reads
  `windowId` out of the probe's `tabs` dump. The same omission teleported any tab reopened
  in an unfocused window. `Tab.windowId` is therefore required, not optional: an optional
  one is a field the mock can forget to set and the suite then stops covering this.
- **A reopen KEEPS a source tab that is on a page** (`keep = /^https?:/.test(tab.url)`
  in `supersede`), opening the container tab at `index + 1` with the source as its opener,
  and only *cancels* the source's navigation. Session history does not span containers,
  so replacing that tab destroys what the user was reading with no way back — clicking a
  link out of an article closed the article. This is MAC's rule
  (`mac/src/js/background/assignManager.js:275`, `removeTab`). A tab with **nothing to
  lose is still replaced** — a new-tab page, the choice page, or a tab still pre-commit
  on `about:blank` (what a middle-clicked / `target=_blank` link is) — and that branch is
  required, not cosmetic: keeping those would strand an empty tab beside every link
  opened in a new tab. **Consequence for e2e:** a cancelled navigation never returns to
  WebDriver, so a test must drive routing from a **fresh** (`about:blank`) tab —
  `driver.get` on a tab that is already on a page will hang until the test times out
  (`test/e2e/options.test.ts` did).
- **Two different things are `about:blank` pre-commit, and only one of them is ours.**
  A tab we reopened *and* a middle-clicked / `target=_blank` / `window.open` tab both
  read `about:blank` with a real container — the latter **inherits its opener's**. So
  `buildNavContext` must keep reporting `current: null` for a pre-commit tab: what
  `disposablePath` needs is the site the tab was ON, which is genuinely unknown, and
  reporting the container instead parks every middle-clicked link in its opener's
  throwaway (kottke.org and the site you opened from it sharing `tmp1` — no isolation
  at all). The requestId in `reopenedNav` is the *only* thing that separates the two
  cases. `test/e2e/routing.test.ts` clicks a real `target=_blank` link for this (the
  harness server renders one with `?link=`); a scripted `tabs.create` does not
  reproduce container inheritance.
- **A navigation that carries a body is never reopened** (`d.method !== "GET"`, at step
  3b of `onBeforeRequest`). `port.createTab` issues a GET, so reopening a POST drops the
  body — a SAML assertion, a 3DS return. The guard sits *before* `macOwns` (no reason to
  message MAC about a navigation we will not act on) and *before* `handled.add`, so the
  path adds no state and is fail-open. It is in the engine rather than the resolver on
  purpose: the routing answer is still correct, the *effect* is what cannot be performed
  losslessly, so a future POST-replay becomes a change to how the engine executes an
  unchanged decision. Same-site POSTs never reach it (`disposablePath` already returns
  `stay`) — that is the case TCP needs an explicit check for
  (`tcp/src/background/isolation.ts:328`) and MAC has no answer to at all.
- **The notification echo must be sent AFTER `notifications.create` resolves**
  (`src/engine/browser-port.ts`). A desktop notification is in no DOM, so L4 observes it
  by having CC's test build forward it to the probe — `__CC_NOTIFY_ECHO_TO__`, an esbuild
  define that is `""` in every shipped build. Echo *before* the create and a missing
  `notifications` permission still yields a green e2e with the notification entirely
  broken: **verified by doing it** — the e2e passed, and only the 5ms
  `browser-port.test.ts` ordering case caught it. `test/extension/package.test.ts`
  separately asserts the probe's id never reaches a packaged bundle. Note esbuild folds
  the condition but does **not** delete the branch (no `minify`), so the shipped bundle
  legitimately contains `if (false)` around a `cc-notification` literal.
- **An F9 e2e must start from a COMMITTED page.** Driving `/authorize` from a fresh tab
  has CC reopen that tab first, and the 302 is then another hop of a navigation
  `reopenedNav` already owns — the callback lands in the throwaway, no container switch
  happens, and a test asserting "the code survived" proves nothing. Both cases in
  `test/e2e/redirect-binding.test.ts` click a same-site link out of an already-loaded
  page. Two further traps there: the probe's command relay lives in the page's document,
  so `listTabs` **must not** be called until the navigation settles or its reply is lost
  to the 8s timeout; and if the POST guard regresses, CC cancels that navigation and the
  tab is wedged — every WebDriver call against it blocks, so the failure is a bare
  timeout. That timeout is the regression signature, not flake, and nothing test-side
  can improve it.
- **MV3 (this branch) is an event page, not a service worker**, so the bundle format,
  `globalThis.setTimeout` and the whole `browser.*` surface survive — and so does
  **`webRequestBlocking`**, which Chrome removed and the engine's cancel-and-reopen
  design depends on entirely. Firefox kept it; addons-linter reports 0 errors. The
  migration was a change to the *adapter* behind `port.ts` and nothing else: the
  resolver, matcher, engine, `reopenedNav` guard and picker were untouched.
- **MV3 removed `contentScripts.register`, and `scripting.registerContentScripts` is NOT
  its replacement here** — that API's `js` is `ExtensionURL[]`, file paths only, so it
  cannot carry an inline `run:` string out of the user's config. `userScripts` is the one
  MV3 API that still takes code. Firefox types `userScripts` as an **`OptionalOnlyPermission`**:
  it cannot sit in `permissions`, so a fresh profile does not have it, and
  `permissions.request` needs a user gesture a background script never has. Hence the
  grant button on the options page, and hence the adapter checking before it registers —
  the injector runs in `background.ts`'s floated async tail, where a throw is swallowed
  and the overlay would break with no diagnostic. addons-linter's `UNSUPPORTED_API`
  warning on `userScripts.register` is stale: it knows only the MV2 `register(options)`
  overload, not the MV3 `register(scripts[])` one we call.
- **An MV3 e2e that grants a permission must poll, not sleep.** The grant triggers
  `runtime.reload()`, and the injector registers on the *next* startup's async tail. A
  fixed wait raced it and made a working injection read as an MV3 failure;
  `test/e2e/scripts.test.ts` polls `userScripts.getScripts()`. The reload also discards
  the extension page the driver is parked on — re-`switchTo` a surviving handle or every
  later call throws `NoSuchWindowError`.
- **The disposer's grace is a STORED FACT, not a timer, and that is not a refactor to
  undo.** A pending `setTimeout` dies with the background context, and an event page is
  suspended whenever idle — so the old version lost every pending grace and its startup
  sweep (which reclaimed orphans at grace **0**) then removed the container on the very
  next wake: a five-minute keep-alive that was really zero (F10, "disposed too early").
  `src/engine/disposer.ts` now writes `cookieStoreId -> emptySince` to
  `storage.local` and re-derives the *remaining* grace on each sweep, so every sweep is
  idempotent and depends only on browser state plus that map. Timers are kept purely to
  make disposal punctual while the page is alive; losing one costs lateness, never
  earliness. Consequence worth knowing: an empty `tmp` container CC has **no stored note
  about** starts its grace now rather than being reclaimed on the spot — an orphan from a
  previous browser session therefore lives one extra grace. That is deliberate. Emptiness
  that was never written down is indistinguishable from a grace still running, and
  reclaiming those immediately is exactly what disposed live throwaways early.
  **The `alarms` permission is load-bearing, not belt-and-braces.** A wake re-runs the
  whole background script, so the startup sweep reclaims anything whose deadline passed
  while suspended — but only if *something wakes it*, and in a browser nobody is touching,
  nothing does. `setTimeout` dies with the page; only a browser-held alarm survives to
  re-run it. Every fast test hides this, because they all keep browsing and so keep
  waking the page by accident: the L3 clock is fake, and both e2e disposal cases sat well
  inside the ~30s idle timeout. This was shipped once with the alarm removed as
  "unused", and **only `disposal.realtime.test.ts` caught it** — a throwaway still alive
  eight minutes into a five-minute grace. Don't remove it again, and don't trust a green
  `npm test` on a change to disposal timing.
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
  evaluates — never after an `await`.** This is `wireBackground`'s contract: it is called
  at module top level and never awaits. The storage read is async, and wiring the siblings
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
  that legitimately waits. `useConfig` folds the `Object.assign` and the gate release into
  one call for the same reason: they must happen together, so a caller cannot do one alone.
- **Saving reloads the extension** (`browser.runtime.reload()`), which is why the
  `tmpSuffix` counter is raised past existing container names via `highestTmpSuffix`
  (`src/engine/registry.ts`) instead of restarting at 0 — otherwise every save reissues
  `tmp1` alongside a live `tmp1`.

## Testing reality

- `npm test` runs everything (unit **and** e2e) under Vitest; `npm run typecheck`
  for tsc. `tsconfig.json` typechecks `test/` too, so test code must type-clean.
- **`*.realtime.test.ts` is the one thing `npm test` does not run** — excluded in
  `vitest.config.ts`, run by `npm run test:realtime` (nightly workflow) through
  `vitest.realtime.config.ts`. These wait out *production* timers, so a case there must
  **not** pass `ccGraceMs` to `launch` — the whole point is that the bundle carries the
  shipped constant and that a five-minute background-page timer really fires. Both
  configs take their esbuild defines from `vitest.shared.ts`; keep it that way, or a
  test's meaning starts depending on which config ran it.
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
  to make a test pass. It also fires `onTabRemoved` from `removeTab`, for the same
  reason: Firefox does not care whether the user or the extension closed the tab. While
  it did not, a tab **CC itself closed** — a reopen superseding its source, a stranded
  redirector — was invisible to every `onTabRemoved` listener, so the disposer never
  learned that the container it had just emptied was empty. That gap was load-bearing in
  the wrong direction: the restart case covering an abandoned throwaway passed only
  because the old startup sweep reclaimed it at grace 0, i.e. the F10 bug was what made
  the test green.
- **The restart harness (`test/engine/restart.ts`) rests on two fidelity rules, and the
  second is the one whose absence would make the suite lie.** (1) Re-wiring is all it
  takes to retire the old listeners, because `mock-port.ts` holds ONE handler slot per
  event — a second registration replaces the first, as a dead context's listeners stop
  being called. (2) Each session's timers must stop with it. The fake clock is shared and
  outlives the session, so without the per-session clock facade the previous disposer
  keeps re-arming its 10-minute GC through a closure that still holds a live port, and
  the harness reports state "surviving" a restart that never happened — verified by
  backing the facade out, which reds the redirector case. What is *not* modelled: async
  work already in flight at the restart. Drive restarts from a settled state.
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
  the probe's usual title/attribute reporting can't see them. It reports each tab's
  `windowId` too, which is the only way to tell "the popup survived" from "the routed tab
  reappeared in the main window" — window handles alone don't distinguish them.
- **Two tests in one session must not share a URL.** The choice-screen cases each leave a
  `figma.example` tab open, so a later `tabs.find(t => t.url.startsWith(host))` matched the
  *earlier* test's tab and read its index. Give a case its own query string. Tab indices
  have the mirror trap: a tab closing anywhere renumbers every tab after it, so compare
  indices only within ONE `listTabs` snapshot, never across two.
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
- **Real MAC is loadable from `mac/src` unbuilt, but four things bite** (all handled in
  `buildXpiFor`/`launch`, see `test/e2e/mac-interop.test.ts`):
  1. `mac/src/_locales` is a **nested submodule** (mozilla-l10n) we do not check out, and
     MAC's manifest declares `default_locale: "en"` — Firefox then refuses the add-on
     with a bare *"Extension is invalid"* that names nothing. The harness synthesises the
     six `__MSG_` keys the manifest interpolates; they are display strings the background
     logic never reads. This is why CI checks out `submodules: true` and **not**
     `recursive` — recursive would drag in a localisation repo for six labels.
  2. **A MAC site assignment cannot be scripted.** It is created from MAC's
     browser-action popup or context menu — chrome UI Selenium cannot drive, the same
     limit as `commands.onCommand` — and MAC's external API exposes only `getAssignment`,
     with no setter. `Utils.currentTab()` is `tabs.query({active:true})`, so opening
     `popup.html` as a tab assigns the popup's own `moz-extension:` url; and WebDriver
     must activate a tab to script it, so there is no arrangement that works. The harness
     instead appends one script to MAC's background **page** inside the `.xpi` it builds
     (the submodule on disk is untouched) which calls MAC's **own** `storageArea.set`, so
     the storage-key format lives in MAC's code and is never mirrored here.
  3. **Seed the assignment with `neverAsk: true`.** Otherwise MAC parks the tab on its
     confirm-page interstitial instead of reopening (`assignManager.js`,
     `reloadPageInContainer`) and no container tab ever appears — the test times out
     looking for one, which reads like a deferral bug and is not.
  4. **Wait for the container to RESOLVE before seeding the assignment.** MAC deletes any
     assignment whose container it cannot `contextualIdentities.get` and lets the page
     load uncontained (`assignManager.js`, "isn't present any more"). CC has already
     deferred by then, so nothing routes the tab — and the assignment is gone for good,
     so polling never recovers. Firefox provisions even the **built-in** containers
     lazily, so `firefox-container-1` (Personal) can genuinely be absent on a cold
     profile: this flaked CI exactly once, passing on a re-run of the identical commit.
     Verifying the write landed is **not** enough; the seeding loop gates on the `get`.
     Reproduce by seeding a `userContextId` that does not exist — the signature is "no
     container tab" for the full timeout, never a wrong container.
- **An unassigned domain cannot test the MAC handshake.** `macOwns` swallows a throw and
  returns false, so a broken handshake and "no assignment" are observationally identical
  — CC routes normally either way. Only an **assigned** domain separates them, and it is
  what proves the two things L3 cannot: that cross-extension `sendMessage` reaches MAC at
  all, and that MAC's permission gate accepts CC (it throws unless the caller declares
  `contextualIdentities` — keep that permission for this reason too, not just for
  `tabs.create`). Backing the F7 defer out makes the e2e fail as *no container tab at
  all*, not as a `tmp` one: CC and MAC fight over the navigation, which is the churn
  signature F2/F7 names.
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
