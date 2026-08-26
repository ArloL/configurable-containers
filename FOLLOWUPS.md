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

## `harness/selenium-webdriver.d.ts` is only DefinitelyTyped being behind (2026-08-25)

That file declares two methods — `getDomAttribute` and `getProperty` — that
`selenium-webdriver` has shipped since **v4.1.1** (its own `CHANGES.md`: "Implements
'getDomAttribute' … as defined by w3c spec") and that `@types/selenium-webdriver` still
does not, as of **4.35.6**, the newest published. There is nothing to upgrade to, so the
declarations live here rather than as a cast at each call site. Delete the file the day
the types carry them.

**Filed upstream: DefinitelyTyped/DefinitelyTyped#75437**, which adds both plus
`getAriaRole` and `getAccessibleName` — the other two W3C element commands the package
is missing. Merged, it republishes `@types/selenium-webdriver` and Renovate carries it
here.

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

---

The entries below came out of one sweep of the cold base on 2026-08-26, against
`0131954` with every gate green (`npm test` 910 passed / 1 skipped on 140.14.0esr,
`test:coverage` 866 passed, typecheck, lint and `audit` clean). None of them is a red
test — that is the point of writing them down.

## `npm run test:flake` can report agreement over no runs at all (2026-08-26)

`scripts/flake-check.ts` reads `Number(process.env.FLAKE_RUNS ?? DEFAULT_RUNS)`. `NaN` (a
typo in the workflow env) and `0` (an empty string, which `Number` reads as zero) both
make the loop body never execute, and `compareRuns([])` then answers with empty
everything: `isRed` is false, the process exits 0, and it prints *"All NaN runs succeeded,
and every case answered the same way."*

That is the exact inference the script was written to refuse. It already knows the shape —
`emptyRuns` exists because "agreement over nothing is not agreement", and `Run.success`
defaults to false because "a report that does not say it succeeded is not evidence that it
did" — but both guard a run that produced nothing, not the absence of runs.
`test/harness/flake-check.test.ts` has 20 cases and none passes zero runs to `isRed`.

Beside it, one shape the comparator cannot report because it never gets the chance:
`readFileSync(outFile)` throws `ENOENT` when vitest dies before writing its report, taking
`main` down with a stack trace instead of recording that run as the empty one it is. Loud,
so not urgent — but it is the one failure mode this file has a vocabulary for and cannot
use.

## `Page.describe()` still anchors on a snapshot handle (2026-08-26)

`384cdfb` established that a window handle is a snapshot — `getAllWindowHandles` names a
tab, the extension closes it, the switch raises `NoSuchWindowError` — and made
`Page.close` and `BrowserSession.newPage` poll over the list instead. `Page.describe` was
not touched and still does the unguarded form: list every handle, `switchTo` each, read
its url (`harness/browser/page.ts`, the `tabs` loop).

It is reached from `diagnose()`, which every `poll` timeout calls to say what it saw, and
which catches the throw and answers *"page: could not be described"*. So the failure is
silent and perfectly inverted: the diagnosis disappears precisely when the extension is
churning tabs, which is when a timeout is most likely and its tab list most worth having.
`Page.describe` is public, so a case can hit the raw throw too.

`BrowserSession.pageAt` has the same walk with a bare `catch { continue }`, where
`newPage` distinguishes `isRetryable`. That is the looser half of the same question:
`retry.ts` is explicit that "a driver that has died is not something to wait out", and
`pageAt` currently waits one out for the full budget.

## The AMO reviewer notes explain seven of the nine permissions (2026-08-26)

`amo/reviewer-notes.txt` lists `webRequest`, `webRequestBlocking`, `<all_urls>`,
`cookies`, `contextualIdentities`, `tabs` and `storage`. `extensions/cc/manifest.json`
also declares **`webNavigation`** (the F13 view-source guard) and **`notifications`** (the
F9 toast), both added after the notes were written. An AMO reviewer reads that file to
find out why an add-on asks for what it asks for, and two of the answers are missing.

`test/fitness/manifest.test.ts` pins the manifest against the APIs `src/` calls, in both
directions, and would have caught either permission being added without a caller. Nothing
pins the notes against the manifest — and since `c48182e` these notes are uploaded to AMO
on **every push to main**, so the drift is published rather than merely stale. A third row
in that fitness function ("every declared permission is named somewhere in the reviewer
notes") is the shape; it needs the notes' permission section to be machine-findable, which
today it is only by convention.

Same file, unverified: *"Needs Node 22+."* CI builds and verifies on Node 24 only,
`package.json` declares no `engines`, and nothing anywhere establishes that a Node 22
rebuild produces the same bytes. The whole point of that paragraph is a reviewer
reproducing the checksum, so the version floor in it should either be what CI proves or be
dropped.

## Two gaps in what the browser layer promises e2e cases (2026-08-26)

Both are in the layer's own stated contract rather than in a case, so no case failing will
find either.

**A variable evades the read-then-compare check.** `test/fitness/e2e-discipline.test.ts`
matches `expect(await ….inputValue())` and the other immediate readers inline. Assigning
first — `const value = await editor.locator("#cc-config").inputValue(); expect(value)…` —
matches nothing. Two files do it today (`options.test.ts:101`, `config-sync.test.ts:72`)
and both are safe for reasons of their own: each waits with a retrying matcher first, and
`config-sync` says so in a comment. The rule is fine; the check is one form narrower than
the rule, and this directory's house rule is that the next exception has to be argued for
here rather than absorbed.

**Three matchers cannot reach the "no element matched" branch.**
`harness/browser/matchers.ts` promises that an element which never appears fails in BOTH
directions, so that `.not` cannot pass for a page that rendered nothing — and
`test/harness/browser/matchers.test.ts` pins it. That holds only for the four matchers
whose reader throws `PollTimeoutError` (`toHaveText`, `toContainText`, `toHaveValue`,
`toHaveAttribute`). `toBeVisible`, `toBeEnabled` and `toHaveCount` read through
`isVisible()` / `isEnabled()` / `count()`, which answer `false`, `false` and `0` for a
missing element, so `reading` is always set and the branch is dead for them. For
`toBeVisible` and `toHaveCount(0)` that matches Playwright and is what a caller wants. For
`toBeEnabled` it does not: Playwright waits for the element, this passes
`.not.toBeEnabled()` on a document that has not rendered. One live call site
(`options.test.ts:114`, and safe only because the line above it waits on `#cc-error`).

## A startup script injection is not serialised against a Save (2026-08-26)

`applyStored` runs applies through the `applying` chain because `scripts.apply`
unregisters what the previous one registered, and two in flight interleave into
unregister, unregister, register, register — every snippet registered and injected twice
until the next apply. `wireBackground`'s comment names two ways in: a double-clicked Save,
and a Save meeting an adoption.

There is a third. `background.injectScripts()` calls `scripts.apply(config)` directly, off
the chain. The async tail awaits it before `configSync.start()`, so adoption cannot race
it — but a `cc-config-apply` from the editor is a message, and messages do not wait for
the tail. The window is small (browser startup, with the editor already open, which
happens when the stored config does not parse and startup opens it) and self-heals on the
next apply. Routing it through `applyStored` would close it; whether that is worth doing,
or worth only a comment saying the window is known, is the call.
