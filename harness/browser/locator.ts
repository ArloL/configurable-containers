// A locator is a page plus a selector, and NEVER an element: there is no accessor that
// hands out something which can go stale, because a handle that outlives its document is
// the bug this layer exists to remove. See the 2026-08-25 design spec §3-§4.
import { By, type WebElement } from "selenium-webdriver";
import { RETRY, poll } from "./retry";
import type { LocatorState, PageContext, WaitOpts } from "./types";

// Playwright's own definition — a non-empty bounding box that is not visibility:hidden —
// through two W3C endpoints, because an injected script is refused on an extension page
// from Firefox 156 on (test/e2e/privileged-protocol.test.ts measures that these are not).
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
    private readonly index = 0,
  ) {}

  // As in Playwright: nth narrows to one of several matches, all() answers with a locator
  // per match RIGHT NOW (it does not wait — a list that might still be growing is a
  // question about a moment, and the caller is the one who knows which moment).
  nth(index: number): Locator {
    return new Locator(this.page, this.selector, this.interval, index);
  }

  async all(): Promise<Locator[]> {
    return Array.from({ length: await this.count() }, (_, i) => this.nth(i));
  }

  private async first(): Promise<WebElement | undefined> {
    await this.page.switchHere();
    return (await this.page.driver.findElements(By.css(this.selector)))[this.index];
  }

  private run<T>(
    what: string,
    opts: WaitOpts | undefined,
    body: (element: WebElement) => Promise<T | typeof RETRY>,
  ): Promise<T> {
    return poll(
      {
        timeout: opts?.timeout ?? this.page.defaultTimeout,
        what: `${what} ${this.describeSelf()}`,
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

  // Playwright's textContent answers null for an element without any; Selenium's types
  // say string, so the null is in the signature rather than in a cast.
  textContent(opts?: WaitOpts): Promise<string | null> {
    return this.run("textContent", opts, (element) => element.getProperty("textContent"));
  }

  // getDomAttribute, not getAttribute: the W3C endpoint rather than the injected atom,
  // and the DOM attribute is what Playwright's getAttribute returns anyway.
  getAttribute(name: string, opts?: WaitOpts): Promise<string | null> {
    return this.run(`getAttribute(${name})`, opts, (element) => element.getDomAttribute(name));
  }

  inputValue(opts?: WaitOpts): Promise<string> {
    return this.run("inputValue", opts, (element) => element.getProperty("value"));
  }

  // Immediate, as in Playwright: these answer about now, and the waiting belongs in the
  // assertion (`expect(locator).toBeVisible()`) rather than in the question.
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
        what: `waitFor(${state}) ${this.describeSelf()}`,
        diagnose: () => this.page.diagnose(),
        ...(this.interval === undefined ? {} : { interval: this.interval }),
      },
      async () => {
        const element = await this.first();
        return (await this.meets(state, element)) ? undefined : RETRY;
      },
    );
  }

  private describeSelf(): string {
    return this.index === 0 ? this.selector : `${this.selector} [${this.index}]`;
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
