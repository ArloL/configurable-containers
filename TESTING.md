# Testing strategy

How we keep the resolution engine correct — with the emphasis on the **subtle,
silent** bugs, not the obvious ones. This is a routing engine sitting on top of
Firefox's container + `webRequest` machinery; the dangerous failures here don't
throw, they mis-route a tab or churn a container while everything looks fine.

The test suite itself is the behaviour spec — each test named for what it pins,
its body written to read as that behaviour. This document is how those tests (and
the invariants underneath them) are *organised*.

## What "subtle bug" means in this project

Concrete failure classes, drawn from the model and from reading the Temporary
Containers source (whose `canceledTabs` / `cleanRequests` machinery exists *only*
to prevent these):

| # | Failure class | Why it's silent |
|---|---------------|-----------------|
| F1 | **Reopen loop / double-tab-open** — the engine reopens a nav, which triggers another reopen. | No error; user sees a flicker or two tabs, or a runaway. |
| F2 | **"Already correctly contained" not honoured** — reopening a tab already in its target container. | Churn; fights MAC; loses tab state. |
| F3 | **Same-site continuity misfire** — spawning a new temp on same-domain nav, or *keeping* one across a real site boundary. | Cookie leak (kept too long) or lost session (churned). |
| F4 | **Group membership resolved by routing, not by target URL** — the age-gate chain. | Login silently dropped on the redirect back. |
| F5 | **Precedence error** — wrong first-match in `rules` or `groups`; cross-list shadowing that shouldn't exist. | Site lands in the wrong container; looks plausible. |
| F6 | **`inherit` routes or isolates** instead of staying put. | Breaks SSO, or leaks identity across a boundary. |
| F7 | **Race** — `onBeforeRequest` vs `onBeforeNavigate` vs MAC ("mac was probably faster"). | Nondeterministic; passes locally, fails in the wild. |
| F8 | **MV3 background restart mid-flow** — in-memory guard state (canceled requests, pending reopens) lost when the service worker is killed. | Reintroduces F1/F2 only under memory pressure. |
| F9 | **Redirect-binding breakage** — reopen turns a SAML `POST` into a `GET`, dropping the assertion. | Only fails for POST-binding IdPs. |
| F10 | **Disposal timing / leak** — temp not disposed after last tab close, or disposed too early. | Cookies linger or vanish; time-dependent. |
| F11 | **Cookie boundary crossed** — a routing construct assumed to move a cookie. | Identity bleed; the one thing containers must prevent. |
| F12 | **Side-effect timing** — a seeded cookie or injected script lands *after* the page already read it; or a `redirector` tab closes *before* its redirect fires, or closes a tab that had already navigated on to a real destination. | No error; the consent banner just reappears, the pref doesn't apply, or a live tab silently vanishes. |
| F13 | **Routing a request that is not a page navigation** — `view-source:` fetches the document it prints, so webRequest reports a main_frame GET for the *inner* url in a pre-commit tab: indistinguishable, from the request alone, from a middle-clicked link. | Routing it "works": a tab opens in the right container. It is just the rendered page, and the source tab is gone. |
| F14 | **Stale tab lineage** — the `initiator` of a navigation read off `openerTabId`, which Firefox keeps for the life of a tab and `supersede` carries across every reopen, rather than off the page the tab is on. | An `inherit` host ping-pongs: each reopen makes the tab it came from the next tab's opener, so two containers take turns opening tabs forever. Only tabs that *have* an opener are affected, so the same url typed by hand works. |

Every level below states which classes it owns. The [coverage
matrix](#subtle-bug-coverage-matrix) proves no class is orphaned.

## The pyramid

```
        ┌─────────────────────────────┐
        │  L5  Acceptance (in tests)   │  BDD naming, real Firefox    slow
        ├─────────────────────────────┤
        │  L4  Integration (Firefox)   │  Selenium/geckodriver, +MAC
        ├─────────────────────────────┤
        │  L3  Model-based (mock API)  │  event sequences + invariants
        ├─────────────────────────────┤
        │  L2  Matcher units           │  URL → rule/group, fuzzed
        ├─────────────────────────────┤
        │  L1  Resolver units + props  │  pure fn, exhaustive         fast
        └─────────────────────────────┘
```

The design goal that makes this tractable: keep the **decision** a pure function
and the **effects** (reopen, create, dispose) behind a thin adapter. TCP fuses
them; we don't. Almost all subtle logic (F3–F6, F11) then lives in L1/L2 where
tests are milliseconds and exhaustive; only the stateful and browser-real classes
(F1, F2, F7, F8, F9, F10) need the slow levels.

Recommended stack (swappable): **Vitest** (L1–L3), **fast-check** for
property-based, a **mock `browser.*`** (`sinon-chrome` or a hand-rolled fake),
**Selenium/geckodriver (real Firefox, headless)** for L4 and L5 (the L5 acceptance
reading lives in the tests' own names — no Gherkin runner),
**Stryker** for mutation testing.

> **Driver note (plumbing spike, 2026-07-09):** L4/L5 use Selenium/geckodriver,
> **not** Playwright. Playwright's Firefox is structurally blind to
> WebExtension-opened container tabs (they never surface as pages), which is
> disqualifying for a container-routing engine; Selenium sees them as ordinary
> window handles. See
> `docs/superpowers/specs/2026-07-09-e2e-harness-plumbing-spike-design.md` §11.

---

## L1 — Resolver units + property-based

The resolver is a pure function:

```
resolve(targetUrl, initiatingContainer, currentTabContainer, config)
  -> Decision   // { temp } | { named: X } | { inherit } | { choice: [...] } | { leaveAlone }
```

No `browser.*`, no clock, no I/O. This is where F4, F5, F6, and the routing side
of F3 are proven. Two flavours:

- **Table-driven examples** — one row per behaviour and per known edge
  (`www.google.com → mail.google.com` switch; inherit-hop membership; domain in
  both an open rule and a group).
- **Property-based invariants** (fast-check generates configs + nav contexts):
  - *First-match determinism* — `resolve` equals a reference "scan in order, take
    first" oracle, for any generated rule list. (F5)
  - *Group totality* — every URL resolves to **at most one** group; membership is a
    function of the target URL **only** (permuting `initiatingContainer` never
    changes the group answer). (F4)
  - *Independence* — routing decision and group membership are computed from
    disjoint inputs; changing one rule's `open:` target never changes any group
    answer. (F4/F5)
  - *`inherit` neutrality* — an `inherit` match never yields `temp` or `named`, and
    for a fixed initiator its result is invariant under the rest of the config. (F6)
  - *Continuity monotonicity* — same registrable domain (or same group) ⇒ never a
    new temp; different site and different group ⇒ always isolate. (F3)

Property tests are the core anti-subtle-bug weapon: they explore configs no human
would hand-write, which is exactly where precedence and totality bugs hide.

## L2 — Matcher units + fuzz

The matcher (`url → matches this pattern?`) is separately pure and separately
dangerous. Table-driven over the three grammars, plus fuzz:

- Shorthand `company.com` expands to `*://*.company.com/*` — and **does not** match
  `notcompany.com`, `company.com.evil.tld`, or bare `company.com` without a dot
  boundary. (classic suffix-match bug)
- Match-pattern semantics match the WebExtension spec (path globs, port, scheme).
- Regex escape hatch is anchored/tested as written; a catastrophic-backtracking
  guard (timeout per match) is asserted.
- Fuzz: random hostnames/URLs against random patterns, cross-checked against an
  independent reference matcher; assert no pattern ever matches a URL of a
  different registrable domain unless it explicitly says so.

## L3 — Model-based interception & lifecycle

Everything stateful runs here, against a **mock `browser.*`** (fake `tabs`,
`contextualIdentities`, `webRequest`, `webNavigation`, and a **fake clock**). We
drive *sequences* of events and assert invariants after each step. This is the
home of F1, F2, F7, F8, F10, F13, F14.

- **Model-based / stateful property tests** (fast-check `commands`): generate
  random sequences of `navigate`, `redirect`, `clickLink`, `closeTab`,
  `openTab`, `macClaims(url)` and check invariants continuously:
  - *No double-open* — one top-level navigation never yields two tabs. (F1)
  - *Loop-free* — reopening converges: a tab already in its resolved container is
    never reopened again. (F1/F2)
  - *No fight with MAC* — when the mock MAC claims a URL, the engine backs off
    exactly as TCP's `getAssignment`-and-defer handshake does. (F2/F7)
  - *Disposal* — a temp with zero tabs is disposed after the configured delay on
    the fake clock, and never while a tab remains. (F10)
  - *Side-effect ordering* — a seeded `cookies` write and a `scripts` registration
    are scheduled on the navigation commit **before** `document_start`, never after.
    A `redirector`-rule tab is closed **only if it's still on the shim domain** after
    the delay: a tab stranded on `t.co` (its destination was reopened into another
    container) is closed; a tab that redirected onward in-place is **never** closed;
    and the close never fires before the delay. Asserted against the fake clock, so
    ordering is deterministic. (F12)
- **Restart injection** (`test/engine/restart.ts`, `restart.test.ts`) — a harness that
  **drops all in-memory guard state** and wires a fresh background against the *same*
  fake browser, then re-runs the invariants. This is the only level that catches F8, a
  class unit tests structurally cannot see. Guard state must therefore be
  reconstructible from `browser.*` queries or persisted, and the tests enforce that one
  mechanism at a time: the throwaway counter resuming past a live `tmp<N>`, the
  disposer resuming the *remaining* grace of a container emptied before the restart (the
  one piece that is genuinely **persisted** rather than re-queried — see
  `EMPTY_SINCE_KEY`), auto-temp's container check standing in for the `processed` set it
  no longer has, and the already-contained guard once a tab has committed. Each is
  revert-verified — back it out and at least one case goes red (the disposer's stored
  map reds seven).

  Not a hypothetical MV3 concern: `src/extension/options.ts` calls `runtime.reload()` on
  every config save, so a user triggers this in the shipping MV2 build. What that costs
  is pinned too — see F8 in the matrix note below.

  The harness calls `wireBackground` (`src/extension/wiring.ts`), the same function the
  extension entry point calls. That is deliberate: a harness that wired the siblings
  itself would hold a second copy of the startup order, and deleting a reconstruction
  from the real entry point would leave the suite green. Two fidelity rules keep it
  honest — the mock's one-handler-per-event slots retire the previous session's
  listeners, and a per-session clock facade retires its timers.

## L4 — Integration in real Firefox

Install the built extension via geckodriver's temporary-addon install and drive a
real Firefox (headless) with **Selenium/geckodriver**. Catches what mocks can't:
real event ordering, real `cookieStoreId` assignment, real container
create/dispose, real redirects.

- **Real routing** — navigate; assert `tab.cookieStoreId` is the expected
  container; assert containers created/disposed via `contextualIdentities.query`.
- **View Page Source (F13)** — open a real `view-source:` tab and assert it is still
  showing source, in the container it was opened in, with no throwaway bought for it.
  Only the browser can produce that load, and only it decides what webRequest is told
  about one; an L3 case can pin the guard, but not that the guard is watching the right
  event.
- **MAC interop (F2/F7)** — install *actual* Multi-Account Containers alongside,
  assign a domain in MAC, and assert our engine defers (no double-open, no churn).
  This is the Phase-1 coexistence contract executed for real.
- **Redirect-binding fixtures (F9)** — a local mock-IdP server serving both an
  OAuth **code (GET redirect)** flow and a **SAML POST-binding** flow. Assert the
  code flow survives a container switch and that the POST-binding case is either
  handled or **fails loudly with a documented reason** — never silently.
- **Cookie boundary (F11)** — set a cookie in container A, open the same site in a
  temp container, assert the cookie is invisible; assert no routing action ever
  moves a cookie across `cookieStoreId`.
- **Side-effect timing (F12)** — the real-`document_start` ordering mocks can't
  prove. Seed a `cookies` entry and assert the loaded page sees it on first read
  (consent banner absent); register a `scripts` snippet via `userScripts` and assert
  its `localStorage` write is visible to page scripts before they run. Drive a
  `redirector`-rule domain three ways and assert the close is conditional: (a)
  destination reopened into a **temp** container — the stranded shim tab is closed;
  (b) destination reopened into a **permanent** container — likewise closed (the
  case `inherit` alone leaves behind); (c) destination that navigates in-place and
  stays put — the tab is **not** closed. The shim hop never spawns a throwaway.
- **Fast-disposal build** — `launch({ ccGraceMs })` bundles CC with a wound-down
  grace (500ms in `test/e2e/disposal.test.ts`), so real timers are exercised without
  five-minute waits.
- **Real-delay disposal (F10), nightly** — `test/e2e/disposal.realtime.test.ts` takes
  the grace CC actually ships (`PRODUCTION_GRACE_MS`, imported from the builder so it
  cannot drift from the bundle) and watches one throwaway across it: still there a
  minute after its last tab closed, gone by the grace. It is the only case that can
  fail when a long background-page timer is throttled, coalesced or dropped — a fake
  clock cannot lie about a duration it invents, and 500ms is too short to be treated
  that way. Excluded from `npm test` by filename (`*.realtime.test.ts`) and run by
  `npm run test:realtime` via `vitest.realtime.config.ts`; excluded rather than
  skipped, so `npm test` stays a suite that skips nothing.

  Observation is `listContainers` — a `containers` probe command over
  `contextualIdentities.query`, added because `data-cc-containers` is a snapshot
  written when a document loaded. Watching a container *disappear* through that
  attribute means re-navigating a tab on every poll; over five minutes the polling
  would be more traffic than the case under test.

## L5 — Acceptance: the tests are the spec

There is no separate acceptance suite, and no second document to drift from. The
behaviour reading lives in the tests themselves: each is named for the behaviour
it pins, and its body is written so the mechanics read as that behaviour —
descriptive locals and helper names (`browser.opensTab`, `aNavigation`,
`theContainerNamed`), not a step DSL. A scenario is owned by whichever level can
prove it, so the acceptance reading is spread across L1–L4 rather than
duplicated above them.

Deliberately **no Gherkin runner** and **no step vocabulary**: cucumber-style
step binding is regex matching over prose, and a shared step library is the same
indirection by another name. Plain `describe` / `it` with well-chosen words
carries the meaning without the layer.

Which is why the [coverage matrix](#subtle-bug-coverage-matrix) has **no L5 column**. A
column is a claim that a class is owned *there*, and nothing is owned here: every
acceptance reading is a test at L1–L4, counted in that test's own column. The column that
used to sit there ticked seven classes and could not say what the ticks meant — every
test in the suite is named for its behaviour by policy, so a column that recorded "has a
behaviour-named test" would tick all fourteen and prove nothing about any of them.

This replaced a `TESTS.md` of 47 Gherkin-notation scenarios, written as reference
before implementation. It was deleted once the tests asserted the same behaviour:
two descriptions of one system, free to drift, only one of them executable. The
three scenarios that had no test at the time were carried in `FOLLOWUPS.md` rather
than lost, and now have one each: two independent blank tabs to the same unmatched
site are isolated (L3, `test/engine/engine.test.ts`), and a rule outranks both
same-site and same-group continuity (L1, `test/resolver/resolve.test.ts` — the
`www.google.com → mail.google.com` switch and a domain in both a group and an open
rule). Each was revert-verified against a mutant that no other case catches:
continuity consulted before `matchRule` reds only the two L1 cases, and a throwaway
shared per host reds only the L3 one.

## Cross-cutting gates

- **Mutation testing (Stryker)** — the direct answer to "are there subtle bugs the
  tests miss." `npm run test:mutation` (`stryker.config.mjs`) mutates `src/resolver`,
  `src/matcher` and `src/psl` — the pure modules — and fails if a mutant survives, i.e.
  if a logic change doesn't break a test. A survived mutant in precedence or group code
  is a subtle-bug hole by definition. **Gated at 100%**, which the scope earns: three
  modules, no I/O, no clock, ~190 mutants in twenty seconds. Nightly all the same, and
  not for the cost — a refactor can introduce an *equivalent* mutant honestly, and that
  should file an issue for someone to name in a comment, not block a merge.

  Two narrowings are what give the number meaning. Only the **pure** modules are
  mutated: the stateful ones fail under mutation as "the mock does not model that" as
  often as "nothing tests this". And only **L1/L2** may kill the mutants
  (`vitest.mutation.config.ts`) — a mutant in `resolve()` that an L3 engine case notices
  and no resolver case does is a hole in the level that owns that logic, and letting the
  slow levels answer for it would hide exactly what the gate is for.

  A survivor has two honest exits, and standing at 100% means every survivor so far took
  one: write the missing L1/L2 case, or — when the change provably cannot alter an answer
  — mark it `// Stryker disable … : <why>` in the source. There are four such comments,
  each naming an equivalence a reader can check: a trailing `"/"` the URL parser would
  supply anyway, two guards unreachable behind an earlier check, and a string tag that
  prevents a collision that cannot occur. Lowering the threshold is not one of the exits.

  It reads the code as it is, not as it is meant to be, so it also reports **dead
  defences**: the port/userinfo check in `canonicalHost` and the empty-host check in
  `urlHost` cannot fire for any input that reaches them, which nothing in the source said
  before the gate asked.
- **Coverage** — line/branch gate on L1–L3; coverage is necessary, mutation score
  is the real bar.
- **Type checking** — `tsc --noEmit` and a lint pass; the `Decision` union is
  exhaustively `switch`ed (no default case) so a new variant fails to compile
  until handled.
- **Determinism** — L1–L3 use a fake clock and seeded fast-check; a failing
  property prints its seed for exact replay. No `sleep`, no wall-clock. The mutation run
  additionally **pins** fast-check's seed (`test/fast-check-seed.ts`, loaded by that
  config alone): Stryker decides each mutant from one run of the suite, so a property
  drawing a fresh sample each time would report a mutant killed one night and survived
  the next from identical code. `npm test` keeps drawing freely — unseeded exploration is
  why the property tests exist.

## Subtle-bug coverage matrix

| Class | L1 | L2 | L3 | L4 | Mutation |
|-------|----|----|----|----|----------|
| F1 double-open / loop      |    |    | ✅ | ✅ |    |
| F2 already-contained guard |    |    | ✅ | ✅ | ✅ |
| F3 continuity misfire      | ✅ |    | ✅ |    | ✅ |
| F4 group-by-target-URL     | ✅ |    | ✅ |    | ✅ |
| F5 precedence              | ✅ | ✅ |    |    | ✅ |
| F6 inherit neutrality      | ✅ |    |    |    | ✅ |
| F7 race / MAC              |    |    | ✅ | ✅ |    |
| F8 MV3 restart             |    |    | ✅ |    |    |
| F9 redirect binding        |    |    | ✅ | ✅ |    |
| F10 disposal timing        |    |    | ✅ | ✅ |    |
| F11 cookie boundary        | ✅ |    |    | ✅ |    |
| F12 side-effect timing     |    |    | ✅ | ✅ |    |
| F13 non-navigation request |    |    | ✅ | ✅ |    |
| F14 stale tab lineage      |    |    | ✅ |    |    |

An L1–L4 tick means a test at that level owns the class. **Mutation** is not a level and
means something stronger than any of them: the decision this class turns on is inside the
mutation gate's scope, where **no** change to that code goes unnoticed by L1/L2 — not "a
test exists" but "there is no test-shaped hole left". F2 is ticked for its pure half
(`alreadyThere`: reopening a tab that is already in its target container is a wrong
answer before it is a churn); the stateful half of that class, and every class whose
decision lives in `src/engine`, is out of scope by design and carries no tick. The ticks
move only when a decision moves into or out of `src/resolver`, `src/matcher`, `src/psl` —
never as a score creeping up or down, because the gate is all-or-nothing.

There is no L5 column, and the [L5 section](#l5--acceptance-the-tests-are-the-spec) says
why: no test lives there to be counted.

Every class now has at least one deterministic owner (L1–L3) *and*, where the
browser is the source of truth (F1, F2, F7, F9, F10, F11, F12, F13), a real-Firefox
confirmation. F9 was the long-standing exception: POST bodies and redirect
bindings don't exist in a pure resolver. It gained an L3 owner when the decision
*not* to reopen a non-GET navigation moved into the engine, where a mock port can
drive it.

F8's tick was the last fictional one — the harness above is what made it true. One
piece of guard state is genuinely **not** reconstructible: `reopenedNav` holds a tab
whose url has not committed, and at restart such a tab is indistinguishable from a
middle-clicked link, which inherits its opener's container and must still be isolated.
The requestId that separates them exists nowhere else. So the tests pin the *bound*
rather than the state: a restart mid-reopen costs exactly one wasted reopen, converges
(the fresh engine guards the reopen it performs), and leaks no container. Recorded in
[`FOLLOWUPS.md`](FOLLOWUPS.md) so an MV3 migration — where suspension is involuntary
rather than user-chosen — can weigh persisting it against a cost already measured.

## GitHub Actions pipeline

```yaml
# .github/workflows/ci.yml  (sketch)
name: CI
on:
  push:
  pull_request:
  schedule:
    - cron: '0 3 * * *'   # nightly: mutation + real-delay disposal

jobs:
  static:            # every push — seconds
    steps: [checkout, setup-node, install, tsc --noEmit, lint]

  unit:              # every push — L1+L2+L3, seconds
    steps: [checkout, setup-node, install, vitest run --coverage]
    # uploads coverage; fails under branch threshold

  build:
    needs: [static, unit]
    steps: [checkout, install, web-ext build]   # artifact: .zip

  integration:       # every push — L4+L5, minutes
    needs: [build]
    strategy:
      matrix:
        firefox: [latest, latest-esr]   # ESR ships different extension APIs
    steps:
      - checkout; install
      - setup-firefox ${{ matrix.firefox }}
      - run mock-IdP fixture server
      - npm test                        # selenium/geckodriver, L4 + L5 acceptance suite
      - if failure: upload screenshots + geckodriver logs

  mutation:          # nightly only — slow
    if: github.event_name == 'schedule'
    steps: [checkout, install, stryker run]   # fails under mutation-score threshold

  disposal-realtime: # nightly only — one 15-min case
    if: github.event_name == 'schedule'
    steps: [build, integration harness with real delay]
```

Gating: `static` + `unit` block every PR and are fast; `integration` blocks merge
but tolerates the Firefox matrix; `mutation` and `disposal-realtime` run nightly
and open an issue on regression rather than blocking a PR (they're guard rails,
not gatekeepers). Artifacts (screenshots, `web-ext` logs, fast-check seeds) are
uploaded on every failure for deterministic repro.

**Built so far**, against that sketch:

- `.github/workflows/ci.yml` — one `test` job on every push: `typecheck`, `lint:ext`
  (addons-linter, what AMO runs server-side), then `npm test` end to end. The
  sketch's static/unit/build/integration split is not worth its overhead at this
  size; the Firefox `latest`/`esr` matrix is not built.
- `.github/workflows/nightly.yml` — `disposal-realtime` and `mutation`, both described
  above, plus a `report-regression` job that opens **one** issue per failing guard rail
  for a failing streak and comments on it thereafter. Scheduled runs go unwatched, so a
  red night has to come and find us; the two rails fail for unrelated reasons and are
  fixed by different work, so they get an issue each.

## What CI still can't catch (be honest)

- **Real disposal under service-worker suspension** — the nightly real-delay case
  exercises the five-minute timer but not Firefox actually evicting the background
  context for minutes. Residual risk on F8/F10; mitigation is the L3
  restart-injection harness plus manual dogfooding.
- **Real IdP quirks** — the mock IdP covers code + SAML-POST shapes, not every
  vendor's nonstandard flow. F9 in the wild needs the author's real logins.
- **Firefox API drift** — new Firefox versions change `webRequest`/container
  behaviour; the `latest`/`esr` matrix narrows this but a scheduled run against
  Firefox **Nightly** (allowed to fail) is the early-warning tripwire worth adding.
```
