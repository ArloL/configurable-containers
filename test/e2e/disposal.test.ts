import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, awaitContainers, navigateToContainerTab, readContainerList,
  type Session,
} from "../../harness/firefox";
import type { Page } from "../../harness/browser/index";
import { RETRY, poll } from "../../harness/browser/retry";

// Read the probe's container list once it has (re)reported into the fresh document. The
// attribute IS the report, so waiting for it to exist is waiting for the report.
async function freshList(page: Page): Promise<string[]> {
  await page.locator("html[data-cc-containers]").waitFor({ state: "attached" });
  return readContainerList(page);
}

describe("temp disposal (real Firefox)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    // Short grace so the keep-alive window elapses quickly in the test.
    firefox = await launch({ extensions: ["probe", "cc"], ccGraceMs: 500 });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("removes a tmp container after its last tab closes", async () => {
    // Route an unmatched host into a fresh tmp container.
    const throwaway = await navigateToContainerTab(
      firefox.browser,
      `http://nomatch.example:${serverPort}/`,
    );
    expect(throwaway.name).toMatch(/^tmp/);

    // Close it. Nothing has to be re-attached afterwards: a page is a handle of its own,
    // so closing one does not leave the next read looking at no window.
    await throwaway.page.close();

    // A STABLE observation tab in the permanent "Work" container: a matched host stays put
    // on reload (no reopen, tab not torn down), so it can be reloaded for a fresh probe
    // report each poll instead of accumulating stale tabs.
    const observer = await navigateToContainerTab(
      firefox.browser,
      `http://work.example:${serverPort}/`,
    );

    // Poll: navigate the Work tab to a fresh (cache-busted) URL each time — same host, so
    // it stays in Work, but a new document forces the probe to re-report the live container
    // list — until the tmp name is gone. Each round trips the network, so it paces itself.
    //
    // Through `poll` rather than a hand-rolled deadline so that giving up says what it last
    // saw: the old form failed as `expected false to be true`, which names neither the
    // container it was waiting on nor the list it kept finding it in.
    let seen: string[] = [];
    await poll(
      {
        timeout: 15_000,
        interval: 0, // each attempt is a navigation and a probe report; it paces itself
        what: `${throwaway.name} to be reclaimed`,
        diagnose: async () => `  last container list: ${JSON.stringify(seen)}`,
      },
      async () => {
        await observer.page.goto(`http://work.example:${serverPort}/?t=${Date.now()}`);
        seen = await freshList(observer.page);
        return seen.includes(throwaway.name) ? RETRY : undefined;
      },
    );
  });

  // The case above polls by NAVIGATING, and a navigation that reopens a tab closes the
  // old one — which fires another onTabRemoved and hands the disposer a second chance to
  // notice the throwaway went empty. That masked a real bug: the disposer's own
  // tab-close sweep is the only thing standing between a throwaway and the 10-minute GC,
  // and a case that keeps browsing never finds out whether it works. This is the nightly
  // real-delay case's shape at a 500ms grace: close the tab, then observe WITHOUT
  // touching anything.
  it("removes it with no further browsing to prompt the sweep", async () => {
    // A stable observation tab in a permanent container: matched, so nothing reopens or
    // tears it down, and the probe's command relay lives in its document.
    const observer = await navigateToContainerTab(
      firefox.browser,
      `http://work.example:${serverPort}/?cb=quiet-${Date.now()}`,
    );

    const target = `http://nomatch.example:${serverPort}/?cb=quiet-${Date.now()}`;
    const throwaway = await navigateToContainerTab(firefox.browser, target);
    expect(throwaway.name).toMatch(/^tmp/);
    await throwaway.page.close();

    // awaitContainers asks the probe against the observer's EXISTING document: no
    // navigation, no new tab, nothing that could hurry the disposer along.
    await awaitContainers(observer.page, (names) => !names.includes(throwaway.name));
  });
});
