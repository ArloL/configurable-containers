// One browser tab. Everything it does begins by switching to its own window handle: that
// is what turns Selenium's hidden "current window" into something a caller can rely on.
import { By, type WebDriver } from "selenium-webdriver";
import { Locator } from "./locator";
import { DEFAULT_TIMEOUT_MS, RETRY, poll } from "./retry";
import type { PageContext, PageReport, WaitOpts } from "./types";

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

  // Playwright's page.waitForURL. Here it is also how a test waits out a navigation that
  // stays in the SAME tab — a POST CC declined to reopen, say — without polling by hand.
  async waitForURL(urlPrefix: string, opts?: WaitOpts): Promise<void> {
    let seen = "";
    await poll(
      {
        timeout: opts?.timeout ?? this.defaultTimeout,
        what: `waitForURL(${urlPrefix})`,
        diagnose: async () => `  last url: ${seen}`,
        ...(this.interval === undefined ? {} : { interval: this.interval }),
      },
      async () => {
        seen = await this.url();
        return seen.startsWith(urlPrefix) ? undefined : RETRY;
      },
    );
  }

  async title(): Promise<string> {
    await this.switchHere();
    return this.driver.getTitle();
  }

  async close(): Promise<void> {
    await this.switchHere();
    await this.driver.close();
    // Closing the ACTIVE tab leaves the driver with no current window, and the next
    // command fails with NoSuchWindow wherever it happens to be — miles from the close
    // that caused it. Re-attach to whatever survives, so a page's lifetime is its own
    // business and closing one is not a trap for the next read.
    const [survivor] = await this.driver.getAllWindowHandles();
    if (survivor !== undefined) await this.driver.switchTo().window(survivor);
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
    return {
      url: await this.driver.getCurrentUrl(),
      title: await this.driver.getTitle(),
      ids,
      tabs,
    };
  }

  async diagnose(): Promise<string> {
    try {
      const report = await this.describe();
      return (
        `  page: ${report.url} (${report.title})\n` +
        `  ids=[${report.ids.join(", ")}]\n` +
        `  tabs=${JSON.stringify(report.tabs)}`
      );
    } catch (e) {
      // A diagnosis that throws would replace the real failure with its own.
      return `  page: could not be described (${(e as Error).message})`;
    }
  }
}
