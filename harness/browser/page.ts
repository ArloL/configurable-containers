// One browser tab. Everything it does begins by switching to its own window handle: that
// is what turns Selenium's hidden "current window" into something a caller can rely on.
import { By, type WebDriver } from "selenium-webdriver";
import { Locator } from "./locator";
import { DEFAULT_TIMEOUT_MS, RETRY, poll } from "./retry";
import { GONE, type PageContext, type PageReport, type WaitOpts } from "./types";

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
    //
    // Whatever survives, not whatever was listed: a handle can be named by
    // `getAllWindowHandles` and already gone, because the extension closes tabs on its own
    // schedule (see BrowserSession.newPage, where that cost a CI run). Best effort — every
    // Page operation switches to its own handle first, so failing to find an anchor here is
    // only a missed courtesy, not a broken session.
    for (const handle of await this.driver.getAllWindowHandles()) {
      try {
        await this.driver.switchTo().window(handle);
        return;
      } catch {
        continue;
      }
    }
  }

  // What a failure gets to say, gathered in two independent halves so that losing one does
  // not cost the other.
  //
  // Every part of this used to assume a handle that `getAllWindowHandles` named would still
  // be there when we switched to it — the snapshot assumption `384cdfb` took out of `close`
  // and `BrowserSession.newPage` and left here. The inversion that made it worth fixing:
  // `diagnose()` catches the throw and answers "could not be described", so the report
  // vanished precisely when the extension was churning tabs, which is when a poll times out
  // and when its tab list is most worth having.
  //
  // The TAB LIST GOES FIRST because it is the half that survives this page's own tab being
  // closed — and the tab a poll was waiting on is the likeliest one to have gone.
  async describe(): Promise<PageReport> {
    const tabs: string[] = [];
    for (const handle of await this.driver.getAllWindowHandles()) {
      try {
        await this.driver.switchTo().window(handle);
        tabs.push(await this.driver.getCurrentUrl());
      } catch {
        // Listed and already gone. Recorded rather than skipped: this is the churn the
        // reader is trying to understand, and a list that quietly got shorter hides it.
        tabs.push(GONE);
      }
    }

    const ids: string[] = [];
    let url: string | null = null;
    let title: string | null = null;
    try {
      await this.switchHere();
      for (const element of await this.driver.findElements(By.css("[id]"))) {
        const id = await element.getDomAttribute("id");
        if (id !== null) ids.push(id);
      }
      url = await this.driver.getCurrentUrl();
      title = await this.driver.getTitle();
    } catch {
      // This page's own tab has gone. `url === null` says so, and the tabs above still
      // say what the browser has instead — which is the whole answer a reader wants.
    }
    return { url, title, ids, tabs };
  }

  async diagnose(): Promise<string> {
    try {
      const report = await this.describe();
      // Said in words rather than printed as `null`: "this tab has gone" is a finding, and
      // the line below it is then the list of what the browser has instead.
      const where =
        report.url === null
          ? `  page: this tab (${this.handle}) has gone`
          : `  page: ${report.url} (${report.title})`;
      return `${where}\n  ids=[${report.ids.join(", ")}]\n  tabs=${JSON.stringify(report.tabs)}`;
    } catch (e) {
      // A diagnosis that throws would replace the real failure with its own.
      return `  page: could not be described (${(e as Error).message})`;
    }
  }
}
