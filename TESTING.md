# Testing strategy

How we keep the resolution engine correct — with the emphasis on the **subtle,
silent** bugs, not the obvious ones. This is a routing engine sitting on top of
Firefox's container + `webRequest` machinery; the dangerous failures here don't
throw, they mis-route a tab or churn a container while everything looks fine.

The [behaviour scenarios](TESTS.md) are the human-readable spec; this document is
how those scenarios (and the invariants underneath them) get *executed*.

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

Every level below states which classes it owns. The [coverage
matrix](#subtle-bug-coverage-matrix) proves no class is orphaned.

## The pyramid

```
        ┌─────────────────────────────┐
        │  L5  Acceptance (TESTS.md)   │  BDD code, real Firefox      slow
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
suite is plain BDD-style test code mirroring `TESTS.md` — no Gherkin runner),
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

- **Table-driven examples** — one row per `TESTS.md` line item and per known edge
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
home of F1, F2, F7, F8, F10.

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
- **MV3 restart injection** — a dedicated harness that **drops all in-memory guard
  state** at an arbitrary point mid-sequence (simulating service-worker
  termination) and re-runs the invariants. This is the only level that catches
  F8, and it's a class unit tests structurally cannot see. Guard state must
  therefore be reconstructible from `browser.*` queries or persisted — the test
  enforces that.

## L4 — Integration in real Firefox

Install the built extension via geckodriver's temporary-addon install and drive a
real Firefox (headless) with **Selenium/geckodriver**. Catches what mocks can't:
real event ordering, real `cookieStoreId` assignment, real container
create/dispose, real redirects.

- **Real routing** — navigate; assert `tab.cookieStoreId` is the expected
  container; assert containers created/disposed via `contextualIdentities.query`.
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
- **Fast-disposal build** — a test-only preference sets the disposal delay to
  seconds so real timers are exercised without 15-minute waits; a separate
  nightly job runs one real-delay case to guard against the fake clock lying.

## L5 — Acceptance: TESTS.md as BDD test code

Every scenario in [`TESTS.md`](TESTS.md) is implemented as a plain BDD-style
test (`describe` / `it`, given-when-then expressed in code) driving the L4
Firefox harness. Deliberately **no Gherkin runner**: cucumber-style step binding
is regex matching over prose — an extra DSL layer that adds indirection without
adding power. TESTS.md stays the human-readable spec; the acceptance suite
mirrors it one test per scenario, each test named after its scenario title. The
age-gate chain (F4 end-to-end), the choice screen, and the strict-SSO breakage
are the headline acceptance cases. Drift is guarded structurally instead of via
step binding: a CI check parses the scenario titles out of TESTS.md and fails
the build if any title lacks a matching test (or a test lacks a scenario) — the
same spec-can't-drift guarantee, without the DSL.

## Cross-cutting gates

- **Mutation testing (Stryker)** — the direct answer to "are there subtle bugs the
  tests miss." Mutates the resolver and matcher (L1/L2 are fast enough to mutate)
  and fails if a mutant survives — i.e. if a logic change doesn't break a test. A
  survived mutant in precedence or group code is a subtle-bug hole by definition.
  Gated with a threshold; run nightly (too slow per-push).
- **Coverage** — line/branch gate on L1–L3; coverage is necessary, mutation score
  is the real bar.
- **Type checking** — `tsc --noEmit` and a lint pass; the `Decision` union is
  exhaustively `switch`ed (no default case) so a new variant fails to compile
  until handled.
- **Determinism** — L1–L3 use a fake clock and seeded fast-check; a failing
  property prints its seed for exact replay. No `sleep`, no wall-clock.

## Subtle-bug coverage matrix

| Class | L1 | L2 | L3 | L4 | L5 | Mutation |
|-------|----|----|----|----|----|----------|
| F1 double-open / loop      |    |    | ✅ | ✅ |    |    |
| F2 already-contained guard |    |    | ✅ | ✅ |    |    |
| F3 continuity misfire      | ✅ |    | ✅ |    | ✅ | ✅ |
| F4 group-by-target-URL     | ✅ |    | ✅ |    | ✅ | ✅ |
| F5 precedence              | ✅ | ✅ |    |    | ✅ | ✅ |
| F6 inherit neutrality      | ✅ |    |    |    | ✅ | ✅ |
| F7 race / MAC              |    |    | ✅ | ✅ |    |    |
| F8 MV3 restart             |    |    | ✅ |    |    |    |
| F9 redirect binding        |    |    |    | ✅ | ✅ |    |
| F10 disposal timing        |    |    | ✅ | ✅ |    |    |
| F11 cookie boundary        | ✅ |    |    | ✅ | ✅ |    |
| F12 side-effect timing     |    |    | ✅ | ✅ | ✅ |    |

Every class except F9 has at least one deterministic owner (L1–L3) *and*, where
the browser is the source of truth (F1, F2, F7, F9, F10, F11, F12), a
real-Firefox confirmation. F9 is the exception by nature: POST bodies and
redirect bindings don't exist in a pure resolver, so it is owned entirely by the
real-Firefox levels (L4 fixtures + L5 scenarios).

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

## What CI still can't catch (be honest)

- **Real 15-minute disposal under service-worker suspension** — the nightly
  real-delay case exercises the timer but not Firefox actually evicting the
  background context for minutes. Residual risk on F8/F10; mitigation is the L3
  restart-injection harness plus manual dogfooding.
- **Real IdP quirks** — the mock IdP covers code + SAML-POST shapes, not every
  vendor's nonstandard flow. F9 in the wild needs the author's real logins.
- **Firefox API drift** — new Firefox versions change `webRequest`/container
  behaviour; the `latest`/`esr` matrix narrows this but a scheduled run against
  Firefox **Nightly** (allowed to fail) is the early-warning tripwire worth adding.
```
