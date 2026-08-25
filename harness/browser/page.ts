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
