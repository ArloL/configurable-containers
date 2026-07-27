import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launch, awaitContainerTab, readContainerList, type Session } from "../../harness/firefox";
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
  let session: Session;
  let port: string;

  beforeAll(async () => {
    // Short grace so the keep-alive window elapses quickly in the test.
    session = await launch({ extensions: ["probe", "cc"], ccGraceMs: 500 });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  it("removes a tmp container after its last tab closes", async () => {
    const d = session.driver;

    // Route an unmatched host into a fresh tmp container.
    await d.switchTo().newWindow("tab");
    try {
      await d.get(`http://nomatch.example:${port}/`);
    } catch {
      /* CC reopened the tab away */
    }
    const { name } = await awaitContainerTab(d, `http://nomatch.example:${port}/`);
    expect(name).toMatch(/^tmp/);

    // Close the tmp tab (currently switched to it), then re-attach to a survivor —
    // closing the active tab leaves the driver with no current window.
    await d.close();
    await d.switchTo().window((await d.getAllWindowHandles())[0]);

    // Establish a STABLE observation tab in the permanent "Work" container: a matched
    // host stays put on reload (no reopen, tab not torn down), so we can reload it to
    // get a fresh probe report each poll instead of accumulating stale tabs.
    await d.switchTo().newWindow("tab");
    try {
      await d.get(`http://work.example:${port}/`);
    } catch {
      /* CC reopened the tab away */
    }
    await awaitContainerTab(d, `http://work.example:${port}/`); // now on the Work tab

    // Poll: navigate the Work tab to a fresh (cache-busted) URL each time — same host,
    // so it stays in Work, but a new document forces the probe to re-report the live
    // container list — until the tmp name is gone.
    const deadline = Date.now() + 15_000;
    let gone = false;
    while (Date.now() < deadline) {
      await d.get(`http://work.example:${port}/?t=${Date.now()}`); // stays in Work; fresh document
      if (!(await freshList(d)).includes(name)) {
        gone = true;
        break;
      }
      await d.sleep(300);
    }
    expect(gone).toBe(true);
  });
});
