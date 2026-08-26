import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Page } from "../../harness/browser/index";
import {
  launch, navigateTab, openRealNewTab, awaitTab, awaitTabs,
  navigateToContainerTab, type ProbeTab, type Session,
} from "../../harness/firefox";

// These tests must NOT reach auto-temp through an http navigation. Any unmatched
// http URL lands in a temp container via the *engine's* disposable path, so a test
// that opens a tab and then navigates passes whether or not auto-temp exists. The
// signal that isolates auto-temp is: a brand-new tab sits in a tmp container while
// still on about:newtab, before any navigation at all.
describe("auto-temp (real Firefox, CC + probe)", () => {
  let firefox: Session;
  let serverPort: string;
  // The page every probe command is asked through. A reply is written into the relaying
  // document, so it must be a page nothing here navigates.
  let relay: Page;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"] });
    serverPort = new URL(firefox.serverUrl).port;
  });

  afterAll(async () => {
    await firefox?.close();
  });

  // Park the driver on a probe-reported page — probeCommand's DOM relay only exists
  // on injected http(s) pages. A matched host is used so CC leaves the tab in its
  // permanent container, and a cache-buster forces a fresh probe report.
  // From a FRESH tab, which is what navigateToContainerTab is: `driver.get` drove whichever
  // tab the driver had been left on, and after a case whose tab the extension discarded that
  // is no window at all — a NoSuchWindow swallowed by the catch, no navigation, and a
  // 15-second timeout naming the container tab that was therefore never going to appear.
  async function parkOnProbePage(tag: string) {
    const url = `http://work.example:${serverPort}/?cb=${tag}-${Date.now()}`;
    relay = (await navigateToContainerTab(firefox.browser, url)).page;
  }

  // Wait until the new-tab page tab reports a container, so we don't race the
  // create/remove pair auto-temp performs.
  function awaitNewTabPageTab(timeoutMs = 10_000): Promise<ProbeTab> {
    return awaitTab(
      relay,
      (tab) => tab.url === "about:newtab" && tab.cookieStoreId !== "firefox-default",
      timeoutMs,
    );
  }

  it("containerizes a real new tab into a temporary container, before any navigation", async () => {
    await parkOnProbePage("one");

    const created = await openRealNewTab(relay);
    // `tabs.create({})` answers with a snapshot taken before the new-tab page's url
    // commits. Firefox 154 has already put "about:newtab" in it; 140 ESR still says
    // "about:blank". That lag is not incidental to this case — it is why auto-temp
    // listens on onTabUpdated as well as onCreated (bug 1586612), so on ESR this is the
    // only case that exercises the second path at all.
    //
    // What matters here is that Firefox opened it in the DEFAULT container. That it is a
    // real new-tab page rather than an about:blank tab — which auto-temp ignores by
    // design — is pinned by awaitNewTabPageTab below, which accepts nothing else.
    expect(created.url).toMatch(/^about:(newtab|blank)$/);
    expect(created.cookieStoreId).toBe("firefox-default"); // …and auto-temp moves it out.

    const tab = await awaitNewTabPageTab();
    expect(tab.cookieStoreId).toMatch(/^firefox-container-\d+$/);
    expect(tab.container).toMatch(/^tmp/);

    // The original default-container tab is gone, not merely duplicated. Waited for, not
    // read once: containerizing is a create/remove pair, and the remove lands when it lands.
    await awaitTabs(relay, (tabs) => tabs.every((tab) => tab.id !== created.id));
  });

  it("gives each new tab its own temporary container", async () => {
    await parkOnProbePage("two");
    const first = await awaitNewTabPageTab();

    await openRealNewTab(relay);
    const second = await awaitTab(
      relay,
      (t) => t.url === "about:newtab" && t.container.startsWith("tmp") && t.id !== first.id,
      10_000,
    );
    expect(second.container).toMatch(/^tmp/);
    expect(second.cookieStoreId).not.toBe(first.cookieStoreId);
  });

  // The manual-testing flow: get a tmp tab, type a URL, expect to still be in it.
  it("keeps the tab in its own temporary container on the first navigation", async () => {
    await parkOnProbePage("typed");
    const before = await awaitNewTabPageTab();

    const url = `http://nomatch.example:${serverPort}/?typed=${Date.now()}`;
    await navigateTab(relay, before.id, url);

    const landed = await awaitTab(relay, (tab) => tab.url === url, 10_000);
    // Not merely "some tmp" — reopening into a fresh tmp2 was the bug.
    expect(landed.container).toBe(before.container);
  });

  it("routes a matched host opened from an auto-temp tab to its permanent container", async () => {
    await parkOnProbePage("three");
    await awaitNewTabPageTab(); // an auto-temp tab exists

    const url = `http://work.example:${serverPort}/?from=autotemp-${Date.now()}`;
    const { name: containerName } = await navigateToContainerTab(firefox.browser, url);
    expect(containerName).toBe("Work");
  });
});

// The startup sweep: tabs that already existed when the extension loaded. Needs its
// own session because it depends on the very first page Firefox opens.
describe("auto-temp startup sweep (real Firefox)", () => {
  let firefox: Session;

  beforeAll(async () => {
    firefox = await launch({ extensions: ["probe", "cc"], startupUrl: "about:newtab" });
  });

  afterAll(async () => {
    await firefox?.close();
  });

  it("containerizes the new-tab page Firefox opened before the extension loaded", async () => {
    // Observe from a tab of our own: navigating an existing handle would consume the
    // very tab the sweep containerized. newWindow makes an about:blank tab, which
    // auto-temp ignores by design, so this adds no tmp container of its own.
    // The sweep discarded the tab the driver started on. Nothing has to be re-anchored
    // for it: newPage() opens a window of its own, and every page acts through its own
    // handle rather than through whichever one the driver was left on.
    const url = `http://work.example:${new URL(firefox.serverUrl).port}/?cb=sweep-${Date.now()}`;
    const observer = await navigateToContainerTab(firefox.browser, url);

    await awaitTab(
      observer.page,
      (tab) => tab.url === "about:newtab" && tab.container.startsWith("tmp"),
      10_000,
    );
    await awaitTabs(
      observer.page,
      (tabs) => !tabs.some((tab) => tab.url === "about:newtab" && tab.cookieStoreId === "firefox-default"),
    );
  });
});
