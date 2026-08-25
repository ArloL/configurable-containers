// The browser. It hands out Pages and knows nothing else — no containers, no probe, no
// extension. What is CC-specific lives in harness/firefox.ts and takes a Page.
//
// No close(): harness/firefox.ts owns the browser's lifetime. `launch()` made the profile
// directory the reaper identifies its processes by, and a second owner is how a Firefox
// survives a run — see harness/reaper.ts.
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
    // The driver may have no current window at all: the extension can discard the tab it
    // was left on, and `newWindow` still has to run in SOME context. Anchor on a survivor
    // first, so opening a tab does not depend on where the driver happened to be.
    const [survivor] = await this.driver.getAllWindowHandles();
    if (survivor !== undefined) await this.driver.switchTo().window(survivor);
    await this.driver.switchTo().newWindow("tab");
    return this.page(await this.driver.getWindowHandle());
  }
}
