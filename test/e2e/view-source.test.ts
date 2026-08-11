import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch,
  awaitContainerTab,
  listTabs,
  listContainers,
  openViewSource,
  type Session,
} from "../../harness/firefox";

// "View Page Source" is a navigation CC must not route, and the only way to know that
// is to watch a real one: `view-source:http://site/` fetches the document it prints, so
// webRequest is handed a plain main_frame GET for `http://site/` in a tab still
// pre-commit on about:blank. Backing the engine's view-source guard out fails here as
// the source tab being REPLACED by the rendered page in a second throwaway — the
// user-visible bug, not an internal detail.
describe("view-source (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  }, 120_000);

  afterAll(async () => {
    await firefox?.close();
  });

  it("shows the source of an unmatched page instead of reopening it in a throwaway", async () => {
    const pageUrl = `http://nomatch.example:${serverPort}/`;

    // Park on the page, in the throwaway CC routes it into. This tab is the command
    // relay and nothing below navigates it — the source opens in a tab of its own,
    // exactly as Ctrl+U does.
    await firefox.driver.switchTo().newWindow("tab");
    try {
      await firefox.driver.get(pageUrl);
    } catch {
      // CC reopened the tab away — expected.
    }
    const page = await awaitContainerTab(firefox.driver, pageUrl);
    expect(page.name).toMatch(/^tmp/);
    const throwawaysBefore = (await listContainers(firefox.driver)).filter((c) => c.startsWith("tmp"));

    const sourceTab = await openViewSource(firefox.driver, pageUrl, page.store);

    // The source tab is on `view-source:` for its whole life, so there is no reopen to
    // wait for and nothing lands in its DOM: poll browser.tabs instead, and give CC the
    // time it would need to have got this wrong.
    const deadline = Date.now() + 15_000;
    let tabs = await listTabs(firefox.driver);
    while (Date.now() < deadline && !tabs.some((t) => t.id === sourceTab.id && t.url.startsWith("view-source:"))) {
      await firefox.driver.sleep(300);
      tabs = await listTabs(firefox.driver);
    }

    const stillShowingSource = tabs.find((t) => t.id === sourceTab.id);
    expect(stillShowingSource, "the tab opened for the source must survive").toBeDefined();
    expect(stillShowingSource!.url).toBe(`view-source:${pageUrl}`);
    // And it stays where "View Page Source" put it: the container of the page it came
    // from, which CC had already routed.
    expect(stillShowingSource!.container).toBe(page.name);

    // Nothing was reopened: no rendered copy of the page, and no throwaway bought for it.
    expect(tabs.filter((t) => t.url === pageUrl)).toHaveLength(1);
    expect((await listContainers(firefox.driver)).filter((c) => c.startsWith("tmp"))).toEqual(throwawaysBefore);
  }, 60_000);
});
