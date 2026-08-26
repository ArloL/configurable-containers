// The browser. It hands out Pages and knows nothing else — no containers, no probe, no
// extension. What is CC-specific lives in harness/firefox.ts and takes a Page.
//
// No close(): harness/firefox.ts owns the browser's lifetime. `launch()` made the profile
// directory the reaper identifies its processes by, and a second owner is how a Firefox
// survives a run — see harness/reaper.ts.
import type { WebDriver } from "selenium-webdriver";
import { Page } from "./page";
import { DEFAULT_TIMEOUT_MS, RETRY, isRetryable, poll } from "./retry";
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
          try {
            await this.driver.switchTo().window(handle);
            const url = await this.driver.getCurrentUrl();
            seen.push(url);
            if (url.startsWith(urlPrefix)) return this.page(handle);
          } catch (e) {
            // A tab can go while we are walking the list — CC closes one per reopen — so
            // that handle is passed over and the next one tried.
            //
            // But only that. `retry.ts` is explicit that a driver which has died is not
            // something to wait out, and `newPage` already draws the line here; this loop
            // swallowed everything, so a dead session was polled for the full budget and
            // then reported as "no page at <url>" — the driver's own error, which said
            // what was wrong, discarded once per 100ms until the timeout replaced it.
            if (isRetryable(e)) continue;
            throw e;
          }
        }
        return RETRY;
      },
    );
  }

  async newPage(opts?: WaitOpts): Promise<Page> {
    // The driver may have no current window at all — the extension can discard the tab it
    // was left on — and `newWindow` still has to run in SOME context. So it anchors on a
    // survivor first, and the anchoring is a POLL rather than a read: a handle that
    // `getAllWindowHandles` named a moment ago can be gone by the time we switch to it,
    // because the extension closes tabs on its own schedule and not on ours. The
    // auto-temp STARTUP SWEEP is that schedule at its worst — it replaces the very tab
    // Firefox opened, while the session is still starting — and it is where this was
    // measured: `NoSuchWindowError` out of the switch on line one of a case, one run in
    // three, in a case whose own comment says nothing has to be re-anchored for it.
    //
    // Reading the list again is the point. Retrying the same dead handle would spin.
    let seen: string[] = [];
    return poll(
      {
        timeout: opts?.timeout ?? this.defaultTimeout,
        what: "a window to open a tab from",
        diagnose: async () => `  last handles: ${JSON.stringify(seen)}`,
        ...(this.interval === undefined ? {} : { interval: this.interval }),
      },
      async () => {
        seen = await this.driver.getAllWindowHandles();
        for (const handle of seen) {
          try {
            await this.driver.switchTo().window(handle);
            await this.driver.switchTo().newWindow("tab");
            return this.page(await this.driver.getWindowHandle());
          } catch (e) {
            // That one went between the listing and the switch; try the next.
            if (isRetryable(e)) continue;
            throw e;
          }
        }
        return RETRY;
      },
    );
  }
}
