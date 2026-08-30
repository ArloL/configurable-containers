# e2e and the probe

Read this before writing, moving or debugging a case under `test/e2e/`, or changing
anything in `harness/`. It is the part of the platform knowledge that only an e2e session
needs: what WebDriver refuses to do, what the probe extension does instead, and the ways a
case here passes while the feature it names is broken.

Everything that applies to any change — the placement rules, the Firefox facts the engine
is built around, the config and startup order, and the L1–L3 hazards — stays in
`CLAUDE.md`. `TESTING.md` owns the L1–L5 pyramid and the F1–F14 matrix; this file owns the
mechanics of L4/L5.

## What a green e2e run can still hide

- **An auto-temp e2e must not navigate.** Any unmatched http url reaches a `tmp` container
  via the *engine's* disposable path, so "open a tab, navigate, assert tmp" passes whether
  or not auto-temp exists. The isolating signal is a tab in `tmp` **while still on
  `about:newtab`** (`launch({ startupUrl: "about:newtab" })`); the startup sweep discards
  the driver's own tab, so observe from a page of your own — `navigateToContainerTab`
  opens one and needs no re-anchoring, which is what that case used to spend three lines on.

- **Don't trust a green `npm test` on disposal timing** — every fast case keeps browsing,
  and browsing re-triggers the sweep. `*.realtime.test.ts` is the one thing `npm test`
  does not run (`npm run test:realtime`, nightly), and cases there must **not** pass
  `ccGraceMs`: the point is that the bundle carries the shipped constant.

- **The pause's toolbar button and badge have no L4 coverage and cannot.** WebDriver
  cannot click a `browser_action` or read chrome UI. `test/e2e/pause.test.ts` drives the
  **options-page** route instead, and since both call one `arm()` the uncovered surface is
  the click itself. **Do not add a build-time seed to arm a container**:
  `__CC_NOTIFY_ECHO_TO__` already shows the cost (no test build is byte-equivalent to a
  packaged one), and arming by name would make the shipped extension capable of starting
  up with routing disabled.

- **`test/e2e` drives the browser through `harness/browser/`, never `driver` directly**
  (`BrowserSession` → `Page` → `Locator`; 2026-08-25 spec). A locator is a page plus a
  selector and never an element: every operation switches to its own window handle,
  re-resolves the selector, runs the actionability checks for that action, and treats the
  five Selenium "not yet" errors as another poll. The hidden current window and the stale
  handle — where every flake in this suite came from — are no longer expressible.
  Assertions retry too (`toHaveText`, `toContainText`, `toHaveValue`, `toHaveAttribute`,
  `toHaveCount`, `toBeVisible`, `toBeEnabled`, imported for effect from
  `harness/browser/matchers`), so the shape to avoid is
  `expect(await locator.innerText()).toBe(…)`: it reads once, which is the flake the
  retrying form exists to remove. **`.not` on one of these polls for the condition to STOP
  holding**, which is not what vitest does on its own, and an element that never appears
  fails in BOTH directions — except under `toBeVisible` and `toHaveCount`, which read a
  missing element as `false` and `0` because that is what `.not.toBeVisible()` and
  `toHaveCount(0)` are asking for. Why each of those is where it is — `settle` and its
  reader contract, `Locator.enabledState`, `Page.describe`'s two independent halves,
  `pageAt`'s retry policy against `close`'s bare catch — is argued at the code, in
  `harness/browser/{matchers,locator,page,session}.ts`, each with the measurement that
  moved it there. This bullet is what a case has to know without opening them.

  Three things a new case gets wrong otherwise. **A textarea's content is its VALUE** —
  `toHaveValue(/…/)`, not `toContainText`, which reads `innerText` and sees `""`.
  **`page.close()` and `session.newPage()` re-anchor the driver** on a surviving window,
  because closing the active tab — or the extension discarding it, as the auto-temp sweep
  does — otherwise leaves the next command *anywhere later in the file* failing with
  `NoSuchWindow`. And **a timeout names what it waited for, the page's url, the ids present
  and the tab list**, which is the report `NoSuchElementError: *[id="cc-sync"]` was not.

  `test/fitness/e2e-discipline.test.ts` pins the rest of this bullet — no `driver`, no
  sleep, no read-then-compare, no deadline loop — each rule carrying an exact list of the
  files that are allowed to break it and why, because the migration that established the
  rules left a file breaking every one of them, and said in its own commit message that it
  had not. **Read-then-compare matches BOTH forms**: assigning the reading first
  (`const value = await …inputValue()`) evaded it entirely until 2026-08-26. It reads one
  line at a time, so a read split across two still evades it.

  Outside the layer on purpose, because none of it is Selenium's problem:
  `navigateToContainerTab` (a navigation CC cancels never returns to WebDriver, so it
  drives from a fresh tab and tolerates the teardown), `awaitContainerTab`,
  `awaitTab`/`awaitTabs`/`awaitContainers`, and the probe readers — all CC-specific, all
  taking or returning a `Page`.

- **The options page is REACHABLE a beat before its document EXISTS, and again before it is
  POPULATED.** It fills `#cc-config` from `storage.local` after it renders, and a tab
  answers by url as soon as its navigation commits. Both windows have been measured: on
  140 ESR one first read in twelve came back empty and hydrated 13ms later; in CI on
  2026-08-25 a read landed before the document had parsed at all, and `findElement`'s throw
  escaped a loop that polled for TEXT. Both are now closed by waiting rather than reading —
  `pageAt`, then a retrying assertion. The race is **load-dependent**: 40 rounds on an idle
  machine, with and without CPU pressure, reproduced it zero times, which is why the
  layer's own semantics are unit-tested against a fake driver instead of a browser.

- **A case that expects CC's OWN options page must wait for it before opening a tab of its
  own, and through `pageAt` rather than the probe.** Two measured hazards, both
  load-dependent, both of which read as "the editor never opened". `openOptionsPage()`
  lands in an EXISTING blank tab when there is one — including the blank tab a case just
  opened for itself — and navigating that tab then has CC reopen it, taking the editor
  with it: the probe's tab log shows the options tab `REMOVED` 16ms after the routed tab
  appears, `windowClosing=false`, with config-sync (the last step of the startup tail)
  having published, so the extension was fine. Once that has happened no wait, however
  long, will find it. And asking the PROBE costs a relay round-trip per poll, which under
  CPU pressure stacks up past any sensible budget — 13.8s, 13.7s and 22.4s were measured
  for a tab that had been open the whole time. `pageAt` enumerates window handles, needs
  no page of its own, and is unaffected by both.

- **An options-page e2e must read tab ids BEFORE parking on the options page.** The
  probe's relay is a DOM event injected into http(s) pages only, so from
  `moz-extension://` every probe command goes unanswered and reads as a timeout.

- **A probe reply is written into the DOM of the page that RELAYED the command, so a `nav`
  must never move the RELAY page it was asked through** — the navigation destroys the
  document the answer lands in, and whether the reply beats the commit is a race the 100ms
  poll loses now and then. It reads as `probe command "nav" timed out`. The probe now
  **refuses** a `nav` targeting `sender.tab.id`, so the mistake names itself instead of
  flaking; the fix is a second http tab to relay from (`openTab` + `awaitContainerTab`, a
  matched host so CC parks it once). **Open that tab through the probe, not `page.goto`** —
  from a committed page the reopen cancels the navigation and it never returns.

- **An F9 e2e must start from a COMMITTED page**: from a fresh tab CC reopens first, the
  302 is then another hop of a navigation `reopenedNav` already owns, and the assertion
  proves nothing. If the POST guard regresses the tab wedges and every WebDriver call
  blocks — **a bare timeout is that regression's signature, not flake.**

- **A reaper case must kill its holder with a SIGNAL.** Selenium's own exit hook cleans up
  after a clean exit and an uncaught throw, so an abandonment case that merely
  `process.exit()`s passes with `harness/reaper.ts` removed entirely. Only SIGTERM
  isolates what the reaper adds.

- **Config-sync adoption has no L4 test and cannot have one** (no Firefox Account in a
  test profile, no `moz-extension:` navigation, the probe has its own sync namespace). The
  e2e cases observe the **startup push** only.

## e2e: what the driver cannot do, and what the probe does instead

- **A machine with no Firefox can get one: `./scripts/get-firefox.sh`.** It fetches both
  channels into `.firefox/`, and then `FIREFOX_BIN=.firefox/esr/firefox npm test` runs the
  suite exactly as `ci.yml`'s `latest-esr` leg does. It fetches **linux64 only**, which is
  what CI runs; on macOS take the dmg from
  `download.mozilla.org/?product=firefox-esr-latest-ssl&os=osx` and point `FIREFOX_BIN` at
  `Firefox.app/Contents/MacOS/firefox` inside it. **geckodriver needs no setup** —
  Selenium Manager ships inside `selenium-webdriver` and fetches it the first time a driver
  is built, so nothing looks for one on PATH. The other prerequisite is a `mac/` checkout
  (`git clone --depth 1 https://github.com/mozilla/multi-account-containers.git mac`),
  without which `mac-interop.test.ts` fails on a bare ENOENT.
- **In a sandbox, `ftp.mozilla.org` being blocked is NOT evidence that Firefox cannot be
  downloaded.** It is a legacy alias that network policies often omit;
  `download.mozilla.org` (which redirects to `archive.mozilla.org`) is the host that
  serves the builds, and GitHub release assets come from `objects.githubusercontent.com`.
  Probe those before concluding L4/L5 cannot be run here — that conclusion has been drawn
  wrongly more than once, and it silently drops the only levels that see a real browser.
  **Always pass `FIREFOX_BIN`**: without it Selenium Manager downloads Firefox itself from
  `ftp.mozilla.org`, and the failure reads `Unable to obtain browser driver` — which looks
  like a geckodriver problem and is not.
- **`runtime.reload()` does not bring a TEMPORARILY installed extension back on 140 ESR.**
  Measured 2026-08-24 against 154.0: the OLD background keeps running, and CC's own pages
  stop resolving at their `moz-extension` uuid. CC no longer calls it — a save applies its
  config in place — which is what let `options.test.ts` drop its `< 154` skip and made the
  config-save case observable on the ESR leg (re-measured 2026-08-25 on 140.14.0esr, red
  with the reload restored). Keep the Firefox fact in mind before reaching for `reload()`
  for anything else.
- **Unsigned CC loads on *release* Firefox by TEMPORARY install** (`installAddon(xpi,
  true)`), which grants `webRequestBlocking`. Don't reach for Developer Edition, Nightly
  or signing to fix a load failure — `xpinstall.signatures.required=false` is ignored on
  release and only *permanent* install needs signing.
- **Observation is the probe**, a separate MV2 extension: `CSID:<store>` in
  `document.title`, container name and list in `data-cc-*`. It also **provisions a `probe`
  container and its own tab**, so every list and tab-count assertion sees one extra.
- **WebDriver cannot navigate to `about:newtab` or `moz-extension://`** (Marionette's
  non-web-scheme rule; pinning the uuid doesn't help), and `newWindow("tab")` gives
  `about:blank`, which auto-temp ignores by design. Hence the probe's `newTab` / `tabs` /
  `nav` (by **tab id** — the driver can't map a handle to one) / `open` commands; the
  driver can only *operate* an extension page something else opened.
- **And operating one may NOT run a script in it.** An extension page lives in the
  extension process, which Firefox counts as a **privileged browsing context**, and
  Marionette refuses `ExecuteScript`/`ExecuteAsyncScript` there unless the browser was
  started with `--remote-allow-system-access`. 154 refused only *parent-process* contexts;
  156.0a1 widened the same check to `isPrivilegedContext` (extension and privileged
  `about:` processes too) and took nine cases down at once — the Nightly tripwire earning
  its keep. The trap is that `WebElement.getAttribute` is **not** a protocol command:
  Selenium implements it as an injected atom, so the call every http(s) case makes reads as
  `UnsupportedOperationError` here. `harness/browser` is built so that mistake cannot be
  made: `Locator.getAttribute` IS `getDomAttribute` (the W3C endpoint — and what
  Playwright's `getAttribute` returns anyway), `inputValue()` is Get Element Property,
  visibility is Get Element Rect plus Get Element CSS Value, the focused element is the CSS
  `:focus`, and `fill()` is `clear()` + `sendKeys()`, which also fires the `input` the
  editor validates on as assigning `.value` never did.
  `test/e2e/privileged-protocol.test.ts` pins that each of those answers on an extension
  page and is the tripwire for the next widening. Re-measured 2026-08-29 on all three
  channels: `executeScript` on that page ANSWERS on **140.14.0esr** and **154.0.1** and is
  refused on **157.0a1**, so the widening rode 156 forward and has not reached release —
  the avoidance is about where release is going, not where it is. **Don't reach for the flag**: it re-grants privileged access to the
  whole session to keep one convenience call working, and pins the suite to a Firefox that
  permits what the shipped extension's users never will. `harness/firefox.ts`'s own
  `executeScript` helpers stay as they are — every one reads a probe-written attribute on
  an http(s) page, which is ordinary web content.
- **The command relay is a DOM event injected into http(s) pages only**, so the driver
  must be parked on a probe-reported http(s) page first, and an unanswered command reads
  as an *empty answer*, not an error. **`commands.onCommand` cannot be driven at all**
  (chrome-level key events) — the reopen picker is L3-tested and its e2e case is `it.skip`.
- **The probe's attributes land AFTER a navigation resolves** (`reportTab` awaits two
  `cookies.getAll` calls first) while server-rendered markup is there as the document
  parses, so asserting on both in one breath is a race. `awaitContainerTab` covers most
  cases free; a navigation with **no reopen to wait for** needs `awaitProbeReport`.
- **Drive routing from a FRESH tab** — a cancelled navigation never returns to WebDriver,
  so navigating a tab already on a page hangs until timeout. `navigateToContainerTab` is
  that rule as a function; reach for it rather than `page.goto` when CC may reopen.
- **The harness server's redirect destinations are CONSTANTS, not query params** — off the
  query string it's an open redirect and CodeQL fails the build. `?link=` for a real
  `target=_blank` anchor is fine, and a scripted `tabs.create` does not reproduce
  container inheritance.
- **`__CC_NOTIFY_ECHO_TO__` echoes notifications to the probe, and must be sent AFTER
  `notifications.create` resolves** — echo first and a missing permission still yields a
  green e2e with the feature broken. `launch()` sets it unconditionally, so even `npm run
  manual` isn't byte-equivalent to a packaged build.
- **`__CC_DECISION_ECHO_TO__` is the same mechanism one level up, and it is the only thing
  at L4/L5 that carries a CAUSE.** Everything else this level sees is an effect — a tab
  exists, in this container, with these cookies — so the six ways a navigation can end up
  not moving arrive as one signal, and `timed out after 30000ms` covered a POST-guard
  regression, a dead window handle, an unanswered relay, a config that never applied, a
  load-dependent hydration race and genuine flake alike. `engine.ts`'s `say()` calls
  `port.echoDecision` at **every exit of `navigate`**, including the ones that return before
  resolving (a `view-source:` load, a re-fire, an absorbed hop) — those are precisely the
  ones a reader takes for "CC never saw this navigation", and they echo a **null** decision
  to say which it is. A request that is not a top-level http(s) navigation echoes nothing:
  it is not a navigation CC declined to route, and every image on the page would bury the
  hops worth reading.

  Three properties are not negotiable. It is **synchronous and void**, like
  `pause.record` — `test/fitness/decision-cost.test.ts` counts a call as a round trip only
  if it returns a thenable, so a promise acquired here starts failing that gate the moment
  it appears. The **words are built inside the guard** in `browser-port.ts`, so a shipped
  navigation pays nothing, and they are the resolver's own (`describeDecision`), so a
  diagnosis and an F9 toast cannot come to describe one decision differently. And it is
  **read-only**, which is what separates it from the build-time seed forbidden above: a seed
  that armed a container would make the shipped extension capable of starting up with
  routing disabled, while an echo changes no routing at all. `package.test.ts` counts **two**
  `if (false)` branches in the packaged bundle rather than asserting one is present, because
  `toContain` goes on passing with either echo live.

  The reading side is `readDecisions` / `describeDecisions` / `describeSessionDecisions` in
  `harness/firefox.ts`, wired into the CC-specific polls (`awaitTab`, `awaitTabs`,
  `awaitContainers`, `awaitContainerTab`, `awaitProbeReport`). Deliberately NOT in
  `harness/browser/` — that layer is Selenium's problem only, and `Page.diagnose()` knows
  nothing about CC. Like `diagnose()` it **never throws** and takes a short budget: it runs
  when the browser is least well, and a diagnosis that fails replaces the real failure with
  its own. Every empty answer says which empty it is, since "CC saw no navigation" and "no
  http(s) page was open to ask through" send a reader to two different places.
- **`driver.quit()` is not what keeps a browser from leaking — `harness/reaper.ts` is.**
  Selenium unrefs its geckodriver and kills it from its own `process.once("exit")` hook,
  which covers a clean exit and an uncaught throw and nothing else: node emits no `exit`
  for a **signalled** process; a browser leaked *mid-run* runs alongside every later test;
  and session creation can throw with Firefox **already up** — on macOS it re-execs,
  geckodriver loses the pid it was watching, and the survivor re-parents to init. So
  `launch` passes a `-profile` directory it made itself, stamping the argv of the browser
  *and every content process* with a token that exists before Firefox does. Keep that
  argument; keep `reapProfile`'s guard refusing a path that isn't `cc-e2e-profile-…` (it
  becomes a `pgrep -f` pattern, and a short one matches half the process table); and leave
  `npm run manual` **without** a SIGINT handler — the reaper's is registered first and
  would pre-empt it.
- **Debug real Firefox** with geckodriver `--log trace` + Selenium `usingServer` +
  `devtools.console.stdout.content=true`; `console.error` then reaches the log. `MOZ_LOG`
  surfaced nothing.

## MAC interop (`test/e2e/mac-interop.test.ts`)

- **Only an ASSIGNED domain tests the handshake** — `macOwns` swallows throws, so a broken
  handshake and "no assignment" look identical. Backing the F7 defer out fails as **no
  container tab at all**, not a `tmp` one: CC and MAC fight over the navigation.
- **An assignment cannot be scripted** (chrome UI only; MAC's API has no setter), so the
  harness appends a script to MAC's background page *inside the xpi it builds* calling
  MAC's **own** `storageArea.set` — with **`neverAsk: true`**, or MAC parks on its confirm
  interstitial and no container tab appears, and only **after the container RESOLVES**,
  since MAC deletes an assignment whose container it can't `get` and Firefox provisions
  even built-in ones lazily.
- **Nothing may navigate until the assignment is READABLE; `launch` blocks on a beacon.**
  MAC reads it in `onBeforeRequest`, CC a `getAssignment` roundtrip later, so a write
  landing mid-flight is seen by one and missed by the other. A background page's storage
  is in no DOM, so a `fetch` to the harness server is the only way Node learns it landed;
  give-up sends no beacon, failing `launch` loudly. Failures here read as "no container
  tab" for the full timeout, never as a wrong container.
- **`mac/src/_locales` is an unchecked-out submodule** and MAC declares `default_locale`,
  so Firefox refuses the add-on with a bare *"Extension is invalid"*; the harness
  synthesises the six `__MSG_` keys.
