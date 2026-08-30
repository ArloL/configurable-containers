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
  - *Precedence* — a rule matching at the head of a generated list decides whatever
    follows it, and a rule that does not match shadows nothing below it: `resolve` reads
    the rule that matched and no other. (F5)
  - *Group totality* — the first group naming both ends of a hop keeps it whatever groups
    follow, and a group naming only the target is not a group the two share. (F4)
  - *Independence* — a rule naming a container answers the same whatever the groups say:
    routing outranks continuity. (F4/F5)
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

## L1b — The other pure modules: the config parser and the sync record

Two more modules are as pure as the resolver and never appear in the pyramid above,
because neither routes anything. Both are still owned by the fast deterministic levels,
and one of them is the only subsystem here whose failure mode is losing the user's work
rather than mis-routing a tab.

`src/config/sync-record.ts` decides what a machine does when its config and the published
one disagree. It has **no L4 owner and cannot have one** — a test profile has no Firefox
Account, `moz-extension:` is unreachable to the driver, and the probe has its own sync
namespace —
so the deterministic levels are the whole defence. What they defend against is a config
silently replaced by an older one on every machine the user owns.

Its two hardest properties are not statements about a single decision. They are about a
*conversation*, and both fail as a **loop** rather than as a wrong answer, which is why
no single-decision example finds them:

- *Convergence* — from any interleaving of edits and syncs on two machines, sync
  terminates: one config, both machines quiet. Equal text must never return `adopt`
  (an adoption is itself a change the other machine hears, so a converged pair would adopt
  each other's identical config forever), and the
  equal-stamp tie-break must give the two machines **opposite** answers, so exactly one
  publishes. The tie is the *normal* first startup — an EDITED pre-sync config backfills
  to the same stamp on every machine. An untouched seed is deliberately not in that tie: it
  backfills below it (`UNEDITED` against `PRE_SYNC_EDIT`, `config-sync.ts`) and loses
  outright, or a fresh install wins half the ties and publishes the shipped default over
  another machine's rules.
- *No rollback* — the published stamp only ever moves forward. The way it would move
  backwards is a read that caught the record mid-arrival: the parts and the meta land as
  ordinary storage changes with nothing making them land together, so `decodeRecord` has
  to answer `incomplete` and not `absent` — `absent` means *push*, and this machine would
  publish its older config over the update still in flight, whose sender then adopts the
  rollback.

`test/config/sync-record.props.test.ts` drives both against a two-machine model with an
arbitrary script of edits, whole syncs and **torn** syncs, checking the stamp after every
step and quiescing at the end. Four mutations were revert-verified against it: reading a
missing part as `absent`, letting equal text adopt, making the tie-break always push, and
checking the record's integrity by length alone.

One consequence worth stating separately: `hashText`'s digest and the `ccConfigMeta` /
`ccConfigPart` key names are a **wire format**, not implementation details. One machine
writes them and another reads them, and the two may be on different builds — change the
algorithm and every record reads as `incomplete` on whichever machine disagrees, so sync
stops permanently with nothing failing anywhere. They are pinned by known answers rather
than by properties of the answers.

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

  Not a hypothetical MV3 concern, even though a config save no longer restarts anything:
  the background context still dies with the browser, which is every user, every day.

  The harness calls `wireBackground` (`src/extension/wiring.ts`), the same function the
  extension entry point calls, so no second copy of the startup order can drift. Two
  fidelity rules keep it honest, both retiring the previous session: a per-session port
  facade stops its listeners being called and a per-session clock facade stops its timers
  firing. The mock is additive, exactly as `addListener` is, so re-wiring a background adds
  handlers rather than replacing them — Firefox retires the old ones by destroying their
  context, and the two facades model that.

## L4 — Integration in real Firefox

Install the built extension via geckodriver's temporary-addon install and drive a real
headless Firefox. On a machine with no Firefox, `./scripts/get-firefox.sh` fetches both
channels into `.firefox/` and `FIREFOX_BIN=.firefox/esr/firefox npm test` runs the suite
the way CI's ESR leg does; geckodriver needs no setup, since Selenium Manager fetches it. Catches what mocks cannot: real event ordering, real `cookieStoreId`
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
- **The decision echo** — the only thing at this level that carries a CAUSE. Everything
  else here is an effect (a tab exists, in this container, with these cookies), so the six
  ways a navigation can end up not moving arrive as one signal: a poll running out. A test
  build echoes what `resolve()` answered and what the engine did with it
  (`__CC_DECISION_ECHO_TO__`, folded to `if (false)` in every shipped bundle) and the
  CC-specific polls print the last few in their timeout report, so a red run names
  *"reopen -> Work => declined: POST has a body"* instead of a selector that never appeared.
  `test/e2e/plumbing.test.ts` proves the channel itself end to end, because a diagnostic
  that silently carried nothing would leave every timeout as bad as before while looking
  better.
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
  miss". `npm run test:mutation` mutates every **pure** module — `src/resolver`,
  `src/matcher`, `src/psl`, `src/config` and `src/overlays` — and fails if a mutant
  survives. A survivor in precedence or group code is a subtle-bug hole by definition.
  **Gated at 100%**, which the scope earns: no I/O, no clock, ~1160 mutants in about two
  minutes (measured 2026-08-29; the count moves with the five modules). Nightly all the
  same, and not for the cost — a refactor can introduce an *equivalent* mutant honestly,
  which should file an issue for someone to name in a comment, not block a merge.

  The nightly keeps the HTML report as an artifact (`mutation-report`, 14 days, uploaded on
  failure too — the failing run is the one worth reading). It is per-mutant and browsable:
  the mutated source, what each survivor changed, which tests ran against it. Stryker wrote
  it on every run before this and the runner was torn down with it still inside, so the only
  thing that ever survived was the score. The same job also names its `reporters` in
  `vitest.mutation.config.ts` — not for the reporting, but because vitest adds
  `github-actions` when none are configured and `GITHUB_ACTIONS=true`, and that reporter
  APPENDS a job summary per test run. Stryker ends one per mutant, so the summary carried
  1152 reports with 2302 ❌ marks on it — where a failing run means a mutant was KILLED, so
  a green 100% job rendered as a wall of red.

  Two narrowings give the number meaning. Only the **pure** modules are mutated: the
  stateful ones fail under mutation as "the mock does not model that" as often as "nothing
  tests this". And only the levels that **own** each module may kill its mutants
  (`vitest.mutation.config.ts` runs `test/{resolver,matcher,psl,config,overlays}`) — a
  mutant in `resolve()` that an L3 engine case notices and no resolver case does is a hole
  in the level that owns that logic.

  The scope was widened from three modules to five on 2026-08-24. What that found, in a
  parser and a sync record that were both green under coverage: a third of the config
  parser's rejection branches reached by no test at all, and most of the rest reached by a
  test that never looked at what came back — emptying every error message in the file
  changed no result. Hence `test/config/parse.rejections.test.ts`, one row per way a
  config can be refused, asserting the exact message and `path`. The diagnostics are the
  product: a config is hand-written YAML, and a rejected one leaves every site opening in
  a throwaway until the user can see what is wrong.

  It also found a real one. `yaml` raises a plain `ReferenceError` for an unresolved alias
  and a `TypeError` for a circular one — neither a `YAMLParseError`, so both left
  `parseConfig` as something that was not a `ConfigError`, and the options page had
  nothing to underline. Now wrapped.

  A survivor has two honest exits, and every survivor so far took one: write the missing
  L1/L2 case, or — when the change provably cannot alter an answer — mark it
  `// Stryker disable … : <why>`. There are sixteen such comments — four older than the
  widening, twelve that arrived with the parser, the sync record and the cookies overlay it
  brought into scope — each naming an equivalence a reader can check. Lowering the threshold
  is not an exit.

  It reads the code as it is, not as it is meant to be, so it also reports **dead
  defences**: the port/userinfo check in `canonicalHost` and the empty-host check in
  `urlHost` cannot fire for any input that reaches them.
- **Coverage** — `npm run test:coverage` (v8), a floor on the deterministic levels, run on
  every push before the Firefox suite spends its minutes. It answers a weaker and
  different question: not "is there logic no test would notice changing" over the five
  modules the mutation gate owns, but "is any of `src/` reached by no deterministic test at
  all".

  Thresholds are **100 on all four counters** (`vitest.coverage.config.ts`), and they are
  the measurement rather than a floor under it: every line, branch and function of `src/`
  outside the three files below is reached by an L1–L3 case. That is what makes a red run
  name the new code on the push that writes it — the 97/95/95/97 this carried until
  2026-08-27, with the five mutation-gate modules held at 100 by glob, absorbed the first
  few uncovered branches in silence and only went red once someone had written several.
  Code no deterministic level can reach is marked at the line instead (`/* v8 ignore … --
  why */`, as `matcher.ts`, `load.ts` and `browser-port.ts`'s two echoes do), so the
  exception is readable beside the code rather than averaged away; lowering a threshold is
  not an exit, the same rule the mutation gate has. Three files are excluded for platform
  facts rather than gaps: `background.ts` (the MV2 entry point, whose listeners must
  register as the file evaluates — L3 drives the `wireBackground` it delegates to) and
  `choice.ts` / `options.ts` (DOM, and there is no jsdom here; what could be decided
  without a document already was, in `picker-protocol.ts`, at 100%). Left in at 0% they
  would force a threshold low enough to report nothing about the rest.

  This gate finds dead defences too, and takes the same exit: the two in `matcher.ts`
  Stryker reports unreachable carry a `/* v8 ignore */` beside their `// Stryker disable`.
  Excluding a file, or lowering a floor, is not an exit.
- **The production dependency tree** — `npm run audit` (`npm audit --omit=dev`), every
  push. The xpi is an esbuild bundle of `src/`, so no `node_modules` package ships and
  every current advisory is dev tooling with no upstream fix. That makes the unfiltered
  `npm audit` permanently loud and this one meaningful: the shipped tree is two packages
  wide (`tldts`, `yaml`), and an advisory in either is a real one, in code that runs
  inside every page load's decision.
- **The reproducibility promise** — `npm run verify:reproducible`, on two triggers. Every
  release body says "Reproduce this build:" and gives two commands; this runs them,
  rebuilding a release from its own published source archive with its own published
  `BUILD_TIMESTAMP` and comparing the sha256 with the xpi attached beside it. The GitHub
  asset is the only copy the comparison can be made against — AMO repacks uploads, so its
  copy differs by entry order and mtimes whatever the build did.

  The two triggers ask different questions and neither replaces the other.
  `verify-release.yaml` checks **each release as it is published**, on either channel, with
  the tag handed to it by the job that just published it — so it performs no search, which
  is the whole point of it. `nightly.yml`'s `reproducible-build` re-checks the newest
  **listed** release against today's toolchain: whether something that reproduced when it
  was cut still does, after a newer Node or a dependency yanked from the registry.

  Both are called rather than triggered. A release published with `GITHUB_TOKEN` fires no
  `release: published` event at all, so `on: release` alone would leave the gate dead on
  arrival — which is a variation of how it spent its first four weeks. The release-PICKING
  is unit-tested (`test/extension/verify-reproducible.test.ts`) because picking wrong is
  the failure that matters: both channels share one tag sequence and the dev channel
  buries a listed release within days, so the fixed 20-release window this used to read
  never reached `v2608.0.112` (the 32nd newest release on 2026-08-25) and the job passed
  every night announcing "No listed release yet". It pages now, and **throws** when the
  page cap runs out rather than reporting an unfinished search as "nothing to check".
- **Determinism of the browser tier** — `npm run test:flake`, nightly. Every other gate
  asks whether the suite is green. This asks whether green means anything: L4/L5 drive a
  real Firefox through a real network stack and real timers, and one run cannot tell a
  1-in-20 case from a solid one. It runs `test/e2e` **ten times, on each of two runners**,
  and fails on **disagreement** — a case that fails every time is the suite being red,
  which `ci.yml` already reports.

  **It refuses to answer over nothing, in two places.** `FLAKE_RUNS` is validated at the
  boundary — `Number("")` is 0 and `Number("thre")` is NaN, and `for (let i = 0; i < runs;
  i++)` runs zero times for both, so a typo in the workflow's env spent no time, exited 0,
  and printed *"All NaN runs succeeded, and every case answered the same way."* That is the
  exact inference this gate exists to refuse, arrived at from the other end. `isRed` refuses
  such a verdict too, and at **fewer than two runs** rather than fewer than one: over a
  single run every case agrees with itself, which is the same emptiness one step along. The
  two guards answer different questions — only the boundary one can name the typo.
  A run whose report vitest never wrote is now **counted as the empty run it is** rather
  than thrown as an ENOENT out of `main`, which used to take the runs that had completed
  down with it.

  Ten because three was thin: P(catching a race that fails one run in three) is 67% at
  N=3 and 98% at N=10, and 1-in-10 goes 27% to 65%. The race that took auto-temp's startup
  sweep down had been in `session.ts` since `f9ab866` and had a one-in-three chance of
  slipping past the run that finally caught it. Two runners because repeats inside one job
  are correlated — same machine, same neighbours — so a race whose odds depend on how fast
  the box is can sit at ~0 there however often it repeats. Raising the count cannot make
  this job noisier, which is what makes the trade one-sided: a disagreement is a real race
  by construction. What it buys is **latency to detection, and latency is the blame
  window**.

  The file ORDER is shuffled too (`sequence.shuffle: { files: true }`, `vitest.config.ts`),
  which is what makes the comparison able to see the other kind of nondeterminism. A case
  that depends on state an earlier file left behind fails the same way every run in a fixed
  order, so it lands in the "red, not flaky" column and the comparison never sees it as a
  race at all; shuffling turns it into the disagreement it actually is. Files only — a
  file's cases share one browser session and several are written as a sequence on purpose,
  so the file is the unit of isolation, not the case. The seed is random and printed
  ("Running tests with seed N"); `--sequence.seed=N` replays an order exactly. The mutation
  run does not inherit any of it: `stryker.config.mjs` points at `vitest.mutation.config.ts`,
  and deciding each mutant from one run needs that run repeatable.

  Deliberately not `--retry`, which turns a race into a pass and throws away the evidence
  that there was one. Every "flake" this harness has actually had was a race in the case:
  a probe reply landing after the navigation that destroyed the document it was written
  into, an assertion made before `reportTab` finished its two cookie reads. A run that
  never reached a case counts as a disagreement too — a file that throws on import answers
  for none of its cases, and reading that absence as "unchanged" is how a suite that
  stopped running half of itself stays quiet.

  It also fails on a run that failed **as a whole** with no case to show for it, which is
  a hole it had until the night it was measured. A `beforeAll` that throws records every
  case it owns as `"skipped"` and leaves `numFailedTests` at 0 — byte-identical, at the
  case level, to a deliberate `it.skip`. So a launch that died in every run had every case
  agreeing in every run, and the job printed *"All cases answered the same way 3 times."*
  `launch()` is a `beforeAll` in every e2e file, and no Firefox, no geckodriver, no
  harness server and no `mac/` checkout all arrive that way: the whole tier not running,
  reported as the tier being solid. A run therefore carries the report's own `success`
  (and the process's exit code), **compared rather than merely checked** — checking would
  be wrong, since a genuinely flaky case makes exactly one run exit non-zero and that run
  is the thing to report as a race. A run that collected no cases at all is red for the
  same reason: agreement over nothing is not agreement.

  The comparison has tests of its own (`test/harness/flake-check.test.ts`) for the reason
  the reaper does: it runs where nobody is watching, and a comparison that always answered
  "consistent" would look exactly like a healthy suite. That is not hypothetical here —
  it did, for every shape above.
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
  - **The Firefox floor** (`firefox-floor.test.ts`) — the `strict_min_version` the manifest
    declares, against every `browser.<api>.<method>` in `src/` and every manifest key the
    add-on ships, priced from `@mdn/browser-compat-data`. Nothing else here would notice a
    call that needs a newer Firefox than the add-on is offered on: every level below L4
    runs against a mock, and L4 measures `latest` and `latest-esr` only, so an API added
    in 141 passes every gate in this file and fails on the profiles below it. Both
    directions are inventoried rather than bounded — a call site BCD cannot price fails
    as unpriced rather than passing, and the manifest keys it cannot price are listed with
    the reason each is a value rather than a key. It carries the other two implied floors
    too: the esbuild `target`, pinned to the floor's major, and the Android question the
    floor raises, where the calls Firefox for Android has at no version are derived from
    BCD rather than listed.
  - **The duplicated seed** (`seed-config.test.ts`) — `__CC_CONFIG_YAML__` is supplied
    twice, by `harness/build-extension.ts` for e2e and `vitest.shared.ts` for the unit
    levels, and drift splits the suite's idea of the shipped config while both halves stay
    green.
  - **The suite itself** (`suite.test.ts`) — no committed `.only` (which shrinks CI to one
    case and still reports success), skips limited to the one documented undriveable case,
    and every `// Stryker disable` carrying its justification.
  - **No `runtime.reload()` in `src/`** (`seams.test.ts`) — a config is applied in place, by
    a Save and by a sync adoption alike. Restarting to apply one takes back the single step
    of a save that nothing can observe, and on a temporarily installed extension on 140 ESR
    it does not come back at all.
  - **What the background page keeps** (`retained-state.test.ts`) — every growable
    collection in `src/`, each with a written bound. No other gate asks this: the L3 cases
    drive tens of navigations and `npm test` restarts the world between files, so a
    structure that gains an entry per navigation and loses none is invisible to all of them
    — F10's shape, silent and only visible over time. An
    inventory rather than a measurement, because counting retained bytes means either
    exporting a closure's privates to be counted or timing a heap. Four structures are
    recorded as growing with nothing emptying them, and all four are fine: each holds one
    short string or number, fed by something rarer than browsing. The list is there for
    the fifth.

    It read `new Set` / `new Map` only until 2026-08-26, so an **array was invisible to
    it** — and the fifth it was written for was already present and unseeable:
    `Recording.hosts`, uncapped, and the one collection here that `storage.local` carries
    across a browser restart. The scan now reads a binding (`new Set`, `new Map`, `= [`)
    **and a field initialised empty in an object literal** (`hosts: []`), which is the
    spelling that no declaration-site scan would ever have found. The reach costs it the
    dozen per-call `const out: T[] = []` builders in `src/`; those are listed as bare keys
    in `PER_CALL`, because a row earns its place through its `bound` column and "one call"
    is not something a reader has to weigh. Widening it is what surfaced the cap that
    `MAX_RECORDED_HOSTS` now applies.
  - **The e2e discipline** (`e2e-discipline.test.ts`) — no `driver` in a case, no fixed
    wait, no read-then-compare on an immediate reader, no hand-rolled deadline loop. Each
    has one named exception and nothing else. It exists because the migration that
    established those rules announced them as done in its own commit message and left one
    file carrying every one of them — a `driver.sleep(1000)` as a negative assertion, and a
    poll that read "no tab shows this url" as a pass, so the case went green with its
    navigation removed altogether. Nothing else in the repo would ever have asked.
  - **Release provenance** (`release-provenance.test.ts`) — both publishing paths attest
    the artefacts they publish, attest nothing they do not, hold the two scopes the
    attestation needs, and are checked by `verify-release.yaml` against the tag's own
    commit. The release notes tell a reader to run `gh attestation verify`, so this is a
    published promise; nothing else here reads a workflow, and a second publishing path
    that skipped the attest step would leave those notes advertising a verification that
    fails.
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
- **Type checking** — `tsc --noEmit` at `strict` plus six of the checks `strict` leaves
  out. Four are free here; the two that are not both earn it. `noUncheckedIndexedAccess`
  is why `Action.containers` is `[string, ...string[]]` rather than a comment promising
  the same thing, and it un-deadened two guards the compiler had been treating as
  unreachable. `exactOptionalPropertyTypes` draws the line this codebase actually needs:
  a property mapped *out* of a browser object is `?: T | undefined`, because Firefox
  really does hand over `openerTabId: undefined` — but `CreateTabProps.url` stays strict,
  since there absent and undefined are different requests and only one of them opens the
  new-tab page. Unions are exhaustively `switch`ed with no `default`, so a new variant
  fails to compile until it is handled.
- **Source lint** — `npm run lint` (oxlint, type-aware via `oxlint-tsgolint`), every push,
  seconds. The gate `tsc` is not: TypeScript proves the types line up, this proves the
  *promises* do. Nearly everything here is an async effect behind a synchronously
  registered listener, and the two ways that goes wrong are both invisible to the
  compiler — a promise nobody awaits or catches, and an async function passed where a
  void-returning listener was expected, which in Firefox claims `runtime.onMessage`'s
  reply channel from the sibling that was addressed. Both were conventions kept by hand
  until now; `no-floating-promises` and `no-misused-promises` are the mechanical version.

  Scope is `correctness` plus six type-aware rules and nothing else: `pedantic` is 1193
  findings here and `style` is 5632, none of them a bug, and a check that cries wolf gets
  deleted and takes its invariant with it. Three rules are **off**, each with its reason
  in `.oxlintrc.json` beside it, and one of those reasons is that the rule is wrong about
  this code — every spread `unicorn/no-useless-spread` flags is a snapshot of a collection
  the loop body deletes from.

  What the first run found, beyond style: an `async` callback handed to `clock.setTimeout`
  in the redirector-closer, where a rejection had nobody to reject to; two runtime
  validators (`isPickMessage`, `isRecording`) whose `as` cast had switched off the type
  checking of the very shape they exist to check, so a renamed field would have silently
  stopped being validated; and a `.sort()` over numeric tab ids in an e2e case, which
  orders 10 before 2 — passing only because both sides of the comparison were sorted the
  same wrong way.
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
ticks move only when a decision moves into or out of the gate's five modules —
`src/resolver`, `src/matcher`, `src/psl`, `src/config`, `src/overlays` — never as a score
creeping, since the gate is all-or-nothing.

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

- `.github/workflows/ci.yml` — one `test` job on every push, across a
  `latest`/`latest-esr` Firefox matrix: `typecheck`, `lint`, `audit`, `lint:ext`
  (addons-linter, what AMO runs server-side), `test:coverage`, then `npm test` end to end.
  The static/unit/build/integration split is still not worth its overhead at this size —
  the matrix runs the non-browser steps twice, which is seconds against the minutes the
  browser suite costs and which genuinely differ between channels. `fail-fast: false`, so
  one channel going red never hides the other's answer.
- `.github/workflows/nightly.yml` — five guard rails: `disposal-realtime`, `mutation`,
  `flake`, `firefox-nightly` and `reproducible-build`, plus a `report-regression` job that
  opens **one** issue per failing rail for a failing streak and comments on it thereafter.
  Scheduled runs go unwatched, so a red night has to come and find us; the rails fail for
  unrelated reasons and are fixed by different work, so they get an issue each, and each
  issue body says what the two or three shapes of that failure mean.
- `.github/workflows/verify-release.yaml` — the per-release half of the reproducibility
  gate above, `workflow_call`ed by `ci.yml` and `release.yaml` with the tag they just
  published, so it never has to go looking for its subject. It installs with
  `package-manager-cache: false` on purpose: a job deciding whether a published artefact
  is trustworthy must not take its dependencies from a mutable cache an earlier run could
  have poisoned.
- `.github/workflows/check-actions.yaml` — `actionlint` and `zizmor` over the workflows
  themselves, on every push and PR. zizmor fails the build on any finding and there are no
  suppressions.

## What CI still can't catch

- **Real disposal under background suspension** — the nightly real-delay case exercises
  the five-minute timer but not Firefox actually evicting the background context for
  minutes. Residual risk on F8/F10; mitigated by the L3 restart harness and dogfooding.
- **Real IdP quirks** — the mock IdP covers code and SAML-POST shapes, not every vendor's
  nonstandard flow. F9 in the wild needs the author's real logins.
- **What ESR does that `latest` does not, beyond what the suite asserts.** The matrix's
  first run found three cases whose green depended on `latest`'s timing, and all three
  were the suite's assumptions rather than CC's behaviour: `tabs.create({})` answering
  with a pre-commit `about:blank` snapshot on ESR (which is why auto-temp watches
  `onTabUpdated` too, so ESR is the only channel exercising that path), Marionette raising
  `NoSuchWindowError` when Esc closes the tab the keystroke went to, and a fixed wait for a
  `runtime.reload()`. A fourth was a real platform difference and the one case ESR could not
  run: `runtime.reload()` does not bring a temporarily installed extension back on 140 ESR,
  so nothing about a config save was observable there. That is what a save applying its
  config in place removed — the case now runs on both channels, measured against
  140.14.0esr, and no shipped path depends on the extension coming back.
- **Firefox API drift** — narrowed rather than closed. The `latest`/`latest-esr` matrix
  blocks every push and the nightly **Nightly** tripwire gives months of notice, but all
  three run the same suite: a behaviour no case asserts can still change under us. The
  measured facts are the exposed ones, and CLAUDE.md names them — `onBeforeNavigate`
  firing before that navigation's `webRequest`, `tabs.create` refusing `about:newtab`,
  `windowId` being honoured for popup windows, `onCreated` firing with `about:blank` first.
- **Whether a green channel means a green browser** — the matrix proves the suite passes
  on two builds, not that CC behaves identically on them. A difference neither channel's
  run asserts is invisible to both.
