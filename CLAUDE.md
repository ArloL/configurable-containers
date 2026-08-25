# CLAUDE.md — Configurable Containers

A Firefox WebExtension that routes each site into the right container from one user config.

Covered elsewhere: `README.md` (goals, build, release), `CONFIG.md` (config format),
`TESTING.md` (the L1–L5 pyramid, the F1–F14 bug matrix), `test/` (the behaviour spec),
`docs/superpowers/`, `FOLLOWUPS.md`. Why a function is shaped the way it is lives in its
own comment. This file carries only **platform and tooling facts that make a
reasonable-looking change wrong**.

## Where new logic goes

- **Routing answers go in `src/resolver/` (pure `resolve`) or `src/matcher/`; effects go
  in `src/engine/engine.ts`.** The engine is not a passthrough: it owns `reopenedNav`, the
  non-GET declination, the MAC handshake and the `handled` dedupe.
- **The three match grammars are one `Matcher` union in `src/matcher/matcher.ts`.**
  `matcherToPatterns` is what the script-injector registers content scripts with, so it
  must cover exactly what `matches()` answers true for — hence a host expanding to two
  patterns, a pattern in canonical form, and a regex **throwing**. Never make that throw
  return `*://*/*`: that injects the user's snippet into every page they open.
  `config/parse` keeps it unreachable by refusing `scripts` on a rule whose match list
  holds a regex (`cookies` are seeded per navigation and need no pattern).

  Two more things an edit gets wrong. In a **pattern** a bare host is only that host, so
  `https://example.com/*` is not `www.example.com`; `*.` asks for the subtree, and
  widening it widens every path-scoped rule. And a path glob is escaped and anchored at
  both ends, so `/work` does not answer `/workshop`, nor `/a.b` answer `/axb`. A regex is
  compiled at parse time (a throw inside the blocking handler is a navigation that never
  completes) and gets **no** backtracking guard, because a JavaScript regex cannot be
  interrupted — `TESTING.md` L2 says why that is a documented risk, not a gap.
- **`BrowserPort` is the browser seam for the engine and its siblings only** (`port.ts`
  types, `browser-port.ts` implementation).
  `src/extension/{config,config-sync,options,choice}.ts` touch `browser.*` directly by
  design.
- **New background behaviour is a sibling in `wireBackground` (`src/extension/wiring.ts`),
  never nested in `createEngine`.** `background.ts` is that call plus an async tail, and
  the L3 restart harness drives the same function, so startup order cannot drift.
- **Tab placement is `src/engine/supersede.ts` — add a caller, never a copy.** Callers:
  `engine.reopen`; `picker.showChoice`, through the injected `engine.reopen` (hence
  `createEngine` returning `{ reopen }`), because a hand-rolled reopen skips `reopenedNav`
  and reopens forever; and `auto-temp.containerize`, where an about: page never matches
  `keep` and takes the replace branch. The rule was copied into the picker once and
  drifted: the choice page loaded into the triggering tab and destroyed the user's page.
- **A guard on the engine's own webRequest handling stays IN `engine.ts`.** `handled`,
  `reopenedNav` and `viewSourceNav` are one family, each keyed on a navigation and read
  inside the blocking handler. A sibling module is for behaviour with a life of its own —
  `pause` has storage, a badge and an options page; a `Set` the handler reads is not.
  `viewSourceNav` deliberately has **no `onTabRemoved` cleanup**: the leak is one integer
  per source tab closed on `view-source:`, not worth a third listener on an event two
  siblings share.
- **The blocking handler takes one navigation at a time PER TAB (`inTurn`, `engine.ts`).**
  A decision is a read-then-act across four awaits (`getTab`, MAC, `createIdentity`,
  `createTab`), and Firefox can deliver a **second `main_frame` request for the same tab
  inside that window** — one "Open Link in New Tab" reaching webRequest twice. Read
  concurrently, both see the same pre-commit `about:blank` tab and both mint a throwaway:
  one click, two containers (F1). `handled` cannot catch it — two requestIds, one
  navigation. Serialised, the second is decided after `supersede` replaced its tab, so
  `getTab` returns null and it falls open. Keep the queue **per tab**: a global one would
  put an unrelated tab's navigation behind this one's MAC roundtrip.
- **`src/engine/pause.ts` owns arming, recording and the badge; the engine consults it at
  one point.** The seam is **synchronous by contract**: `isPaused` runs inside the blocking
  `onBeforeRequest`, where an `await` is latency on every navigation, and `record` returns
  `void`. The step sits **after `resolve()`**, because the record's value is the
  counterfactual, and **before the non-GET declination**, because a paused POST must raise
  no F9 toast — nothing went unapplied, the user turned routing off. It adds nothing to
  `handled` and never cancels.
- **Two arming paths, one `arm()`.** The toolbar button takes its container from the `Tab`
  Firefox passes to `browserAction.onClicked`; the options page names one and the
  background validates it. **WebDriver cannot click a `browser_action`**, so logic living
  only in that handler has no end-to-end coverage — keep it a caller.
- **`wireBackground` owns the single `runtime.onMessage` registration** and dispatches by
  `type`; siblings expose `handleMessage` and must return `undefined` **synchronously**
  for a message that is not theirs. A second `addListener` breaks the reply channel in
  Firefox: an `async` handler returns a Promise for *every* message it sees, claiming the
  channel from the sibling that was addressed. `mock-port` models the hazard (first
  listener with an answer replies); `test/fitness/listeners.test.ts` pins the single
  registration. Assert on the **un-awaited** return — `await` flattens
  `Promise<undefined>` to `undefined`.
- **The choice page's keyboard grammar is PURE and lives in `picker-protocol.ts`**
  (`choiceHints`/`choiceBindings`/`choiceIntent`); `choice.ts` only performs DOM effects.
  There is **no jsdom here**, so anything decided inside `choice.ts` has no test below L4,
  and the keyboard is this screen's non-negotiable surface. The page also **focuses its
  first option as it renders**: a `tabs.create`d extension page renders with focus
  nowhere, so arrows and Enter did nothing and the printed hotkeys were the only way in.
- **Nothing crossing the choice-page boundary carries a tab id.** A crafted
  `moz-extension://<id>/choice.html#…` link is attacker-reachable, so the background takes
  the tab from the `cc-pick` *sender* and re-checks the url for http(s) — it goes on to
  `port.createTab`, where `javascript:` would run in a privileged origin.

## Firefox facts that make correct-looking code wrong

- **Keep `cookies`, `contextualIdentities`, `notifications` and `webNavigation` in the
  manifest.** Without `cookies`, `tabs.create({cookieStoreId})` throws and *nothing
  routes*. Without `contextualIdentities`, MAC's gate rejects the F7 handshake. Without
  `notifications`, the F9 toast is silently lost. Without `webNavigation`,
  `onBeforeNavigate` never fires and every "View Page Source" is routed as a navigation
  (F13).
- **A `view-source:` load reaches `onBeforeRequest` wearing the INNER url.** Ctrl+U
  fetches the document it prints, so webRequest reports a `main_frame` GET for plain
  `https://site/` in a tab still pre-commit on `about:blank`. Routing it loses the wrapper
  (a reopen can only issue a plain GET) and takes the source tab down with it, rendering
  the page in a throwaway. **`webNavigation.onBeforeNavigate` is the only event that names
  the wrapped url**, and Firefox fires it before that navigation's request (measured,
  FF153). Hence `viewSourceNav`: written there, read without an await inside the blocking
  handler. MAC has the same bug open (`mozilla/multi-account-containers#2582`).
- **`tabs.create` rejects `about:newtab`/`about:home`** ("Illegal URL") — land there by
  passing **no url at all**, hence optional `CreateTabProps.url`. Auto-temp shipped once
  with `url: tab.url`: every containerize threw *after* creating the identity, leaving
  orphan `tmp…` containers and a swallowed `console.warn`.
- **A tab reads `about:blank` for its whole pre-commit life**, so a tab we reopened, a
  `target=_blank`/`window.open` tab (which **inherits its opener's** container) and a
  truly blank tab are indistinguishable. Hence: `about:blank` is not an auto-temp
  candidate, or every link opened in a new tab dies pre-load (cost:
  `newtabpage.enabled=false` users go uncontainerized, as in TCP); `buildNavContext`
  reports `current: null` there, since a tab with no page of its own is not "already
  correctly contained" and treating an inherited container as its own would silence the
  choice screen on a tab's first navigation; and `reopenedNav`'s requestId is the only
  thing separating our tab from theirs.
- **A link opened in a new tab must still answer the continuity question, and `current`
  cannot** — hence `NavContext.inheritedFrom`, the *page* the tab's container came from,
  read by the **disposable path only**. Without it every new-tab link failed every
  same-site and same-group comparison, so opening a YouTube video from the search results
  bought a throwaway and landed logged out. `buildNavContext` fills it only when the tab
  is genuinely IN the opener's container (`tabs.create` can name an opener in any
  container, and every CC reopen does) and the opener is on **http(s)** — the disposable
  path reads a non-http url as "a throwaway nobody has browsed in yet" and would park
  every middle-clicked link in its opener's throwaway.
- **`openerTabId` outlives the click that set it** for the life of the tab, and
  `supersede` carries it across every reopen, so a routed tab still points at one in a
  *different* container. So `buildNavContext` reads `initiator` off the **page the tab is
  on** and consults the opener only when there is none (pre-commit, the `target=_blank`
  case). Asking the opener first made `inherit` bounce a tab back to the container it was
  reopened out of, and since each reopen makes the source tab the new one's opener, the
  next hop bounced it back again: login tabs alternating between two containers forever
  (F14). A typed url has no opener, so it always looked fine.
- **`tabs.onCreated` sometimes fires with `about:blank` before the real url** (bug
  1586612), so auto-temp listens on **both** `onTabCreated` and `onTabUpdated`, deduped by
  a `processed` set. An `onCreated`-only draft passed L3 and failed in real Firefox.
- **`reopenedNav` is keyed on the *navigation*, awaits a *specific* url, and matches by
  site.** A redirect chain keeps one requestId and stays `about:blank` throughout, so the
  one-shot version walked `tmp1`→`tmp2`→`tmp3` on one click; a marker any request could
  claim went stale and loaded the next navigation **unrouted inside the container we had
  just reopened into** (F11 via F1); and HSTS rewrites the url before `onBeforeRequest`,
  so exact matching bought a throwaway per upgrade. All three have revert-verified L3
  tests.
- **Firefox honours `windowId` on `tabs.create` even for popup windows** (FF153). Omit it
  and a `window.open` share popup is replaced in the last focused *normal* window, then
  closed with its navigation. `Tab.windowId` is required, not optional — an optional field
  is one the mock forgets to set, and coverage quietly stops.
- **A reopen KEEPS a source tab that is on a page**, cancelling only its navigation and
  opening beside it: session history doesn't span containers, so replacing it destroys
  what the user was reading. A tab with **nothing to lose** (new-tab, choice page,
  pre-commit `about:blank`) is still replaced, or every new-tab link strands an empty tab.
  MAC's rule (`mac/src/js/background/assignManager.js`, `removeTab`).
- **`port.createTab` issues a GET, so a navigation with a body is never reopened**
  (`d.method !== "GET"`, before `macOwns` and `handled.add`, so it adds no state and fails
  open). Reopening a POST drops the SAML assertion. It sits in the engine, not the
  resolver: the routing answer is right, the *effect* cannot be performed losslessly.
- **The decline is unconditional; the TOAST is not** (`namesAConfiguredContainer`). Only a
  decision naming a container the config names is announced — a `choice`, or a `reopen`
  into a `permanent`. A temporary target is declined in silence: "stayed in tmp9 instead
  of a new temporary container" names two throwaways the user can neither tell apart nor
  act on, and that is the **common** case — a card payment at an unmatched site where the
  3DS host posts back cross-site and staying put is what makes checkout work. Keep the two
  separate; wiring the notification into the guard makes "say less" mean "route
  differently".
- **A POST that resolves to `choice` may be unreachable outside L3** — don't try to
  reproduce it in a browser. The choice screen appears only when the tab is in **none** of
  the eligible containers, and picking one puts it in an eligible container, which is when
  multi-open returns `stay`. Every auth POST arrives after that pick.
  `post-binding.test.ts` owns the path.
- **Firefox awaits a blocking listener's returned promise** — the only reason `gatedPort`
  can delay an early navigation, and the only reason the engine can `cancel` after an
  async effect. MV2 only.

## Config: storage is the truth, the bundle is only a seed

- **`__CC_CONFIG_YAML__` / `SEED_CONFIG_YAML` is the FIRST-RUN SEED**; the live config is
  `storage.local.configYaml`, so a later build's seed never overrides an edited config —
  the point, not a bug. Four seeds differ: e2e, `npm run manual`, `npm run package`, plus
  a **hand-copied duplicate of `TEST_CONFIG_YAML` in `vitest.shared.ts`** (unit tests skip
  esbuild) that nothing asserts.
- **A broken stored config never falls back to the seed**: `loadConfig` returns the
  *empty* config plus the error, so everything opens in a throwaway — loud, where stale
  rules are a silent wrong answer. `parseConfig("")` is legal and means "nothing matches".
- **Every `browser.*` listener registers SYNCHRONOUSLY as `background.ts` evaluates.**
  Wiring inside an async IIFE loses the session's *first* navigation: Firefox dispatches it
  before `onBeforeRequest` exists (four `auto-temp` e2e cases went red deterministically).
  Two devices keep it working — `config` is one object filled in place by `Object.assign`
  (hand the siblings a fresh object and they keep the empty one), and `useConfig` folds
  that fill and the gate release into one call.
- **The gate covers the engine only** — `gatedPort` goes to `createEngine`, every other
  sibling gets the raw port, so the cookie-seeder can fire against the empty config. The
  script-injector reads config eagerly and is deferred to `injectScripts()`.
- **`storage.sync` is a MIRROR and the background is its only writer.** `loadConfig` and the
  resolver know nothing about it; the wiring knows only that a Save publishes (`afterApply`,
  handed in by `background.ts`, which builds `createConfigSync` **before** `wireBackground`
  so the two can reach each other without a mutable slot). It starts **last** in the async
  tail, being the only step that can adopt another machine's config mid-startup. Two writers
  would race the options page against the background.
- **`decodeRecord` must distinguish `incomplete` from `absent`.** `absent` means *push*,
  so reading a half-arrived record as absent publishes your older config over the update
  still landing — and the sender adopts the rollback. The integrity check is a hash, not a
  length.
- **Both convergence properties in `reconcile` fail as a loop, not a wrong answer**: equal
  text never returns `adopt` (an adoption is itself a change the other machine hears, so a
  converged pair would adopt each other's identical config forever), and the equal-stamp
  tie-break compares **texts** so exactly one side publishes. The tie is the *normal* first startup — pre-existing configs backfill to
  `PRE_SYNC_EDIT`.
- **The background is the pause state's ONLY writer; the options page only reads.** Arming
  by a write from the page would race the background's row-appends and lose one of the two
  writes. The page subscribes to `storage.onChanged` as a *signal* and refetches through a
  message.
- **The startup gate awaits pause hydration as well as the config.** The armed set cannot
  be read inside the blocking handler (a storage round-trip before every navigation), so
  it is read once and the session's first navigation is delayed instead. Registration
  stays synchronous; only the handler's body waits. `wireBackground` exposes that
  readiness as `ready` **for the restart harness** — a case that observes half-hydrated
  pause state passes for the wrong reason.
- **Saving APPLIES the config in place; it does not restart anything** (`applyStored` in
  `wiring.ts`, reached by `cc-config-apply` from the editor and called directly by
  config-sync's `adopt`). It re-reads storage through `port.readStored`, fills the one
  `config` object in place — every sibling reads it at event time, so nothing else has to be
  told — and hands the new config to the script-injector, which **unregisters its previous
  registrations** and registers the new set. That is why the injector holds its handles.
  Order is deliberate: the swap first, the registrations second, and a registration failure
  comes back in the reply rather than rolling the swap back. Storage is the truth and memory
  follows it; the other order leaves the two disagreeing until the browser restarts, which is
  the silent divergence this replaced.

  The reason it is not `runtime.reload()` any more: that is the only step of a save nothing
  can observe, and on a **temporarily installed** extension on 140.14.0esr it never comes
  back — the old background goes on routing by the old config while the editor says "Saved".
  `test/fitness/seams.test.ts` pins the call out of `src/`, and `test/e2e/options.test.ts`
  now observes a save on **both** channels. Don't reintroduce a reload to "make sure
  everything re-reads": nothing needs telling, and the reload is the part that fails.

  Consequence for state: `handled`, `reopenedNav`, warned hosts and the `tmpSuffix` counter
  now survive a save and die only with the browser. That is a fix (a save mid-reopen no
  longer costs an extra reopen) and a caution — `test/fitness/retained-state.test.ts` prices
  what nothing empties, and "the next save clears it" is no longer an argument.
  `highestTmpSuffix` stays: a browser restart still leaves `tmp<N>` containers behind with
  the counter at zero.
- **A throwaway is `tmp` PLUS A NUMBER, and the digits are load-bearing**
  (`isThrowawayName`, `src/engine/registry.ts`). Identity derives from the name because
  the name is all that survives a restart, so the shape must separate ours from the user's
  exactly: on the prefix alone, `open: tmpwork` — or an action-less rule for
  `tmpfiles.org`, where nobody typed a container name at all — was **deleted by the
  disposer once empty**, with the logins in it, and read by `toRef` as a throwaway until
  then. The other half is `config/parse` refusing a container named `tmp<N>`; keep the two
  in step, and mint only through `TMP_PREFIX + <counter>`.
- **The disposer's grace is a STORED FACT** (`cookieStoreId -> emptySince`, remaining
  grace re-derived per sweep), because a pending `setTimeout` dies with the background
  context — with the browser now, and with every config save back when saving reloaded. The
  timer version lost each pending grace on Save and its startup sweep then reclaimed at
  grace 0, so saving your config destroyed live throwaways (F10). Timers now only make
  disposal punctual: losing one costs lateness, never earliness. Deliberate consequence: a `tmp` container with no stored note starts
  its grace *now*, since emptiness never written down is indistinguishable from a live
  grace.
- **A `scripts:` snippet in the seed config is the one place nothing type-checks or
  tests** (it ships as a string inside YAML), and the shipped YouTube original-audio
  snippet carries two measured facts that make the obvious rewrites wrong. **Patching
  `ytInitialPlayerResponse` does nothing**: the player re-derives from its own
  `/youtubei/v1/player` fetch, so the retarget landed before the player read it and German
  played anyway. And **the player applies an audio-track switch, then reverts it** as
  playback commits, announcing it through none of the 48 event types the page fires — so
  no one-shot design is reliable, and `video.audioTracks` reads length 0 because YouTube
  feeds audio through MSE. Hence a held invariant on a poll, which also collapses SPA
  navigation, back navigation and the revert into one case. Full notes:
  `docs/superpowers/specs/2026-07-31-youtube-original-audio-design.md` §2.

## Static analysis: two gates, and why the obvious linter is not one

- **`typescript@7` is the Go port, and it exports no JS compiler API** — the package's
  `exports` are `lib/version.cjs` plus `unstable/*`. typescript-eslint builds every
  type-aware rule on the API that is gone, so making it work means resolving a **second**
  TypeScript 5 for the linter alone and letting lint and `npm run typecheck` disagree
  about the language. `oxlint` + `oxlint-tsgolint` reads types through tsgo — the same
  compiler `npm run typecheck` runs. Type-aware rules only fire with `--type-aware`; the
  `lint` script passes it, and `--deny-warnings`, because a rule that only warns is a rule
  nobody fixes.
- **Three rules are off and one of them is off because it is WRONG about this code.**
  `unicorn/no-useless-spread` flags `[...armed]` in `pause` and `[...live]` in the reaper;
  both loop bodies (`disarm`, `reapProfile`) delete from the collection being iterated, so
  taking its advice introduces the bug. `typescript/unbound-method` has no true positive
  here — there is one class in `src/` and no method is ever passed as a value.
  `no-unnecessary-condition` is off for `test/**` only: the mock builds states the types
  call impossible on purpose, while in `src/` the same rule is a dead-defence detector.
- **A suppression comment disables the line after the DIRECTIVE, not after the reason.**
  `// oxlint-disable-next-line <rule> -- because…` spanning three lines suppresses the
  second comment line and nothing else, silently. Put the prose above and the directive
  immediately over the code.
- **The workflows have their own two gates — `actionlint` and `zizmor`** (`check-actions.yaml`),
  and zizmor fails the build on any finding. There are **no** zizmor suppressions, and its
  `cache-poisoning` finding on a release trigger is the reason: the fix is real, not an
  ignore. **`actions/setup-node` caches BY DEFAULT** — `package-manager-cache` defaults to
  `true` and turns caching on as soon as `package.json` declares `packageManager` or
  `devEngines.packageManager` — so omitting `cache:` disables nothing, and a suppression
  would go on lying the day that field is added. Both verifiers
  (`verify-release.yaml`, `nightly.yml`'s reproducible-build) therefore pass
  `package-manager-cache: false`: a job deciding whether a published artefact is
  trustworthy must not install from a mutable cache an earlier run could have poisoned, or
  a tampered build gets certified reproducible. zizmor only reports the pairing on a
  publishing trigger, so the nightly's half was never going to be flagged.
- **`?? ""` on a `spawnSync().stdout` is not a dead defence**, whatever the types say:
  `@types/node` declares `string` once an encoding is set, and a spawn that never started
  reports null — which is the case `harness/reaper.ts` exists for. Both sites carry a
  suppression rather than a "fix".
- **`exactOptionalPropertyTypes` draws a real line at the port seam.** A property mapped
  *out* of a browser object carries `| undefined` because Firefox sets it that way;
  `CreateTabProps.url` does not, because absent and `undefined` are different requests
  and only one of them lands on the new-tab page. Keep the two call sites spreading the
  key in conditionally rather than passing `url: undefined` and trusting Firefox's
  tolerance.

## What a green test run can still hide

- **`test/fitness/` pins the properties that make every other gate mean something.** Its
  rules are not a normal test's. An **exact inventory, never a bound** (`toEqual([...])`,
  not "at most two"): a bound absorbs the next violation in silence, an inventory makes
  whoever adds one write down why. Match on **stripped comments** and identify by **file,
  not line** — this codebase names the very APIs it avoids calling, and pinned lines fail
  on every edit above them; a check that cries wolf is deleted and takes its invariant
  with it. The subject is `src/` **as text**: importing the modules would answer a
  question about what the bundler resolves. `decision-cost.test.ts` measures rather than
  inspects, and counts **port round trips, never milliseconds** — wall clock in CI is a
  flake generator.
- **Revert-verify every regression test — back the fix out, watch it go red, restore it**
  (editor undo, **not** `git checkout`, which discards uncommitted work). This suite
  shipped false greens twice: three e2e tests passed with auto-temp entirely broken, and
  L3 tests once asserted the bug.
- **An auto-temp e2e must not navigate.** Any unmatched http url reaches a `tmp` container
  via the *engine's* disposable path, so "open a tab, navigate, assert tmp" passes whether
  or not auto-temp exists. The isolating signal is a tab in `tmp` **while still on
  `about:newtab`** (`launch({ startupUrl: "about:newtab" })`); the startup sweep discards
  the driver's own tab, so re-`switchTo` a survivor and observe from a fresh one.
- **Don't trust a green `npm test` on disposal timing** — every fast case keeps browsing,
  and browsing re-triggers the sweep. `*.realtime.test.ts` is the one thing `npm test`
  does not run (`npm run test:realtime`, nightly), and cases there must **not** pass
  `ccGraceMs`: the point is that the bundle carries the shipped constant.
- **The mutation gate is at 100% and `npm test` does not run it** (`npm run test:mutation`,
  nightly). It mutates only the pure modules — `resolver`, `matcher`, `psl`, `config`,
  `overlays` — and lets only the tests that **own** each of them kill the mutants
  (`test/{resolver,matcher,psl,config,overlays}`), so a new branch in `resolve`/`matcher`/
  `same-site`/`parse` needs a case in *that module's* suite; an L3 engine case that covers
  it leaves the gate red. The parser's error **messages and `path`s are inside the gate**:
  `test/config/parse.rejections.test.ts` pins one row per rejection, so rewording a
  diagnostic without updating it is a failure, not a silent drift. A survivor is killed or named
  (`// Stryker disable … : why`), never absorbed by lowering the threshold. Two settings
  in `stryker.config.mjs` fail as `stryker run` dying at startup rather than as a bad
  score: `tsconfigFile: "none"` (its rewriter calls `ts.parseConfigFileTextToJson`, which
  **TypeScript 7 no longer exports**) and `vitest.related: false` (Vitest 4 answers "no
  related test files", so the dry run finds no tests). The run also pins fast-check's seed
  — fresh samples make each mutant's verdict a coin flip — via a setup file `npm test`
  deliberately does not load.
- **The pause's toolbar button and badge have no L4 coverage and cannot.** WebDriver
  cannot click a `browser_action` or read chrome UI. `test/e2e/pause.test.ts` drives the
  **options-page** route instead, and since both call one `arm()` the uncovered surface is
  the click itself. **Do not add a build-time seed to arm a container**:
  `__CC_NOTIFY_ECHO_TO__` already shows the cost (no test build is byte-equivalent to a
  packaged one), and arming by name would make the shipped extension capable of starting
  up with routing disabled.
- **The options page is REACHABLE a beat before it is POPULATED.** It fills `#cc-config`
  from `storage.local` after it renders, and `switchToUrl` returns on the url alone, so a
  single read can land in the gap — measured on 140 ESR, one first read in twelve came
  back empty and hydrated 13ms later. `#cc-error` has the same window, being written by
  the `validate()` that follows the fill. Wait for the text; never read once. The gap used
  to be absorbed by `getAttribute` being a script Selenium injects, and replacing it with a
  protocol command turned a standing race into a red `main` — a slower call is not a
  synchronisation primitive. Typing has the same exposure from the other side: a fill
  landing after `clear()` + `sendKeys()` overwrites what was just typed, and that reads as
  the editor ignoring input. Note the race is **load-dependent** — 40 rounds on an idle
  machine, with and without CPU pressure, reproduced it zero times.
- **An options-page e2e must read tab ids BEFORE parking on the options page.** The
  probe's relay is a DOM event injected into http(s) pages only, so from
  `moz-extension://` every probe command goes unanswered and reads as a timeout.
- **A probe reply is written into the DOM of the page that RELAYED the command, so a `nav`
  must never move the tab the driver is parked on** — the navigation destroys the document
  the answer lands in, and whether the reply beats the commit is a race the driver's 100ms
  poll loses now and then. It reads as `probe command "nav" timed out`. The probe now
  **refuses** a `nav` targeting `sender.tab.id`, so the mistake names itself instead of
  flaking; the fix is a second http tab to relay from (`openTab` + `awaitContainerTab`, a
  matched host so CC parks it once). **Open that tab through the probe, not `driver.get`**
  — from a committed page the reopen cancels the navigation and `driver.get` never returns.
- **`test/engine/mock-port.ts` fidelity is where "L3 green, Firefox broken" comes from.**
  It fires `onTabCreated` from `createTab`, fires `onTabRemoved` from `removeTab` (Firefox
  doesn't care who closed the tab — while it didn't, a tab CC itself closed was invisible
  to the disposer), throws on privileged `about:` urls, and keeps listeners in a **list
  per event, not a slot**. `addListener` is additive in Firefox, and while the mock
  modelled "last registration wins" the two events `wireBackground` registers twice
  (`onTabRemoved`: pause then the disposer; `onTabUpdated`: auto-temp then the
  redirector-closer) had their first listener silently dropped, so pause's disarm-on-empty
  and auto-temp's bug-1586612 path were unwired in every composed-background case. Never
  relax these.
- **`test/engine/restart.ts` retires a dead session TWICE — `aSessionClock` for its
  timers, `aSessionPort` for its listeners** — because `mock-port` is additive like
  Firefox, so re-wiring *adds* handlers rather than replacing them. Without the clock
  facade the old disposer re-arms its GC through a closure holding a live port; without
  the port facade every one of the previous session's siblings keeps running. Either way
  the harness reports state surviving a restart that never happened. Restart from a
  settled state: async work in flight is unmodelled.
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
  Selenium implements it as an injected atom, so the call every http(s) case makes reads
  as `UnsupportedOperationError` here. Use `getDomAttribute` for a `data-*` attribute,
  `getProperty` for a textarea's value, `switchTo().activeElement()` for the focus, and
  `clear()` + `sendKeys()` to type — all real commands, all working on ESR through
  Nightly, and typing fires the `input` the editor validates on, which assigning `.value`
  never did anyway. **Don't reach for the flag**: it re-grants privileged access to the
  whole session to keep one convenience call working, and pins the suite to a Firefox that
  permits what the shipped extension's users never will. `harness/firefox.ts`'s own
  `executeScript` helpers stay as they are — every one reads a probe-written attribute on
  an http(s) page, which is ordinary web content.
- **The command relay is a DOM event injected into http(s) pages only**, so the driver
  must be parked on a probe-reported http(s) page first, and an unanswered command reads
  as an *empty answer*, not an error. **`commands.onCommand` cannot be driven at all**
  (chrome-level key events) — the reopen picker is L3-tested and its e2e case is `it.skip`.
- **The probe's attributes land AFTER `driver.get` resolves** (`reportTab` awaits two
  `cookies.getAll` calls first) while server-rendered markup is there as the document
  parses, so asserting on both in one breath is a race. `awaitContainerTab` covers most
  cases free; a navigation with **no reopen to wait for** needs `awaitProbeReport`.
- **Drive routing from a FRESH tab** — a cancelled navigation never returns to WebDriver,
  so `driver.get` on a tab already on a page hangs until timeout.
- **The harness server's redirect destinations are CONSTANTS, not query params** — off the
  query string it's an open redirect and CodeQL fails the build. `?link=` for a real
  `target=_blank` anchor is fine, and a scripted `tabs.create` does not reproduce
  container inheritance.
- **`__CC_NOTIFY_ECHO_TO__` echoes notifications to the probe, and must be sent AFTER
  `notifications.create` resolves** — echo first and a missing permission still yields a
  green e2e with the feature broken. `launch()` sets it unconditionally, so even `npm run
  manual` isn't byte-equivalent to a packaged build.
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

## Release and AMO facts that look like bugs

- **`npm run sign:dev` and `npm run submit` UPLOAD.** The credential guard is not a
  dry-run switch, and `npm` under mise carries AMO credentials even when a plain shell
  shows them unset. `sign:dev` takes its version from `VERSION`; to exercise only the
  build half, call `packageExtension` with the dev id.
- **Never derive a dev version from the clock** — `YYMM.DD.HHMM` outranks every
  `YYMM.0.<micro>` for the rest of the month, so one local build would own the update
  channel. Nothing enforces this; it is a rule for whoever sets `VERSION`.
- **AMO REPACKS uploads**, so its copy is never byte-comparable with a local rebuild
  (sorted entries + fixed 1980 mtime here, filesystem order + real mtimes there). Verify
  reproducibility against the **GitHub release** asset and that release's
  `BUILD_TIMESTAMP`.
- **A listed version is signed at APPROVAL, not upload** — in the queue it downloads back
  without `META-INF/`, so nothing is permanently installable. Unlisted signs in minutes:
  `unreviewed` → `public`, +~10KB, `file.url` flips `.zip` → `.xpi`.
- **`update_url` is legal unlisted and REJECTED listed**, and must be stamped *before*
  signing (it lives inside the signed manifest), so a build shipped without one can never
  learn about its successors. `package.test.ts` asserts both directions.
- **Both channels share ONE tag sequence — the `prerelease` flag distinguishes them, not
  the tag.** `scripts/dev-updates.js` filters on it; a tag prefix matches nothing, and
  matching everything pushes the *listed* xpi to dev users under the dev add-on's id.
  The other half of sharing a sequence: **the dev channel BURIES a listed release in the
  release list within days**, so anything looking for one must page rather than read a
  window. `verify-reproducible.ts` asked for the newest 20 and passed nightly for four
  weeks announcing "No listed release yet" while `v2608.0.112` sat 32 releases down. Its
  `findLatestListedRelease` pages until one turns up and **throws** when the page cap runs
  out, because "I stopped looking" reported as "there is nothing to check" is what made
  that gate inert.
- **Both channels publish the SAME THREE artefacts** — the reproducible pre-signing xpi,
  the source archive, and `BUILD_TIMESTAMP` in the notes — so one job verifies either and
  `verify-release.yaml` needs no branch. A dev release carries a fourth, the AMO-signed
  xpi Firefox actually installs, and that one must stay **distinguishable by name**:
  `dev-updates.js` picks the signed asset by excluding `configurable-containers-<v>.xpi`,
  and its old `.endsWith(".xpi")` would have offered the *unsigned* build to every
  dogfooder — uninstallable, silent, and permanent on an immutable release.
- **AMO's source requirement follows the BUNDLE, not the channel, so `sign:dev` uploads it
  too.** It is triggered by shipping code a reviewer cannot read (`background.js` is an
  esbuild bundle) and unlisted add-ons are "subject to be manually reviewed at any time
  after submission" — so "nothing complained" only means nobody has looked yet, and what
  they would find is a dev add-on already installed on dogfooders' profiles. The GitHub
  asset satisfies none of it; `--upload-source-code` does, and `scripts/sign-dev.ts` builds
  the archive itself rather than taking a path from the workflow, so no upload path can
  skip it. It is safe on a path that runs on **every push to main** because attaching
  source does not delay unlisted signing: in addons-server, source creates a
  `NeedsHumanReview` only for a version *already pending rejection*
  (`Version.flag_if_sources_were_provided`), and none of `AutoApprovalSummary`'s checks
  reads it — it is a reviewer *queue flag*, not an auto-approval blocker. web-ext PATCHes
  the source on after creating the version, then polls for `public` with a 15-minute
  timeout, which is the thing that would break if that were ever to change.
- **What is NOT symmetric is the add-on itself, and it cannot be.** A dev build has its own
  id (so it installs beside the listed one with its own `storage.local`), its own name, and
  the `update_url` AMO rejects on a listed submission. So a dev release's notes publish
  `npm run package -- <version> --dev`, and `planFor` passes that flag; rebuilding a
  prerelease without it produces the listed identity and a hash mismatch that reads as
  "this release does not reproduce".
- **A release published with `GITHUB_TOKEN` triggers NO workflow**, so `on: release` is a
  dead trigger for every release this repo cuts — GitHub suppresses those events to stop
  workflows recursing. Proof rather than folklore: `publish-dev-manifest.yml` has declared
  `on: release: [published]` since July and has **one** run ever, a manual dispatch, across
  ~150 releases; it works only because `ci.yml` *calls* it. `verify-release.yaml` is wired
  the same way — `workflow_call` with the tag as an input, invoked by `ci.yml` and
  `release.yaml` after they publish — and keeps `on: release` only for a release a person
  creates in the UI, which does fire.
- **GitHub immutable releases are ENABLED**: assets can't be edited, so the dev xpi ships
  in the same `gh release create`, and a rollback is *deleting* a release plus
  republishing the manifest.
- **`npm audit` is loud and `npm run audit` (`--omit=dev`) is the one that means anything,
  and it gates every push.** The
  xpi is an esbuild bundle of `src/`, so no `node_modules` package ships and every current
  advisory is transitive dev tooling with no upstream fix (`image-size` under
  `addons-linter`, `brace-expansion` under two `minimatch` lines, `nanoid`, `qs`). `npm
  audit fix` advertises a fix and changes nothing — check its `--dry-run` first. **Don't
  silence any of it with `overrides`**: forcing a transitive dev dependency past what its
  dependent declares is a standing compatibility risk taken for a warning no user sees.
  After any change here `npm run lint:ext` is the check that matters — web-ext is the only
  thing that consumes these packages.

## `tcp/` and `mac/`

Read-only upstream reference (we re-implement both): TCP's `cleanup.ts` shaped the
disposer, its `getAssignment` handshake the F7 defer. **Both are gitignored and absent
from a fresh clone, and `mac/` is a test prerequisite** — `harness/firefox.ts` builds
MAC's xpi from `mac/src` unbuilt, and `mac-interop.test.ts` **fails rather than skips**
without it (a bare ENOENT), so a first `npm test` on a new machine reports a broken case
that is only a missing checkout. Clone `mozilla/multi-account-containers` into `mac/` as
CI does. Cite both by **file and symbol, never line number** — they track upstream.
