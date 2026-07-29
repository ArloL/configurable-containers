import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, readContainerList, listContainers, type Session } from "../../harness/firefox";
import type { WebDriver } from "selenium-webdriver";

// Read the probe's container list once it has (re)reported into the fresh document.
async function freshList(driver: WebDriver): Promise<string[]> {
  for (let i = 0; i < 30; i++) {
    const list = await readContainerList(driver);
    if (list.length) return list; // built-in containers are always present once reported
    await driver.sleep(100);
  }
  return [];
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
    const d = firefox.driver;

    // Route an unmatched host into a fresh tmp container.
    await d.switchTo().newWindow("tab");
    try {
      await d.get(`http://nomatch.example:${serverPort}/`);
    } catch {
      /* CC reopened the tab away */
    }
    const { name: containerName } = await awaitContainerTab(d, `http://nomatch.example:${serverPort}/`);
    expect(containerName).toMatch(/^tmp/);

    // Close the tmp tab (currently switched to it), then re-attach to a survivor —
    // closing the active tab leaves the driver with no current window.
    await d.close();
    await d.switchTo().window((await d.getAllWindowHandles())[0]);

    // Establish a STABLE observation tab in the permanent "Work" container: a matched
    // host stays put on reload (no reopen, tab not torn down), so we can reload it to
    // get a fresh probe report each poll instead of accumulating stale tabs.
    await d.switchTo().newWindow("tab");
    try {
      await d.get(`http://work.example:${serverPort}/`);
    } catch {
      /* CC reopened the tab away */
    }
    await awaitContainerTab(d, `http://work.example:${serverPort}/`); // now on the Work tab

    // Poll: navigate the Work tab to a fresh (cache-busted) URL each time — same host,
    // so it stays in Work, but a new document forces the probe to re-report the live
    // container list — until the tmp name is gone.
    const deadline = Date.now() + 15_000;
    let gone = false;
    while (Date.now() < deadline) {
      await d.get(`http://work.example:${serverPort}/?t=${Date.now()}`); // stays in Work; fresh document
      if (!(await freshList(d)).includes(containerName)) {
        gone = true;
        break;
      }
      await d.sleep(300);
    }
    expect(gone).toBe(true);
  });

  // The case above polls by NAVIGATING, and a navigation that reopens a tab closes the
  // old one — which fires another onTabRemoved and hands the disposer a second chance to
  // notice the throwaway went empty. That masked a real bug: the disposer's own
  // tab-close sweep is the only thing standing between a throwaway and the 10-minute GC,
  // and a case that keeps browsing never finds out whether it works. This is the nightly
  // real-delay case's shape at a 500ms grace: close the tab, then observe WITHOUT
  // touching anything.
  it("removes it with no further browsing to prompt the sweep", async () => {
    const d = firefox.driver;

    // A stable observation tab in a permanent container: matched, so nothing reopens or
    // tears it down, and the probe's command relay lives in its document.
    await d.switchTo().newWindow("tab");
    try {
      await d.get(`http://work.example:${serverPort}/?cb=quiet-${Date.now()}`);
    } catch {
      /* CC reopened the tab away */
    }
    await awaitContainerTab(d, `http://work.example:${serverPort}/?cb=quiet-`.split("?")[0]);
    const observer = await d.getWindowHandle();

    await d.switchTo().newWindow("tab");
    const target = `http://nomatch.example:${serverPort}/?cb=quiet-${Date.now()}`;
    try {
      await d.get(target);
    } catch {
      /* CC reopened the tab away */
    }
    const { name: throwaway } = await awaitContainerTab(d, target);
    expect(throwaway).toMatch(/^tmp/);

    // Closing the active tab leaves the driver with no window — re-attach to the observer.
    await d.close();
    await d.switchTo().window(observer);

    // listContainers is a probe command against the existing document: no navigation, no
    // new tab, nothing that could hurry the disposer along.
    const deadline = Date.now() + 15_000;
    let gone = false;
    while (Date.now() < deadline) {
      if (!(await listContainers(d)).includes(throwaway)) {
        gone = true;
        break;
      }
      await d.sleep(300);
    }
    expect(gone).toBe(true);
  });
});
