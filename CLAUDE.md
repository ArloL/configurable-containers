# CLAUDE.md — Configurable Containers

A Firefox WebExtension that routes each site into the right container from one user config.

This file carries only **platform and tooling facts that make a reasonable-looking change
wrong, whatever the change is**. Why a function is shaped the way it is lives in its own
comment. Three kinds of gotcha are just as load-bearing but only for one task, and each has
its own file — **read the matching one before you start, not when something breaks**:

| Before you… | Read |
|---|---|
| write, move or debug a case in `test/e2e/`, or change `harness/` | `docs/e2e-and-probe.md` |
| cut a release, run `sign:dev`/`submit`, or edit `amo/` or `scripts/` | `docs/releasing.md` (with `docs/amo-listing.md`) |
| change lint config, answer a Sonar finding, or add a suppression | `docs/static-analysis.md` |

Covered elsewhere: `README.md` (goals, build, release), `CONFIG.md` (config format),
`TESTING.md` (the L1–L5 pyramid, the F1–F14 bug matrix), `test/` (the behaviour spec),
`docs/superpowers/`, `FOLLOWUPS.md`, `docs/drift-reviews.md` (the agent reviews for what no
gate can see — a true statement that stopped being true, which every check here is blind to
because `test/fitness/` reads source with comments stripped).

## Where new logic goes

- **Routing answers go in `src/resolver/` (pure `resolve`) or `src/matcher/`; effects go
  in `src/engine/engine.ts`.** The engine is not a passthrough: it owns `reopenedNav`, the
  non-GET declination, the MAC handshake and the `handled` dedupe.
- **The three match grammars are one `Matcher` union in `src/matcher/matcher.ts`.**
  `matcherToPatterns` is what the script-injector registers content scripts with, so it
  must cover exactly what `matches()` answers true for — hence a host expanding to two
  patterns, a pattern in canonical form, and a regex throwing. Never make that throw
  return `*://*/*`: that injects the user's snippet into every page they open.
  `config/parse` keeps it unreachable by refusing `scripts` on a rule whose match list
  holds a regex (`cookies` are seeded per navigation and need no pattern).

  `patternForUrl` is the same question backwards — the pattern for one observed URL, which
  the pause record hands the user to paste — and it carries the **same "must not widen"
  duty**: `*://` because HSTS rewrites the scheme before webRequest sees it, no port
  (a pattern's host cannot carry one), a trailing `*` because a path is anchored at both
  ends and every OAuth entry point has a query, and the query itself dropped rather
  than pasted, since a record written during a checkout must not carry the token. It
  answers `null` where no pattern exists (an IPv6 literal) rather than a string the config
  editor would then reject.

  Two more things an edit gets wrong. In a pattern a bare host is only that host, so
  `https://example.com/*` is not `www.example.com`; `*.` asks for the subtree, and
  widening it widens every path-scoped rule. And a path glob is escaped and anchored at
  both ends, so `/work` does not answer `/workshop`, nor `/a.b` answer `/axb`. A regex is
  compiled at parse time (a throw inside the blocking handler is a navigation that never
  completes) and gets no backtracking guard, because a JavaScript regex cannot be
  interrupted — `TESTING.md` L2 says why that is a documented risk, not a gap.
- **`BrowserPort` is the browser seam for the engine and its siblings only** (`port.ts`
  types, `browser-port.ts` implementation).
  `src/extension/{config,config-sync,options,choice}.ts` touch `browser.*` directly by
  design. `port.ts` also owns the Firefox values the engine's siblings would otherwise
  each spell — `DEFAULT_STORE_ID` was written out independently in `registry`, `pause`,
  `auto-temp` and `browser-port`, none importing another, and two of them must be identical
  for routing to answer at all (`toRef` reading it as `{kind:"default"}`, `arm` refusing it).
- **A `Decision` said in words is the RESOLVER's** (`src/resolver/decision-label.ts`:
  `targetLabel`, `namesAConfiguredContainer`, `Declinable`). The F9 toast and the pause
  record must not drift, so it is one function — but it decides nothing the engine owns, and
  living in `engine.ts` made `pause.ts` (and every bundle that reaches it) depend on the
  engine for two pure functions. Down there it is also inside the mutation gate, which never
  saw it while only L3 engine cases covered it.
- **New background behaviour is a sibling in `wireBackground` (`src/extension/wiring.ts`),
  never nested in `createEngine`.** `background.ts` is that call plus an async tail, and
  the L3 restart harness drives the same function, so startup order cannot drift.
- **Tab placement is `src/engine/supersede.ts` — add a caller, never a copy.** Callers:
  `engine.reopen`; `picker.showChoice`, through the injected `engine.reopen` (hence
  `createEngine` returning `{ reopen }`), because a hand-rolled reopen skips `reopenedNav`
  and reopens forever; and `auto-temp.containerize`, where `about:newtab`/`about:home` are
  named among the pages with nothing to lose and take the replace branch. The rule was copied into the picker once and
  drifted: the choice page loaded into the triggering tab and destroyed the user's page.
- **A guard on the engine's own webRequest handling stays IN `engine.ts`.** `handled`,
  `reopenedNav` and `viewSourceNav` are one family, each keyed on a navigation and read
  inside the blocking handler. A sibling module is for behaviour with a life of its own —
  `pause` has storage, a badge and an options page; a `Set` the handler reads is not.
  `viewSourceNav` deliberately has no `onTabRemoved` cleanup: the leak is one integer
  per source tab closed on `view-source:`, not worth a third listener on an event two
  siblings share.
- **The blocking handler takes one navigation at a time PER TAB (`inTurn`, `engine.ts`).**
  A decision is a read-then-act across four awaits (`getTab`, MAC, `createIdentity`,
  `createTab`), and Firefox can deliver a second `main_frame` request for the same tab
  inside that window — one "Open Link in New Tab" reaching webRequest twice. Read
  concurrently, both see the same pre-commit `about:blank` tab and both mint a throwaway:
  one click, two containers (F1). `handled` cannot catch it — two requestIds, one
  navigation. Serialised, the second is decided after `supersede` replaced its tab, so
  `getTab` returns null and it falls open. Keep the queue per tab: a global one would
  put an unrelated tab's navigation behind this one's MAC roundtrip.
- **`src/engine/pause.ts` owns arming, recording and the badge; the engine consults it at
  one point.** The seam is synchronous by contract: `isPaused` runs inside the blocking
  `onBeforeRequest`, where an `await` is latency on every navigation, and `record` returns
  `void`. The step sits after `resolve()`, because the record's value is the
  counterfactual, and before the non-GET declination, because a paused POST must raise
  no F9 toast — nothing went unapplied, the user turned routing off. It adds nothing to
  `handled` and never cancels.

  **Its recordings are the ONE thing CC APPENDS TO that outlives the browser**, so they are
  the one place a cap is not optional. The four other `storage.local` keys — the config, its
  stamp, the replaced copy, the disposer's `tmpEmptySince` — are each rewritten whole rather
  than grown, and everything else here dies with the background context. The pause state is
  in `storage.local`, and `record()` appends a row per distinct host and `persist()`s the
  whole state on each new one. A container armed and forgotten therefore grew a stored
  array, and wrote it from the blocking path, for as long as browsing continued.
  `MAX_RECORDED_HOSTS` bounds both — and the hosts past it are counted into
  `Recording.dropped`, not dropped in silence: rules are written from that list, and one a
  reader takes for the whole flow while it quietly is not is the same silent wrong answer a
  half-parsed config would be. `dropped` is optional in `StoredRecording` and required in
  `Recording`, which is the split below: a recording stored before the cap has no such key
  and refusing it on hydrate would throw the user's history away, but by the time the
  blocking handler increments it the normalizer has filled it in.

  **A row is one per URL as well as one per host** (`RecordedHost.urls`, the pattern
  `patternForUrl` built), which is what makes a rule for a GitHub OAuth hand-off writable
  from a record at all — and what makes the second cap
  (`MAX_RECORDED_URLS_PER_HOST`, counted into the host row's own `dropped`) not optional
  either: a URL row grows with browsing, not with the handful of hops a flow makes.
  A host whose URLs did not all resolve the same way says `VARIED` rather than picking one,
  because with path matching `github.com` genuinely has two answers and a row claiming
  either sends the reader to write the rule that breaks the sign-in.

  Hydration therefore **normalizes rather than validates** (`readRecording`/`readHost`/
  `readUrl`, which replaced the `isRecording` type guard). A host row written before URL
  detail has no `urls`, and a build that trusted the stored shape would call `.find` on
  `undefined` inside the blocking handler, where a throw is a navigation that never
  completes. Filling the missing fields in is what lets `urls` be required in the type
  instead of checked at every use.

  **Three types, not one, and which one may carry an optional field is the contract.**
  `StoredRecording`/`StoredHost` (what any build may have left in `storage.local`, where a
  field added later is optional), `Recording`/`RecordedHost` (in memory, everything present)
  and `RecordingView`/`RecordedHostView`/`RecordedUrlView` (`pause-protocol.ts`, what the
  message carries and the options page renders). The normalizers are the crossing one way,
  `toView` the other. One declaration served all four roles until 2026-08-29, so a change
  made for the renderer landed in a schema the blocking handler mutates, and the module was
  `src/`'s only import cycle — `engine/pause` ↔ `extension/pause-protocol`. Adding a field
  now costs three edits the compiler asks for. Two things it bought immediately:
  `cookieStoreId` does not cross to the page (it has no use for a store id), and
  `record()` says `open.dropped++` rather than `(open.dropped ?? 0) + 1` inside
  `onBeforeRequest`. `PAUSE_STORAGE_KEY` moved to `pause-protocol.ts` for the same reason:
  the page names it to subscribe to `storage.onChanged` as a signal, and a key two realms
  agree on is protocol, not a private detail one of them borrows. So `options.ts` imports
  nothing from `src/engine/` and `test/fitness/seams.test.ts` pins that the engine's only
  reach into `src/extension` is a protocol module.
- **Two arming paths, one `arm()`.** The toolbar button takes its container from the `Tab`
  Firefox passes to `browserAction.onClicked`; the options page names one and the
  background validates it. WebDriver cannot click a `browser_action`, so logic living
  only in that handler has no end-to-end coverage — keep it a caller.
- **`wireBackground` owns the single `runtime.onMessage` registration** and dispatches by
  `type`; siblings expose `handleMessage` and must return `undefined` synchronously
  for a message that is not theirs. A second `addListener` breaks the reply channel in
  Firefox: an `async` handler returns a Promise for *every* message it sees, claiming the
  channel from the sibling that was addressed. `mock-port` models the hazard (first
  listener with an answer replies); `test/fitness/listeners.test.ts` pins the single
  registration. Assert on the un-awaited return — `await` flattens
  `Promise<undefined>` to `undefined`.
- **The choice page's keyboard grammar is PURE and lives in `picker-protocol.ts`**
  (`choiceHints`/`choiceBindings`/`choiceIntent`); `choice.ts` only performs DOM effects.
  There is no jsdom here, so anything decided inside `choice.ts` has no test below L4,
  and the keyboard is this screen's non-negotiable surface. The page also focuses its
  first option as it renders: a `tabs.create`d extension page renders with focus
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
- **The floor is `strict_min_version: "140.0"`, and 140 comes from the MANIFEST rather than
  the code.** Every `browser.*` call in `src/` has been there since Firefox 59 at the
  latest (`contentScripts.register`); what sets the floor is
  `browser_specific_settings.gecko.data_collection_permissions`, a 140 key. 140 is also
  where CI's `latest-esr` leg sits, and below it nothing here has ever been run — which is
  the argument against lowering it to what the APIs alone would allow: an older Firefox
  that lacks an API or ignores a key does not refuse to install, it routes wrongly on a
  profile no gate here has touched. `test/fitness/firefox-floor.test.ts` prices every call
  site and every manifest key against `@mdn/browser-compat-data` and fails on one that
  wants more than the floor; it also pins `harness/build-extension.ts`'s esbuild `target`
  to the same major, which is a claim about *syntax* only and is how that one had drifted
  to `firefox115` while the manifest shipped a 140 key. Don't add `gecko_android` to
  quiet addons-linter's warning that the key needs Android 142: containers do not exist on
  Firefox for Android (`contextualIdentities` is unsupported at every version), so the key
  would advertise an add-on that cannot route there at all.
- **A `view-source:` load reaches `onBeforeRequest` wearing the INNER url.** Ctrl+U
  fetches the document it prints, so webRequest reports a `main_frame` GET for plain
  `https://site/` in a tab still pre-commit on `about:blank`. Routing it loses the wrapper
  (a reopen can only issue a plain GET) and takes the source tab down with it, rendering
  the page in a throwaway. `webNavigation.onBeforeNavigate` is the only event that names
  the wrapped url, and Firefox fires it before that navigation's request (measured,
  FF153). Hence `viewSourceNav`: written there, read without an await inside the blocking
  handler. MAC has the same bug open (`mozilla/multi-account-containers#2582`).
- **`tabs.create` rejects `about:newtab`/`about:home`** ("Illegal URL") — land there by
  passing no url at all, hence optional `CreateTabProps.url`. Auto-temp shipped once
  with `url: tab.url`: every containerize threw *after* creating the identity, leaving
  orphan `tmp…` containers and a swallowed `console.warn`.
- **A tab reads `about:blank` for its whole pre-commit life**, so a tab we reopened, a
  `target=_blank`/`window.open` tab (which inherits its opener's container) and a
  truly blank tab are indistinguishable. Hence: `about:blank` is not an auto-temp
  candidate, or every link opened in a new tab dies pre-load (cost:
  `newtabpage.enabled=false` users go uncontainerized, as in TCP); `buildNavContext`
  reports `current: null` there, since a tab with no page of its own is not "already
  correctly contained" and treating an inherited container as its own would silence the
  choice screen on a tab's first navigation; and `reopenedNav`'s requestId is the only
  thing separating our tab from theirs.
- **A link opened in a new tab must still answer the continuity question, and `current`
  cannot** — hence `NavContext.inheritedFrom`, the *page* the tab's container came from,
  read by the disposable path only. Without it every new-tab link failed every
  same-site and same-group comparison, so opening a YouTube video from the search results
  bought a throwaway and landed logged out. `buildNavContext` fills it only when the tab
  is genuinely IN the opener's container (`tabs.create` can name an opener in any
  container, and every CC reopen does) and the opener is on http(s) — the disposable
  path reads a non-http url as "a throwaway nobody has browsed in yet" and would park
  every middle-clicked link in its opener's throwaway.
- **`openerTabId` outlives the click that set it** for the life of the tab, and
  `supersede` carries it across every reopen, so a routed tab still points at one in a
  *different* container. So `buildNavContext` reads `initiator` off the page the tab is
  on and consults the opener only when there is none (pre-commit, the `target=_blank`
  case). Asking the opener first made `inherit` bounce a tab back to the container it was
  reopened out of, and since each reopen makes the source tab the new one's opener, the
  next hop bounced it back again: login tabs alternating between two containers forever
  (F14). A typed url has no opener, so it always looked fine.
- **A tab's url is not final when `tabs.onCreated` fires** — it reads `about:blank` until
  the url commits and the real one arrives on `tabs.onUpdated`, and how long that lasts is
  channel-dependent (`tabs.create({})` answers `about:blank` on 140 ESR, `about:newtab` on
  154). So auto-temp listens on both `onTabCreated` and `onTabUpdated`, deduped by a
  `processed` set; an `onCreated`-only draft passed L3 and failed in real Firefox. Four sites
  here credited bug 1586612 for this until 2026-08-29 and none should again: that bug is
  `onUpdated` firing *before* `onCreated`, fixed on 73.0a1 in 2019 — this is ordinary
  documented behaviour, so no Firefox version retires the second listener.
- **`reopenedNav` is keyed on the *navigation*, awaits a *specific* url, and matches by
  site.** A redirect chain keeps one requestId and stays `about:blank` throughout, so the
  one-shot version walked `tmp1`→`tmp2`→`tmp3` on one click; a marker any request could
  claim went stale and loaded the next navigation unrouted inside the container we had
  just reopened into (F11 via F1); and HSTS rewrites the url before `onBeforeRequest`,
  so exact matching bought a throwaway per upgrade. All three have revert-verified L3 tests.

  The site and the requestId answer different halves of a hop, and **neither one alone is the
  guard**. A hop that stays on the awaited site is absorbed outright. A hop that LEAVES it is
  resolved like any navigation — with the tab's real container and the awaited url standing in
  for the `about:blank` it reads as, so a hop within one rule (`github.com` → `github.dev`) is
  answered "already contained" rather than reopened into the container it is in — and then
  `aHopBuysNoThrowaway` vetoes any answer that is only another throwaway. Both halves are
  required and each is pinned by the case it exists for: absorbing a cross-site hop outright
  left every SSO return hop unrouted in the identity provider's container (sonarcloud.io →
  github.com/login/oauth → back, logged out), and routing one without the veto put `tmp1` and
  `tmp2` on one redirect chain, which is the `tmp1`→`tmp2`→`tmp3` bug again. The second is
  L3-invisible until you cross a site: the L3 chain case was same-site (`linked.test` →
  `www.linked.test`) and stayed green while `routing.test.ts` went red in CI. Both sites now
  have an L3 case.
- **Firefox honours `windowId` on `tabs.create` even for popup windows** (FF153). Omit it
  and a `window.open` share popup is replaced in the last focused *normal* window, then
  closed with its navigation. `Tab.windowId` is required, not optional — an optional field
  is one the mock forgets to set, and coverage quietly stops.
- **A reopen KEEPS a source tab unless `hasNothingToLose` names the page it is on**
  (`supersede.ts`), cancelling only its navigation and opening beside it: session history
  doesn't span containers, so replacing it destroys what the user was looking at. What gets
  replaced is an allow-list, not a scheme test — `""` (a fresh tab can report that
  instead of `about:blank`), `about:blank`, `about:newtab`/`about:home`,
  `about:privatebrowsing`, and the choice page by prefix (it carries a fragment). Don't
  "simplify" it back to `/^https?:/`: that is what it was, and it swept CC's own options
  page in with the blanks, so a url typed into the editor's tab destroyed a half-written
  config — the textarea is not in storage until Save, and the tab is removed rather than
  kept, so there is no back button either. Keep the list complete in the other direction
  too: a fresh-tab page missing from it is kept, and a kept blank tab strands an empty one
  beside every new-tab link, which is the whole reason the replace branch exists. The two CC
  pages sit on opposite sides deliberately — the choice page is replaced, because picking a
  container *is* that page being navigated away; the options page is kept. MAC's rule
  (`mac/src/js/background/assignManager.js`, `removeTab`).
- **`port.createTab` issues a GET, so a navigation with a body is never reopened**
  (`d.method !== "GET"`, before `macOwns` and `handled.add`, so it adds no state and fails
  open). Reopening a POST drops the SAML assertion. It sits in the engine, not the
  resolver: the routing answer is right, the *effect* cannot be performed losslessly.
- **The decline is unconditional; the TOAST is not** (`namesAConfiguredContainer`). Only a
  decision naming a container the config names is announced — a `choice`, or a `reopen`
  into a `permanent`. A temporary target is declined in silence: "stayed in tmp9 instead
  of a new temporary container" names two throwaways the user can neither tell apart nor
  act on, and that is the common case — a card payment at an unmatched site where the
  3DS host posts back cross-site and staying put is what makes checkout work. Keep the two
  separate; wiring the notification into the guard makes "say less" mean "route
  differently".
- **A POST that resolves to `choice` may be unreachable outside L3** — don't try to
  reproduce it in a browser. The choice screen appears only when the tab is in none of
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
  a hand-copied duplicate of `TEST_CONFIG_YAML` in `vitest.shared.ts` (unit tests skip
  esbuild) that nothing asserts.
- **A broken stored config never falls back to the seed**: `loadConfig` returns the
  *empty* config plus the error, so everything opens in a throwaway — loud, where stale
  rules are a silent wrong answer. `parseConfig("")` is legal and means "nothing matches".
- **An unknown key is a TYPO unless the config declares a `version:` above `CONFIG_VERSION`**
  (`src/config/parse.ts`). Only then does the parser ignore keys it does not know and skip
  rules it cannot parse; a config declaring nothing is refused with the same words as
  before, and `test/config/parse.rejections.test.ts` still owns every one of them. Do not
  make that leniency unconditional to "be forgiving": `opne: X` ignored is a rule that
  auto-names a container instead of opening the one it names, which is the silent wrong
  answer this whole file exists to prevent. Leniency also stops at the rule — a
  document whose own shape is wrong (`rules: 5`, a YAML error) is still refused whole,
  because the empty config that follows sends every site to a throwaway.
  `FEATURE_VERSIONS` is the allow-list AND the price list, so a new grammar key needs a row
  there with the version it arrives in; version 2 is the two non-hostname match forms,
  which are shapes rather than keys and are priced under `matchForm`. Warnings ride
  `parseConfigDetailed` only — `loadConfig` drops them, and the options page is the one
  surface that shows them. The top level is strict too, with one escape: a key starting
  with `x-` is the user's and is ignored in silence, because a YAML anchor needs a node to
  attach to and every node this grammar defines is spoken for. Don't extend `x-` inside a
  rule — a comment already annotates a rule, and the anchor case is top-level by nature.
- **The `version:` line is DERIVED, written by Save, and a build in LENIENT mode must never
  rewrite it** (`stampVersion`, `src/config/stamp.ts`). Restamping there computes a version
  from the keys this build happens to know, strips the marker, and disarms leniency on
  every other older machine while the feature it was announcing sits in the text. The
  self-check at the end of `stampVersion` only catches the case where stripping leaves the
  document unparseable; the one where a newer version changed what an EXISTING key means is
  what the guard is for, and `test/config/stamp.test.ts` owns it. It also edits text
  rather than round-tripping through the YAML parser: this is the user's hand-written file,
  and a serialise reflows their comments, quoting and key order.
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
  handed in by `background.ts`, which builds `createConfigSync` before `wireBackground`
  so the two can reach each other without a mutable slot). It starts last in the async
  tail, being the only step that can adopt another machine's config mid-startup. Two writers
  would race the options page against the background.
- **`decodeRecord` must distinguish `incomplete` from `absent`.** `absent` means *push*,
  so reading a half-arrived record as absent publishes your older config over the update
  still landing — and the sender adopts the rollback. The integrity check is a hash, not a
  length.
- **Both convergence properties in `reconcile` fail as a loop, not a wrong answer**: equal
  text never returns `adopt` (an adoption is itself a change the other machine hears, so a
  converged pair would adopt each other's identical config forever), and the equal-stamp
  tie-break compares texts so exactly one side publishes. The tie is the *normal* first startup — pre-existing configs backfill to
  `PRE_SYNC_EDIT`.
- **The background is the pause state's ONLY writer; the options page only reads.** Arming
  by a write from the page would race the background's row-appends and lose one of the two
  writes. The page subscribes to `storage.onChanged` as a *signal* and refetches through a
  message.
- **The startup gate awaits pause hydration as well as the config.** The armed set cannot
  be read inside the blocking handler (a storage round-trip before every navigation), so
  it is read once and the session's first navigation is delayed instead. Registration
  stays synchronous; only the handler's body waits. `wireBackground` exposes that
  readiness as `ready` for the restart harness — a case that observes half-hydrated
  pause state passes for the wrong reason.
- **Saving APPLIES the config in place; it does not restart anything** (`applyStored` in
  `wiring.ts`, reached by `cc-config-apply` from the editor and called directly by
  config-sync's `adopt`). It re-reads storage through `port.readStored`, fills the one
  `config` object in place — every sibling reads it at event time, so nothing else has to be
  told — and hands the new config to the script-injector, which unregisters its previous
  registrations and registers the new set. That is why the injector holds its handles.
  Order is deliberate: the swap first, the registrations second, and a registration failure
  comes back in the reply rather than rolling the swap back. Storage is the truth and memory
  follows it; the other order leaves the two disagreeing until the browser restarts, which is
  the silent divergence this replaced.

  **Everything that touches the REGISTRATIONS goes through the one queue** (`enqueue`), not
  just `applyStored`. `scripts.apply` unregisters what the previous one registered, so two
  in flight interleave into unregister, unregister, register, register — every snippet
  registered twice and injected twice, for the life of the browser, and the first handle
  leaked with no one holding it. Three ways in, not two: a double-clicked Save, a Save
  meeting a config-sync adoption, and a Save meeting the STARTUP injection —
  `background.ts`'s tail calls `injectScripts()`, and a `cc-config-apply` message does not
  wait for the tail. That third one is reachable because a config that does not parse makes
  startup open the editor. `injectScripts` registers the config already in memory rather
  than re-reading storage, which is why it is not simply `applyStored`, and it deliberately
  does NOT swallow a registration failure the way `applyOnce` does — the tail is its only
  caller. Hence `enqueue`'s `then(work, work)`: a rejected link must not strand the queue.

  The reason it is not `runtime.reload()` any more: that is the only step of a save nothing
  can observe, and on a temporarily installed extension on 140.14.0esr it never comes
  back — the old background goes on routing by the old config while the editor says "Saved".
  `test/fitness/seams.test.ts` pins the call out of `src/`, and `test/e2e/options.test.ts`
  now observes a save on both channels. **Don't reintroduce a reload** to "make sure
  everything re-reads": nothing needs telling, and the reload is the part that fails.

  Consequence for state: `handled`, `reopenedNav`, warned hosts and the `tmpSuffix` counter
  now survive a save and die only with the browser. That is a fix (a save mid-reopen no
  longer costs an extra reopen) and a caution — `test/fitness/retained-state.test.ts` prices
  what nothing empties, and "the next save clears it" is no longer an argument.
  `highestTmpSuffix` stays: a browser restart still leaves `tmp<N>` containers behind with
  the counter at zero.
- **A throwaway is `tmp` PLUS A NUMBER, and the digits are load-bearing**
  (`isThrowawayName`, `src/resolver/types.ts`). Identity derives from the name because
  the name is all that survives a restart, so the shape must separate ours from the user's
  exactly: on the prefix alone, `open: tmpwork` — or an action-less rule for
  `tmpfiles.org`, where nobody typed a container name at all — was deleted by the
  disposer once empty, with the logins in it, and read by `toRef` as a throwaway until
  then. The other half is `config/parse` refusing a container named `tmp<N>`; keep the two
  in step, and mint only through `TMP_PREFIX + <counter>`. It lives beside `TEMPORARY` in
  the resolver rather than where it is minted because those two halves are an engine module
  and a pure parser, and the parser importing `engine/registry` to ask put that module
  in the options-page bundle for one seven-line predicate. Both import down now, and
  `test/resolver/throwaway-name.test.ts` owns the cases — under `test/resolver/` so the
  mutation gate can kill a regex widened to `/^tmp/`.
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
  snippet carries two measured facts that make the obvious rewrites wrong. Patching
  `ytInitialPlayerResponse` does nothing: the player re-derives from its own
  `/youtubei/v1/player` fetch, so the retarget landed before the player read it and German
  played anyway. And the player applies an audio-track switch, then reverts it as
  playback commits, announcing it through none of the 48 event types the page fires — so
  no one-shot design is reliable, and `video.audioTracks` reads length 0 because YouTube
  feeds audio through MSE. Hence a held invariant on a poll, which also collapses SPA
  navigation, back navigation and the revert into one case. Full notes:
  `docs/superpowers/specs/2026-07-31-youtube-original-audio-design.md` §2.

## What a green test run can still hide

- **`test/fitness/` pins the properties that make every other gate mean something.** Its
  rules are not a normal test's. An exact inventory, never a bound (`toEqual([...])`,
  not "at most two"): a bound absorbs the next violation in silence, an inventory makes
  whoever adds one write down why. Match on stripped comments and identify by file,
  not line — this codebase names the very APIs it avoids calling, and pinned lines fail
  on every edit above them; a check that cries wolf is deleted and takes its invariant
  with it. The subject is `src/` as text: importing the modules would answer a
  question about what the bundler resolves. `decision-cost.test.ts` measures rather than
  inspects, and counts port round trips, never milliseconds — wall clock in CI is a
  flake generator.
- **`npm test` shuffles the FILE order, and that is not noise to be pinned away**
  (`sequence.shuffle: { files: true, tests: false }`, `vitest.config.ts`). Order dependence
  and time dependence fail differently: a case that leans on state an earlier file left
  behind fails identically every run, so `npm run test:flake` files it under "red, not
  flaky" and its comparison never sees it. A shuffled order is the only thing that turns it
  into a disagreement. Files, never tests — a file's cases share one browser session and
  some are deliberately a sequence (choice.test.ts picks a container, then asserts the pick
  was not remembered), so shuffling those breaks by design rather than by fault. A failure
  is reproducible: vitest prints `Running tests with seed N`, and `--sequence.seed=N`
  replays it. Keep it off the mutation config — Stryker decides each mutant from one run,
  and `stryker.config.mjs` names `vitest.mutation.config.ts` precisely so that run inherits
  nothing that varies.
- **Revert-verify every regression test — back the fix out, watch it go red, restore it**
  (editor undo, not `git checkout`, which discards uncommitted work). This suite
  shipped false greens twice: three e2e tests passed with auto-temp entirely broken, and
  L3 tests once asserted the bug.
- **The coverage gate is at 100% and the thresholds ARE 100** (`npm run test:coverage`,
  every push; `vitest.coverage.config.ts`). It runs L1–L3 only — an e2e drives a packaged
  extension in another process and contributes nothing here — over `src/**` minus the three
  files no deterministic level can reach. A number that is also the floor means new code
  nothing reaches fails on the push that writes it, and there are exactly two honest ways
  to answer a red one: write the case, or, where the code cannot be reached from a
  measured run at all, mark it at the line with `/* v8 ignore … -- why */` as
  `matcher.ts`, `load.ts` and `browser-port.ts`'s two echoes do. Never lower a threshold
  — the same rule the mutation gate has, for the same reason. Third possibility worth
  checking first: an unreachable line is often a dead defence and the fix is deleting
  it. Two were, reaching 100 — a `?? []` over a key taken from that same map, and
  `createEngine`'s own tmp-suffix counter, which no production caller has ever used
  because auto-temp and the engine must share one (a second counter mints a colliding
  `tmp1`, and identity is derived from the name). `EngineOptions.tmpSuffix` is required
  now; keep it that way.
- **The mutation gate is at 100% and `npm test` does not run it** (`npm run test:mutation`,
  nightly). It mutates only the pure modules — `resolver`, `matcher`, `psl`, `config`,
  `overlays` — and lets only the tests that own each of them kill the mutants
  (`test/{resolver,matcher,psl,config,overlays}`), so a new branch in `resolve`/`matcher`/
  `same-site`/`parse` needs a case in *that module's* suite; an L3 engine case that covers
  it leaves the gate red. The parser's error messages and `path`s are inside the gate:
  `test/config/parse.rejections.test.ts` pins one row per rejection, so rewording a
  diagnostic without updating it is a failure, not a silent drift. A survivor is killed or named
  (`// Stryker disable … : why`), never absorbed by lowering the threshold. Two settings
  in `stryker.config.mjs` fail as `stryker run` dying at startup rather than as a bad
  score: `tsconfigFile: "none"` (its rewriter calls `ts.parseConfigFileTextToJson`, which
  TypeScript 7 no longer exports) and `vitest.related: false` (Vitest 4 answers "no
  related test files", so the dry run finds no tests). The run also pins fast-check's seed
  — fresh samples make each mutant's verdict a coin flip — via a setup file `npm test`
  deliberately does not load.
- **`test/engine/mock-port.ts` fidelity is where "L3 green, Firefox broken" comes from.**
  It fires `onTabCreated` from `createTab`, fires `onTabRemoved` from `removeTab` (Firefox
  doesn't care who closed the tab — while it didn't, a tab CC itself closed was invisible
  to the disposer), throws on privileged `about:` urls, and keeps listeners in a list
  per event, not a slot. `addListener` is additive in Firefox, and while the mock
  modelled "last registration wins" the two events `wireBackground` registers twice
  (`onTabRemoved`: pause then the disposer; `onTabUpdated`: auto-temp then the
  redirector-closer) had their first listener silently dropped, so pause's disarm-on-empty
  and auto-temp's `onTabUpdated` path were unwired in every composed-background case. Never
  relax these. `getCookie` carries one more: a `setCookie` that SUCCEEDS does not mean the
  next get answers, because the seeder sets with the spec's own https url and then asks
  with the navigation's — Firefox hands no Secure cookie to an http one, and a mock that
  always answered read that as "already on the wire" and spliced a header the browser
  would never have sent. The arranged failures (`tabCreationFails`, `tabRemovalFails`,
  `storageWritesFail`, `notificationsFail`, `tabLookupFails`) are each a real Firefox
  rejection, and what they reach is a floated promise's `catch`: an unarranged one is an
  unhandled rejection in the background context rather than a missing feature.

  **What it does NOT model is latency, and that can make a case pass for the wrong reason.**
  Everything here resolves on the microtask queue, so two async paths interleave in whatever
  fixed order their await counts give them: `applyOnce` awaits `readStored` before touching
  the registrations and `injectScripts` does not, so the injection always won and a case
  written on that timing passed with the serialisation removed. Firefox makes no such
  promise — these are IPC round trips. `stallScriptRegistration()` holds registration open
  so a case can put both callers past their unregister at once and STATE the interleaving it
  is about. Reach for it whenever a case is about two things overlapping.
- **`test/engine/restart.ts` retires a dead session TWICE — `aSessionClock` for its
  timers, `aSessionPort` for its listeners** — because `mock-port` is additive like
  Firefox, so re-wiring *adds* handlers rather than replacing them. Without the clock
  facade the old disposer re-arms its GC through a closure holding a live port; without
  the port facade every one of the previous session's siblings keeps running. Either way
  the harness reports state surviving a restart that never happened. Restart from a
  settled state: async work in flight is unmodelled.

## `tcp/` and `mac/`

Read-only upstream reference (we re-implement both): TCP's `cleanup.ts` shaped the
disposer, its `getAssignment` handshake the F7 defer. **Both are gitignored and absent
from a fresh clone, and `mac/` is a test prerequisite** — `harness/firefox.ts` builds
MAC's xpi from `mac/src` unbuilt, and `mac-interop.test.ts` fails rather than skips
without it (a bare ENOENT), so a first `npm test` on a new machine reports a broken case
that is only a missing checkout. Clone `mozilla/multi-account-containers` into `mac/` as
CI does. Cite both by file and symbol, never line number — they track upstream.
