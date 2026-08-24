# Fitness Functions — Design

**Date:** 2026-08-24
**Status:** Implemented (first batch)
**Topic:** Executable checks on the *shape* of the codebase and the *cost* of its hot
path, rather than on its behaviour — the quality criteria this project already states in
prose and has, until now, kept true by hand.

## 1. Goal & scope

The behavioural coverage here is unusually complete: five levels, a 100% mutation gate
over the pure modules, a coverage floor on the deterministic ones, fourteen named
failure classes each with an owner. What none of it measures is the set of properties
that make those levels *mean* anything:

- The resolver is pure. That is why F3–F6 and F11 live at L1 and why the mutation gate's
  100% is a statement about anything at all. Nothing enforces it — `import type {
  BrowserPort }` into `resolve.ts` compiles, and every test stays green.
- One handler per browser event. `test/engine/mock-port.ts` keeps a single slot per
  event, so a second registration in `src/` silently displaces the first and L3 stops
  seeing a behaviour it believes it drives.
- The manifest holds exactly the permissions the code needs. CLAUDE.md opens its Firefox
  section with four whose absence produces no error at all.
- The blocking handler is cheap. Every design note about the pause seam being
  synchronous, the armed set being hydrated at startup, and the MAC handshake sitting
  *after* the decision is a latency argument — and latency is the one quality criterion
  in this project that no test measures.

These are architecture **fitness functions** in the Building-Evolutionary-Architectures
sense: an objective, automated check on a structural or cross-cutting property that
would otherwise be preserved only by whoever remembers it. They are cheap (milliseconds,
no browser) and they run inside `npm test` with everything else.

### In scope

`test/fitness/`, six files, twenty-one cases:

| File | Asks |
|---|---|
| `seams.test.ts` | Are the pure modules still pure, and is `browser.*` still confined to the five files allowed to touch it? |
| `listeners.test.ts` | Is every browser event registered exactly where the inventory says? |
| `manifest.test.ts` | Do the declared permissions and the called APIs still agree — in **both** directions? |
| `seed-config.test.ts` | Do the two hand-copied test seeds still say the same thing? |
| `suite.test.ts` | Did the run that reported green actually run everything? |
| `decision-cost.test.ts` | What does a navigation pay, in round trips, to be decided? |

### Out of scope

- **A wall-clock performance budget.** Milliseconds in CI are a flake generator, and the
  number would be about the runner. Round trips are what the design is actually about
  and they are exact.
- **Bundle-size budgets.** Real, but this bundle is an esbuild of `src/` with two
  dependencies; the number would move for reasons nobody would act on.
- **A doc-link checker.** Considered and dropped from the first batch: the failure it
  catches (a stale relative link) is visible to any reader, unlike everything above.

## 2. What makes a fitness function worth its place here

Three rules, each learned from a gate this repo already has:

1. **An exact inventory, never a bound.** `expect(sites).toEqual([...])`, not
   `toHaveLength(≤ 2)`. A bound absorbs the next violation silently; an inventory forces
   the person adding a registration to come and write down why. This is the coverage
   gate's "excluding a file is not one of the exits", applied to structure.
2. **No false alarms, ever.** The first draft of `listeners.test.ts` pinned line numbers
   and would have failed on any edit above a registration. A fitness function that cries
   wolf is one that gets deleted in three months, and it takes its invariant with it.
   Hence: comments stripped before matching (this codebase names the very APIs it is
   careful not to call), and files, not lines, as the unit of identity.
3. **The reason lives in the check.** Every allowlist entry carries the sentence that
   justifies it, the way `stryker.config.mjs`'s four disables and the coverage config's
   three exclusions do. An allowlist without reasons is a list of things nobody
   remembers agreeing to.

## 3. The round-trip budget

`decision-cost.test.ts` is the one that is not a static check, and the only new *kind* of
gate here. `onBeforeRequest` is blocking: Firefox holds the request until the handler's
promise settles, so every awaited call before the answer is latency in front of a page
load, on every navigation in the browser.

It wraps the port in a counting `Proxy` and asserts the exact call sequence for four
paths:

| Path | Budget | Why that number |
|---|---|---|
| Already in the right container | `getTab`, `getIdentity` | The common case by a wide margin. There is no third question to ask about a navigation that is already where it belongs. |
| A container the config names | `getTab`, `sendExternalMessage`, `queryIdentities`, `createIdentity`, `createTab` | MAC is asked **after** the decision — it is a round trip to another extension, and a navigation we were never going to act on must not pay for it. |
| Container armed (paused) | `getTab`, `getIdentity` | The pause seam is synchronous by contract. An `await` in `isPaused` or `record` would be paid on every navigation in the one place the user asked CC to do *less*. |
| The hops of a reopen we performed | *nothing* | `reopenedNav` answers the reopened tab's own request, and every redirect hop of it, without going near the browser. |

Four mutations were revert-verified against it: MAC moved before the decision, an extra
container lookup on the common path, the `reopenedNav` fast path disabled, and a storage
read added to the armed path. Each turns exactly one case red, naming the call that
appeared.

## 4. What the first run found

`listeners.test.ts` was written expecting one registration per event and found three
events with two, of which one is benign and two are not:

- **`onBeforeRequest`** — two call sites, one listener. `wireBackground`'s `gatedPort`
  wraps the event and the engine registers on the wrapper. A chain, not a fan-out.
- **`onTabRemoved`** — `createDisposer` and `createPause` both register on the raw port,
  and the disposer is constructed second. Under `mock-port`'s single slot the disposer
  wins, so **pause's disarm-on-empty is not wired in any L3 case that drives the composed
  background**. Verified directly: arm a container through `wireBackground`, close its
  last tab, and `isPaused` still answers true. `test/engine/pause.test.ts` passes because
  it builds a `createPause` on a port of its own.
- **`onTabUpdated`** — `createAutoTemp` and `createRedirectorCloser`, same shape, same
  result: at L3 auto-temp is driven by `onTabCreated` alone. That is precisely the
  configuration CLAUDE.md records as having passed L3 and failed in real Firefox, because
  bug 1586612 makes `onCreated` fire with `about:blank` before the real url.

Both are blind spots at L3 rather than shipped bugs — Firefox's `tabs.onRemoved` and
`tabs.onUpdated` are additive, so both listeners run in the browser, and the e2e level
covers the behaviours end to end. Recorded in `FOLLOWUPS.md` with the two candidate
fixes rather than fixed here: one of them changes `src/` to satisfy a test double, the
other changes the mock's fidelity contract and invalidates three CLAUDE.md notes that
lean on it. That is the author's call, not a drive-by.

The point worth keeping: the check found this on its first run, in a codebase whose
own documentation had already written the hazard down twice.
