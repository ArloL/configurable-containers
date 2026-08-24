# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry
once it is resolved.

## Two browser events are registered twice, and L3 can only see one (2026-08-24)

`test/fitness/listeners.test.ts` found this on its first run. `wireBackground` registers
**`onTabRemoved`** twice (`createPause`, then `createDisposer`) and **`onTabUpdated`**
twice (`createAutoTemp`, then `createRedirectorCloser`). `test/engine/mock-port.ts` holds
a single handler slot per event — an assignment, not a push — so at L3 the *second*
registration silently displaces the first:

- **pause's disarm-on-empty never runs** in any case that drives the composed background.
  Verified directly: arm a container through `wireBackground`, close its last tab, and
  `isPaused` still answers true. `test/engine/pause.test.ts` passes because it builds a
  `createPause` on a port of its own.
- **auto-temp is driven by `onTabCreated` alone**, which is exactly the configuration
  CLAUDE.md records as having passed L3 and failed in real Firefox: bug 1586612 makes
  `onCreated` fire with `about:blank` before the real url, which is *why* auto-temp
  listens on both.

Neither is a shipped bug. Firefox's `tabs.onRemoved` and `tabs.onUpdated` are additive, so
both listeners run in the browser, and the e2e level covers both behaviours end to end.
What is lost is L3's ability to see them — in a project whose stated worry is "L3 green,
Firefox broken", a blind spot in the composed level is worth closing deliberately.

Two ways to close it, and they are not equivalent:

- **Fan out in `wireBackground`**, as it already does for `runtime.onMessage`: one
  registration per event, dispatching to the siblings. Small, local, precedented — and it
  changes `src/` to satisfy a property of a test double, which for `onMessage` was also a
  real Firefox requirement and here is not.
- **Make `mock-port` additive** and move session retirement into `test/engine/restart.ts`,
  beside the clock facade it already keeps. This is the more honest fix — Firefox *is*
  additive, and the single slot is currently doing two unrelated jobs — but it invalidates
  three CLAUDE.md notes that lean on one-slot-per-event (the `viewSourceNav` cleanup
  rationale among them) and needs the restart harness to model a dead context's listeners.

The fitness check pins the current inventory exactly, so this cannot spread while it waits.

## `reopenedNav` does not survive a background restart (2026-07-28)

The F1 reopen guard (`src/engine/engine.ts`) is the one piece of guard state nothing can
rebuild, and `test/engine/restart.test.ts` pins the price rather than fixing it. The
window is between `port.createTab` and the reopened tab's first request; a restart
inside it costs **one** extra reopen, converges (the fresh engine guards the reopen it
performs), and leaks no container — the abandoned throwaway is disposed on the grace.

It is not reconstructible because a reopened pre-commit tab and a middle-clicked one are
both `about:blank` in a real container, and the middle-clicked one must still be
isolated into a throwaway of its own. The requestId in `reopenedNav` is the only thing
that separates them. Persisting it needs a storage seam on `BrowserPort`, which is a
poor trade for a millisecond window the user currently chooses (a config save calls
`runtime.reload()`). **Revisit on an MV3 migration**, where suspension is involuntary
and the window stops being user-chosen — the cost side is already measured.

**Priced against the seam, 2026-07-28, and the answer is still no.** The disposer's grace
fix built `readStored`/`writeStored` on `BrowserPort`, so the seam this was waiting for
now exists and the implementation would be cheap: hydrate the map at startup, write
through on each reopen, and extend the existing `configReady` gate to also await the
hydration (reading storage inside the blocking handler is not an option — that is every
navigation's latency). Two things nonetheless argue against it:

- **The window coincides with peak activity, not idleness.** It runs from `port.createTab`
  to the reopened tab's first request — milliseconds during which the extension has just
  handled a blocking request and is mid-reopen. Firefox suspends an event page when it is
  *idle*, so the involuntary-suspension frequency that justified revisiting this is much
  lower here than the MV2-vs-MV3 framing suggested. The window did not really stop being
  rare.
- **Persisting it adds a worse failure than the one it removes.** Entries are keyed by
  tab id, and tab ids restart with the browser — so a stale entry (the reopened tab's
  request never arrived: load aborted, tab closed) could be claimed by an unrelated later
  tab of the same id. That is the mis-absorption the in-memory version already had to be
  taught to avoid, and its cost is a navigation loading **unrouted inside a permanent
  container** (F11 by way of F1). A TTL bounds it, but the trade is then "a silent
  wrong-container risk" against "one wasted reopen that converges and leaks nothing".

Revisit only if dogfooding shows the wasted reopen actually happening — it is visible as
a `tmp` container created and abandoned in the same second.

Harness gap while here: `test/engine/restart.ts` does not model async work already in
flight at the restart (a floated `containerize` mid-`await`). Firefox kills it; the
harness lets it land. Every current case drives the restart from a settled state, so
nothing is in flight — a future case that needs it has to close this first.

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
