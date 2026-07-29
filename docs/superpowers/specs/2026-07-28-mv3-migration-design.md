# MV3 migration — spike findings

**Status: the conversion is complete and green. The behaviour regression this spike
found (§4) has since been fixed — see §4a for what shipped and what it changed. The
remaining gate is dogfooding under real suspension (§6).**

The question this spike answers is not "does the manifest validate" but "which of CC's
mechanisms stop being true when the background stops being persistent". Everything below
was measured against real Firefox through the existing e2e harness, not reasoned about.

## 1. What the conversion actually cost

Almost nothing, and that is the headline. `src/engine/port.ts` is the only seam that
touches `browser.*`, and MV3 turned out to be a change to the adapter behind it:

- `manifest_version: 3`; `<all_urls>` moves from `permissions` to `host_permissions`.
- `background.scripts` stays — Firefox MV3 uses an **event page**, not a service worker,
  so the bundle format, `globalThis.setTimeout` and the whole `browser.*` surface survive.
- `strict_min_version: 140.0`, forced by `data_collection_permissions` (addons-linter
  rejects anything lower), which is well past the MV3 floor anyway.

**`webRequestBlocking` survives.** This was the migration's existential risk — Chrome
removed blocking `webRequest` in MV3 and the engine's entire design is a blocking
`onBeforeRequest` that cancels and reopens. Firefox kept it: addons-linter reports **0
errors** on the MV3 manifest, and every routing e2e passes against real Firefox. The
resolver, matcher, engine, supersede rule, `reopenedNav` guard and picker needed **no
changes at all** — 332 of 333 non-e2e tests passed unmodified on the first run, and the
one failure was a test pinning the old content-script API.

## 2. Content scripts: the `scripts:` overlay had to change API twice over

`browser.contentScripts.register` is removed in MV3 (addons-linter `UNSUPPORTED_API`).
The obvious successor is wrong: **`scripting.registerContentScripts` takes file paths
only** — its `js` is `ExtensionURL[]`, with no inline-code form — so it cannot carry a
`run:` string out of the user's config. There is exactly one MV3 API that still accepts
code, and it is the one built for this: `userScripts`.

Two consequences, both deliberate:

- **The world changes.** userScripts default to the `USER_SCRIPT` world rather than the
  extension's content-script world: same DOM, separate JS globals, a CSP that forbids
  eval. Verified in real Firefox that this does not weaken the overlay — the injected
  code still runs at `document_start` *before the page's own scripts*, and `localStorage`
  is shared with the page (both are what `test/e2e/scripts.test.ts` asserts). F11 is
  unaffected: still no `cookieStoreId`, so the script runs wherever the URL loads.
  Arguably an improvement — user-supplied code no longer holds extension-adjacent
  privileges.
- **Registrations need an id**, which is ours to generate and must match on unregister.

## 3. `userScripts` is optional-only, and that is a UX change, not a detail

Firefox types it as `OptionalOnlyPermission`: it **cannot** appear in `permissions`. It
must be in `optional_permissions` and granted by the user at runtime, and
`permissions.request` requires a user gesture — which a background script does not have.

So the `scripts:` overlay cannot be a silent startup registration any more. This branch:

- puts the request on the **options page**, the only place a gesture exists, behind a
  prompt that appears *only* when the config actually uses `scripts:` and the permission
  is missing (nobody who does not use the feature is ever nagged);
- makes the adapter **check before registering** and fail loudly-but-harmlessly if the
  grant is absent. This matters more than it looks: the injector runs inside
  `background.ts`'s floated async tail, where a throw is swallowed — the overlay would
  simply stop working with no diagnostic. Routing is untouched either way.

Note for anyone reading a failing `scripts` e2e: registration is asynchronous on the
startup *after* the grant's `runtime.reload()`. A fixed sleep raced it and made a working
injection look like an MV3 failure. The test polls `userScripts.getScripts()` instead.

## 4. UNRESOLVED — the keep-alive grace does not survive an event page

This is the one thing the migration genuinely breaks, and it is an F10 ("disposed too
early") regression.

`createDisposer` schedules the 5-minute grace and the 10-minute GC with
`clock.setTimeout`. **A pending `setTimeout` dies with the background context**, and an
MV3 event page is suspended whenever it is idle. Worse, the recovery path makes it
*silent*: the disposer's startup runs `sweep(true)` — `skipDelay`, grace **0** — because
it is written to reclaim orphans from a previous session, and it cannot distinguish those
from a container whose grace is still running. So:

> last tab closes → grace starts → background suspends → any event wakes it → startup
> sweep removes the container immediately.

Under MV2 this path is user-chosen and rare (a config save calls `runtime.reload()`).
Under MV3 it becomes the *normal* way a throwaway dies, and the five-minute grace is
effectively zero. Pinned at L3 by `MV3 HAZARD: a restart inside the grace disposes a
throwaway early` in `test/engine/restart.test.ts`, using the existing restart harness —
which already models "a dead session's timers stop", exactly the property at issue.

**The fix direction** is the one this codebase already reaches for (F8: keep only what you
can reconstruct). Timers are the wrong primitive because the *callback* dies with the
page; alarms alone do not help for the same reason. Instead make the grace a
**reconstructible fact** rather than a live timer:

- record, in `storage.local`, when each `tmp…` container was first observed empty;
- replace the per-container grace timer and the GC tick with one periodic `alarms` sweep
  that removes a container only once `now - firstEmptyAt >= graceMs`;
- the startup sweep then stops needing `skipDelay` at all — an orphan from a previous
  session is just a container whose `firstEmptyAt` is already old, which is the same
  question, correctly answered.

That needs a storage seam on `BrowserPort` and changes to the disposer and the mock port.
It is a slice of its own, not a spike step.

## 4a. What actually shipped for §4

**Split across two branches on purpose.** The storage-backed grace is not an MV3
concern — `options.ts` calls `runtime.reload()` on every config save, so the same bug
(a mid-grace throwaway destroyed at grace 0) fires on the shipping MV2 build every time
a user hits Save. That fix therefore lands on MV2 and is reviewed on its own merits. Only
the **alarm** is MV3-specific, because only an event page gets suspended out from under
its timers; it lands here.

`readStored`/`writeStored` on `BrowserPort` (plain JSON under a caller-owned key) and
`now()` on `Clock` — the grace is arithmetic on two timestamps, so the test clock has to
supply both halves or fake time and stored time disagree. `createDisposer` was rewritten
around one idempotent `sweep()`: for every `tmp…` container, a container with tabs drops
its note (keep-alive), an empty one without a note gets `emptySince = now`, and one whose
`emptySince + graceMs` has passed is removed. The map is rewritten wholesale each pass, so
it cannot accumulate entries for containers that were refilled or deleted by hand.

Three things fell out of it worth recording:

- **Timers became an optimisation, and an alarm became mandatory.** A timer keeps disposal
  punctual while the page is alive; losing one costs lateness, never earliness. But a
  stored deadline still needs *something to act on it*, and that was the part this spike
  got wrong first time round: the reasoning "a wake re-runs the background script, so the
  startup sweep covers it" is only true if something causes a wake, and in a browser
  nobody is touching, nothing does. `alarms` was removed as "unused" on that reasoning and
  `disposal.realtime.test.ts` found a throwaway **still alive eight minutes into a
  five-minute grace**. The disposer now arms a `browser.alarms` wake at the nearest
  deadline alongside the timer, and cancels it when nothing is pending. See §7.
- **The `tabId -> container` map is gone.** `onTabRemoved` no longer needs to know which
  container the tab was in; the sweep asks the browser. That is precisely what lets it
  survive a suspension, because the old map had no answer for a tab it never saw created.
- **A deliberate behaviour change:** an empty `tmp` container with no stored note starts
  its grace now instead of being reclaimed immediately, so an orphan from a previous
  browser session lives one extra grace. Unavoidable and correct — emptiness that was
  never written down is indistinguishable from a grace still running, and reclaiming
  those on sight is the exact bug. Lateness on an empty container is invisible; earliness
  loses a session.

The rewrite also exposed a **mock fidelity gap**: `mock-port.ts` did not fire
`onTabRemoved` from `removeTab`, so a tab CC itself closed was invisible to every
listener. The restart case covering an abandoned throwaway had been passing only because
the old startup sweep reclaimed it at grace 0 — the F10 bug was what made the test green.
Fixed alongside.

## 5. `reopenedNav` — priced against the same seam, and declined

The seam §4a built is the one `FOLLOWUPS.md` was waiting for, and the implementation
would now be cheap (hydrate at startup, write through on reopen, extend the existing
`configReady` gate to await the hydration — a storage read inside the blocking handler is
not an option, that is every navigation's latency). It is still the wrong trade, for one
old reason and one new one:

- **New:** the window runs from `port.createTab` to the reopened tab's first request —
  milliseconds in which the extension has just handled a blocking request and is mid-
  reopen. Firefox suspends an event page when it is **idle**, so the "suspension is
  involuntary now" argument is much weaker here than the MV2/MV3 framing implied. The
  window did not really stop being rare.
- **Old, and decisive:** entries are keyed by tab id, and tab ids restart with the
  browser. A stale entry — the reopened tab's request never arrived because the load was
  aborted or the tab closed — could be claimed by an unrelated later tab of the same id,
  which is the mis-absorption the in-memory version already had to be taught to avoid.
  Its cost is a navigation loading **unrouted inside a permanent container** (F11 by way
  of F1). A TTL bounds it, but the trade becomes "a silent wrong-container risk" against
  "one wasted reopen that converges and leaks nothing".

Recorded in `FOLLOWUPS.md` with the trigger for revisiting: dogfooding actually showing
the wasted reopen, visible as a `tmp` container created and abandoned in the same second.

## 6. Verification status

- `npm run typecheck` — clean.
- `npm run lint:ext` (addons-linter 10.8.0, what AMO runs) — **0 errors**, 2 warnings:
  an Android `strict_min_version` note, and a stale `UNSUPPORTED_API` on
  `userScripts.register`. The latter is a linter bug: the types carry two overloads,
  `register(options)` marked *"Not supported on manifest versions above 2"* and
  `register(scripts[])` marked *"Needs at least manifest version 3"*. We call the MV3
  array form; the linter only knows the MV2 one. Real Firefox registers it fine
  (observed via `userScripts.getScripts()`).
- `npx vitest run` — 364 passed, 2 skipped. The only failure is `mac-interop`, which
  needs the `mac/` submodule and is unrelated (it fails identically on the MV2 baseline
  in this container, where submodules are not checked out).
- One caveat, recorded rather than smoothed over: `cookie-boundary` (F11) failed **once**
  in a full MV3 run and did not reproduce — it passed in isolation and on a second full
  run, and passed on the MV2 baseline. Not diagnosed. If it recurs, it is the first thing
  to look at, because F11 is the class where a wrong answer is worst.
- **Not covered anywhere:** real suspension. Nothing in CI evicts the background context,
  which is precisely the mechanism §4 is about. The L3 restart harness is the closest
  proxy and it is a proxy — it models "the timers died and the memory is gone", which is
  the part that matters, but it chooses *when* that happens. Manual dogfooding on a real
  profile is the remaining gate before this ships.
- The disposer rewrite is revert-verified: backing the stored map out reds **seven**
  cases across `disposer.test.ts` and `restart.test.ts`, including the new
  `resumes the remaining grace of a throwaway emptied before the restart`. The alarm's two
  halves have separate owners — dropping `scheduleWake` reds the arming and cancelling
  cases, dropping the `onWake` handler reds the suspended-page case.

## 7. What the fast tests structurally cannot see

Worth stating plainly, because it cost a wrong conclusion in this very document. Every
test below the nightly one keeps the browser *busy*, and a busy event page is never
suspended:

- L3 runs on a fake clock, so "the page was suspended" is only ever modelled, never
  suffered. The `suspendedPage` clock in `disposer.test.ts` is the closest it gets.
- `disposal.test.ts` runs at a 500ms grace — comfortably inside Firefox's ~30s idle
  timeout, so the page is still alive when the deadline lands.
- Its original case also polled by *navigating*, and a navigation that reopens a tab
  closes the old one, firing another `onTabRemoved` and handing the disposer a second
  chance it would not get in a quiet browser. A companion case now polls via a probe
  command instead, touching nothing — but even that only reproduces bugs that show up
  inside 15 seconds.

So `disposal.realtime.test.ts` is not a luxury: it is the only case in the suite where
the background is genuinely left alone long enough to be suspended. **A change to
disposal timing is not verified by a green `npm test`.** Run `npm run test:realtime`.
