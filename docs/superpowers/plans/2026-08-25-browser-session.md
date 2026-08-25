# Browser Session (Selenium auto-waiting layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `harness/browser/` — a Playwright-shaped `BrowserSession` → `Page` → `Locator` API over Selenium whose every operation re-resolves what it acts on — and prove it against real Firefox by converting the one e2e file whose flake started this work.

**Architecture:** A locator is a page plus a CSS selector and never an element. Every operation runs one loop: switch to the page's own window handle, re-resolve the selector, run Playwright's actionability checks for that action, act — treating the five "not yet" Selenium errors as another poll and everything else as a real failure. On timeout it throws with the page's url, the ids present on it and the tab list, because these failures only ever appear under CI load and the first report is usually the only evidence there will be.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes`), `selenium-webdriver` (already a dependency — **no new packages**), Vitest 4, oxlint with `--type-aware --deny-warnings`, tsgo (`npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-08-25-browser-session-design.md`

## Global Constraints

- **No new npm dependencies.** Everything here is `selenium-webdriver` plus what the repo has.
- **Never call `driver.executeScript` or `WebElement.getAttribute` in this layer.** Both are injected scripts; Marionette refuses them on `moz-extension://` pages. Use `getDomAttribute` (Get Element Attribute) and `getProperty` (Get Element Property).
- **No `driver.sleep` in `test/e2e`.** The library polls; a sleep in a test is the bug this replaces.
- **`exactOptionalPropertyTypes` is on.** Spread an optional key in conditionally; never pass `foo: undefined`.
- Every commit must pass `npm run typecheck` and `npm run lint`.
- E2E locally: `FIREFOX_BIN=/Applications/Firefox.app/Contents/MacOS/firefox npx vitest run <file>`.
- Conventional commit prefixes (`feat:`, `test:`, `docs:`, `refactor:`), one logical change per commit.
- Scope: this plan builds the library and converts **one** e2e file. The remaining 16 files and the CLAUDE.md rewrite are a second plan, written once this API has been used in anger.

---

### Task 1: Pin which protocol commands answer on a privileged page

The library's actionability checks rest on the claim that *Get Element Rect* and *Get Element CSS Value* are W3C endpoints rather than injected scripts, so they work where `getAttribute` does not. That claim needs measuring, not assuming — and once measured it needs a tripwire, because Firefox 156 widened the privileged-context check once already and took nine cases down.

**Files:**
- Create: `test/e2e/privileged-protocol.test.ts`

**Interfaces:**
- Consumes: `launch`, `openExtensionPage`, `switchToUrl`, `ccExtensionUrl` from `harness/firefox.ts`.
- Produces: nothing importable. It produces a **fact** the rest of the plan depends on.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainerTab, awaitElement, openExtensionPage, switchToUrl, ccExtensionUrl,
  type Session,
} from "../../harness/firefox";

const OPTIONS_URL = ccExtensionUrl("options.html");

// harness/browser is built on the claim that these are W3C endpoints rather than scripts
// Selenium injects, so they answer on an extension page where `getAttribute` and
// `executeScript` are refused. Firefox 156 widened that refusal once already
// (isPrivilegedContext, nine cases at once), so this is the tripwire for the next time.
describe("what a privileged page answers (real Firefox)", () => {
  let firefox: Session;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    // The probe's command relay is a DOM event injected into http(s) pages only, so the
    // driver has to be parked on one before anything can ask it to open a page.
    const port = new URL(firefox.serverUrl).port;
    const url = `http://work.example:${port}/?cb=privileged-${Date.now()}`;
    try {
      await firefox.driver.get(url);
    } catch {
      // Reopened into Work, tearing this tab down — expected.
    }
    await awaitContainerTab(firefox.driver, url);
    await openExtensionPage(firefox.driver, OPTIONS_URL);
    await switchToUrl(firefox.driver, OPTIONS_URL);
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("answers the commands the locator layer is built on", async () => {
    // Waiting for the element to EXIST before reading it: the page is reachable a beat
    // before its document is, which is the whole reason harness/browser exists.
    const save = await awaitElement(firefox.driver, "cc-save");

    const rect = await save.getRect();
    expect(rect.width, "Get Element Rect must report a real box").toBeGreaterThan(0);
    expect(await save.getCssValue("visibility")).toBe("visible");
    expect(await save.isEnabled()).toBe(true);
    expect(await save.getDomAttribute("id")).toBe("cc-save");
    expect(await save.getProperty("tagName")).toBe("BUTTON");
    expect(await save.getText()).toContain("Save");
  });

  // Deliberately NOT asserted here: that an injected script is refused. Measured on
  // 154.0, `executeScript("return 1;")` on this very page answers 1 — the refusal is
  // 156.0a1's widened `isPrivilegedContext` check and has not reached release.
});
```

- [ ] **Step 2: Run it**

Run: `FIREFOX_BIN=/Applications/Firefox.app/Contents/MacOS/firefox npx vitest run test/e2e/privileged-protocol.test.ts`
Expected: PASS. If `getRect` or `getCssValue` is refused, **stop and report** — §4 of the spec needs amending to degrade the Visible check to attached-only, and Task 4 changes with it.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/privileged-protocol.test.ts
git commit -m "test(e2e): pin which protocol commands answer on a privileged page"
```

---

### Task 2: The retry core

**Files:**
- Create: `harness/browser/retry.ts`
- Create: `harness/browser/types.ts`
- Test: `test/harness/browser/retry.test.ts`

**Interfaces:**
- Produces:
  - `RETRY: unique symbol` — an attempt's way of saying "not yet".
  - `poll<T>(opts: PollOpts, attempt: () => Promise<T | typeof RETRY>): Promise<T>`
  - `PollOpts = { timeout: number; interval?: number; what: string; diagnose: () => Promise<string> }`
  - `isRetryable(e: unknown): boolean`
  - `DEFAULT_TIMEOUT_MS = 10_000`, `ASSERTION_TIMEOUT_MS = 5_000`, `POLL_INTERVAL_MS = 100`
  - `types.ts`: `WaitOpts { timeout?: number }`, `PageReport { url; title; ids; tabs }`, `PageContext` (the slice of `Page` a `Locator` needs — `handle`, `driver`, `defaultTimeout`, `switchHere()`, `diagnose()`), `LocatorState = "attached" | "detached" | "visible" | "hidden"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { error as seleniumError } from "selenium-webdriver";
import { RETRY, poll, isRetryable } from "../../../harness/browser/retry";

import type { PollOpts } from "../../../harness/browser/retry";

const opts = (over: Partial<PollOpts> = {}): PollOpts => ({
  timeout: 1000,
  interval: 0,
  what: "click #cc-save",
  diagnose: async () => "url=moz-extension://cc/options.html ids=[cc-config]",
  ...over,
});

describe("poll", () => {
  it("returns the first answer that is not RETRY", async () => {
    let calls = 0;
    const answer = await poll(opts(), async () => (++calls < 3 ? RETRY : "done"));
    expect(answer).toBe("done");
    expect(calls).toBe(3);
  });

  // Every "not yet" Selenium has a word for: the tab is mid-teardown, the document has
  // not parsed, the element was replaced, the click landed on an overlay.
  it.each([
    ["NoSuchWindowError", new seleniumError.NoSuchWindowError("gone")],
    ["NoSuchElementError", new seleniumError.NoSuchElementError("absent")],
    ["StaleElementReferenceError", new seleniumError.StaleElementReferenceError("stale")],
    ["ElementNotInteractableError", new seleniumError.ElementNotInteractableError("busy")],
    ["ElementClickInterceptedError", new seleniumError.ElementClickInterceptedError("covered")],
  ])("polls through %s", async (_name, thrown) => {
    let calls = 0;
    const answer = await poll(opts(), async () => {
      if (++calls < 2) throw thrown;
      return "done";
    });
    expect(answer).toBe("done");
  });

  // A broken browser is not something to wait out: swallowing this would turn it into a
  // ten-second timeout and hide what actually happened.
  it("propagates anything else at once", async () => {
    let calls = 0;
    await expect(
      poll(opts(), async () => {
        calls++;
        throw new Error("geckodriver died");
      }),
    ).rejects.toThrow(/geckodriver died/);
    expect(calls).toBe(1);
  });

  it("returns a void answer rather than polling forever", async () => {
    await expect(poll(opts(), async () => undefined)).resolves.toBeUndefined();
  });

  it("says what it was doing, where, and for how long", async () => {
    await expect(poll(opts({ timeout: 0 }), async () => RETRY)).rejects.toThrow(
      /click #cc-save.*timed out.*ids=\[cc-config\]/s,
    );
  });

  it("tries once even with no time left", async () => {
    let calls = 0;
    await poll(opts({ timeout: 0 }), async () => {
      calls++;
      return "done";
    });
    expect(calls).toBe(1);
  });
});

describe("isRetryable", () => {
  it("is false for an ordinary error", () => {
    expect(isRetryable(new Error("nope"))).toBe(false);
  });

  it("is true for a stale element", () => {
    expect(isRetryable(new seleniumError.StaleElementReferenceError("stale"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run test/harness/browser/retry.test.ts`
Expected: FAIL — cannot resolve `harness/browser/retry`.

- [ ] **Step 3: Write `harness/browser/types.ts`**

```ts
import type { WebDriver } from "selenium-webdriver";

export interface WaitOpts {
  timeout?: number;
}

export interface PageReport {
  url: string;
  title: string;
  ids: string[];
  tabs: string[];
}

export type LocatorState = "attached" | "detached" | "visible" | "hidden";

// The slice of Page a Locator needs. Declared here rather than imported from page.ts so
// the two modules do not depend on each other.
export interface PageContext {
  readonly driver: WebDriver;
  readonly handle: string;
  readonly defaultTimeout: number;
  switchHere(): Promise<void>;
  diagnose(): Promise<string>;
}
```

- [ ] **Step 4: Write `harness/browser/retry.ts`**

```ts
// The one loop every operation in this layer runs. See
// docs/superpowers/specs/2026-08-25-browser-session-design.md §4.
import { error as seleniumError } from "selenium-webdriver";

export const RETRY: unique symbol = Symbol("retry");

export const DEFAULT_TIMEOUT_MS = 10_000;
export const ASSERTION_TIMEOUT_MS = 5_000;
export const POLL_INTERVAL_MS = 100;

export interface PollOpts {
  timeout: number;
  interval?: number;
  /** What the caller was doing, in the words the failure should use: `click #cc-save`. */
  what: string;
  diagnose: () => Promise<string>;
}

// The five ways Selenium says "not yet": the tab is mid-teardown, the document has not
// parsed, the element was replaced under us, it is not ready for input, something is on
// top of it. Anything else is a real failure — a driver that has died is not something to
// wait out, and waiting turns it into a timeout that explains nothing.
const RETRYABLE = [
  seleniumError.NoSuchWindowError,
  seleniumError.NoSuchElementError,
  seleniumError.StaleElementReferenceError,
  seleniumError.ElementNotInteractableError,
  seleniumError.ElementClickInterceptedError,
];

export function isRetryable(e: unknown): boolean {
  return RETRYABLE.some((kind) => e instanceof kind);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll<T>(opts: PollOpts, attempt: () => Promise<T | typeof RETRY>): Promise<T> {
  const started = Date.now();
  const deadline = started + opts.timeout;
  for (;;) {
    try {
      const outcome = await attempt();
      if (outcome !== RETRY) return outcome;
    } catch (e) {
      if (!isRetryable(e)) throw e;
    }
    // Checked after the attempt, so a zero timeout still tries once.
    if (Date.now() >= deadline) {
      throw new Error(
        `${opts.what} timed out after ${Date.now() - started}ms\n${await opts.diagnose()}`,
      );
    }
    await sleep(opts.interval ?? POLL_INTERVAL_MS);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/harness/browser/retry.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add harness/browser test/harness/browser
git commit -m "feat(harness): a retry core that tells a not-yet from a failure"
```

---

### Task 3: A fake driver for the unit tests

The semantics worth testing — re-resolving per poll, surviving a stale element, surviving a vanished window — are exactly the ones a real browser cannot be made to produce on demand. That is the same reason these flakes only ever appear in CI.

**Files:**
- Create: `test/harness/browser/fake-driver.ts`

**Interfaces:**
- Produces: `fakeDriver(script: FakeScript): { driver: WebDriver; calls: string[] }` where `FakeScript` is `{ elements: (attempt: number) => FakeElement[]; handles?: string[]; url?: string; title?: string }`, and `FakeElement` is a partial `WebElement` whose methods the test supplies.

- [ ] **Step 1: Write the fake**

```ts
import type { WebDriver, WebElement } from "selenium-webdriver";

export interface FakeElement {
  getText?: () => Promise<string>;
  getRect?: () => Promise<{ width: number; height: number; x: number; y: number }>;
  getCssValue?: (name: string) => Promise<string>;
  isEnabled?: () => Promise<boolean>;
  getDomAttribute?: (name: string) => Promise<string | null>;
  getProperty?: (name: string) => Promise<unknown>;
  click?: () => Promise<void>;
  clear?: () => Promise<void>;
  sendKeys?: (...keys: string[]) => Promise<void>;
}

export interface FakeScript {
  /** What findElements answers on the nth call (1-based). */
  elements: (attempt: number) => FakeElement[];
  handles?: string[];
  url?: string;
  title?: string;
}

// A visible, enabled element, which is what most cases want their locator to find.
export function anElement(over: FakeElement = {}): FakeElement {
  return {
    getRect: async () => ({ width: 40, height: 20, x: 0, y: 0 }),
    getCssValue: async () => "visible",
    isEnabled: async () => true,
    ...over,
  };
}

export function fakeDriver(script: FakeScript): { driver: WebDriver; calls: string[] } {
  const calls: string[] = [];
  let attempt = 0;
  let current = script.handles?.[0] ?? "w1";
  const driver = {
    async findElements() {
      attempt++;
      calls.push(`findElements#${attempt}`);
      return script.elements(attempt) as unknown as WebElement[];
    },
    switchTo: () => ({
      async window(handle: string) {
        calls.push(`switchTo(${handle})`);
        current = handle;
      },
      async newWindow() {
        calls.push("newWindow");
        current = `w${(script.handles?.length ?? 1) + 1}`;
      },
    }),
    async getAllWindowHandles() {
      return script.handles ?? ["w1"];
    },
    async getWindowHandle() {
      return current;
    },
    async getCurrentUrl() {
      return script.url ?? "http://example.test/";
    },
    async getTitle() {
      return script.title ?? "a page";
    },
    async get(url: string) {
      calls.push(`get(${url})`);
    },
    async close() {
      calls.push("close");
    },
    actions: () => ({
      sendKeys(key: string) {
        calls.push(`sendKeys(${key})`);
        return { async perform() {} };
      },
    }),
  };
  return { driver: driver as unknown as WebDriver, calls };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck && npm run lint`
Expected: clean. (No test yet — the next task's tests exercise it.)

- [ ] **Step 3: Commit**

```bash
git add test/harness/browser/fake-driver.ts
git commit -m "test(harness): a fake driver that can be told what to answer when"
```

---

### Task 4: Locator — reads and actionability

**Files:**
- Create: `harness/browser/locator.ts`
- Test: `test/harness/browser/locator.test.ts`

**Interfaces:**
- Consumes: `poll`, `RETRY` from `retry.ts`; `PageContext`, `WaitOpts`, `LocatorState` from `types.ts`; `fakeDriver`, `anElement` from `fake-driver.ts`.
- Produces: `class Locator` with `click`, `fill`, `press`, `innerText`, `textContent`, `getAttribute`, `inputValue`, `isVisible`, `isEnabled`, `count`, `waitFor`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { error as seleniumError } from "selenium-webdriver";
import { Locator } from "../../../harness/browser/locator";
import type { PageContext } from "../../../harness/browser/types";
import { fakeDriver, anElement, type FakeScript } from "./fake-driver";

function locatorOn(script: FakeScript) {
  const { driver, calls } = fakeDriver(script);
  const page: PageContext = {
    driver,
    handle: "w1",
    defaultTimeout: 500,
    async switchHere() {
      calls.push("switchHere");
    },
    async diagnose() {
      return "url=moz-extension://cc/options.html ids=[cc-config]";
    },
  };
  return { locator: new Locator(page, "#cc-save", 0), calls };
}

describe("Locator", () => {
  it("pins its own tab before every resolve", async () => {
    const { locator, calls } = locatorOn({ elements: () => [anElement({ getText: async () => "Save" })] });
    await locator.innerText();
    expect(calls.slice(0, 2)).toEqual(["switchHere", "findElements#1"]);
  });

  // The window is re-resolved per attempt, so a tab CC tore down and reopened is found
  // again rather than answered as a dead handle.
  it("polls until the document has the element", async () => {
    const { locator } = locatorOn({
      elements: (n) => (n < 3 ? [] : [anElement({ getText: async () => "Save" })]),
    });
    expect(await locator.innerText()).toBe("Save");
  });

  it("re-resolves after a stale element rather than reusing it", async () => {
    let handed = 0;
    const { locator } = locatorOn({
      elements: () => {
        handed++;
        return [
          anElement({
            getText: async () => {
              if (handed < 2) throw new seleniumError.StaleElementReferenceError("stale");
              return "Save";
            },
          }),
        ];
      },
    });
    expect(await locator.innerText()).toBe("Save");
    expect(handed).toBe(2);
  });

  it("waits for enabled before clicking", async () => {
    let clicked = false;
    const { locator } = locatorOn({
      elements: (n) => [
        anElement({ isEnabled: async () => n >= 3, click: async () => { clicked = true; } }),
      ],
    });
    await locator.click();
    expect(clicked).toBe(true);
  });

  // Playwright's definition of visible: a non-empty box, and not visibility:hidden.
  it("waits for a real box before clicking", async () => {
    const { locator } = locatorOn({
      elements: (n) => [
        anElement({ getRect: async () => ({ width: n < 2 ? 0 : 40, height: 20, x: 0, y: 0 }) }),
      ],
    });
    await expect(locator.click()).resolves.toBeUndefined();
  });

  it("does not click something visibility:hidden", async () => {
    const { locator } = locatorOn({
      elements: () => [anElement({ getCssValue: async () => "hidden" })],
    });
    await expect(locator.click()).rejects.toThrow(/click #cc-save timed out/);
  });

  it("fills by clearing and typing, which is what fires the page's input handler", async () => {
    const typed: string[] = [];
    const { locator } = locatorOn({
      elements: () => [
        anElement({
          clear: async () => { typed.push("<clear>"); },
          sendKeys: async (...keys) => { typed.push(...keys); },
          getDomAttribute: async () => null,
        }),
      ],
    });
    await locator.fill("rules:\n");
    expect(typed).toEqual(["<clear>", "rules:\n"]);
  });

  it("does not fill a readonly field", async () => {
    const { locator } = locatorOn({
      elements: () => [anElement({ getDomAttribute: async (n) => (n === "readonly" ? "" : null) })],
    });
    await expect(locator.fill("x")).rejects.toThrow(/fill #cc-save timed out/);
  });

  // Matching Playwright, where press requires no actionability at all.
  it("presses without waiting for visible or enabled", async () => {
    const sent: string[] = [];
    const { locator } = locatorOn({
      elements: () => [
        anElement({
          getRect: async () => ({ width: 0, height: 0, x: 0, y: 0 }),
          isEnabled: async () => false,
          sendKeys: async (...keys) => { sent.push(...keys); },
        }),
      ],
    });
    await locator.press("Enter");
    expect(sent).toEqual(["Enter"]);
  });

  it("reads a dom attribute and an input value", async () => {
    const { locator } = locatorOn({
      elements: () => [
        anElement({
          getDomAttribute: async () => "Work",
          getProperty: async (name) => (name === "value" ? "rules:\n" : undefined),
        }),
      ],
    });
    expect(await locator.getAttribute("data-container")).toBe("Work");
    expect(await locator.inputValue()).toBe("rules:\n");
  });

  it("counts without waiting", async () => {
    const { locator } = locatorOn({ elements: () => [] });
    expect(await locator.count()).toBe(0);
  });

  it("answers isVisible false for an element that is not there, rather than waiting", async () => {
    const { locator } = locatorOn({ elements: () => [] });
    expect(await locator.isVisible()).toBe(false);
  });

  it.each([
    ["attached", (n: number) => (n < 2 ? [] : [anElement()])],
    ["detached", (n: number) => (n < 2 ? [anElement()] : [])],
    ["visible", (n: number) => (n < 2 ? [] : [anElement()])],
    ["hidden", (n: number) => (n < 2 ? [anElement()] : [])],
  ])("waits for state %s", async (state, elements) => {
    const { locator } = locatorOn({ elements });
    await expect(
      locator.waitFor({ state: state as "attached" | "detached" | "visible" | "hidden" }),
    ).resolves.toBeUndefined();
  });

  it("names the selector and the page when it gives up", async () => {
    const { locator } = locatorOn({ elements: () => [] });
    await expect(locator.innerText()).rejects.toThrow(/innerText #cc-save.*ids=\[cc-config\]/s);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run test/harness/browser/locator.test.ts`
Expected: FAIL — cannot resolve `harness/browser/locator`.

- [ ] **Step 3: Write `harness/browser/locator.ts`**

```ts
// A locator is a page plus a selector, and NEVER an element: there is no accessor that
// hands out something which can go stale, because a handle that outlives its document is
// the bug this layer exists to remove. See the 2026-08-25 design spec §3-§4.
import { By, type WebElement } from "selenium-webdriver";
import { RETRY, poll } from "./retry";
import type { LocatorState, PageContext, WaitOpts } from "./types";

// Playwright's own definition — a non-empty bounding box that is not visibility:hidden —
// through two W3C endpoints, because an injected script is refused on an extension page.
async function isVisibleNow(element: WebElement): Promise<boolean> {
  const { width, height } = await element.getRect();
  if (width === 0 || height === 0) return false;
  return (await element.getCssValue("visibility")) !== "hidden";
}

export class Locator {
  constructor(
    private readonly page: PageContext,
    readonly selector: string,
    private readonly interval?: number,
  ) {}

  private async first(): Promise<WebElement | undefined> {
    await this.page.switchHere();
    return (await this.page.driver.findElements(By.css(this.selector)))[0];
  }

  private run<T>(
    what: string,
    opts: WaitOpts | undefined,
    body: (element: WebElement) => Promise<T | typeof RETRY>,
  ): Promise<T> {
    return poll(
      {
        timeout: opts?.timeout ?? this.page.defaultTimeout,
        what: `${what} ${this.selector}`,
        diagnose: () => this.page.diagnose(),
        ...(this.interval === undefined ? {} : { interval: this.interval }),
      },
      async () => {
        const element = await this.first();
        return element === undefined ? RETRY : body(element);
      },
    );
  }

  click(opts?: WaitOpts): Promise<void> {
    return this.run("click", opts, async (element) => {
      if (!(await isVisibleNow(element))) return RETRY;
      if (!(await element.isEnabled())) return RETRY;
      await element.click();
    });
  }

  // clear() + sendKeys(), never an assignment: these are protocol commands rather than
  // injected script, and they fire the `input` event the page validates on.
  fill(text: string, opts?: WaitOpts): Promise<void> {
    return this.run("fill", opts, async (element) => {
      if (!(await isVisibleNow(element))) return RETRY;
      if (!(await element.isEnabled())) return RETRY;
      if ((await element.getDomAttribute("readonly")) !== null) return RETRY;
      await element.clear();
      await element.sendKeys(text);
    });
  }

  // No actionability checks, matching Playwright: a key goes to whatever is there.
  press(key: string, opts?: WaitOpts): Promise<void> {
    return this.run("press", opts, (element) => element.sendKeys(key));
  }

  innerText(opts?: WaitOpts): Promise<string> {
    return this.run("innerText", opts, (element) => element.getText());
  }

  textContent(opts?: WaitOpts): Promise<string | null> {
    return this.run("textContent", opts, async (element) => {
      return (await element.getProperty("textContent")) as string | null;
    });
  }

  // getDomAttribute, not getAttribute: the W3C endpoint rather than the injected atom,
  // and the DOM attribute is what Playwright's getAttribute returns anyway.
  getAttribute(name: string, opts?: WaitOpts): Promise<string | null> {
    return this.run(`getAttribute(${name})`, opts, (element) => element.getDomAttribute(name));
  }

  inputValue(opts?: WaitOpts): Promise<string> {
    return this.run("inputValue", opts, async (element) => {
      return (await element.getProperty("value")) as string;
    });
  }

  // Immediate, as in Playwright: these answer about now, and the waiting belongs in the
  // assertion (`expect(locator).toBeVisible()`) rather than the question.
  async count(): Promise<number> {
    await this.page.switchHere();
    return (await this.page.driver.findElements(By.css(this.selector))).length;
  }

  async isVisible(): Promise<boolean> {
    const element = await this.first();
    return element === undefined ? false : isVisibleNow(element);
  }

  async isEnabled(): Promise<boolean> {
    const element = await this.first();
    return element === undefined ? false : element.isEnabled();
  }

  async waitFor(opts?: { state?: LocatorState } & WaitOpts): Promise<void> {
    const state = opts?.state ?? "visible";
    await poll(
      {
        timeout: opts?.timeout ?? this.page.defaultTimeout,
        what: `waitFor(${state}) ${this.selector}`,
        diagnose: () => this.page.diagnose(),
        ...(this.interval === undefined ? {} : { interval: this.interval }),
      },
      async () => {
        const element = await this.first();
        const met = await this.meets(state, element);
        return met ? undefined : RETRY;
      },
    );
  }

  private async meets(state: LocatorState, element: WebElement | undefined): Promise<boolean> {
    switch (state) {
      case "attached":
        return element !== undefined;
      case "detached":
        return element === undefined;
      case "visible":
        return element !== undefined && (await isVisibleNow(element));
      case "hidden":
        return element === undefined || !(await isVisibleNow(element));
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/harness/browser && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add harness/browser/locator.ts test/harness/browser/locator.test.ts
git commit -m "feat(harness): a locator that re-resolves, and waits for what Playwright waits for"
```

---

### Task 5: Page

**Files:**
- Create: `harness/browser/page.ts`
- Test: `test/harness/browser/page.test.ts`

**Interfaces:**
- Consumes: `Locator`, `PageContext`, `PageReport`, `DEFAULT_TIMEOUT_MS`.
- Produces: `class Page implements PageContext` with `locator(selector)`, `keyboard.press(key)`, `goto(url)`, `url()`, `title()`, `close()`, `describe()`, `diagnose()`, and the readonly `handle` / `driver` / `defaultTimeout`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Page } from "../../../harness/browser/page";
import { fakeDriver, anElement } from "./fake-driver";

describe("Page", () => {
  it("switches to its own window before acting, whatever the driver was on", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [], handles: ["w1", "w2"] });
    await new Page(driver, "w2").goto("http://example.test/");
    expect(calls).toEqual(["switchTo(w2)", "get(http://example.test/)"]);
  });

  it("sends a key to whatever has focus, in its own window", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [] });
    await new Page(driver, "w1").keyboard.press("Enter");
    expect(calls).toEqual(["switchTo(w1)", "sendKeys(Enter)"]);
  });

  it("makes a locator that belongs to it", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [anElement({ getText: async () => "Save" })] });
    const page = new Page(driver, "w2");
    expect(await page.locator("#cc-save").innerText()).toBe("Save");
    expect(calls[0]).toBe("switchTo(w2)");
  });

  // What a failure gets to say. The ids are the useful half: "the element was missing" and
  // "the document had not parsed" look identical without them.
  it("describes itself with the ids that were actually there", async () => {
    const { driver } = fakeDriver({
      elements: () => [
        anElement({ getDomAttribute: async () => "cc-config" }),
        anElement({ getDomAttribute: async () => "cc-save" }),
      ],
      url: "moz-extension://cc/options.html",
      title: "config",
      handles: ["w1", "w2"],
    });
    const report = await new Page(driver, "w1").describe();
    expect(report).toEqual({
      url: "moz-extension://cc/options.html",
      title: "config",
      ids: ["cc-config", "cc-save"],
      tabs: ["moz-extension://cc/options.html", "moz-extension://cc/options.html"],
    });
  });

  it("renders the report as one line a failure can carry", async () => {
    const { driver } = fakeDriver({ elements: () => [], url: "http://x.test/", title: "x" });
    expect(await new Page(driver, "w1").diagnose()).toMatch(/http:\/\/x\.test\/.*ids=\[\]/s);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run test/harness/browser/page.test.ts`
Expected: FAIL — cannot resolve `harness/browser/page`.

- [ ] **Step 3: Write `harness/browser/page.ts`**

```ts
// One browser tab. Everything it does begins by switching to its own window handle: that
// is what turns Selenium's hidden "current window" into something a caller can rely on.
import { By, type WebDriver } from "selenium-webdriver";
import { Locator } from "./locator";
import { DEFAULT_TIMEOUT_MS } from "./retry";
import type { PageContext, PageReport } from "./types";

export class Page implements PageContext {
  constructor(
    readonly driver: WebDriver,
    readonly handle: string,
    readonly defaultTimeout: number = DEFAULT_TIMEOUT_MS,
    private readonly interval?: number,
  ) {}

  locator(selector: string): Locator {
    return new Locator(this, selector, this.interval);
  }

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      await this.switchHere();
      await this.driver.actions().sendKeys(key).perform();
    },
  };

  async switchHere(): Promise<void> {
    await this.driver.switchTo().window(this.handle);
  }

  // Honest: a navigation this extension cancels never returns, and tolerating that is the
  // harness's job (a fresh tab plus awaitContainerTab), not this layer's.
  async goto(url: string): Promise<void> {
    await this.switchHere();
    await this.driver.get(url);
  }

  async url(): Promise<string> {
    await this.switchHere();
    return this.driver.getCurrentUrl();
  }

  async title(): Promise<string> {
    await this.switchHere();
    return this.driver.getTitle();
  }

  async close(): Promise<void> {
    await this.switchHere();
    await this.driver.close();
  }

  async describe(): Promise<PageReport> {
    await this.switchHere();
    const ids: string[] = [];
    for (const element of await this.driver.findElements(By.css("[id]"))) {
      const id = await element.getDomAttribute("id");
      if (id !== null) ids.push(id);
    }
    const tabs: string[] = [];
    for (const handle of await this.driver.getAllWindowHandles()) {
      await this.driver.switchTo().window(handle);
      tabs.push(await this.driver.getCurrentUrl());
    }
    await this.switchHere();
    return { url: await this.driver.getCurrentUrl(), title: await this.driver.getTitle(), ids, tabs };
  }

  async diagnose(): Promise<string> {
    try {
      const report = await this.describe();
      return `  page: ${report.url} (${report.title})\n  ids=[${report.ids.join(", ")}]\n  tabs=${JSON.stringify(report.tabs)}`;
    } catch (e) {
      // A diagnosis that throws would replace the real failure with its own.
      return `  page: could not be described (${(e as Error).message})`;
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/harness/browser && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add harness/browser/page.ts test/harness/browser/page.test.ts
git commit -m "feat(harness): a page that pins its own window and can describe itself"
```

---

### Task 6: BrowserSession

**Files:**
- Create: `harness/browser/session.ts`
- Create: `harness/browser/index.ts`
- Test: `test/harness/browser/session.test.ts`

**Interfaces:**
- Produces: `class BrowserSession` with `pages()`, `pageAt(urlPrefix, opts?)`, `newPage()`; `index.ts` re-exports `BrowserSession`, `Page`, `Locator`, the timeout constants and the types.
- **Deliberately no `close()`**, against the spec's §3 sketch: `harness/firefox.ts` owns the browser's life, and `harness/reaper.ts` exists because a second owner is how a Firefox gets leaked. Task 8 amends the spec.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { BrowserSession } from "../../../harness/browser/session";
import { fakeDriver } from "./fake-driver";

describe("BrowserSession", () => {
  it("hands out a page per window handle", async () => {
    const { driver } = fakeDriver({ elements: () => [], handles: ["w1", "w2", "w3"] });
    const pages = await new BrowserSession(driver).pages();
    expect(pages.map((p) => p.handle)).toEqual(["w1", "w2", "w3"]);
  });

  it("finds the page showing a url", async () => {
    const { driver } = fakeDriver({
      elements: () => [],
      handles: ["w1", "w2"],
      url: "moz-extension://cc/options.html",
    });
    const page = await new BrowserSession(driver, 500, 0).pageAt("moz-extension://cc/options.html");
    expect(page.handle).toBe("w1");
  });

  it("says what it saw when no page shows the url", async () => {
    const { driver } = fakeDriver({ elements: () => [], handles: ["w1"], url: "http://x.test/" });
    await expect(new BrowserSession(driver, 0, 0).pageAt("moz-extension://cc/")).rejects.toThrow(
      /moz-extension:\/\/cc\/.*http:\/\/x\.test\//s,
    );
  });

  it("opens a fresh tab and returns it", async () => {
    const { driver, calls } = fakeDriver({ elements: () => [], handles: ["w1"] });
    const page = await new BrowserSession(driver).newPage();
    expect(calls).toContain("newWindow");
    expect(page.handle).toBe("w2");
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run test/harness/browser/session.test.ts`
Expected: FAIL — cannot resolve `harness/browser/session`.

- [ ] **Step 3: Write `harness/browser/session.ts`**

```ts
// The browser. It hands out Pages and knows nothing else — no containers, no probe, no
// extension. What is CC-specific lives in harness/firefox.ts and takes a Page.
import type { WebDriver } from "selenium-webdriver";
import { Page } from "./page";
import { DEFAULT_TIMEOUT_MS, RETRY, poll } from "./retry";
import type { WaitOpts } from "./types";

export class BrowserSession {
  constructor(
    private readonly driver: WebDriver,
    private readonly defaultTimeout: number = DEFAULT_TIMEOUT_MS,
    private readonly interval?: number,
  ) {}

  private page(handle: string): Page {
    return new Page(this.driver, handle, this.defaultTimeout, this.interval);
  }

  async pages(): Promise<Page[]> {
    return (await this.driver.getAllWindowHandles()).map((handle) => this.page(handle));
  }

  async pageAt(urlPrefix: string, opts?: WaitOpts): Promise<Page> {
    let seen: string[] = [];
    return poll(
      {
        timeout: opts?.timeout ?? this.defaultTimeout,
        what: `a page at ${urlPrefix}`,
        diagnose: async () => `  saw ${JSON.stringify(seen)}`,
        ...(this.interval === undefined ? {} : { interval: this.interval }),
      },
      async () => {
        seen = [];
        for (const handle of await this.driver.getAllWindowHandles()) {
          // A tab can go while we are walking the list — CC closes one per reopen.
          try {
            await this.driver.switchTo().window(handle);
            const url = await this.driver.getCurrentUrl();
            seen.push(url);
            if (url.startsWith(urlPrefix)) return this.page(handle);
          } catch {
            continue;
          }
        }
        return RETRY;
      },
    );
  }

  async newPage(): Promise<Page> {
    await this.driver.switchTo().newWindow("tab");
    return this.page(await this.driver.getWindowHandle());
  }
}
```

- [ ] **Step 4: Write `harness/browser/index.ts`**

```ts
export { BrowserSession } from "./session";
export { Page } from "./page";
export { Locator } from "./locator";
export { ASSERTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from "./retry";
export type { LocatorState, PageReport, WaitOpts } from "./types";
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/harness/browser && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add harness/browser/session.ts harness/browser/index.ts test/harness/browser/session.test.ts
git commit -m "feat(harness): a session that hands out pages by url"
```

---

### Task 7: Retrying assertions

Playwright's central promise is that assertions retry too — its docs steer text comparisons to `expect(locator).toHaveText()` precisely because reading and then comparing flakes. Without this half, the Playwright habit produces the failure this work exists to remove.

**Files:**
- Create: `harness/browser/matchers.ts`
- Test: `test/harness/browser/matchers.test.ts`

**Interfaces:**
- Consumes: `Locator`, `ASSERTION_TIMEOUT_MS`, `poll`, `RETRY`.
- Produces: a side-effect import registering `toHaveText`, `toContainText`, `toHaveValue`, `toHaveCount`, `toBeVisible`, `toBeEnabled` on vitest's `expect`, with a 5s default. Files that use them do `import "../../harness/browser/matchers";`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Locator } from "../../../harness/browser/locator";
import type { PageContext } from "../../../harness/browser/types";
import { fakeDriver, anElement, type FakeScript } from "./fake-driver";
import "../../../harness/browser/matchers";

function locatorOn(script: FakeScript) {
  const { driver } = fakeDriver(script);
  const page: PageContext = {
    driver,
    handle: "w1",
    defaultTimeout: 500,
    async switchHere() {},
    async diagnose() {
      return "ids=[cc-status]";
    },
  };
  return new Locator(page, "#cc-status", 0);
}

const saying = (text: (n: number) => string) =>
  locatorOn({ elements: (n) => [anElement({ getText: async () => text(n) })] });

describe("retrying matchers", () => {
  it("waits for the text to arrive", async () => {
    await expect(saying((n) => (n < 3 ? "Saving…" : "Saved"))).toHaveText("Saved", { timeout: 500 });
  });

  // Exact, as Playwright's toHaveText is — this suite has a "Saved — a script could not be
  // registered: …" that must not satisfy a wait for "Saved".
  it("does not accept a longer message as the text", async () => {
    await expect(
      expect(saying(() => "Saved — a script could not be registered: x")).toHaveText("Saved", {
        timeout: 0,
      }),
    ).rejects.toThrow(/toHaveText/);
  });

  it("accepts the substring form when that is what was asked", async () => {
    await expect(saying(() => "Saved — a script could not be registered: x")).toContainText("Saved", {
      timeout: 0,
    });
  });

  it("matches a regular expression", async () => {
    await expect(saying(() => "Synced via Firefox Sync (1 part)")).toHaveText(/Synced via/, {
      timeout: 0,
    });
  });

  it("waits for a value, a count, visibility and enabledness", async () => {
    await expect(
      locatorOn({ elements: () => [anElement({ getProperty: async () => "rules:\n" })] }),
    ).toHaveValue("rules:\n", { timeout: 0 });
    await expect(locatorOn({ elements: () => [anElement(), anElement()] })).toHaveCount(2, {
      timeout: 0,
    });
    await expect(locatorOn({ elements: () => [anElement()] })).toBeVisible({ timeout: 0 });
    await expect(locatorOn({ elements: () => [anElement()] })).toBeEnabled({ timeout: 0 });
  });

  it("reports what it last saw when it gives up", async () => {
    await expect(
      expect(saying(() => "Saving…")).toHaveText("Saved", { timeout: 0 }),
    ).rejects.toThrow(/Saving…/);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run test/harness/browser/matchers.test.ts`
Expected: FAIL — cannot resolve `harness/browser/matchers`.

- [ ] **Step 3: Write `harness/browser/matchers.ts`**

```ts
// Playwright's web-first assertions, in vitest's idiom: the comparison retries, so a page
// that has not finished rendering is a wait rather than a failure. Imported for effect by
// the e2e files that use them.
import { expect } from "vitest";
import type { Locator } from "./locator";
import { ASSERTION_TIMEOUT_MS, RETRY, poll } from "./retry";
import type { WaitOpts } from "./types";

interface Verdict {
  pass: boolean;
  message: () => string;
}

// One shape for every matcher: poll the reading until the comparison holds, and report
// the LAST reading when it never does — "expected Saved, got Saving…" is the whole
// diagnosis, and a matcher that only says "timed out" throws it away.
async function settle<T>(
  locator: Locator,
  name: string,
  opts: WaitOpts | undefined,
  read: () => Promise<T>,
  holds: (seen: T) => boolean,
  describe: (seen: T) => string,
): Promise<Verdict> {
  let last: T | undefined;
  try {
    await poll(
      {
        timeout: opts?.timeout ?? ASSERTION_TIMEOUT_MS,
        what: `${name} ${locator.selector}`,
        diagnose: async () => "",
      },
      async () => {
        last = await read();
        return holds(last) ? undefined : RETRY;
      },
    );
    return { pass: true, message: () => `${name} ${locator.selector} held` };
  } catch {
    return {
      pass: false,
      message: () => `${name} ${locator.selector}: ${describe(last as T)}`,
    };
  }
}

const trimmed = (s: string) => s.trim();

expect.extend({
  async toHaveText(locator: Locator, expected: string | RegExp, opts?: WaitOpts) {
    return settle(
      locator,
      "toHaveText",
      opts,
      () => locator.innerText({ timeout: 0 }),
      (seen) =>
        expected instanceof RegExp ? expected.test(seen) : trimmed(seen) === trimmed(expected),
      (seen) => `expected ${String(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toContainText(locator: Locator, expected: string, opts?: WaitOpts) {
    return settle(
      locator,
      "toContainText",
      opts,
      () => locator.innerText({ timeout: 0 }),
      (seen) => seen.includes(expected),
      (seen) => `expected to contain ${JSON.stringify(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toHaveValue(locator: Locator, expected: string, opts?: WaitOpts) {
    return settle(
      locator,
      "toHaveValue",
      opts,
      () => locator.inputValue({ timeout: 0 }),
      (seen) => seen === expected,
      (seen) => `expected ${JSON.stringify(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toHaveCount(locator: Locator, expected: number, opts?: WaitOpts) {
    return settle(
      locator,
      "toHaveCount",
      opts,
      () => locator.count(),
      (seen) => seen === expected,
      (seen) => `expected ${expected}, last saw ${seen}`,
    );
  },

  async toBeVisible(locator: Locator, opts?: WaitOpts) {
    return settle(
      locator,
      "toBeVisible",
      opts,
      () => locator.isVisible(),
      (seen) => seen,
      () => "never became visible",
    );
  },

  async toBeEnabled(locator: Locator, opts?: WaitOpts) {
    return settle(
      locator,
      "toBeEnabled",
      opts,
      () => locator.isEnabled(),
      (seen) => seen,
      () => "never became enabled",
    );
  },
});

declare module "vitest" {
  interface Matchers<T = unknown> {
    toHaveText(expected: string | RegExp, opts?: WaitOpts): Promise<T>;
    toContainText(expected: string, opts?: WaitOpts): Promise<T>;
    toHaveValue(expected: string, opts?: WaitOpts): Promise<T>;
    toHaveCount(expected: number, opts?: WaitOpts): Promise<T>;
    toBeVisible(opts?: WaitOpts): Promise<T>;
    toBeEnabled(opts?: WaitOpts): Promise<T>;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/harness/browser && npm run typecheck && npm run lint`
Expected: PASS, clean. If the `declare module "vitest"` augmentation does not take, check Vitest 4's expected interface name with `npx tsc --noEmit` output rather than guessing — the matcher bodies are correct either way.

- [ ] **Step 5: Commit**

```bash
git add harness/browser/matchers.ts test/harness/browser/matchers.test.ts
git commit -m "feat(harness): assertions that retry, which is the other half of the promise"
```

---

### Task 8: Give the harness session a browser

**Files:**
- Modify: `harness/firefox.ts` (the `Session` interface and `launch`'s return)
- Modify: `docs/superpowers/specs/2026-08-25-browser-session-design.md` (§3: no `BrowserSession.close`)

**Interfaces:**
- Consumes: `BrowserSession`.
- Produces: `Session.browser: BrowserSession`, alongside the existing `Session.driver`, which stays until the second plan removes the tests' need for it.

- [ ] **Step 1: Add the field**

In `harness/firefox.ts`, add the import beside the other local ones:

```ts
import { BrowserSession } from "./browser/index";
```

Add the field to the `Session` interface (currently at line 50), directly under `driver`:

```ts
export interface Session {
  driver: WebDriver;
  // The same browser through the auto-waiting API. `driver` stays for now: the harness's
  // own internals use it, and the e2e files move over one at a time.
  browser: BrowserSession;
  serverUrl: string;
```

And add it to what `launch` returns (currently line 282):

```ts
  return {
    driver,
    browser: new BrowserSession(driver),
    serverUrl: server.url,
    profileDir,
```

Do not touch `close()` — the harness owns the browser's life, and `harness/reaper.ts` is a long argument about what a second owner costs.

- [ ] **Step 2: Amend the spec**

In §3 of the design doc, remove `close(): Promise<void>` from `BrowserSession` and add below the block:

```markdown
**No `close()` on the session.** The harness owns the browser's lifetime — `launch()`
made the profile the reaper watches, and a second owner is how a Firefox survives a run.
```

- [ ] **Step 3: Verify nothing regressed**

Run: `npm run typecheck && npm run lint && FIREFOX_BIN=/Applications/Firefox.app/Contents/MacOS/firefox npx vitest run test/e2e/config-sync.test.ts`
Expected: PASS — nothing uses `browser` yet.

- [ ] **Step 4: Commit**

```bash
git add harness/firefox.ts docs/superpowers/specs/2026-08-25-browser-session-design.md
git commit -m "feat(harness): hand launch()'s session a browser"
```

---

### Task 9: Convert `config-sync.test.ts`, the file whose flake started this

**Files:**
- Modify: `test/e2e/config-sync.test.ts`

**Interfaces:**
- Consumes: `Session.browser`, `Page`, the matchers.
- Produces: the pattern the second plan applies to the other 16 files.

- [ ] **Step 1: Rewrite the case against the new API**

Replace the imports of `By`/`WebDriver`/`awaitElement`/`switchToUrl` with the browser API and the matchers:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, openExtensionPage, ccExtensionUrl, type Session } from "../../harness/firefox";
import "../../harness/browser/matchers";
```

Replace the body of the `it(...)` and delete `awaitSyncStatus` entirely:

```ts
    it(behaviour, async () => {
      // Park on a probe-reported page so the cc-probe-cmd relay exists; the cache-buster
      // forces a fresh probe report.
      const url = `http://work.example:${serverPort}/?cb=sync-${Date.now()}`;
      try {
        await firefox.driver.get(url);
      } catch {
        // First visit reopens the tab into Work, tearing this one down — expected.
      }
      await awaitContainerTab(firefox.driver, url);

      await openExtensionPage(firefox.driver, OPTIONS_URL);
      const options = await firefox.browser.pageAt(OPTIONS_URL);

      // The status line is rendered from a live read of storage.sync, so the assertion is
      // what waits: no element to find first, no poll loop, and a failure that reports the
      // last text it saw rather than a missing selector.
      const status = options.locator("#cc-sync");
      await expect(status).toHaveText(want);
      check(await status.innerText());
    });
```

- [ ] **Step 2: Run it against real Firefox**

Run: `FIREFOX_BIN=/Applications/Firefox.app/Contents/MacOS/firefox npx vitest run test/e2e/config-sync.test.ts`
Expected: PASS, both cases.

- [ ] **Step 3: Prove the assertion actually waits**

Temporarily change `toHaveText(want)` to `toHaveText(/never appears/)`, run again, and confirm the failure names the **last text it saw** rather than a timeout with no content. Restore.

Expected: `toHaveText #cc-sync: expected /never appears/, last saw "Synced via Firefox Sync…"`

- [ ] **Step 4: Full suite**

Run: `FIREFOX_BIN=/Applications/Firefox.app/Contents/MacOS/firefox npm test`
Expected: all green (824 passed / 1 skipped as of a042f48, plus the new unit and privileged-protocol cases).

- [ ] **Step 5: Commit**

```bash
git add test/e2e/config-sync.test.ts
git commit -m "test(e2e): drive the sync status through the browser API"
```

---

## What this plan does not do

The other 16 e2e files, the removal of `switchToUrl`/`awaitElement`, moving the probe readers onto `Page`, and the CLAUDE.md e2e rewrite are the second plan. They are deliberately not guessed at here: the migration's shape is a question about how this API reads in the files that use it hardest (`options`, `choice`), and one converted file is the evidence that plan should be written from.
