# F8 — Background Restart Injection — Design

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan
**Topic:** Give F8 (background restart mid-flow) a real L3 owner: a harness that drops every
in-memory guard and re-runs the invariants against the same browser, plus the extraction that
lets it drive the *actual* startup path rather than a test-local imitation of it.

## 1. Goal & scope

`TESTING.md`'s subtle-bug matrix ticks L3 ✅ for F8. Nothing in `test/` mentions a restart. The
tick is fiction, and F8 is the only class in the table with no test anywhere.

It is also the only class `TESTING.md` claims *only* L3 can catch — "a class unit tests
structurally cannot see" — and the one whose stated requirement is a design constraint on the
source, not just on the tests:

> Guard state must therefore be reconstructible from `browser.*` queries or persisted — the
> test enforces that.

Nothing enforces it today. Two reconstructions exist (`highestTmpSuffix` in
`src/engine/registry.ts`, the disposer's startup `queryTabs` + `sweep(true)`) and **both can be
deleted with the suite staying green.** That is the hole this slice closes.

### F8 is reachable today, not only under MV3

The manifest is MV2 with a persistent background page, so it is tempting to file F8 as
prospective. It is not. `src/extension/options.ts:50` calls `browser.runtime.reload()` on every
config save. That is a background restart, in the shipping build, at a moment the user chooses —
and `src/engine/engine.ts:91` already reasons about it for `warnedHosts`. F8 is a present-day
class with a present-day trigger; MV3 would only make the trigger involuntary.

### In scope

- `src/extension/wiring.ts` — extract the synchronous sibling wiring out of `background.ts`.
- `test/engine/restart.ts` — the restart harness.
- `test/engine/restart.test.ts` — the F8 invariants.
- `TESTING.md` (make the tick true), `FOLLOWUPS.md` (record the residual), `CLAUDE.md`.

### Out of scope

- **Persisting `reopenedNav`.** See §6 — the honest answer is that it is not reconstructible,
  its loss is bounded, and adding a storage seam to `BrowserPort` for a millisecond window is a
  worse trade than documenting it. Recorded in `FOLLOWUPS.md`.
- **Stateful model-based sequences** (`fc.commands`). The restart primitive built here is what a
  later `fc.commands` model would call to drop state "at an arbitrary point mid-sequence"; the
  sequences themselves are a separate slice.
- **An L4 restart case.** `browser.runtime.reload()` from a test would tear down the probe's view
  of CC mid-assertion, and the classes at stake are all deterministic. L3 is the right owner.
- Any behaviour change. If a test written here fails, that is a finding for `FOLLOWUPS.md` or a
  separate fix commit — not a silent patch inside this slice.

## 2. The state, and what happens to each piece

Every `let`/`Map`/`Set` a restart destroys, and whether anything rebuilds it:

| State | Owner | After a restart | Rebuilt by |
|---|---|---|---|
| `n` (throwaway counter) | `background.ts:65` | reissues `tmp1` beside a live `tmp1` | `highestTmpSuffix` — **untested** |
| `tabContainer` | `disposer.ts:16` | a closing tab names no container, so nothing is queued | startup `queryTabs({})` — **untested** |
| `queued` | `disposer.ts:17` | a pending grace timer is lost | `sweep(true)` at startup, then the 10-min GC |
| `processed` | `auto-temp.ts:40` | a new-tab page could be containerized twice | the `cookieStoreId !== "firefox-default"` candidate check — **untested in this role** |
| `creating` | `auto-temp.ts:41` | irrelevant: no containerize is in flight | — |
| `permanentByName` | `registry.ts:32` | a cache miss, then `queryIdentities` | by construction |
| `handled` | `engine.ts:89` | a re-fired request would be re-acted on | nothing — harmless, the request is long gone |
| `warnedHosts` | `engine.ts:93` | the user hears about a declined POST again | nothing — **deliberate**, see `engine.ts:90` |
| `reopenedNav` | `engine.ts:116` | a reopened, still-pre-commit tab is reopened once more | **nothing — not reconstructible.** §6 |

Three rows carry a mechanism that no test defends. Those are the tests worth having; the rest are
characterizations that stop a future change from turning a shrug into a bug.

## 3. Why the wiring must be extracted first

A restart test is only as honest as the startup it restarts *into*. If the harness wires the
siblings itself, it encodes a second copy of `background.ts`'s startup order — and then deleting
`resumeTmpSuffix` from the real entry point leaves the suite green, which is exactly the failure
this slice exists to fix. The test would defend `highestTmpSuffix`'s *implementation* while the
call site rotted.

So the synchronous half of `background.ts` becomes a function both callers share:

```ts
export function wireBackground(opts: {
  port: BrowserPort;
  clock: Clock;
  graceMs: number;
  redirectorDelayMs: number;
}): Background;

export interface Background {
  config: Config;                    // the single object filled in place
  useConfig(loaded: Config): void;   // Object.assign + release the gate, in one call
  resumeTmpSuffix(): Promise<void>;  // raise the counter past every existing tmp<N>
  injectScripts(): Promise<void>;    // the one sibling that reads config eagerly
  engine: Engine;
}
```

`background.ts` keeps what is genuinely its own: `createBrowserPort()`, the `__CC_*` defines, and
the async config tail (storage read, seed write, editor-on-parse-error). Its tail becomes a
transcription of the order the siblings need, which is the thing worth reading.

### The invariant this must not break

**Every `browser.*` listener still registers synchronously as `background.ts` evaluates.**
`wireBackground` is a plain synchronous function called at module top level, so this holds by
construction — but it is now one function's contract instead of a paragraph of comment, which is
strictly better. `useConfig` folding `Object.assign` and `markConfigReady` into one call is the
same move: the two must happen together, so they stop being two things a caller can get wrong.

`CLAUDE.md`'s "registered synchronously — never after an `await`" note gains a pointer at
`wiring.ts` rather than at a block of `background.ts`.

## 4. The harness

```ts
const browser = aFakeBrowser();
const { clock, advance } = aFakeClock();
let session = await startTheBackground(browser, clock, config);
// …drive events…
session = await restartTheBackground(session, browser, clock, config);
// …the same browser, none of the same memory…
```

Two pieces of fidelity carry the whole thing:

**The mock's handler slots model the restart.** `test/engine/mock-port.ts` holds one handler per
event (`handler = h`), so wiring a second session *replaces* the first. That is precisely what a
restart does — the old context's listeners die with it — and it means the harness needs no
teardown API to make the old engine stop answering.

**A dead background's timers must not fire.** The fake clock outlives the session, so the old
disposer's re-arming 10-minute GC tick would keep sweeping through a closure that still holds a
live `port`. Real Firefox drops those timers with the context. So each session gets a clock
facade that stops delivering when the session ends:

```ts
{ setTimeout: (fn, ms) => clock.setTimeout(() => { if (live) fn(); }, ms) }
```

Without it the harness would prove the opposite of what it claims: state "surviving" a restart
because the previous background never actually stopped running.

Not modelled: async work already in flight when the restart happens (a floated `containerize`
mid-`await`). Firefox would kill it; the harness lets it land. Every case below drives the
restart from a settled state, so nothing is in flight — noted so a future case that needs it
knows the gap is there.

## 5. The invariants

Reconstructed state — a restart must not be observable:

1. **The throwaway counter resumes past a live `tmp<N>`.** Route an unmatched host (`tmp1`),
   restart, route another: `tmp2`, never a second `tmp1`.
2. **A throwaway created before the restart is still disposed after it.** Its tab is open across
   the restart; closing it afterwards disposes the container within the grace — proving both the
   disposer's `queryTabs` reseed and that identity-by-name survives a session boundary. Asserted
   inside the grace window, so the 10-minute GC cannot supply a false pass.
3. **A tab already correctly contained is not churned.** Once a tab has *committed*, `tabs.get`
   is a complete substitute for everything that was lost — the F2 guard needs no memory.
4. **An already-containerized new-tab page is not containerized twice.** Auto-temp's startup sweep
   runs again on restart; the candidate check on `cookieStoreId` is what stands in for the
   `processed` set it no longer has.

Deliberately lost state:

5. **The declined-POST notification is raised again.** `engine.ts:90` states this is wanted; the
   test turns the comment into an assertion.

Not reconstructible — bounded degradation:

6. **A restart mid-reopen costs exactly one extra reopen, and converges.** §6.

## 6. `reopenedNav`, and why losing it is survivable

`reopenedNav` holds a tab whose url has not committed. That is the whole point of it, and it is
also why nothing can rebuild it: at restart the tab reads `about:blank` in some container, and
**so does a middle-clicked link** — which inherits its opener's container and must still be
isolated into a throwaway of its own. The requestId in `reopenedNav` is the only thing that
separates the two, and it exists nowhere else. A rule like "a pre-commit tab already in a
throwaway stays put" would resolve the restart case correctly and break isolation for every
`target=_blank` link, which is the trade `CLAUDE.md` already refuses.

What actually happens, traced:

```
session 1   tab A on start.test → nav work.example → reopen into Work, tab B pre-commit
RESTART
session 2   B's own request arrives; current is null, so resolve() cannot see B is
            already in Work → reopen into Work → tab C, B removed (nothing to lose)
            C's request arrives → the fresh reopenedNav guard absorbs it → loads
```

One extra create/remove, and the tab ends in the container the rules asked for. The throwaway
case is the same shape and self-cleaning: the abandoned `tmp1` is empty, so the disposer removes
it after the grace — no container leak.

The reason it converges rather than looping is that the *new* engine establishes the guard on the
reopen it performs. That is a property of the guard's design, not a coincidence, and it is worth
an executable assertion: a future change to how `resolve()` treats a pre-commit tab could turn
one wasted hop into the F1 runaway, and this is the only test that would notice.

So: not a bug to fix here, a bound to pin. `FOLLOWUPS.md` records the window (between
`port.createTab` and the reopened tab's first request) and the price (one hop), so a later MV3
migration — where suspension is involuntary and the window is no longer user-chosen — can weigh
persisting it with the cost already measured.

## 7. Revert-verification

Every test that defends a mechanism must be proven to fail with that mechanism backed out.
Restore by undoing the edit, never `git checkout`.

| Test | Back out | Expected failure |
|---|---|---|
| 1 | `resumeTmpSuffix` body → no-op | `tmp1` issued twice |
| 2 | the disposer's startup `queryTabs({})` loop | container never disposed |
| 3 | resolve's already-contained check | a reopen where none was due |
| 4 | `isAutoTempCandidate`'s `cookieStoreId` check | a second `tmp` container |
| 6 | — | characterization; assert the exact hop count instead, so any change to it is loud |

Test 5 pins an intent, not a mechanism; its guard against drift is the assertion itself.

## 8. Risk

The wiring extraction touches the extension's entry point, which is the one file whose ordering
bugs cost a session's first navigation. Mitigation: the extraction is behaviour-preserving and
mechanical, `npm test` runs the four event-driven `test/e2e/auto-temp.test.ts` cases that went
red the last time this ordering was got wrong, and the extraction lands as its own commit so a
bisect separates it from the tests.
