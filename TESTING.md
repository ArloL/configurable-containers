# Testing strategy

How we keep the resolution engine correct, with the emphasis on the **subtle, silent**
bugs. This is a routing engine on top of Firefox's container and `webRequest` machinery;
the dangerous failures here don't throw, they mis-route a tab or churn a container while
everything looks fine.

The test suite is the behaviour spec — each test is named for what it pins, and its body
is written to read as that behaviour. This document is how those tests, and the invariants
under them, are *organised*.

## What "subtle bug" means here

Failure classes drawn from the model and from Temporary Containers' source, whose
`canceledTabs` / `cleanRequests` machinery exists only to prevent them:

| # | Failure class | Why it's silent |
|---|---------------|-----------------|
| F1 | **Reopen loop / double-tab-open** — the engine reopens a nav, which triggers another reopen. | No error; a flicker, two tabs, or a runaway. |
| F2 | **"Already correctly contained" not honoured** — reopening a tab already in its target container. | Churn; fights MAC; loses tab state. |
| F3 | **Same-site continuity misfire** — a new temp on a same-domain nav, or *keeping* one across a real site boundary. | Cookie leak (kept too long) or lost session (churned). |
| F4 | **Group membership resolved by routing, not by target URL** — the age-gate chain. | Login silently dropped on the redirect back. |
| F5 | **Precedence error** — wrong first-match in `rules` or `groups`; cross-list shadowing. | Wrong container, and it looks plausible. |
| F6 | **`inherit` routes or isolates** instead of staying put. | Breaks SSO, or leaks identity across a boundary. |
| F7 | **Race** — `onBeforeRequest` vs `onBeforeNavigate` vs MAC. | Nondeterministic; passes locally, fails in the wild. |
| F8 | **Background restart mid-flow** — in-memory guard state lost when the context dies. | Reintroduces F1/F2, but only sometimes. |
| F9 | **Redirect-binding breakage** — a reopen turns a SAML `POST` into a `GET`, dropping the assertion. | Only fails for POST-binding IdPs. |
| F10 | **Disposal timing / leak** — a temp not disposed after its last tab closes, or disposed too early. | Cookies linger or vanish; time-dependent. |
| F11 | **Cookie boundary crossed** — a routing construct assumed to move a cookie. | Identity bleed; the one thing containers must prevent. |
| F12 | **Side-effect timing** — a seeded cookie or injected script lands *after* the page read it; or a `redirector` tab closes before its redirect fires, or closes a tab that had already navigated on. | The consent banner reappears, the pref doesn't apply, or a live tab vanishes. |
| F13 | **Routing a request that is not a page navigation** — `view-source:` fetches the document it prints, so webRequest reports a main_frame GET for the *inner* url in a pre-commit tab. | Routing it "works": a tab opens in the right container, showing the rendered page, and the source tab is gone. |
| F14 | **Stale tab lineage** — `initiator` read off `openerTabId`, which Firefox keeps for the life of a tab and `supersede` carries across every reopen, rather than off the page the tab is on. | An `inherit` host ping-pongs: each reopen makes the old tab the next one's opener, so two containers take turns forever. Only tabs with an opener are affected, so a typed url works. |

Every level states which classes it owns; the [coverage
matrix](#subtle-bug-coverage-matrix) proves none is orphaned.

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

What makes this tractable: the **decision** is a pure function and the **effects**
(reopen, create, dispose) sit behind a thin adapter. TCP fuses them; we don't. Almost all
subtle logic (F3–F6, F11) then lives in L1/L2, where tests are milliseconds and
exhaustive; only the stateful and browser-real classes (F1, F2, F7, F8, F9, F10) need the
slow levels.

Stack: **Vitest** (L1–L3), **fast-check** for properties, a hand-rolled mock `browser.*`,
**Selenium/geckodriver** (real Firefox, headless) for L4/L5, **Stryker** for mutation.

> **Driver note (plumbing spike, 2026-07-09):** L4/L5 use Selenium/geckodriver, **not**
> Playwright. Playwright's Firefox is structurally blind to WebExtension-opened container
> tabs — they never surface as pages — which is disqualifying for a container-routing
> engine; Selenium sees them as ordinary window handles. See
> `docs/superpowers/specs/2026-07-09-e2e-harness-plumbing-spike-design.md` §11.

---

## L1 — Resolver units + property-based

```
resolve(targetUrl, initiatingContainer, currentTabContainer, config)
  -> Decision   // { temp } | { named: X } | { inherit } | { choice: [...] } | { leaveAlone }
```

No `browser.*`, no clock, no I/O. F4, F5, F6 and the routing side of F3 are proven here.

- **Table-driven examples** — one row per behaviour and per known edge
  (`www.google.com → mail.google.com`; inherit-hop membership; a domain in both an open
  rule and a group).
- **Property-based invariants** (fast-check generates configs and nav contexts):
  - *First-match determinism* — `resolve` equals a "scan in order, take first" oracle for
    any generated rule list. (F5)
  - *Group totality* — every URL resolves to at most one group, and membership is a
    function of the target URL only. (F4)
  - *Independence* — routing and group membership come from disjoint inputs; changing a
    rule's `open:` target never changes a group answer. (F4/F5)
  - *`inherit` neutrality* — an `inherit` match never yields `temp` or `named`, and for a
    fixed initiator its result is invariant under the rest of the config. (F6)
  - *Continuity monotonicity* — same registrable domain or same group ⇒ never a new temp;
    different site and different group ⇒ always isolate. (F3)

Properties are the core anti-subtle-bug weapon: they explore configs no human would
hand-write, which is where precedence and totality bugs hide.

## L2 — Matcher units + fuzz

The matcher is separately pure and separately dangerous. Table-driven over the three
grammars, plus fuzz:

- Shorthand `company.com` expands to `*://*.company.com/*` and does **not** match
  `notcompany.com`, `company.com.evil.tld`, or a host without the dot boundary — the
  classic suffix-match bug.
- Match patterns follow the WebExtension spec, including the two places they differ from
  the shorthand: a bare host is *only* that host, and the path is escaped and anchored at
  both ends, so `/work` does not answer `/workshop` and `/a.b` does not answer `/axb`.
- The regex escape hatch is tested as written, against the canonical URL, and compiled at
  parse time so a broken expression is a config error. There is **no** backtracking guard
  and there cannot be one: a JavaScript regex is synchronous and uninterruptible, so a
  per-match timeout needs a different regex engine — a dependency this repo will not take
  for a single-user escape hatch. `CONFIG.md` documents the risk instead.
- Fuzz (`test/matcher/matcher.props.test.ts`): a host matcher's `matcherToPatterns`
  expansion matches exactly what the matcher matches, cross-checking the suffix test
  against the pattern machinery — the two independent paths behind routing and script
  registration. Plus totality: `matches()` returns a boolean and never throws for an
  arbitrary string, in all three grammars, because it runs inside the blocking handler
  where a throw is a navigation that never completes.

## L3 — Model-based interception & lifecycle

Everything stateful runs here against a mock `browser.*` (fake `tabs`,
`contextualIdentities`, `webRequest`, `webNavigation`, and a fake clock). We drive
*sequences* of events and assert invariants after each step. Home of F1, F2, F7, F8, F10,
F13, F14.

- **Model-based property tests** (fast-check `commands`): random sequences of `navigate`,
  `redirect`, `clickLink`, `closeTab`, `openTab`, `macClaims(url)`, with invariants
  checked continuously:
  - *No double-open* — one top-level navigation never yields two tabs. (F1)
  - *Loop-free* — a tab already in its resolved container is never reopened. (F1/F2)
  - *No fight with MAC* — when the mock MAC claims a URL the engine backs off, exactly as
    TCP's `getAssignment`-and-defer handshake does. (F2/F7)
  - *Disposal* — a temp with zero tabs is disposed after the configured delay on the fake
    clock, and never while a tab remains. (F10)
  - *Side-effect ordering* — a seeded `cookies` write and a `scripts` registration are
    scheduled on the navigation commit **before** `document_start`, never after. A
    `redirector`-rule tab is closed **only if it is still on the shim domain** after the
    delay: a tab stranded on `t.co` is closed, a tab that redirected onward in place is
    never closed, and the close never fires early. (F12)
- **Restart injection** (`test/engine/restart.ts`, `restart.test.ts`) — drops all
  in-memory guard state and wires a fresh background against the *same* fake browser, then
  re-runs the invariants. The only level that catches F8. Guard state must therefore be
  reconstructible from `browser.*` queries or persisted, and the tests enforce one
  mechanism at a time: the throwaway counter resuming past a live `tmp<N>`, the disposer
  resuming the *remaining* grace of a container emptied before the restart (the one piece
  genuinely persisted rather than re-queried — `EMPTY_SINCE_KEY`), auto-temp's container
  check standing in for the `processed` set it no longer has, and the already-contained
  guard once a tab has committed. Each is revert-verified; the disposer's stored map reds
  seven cases.

  Not a hypothetical MV3 concern: `src/extension/options.ts` calls `runtime.reload()` on
  every config save, so a user triggers this in the shipping MV2 build.

  The harness calls `wireBackground` (`src/extension/wiring.ts`), the same function the
  extension entry point calls, so no second copy of the startup order can drift. Two
  fidelity rules keep it honest, both retiring the previous session: a per-session port
  facade stops its listeners being called and a per-session clock facade stops its timers
  firing. The mock is additive, exactly as `addListener` is, so re-wiring a background adds
  handlers rather than replacing them — Firefox retires the old ones by destroying their
  context, and the two facades model that.

## L4 — Integration in real Firefox

Install the built extension via geckodriver's temporary-addon install and drive a real
headless Firefox. Catches what mocks cannot: real event ordering, real `cookieStoreId`
assignment, real container create/dispose, real redirects.

- **Real routing** — navigate; assert `tab.cookieStoreId`; assert containers created and
  disposed via `contextualIdentities.query`.
- **View Page Source (F13)** — open a real `view-source:` tab and assert it is still
  showing source, in the container it was opened in, with no throwaway bought for it. Only
  the browser can produce that load and decide what webRequest is told about it; an L3
  case pins the guard, not that the guard watches the right event.
- **Stale tab lineage (F14)** — click a real `target=_blank` link out of one container
  into a host that belongs in another, so CC's reopen leaves a tab in the second container
  still pointing at an opener in the first; navigate it to an `inherit` host and assert it
  stays. How long Firefox keeps `openerTabId`, and whether `tabs.create({ openerTabId })`
  reproduces that lineage across a reopen, are facts only the browser holds — the L3 mock
  keeps the opener because it was written to. So the case asserts the opener itself
  midway; without that it would pass on a browser that had quietly dropped the lineage.
- **MAC interop (F2/F7)** — install actual Multi-Account Containers alongside, assign a
  domain in MAC, assert our engine defers: no double-open, no churn.
- **Redirect-binding fixtures (F9)** — a local mock-IdP serving an OAuth **code (GET
  redirect)** flow and a **SAML POST-binding** flow. The code flow survives a container
  switch; the POST-binding case is handled or **fails loudly with a documented reason**,
  never silently.
- **Cookie boundary (F11)** — set a cookie in container A, open the same site in a temp,
  assert it is invisible; assert no routing action moves a cookie across `cookieStoreId`.
- **Side-effect timing (F12)** — the real `document_start` ordering mocks cannot prove.
  Seed a `cookies` entry and assert the page sees it on first read (consent banner
  absent); register a `scripts` snippet and assert its `localStorage` write is visible to
  page scripts before they run. Drive a `redirector` domain three ways: destination
  reopened into a **temp** — the stranded shim tab is closed; into a **permanent** —
  likewise closed (the case `inherit` alone leaves behind); a destination that navigates
  in place and stays — **not** closed. The shim hop never spawns a throwaway.
- **Fast-disposal build** — `launch({ ccGraceMs })` bundles CC with a wound-down grace
  (500ms in `test/e2e/disposal.test.ts`), exercising real timers without five-minute waits.
- **Real-delay disposal (F10), nightly** — `test/e2e/disposal.realtime.test.ts` takes the
  grace CC ships (`PRODUCTION_GRACE_MS`, imported from the builder so it cannot drift from
  the bundle) and watches one throwaway across it: still there a minute after its last tab
  closed, gone by the grace. The only case that can fail when a long background timer is
  throttled, coalesced or dropped — a fake clock cannot lie about a duration it invents,
  and 500ms is too short to be treated that way. Excluded from `npm test` by filename and
  run by `npm run test:realtime`; excluded rather than skipped, so `npm test` skips
  nothing.

  Observation is `listContainers`, a probe command over `contextualIdentities.query`,
  because `data-cc-containers` is a snapshot written when a document loaded — watching a
  container *disappear* through it means re-navigating a tab on every poll, which over
  five minutes is more traffic than the case under test.

## L5 — Acceptance: the tests are the spec

There is no separate acceptance suite and no second document to drift from. Each test is
named for the behaviour it pins, and its body is written so the mechanics read as that
behaviour — descriptive locals and helpers (`browser.opensTab`, `aNavigation`,
`theContainerNamed`), not a step DSL. A scenario is owned by whichever level can prove it,
so the acceptance reading is spread across L1–L4 rather than duplicated above them.

Deliberately **no Gherkin runner** and **no step vocabulary**: cucumber-style step binding
is regex matching over prose, and a shared step library is the same indirection by another
name.

Which is why the coverage matrix has **no L5 column**. A column claims a class is owned
there, and nothing is owned here. The column that used to sit there ticked seven classes
and could not say what the ticks meant — every test is behaviour-named by policy, so it
would tick all fourteen and prove nothing.

This replaced a `TESTS.md` of 47 Gherkin scenarios written before implementation, deleted
once the tests asserted the same behaviour: two descriptions of one system, free to drift,
only one executable. The three scenarios that had no test were carried in `FOLLOWUPS.md`
and now have one each: two independent blank tabs to the same unmatched site are isolated
(L3, `test/engine/engine.test.ts`), and a rule outranks both same-site and same-group
continuity (L1, `test/resolver/resolve.test.ts`). Each was revert-verified against a
mutant no other case catches.

## Cross-cutting gates

- **Mutation testing (Stryker)** — the direct answer to "are there subtle bugs the tests
  miss". `npm run test:mutation` mutates `src/resolver`, `src/matcher` and `src/psl` and
  fails if a mutant survives. A survivor in precedence or group code is a subtle-bug hole
  by definition. **Gated at 100%**, which the scope earns: three modules, no I/O, no
  clock, ~190 mutants in twenty seconds. Nightly all the same, and not for the cost — a
  refactor can introduce an *equivalent* mutant honestly, which should file an issue for
  someone to name in a comment, not block a merge.

  Two narrowings give the number meaning. Only the **pure** modules are mutated: the
  stateful ones fail under mutation as "the mock does not model that" as often as "nothing
  tests this". And only **L1/L2** may kill the mutants (`vitest.mutation.config.ts`) — a
  mutant in `resolve()` that an L3 engine case notices and no resolver case does is a hole
  in the level that owns that logic.

  A survivor has two honest exits, and every survivor so far took one: write the missing
  L1/L2 case, or — when the change provably cannot alter an answer — mark it
  `// Stryker disable … : <why>`. There are four such comments, each naming an equivalence
  a reader can check. Lowering the threshold is not an exit.

  It reads the code as it is, not as it is meant to be, so it also reports **dead
  defences**: the port/userinfo check in `canonicalHost` and the empty-host check in
  `urlHost` cannot fire for any input that reaches them.
- **Coverage** — `npm run test:coverage` (v8), a floor on the deterministic levels, run on
  every push before the Firefox suite spends its minutes. It answers a weaker and
  different question: not "is there logic no test would notice changing" over three
  modules, but "is any of `src/` reached by no deterministic test at all".

  Thresholds sit a point or two under what the suite measures (~92% statements, ~89%
  branches), **except** `src/resolver`, `src/matcher` and `src/psl`, held at 100 — the
  mutation gate owns those three, and this catches a new uncovered branch on the push that
  adds it rather than that night. Three files are excluded for platform facts rather than
  gaps: `background.ts` (the MV2 entry point, whose listeners must register as the file
  evaluates — L3 drives the `wireBackground` it delegates to) and `choice.ts` /
  `options.ts` (DOM, and there is no jsdom here; what could be decided without a document
  already was, in `picker-protocol.ts` at 100%). Left in at 0% they would force a
  threshold low enough to report nothing about the rest.

  This gate finds dead defences too, and takes the same exit: the two in `matcher.ts`
  Stryker reports unreachable carry a `/* v8 ignore */` beside their `// Stryker disable`.
  Excluding a file, or lowering a floor, is not an exit.
- **Fitness functions** — `test/fitness/`, in `npm test`, milliseconds. Every gate above
  asks whether the code is *right*; these ask whether the properties that make those gates
  **mean** anything are still true. Each exists because the property it pins is stated in
  prose somewhere and kept true by hand:

  - **The seams** (`seams.test.ts`) — `src/resolver`, `src/matcher` and `src/psl` reach no
    browser API, read no clock, draw no randomness, and import nothing from a layer above.
    That purity is why F3–F6 and F11 are provable at L1 and what the mutation gate's 100%
    is a statement *about*; `import type { BrowserPort }` into `resolve.ts` compiles and
    leaves every test green. Plus the `browser.*` allowlist: five files, one of them the
    port implementation.
  - **The listener inventory** (`listeners.test.ts`) — every `BrowserPort` event and every
    place it is registered, compared exactly. A second `runtime.onMessage` listener breaks
    the reply channel in Firefox itself.
  - **The manifest** (`manifest.test.ts`) — declared permissions against called APIs, both
    directions. A missing one fails silently; an unused one is a larger install prompt and
    more AMO surface for an API nothing calls.
  - **The duplicated seed** (`seed-config.test.ts`) — `__CC_CONFIG_YAML__` is supplied
    twice, by `harness/build-extension.ts` for e2e and `vitest.shared.ts` for the unit
    levels, and drift splits the suite's idea of the shipped config while both halves stay
    green.
  - **The suite itself** (`suite.test.ts`) — no committed `.only` (which shrinks CI to one
    case and still reports success), skips limited to the one documented undriveable case,
    and every `// Stryker disable` carrying its justification.
  - **The round-trip budget** (`decision-cost.test.ts`) — the only one that measures
    rather than inspects, and the answer to "nothing tests latency". `onBeforeRequest` is
    blocking, so every awaited call before it answers is latency in front of a page load.
    It counts port round trips, not milliseconds (a flake generator in CI), and pins the
    call sequence for four paths: a navigation that stays put costs `getTab` +
    `getIdentity` and nothing else, a reopen asks MAC only *after* deciding to act, an
    armed container adds nothing, and the hops of a reopen we performed cost nothing.

  House rules for adding one: an **exact inventory, never a bound** (a bound absorbs the
  next violation silently); **no false alarms** (comments stripped before matching,
  identity by file rather than line — a check that cries wolf gets deleted and takes its
  invariant with it); and **the reason lives beside the exception**. Thirteen mutations
  were revert-verified against this batch. Design notes:
  [`docs/superpowers/specs/2026-08-24-fitness-functions-design.md`](docs/superpowers/specs/2026-08-24-fitness-functions-design.md).
- **Type checking** — `tsc --noEmit` plus a lint pass; the `Decision` union is exhaustively
  `switch`ed with no default, so a new variant fails to compile until handled.
- **Determinism** — L1–L3 use a fake clock and seeded fast-check; a failing property prints
  its seed for exact replay. No `sleep`, no wall clock. The mutation run additionally
  **pins** fast-check's seed (`test/fast-check-seed.ts`, loaded by that config alone):
  Stryker decides each mutant from one run, so a property drawing a fresh sample would
  report a mutant killed one night and survived the next from identical code. `npm test`
  keeps drawing freely — unseeded exploration is why the properties exist.

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
| F8 background restart      |    |    | ✅ |    |    |
| F9 redirect binding        |    |    | ✅ | ✅ |    |
| F10 disposal timing        |    |    | ✅ | ✅ |    |
| F11 cookie boundary        | ✅ |    |    | ✅ |    |
| F12 side-effect timing     |    |    | ✅ | ✅ |    |
| F13 non-navigation request |    |    | ✅ | ✅ |    |
| F14 stale tab lineage      |    |    | ✅ | ✅ |    |

An L1–L4 tick means a test at that level owns the class. **Mutation** is not a level and
means something stronger: the decision this class turns on is inside the gate's scope,
where no change to that code goes unnoticed by L1/L2 — not "a test exists" but "there is
no test-shaped hole left". F2 is ticked for its pure half (`alreadyThere`); the stateful
half, and every class whose decision lives in `src/engine`, is out of scope by design. The
ticks move only when a decision moves into or out of `src/resolver`, `src/matcher`,
`src/psl`, never as a score creeping — the gate is all-or-nothing.

Every class has a deterministic owner (L1–L3) and, where the browser is the source of
truth (F1, F2, F7, F9, F10, F11, F12, F13, F14), a real-Firefox confirmation. F9 was the
long-standing exception — POST bodies and redirect bindings don't exist in a pure resolver
— and gained an L3 owner when the decision *not* to reopen a non-GET navigation moved into
the engine.

F8's tick was the last fictional one; the restart harness made it true. One piece of guard
state is genuinely **not** reconstructible: `reopenedNav` holds a tab whose url has not
committed, and at restart such a tab is indistinguishable from a middle-clicked link,
which inherits its opener's container and must still be isolated. The requestId that
separates them exists nowhere else. So the tests pin the *bound* instead: a restart
mid-reopen costs exactly one wasted reopen, converges, and leaks no container. Recorded in
[`FOLLOWUPS.md`](FOLLOWUPS.md) so an MV3 migration — where suspension is involuntary — can
weigh persisting it against a measured cost.

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

Gating: `static` + `unit` block every PR and are fast; `integration` blocks merge but
tolerates the Firefox matrix; `mutation` and `disposal-realtime` run nightly and open an
issue on regression rather than blocking a PR — guard rails, not gatekeepers. Artifacts
(screenshots, `web-ext` logs, fast-check seeds) are uploaded on every failure.

**Built so far**, against that sketch:

- `.github/workflows/ci.yml` — one `test` job on every push: `typecheck`, `lint:ext`
  (addons-linter, what AMO runs server-side), then `npm test` end to end. The
  static/unit/build/integration split is not worth its overhead at this size, and the
  Firefox `latest`/`esr` matrix is not built.
- `.github/workflows/nightly.yml` — `disposal-realtime` and `mutation`, plus a
  `report-regression` job that opens **one** issue per failing guard rail for a failing
  streak and comments on it thereafter. Scheduled runs go unwatched, so a red night has to
  come and find us; the two rails fail for unrelated reasons and are fixed by different
  work, so they get an issue each.

## What CI still can't catch

- **Real disposal under background suspension** — the nightly real-delay case exercises
  the five-minute timer but not Firefox actually evicting the background context for
  minutes. Residual risk on F8/F10; mitigated by the L3 restart harness and dogfooding.
- **Real IdP quirks** — the mock IdP covers code and SAML-POST shapes, not every vendor's
  nonstandard flow. F9 in the wild needs the author's real logins.
- **Firefox API drift** — new versions change `webRequest` and container behaviour. The
  `latest`/`esr` matrix narrows this; a scheduled run against Firefox **Nightly**, allowed
  to fail, is the early-warning tripwire worth adding.
