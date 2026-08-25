# Follow-ups

Things deliberately left needing a re-check, and where to look. Delete an entry once it is
resolved.

## `reopenedNav` does not survive a background restart (2026-07-28)

The F1 reopen guard (`src/engine/engine.ts`) is the one piece of guard state nothing can
rebuild, and `test/engine/restart.test.ts` pins the price rather than fixing it. The
window runs from `port.createTab` to the reopened tab's first request; a restart inside it
costs **one** extra reopen, converges (the fresh engine guards the reopen it performs),
and leaks no container — the abandoned throwaway is disposed on the grace.

It is not reconstructible because a reopened pre-commit tab and a middle-clicked one are
both `about:blank` in a real container, and the middle-clicked one must still be isolated
into a throwaway of its own. The requestId in `reopenedNav` is the only thing separating
them.

**Priced against the seam, 2026-07-28, and the answer is still no.** The disposer's grace
fix built `readStored`/`writeStored` on `BrowserPort`, so the seam exists and the
implementation would be cheap: hydrate the map at startup, write through on each reopen,
and extend the `configReady` gate to await the hydration (reading storage inside the
blocking handler is not an option — that is every navigation's latency). Two things argue
against it:

- **The window coincides with peak activity, not idleness.** It runs while the extension
  has just handled a blocking request and is mid-reopen. Firefox suspends an event page
  when it is *idle*, so the involuntary-suspension frequency that justified revisiting
  this is much lower than the MV2-vs-MV3 framing suggested.
- **Persisting it adds a worse failure than the one it removes.** Entries are keyed by tab
  id, and tab ids restart with the browser, so a stale entry — the reopened tab's request
  never arrived, load aborted, tab closed — could be claimed by an unrelated later tab of
  the same id. That is the mis-absorption the in-memory version had to be taught to avoid,
  and its cost is a navigation loading **unrouted inside a permanent container** (F11 by
  way of F1). A TTL bounds it, but the trade is then a silent wrong-container risk against
  one wasted reopen that converges and leaks nothing.

Revisit only if dogfooding shows the wasted reopen actually happening — it is visible as a
`tmp` container created and abandoned in the same second.

Harness gap while here: `test/engine/restart.ts` does not model async work already in
flight at the restart (a floated `containerize` mid-`await`). Firefox kills it; the
harness lets it land. Every current case drives the restart from a settled state, so a
future case that needs it has to close this first.

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

## Does a config save reach ESR users at all? (2026-08-24)

`runtime.reload()` does not bring a **temporarily installed** extension back on
140.14.0esr. Measured against 154.0 for comparison: after the options page saves and
reloads, the OLD background is still running the OLD config — `work.example`, which the
edit stops matching, still lands in `Work` — and CC's own pages stop resolving at their
`moz-extension` uuid. On 154.0 the same steps apply the new config. The one case that
observes this skips below 154 (`test/e2e/options.test.ts`), which is the only case the
ESR leg of `ci.yml` cannot run.

**What is not known is whether this reaches real users**, and the gap matters: if a
permanently installed CC behaves the same way on ESR, then **saving a config never takes
effect there** and nothing says so — the editor reports "Saved — reloading" either way.
That is a silent wrong answer of the kind this whole suite exists to prevent, on the one
action every user performs.

The harness cannot settle it. An unsigned xpi loads on release Firefox only by temporary
install (`installAddon(xpiPath, true)` in `harness/firefox.ts`), which is also what grants
`webRequestBlocking`; only a permanent install needs signing, and a signed add-on takes a
different path through the add-on manager. So the two cases the measurement cannot
separate are exactly the two that differ.

**What would settle it, and it is a manual step:** install a *signed* dev build — the xpi
`npm run sign:dev` produces — permanently in a real ESR profile, edit the config, save,
and see whether routing follows. If it does, this entry is a harness limitation and can be
deleted. If it does not, it is a shipped bug on ESR and the fix is a config-apply path that
does not depend on `runtime.reload()`.

## The reproducible-build gate has never run in CI (2026-08-25)

**Corrects the 2026-08-24 entry, whose premise was wrong.** That entry said the gate was
inert because the repo had cut no listed release yet, and that the case was pinned and the
behaviour designed. There were two listed releases — `v2607.0.103` (2026-07-28) and
`v2608.0.112` (2026-08-08). The gate never saw them: `fetchReleases` asked for
`releases?per_page=20`, and because both channels share one tag sequence and the dev
channel publishes several times a day, `v2608.0.112` was the **32nd** newest release by
2026-08-25. Every night the job printed "No listed release yet — nothing to reproduce" and
passed in **zero seconds**
([run 32821114275](https://github.com/ArloL/configurable-containers/actions/runs/32821114275)).

Fixed by paging until a listed release turns up, and by making the giving-up case
*provable*: `undefined` now means the release list was read to its end, while exhausting
the page cap throws. The old shape reported an inconclusive search as a conclusive
"nothing to check", which is how a gate stays green for four weeks while checking nothing.
`test/extension/verify-reproducible.test.ts` owns the paging, including the measured
32-releases-deep shape.

**`v2608.0.112` reproduces byte for byte** — verified by hand on 2026-08-25, downloading
its two assets, `npm ci` in the source archive and `BUILD_TIMESTAMP=2026-08-08T19:34:01+00:00
npm run package -- 2608.0.112`: sha256
`5aaeab49afb529571e3a4a013887495b5d2489761bf66d27425db382509f2fb9`, identical to the
published xpi. So the build was never the problem, and the old entry's guess that the
rebuild environment was the risk is answered too.

**What is still open is one nightly run.** The job has never executed its download-and-
rebuild half in CI, so that path — `curl`, `unzip`, `npm ci` and `npm run package` on a
GitHub runner — is unexercised. The next scheduled run is its first real execution; if it
is green, delete this entry.

The lesson worth keeping: the release *picker* was thoroughly tested and always right
about the list it was handed. Nothing tested how that list was fetched, and that is where
the gate died. A gate that cannot find its subject must fail, never pass quietly.

While here: the three jobs added to `nightly.yml` on 2026-08-24 — `flake`,
`reproducible-build` and `firefox-nightly` — have now had their first scheduled run
(2026-08-25). `firefox-nightly` earned its keep on its first night: Firefox 156.0a1 widened
Marionette's privileged-context check to cover the extension process, and nine cases that
ran a script in an extension page went red at once. Fixed by asking through protocol
commands instead (CLAUDE.md, the e2e section) — months before it reaches a release users
are on.

## `harness/selenium-webdriver.d.ts` is only DefinitelyTyped being behind (2026-08-25)

That file declares two methods — `getDomAttribute` and `getProperty` — that
`selenium-webdriver` has shipped since **v4.1.1** (its own `CHANGES.md`: "Implements
'getDomAttribute' … as defined by w3c spec") and that `@types/selenium-webdriver` still
does not, as of **4.35.6**, the newest published. There is nothing to upgrade to, so the
declarations live here rather than as a cast at each call site. Delete the file the day
the types carry them.

To be clear about what is *not* temporary: the call sites. `getDomAttribute`,
`getProperty`, `switchTo().activeElement()` and `clear()` + `sendKeys()` are the
spec's own commands, they work on ESR through Nightly, and they would stay the right
calls even if Firefox reverted the privileged-context change that forced them (CLAUDE.md,
the e2e section). Only the type declarations are a stopgap.

**Nothing will announce it.** Merging an interface into a class turns same-named methods
into *overloads*, not a conflict: measured 2026-08-25, redeclaring even `getAttribute`
with a wrong return type typechecks clean. So an upstream fix will not collide, and a
stale local signature would silently win over the real one. The trigger to re-check is a
Renovate bump of `@types/selenium-webdriver`: grep the new package for the two names, and
if they are there, delete `harness/selenium-webdriver.d.ts` and let `npm run typecheck`
confirm the call sites still resolve.
