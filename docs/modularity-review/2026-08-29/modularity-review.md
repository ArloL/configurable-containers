# Modularity Review

**Scope**: Entire codebase — `src/` (resolver, matcher, psl, overlays, config, engine, extension), `harness/`, and the `test/` seams that shape the design
**Date**: 2026-08-29

## Executive Summary

Configurable Containers is a Firefox WebExtension that routes each site into the right container from one user-authored config, replacing what Multi-Account Containers and Temporary Containers do separately. Its [modularity](https://coupling.dev/posts/core-concepts/modularity/) is unusually healthy: the routing decision is a pure function, effects sit behind a narrow port, the overlays reuse the router's own `matchRule` so precedence cannot drift, and the two highest-[distance](https://coupling.dev/posts/dimensions-of-coupling/distance/) boundaries in the system — `storage.sync` across machines and the config YAML across builds — both carry real versioned [integration contracts](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/). A fitness suite reads `src/` as text to keep those properties from eroding.

The one genuinely [unbalanced](https://coupling.dev/posts/core-concepts/balance/) integration is the pause-and-record feature. A single type, `Recording`, is simultaneously the in-memory model, the `storage.local` persisted schema, the message-reply wire type, and the options page's render model — four roles across a realm boundary and a version boundary, in the most [volatile](https://coupling.dev/posts/dimensions-of-coupling/volatility/) part of the codebase. It has already broken once (the `readRecording`/`readHost`/`readUrl` normalizers exist because a build that trusted the stored shape would have called `.find` on `undefined` inside the blocking handler), and it is the only place in `src/` with a module-level import cycle.

Two conclusions worth stating up front because they run against instinct. The engine's guard family — `handled`, `reopenedNav`, `viewSourceNav`, `inTurn` — was named as a pain point, and under this model it is **correctly designed**: high [strength](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) at the lowest possible distance is [high cohesion](https://coupling.dev/posts/core-concepts/balance/), and extracting a guard into a sibling would raise distance without lowering strength. And the MV2 blocking-`webRequest` dependency, which would otherwise be the headline finding, is neutralised by low volatility: no migration is planned.

## Coupling Overview

| Integration | [Strength](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) | [Distance](https://coupling.dev/posts/dimensions-of-coupling/distance/) | [Volatility](https://coupling.dev/posts/dimensions-of-coupling/volatility/) | [Balanced?](https://coupling.dev/posts/core-concepts/balance/) |
| --- | --- | --- | --- | --- |
| `engine/pause.ts` ↔ `extension/pause-protocol.ts` ↔ `extension/options.ts` | [Model](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/), trending [functional](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) | High — separate realms, separate bundles, plus a time boundary via `storage.local` | High — the shape changed on 2026-08-26 | **No** — Issue 1 |
| `harness/` + `test/e2e/` → the running extension | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — but a contract that carries effects, not causes | High — separate process, separate add-on, async relay | High — the named pain point | **No** — Issue 2 |
| `wiring.ts` → six siblings via one mutated `Config` object | [Functional](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) (common coupling), **implicit** | Low — one construction site, one mutation site | High — config is the core | Balanced by distance; the *implicitness* is Issue 3 |
| `config/parse.ts` → `engine/registry.ts` (`isThrowawayName`) | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) | Low, but the layer direction is inverted | Low — `tmp<N>` has one shape | Balanced; direction is Issue 4 |
| `extension/options.ts` → `engine/pause.ts` (`PAUSE_STORAGE_KEY`) | [Intrusive](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/)-adjacent — names another module's private storage key | Medium — crosses the realm boundary | Medium | Marginal — Issue 5 |
| `resolver/resolve.ts` → `matcher`/`psl` via injected `Deps` | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — `Matcher = unknown`, fully opaque | Low, pinned by `fitness/seams.test.ts` | High (core) | **Yes** — exemplary |
| `overlays/*` → routing via the same `matchRule` | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — one injected function, never a duplicated rule | Low | High | **Yes** — exemplary |
| `engine/engine.ts` internal guard family | [Functional](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/), high degree ([connascence of execution order](https://coupling.dev/posts/related-topics/connascence/)) | Lowest possible — one function | High | **Yes** — [high cohesion](https://coupling.dev/posts/core-concepts/balance/), correctly located |
| `config/sync-record.ts` ↔ another machine's build | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — `SyncMeta.v`, hash, absent/incomplete/unreadable/ok | Highest in the system | Low–medium | **Yes** — the model done exactly right |
| `config/parse.ts` ↔ the user's hand-written YAML | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — `CONFIG_VERSION`, `FEATURE_VERSIONS`, gated leniency | High — an artifact CC does not own, read by builds of different ages | Medium | **Yes** |
| `engine/engine.ts` → MAC via `sendExternalMessage` | [Contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — one method, throws swallowed | Maximum — another organisation's add-on | Low | **Yes** |
| `engine/port.ts` → Firefox `browser.*` | [Functional](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — undocumented event ordering, measured facts, known bugs | Maximum — no coordination, independent release cadence | Medium–high | **Unbalanceable by nature**; mitigated, see below |
| `src/engine/*` ↔ `test/engine/mock-port.ts` | [Functional](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) — the mock reimplements Firefox's requirements | Low — same repo, same author | Medium | Balanced by distance; leakage noted in Issue 6 |
| MV2 blocking `webRequest` semantics → the whole engine | [Functional](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) | Maximum | **Low** — no migration planned | **Yes** — neutralised by low volatility |

### A note on the level of abstraction

The [balanced coupling model is fractal](https://coupling.dev/posts/core-concepts/balance/), so the analysis has to name the level it operates at. This project is one deployable built by one author (324 of 437 commits over two months), so [socio-technical distance](https://coupling.dev/posts/dimensions-of-coupling/distance/) is near zero everywhere inside the repository — there is no team boundary to raise the cost of a cross-module change. That materially lowers the severity of most in-repo coupling, and it is why several integrations that would be findings in a multi-team system are recorded above as balanced.

The genuinely high-distance boundaries are all *external*, and all of them are boundaries in time or process rather than in org chart:

- Firefox itself (independent release cadence, no coordination)
- Multi-Account Containers (another organisation's add-on)
- `storage.sync` (another machine, possibly another build version)
- `storage.local` (this machine, a *future* build — a time boundary)
- the user's config YAML (an artifact the user owns and hand-edits)
- the background context ↔ the options and choice pages (separate JS realms, separate esbuild outputs, async message passing)

Every issue below sits on one of those.

## Issue: `Recording` is four types wearing one name

**Integration**: `engine/pause.ts` ↔ `extension/pause-protocol.ts` ↔ `extension/options.ts` ↔ `storage.local`
**Severity**: Significant

### Knowledge Leakage

`Recording`, `RecordedHost` and `RecordedUrl` are defined once in `src/engine/pause.ts` and serve four distinct roles:

1. the in-memory model `record()` mutates on the blocking path;
2. the `storage.local` persisted schema — `snapshot()` writes `PauseState` verbatim, so the type *is* the disk format;
3. the message-reply wire type — `PauseStatusResponse.recordings: Recording[]` ships it unchanged across the realm boundary;
4. the options page's render model — `renderRecording` reads `.hosts`, `.urls`, `.dropped`, `.wouldHave` directly.

This is [model coupling](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) at minimum, and it behaves as [functional coupling](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/): the persisted form and the rendered form are required to change together, because they are the same declaration.

The leakage is already visible in the type itself. `RecordedHost.dropped` is required while `Recording.dropped` is optional, and the reason given in the source is purely about what an *older build* wrote to disk — a persistence concern that has surfaced in a type the render layer also consumes. `readRecording`/`readHost`/`readUrl` exist because the previous `isRecording` type guard was not enough: a host row written before URL detail existed has no `urls`, and a build that trusted the stored shape would have called `.find` on `undefined` **inside the blocking `onBeforeRequest` handler**, where a throw is a navigation that never completes.

It is also the only module-level import cycle in `src/`: `engine/pause.ts` imports four types from `extension/pause-protocol.ts`, which imports `Recording` back from `engine/pause.ts`. Type-only, so no runtime cycle — but a knowledge cycle across a layer boundary the codebase polices hard elsewhere. `test/fitness/seams.test.ts` forbids exactly this direction for `src/resolver`, `src/matcher` and `src/psl`; no rule covers `src/engine` reaching into `src/extension`.

A third strand runs through the same module. `pause.ts` imports `targetLabel` from `engine.ts` — the *only* import that makes `pause.ts` depend on the engine, and `pause.ts` is `targetLabel`'s only external consumer. Sharing that function is right (the record and the F9 toast must use the same words), but its current home means the pause module drags the engine into its dependency graph, and through `options.ts` into the options page's.

### Complexity Impact

Adding a field to a recording row means holding four things at once: what the blocking-path writer does with it, what a normalizer must fill in when an older build's row lacks it, what the message reply now carries, and what the page renders. Adding a field to a *render* row means asking whether it needs to be persisted — a question the type does not pose, so the default answer is "yes, because it is the same type." That is four units of working memory for a change that ought to need one, and the units are not independent: the normalizer's behaviour depends on the persistence decision, which depends on the render need.

The blocking-path constraint sharpens it. `record()` runs inside `onBeforeRequest`, so a shape mismatch is not a rendering bug — it is a navigation that never completes. The distance between where a mistake is made (a type declaration read by the options page) and where it is paid (a hung tab) is exactly the [unpredictability](https://coupling.dev/posts/core-concepts/complexity/) modular design exists to remove.

### Cascading Changes

- **Adding a field the page needs to display.** It lands in the persisted schema whether or not it should, and every stored recording written before the change now needs a normalizer arm. This has already happened once, on 2026-08-26, for `urls` and both `dropped` counters.
- **Changing how a host row is summarised.** `VARIED` is currently computed in `record()` on the blocking path and stored. If the presentation of "this host resolved two ways" changes, the change is to persisted data written under a latency constraint, not to a renderer.
- **Removing or renaming a field.** Every recording on every dogfooder's profile is now unreadable by the normalizer, which silently drops it — losing browsing history the user armed a container specifically to capture.
- **The options page pulling in more of the engine.** `engine.ts` is currently absent from the options bundle only because esbuild tree-shakes `createPause` and therefore `targetLabel`. Any future options-page import that reaches `createPause` pulls `engine.ts`, `resolve.ts`, `supersede.ts`, `registry.ts` and `port.ts` into a page bundle, with no test that would notice.

### Recommended Improvement

**Do not decompose further.** Distance is already high — separate realms and a time boundary. Splitting the module would raise it without touching the strength, which is the move that manufactures a distributed monolith in miniature. Reduce [strength](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) instead, by giving the boundary the [integration contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) that `sync-record.ts` already has for the harder boundary next door.

Three moves, none of them large:

1. **Split one type into three.** `StoredRecording` (what `hydrate` reads, and the only shape allowed to carry an optional field for backward compatibility), `Recording` (in-memory, all fields required), and `RecordingView` (what `PauseStatusResponse` carries and the page renders). The normalizer already *is* an [anti-corruption layer](https://coupling.dev/posts/related-topics/domain-driven-design/); it just has no distinct type on its far side, so nothing prevents the disk shape and the render shape drifting into each other. With `RecordingView` owned by `pause-protocol.ts`, the import cycle disappears — the protocol module imports nothing from `engine/`.

2. **Move `targetLabel`, `namesAConfiguredContainer` and `Declinable` out of `engine.ts`.** They are presentation of a `Decision`, which is a resolver concept, not an engine one. A small `decision-label.ts` beside the resolver removes the `pause → engine` edge entirely, and with it the tree-shaking dependency that keeps `engine.ts` out of the options bundle by luck rather than by rule.

3. **Extend the `fitness/seams.test.ts` layering rule** to forbid `src/engine/**` importing from `src/extension/**`. The rule already exists in the exact shape needed for the pure modules — an exact import inventory rather than a bound — and this is the direction it does not yet cover.

**Trade-off.** Three types where there is one is more declaration to read, and two of them will be structurally identical on the day they are written. That cost is real and it is the standard objection to DTOs. It is worth paying here for one specific reason: this shape has already changed under a live install base, the normalizers that absorbed that change exist and are tested, and the next change will arrive the same way. The three types are where the normalizer's job becomes statable in the type system instead of in a comment.

## Issue: the e2e boundary returns effects, never causes

**Integration**: `harness/browser/` + `test/e2e/` → the running extension
**Severity**: Significant

### Knowledge Leakage

This is the inverse of the usual finding: the boundary is *too* thin, and the missing knowledge is diagnostic rather than functional.

The e2e layer observes CC only through what the probe extension writes into an http(s) page's DOM — `CSID:<store>` in the title, `data-cc-container`, `data-cc-containers`, `data-cc-cookies-here`, `data-cc-script-at-start`. `harness/browser/`'s `PageReport` diagnoses the *browser*: current url, ids present in the document, the tab list with `GONE` markers, and it is carefully built to survive its own tab being closed. Nothing anywhere reports the *extension's* reasoning.

So the return channel across the highest-distance boundary in the test suite carries CC's **effects** (a tab exists in container X) and never its **causes** (CC resolved `reopen → Work`, then declined because the method was POST). The [contract](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) is clean — which is why this is Significant and not Critical — but it is under-specified for the job it has to do.

### Complexity Impact

This is the pain point you named, and it is [complexity in the Cynefin sense](https://coupling.dev/posts/core-concepts/complexity/) precisely: the only way to determine why a run failed is to change something and observe what happens. CLAUDE.md already documents the cost — *"a bare timeout is that regression's signature, not flake"* for the F9 case, and separately that a missing `mac/` checkout surfaces as a bare `ENOENT`. A red e2e reading `timed out after 30000ms` can mean a POST-guard regression that wedged the tab, a dead window handle, a probe relay that went unanswered because the driver was parked on a `moz-extension://` page, a config that did not apply, a load-dependent race in options-page hydration, or genuine flake.

Six candidate causes for one signal is well past the 4±1 units a person holds at once, which is why diagnosis is expensive even though each individual hazard is documented.

### Cascading Changes

- **Every new e2e case inherits the whole hazard list.** Because the failure signal does not discriminate, a case author must pre-emptively avoid all six causes rather than diagnose the one that fired. That is why `test/fitness/e2e-discipline.test.ts` has to encode the rules structurally — no `driver`, no sleep, no read-then-compare, no deadline loop — and why the migration that established those rules left a file breaking every one of them.
- **A change to routing that regresses a guard costs a full timeout per affected case** before anyone learns anything, and the report at the end names a selector, not a decision.
- **The cost compounds under CI load**, where the races are load-dependent and reproduce nowhere else — 40 rounds on an idle machine reproduced the options-page hydration race zero times.

### Recommended Improvement

Widen the contract to carry causes. CC already computes a `Decision` per navigation and already has one function that renders one into words — `targetLabel`, whose whole reason for existing is that the F9 toast and the pause record must not drift. A build-time-gated decision log, echoed to the probe the way notifications already are, would let `Page.diagnose()` answer *"CC last decided `reopen → Work` for `https://…`, then declined: non-GET"* instead of naming a selector that never appeared.

The mechanism already exists and is proven: `__CC_NOTIFY_ECHO_TO__` echoes notifications to the probe for exactly this reason — so that an e2e can observe a toast that lives in no DOM. A decision echo is the same shape one level up.

Three constraints that must be respected, all of them already written down in CLAUDE.md:

- **`__CC_NOTIFY_ECHO_TO__` must be sent *after* `notifications.create` resolves**, or a missing permission yields a green test with the feature broken. A decision echo has the same hazard inverted: echo the decision the engine *acted on*, at the point it acts, not the one it computed.
- **It costs byte-equivalence.** `launch()` already sets the notify echo unconditionally, so no test build is byte-equivalent to a packaged one. This adds a second such define rather than a first, which is the honest way to price it.
- **It must not be a behaviour seed.** CLAUDE.md rightly forbids a build-time seed that arms a container, because it would make the shipped extension capable of starting with routing disabled. A decision log is read-only and changes no routing — that distinction is what makes it acceptable where the arm seed is not, and it should be stated in the code so the rule is not read as broken.

**Trade-off.** One more build-time define, one more thing the probe knows how to receive, and a small amount of engine code on the decision path guarded by a constant esbuild folds away in shipped builds. Against that: the single most expensive activity in the repository — working out what a red e2e means — gets a first-class answer instead of a search. Given that the e2e suite is the only level that sees a real Firefox, and that Firefox is the one dependency whose coupling cannot be rebalanced, improving what that level *tells you* is the highest-leverage change available.

## Issue: the live `Config` object's mutation contract is invisible

**Integration**: `extension/wiring.ts` → `engine`, `picker`, `cookie-seeder`, `redirector-closer`, `script-injector`
**Severity**: Minor

### Knowledge Leakage

`wireBackground` creates one `Config` object and fills it in place with `Object.assign` inside `useConfig`. Six siblings hold a reference to that same object. The invariant every one of them depends on — *this object mutates under you; read it at event time, never at construction* — appears nowhere in any type. `CookieSeederOptions { config: Config }` is indistinguishable from a signature that takes a snapshot.

In classic terms this is **common coupling**, which maps to [functional coupling](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) in this model, and it is **implicit** — the dangerous half of the [implicit/explicit spectrum](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/).

Half the failure mode is already closed, and closed well: `useConfig` spells out `{ rules: loaded.rules, groups: loaded.groups }` as a `Required<Config>` so that a key added to `Config` later fails to compile rather than silently retaining whatever the previous config left. The other half is open: a sibling that destructures `const { rules } = config` at construction time freezes on the empty config forever, and nothing would catch it — not the compiler, not the coverage gate, and not an L3 case, since the composed-background tests apply a config before navigating.

### Complexity Impact

Low, today. All six siblings are correct, all are in one directory, and `wiring.ts`'s own comment explains the rule at length. The [distance](https://coupling.dev/posts/dimensions-of-coupling/distance/) is minimal — one construction site, one mutation site, same file — so high strength here is [high cohesion](https://coupling.dev/posts/core-concepts/balance/) and the coupling is balanced. What is not balanced is that the rule survives on prose and reviewer attention rather than on anything mechanical, in the module whose whole job is to be the place startup order cannot drift.

### Cascading Changes

The realistic trigger is a seventh sibling. Adding one means reading `wiring.ts`'s comment and understanding why the object is mutated rather than replaced — and the natural, idiomatic way to write a factory that takes a config is to destructure what it needs. `script-injector` is the informative exception: it reads the config eagerly, so it takes it as an argument to `apply(config)` rather than holding a reference, which is exactly the contract form.

### Recommended Improvement

Convert the shared object into a contract without moving anything. Hand siblings a `getConfig(): Config` accessor instead of a `config: Config` reference. A function cannot be destructured into a stale snapshot, so the rule becomes unstatable-wrongly rather than merely documented. `script-injector`'s existing `apply(config)` shape already demonstrates the pattern from the other direction.

**Trade-off.** A call at each read site rather than a property access, and a small amount of churn across six modules for a bug that has not happened. That is why this is Minor: distance already neutralises the strength, and the recommendation is worth taking opportunistically — when the seventh sibling is written, not before.

## Issue: `config/parse.ts` reaches down into `engine/registry.ts`

**Integration**: `config/parse.ts` → `engine/registry.ts`
**Severity**: Minor

### Knowledge Leakage

`parseConfig` imports `isThrowawayName` from `src/engine/registry.ts` to refuse a container named `tmp<N>`. The reason given is sound and the alternative would be worse: *"imported rather than restated so the two halves cannot drift."* Duplicating the `/^tmp(\d+)$/` shape is exactly the silent divergence this codebase is built to prevent — on the prefix alone, a user's `tmpwork` gets deleted by the disposer with its logins in it.

The problem is the direction, not the sharing. A pure data layer now depends on an engine module, and the fitness suite cannot see it: `seams.test.ts` forbids the inverted edge for `src/resolver`, `src/matcher` and `src/psl`, and `src/config` is not in that list.

The consequence is measurable. `src/engine/registry.ts` is in the **options page bundle**, reached through `config/parse.ts`, for one seven-line predicate.

### Complexity Impact

Minimal. `TMP_NAME` has one shape, no reason to change, and both halves of the naming contract are documented in each other's terms. [Volatility is low](https://coupling.dev/posts/dimensions-of-coupling/volatility/), which under the balance rule neutralises the imbalance outright.

### Cascading Changes

None likely. The one scenario worth naming: if the throwaway naming scheme ever changes — a different prefix, or identity carried somewhere other than the name — the change lands in a file the config parser imports, which is a surprising blast radius for a rename. `config/parse` refusing `tmp<N>` and `registry` minting it are genuinely two halves of one rule, so they should move together; the question is only where "together" is.

### Recommended Improvement

Move `isThrowawayName` and `TMP_PREFIX` to `src/resolver/types.ts`, which already owns the other half of this vocabulary — the reserved container name `TEMPORARY`. Both `config/parse` and `engine/registry` then import *down* rather than one importing sideways into the other, the layer direction becomes statable, and `registry.ts` leaves the options bundle.

Then extend `fitness/seams.test.ts`'s pure-module import inventory to cover `src/config`, so the direction is enforced rather than remembered.

**Trade-off.** It puts a naming policy in a types module, which is a slightly odd home for a regex. The alternative — a `src/naming.ts` of its own — is a file for two exports. Given `resolver/types.ts` already declares `TEMPORARY` with a comment calling it "the reserved container name," the vocabulary is already there and this completes it.

## Issue: the options page knows the background's private storage key

**Integration**: `extension/options.ts` → `engine/pause.ts`
**Severity**: Minor

### Knowledge Leakage

`options.ts` imports `PAUSE_STORAGE_KEY` and subscribes to `storage.onChanged`, filtering on that key to know when to re-render. It is scrupulous about not *reading* the value — the comment is explicit that the data still arrives through a message so the background stays the only reader of its own storage shape, and that reasoning is correct. But it names a private storage key belonging to another module across the realm boundary, which is [intrusive coupling](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) in miniature: the key is an implementation detail of how `pause.ts` persists, not part of any protocol.

A second, verifiable detail. The nearby comment explaining why `MAX_RECORDED_HOSTS` is *not* imported says that doing so *"would pull the background's pause module, and with it the engine, into the options bundle."* Measured against the actual build: `src/engine/pause.ts` is **already** in the options bundle, via this very import, and `src/engine/engine.ts` is **not** — esbuild tree-shakes `createPause` and therefore `targetLabel`. Importing the constant would cost zero additional bytes.

In a codebase where the reasoning is the artifact — where CLAUDE.md exists to record why a reasonable-looking change is wrong — a decision resting on a premise that is measurably false is worth correcting even when the decision itself does no harm.

### Complexity Impact

Small and contained. The consequence today is a slightly worse message: the page says "the per-host cap was reached" without naming the number, because naming it was thought to cost the engine.

### Cascading Changes

Renaming the storage key breaks the options page's live refresh silently — the subscription simply stops firing, the page stops updating, and nothing fails. Small, but exactly the silent-wrong-answer class this project cares about most.

### Recommended Improvement

Move `PAUSE_STORAGE_KEY` into `pause-protocol.ts`, which both sides already import and which exists to be the shared vocabulary of this boundary. The key stops being private-and-borrowed and becomes part of the declared protocol, which is what it has been functioning as. This folds naturally into Issue 1's third move, since `pause-protocol.ts` is being reworked to break the import cycle anyway.

Then either correct the bundle comment or delete it — with `RecordingView` and `PAUSE_STORAGE_KEY` living in the protocol module, `options.ts` need not import from `src/engine/` at all, and the question the comment answers stops arising.

**Trade-off.** None worth the word. It is a constant moving one file.

## What is working, and why it should not be changed

A review that only lists problems misreads a codebase this deliberate. Four things here are [balanced coupling](https://coupling.dev/posts/core-concepts/balance/) done correctly, and three of them are load-bearing enough that a future refactor should be checked against them.

**The engine's guard family is correctly located.** `handled`, `reopenedNav`, `viewSourceNav` and `inTurn` share [connascence of execution order](https://coupling.dev/posts/related-topics/connascence/) — one of the strongest degrees of [functional coupling](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) there is — and `navigate()`'s ordering constraints are each paid for by a named bug. That is very high strength at the lowest distance the system has: one function, adjacent lines. Under the [balance rule](https://coupling.dev/posts/core-concepts/balance/) that is [high cohesion](https://coupling.dev/posts/core-concepts/balance/), which is a form of balanced coupling, not a defect. CLAUDE.md's rule that a guard on the engine's own webRequest handling stays in `engine.ts` is the right call, and the instinct to extract one into a sibling is the wrong one: it would raise distance without lowering strength, converting cohesion into tight coupling. The pain here is essential complexity correctly placed, and it is already pinned behaviourally — `test/engine/engine.test.ts` asserts the ordering as behaviour ("raises no declination notification for a POST", "shows no choice screen in a paused container, and records that one was due") rather than leaving it to prose alone.

**`sync-record.ts` is the reference implementation.** Highest distance in the system — another machine, possibly another build version, no coordination, fully async — met with the lowest [strength](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/): a versioned meta record, a hash rather than a length, four explicitly distinguished remote states, and a pure `reconcile` whose two convergence properties are named and defended. This is what Issue 1's boundary should look like when it is done.

**The `Deps` injection and the shared `matchRule`.** `resolve()` holds matchers as `unknown` and never interprets them; the overlays take the router's own `matchRule` as a parameter rather than reimplementing precedence. Both are [contract coupling](https://coupling.dev/posts/dimensions-of-coupling/integration-strength/) in the most useful sense — one shared function instead of one shared rule — and they are what make the mutation gate reachable at 100% on the pure modules.

**The unbalanceable coupling is detected rather than denied.** CC depends on Firefox *functionally* — undocumented event ordering, `view-source:` reporting the inner url, `tabs.create` rejecting `about:newtab`, bug 1586612, the FF153 measurement that `onBeforeNavigate` precedes the request. That strength cannot be lowered, and Mozilla's distance cannot be closed. The answer taken here is the right one: L4/L5 against a real browser on two channels plus a Nightly tripwire, which converts an unbalanceable coupling into a *monitored* one. 156.0a1's widening of the privileged-context check took nine cases down at once, which is the tripwire working.

One caveat inside that success, and it is the reason Issue 6 is folded in here rather than raised separately: **Firefox facts leak outside the port.** `"firefox-default"` is spelled independently in four places — twice inline in `registry.ts`, as `DEFAULT_STORE_ID` in `pause.ts`, and in `auto-temp.ts` and `browser-port.ts`. `supersede.ts` owns the `EMPTY_PAGES` allow-list, `sync-record.ts` owns Firefox's two quota constants, `auto-temp.ts` owns bug 1586612, and `resolve.ts` — a module the fitness suite certifies as pure — carries `/^https?:/` on `current.url` because a pre-commit tab reads `about:blank`. Individually all are justified and documented. Collectively they mean the question *"what does CC assume about Firefox?"* has no single answer, which is [low cohesion](https://coupling.dev/posts/core-concepts/balance/): high-distance knowledge smeared across low-distance modules. The `"firefox-default"` literal is the one worth consolidating now, because it is the one that can actually diverge — `pause.ts` and `registry.ts` independently spell a value that must be identical, and neither imports the other.

---

_This analysis was performed using the [Balanced Coupling](https://coupling.dev) model by [Vlad Khononov](https://vladikk.com)._
