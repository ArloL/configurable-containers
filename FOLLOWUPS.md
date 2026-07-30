# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry
once it is resolved.

## Behaviour described in TESTS.md but not asserted anywhere (2026-07-28)

TESTS.md was deleted when the tests became the only behaviour spec
(`docs/superpowers/specs/2026-07-28-bdd-test-naming-design.md`). Its 47 decided
scenarios were audited against the suite first; these three had no test, and are kept
here so the intent is not lost with the file. Each needs a failing test written first —
they are coverage gaps, not renames.

- **Two blank tabs to the same unmatched site are isolated.** Every existing isolation
  test drives one tab, or a link from an opener. Nothing asserts that two *independent*
  blank tabs navigating to the same unmatched host get separate throwaways. `resolve` is
  pure and takes one navigation, so this is only expressible at L3 or L4.
- **Rule enforcement overrides same-site continuity.** `resolve` consults `matchRule`
  before `disposablePath`, so a matched rule structurally always wins — but no test pins
  it. The scenario is the `www.google.com` (throwaway) → `mail.google.com` (Gmail rule)
  hop: same registrable domain, yet it must still switch container.
- **A group does not override an open rule.** The mirror of the above for groups: a
  domain in both a group and an `open` rule must follow the rule. The existing group
  tests all cover continuity *within* the disposable path, which is the other direction.

## Nothing pins the literal value of TMP_PREFIX (2026-07-28)

`test/engine/registry.test.ts` imports `TMP_PREFIX` and interpolates it, so changing
`"tmp"` to anything else moves both sides of every assertion and the suite stays green
(verified by mutation). The behaviour — prefix-based identification — *is* covered; the
value is not. That value is crucial across a background restart: CC recognises its
own throwaways by name, so changing the prefix would silently orphan every `tmp…`
container in a live profile. A test asserting the literal would catch it.

## What the L5 and Mutation columns of the coverage matrix mean (2026-07-28)

`TESTING.md`'s subtle-bug matrix ticks L5 for F3, F4, F5, F6, F9, F11 and F12, and
Mutation for F3, F4, F5 and F6. There is no acceptance suite and no Stryker config, so
the ticks encode something other than "a test exists at this level" — the author did not
recall what, and the prose that would have defined it was rewritten when TESTS.md went.
The matrix was deliberately left untouched rather than guessed at. Resolve it by deciding
what the columns should mean, then making them true.

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

## No per-machine opt-out for config sync (2026-07-30)

`src/extension/config-sync.ts` publishes the config from every install; there is no
switch. The config carries the hostnames a person visits and the names they gave their
containers, and `storage.sync` carries it to every machine on the account. What makes
on-by-default defensible is that it goes nowhere else — the user's own Firefox Account,
end-to-end encrypted, no server of ours — but "defensible" is not "always what the user
wants": a shared or work machine is the obvious case where it is not.

The switch is a checkbox, a third `storage.local` key, and one branch in `start()`. It is
deferred because a setting added before its first user is a setting shaped by guesswork,
and because the interesting half is not the flag but what an *off* machine should do with
a record it can already see (keep adopting? go fully local? forget the record?). Build it
when someone wants it, and decide that question then rather than now.

Related, and cheaper to answer: the L4 suite proves a config reaches the sync area but
never that one is adopted, because nothing in a test profile can write CC's sync area
from outside (see CLAUDE.md). If that gap ever matters more than it does today, the
lever is a second Firefox profile in the harness sharing a sync backend — a much larger
harness change than it sounds, and not obviously possible without an account.

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
