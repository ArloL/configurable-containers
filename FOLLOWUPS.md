# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry once it is
resolved.

## Firefox 155 routes per-site associations itself, and CC has not been measured against it (2026-09-23)

Bug 2052136 (fixed in 155) added `contextualIdentities.setSiteAssociation` and a Settings
dialog for it; Firefox then picks the container for a top-level navigation natively
(`ContextualIdentityService.containerForNavigation`). MAC 8.4 mirrors its assignments into
it both ways (`mac/src/js/background/siteAssociation.js`). `macOwns` in `engine.ts` asks MAC
only, so on 155+ without MAC a native association owns the URL and CC never learns of it —
whether the two then fight over the tab is unknown. ESR 140 has no such API.

Re-measure on `latest`: probe plus CC, no MAC; `setSiteAssociation({ site: "nomatch.example",
cookieStoreId: "firefox-container-1" })`; navigate to `http://nomatch.example/` on port 80
(a port-qualified site matches nothing); record which container the tab ends in and whether
it is reopened. If they fight, F7 grows a second owner to defer to.

## CI's `latest-esr` leg is about to leave the 140 floor (2026-09-23)

`FIREFOX_ESR_NEXT` is 153.3.0esr and 140 ESR reaches end of life around 2026-09-29. When
`firefox-esr-latest-ssl` (what CI's `latest-esr` and `get-firefox.sh` fetch) resolves to
153, the floor of 140 becomes a version no leg runs — which `firefox-floor.test.ts` gives as
the reason not to declare a floor below what CI measures — and TESTING.md's "ESR is the
only channel exercising that path" (`onCreated` seeing `about:blank` first) goes false:
153 answers `tabs.create({})` with `about:newtab`, like release.

Measured 2026-09-23 on 153.3.0esr: `routing`, `privileged-protocol` and `view-source` pass.
Once `FIREFOX_ESR` in <https://product-details.mozilla.org/1.0/firefox_versions.json> is
153.x, run the full suite on it, then decide: raise the floor to 153, or pin a leg to the
last 140 ESR.

## `vitest` is held at 4 so the mutation gate can measure (2026-09-21)

`@stryker-mutator/vitest-runner@10` narrows a mutant's run to its covering tests by
writing a regex into `testNamePattern`, built from the suite chain and the test name
joined with a single space. Vitest 4 matched that against `getTaskFullName(task)`, built
the same way; vitest 5 matches it against the precomputed `task.fullTestName`, which
`createTaskName()` joins with `" > "`. Nothing matches, so no test runs against a mutant,
and a mutant no test ran is reported as SURVIVED. The nightly said 769 survivors across
five modules on vitest 5 and 0 — 100.00%, 1172 killed — on vitest 4, same suite, same
commit. `coverageAnalysis: "all"` is not a way out: measured at the same 769, because
Stryker builds the filter either way.

Upstream is <https://github.com/stryker-mutator/stryker-js/issues/6210>, fix proposed in
PR #6214. When a `@stryker-mutator/vitest-runner` release carries it: drop the
`packageRules` entry in `renovate.json5`, take `vitest` and `@vitest/coverage-v8` to 5,
restore the two-parameter `Matchers` declaration in `harness/browser/matchers.ts` (the
comment there says what 5 wants), delete `test/fitness/mutation-gate.test.ts`, and check
`npm run test:mutation` still ends at 100.00% — that run is the whole point of the pin,
and it is the one thing a green `npm test` does not tell you.

## `package.json` has dependency overrides (2026-09-17)

Each override's reason and removal condition live in `overridesComments` in `package.json`,
keyed like `overrides`. Re-check them when bumping the packages they name.

## The live `Config` object mutates under four siblings, and no type says so (2026-08-29)

`wireBackground` creates one `Config` and fills it in place with `Object.assign` inside
`useConfig`; four siblings hold a reference — `engine`, `picker`, `cookie-seeder` and
`redirector-closer`. The invariant every one of them depends on —
*this object mutates under you; read it at event time, never at construction* — appears in
no type. `CookieSeederOptions { config: Config }` is indistinguishable from a signature
taking a snapshot, so a fifth sibling written the idiomatic way (`const { rules } =
config`) would freeze on the empty config forever, and nothing would catch it: not the
compiler, not the coverage gate, and not an L3 case, since the composed-background tests
apply a config before navigating.

Half the failure mode is already closed and closed well — `useConfig` spells out
`{ rules, groups }` as a `Required<Config>`, so a key added to `Config` later fails to
compile rather than silently retaining what the previous config left.

**Left open deliberately, on the 2026-08-29 modularity review's own recommendation.** The
distance is minimal — one construction site, one mutation site, the same file — so the high
strength here is cohesion rather than coupling, and the bug has never happened. The fix is
known and small: hand siblings a `getConfig(): Config` accessor instead of a `config: Config`
reference, since a function cannot be destructured into a stale snapshot.
`script-injector`'s existing `apply(config)` already demonstrates the shape from the other
direction.

Take it when the next sibling holding a `config` reference is written — the FIFTH — not
before. **That trigger is now mechanical**: `test/fitness/live-config.test.ts` pins the four
holders as an exact list, so the fifth cannot be added without someone coming here, reading
why the object mutates under it, and writing the row. It also pins the two halves that make
the rule work — `script-injector` reaching the config as an `apply(config)` argument rather
than a field, and `useConfig` FILLING the object rather than replacing it.

Two things priced on 2026-08-30, which is why the accessor did not come with that check:

- **It is weaker than "unstatable-wrongly".** `const config = getConfig()` at the top of a
  factory snapshots exactly as dead as `const { rules } = config` does. What the accessor
  removes is the destructure — the idiomatic spelling — not the mistake itself.
- **It is not four modules of churn.** The four sources are five read sites, but the option
  is spelled at 114 construction sites across seven test files, ~107 of them passing
  `config`, each an inline one-line literal (`createEngine({ port, config: workConfig(), … })`).
  Every one becomes two lines, since `getConfig: () => workConfig()` would build a fresh
  config per read instead of sharing one.

So the entry stays open on a smaller claim than it started with: the accessor is worth
taking when a fifth sibling makes someone open these modules anyway, and is not worth a
110-site diff before then.

The count was wrong here until 2026-08-30, and the shape of the mistake is worth keeping:
`grep -rn "config: Config" src/engine src/extension/wiring.ts` answers with six FILES, two
of which hold nothing — `script-injector` takes the config as an `apply(config)` argument
(the review's own named exception, the contract form this entry wants) and `wiring.ts` is
the owner. Stated as an ordinal, "the seventh sibling" was a trigger nobody could recognise:
anyone checking it counts four and concludes it has not arrived. The 2026-08-29 modularity
review says six for the same reason; it is a dated record and is left as it stands.

## `reopenedNav` does not survive a background restart (2026-07-28)

The F1 reopen guard (`src/engine/engine.ts`) is the one piece of guard state nothing can
rebuild, and `test/engine/restart.test.ts` pins the price rather than fixing it. The
window runs from `port.createTab` to the reopened tab's first request; a restart inside it
costs **one** extra reopen, converges (the fresh engine guards the reopen it performs),
and leaks no container — the abandoned throwaway is disposed on the grace.

It is not reconstructible because a reopened pre-commit tab and a middle-clicked one are
both `about:blank` in a real container, and the middle-clicked one must still be isolated
into a throwaway of its own. The requestId in `reopenedNav` is the only thing separating
them.

**Priced against the seam, 2026-07-28, and the answer is still no.** The disposer's grace
fix built `readStored`/`writeStored` on `BrowserPort`, so the seam exists and the
implementation would be cheap: hydrate the map at startup, write through on each reopen,
and extend the `configReady` gate to await the hydration (reading storage inside the
blocking handler is not an option — that is every navigation's latency). Two things argue
against it:

- **The window coincides with peak activity, not idleness.** It runs while the extension
  has just handled a blocking request and is mid-reopen. Firefox suspends an event page
  when it is *idle*, so the involuntary-suspension frequency that justified revisiting
  this is much lower than the MV2-vs-MV3 framing suggested. Lower still than that sentence
  says, on what CC actually ships: `extensions/cc/manifest.json` declares `background.scripts`
  with no `persistent` key, and MV2 defaults it to `true`, so this is a persistent background
  page and Firefox does not idle-suspend it at all. The bullet is an argument about the MV3
  world, not this one — every restart CC sees today is a browser restart, an update, a
  disable/enable or a crash.
- **Persisting it adds a worse failure than the one it removes.** Entries are keyed by tab
  id, and tab ids restart with the browser, so a stale entry — the reopened tab's request
  never arrived, load aborted, tab closed — could be claimed by an unrelated later tab of
  the same id. That is the mis-absorption the in-memory version had to be taught to avoid,
  and its cost is a navigation loading **unrouted inside a permanent container** (F11 by
  way of F1). A TTL bounds it, but the trade is then a silent wrong-container risk against
  one wasted reopen that converges and leaks nothing.

Revisit only if dogfooding shows the wasted reopen actually happening — it is visible as a
`tmp` container created and abandoned in the same second.

Harness gap while here: `test/engine/restart.ts` does not model async work already in
flight at the restart (a floated `containerize` mid-`await`). Firefox kills it; the
harness lets it land. Every current case drives the restart from a settled state, so a
future case that needs it has to close this first.

## Replaying a declined POST into the target container (2026-07-28)

A navigation carrying a body is declined rather than reopened, because `tabs.create`
issues a GET and would drop the body. **Replaying** it — a generated auto-submitting form
page in the target container — is the only option that would actually route the assertion,
and neither Temporary Containers nor Multi-Account Containers attempts it. It needs the
`requestBody` webRequest opt-in, urlencoded and multipart handling, and a `moz-extension:`
page forging a cross-origin POST. See
`docs/superpowers/specs/2026-07-28-f9-redirect-binding-design.md` §1.

The decline is deliberately shaped so this stays a change to *how the engine executes an
unchanged decision*: `resolve()` still answers `reopen`, and only the engine's ability to
carry it out is in question.
