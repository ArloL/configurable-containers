# An Auto-Waiting API Layer Over Selenium — Design

**Date:** 2026-08-25
**Status:** Proposed
**Topic:** Replace raw `WebDriver` use in `test/e2e` and `harness/` with a small
Playwright-shaped API — `BrowserSession` → `Page` → `Locator` — whose every operation
re-resolves what it acts on. Portable by intent: this is the second language for the
design (the first is `BrowserSession.java` in HSP-Backend), so the API is specified
here in language-neutral terms and the Firefox/WebExtension-specific parts are marked
as such.

## 1. Goal & scope

Selenium hands out handles that go stale and resolves elements against a **hidden
current window**. Every flake this suite has had is one of those two facts surfacing
under CI load. The fix is not more waiting at each call site — the suite already has
17 `driver.sleep`s and several bespoke polling loops — but an API where the waiting is
structural and a test cannot express the unsound version.

Playwright is the proof that this is an API problem rather than a browser-automation
problem: nothing in its auto-waiting needs CDP. A locator is a lazy reference,
re-resolved on every use, and that single decision removes the class.

### In scope

- **`harness/browser/`** (new): `BrowserSession`, `Page`, `Locator`, and the one retry
  core they share. No CC, WebExtension or probe knowledge.
- **`harness/firefox.ts`**: `launch()` returns a session exposing `.browser`; the ~25
  probe readers take or return a `Page` instead of a `WebDriver`.
- **`test/e2e/*` (17 files)**: rewritten. No `driver` reference, no `driver.sleep`, no
  `By`, no bespoke poll loop survives.
- **`CLAUDE.md`**: the e2e section. Several of its rules become "the library does this
  for you", and a rule that is no longer true is worse than no rule.
- Unit tests for the retry semantics against a stub driver.

### Out of scope

- `src/`. Nothing about the extension changes.
- The probe extension's own protocol.
- Extraction into a published package. This lands as `harness/browser/`, written so
  that extraction is a move rather than a rewrite.

## 2. Why the flakes happen — the three windows

Root-cause analysis first, because each API decision below answers one of these.

1. **The hidden current window.** `driver.findElement` resolves against whichever
   window the driver last switched to. Anything between a switch and a read can move
   it: another helper, a retry loop, or — here — the extension tearing a tab down and
   reopening it. The dependency is real and invisible, which is the worst combination.
2. **Reachable ≠ parsed ≠ populated.** A tab's committed url precedes its document,
   and its document precedes whatever JavaScript fills in. `findElement` reports the
   first gap as a *throw* and the second as an empty string, so a loop written for one
   fails outright on the other. Both were observed here within one day: an empty
   `#cc-config` on the ESR leg (fixed by 0279640) and `NoSuchElementError` on
   `#cc-sync` on the latest leg (fixed by a042f48).
3. **Handles outlive what they point at.** A `WebElement` goes stale when its document
   is replaced; a window handle dies when its tab closes. Both are ordinary events in
   this suite, because routing a navigation *is* closing a tab and opening another.

## 3. The API

```ts
class BrowserSession {
  pages(): Promise<Page[]>
  pageAt(urlPrefix: string, opts?: WaitOpts): Promise<Page>   // waits for one to exist
  newPage(): Promise<Page>                                    // a fresh, blank tab
  close(): Promise<void>
}

class Page {
  byId(id: string): Locator
  locator(css: string): Locator
  focused(): Promise<Locator>          // the active element, as a locator
  press(key: string): Promise<void>    // chrome-level key to the focused element
  goto(url: string): Promise<void>
  url(): Promise<string>
  title(): Promise<string>
  close(): Promise<void>
  describe(): Promise<PageReport>      // url, title, ids present, tab list
}

class Locator {
  click(opts?): Promise<void>
  fill(text: string, opts?): Promise<void>       // clear() + sendKeys()
  text(opts?): Promise<string>
  domAttribute(name: string, opts?): Promise<string | null>
  property(name: string, opts?): Promise<unknown>
  isEnabled(opts?): Promise<boolean>
  isPresent(): Promise<boolean>                  // immediate, never waits
  waitForText(expected: string | RegExp, opts?): Promise<string>
  waitForNonEmptyText(opts?): Promise<string>
  waitForPresent(opts?): Promise<void>
  waitForHidden(opts?): Promise<void>
}
```

**A locator is a page plus a selector, and never an element.** There is no API that
hands a caller something that can go stale — that is the point, and it is why
`Locator` has no `element()` accessor.

**Selectors are CSS strings**, with `byId` as sugar for the case that is 30 of this
suite's 36 locators. A `By` object is a Selenium type and would not survive a port;
a string does.

**`domAttribute` and `property`, but no `attribute`.** Selenium implements
`getAttribute` as an injected script, which Marionette refuses on a privileged
browsing context — every `moz-extension://` page here. Leaving the method out means
the mistake cannot be made. *(Firefox-specific: other implementations may expose it.)*

**`waitForText(string)` is exact equality after trimming**; use a RegExp for anything
looser. Substring semantics would let `"Saved — a script could not be registered: …"`
satisfy a wait for `"Saved"`, which is a real message this suite distinguishes.

**Timeouts:** one default (10s) set on the session, overridable per call via
`opts.timeout`. The deadline is computed once per operation, not per retry, so a
slow retry cannot extend the budget indefinitely.

## 4. The retry core

Every operation is one loop:

1. **Switch to the page's own window handle.** This is what makes the hidden current
   window explicit — the locator pins its tab on every call, so no other code can move
   it out from under this one.
2. **Re-resolve the selector** with `findElements` (which answers with an empty list
   rather than throwing).
3. **Act**, and treat these as "poll again" rather than failure: `NoSuchWindow`
   (the tab is mid-teardown), `NoSuchElement`, `StaleElementReference`,
   `ElementNotInteractable`, `ElementClickIntercepted`.
4. **Sleep 100ms** and repeat until the deadline.

Anything else propagates immediately. A `SessionNotCreated` or a driver crash is not
something to wait out, and swallowing it would turn a broken browser into a timeout.

Operations are serialised by `await`; two pages are never driven concurrently, which
Selenium could not support anyway.

## 5. Failure output is a feature

On timeout an operation throws with: the selector, the page's url, **the ids present
on that page**, the tab list, and the elapsed time.

This is the half that pays for itself. The CI failure that prompted this work reported
`NoSuchElementError: Unable to locate element: *[id="cc-sync"]` and nothing else — no
page, no context, no evidence of whether the document existed. Diagnosing it took a
log dig and three inferences. These failures reproduce only under CI load, so the
first report is usually the only evidence there will ever be.

## 6. What is deliberately absent

YAGNI, but recorded so the next implementation knows what was a choice:

| Absent | Why | Universal? |
|---|---|---|
| `waitForLoadState`, `waitForNetworkIdle`, `waitForStable`, `scrollIntoView` | All need `executeScript`, which Marionette refuses on `moz-extension://` pages — exactly where this suite flakes | **Environment-specific.** Keep them elsewhere |
| Locator handlers / overlay dismissal | Nothing in this suite has an overlay | Environment-specific |
| Frames | No iframes here | Environment-specific |
| Screenshots | CI keeps no artefacts today; `describe()` covers diagnosis | Environment-specific |
| `attribute()` | Injected-script atom, refused on privileged pages | Firefox-specific |
| Element handles | Deliberate, permanent — a handle that can go stale is the bug | **Universal** |

## 7. Where CC-specific behaviour lives

The library knows nothing about containers. The layer above it does:

- `awaitContainerTab(url)` → returns a `Page`, still meaning "a tab showing this url
  in a non-default container".
- `probeCommand`, `listTabs`, `readContainerName`, `readCookieNames*`, the notification
  readers: take a `Page` rather than a `WebDriver`.
- **Navigation that may not return** stays a CC concern. Reopening a routed navigation
  cancels it, and `driver.get` on a committed tab then never returns — so the tolerant
  form (`newPage()` + `goto` + `awaitContainerTab`) is a harness helper, not a library
  behaviour. `Page.goto` stays honest and can throw.

`Session.driver` becomes internal to `harness/`; tests reach the browser through
`Session.browser`.

## 8. Testing

- **Unit, against a stub driver** (`test/harness/`): re-resolves on every poll; retries
  through a stale element; retries through a vanished window; propagates a non-retryable
  error immediately; produces the diagnostic on timeout; respects a per-call timeout.
  These are exactly the semantics a real browser cannot be made to reproduce on demand,
  which is the same reason the flakes only ever appear in CI.
- **Integration:** the e2e suite itself. `npm test` remains the gate, on both channels.
- No new gate. `harness/` is outside the mutation and fitness scopes and stays there.

## 9. Migration

Order, each step green before the next:

1. `harness/browser/` plus its unit tests. Nothing uses it yet.
2. `launch()` exposes `.browser`; probe readers take a `Page`. Existing tests keep
   working through `.driver`.
3. The 17 e2e files, one per commit, simplest first (`routing`, `inherit`,
   `redirector`) and the two hardest last (`options`, `choice` — keyboard and focus).
4. Remove `Session.driver` from the tests' reach; delete `switchToUrl`, `awaitElement`
   and the bespoke poll loops they replace.
5. Rewrite the CLAUDE.md e2e section against what is then true.

## 10. Risks

- **A large diff in the suite that guards everything else.** Mitigated by migrating one
  file per commit with a full run between, never by a sweeping edit.
- **Slow iteration:** ~2 minutes per e2e run, and the failure modes being fixed do not
  reproduce locally. The stub-driver tests exist because of this.
- **The CLAUDE.md section is load-bearing.** Rules that quietly become false are worse
  than the flakes; rewriting that section is part of the work, not a follow-up.
- **PR #113 touches the same files.** This branch stacks on it and rebases onto main
  once it merges.
