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
- **Retrying assertions** as vitest matchers, so the Playwright habit of asserting on a
  locator rather than on a value read from one works here too.
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

Names are Playwright's wherever Playwright has one. A reader arriving from Playwright
should be able to guess this API and be right; where that is impossible, §6 says so and
why.

```ts
class BrowserSession {
  pages(): Promise<Page[]>
  pageAt(urlPrefix: string, opts?): Promise<Page>   // waits for a tab to show it
  newPage(): Promise<Page>                          // a fresh, blank tab
  close(): Promise<void>
}

class Page {
  locator(selector: string): Locator                // CSS; `#cc-save`, `[data-cc-option]`
  keyboard: { press(key: string): Promise<void> }   // chrome-level, to whatever has focus
  goto(url: string): Promise<void>
  url(): Promise<string>
  title(): Promise<string>
  close(): Promise<void>
  describe(): Promise<PageReport>                   // url, title, ids present, tab list
}

class Locator {
  click(opts?): Promise<void>
  fill(text: string, opts?): Promise<void>
  press(key: string, opts?): Promise<void>
  innerText(opts?): Promise<string>
  textContent(opts?): Promise<string | null>
  getAttribute(name: string, opts?): Promise<string | null>
  inputValue(opts?): Promise<string>
  isVisible(): Promise<boolean>                     // immediate, as in Playwright
  isEnabled(): Promise<boolean>                     // immediate
  count(): Promise<number>                          // immediate
  waitFor(opts?: { state?: "attached" | "detached" | "visible" | "hidden" }): Promise<void>
}
```

**A locator is a page plus a selector, and never an element.** No API hands out
something that can go stale — that is the point, and it is why there is no
`elementHandle()`.

**The focused element is `page.locator(":focus")`**, not a bespoke method. `:focus` is
ordinary CSS, so the existing machinery covers it.

**`getAttribute` is implemented with Selenium's `getDomAttribute`** — the W3C
*Get Element Attribute* endpoint, which returns the DOM attribute, which is what
Playwright's `getAttribute` returns. The name that would be wrong here is Selenium's
own `getAttribute`, an injected script that Marionette refuses on privileged pages.
Faithfulness and correctness point the same way.

**`inputValue()` covers every `getProperty("value")` in the suite** (all four of them),
and is what a Playwright user would reach for to read a textarea.

### Retrying assertions

Playwright's central promise is not just that actions wait — it is that **assertions
wait too**, and its docs steer text assertions to `expect(locator).toHaveText()` rather
than reading text and comparing. A Playwright user who writes
`expect(await locator.innerText()).toBe("Saved")` here would get exactly the flake this
work exists to remove, so the library ships the retrying half as vitest matchers:

```ts
await expect(page.locator("#cc-status")).toHaveText("Saved");
await expect(page.locator("#cc-warnings")).toContainText("sandbox");
await expect(page.locator("#cc-save")).toBeEnabled();
await expect(page.locator("#cc-config")).toHaveValue(EDITED_CONFIG);
await expect(page.locator("[data-cc-option]")).toHaveCount(3);
```

`toHaveText` is exact after trimming and `toContainText` is the substring form —
Playwright's split, and one this suite needs: `"Saved — a script could not be
registered: …"` must not satisfy a wait for `"Saved"`.

## 4. Actionability, and which of Playwright's checks survive

Playwright runs a fixed set of checks before each action: click needs *Visible, Stable,
Receives Events, Enabled*; fill needs *Visible, Enabled, Editable*; `press` needs none.
Three of those five are reachable here **through W3C protocol endpoints alone**, which
matters because injected scripts are refused on `moz-extension://` pages:

| Check | How | Status |
|---|---|---|
| **Visible** | *Get Element Rect* (non-empty box) + *Get Element CSS Value* for `visibility` — Playwright's own definition | Implemented |
| **Enabled** | *Is Element Enabled* | Implemented |
| **Editable** | Enabled, and no `readonly` attribute | Implemented |
| **Receives Events** | Needs hit-testing, which needs script. Approximated by retrying `ElementClickIntercepted` until the deadline | Approximated |
| **Stable** | Two identical bounding boxes across consecutive frames. Would be two *Get Element Rect* samples 32ms apart — no script needed — but nothing here animates | Not implemented; YAGNI, not blocked |

So the honest statement of the promise: **click waits for visible + enabled and retries
interception; it does not check stability.** Written down because a Playwright user is
entitled to assume all four.

### The retry core

Every operation is one loop:

1. **Switch to the page's own window handle.** This is what makes the hidden current
   window explicit — the locator pins its tab on every call, so no other code can move
   it out from under this one.
2. **Re-resolve the selector** with `findElements`, which answers with an empty list
   rather than throwing.
3. **Run the actionability checks** for this action, then act. These are treated as
   "poll again" rather than failure: `NoSuchWindow` (the tab is mid-teardown),
   `NoSuchElement`, `StaleElementReference`, `ElementNotInteractable`,
   `ElementClickIntercepted`.
4. **Sleep 100ms** and repeat until the deadline.

Anything else propagates immediately. A `SessionNotCreated` or a driver crash is not
something to wait out, and swallowing it would turn a broken browser into a timeout.

Operations are serialised by `await`; two pages are never driven concurrently, which
Selenium could not support anyway.

### Timeouts — a deliberate divergence

Playwright defaults actions and navigations to **no timeout**, leaning on the 30s test
timeout, and gives assertions 5s. We keep **5s for assertions** and diverge on actions:
**10s, with a diagnostic**. Under Playwright's default, a hung action here surfaces as
vitest's bare `Test timed out in 30000ms` with no page context — which is exactly the
report that made the last two flakes expensive. A timeout that can explain itself beats
one that cannot.

## 5. Failure output is a feature

On timeout an operation throws with: the selector, the action, the page's url, **the ids
present on that page**, the tab list, and the elapsed time.

This is the half that pays for itself. The CI failure that prompted this work reported
`NoSuchElementError: Unable to locate element: *[id="cc-sync"]` and nothing else — no
page, no context, no evidence of whether the document existed. Diagnosing it took a log
dig and three inferences. These failures reproduce only under CI load, so the first
report is usually the only evidence there will ever be.

## 6. Correspondence with Playwright, and what is absent

| Playwright | Here | Note |
|---|---|---|
| `page.locator`, `locator.click/fill/press` | same | |
| `innerText`, `textContent`, `getAttribute`, `inputValue`, `count`, `isVisible`, `isEnabled` | same | `isVisible`/`isEnabled`/`count` return immediately, as in Playwright |
| `locator.waitFor({state})` | same | all four states |
| `expect(locator).toHaveText/toContainText/toHaveValue/toHaveCount/toBeVisible/toBeEnabled` | same | as vitest matchers, 5s |
| `page.keyboard.press` | same | |
| `page.url()` | **async** | forced: a remote protocol has no synchronous read |
| `page.getByRole/getByLabel/getByTestId` | absent | this suite selects by id; add if that changes |
| `elementHandle()` | **absent, permanently** | a handle that can go stale is the bug |
| `waitForLoadState`, `waitForNetworkIdle`, `scrollIntoViewIfNeeded`, `waitForStable` | absent | need `executeScript`, refused on `moz-extension://` pages — *Firefox-specific; keep them in other implementations* |
| `addLocatorHandler` | absent | nothing here has an overlay |
| frames, screenshots, tracing | absent | no iframes here; `describe()` is the diagnostic |

Only one row is a universal statement about the design: **no element handles.** Every
other absence is this environment, and the table exists so the next implementation can
tell the two apart instead of copying a gap.

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
  through a stale element; retries through a vanished window; waits for enabled before
  clicking; propagates a non-retryable error immediately; produces the diagnostic on
  timeout; respects a per-call timeout. The matchers get the same treatment — a matcher
  that does not retry is the flake it was meant to remove.
  These are exactly the semantics a real browser cannot be made to reproduce on demand,
  which is the same reason the flakes only ever appear in CI.
- **Integration:** the e2e suite itself. `npm test` remains the gate, on both channels.
- No new gate. `harness/` is outside the mutation and fitness scopes and stays there.

## 9. Migration

Order, each step green before the next:

0. **Measure first**: that *Get Element Rect* and *Get Element CSS Value* answer on a
   `moz-extension://` page. Both are W3C endpoints rather than injected scripts, so they
   should — but `getAttribute` looked like an endpoint too, and is not. If either is
   refused, the Visible check degrades to attached-only there, and §4's table says so
   instead of the code pretending otherwise.
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
