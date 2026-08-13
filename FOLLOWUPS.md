# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry
once it is resolved.

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

## Notification volume on declined POSTs (2026-07-28)

Every cross-site form POST that would change container now raises a notification,
deduplicated per host per background session. Payment-gateway returns are the common
case, and there staying put is the *desirable* outcome — so the toast may prove to be
noise. The narrower trigger (notify only when the denied target was a **permanent**
container, i.e. a rule that went unapplied) is a one-line change at the same site in
`src/engine/engine.ts`. Revisit after real use.

Not done here either: **replaying** the POST into the target container via a generated
auto-submitting form page. It is the only option that would actually route the
assertion, and neither Temporary Containers nor Multi-Account Containers attempts it.
It needs the `requestBody` webRequest opt-in, urlencoded and multipart handling, and a
`moz-extension:` page forging a cross-origin POST. See
`docs/superpowers/specs/2026-07-28-f9-redirect-binding-design.md` §1.

## `overrides` in package.json (2026-07-28)

`adm-zip` and `shell-quote` are forced past what their own dependents declare
(`firefox-profile` asks for `~0.5.x`, `fx-runner` pins `1.8.4` exactly) to clear
two Dependabot alerts on transitive **dev** dependencies of `web-ext`. Nothing
here ships — `npm audit --omit=dev` is clean and the xpi is an esbuild bundle of
`src/` — so these are a standing compatibility risk rather than a fix:
`firefox-profile` was written against `adm-zip` 0.5.

Drop them once a `web-ext` release past 10.5.0 pulls in dependents that already
ask for the patched versions. After any change here `npm run lint:ext` is the
check that matters — web-ext is the only thing that consumes these packages.

`npm audit` also reports `brace-expansion` advisories under `eslint →
addons-linter`. Left alone: the installed `1.x` is already the newest of its
line, and the advisory is only fixed in `5.x`, which `minimatch@3` cannot take.
GitHub raises no Dependabot alert for it either.

## F14 (stale tab lineage) has no L4 owner (2026-08-12)

The opener-vs-current fix in `buildNavContext` is pinned at L3 only
(`test/engine/engine.test.ts`, "an inherit host in a tab that has an opener"), and the
coverage matrix ticks F14 for L3 alone. The browser is the source of truth for how long
Firefox keeps `openerTabId` — the L3 mock keeps it because the mock was written to, not
because it was measured — so a real-Firefox case would be worth having. It is awkward
rather than impossible: the chain needs a real `target=_blank` anchor (the harness
server's `?link=`, since a scripted `tabs.create` does not reproduce inheritance), then
the *choice page*, which the driver can only operate once something else has opened it,
then a second navigation in the resulting tab. Pinning just the second half — a tab with
a cross-container opener navigating to an `inherit` host — would cover the fix without
the picker.
