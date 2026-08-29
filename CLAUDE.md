# CLAUDE.md — Configurable Containers

A Firefox WebExtension that routes each site into the right container from one user config.

Covered elsewhere: `README.md` (goals, build, release), `CONFIG.md` (config format),
`TESTING.md` (the L1–L5 pyramid, the F1–F14 bug matrix), `test/` (the behaviour spec),
`docs/superpowers/`, `FOLLOWUPS.md`, `docs/drift-reviews.md` (the agent reviews for what no
gate can see — a true statement that stopped being true, which every check here is blind to
because `test/fitness/` reads source with comments stripped).
Why a function is shaped the way it is lives in its own comment. This file carries only
**platform and tooling facts that make a reasonable-looking change wrong**.

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

  `patternForUrl` is the same question backwards — the pattern for one observed URL, which
  the pause record hands the user to paste — and it carries the same "must not widen"
  duty: `*://` because HSTS rewrites the scheme before webRequest sees it, no port
  (a pattern's host cannot carry one), a trailing `*` because a path is anchored at both
  ends and every OAuth entry point has a query, and the query itself **dropped** rather
  than pasted, since a record written during a checkout must not carry the token. It
  answers `null` where no pattern exists (an IPv6 literal) rather than a string the config
  editor would then reject.

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
  design. `port.ts` also owns the Firefox **values** the engine's siblings would otherwise
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

  **Its recordings are the ONE thing CC keeps that outlives the browser**, so they are the
  one place a cap is not optional. Everything else here dies with the background context;
  the pause state is in `storage.local`, and `record()` appends a row per distinct host and
  `persist()`s the whole state on each new one. A container armed and forgotten therefore
  grew a stored array, and wrote it from the blocking path, for as long as browsing
  continued. `MAX_RECORDED_HOSTS` bounds both — and the hosts past it are **counted into
  `Recording.dropped`**, not dropped in silence: rules are written from that list, and one a
  reader takes for the whole flow while it quietly is not is the same silent wrong answer a
  half-parsed config would be. `dropped` is optional in **`StoredRecording`** and required in
  `Recording`, which is the split below: a recording stored before the cap has no such key
  and refusing it on hydrate would throw the user's history away, but by the time the
  blocking handler increments it the normalizer has filled it in.

  **A row is one per URL as well as one per host** (`RecordedHost.urls`, the pattern
  `patternForUrl` built), which is what makes a rule for a GitHub OAuth hand-off writable
  from a record at all — and what makes the second cap
  (`MAX_RECORDED_URLS_PER_HOST`, counted into the host row's own `dropped`) not optional
  either: a URL row grows with **browsing**, not with the handful of hops a flow makes.
  A host whose URLs did not all resolve the same way says `VARIED` rather than picking one,
  because with path matching `github.com` genuinely has two answers and a row claiming
  either sends the reader to write the rule that breaks the sign-in.

  Hydration therefore **normalizes rather than validates** (`readRecording`/`readHost`/
  `readUrl`, which replaced the `isRecording` type guard). A host row written before URL
  detail has no `urls`, and a build that trusted the stored shape would call `.find` on
  `undefined` **inside the blocking handler**, where a throw is a navigation that never
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
  `cookieStoreId` does **not** cross to the page (it has no use for a store id), and
  `record()` says `open.dropped++` rather than `(open.dropped ?? 0) + 1` inside
  `onBeforeRequest`. `PAUSE_STORAGE_KEY` moved to `pause-protocol.ts` for the same reason:
  the page names it to subscribe to `storage.onChanged` as a signal, and a key two realms
  agree on is protocol, not a private detail one of them borrows. So **`options.ts` imports
  nothing from `src/engine/`** and `test/fitness/seams.test.ts` pins that the engine's only
  reach into `src/extension` is a protocol module.
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
  so exact matching bought a throwaway per upgrade. All three have revert-verified L3 tests.

  The site and the requestId answer different halves of a hop, and **neither one alone is the
  guard**. A hop that stays on the awaited site is absorbed outright. A hop that LEAVES it is
  resolved like any navigation — with the tab's real container and the awaited url standing in
  for the `about:blank` it reads as, so a hop within one rule (`github.com` → `github.dev`) is
  answered "already contained" rather than reopened into the container it is in — and then
  `aHopBuysNoThrowaway` vetoes any answer that is only another throwaway. Both halves are
  required and each is pinned by the case it exists for: absorbing a cross-site hop outright
  left every SSO **return** hop unrouted in the identity provider's container (sonarcloud.io →
  github.com/login/oauth → back, logged out), and routing one without the veto put `tmp1` **and**
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
  replaced is an **allow-list, not a scheme test** — `""` (a fresh tab can report that
  instead of `about:blank`), `about:blank`, `about:newtab`/`about:home`,
  `about:privatebrowsing`, and the choice page by prefix (it carries a fragment). Don't
  "simplify" it back to `/^https?:/`: that is what it was, and it swept **CC's own options
  page** in with the blanks, so a url typed into the editor's tab destroyed a half-written
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
- **An unknown key is a TYPO unless the config declares a `version:` above `CONFIG_VERSION`**
  (`src/config/parse.ts`). Only then does the parser ignore keys it does not know and skip
  rules it cannot parse; a config declaring nothing is refused with the same words as
  before, and `test/config/parse.rejections.test.ts` still owns every one of them. Do not
  make that leniency unconditional to "be forgiving": `opne: X` ignored is a rule that
  auto-names a container instead of opening the one it names, which is the silent wrong
  answer this whole file exists to prevent. Leniency also **stops at the rule** — a
  document whose own shape is wrong (`rules: 5`, a YAML error) is still refused whole,
  because the empty config that follows sends every site to a throwaway.
  `FEATURE_VERSIONS` is the allow-list AND the price list, so a new grammar key needs a row
  there with the version it arrives in; version 2 is the two non-hostname match forms,
  which are shapes rather than keys and are priced under `matchForm`. Warnings ride
  `parseConfigDetailed` only — `loadConfig` drops them, and the options page is the one
  surface that shows them. The **top level is strict too**, with one escape: a key starting
  with `x-` is the user's and is ignored in silence, because a YAML anchor needs a node to
  attach to and every node this grammar defines is spoken for. Don't extend `x-` inside a
  rule — a comment already annotates a rule, and the anchor case is top-level by nature.
- **The `version:` line is DERIVED, written by Save, and a build in LENIENT mode must never
  rewrite it** (`stampVersion`, `src/config/stamp.ts`). Restamping there computes a version
  from the keys this build happens to know, strips the marker, and disarms leniency on
  every other older machine while the feature it was announcing sits in the text. The
  self-check at the end of `stampVersion` only catches the case where stripping leaves the
  document unparseable; the one where a newer version changed what an EXISTING key means is
  what the guard is for, and `test/config/stamp.test.ts` owns it. It also edits **text**
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
  (`isThrowawayName`, **`src/resolver/types.ts`**). Identity derives from the name because
  the name is all that survives a restart, so the shape must separate ours from the user's
  exactly: on the prefix alone, `open: tmpwork` — or an action-less rule for
  `tmpfiles.org`, where nobody typed a container name at all — was **deleted by the
  disposer once empty**, with the logins in it, and read by `toRef` as a throwaway until
  then. The other half is `config/parse` refusing a container named `tmp<N>`; keep the two
  in step, and mint only through `TMP_PREFIX + <counter>`. It lives beside `TEMPORARY` in
  the resolver rather than where it is minted because those two halves are an engine module
  and a **pure parser**, and the parser importing `engine/registry` to ask put that module
  in the **options-page bundle** for one seven-line predicate. Both import down now, and
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
  snippet carries two measured facts that make the obvious rewrites wrong. **Patching
  `ytInitialPlayerResponse` does nothing**: the player re-derives from its own
  `/youtubei/v1/player` fetch, so the retarget landed before the player read it and German
  played anyway. And **the player applies an audio-track switch, then reverts it** as
  playback commits, announcing it through none of the 48 event types the page fires — so
  no one-shot design is reliable, and `video.audioTracks` reads length 0 because YouTube
  feeds audio through MSE. Hence a held invariant on a poll, which also collapses SPA
  navigation, back navigation and the revert into one case. Full notes:
  `docs/superpowers/specs/2026-07-31-youtube-original-audio-design.md` §2.

## Static analysis: three gates, and why the obvious linter is not one

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
- **A SonarCloud finding is answered in `sonar-project.properties`, never in the web UI.**
  Resolving one as "won't fix" there is what the service invites and it loses the only part
  worth keeping: the reasoning, where a reviewer would see it, in a project that can be
  recreated. Suppression is per rule and path
  (`sonar.issue.ignore.multicriteria.<id>.{ruleKey,resourceKey}`), and each id in that file
  carries the comment saying why. Unlike zizmor — which has **no** suppressions on purpose —
  a few of these rules are simply wrong about this code, and one of them is wrong in the
  direction that matters: **`S2871` asks for `localeCompare` behind the `.sort()` in
  `scripts/package.ts`, and taking that advice breaks reproducible builds**, since that sort
  is what makes the xpi's entry order the same on every machine and collation is not. The
  other two are `S4036` (absolute paths for `git`/`gh`/`npm`/`curl` in dev scripts) and
  `S5332` (the `"http://" + hostish + "/"` in `bareHost`, which parses a string and fetches
  nothing). Everything else gets fixed.
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
- **`npm test` shuffles the FILE order, and that is not noise to be pinned away**
  (`sequence.shuffle: { files: true, tests: false }`, `vitest.config.ts`). Order dependence
  and time dependence fail differently: a case that leans on state an earlier file left
  behind fails identically every run, so `npm run test:flake` files it under "red, not
  flaky" and its comparison never sees it. A shuffled order is the only thing that turns it
  into a disagreement. **Files, never tests** — a file's cases share one browser session and
  some are deliberately a sequence (choice.test.ts picks a container, then asserts the pick
  was not remembered), so shuffling those breaks by design rather than by fault. A failure
  is reproducible: vitest prints `Running tests with seed N`, and `--sequence.seed=N`
  replays it. Keep it off the mutation config — Stryker decides each mutant from one run,
  and `stryker.config.mjs` names `vitest.mutation.config.ts` precisely so that run inherits
  nothing that varies.
- **Revert-verify every regression test — back the fix out, watch it go red, restore it**
  (editor undo, **not** `git checkout`, which discards uncommitted work). This suite
  shipped false greens twice: three e2e tests passed with auto-temp entirely broken, and
  L3 tests once asserted the bug.
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
- **The coverage gate is at 100% and the thresholds ARE 100** (`npm run test:coverage`,
  every push; `vitest.coverage.config.ts`). It runs L1–L3 only — an e2e drives a packaged
  extension in another process and contributes nothing here — over `src/**` minus the three
  files no deterministic level can reach. A number that is also the floor means new code
  nothing reaches fails on the push that writes it, and there are exactly two honest ways
  to answer a red one: write the case, or, where the code cannot be reached from a
  measured run at all, mark it **at the line** with `/* v8 ignore … -- why */` as
  `matcher.ts`, `load.ts` and `browser-port.ts`'s two echoes do. Never lower a threshold
  — the same rule the mutation gate has, for the same reason. Third possibility worth
  checking first: an unreachable line is often a **dead defence** and the fix is deleting
  it. Two were, reaching 100 — a `?? []` over a key taken from that same map, and
  `createEngine`'s own tmp-suffix counter, which no production caller has ever used
  because auto-temp and the engine must share one (a second counter mints a colliding
  `tmp1`, and identity is derived from the name). `EngineOptions.tmpSuffix` is required
  now; keep it that way.
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
  holding**, which is not what vitest does on its own: it inverts `pass` and nothing else,
  so a matcher that always waited for its condition would mean the opposite of itself under
  negation — `not.toHaveValue("")` polling until the field IS empty, then calling that a
  failure. `settle` takes the matcher context for this and nothing else. It also **waits for the
  element, not only for what it says**: the reader is given a zero budget because the waiting
  is the matcher's job, so a `PollTimeoutError` out of it means "not in the document yet" and
  is retried — reading it as a verdict is what made `#cc-sync` fail one full run in ten. An
  element that never appears fails in BOTH directions, or `.not` passes for a page that
  rendered nothing — and that promise belongs to the **reader**, not to `settle`: it holds
  for the matchers whose reader raises `PollTimeoutError` on an unresolvable element.
  `toBeVisible` and `toHaveCount` are deliberately outside it, reading a missing element as
  `false` and `0`, which is Playwright's behaviour and what `.not.toBeVisible()` and
  `toHaveCount(0)` are asking for. **`toBeEnabled` was outside it by accident** —
  `isEnabled()` answers `false` for an element that is not there, so "disabled" and "never
  rendered" arrived as one reading and `.not.toBeEnabled()` passed on an empty document. It
  asks `Locator.enabledState()` now, which answers `null` for the third case. Backing it out
  costs the full timeout on every negated assertion that is already satisfied (61.8s of
  `options.test.ts`, measured) and turns the pre-hydration race it guards into a hard
  failure. `test/fitness/e2e-discipline.test.ts` pins the rest of this bullet — no `driver`,
  no sleep, no read-then-compare, no deadline loop — each rule carrying an exact list of the
  files that are allowed to break it and why, because the migration that established the
  rules left a file breaking every one of them, and said in its own commit message that it
  had not. **Read-then-compare matches BOTH forms**: assigning the reading first
  (`const value = await …inputValue()`) evaded it entirely until 2026-08-26, and two files
  were doing that — both defensibly, which is the point, since an exception no check can see
  is a hole rather than an exception. It reads one line at a time, so a read split across two
  still evades it.

  **A window handle is a SNAPSHOT, and the extension closes tabs on its own schedule**, so
  anchoring on one — `newPage` before it can open a tab, `close` re-attaching after — is a
  poll over the list rather than a switch to its head. `getAllWindowHandles` names a tab, the
  auto-temp startup sweep replaces it, and the switch raises `NoSuchWindowError` on line one
  of a case whose own comment says nothing has to be re-anchored for it. Measured by
  `npm run test:flake`: one run in three, and never locally. Retry by re-READING the list —
  retrying the same dead handle spins — and let `close` give up in silence, since every Page
  operation switches to its own handle first.

  **That rule reaches `describe` and `pageAt` too, and it reaches them differently.**
  `describe` is what a poll's timeout prints, and `diagnose` catches its throw and answers
  *"could not be described"* — so an unguarded walk made the report vanish exactly when the
  tabs were churning, which is when a timeout happens and when its tab list is worth having.
  It now gathers in two independent halves, the TAB LIST FIRST because that half survives
  this page's own tab being closed, and the tab a poll was waiting on is the likeliest one
  to have gone: `PageReport.url` is `null` then, `tabs` carries `GONE` where a handle would
  not answer, and only a browser that will not list its windows at all still throws.
  `pageAt`, by contrast, must NOT swallow everything — `retry.ts` is explicit that a driver
  which has died is not something to wait out, and a bare `catch { continue }` there polled
  a dead session for the full budget and then reported it as "no page at &lt;url&gt;". It
  distinguishes `isRetryable` as `newPage` does. `close` keeps its bare catch on purpose:
  it returns nothing, its re-attach is a courtesy, and the next real command reports a dead
  driver anyway.

  Three things a new case gets wrong otherwise. **A textarea's content is its VALUE** —
  `toHaveValue(/…/)`, not `toContainText`, which reads `innerText` and sees `""`.
  **`page.close()` and `session.newPage()` re-anchor the driver** on a surviving window,
  because closing the active tab — or the extension discarding it, as the auto-temp sweep
  does — otherwise leaves the next command *anywhere later in the file* failing with
  `NoSuchWindow`. And **a timeout names what it waited for, the page's url, the ids present
  and the tab list**, which is the report `NoSuchElementError: *[id="cc-sync"]` was not.

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
- **`test/engine/mock-port.ts` fidelity is where "L3 green, Firefox broken" comes from.**
  It fires `onTabCreated` from `createTab`, fires `onTabRemoved` from `removeTab` (Firefox
  doesn't care who closed the tab — while it didn't, a tab CC itself closed was invisible
  to the disposer), throws on privileged `about:` urls, and keeps listeners in a **list
  per event, not a slot**. `addListener` is additive in Firefox, and while the mock
  modelled "last registration wins" the two events `wireBackground` registers twice
  (`onTabRemoved`: pause then the disposer; `onTabUpdated`: auto-temp then the
  redirector-closer) had their first listener silently dropped, so pause's disarm-on-empty
  and auto-temp's bug-1586612 path were unwired in every composed-background case. Never
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
  page and is the tripwire for the next widening. Measured 2026-08-25 on **154.0**:
  `executeScript` on that page still WORKS, so the refusal is 156.0a1's and has not reached
  release — the avoidance is about where release is going, not where it is. **Don't reach for the flag**: it re-grants privileged access to the
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

## Release and AMO facts that look like bugs

- **`npm run sign:dev` and `npm run submit` UPLOAD.** The credential guard is not a
  dry-run switch, and `npm` under mise carries AMO credentials even when a plain shell
  shows them unset. `sign:dev` takes its version from `VERSION`; to exercise only the
  build half, call `packageExtension` with the dev id. Both now also require
  `BUILD_TIMESTAMP`, because the reviewer notes they upload name it.
- **The AMO listing is PUSHED BY THE UPLOAD, so editing it in the Developer Hub is undone
  by the next release.** The copy is `amo/{summary.txt,description.md,reviewer-notes.txt}`;
  `scripts/amo-metadata.ts` fills its `{{version}}`/`{{timestamp}}`/`{{package_args}}`
  placeholders and both upload paths pass the result to `web-ext sign --amo-metadata`.
  Three things a change here gets wrong. **Both channels get the same copy, and the dev
  one is not decoration** — an unlisted add-on displays none of it, so the dev add-on's
  Developer Hub page is the only place the copy can be read BEFORE a listed release makes
  it public, and every push to main refreshes it. The cost is that a field AMO rejects
  fails `sign:dev` on **every push to main**, not on a release someone is watching, which
  is why the validation is in `buildAmoMetadata` rather than left to the API.
  **`name`, `categories` and `license` are never sent**: they are mandatory at add-on
  *creation* rather than per version, so a wrong value is a rejected upload rather than a
  bad paragraph. And an **unknown `{{…}}` throws** rather than shipping the braces — the
  hand-pasted notes this replaced told a reviewer to rebuild at `<version>` with
  `BUILD_TIMESTAMP=<value>`, which nobody substituted and which no checksum could match.

  Because that upload happens on **every push to main**, prose in `amo/` that has gone
  stale is drift that gets PUBLISHED rather than merely sitting in the repo. Two claims in
  `reviewer-notes.txt` are therefore pinned by `test/extension/amo-metadata.test.ts`
  against what they describe. **The PERMISSIONS bullets are an exact set against
  `extensions/cc/manifest.json`** — `test/fitness/manifest.test.ts` already stops a
  permission arriving without a caller, but nothing stopped one arriving without an
  explanation, and `webNavigation` and `notifications` had both done exactly that. It is
  exact in the other direction too: a bullet outliving its permission tells a reviewer the
  add-on asks for something it does not. The parser reads the `- <names> — <why>` heads of
  the section under the bare `PERMISSIONS` heading, and **throws** when that heading or a
  bullet's em dash is missing, because a parser that quietly found nothing would compare
  two empty sets and pass. **And the Node version is the one the workflows really set** —
  the notes said "Needs Node 22+" while every workflow said 24, `package.json` declares no
  `engines`, and the whole point of that paragraph is a reviewer reproducing the checksum.
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
