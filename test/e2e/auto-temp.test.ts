import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launch, listTabs, openRealNewTab, awaitContainerTab, type ProbeTab, type Session,
} from "../../harness/firefox";

// These tests must NOT reach auto-temp through an http navigation. Any unmatched
// http URL lands in a temp container via the *engine's* disposable path, so a test
// that opens a tab and then navigates passes whether or not auto-temp exists. The
// signal that isolates auto-temp is: a brand-new tab sits in a tmp container while
// still on about:newtab, before any navigation at all.
describe("auto-temp (real Firefox, CC + probe)", () => {
  let session: Session;
  let port: string;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"] });
    port = new URL(session.serverUrl).port;
  });

  afterAll(async () => {
    await session?.close();
  });

  // Park the driver on a probe-reported page — probeCommand's DOM relay only exists
  // on injected http(s) pages. A matched host is used so CC leaves the tab in its
  // permanent container, and a cache-buster forces a fresh probe report.
  async function parkOnProbePage(tag: string) {
    const url = `http://work.example:${port}/?cb=${tag}-${Date.now()}`;
    try {
      await session.driver.get(url);
    } catch {
      // First visit reopens the tab into Work, tearing this one down — expected.
    }
    await awaitContainerTab(session.driver, url);
  }

  // Poll until the new-tab page tab reports a container, so we don't race the
  // create/remove pair auto-temp performs.
  async function awaitNewTabPageTab(timeoutMs = 10_000): Promise<ProbeTab> {
    const deadline = Date.now() + timeoutMs;
    let last: ProbeTab[] = [];
    while (Date.now() < deadline) {
      last = await listTabs(session.driver);
      const hit = last.find((t) => t.url === "about:newtab" && t.cookieStoreId !== "firefox-default");
      if (hit) return hit;
      await session.driver.sleep(300);
    }
    throw new Error(`no containerized about:newtab tab; saw ${JSON.stringify(last)}`);
  }

  it("containerizes a real new tab into a temporary container, before any navigation", async () => {
    await parkOnProbePage("one");

    const created = await openRealNewTab(session.driver);
    expect(created.url).toBe("about:newtab");
    expect(created.cookieStoreId).toBe("firefox-default"); // Firefox opens it in default…

    const tab = await awaitNewTabPageTab(); // …and auto-temp moves it out.
    expect(tab.cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(tab.container).toMatch(/^tmp/);

    // The original default-container tab is gone, not merely duplicated.
    const tabs = await listTabs(session.driver);
    expect(tabs.find((t) => t.id === created.id)).toBeUndefined();
  });

  it("gives each new tab its own temporary container", async () => {
    await parkOnProbePage("two");
    const first = await awaitNewTabPageTab();

    await openRealNewTab(session.driver);
    const deadline = Date.now() + 10_000;
    let second: ProbeTab | undefined;
    while (Date.now() < deadline && !second) {
      second = (await listTabs(session.driver)).find(
        (t) => t.url === "about:newtab" && t.container.startsWith("tmp") && t.id !== first.id,
      );
      if (!second) await session.driver.sleep(300);
    }

    expect(second).toBeDefined();
    expect(second!.container).toMatch(/^tmp/);
    expect(second!.cookieStoreId).not.toBe(first.cookieStoreId);
  });

  it("routes a matched host opened from an auto-temp tab to its permanent container", async () => {
    await parkOnProbePage("three");
    await awaitNewTabPageTab(); // an auto-temp tab exists

    const url = `http://work.example:${port}/?from=autotemp-${Date.now()}`;
    try {
      await session.driver.get(url);
    } catch {
      // CC may reopen the tab away — expected.
    }
    const { name } = await awaitContainerTab(session.driver, url);
    expect(name).toBe("Work");
  });
});

// The startup sweep: tabs that already existed when the extension loaded. Needs its
// own session because it depends on the very first page Firefox opens.
describe("auto-temp startup sweep (real Firefox)", () => {
  let session: Session;

  beforeAll(async () => {
    session = await launch({ extensions: ["probe", "cc"], startupUrl: "about:newtab" });
  });

  afterAll(async () => {
    await session?.close();
  });

  it("containerizes the new-tab page Firefox opened before the extension loaded", async () => {
    // Observe from a tab of our own: navigating an existing handle would consume the
    // very tab the sweep containerized. newWindow makes an about:blank tab, which
    // auto-temp ignores by design, so this adds no tmp container of its own.
    const url = `http://work.example:${new URL(session.serverUrl).port}/?cb=sweep-${Date.now()}`;
    // The sweep discarded the tab the driver started on, leaving it with no context —
    // re-anchor on a surviving handle before opening anything.
    const handles = await session.driver.getAllWindowHandles();
    await session.driver.switchTo().window(handles[handles.length - 1]);
    await session.driver.switchTo().newWindow("tab");
    try {
      await session.driver.get(url);
    } catch {
      // CC reopens it into Work, tearing this tab down — expected.
    }
    await awaitContainerTab(session.driver, url);

    const deadline = Date.now() + 10_000;
    let swept: ProbeTab | undefined;
    let last: ProbeTab[] = [];
    while (Date.now() < deadline && !swept) {
      last = await listTabs(session.driver);
      swept = last.find((t) => t.url === "about:newtab" && t.container.startsWith("tmp"));
      if (!swept) await session.driver.sleep(300);
    }
    expect(swept, `saw ${JSON.stringify(last)}`).toBeDefined();
    expect(last.some((t) => t.url === "about:newtab" && t.cookieStoreId === "firefox-default")).toBe(false);
  });
});
