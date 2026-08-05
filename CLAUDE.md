# CLAUDE.md — Configurable Containers

A Firefox WebExtension that routes each site into the right container from one user config.
Not repeated here: `README.md` (goals, build, release), `CONFIG.md` (config format),
`TESTING.md` (L1–L5 pyramid, F1–F12 bug matrix), `test/` (the behaviour spec — each test
names what it pins), `docs/superpowers/`, `FOLLOWUPS.md`. *Why this function is shaped this
way* is in its own comment; the source is densely commented. This file carries only
**platform and tooling facts that make a reasonable-looking change wrong**.

## Where new logic goes

- **Routing answers go in `src/resolver/` (pure `resolve`) or `src/matcher/`; effects go in
  `src/engine/engine.ts`**, which is not a passthrough — it owns the `reopenedNav` guard,
  the non-GET declination, the MAC handshake and the `handled` dedupe.
- **`BrowserPort` is the browser seam for the engine and its siblings only** (`port.ts` is
  types, `browser-port.ts` the implementation). `src/extension/{config,config-sync,options,choice}.ts`
  touch `browser.*` directly by design — `port.ts`'s own header overclaims here.
- **New background behaviour is a sibling in `wireBackground` (`src/extension/wiring.ts`),
  never nested in `createEngine`.** `background.ts` is that call plus an async tail; the L3
  restart harness drives the same function, so startup order can't drift.
- **Tab placement is `src/engine/supersede.ts` — add a caller, never a copy.** Callers:
  `engine.reopen`, `picker.showChoice` (the picker reopens through the injected
  `engine.reopen` — hence `createEngine` returning `{ reopen }` — because a hand-rolled
  reopen skips `reopenedNav` and reopens forever). The rule was copied into the picker once
  and drifted inside the slice: the choice page loaded into the triggering tab, destroying
  the user's page. **`auto-temp.containerize` is a surviving second copy** — fold it in.
- **`src/engine/pause.ts` owns arming, recording and the badge; the engine consults it at
  exactly one point.** The seam is **synchronous by contract** — `isPaused` runs inside
  the blocking `onBeforeRequest`, where an `await` is every navigation's latency, and
  `record` returns `void` so a navigation never waits on bookkeeping. The step sits
  **after `resolve()`** (the record's whole value is the counterfactual — "would have
  been reopened into…" is what says a rule was needed) and **before the non-GET
  declination** (a paused POST must raise no F9 toast: nothing went unapplied, the user
  turned routing off). It adds nothing to `handled` and never cancels.
- **Two arming paths, one `arm()`.** The toolbar button takes its container from the
  `Tab` Firefox passes to `browserAction.onClicked`; the options page *names* one and the
  background validates it. **WebDriver cannot click a `browser_action`**, so any logic
  that lives only in the `onClicked` handler has no end-to-end coverage — keep it a
  caller.
- **`wireBackground` owns the single `runtime.onMessage` registration** and dispatches by
  `type`; siblings expose `handleMessage` and must return `undefined` **synchronously**
  for a message that is not theirs. A second `addListener` fails twice over and silently:
  `mock-port` keeps one handler slot per event, so the first registration is replaced
  with nothing going red, and in Firefox an `async` handler returns a Promise for *every*
  message, which claims the reply channel from the sibling it was addressed to. Assert on
  the **un-awaited** return — `await` flattens `Promise<undefined>` to `undefined`, which
  is how the pre-existing case passed either way.
- **The choice page's keyboard grammar is PURE and lives in `picker-protocol.ts`**
  (`choiceHints`/`choiceBindings`/`choiceIntent`); `choice.ts` only performs its DOM
  effects. There is **no jsdom in this repo**, so anything decided inside `choice.ts` has
  no test below L4 — and the keyboard is this screen's non-negotiable surface. The page
  also **focuses its first option as it renders**: a `tabs.create`d extension page renders
  with focus nowhere, so arrows and Enter — the first two keys anyone tries — did nothing
  at all, and the printed hotkeys were the only way in.
- **Nothing crossing the choice-page boundary carries a tab id.** A crafted
  `moz-extension://<id>/choice.html#…` link is attacker-reachable, so the background takes
  the tab from the `cc-pick` *sender* and re-checks the url for http(s) — it goes on to
  `port.createTab`, where `javascript:` would run in a privileged origin.

## Firefox facts that make correct-looking code wrong

- **Keep `cookies`, `contextualIdentities` and `notifications` in the manifest.** Without
  `cookies`, `tabs.create({cookieStoreId})` throws and *nothing routes*; without
  `contextualIdentities`, MAC's gate rejects the F7 handshake; without `notifications`, the
  F9 declination toast is silently lost.
- **`tabs.create` rejects `about:newtab`/`about:home`** (`Illegal URL`) — land there by
  passing **no url at all** (hence optional `CreateTabProps.url`). Auto-temp shipped once
  with `url: tab.url`: every containerize threw *after* creating the identity, leaving
  orphan `tmp…` containers and a swallowed `console.warn` as the only symptom.
- **A tab reads `about:blank` for its whole pre-commit life**, so a tab we reopened, a
  `target=_blank`/`window.open` tab (which **inherits its opener's** container) and a truly
  blank tab are indistinguishable. Hence: `about:blank` is not an auto-temp candidate (else
  every link opened in a new tab dies pre-load — cost: `newtabpage.enabled=false` users go
  uncontainerized, as in TCP); `buildNavContext` reports `current: null` there (reporting
  the inherited container parks every middle-clicked link in its opener's throwaway); and
  `reopenedNav`'s requestId is the *only* thing separating our tab from theirs.
- **`tabs.onCreated` sometimes fires with `about:blank` before the real url** (bug 1586612),
  so auto-temp listens on **both** `onTabCreated` and `onTabUpdated`, deduped by a
  `processed` set. An `onCreated`-only draft passed L3 and silently failed in real Firefox.
- **`reopenedNav` is keyed on the *navigation*, awaits a *specific* url, and matches it by
  **site**.** A redirect chain keeps one requestId and stays `about:blank` throughout, so the
  one-shot version walked `tmp1`→`tmp2`→`tmp3` on one click; a marker that any request could
  claim went stale and loaded the next navigation **unrouted inside the container we had just
  reopened into** (F11 via F1); and HSTS rewrites the url before `onBeforeRequest`, so exact
  matching bought a second throwaway per upgrade. All three have revert-verified L3 tests.
- **Firefox honours `windowId` on `tabs.create` even for popup windows** (verified, FF153).
  Omit it and a `window.open` share popup is replaced in the last focused *normal* window,
  then closed with its navigation. `Tab.windowId` is required, not optional — an optional
  field is one the mock forgets to set, and coverage quietly stops.
- **A reopen KEEPS a source tab that is on a page**, cancelling only its navigation and
  opening beside it: session history doesn't span containers, so replacing it destroys what
  the user was reading. A tab with **nothing to lose** (new-tab, choice page, pre-commit
  `about:blank`) is still replaced, else every new-tab link strands an empty tab. MAC's rule
  (`mac/src/js/background/assignManager.js`, `removeTab`).
- **`port.createTab` issues a GET, so a navigation with a body is never reopened**
  (`d.method !== "GET"`, before `macOwns` and `handled.add`, so it adds no state and is
  fail-open). Reopening a POST drops the SAML assertion. It sits in the engine, not the
  resolver: the routing answer is right, the *effect* can't be performed losslessly.
- **Firefox awaits a blocking listener's returned promise** — the only reason `gatedPort`
  can delay an early navigation, and the only reason the engine can `cancel` after an async
  effect. MV2 only.

## Config: storage is the truth, the bundle is only a seed

- **`__CC_CONFIG_YAML__` / `SEED_CONFIG_YAML` is the FIRST-RUN SEED**; the live config is
  `storage.local.configYaml`, so a later build's seed never overrides an edited config —
  the point, not a bug. Four seeds differ: e2e, `npm run manual`, `npm run package`, plus a
  **hand-copied duplicate of `TEST_CONFIG_YAML` in `vitest.shared.ts`** (unit tests skip
  esbuild) that nothing asserts.
- **A broken stored config never falls back to the seed**: `loadConfig` returns the *empty*
  config plus the error, so everything opens in a throwaway — loud, where stale rules are a
  silent wrong answer. `parseConfig("")` is legal and means "nothing matches".
- **Every `browser.*` listener registers SYNCHRONOUSLY as `background.ts` evaluates.**
  Wiring inside an async IIFE loses the session's *first* navigation outright — Firefox
  dispatches it before `onBeforeRequest` exists (four `auto-temp` e2e cases went red
  deterministically, not flake). Two devices keep it working: `config` is one object filled
  in place by `Object.assign` (hand the siblings a fresh object and they keep the empty
  one), and `useConfig` folds that fill and the gate release into one call.
- **The gate covers the engine only** — `gatedPort` goes to `createEngine`, every other
  sibling gets the raw port, so the cookie-seeder can fire against the empty config. The
  script-injector reads config eagerly and is deferred to `injectScripts()`.
- **`storage.sync` is a MIRROR and the background is its only writer.** Nothing in the
  engine, wiring, `loadConfig` or resolver knows sync exists — which is what keeps it out of
  the synchronous-listener contract. It runs **last** in the async tail, being the only step
  that can end in `runtime.reload()`; two writers would race a dying options page against a
  starting background.
- **`decodeRecord` must distinguish `incomplete` from `absent`.** `absent` means *push*, so
  reading a half-arrived record as absent publishes your older config over the update still
  landing — and the sender adopts the rollback. The integrity check is a hash, not a length.
- **Both convergence properties in `reconcile` fail as a loop, not a wrong answer**: equal
  text never returns `adopt` (adoption reloads, so two machines restart each other forever),
  and the equal-stamp tie-break compares **texts** so exactly one side publishes. The tie is
  the *normal* first startup — pre-existing configs all backfill to `PRE_SYNC_EDIT`.
- **The background is the pause state's ONLY writer; the options page only reads.**
  Arming by a storage write from the page would race the background's own row-appends —
  a new host landing while the user toggles loses one of the two writes. The page
  subscribes to `storage.onChanged` as a *signal* and refetches through a message.
- **The startup gate awaits pause hydration as well as the config.** The armed set cannot
  be read inside the blocking handler (that is a storage round-trip in front of every
  navigation), so it is read once and the session's first navigation is delayed instead.
  Registration still happens synchronously; only the handler's body waits.
  `wireBackground` exposes that readiness as `ready` **for the restart harness** — a case
  that observes half-hydrated pause state passes for the wrong reason.
- **Saving is a full extension restart, so every in-memory structure dies** — `handled`,
  `reopenedNav`, warned hosts, the `tmpSuffix` counter (hence `highestTmpSuffix`, or every
  save reissues `tmp1` beside a live `tmp1`). Don't add a cache expecting it to survive.
- **`tmp` is a reserved name prefix with no enforcement.** Identity derives from the name so
  it survives a restart — but a user rule `open: tmpwork` creates a permanent container the
  disposer **deletes once empty**. Suspect this first when a container vanishes.
- **The disposer's grace is a STORED FACT** (`cookieStoreId -> emptySince`, remaining grace
  re-derived per sweep), because a pending `setTimeout` dies with the background context and
  every save reloads: the timer version lost each pending grace on Save and its startup sweep
  then reclaimed at grace 0, so saving your config destroyed live throwaways (F10). Timers
  now only make disposal punctual — losing one costs lateness, never earliness. Deliberate
  consequence: a `tmp` container with no stored note starts its grace *now*, since emptiness
  never written down is indistinguishable from a live grace.

## What a green test run can still hide

- **Revert-verify every regression test — back the fix out, watch it go red, restore it**
  (from an editor undo, **not** `git checkout`, which discards uncommitted work). This suite
  shipped false greens twice: three e2e tests passed with auto-temp entirely broken, and L3
  tests once asserted the bug.
- **An auto-temp e2e must not navigate.** Any unmatched http url reaches a `tmp` container
  via the *engine's* disposable path, so "open a tab, navigate, assert tmp" passes whether or
  not auto-temp exists. The isolating signal is a tab in `tmp` **while still on
  `about:newtab`** (`launch({ startupUrl: "about:newtab" })`); the startup sweep discards the
  driver's own tab, so re-`switchTo` a survivor and observe from a fresh one.
- **Don't trust a green `npm test` on disposal timing** — every fast case keeps browsing,
  and browsing re-triggers the sweep. `*.realtime.test.ts` is the one thing `npm test` does
  not run (`npm run test:realtime`, nightly), and cases there must **not** pass `ccGraceMs`:
  the point is that the bundle carries the shipped constant.
- **The pause's toolbar button and badge have no L4 coverage and cannot.** WebDriver
  cannot click a `browser_action` or read chrome UI. `test/e2e/pause.test.ts` drives the
  **options-page** arming route instead, and because both routes call one `arm()` the
  uncovered surface is the click itself (`browser-port.test.ts` covers the tab mapping).
  **Do not add a build-time seed to arm a container** to close the gap:
  `__CC_NOTIFY_ECHO_TO__` already shows the cost — no test build is byte-equivalent to a
  packaged one — and a path that arms by name would make the shipped extension capable of
  starting up with routing disabled.
- **An options-page e2e must read tab ids BEFORE parking on the options page.** The
  probe's command relay is a DOM event injected into http(s) pages only, so from
  `moz-extension://` every probe command (`listTabs`, `nav`, …) goes unanswered and reads
  as a timeout. `pause.test.ts` collects the tab id while still on the http page, arms,
  then switches back to an http page before navigating.
- **A probe reply is written into the DOM of the page that RELAYED the command, so a
  `nav` must never move the tab the driver is parked on** — the navigation destroys the
  document the answer lands in, and whether the reply beats the commit is a race the
  driver's 100ms poll loses now and then. It reads as `probe command "nav" timed out`,
  and it took `pause.test.ts` red on CI. The probe now **refuses** a `nav` whose target is
  `sender.tab.id`, so the mistake names itself instead of flaking; the fix is a second
  http tab to relay from (`openTab` + `awaitContainerTab`, a matched host so CC parks it
  once and never touches it again). **Open that tab through the probe, not `driver.get`** —
  from a committed page the reopen cancels the navigation and `driver.get` never returns.
- **`test/engine/mock-port.ts` fidelity is where "L3 green, Firefox broken" comes from.** It
  fires `onTabCreated` from `createTab`, fires `onTabRemoved` from `removeTab` (Firefox
  doesn't care who closed the tab — while it didn't, a tab **CC itself closed** was invisible
  to the disposer), and throws on privileged `about:` urls. Never relax these.
- **`test/engine/restart.ts` needs one handler slot per event and the per-session clock
  facade** — without it the old disposer re-arms its GC through a closure holding a live port,
  and the harness reports state surviving a restart that never happened. Restart from a
  settled state: async work in flight is unmodelled.
- **An F9 e2e must start from a COMMITTED page**: from a fresh tab CC reopens first, the 302
  is then another hop of a navigation `reopenedNav` already owns, and the assertion proves
  nothing. If the POST guard regresses the tab wedges and every WebDriver call blocks — **a
  bare timeout is that regression's signature, not flake.**
- **A reaper case must kill its holder with a SIGNAL.** Selenium's own exit hook already
  cleans up after a clean exit and an uncaught throw, so an abandonment case that merely
  `process.exit()`s passes with `harness/reaper.ts` removed entirely — verified by doing it.
  Only SIGTERM isolates what the reaper adds.
- **Config-sync adoption has no L4 test and cannot have one** (no Firefox Account in a test
  profile, no `moz-extension:` navigation, probe has its own sync namespace). The e2e cases
  observe the **startup push and save nothing** — a Save means observing after
  `runtime.reload()`, which parks the driver on a torn-down page and hangs `afterAll`.

## e2e: what the driver cannot do, and what the probe does instead

- **Unsigned CC loads on *release* Firefox by TEMPORARY install** (`installAddon(xpi, true)`),
  which grants `webRequestBlocking`. Don't reach for Developer Edition, Nightly or signing to
  fix a load failure — `xpinstall.signatures.required=false` is ignored on release and only
  *permanent* install needs signing. (A long detour blamed signing; it was the missing
  `cookies` permission plus the F1 loop.)
- **Observation is the probe**, a separate MV2 extension: `CSID:<store>` in `document.title`,
  container name/list in `data-cc-*`. It also **provisions a `probe` container and its own
  tab**, so every list and tab-count assertion sees one extra.
- **WebDriver cannot navigate to `about:newtab` or `moz-extension://`** (Marionette's
  non-web-scheme rule; pinning the uuid doesn't help), and `newWindow("tab")` gives
  `about:blank`, which auto-temp ignores by design. Hence the probe's `newTab` / `tabs` /
  `nav` (by **tab id** — the driver can't map a handle to one) / `open` commands; the driver
  can only *operate* an extension page something else opened.
- **The command relay is a DOM event injected into http(s) pages only**, so the driver must
  be parked on a probe-reported http(s) page first, and an unanswered command reads as an
  *empty answer*, not an error. Likewise **`commands.onCommand` cannot be driven at all**
  (chrome-level key events) — the reopen picker is L3-tested and its e2e case is `it.skip`.
- **The probe's attributes land AFTER `driver.get` resolves** (`reportTab` awaits two
  `cookies.getAll` calls first) while server-rendered markup is there as the document
  parses, so asserting on both in one breath is a race. `awaitContainerTab` covers most
  cases free; a navigation with **no reopen to wait for** needs `awaitProbeReport`.
- **Drive routing from a FRESH tab** — a cancelled navigation never returns to WebDriver, so
  `driver.get` on a tab already on a page hangs until timeout.
- **The harness server's redirect destinations are CONSTANTS, not query params** — off the
  query string it's an open redirect and CodeQL fails the build. `?link=` for a real
  `target=_blank` anchor is fine, and a scripted `tabs.create` does not reproduce container
  inheritance.
- **`__CC_NOTIFY_ECHO_TO__` echoes notifications to the probe, and must be sent AFTER
  `notifications.create` resolves** — echo first and a missing permission still yields a
  green e2e with the feature broken (verified by doing it; only the 5ms ordering case in
  `browser-port.test.ts` caught it). `launch()` sets it unconditionally, so even
  `npm run manual` isn't byte-equivalent to a packaged build.
- **`driver.quit()` is not what keeps a browser from leaking — `harness/reaper.ts` is.**
  Selenium unrefs its geckodriver and kills it from a `process.once("exit")` hook of its own
  (`io/exec.js`, `onProcessExit`), which covers a clean exit and an uncaught throw and
  nothing else: node emits no `exit` for a **signalled** process; a browser leaked *mid-run*
  (a `beforeAll` past `hookTimeout`, an `installAddon` that throws) then runs alongside every
  later test; and session creation can throw with Firefox **already up** — on macOS it
  re-execs, geckodriver loses the pid it was watching, and the survivor re-parents to init
  with no capability left to find it by. So `launch` passes a `-profile` directory it made
  itself, stamping the argv of the browser *and every content process* with a token that
  exists before Firefox does. Keep that argument; keep `reapProfile`'s guard refusing a path
  that isn't `cc-e2e-profile-…` (it becomes a `pgrep -f` pattern, and a short one matches
  half the process table); and leave `npm run manual` **without** a SIGINT handler — the
  reaper's is registered first and would pre-empt it.
- **Debug real Firefox** with geckodriver `--log trace` + Selenium `usingServer` +
  `devtools.console.stdout.content=true`; `console.error` then reaches the log. `MOZ_LOG`
  surfaced nothing.

## MAC interop (`test/e2e/mac-interop.test.ts`)

- **Only an ASSIGNED domain tests the handshake** — `macOwns` swallows throws, so a broken
  handshake and "no assignment" look identical. Backing the F7 defer out fails as **no
  container tab at all**, not a `tmp` one: CC and MAC fight over the navigation.
- **An assignment cannot be scripted** (chrome UI only; MAC's API has no setter), so the
  harness appends a script to MAC's background page *inside the xpi it builds* calling MAC's
  **own** `storageArea.set` — with **`neverAsk: true`**, or MAC parks on its confirm
  interstitial and no container tab appears, and only **after the container RESOLVES**, since
  MAC deletes an assignment whose container it can't `get` and Firefox provisions even
  built-in ones lazily (this flaked CI once, green on re-run).
- **Nothing may navigate until the assignment is READABLE; `launch` blocks on a beacon.**
  MAC reads it in `onBeforeRequest`, CC a `getAssignment` roundtrip later, so a write landing
  mid-flight is seen by one and missed by the other. A background page's storage is in no DOM,
  so a `fetch` to the harness server is the only way Node learns it landed; give-up sends no
  beacon, failing `launch` loudly. Failures here read as "no container tab" for the full
  timeout, never as a wrong container.
- **`mac/src/_locales` is an unchecked-out submodule** and MAC declares `default_locale`, so
  Firefox refuses the add-on with a bare *"Extension is invalid"*; the harness synthesises
  the six `__MSG_` keys.

## Release and AMO facts that look like bugs

- **`npm run sign:dev` and `npm run submit` UPLOAD.** The credential guard is not a dry-run
  switch, and `npm` under mise carries AMO credentials even when a plain shell shows them
  unset. `sign:dev` takes its version from `VERSION`; to exercise only the build half, call
  `packageExtension` with the dev id (both CLI tails are argv-guarded).
- **Never derive a dev version from the clock** — `YYMM.DD.HHMM` outranks every
  `YYMM.0.<micro>` for the rest of the month, so one local build would own the update channel.
  Nothing enforces this; it is a rule for whoever sets `VERSION`.
- **AMO REPACKS uploads**, so its copy is never byte-comparable with a local rebuild (sorted
  entries + fixed 1980 mtime here, filesystem order + real mtimes there — measured twice).
  Verify reproducibility against the **GitHub release** asset and that release's `BUILD_TIMESTAMP`.
- **A listed version is signed at APPROVAL, not upload** — in the queue it downloads back
  without `META-INF/`, so nothing is permanently installable. Unlisted signs in minutes:
  `unreviewed` → `public`, +~10KB, `file.url` flips `.zip` → `.xpi`.
- **`update_url` is legal unlisted and REJECTED listed**, and must be stamped *before*
  signing (it lives inside the signed manifest), so a build shipped without one can never
  learn about its successors. `package.test.ts` asserts both directions.
- **Both channels share ONE tag sequence — the `prerelease` flag distinguishes them, not the
  tag.** `scripts/dev-updates.js` filters on it; a tag prefix matches nothing, and matching
  everything pushes the *listed* xpi to dev users under the dev add-on's id.
- **GitHub immutable releases are ENABLED**: assets can't be edited, so the dev xpi ships in
  the same `gh release create`, and a rollback is *deleting* a release plus republishing the
  manifest.

## `tcp/` and `mac/`

Read-only upstream reference (we re-implement both): TCP's `cleanup.ts` shaped the disposer,
its `getAssignment` handshake the F7 defer. **Both are gitignored and absent from a fresh
clone, and `mac/` is a test prerequisite** — `harness/firefox.ts` builds MAC's xpi from
`mac/src` unbuilt, and `mac-interop.test.ts` **fails rather than skips** without it (a bare
ENOENT), so a first `npm test` on a new machine reports a broken case that is only a missing
checkout. Clone `mozilla/multi-account-containers` into `mac/` as CI does. Cite both by
**file and symbol, never line number** — they track upstream, so a `:NNN` drifts.
