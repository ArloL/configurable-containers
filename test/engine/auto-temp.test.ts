import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createAutoTemp } from "../../src/engine/auto-temp";

function setup() {
  const browser = aFakeBrowser();
  return { browser };
}

// Let async init (startup sweep) settle and return control to caller.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("auto-temp — startup sweep", () => {
  it("containerizes a pre-existing about:newtab at startup", async () => {
    const { browser } = setup();
    browser.existingTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    createAutoTemp({ port: browser.port });
    await flush();

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.openedTabs[0]!.url).toBeUndefined(); // Firefox rejects an explicit about:newtab
    expect(browser.closedTabIds).toHaveLength(1);
  });

  it("does not containerize a pre-existing http tab", async () => {
    const { browser } = setup();
    browser.existingTab({ url: "https://example.com/", cookieStoreId: "firefox-default" });
    createAutoTemp({ port: browser.port });
    await flush();

    expect(browser.createdContainers).toHaveLength(0);
  });

  it("does not containerize a pre-existing tab already in a container", async () => {
    const { browser } = setup();
    const throwaway = browser.addContainerNamed({ name: "tmp1" });
    browser.existingTab({ url: "about:newtab", cookieStoreId: throwaway.cookieStoreId });
    createAutoTemp({ port: browser.port });
    await flush();

    expect(browser.createdContainers).toHaveLength(0);
  });
});

describe("auto-temp — onCreated path", () => {
  it("reopens about:newtab into a fresh temporary container", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default", index: 2, active: true });

    expect(browser.createdContainers).toHaveLength(1);
    const ciName = browser.createdContainers[0]!.name;
    expect(ciName).toMatch(/^tmp/);
    expect(browser.openedTabs).toHaveLength(1);
    // No url: the replacement tab gets the browser's new-tab page (see auto-temp.ts).
    expect(browser.openedTabs[0]).toMatchObject({ index: 2, active: true });
    expect(browser.openedTabs[0]!.url).toBeUndefined();
    expect(browser.closedTabIds).toHaveLength(1);
  });

  it("reopens about:home into a fresh temporary container", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:home", cookieStoreId: "firefox-default" });

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.openedTabs[0]!.url).toBeUndefined(); // Firefox rejects an explicit about:home
    expect(browser.closedTabIds).toHaveLength(1);
  });

  it("skips tabs already in a non-default container", async () => {
    const { browser } = setup();
    const throwaway = browser.addContainerNamed({ name: "tmp1" });
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:newtab", cookieStoreId: throwaway.cookieStoreId });

    expect(browser.createdContainers).toHaveLength(0);
    expect(browser.openedTabs).toHaveLength(0);
    expect(browser.closedTabIds).toHaveLength(0);
  });

  it("skips http(s) navigations", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "https://example.com/", cookieStoreId: "firefox-default" });

    expect(browser.createdContainers).toHaveLength(0);
  });

  // about:blank is what a tab reads as until its navigation commits, so it cannot be
  // told apart from a tab on its way to a real page. See auto-temp.ts.
  it("skips about:blank tabs (indistinguishable from a tab mid-load)", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:blank", cookieStoreId: "firefox-default" });

    expect(browser.createdContainers).toHaveLength(0);
  });

  // The replacement tab is created by `supersede` and lands on the browser's new-tab page —
  // a candidate url — and the mock fires onTabCreated for it as Firefox does. What stops it
  // going round again is `isAutoTempCandidate`'s cookieStoreId check: the replacement is in
  // the tmp container just minted, not in firefox-default. Named after that check, because
  // this used to be attributed to a `creating` flag that had nothing to do with it.
  it("does not containerize the replacement tab, which is already in the new container", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.closedTabIds).toHaveLength(1);
  });

  // Two Ctrl+T in the same turn. The second tab's onCreated is delivered while the first
  // containerize is still parked on `createIdentity`, which is the window a module-level
  // "one containerize at a time" flag closed by dropping the second tab entirely — neither
  // containerized nor recorded in `processed`, so nothing would retry it. The invariant here
  // is per tab, and `processed` is what carries it.
  //
  // Deliberately not awaited in between: `opensTab` settles the turn, and that turn is the
  // whole subject of this case.
  it("containerizes a second new tab that arrives while the first is minting its container", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    const first = browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    const second = browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    await first;
    await second;

    expect(browser.createdContainers).toHaveLength(2);
    expect(browser.createdContainers[0]!.name).not.toBe(browser.createdContainers[1]!.name);
    expect(browser.closedTabIds).toHaveLength(2);
  });

  it("preserves openerTabId across the reopen", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default", openerTabId: 99 });

    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.openedTabs[0]!.openerTabId).toBe(99);
  });

  it("containerizes a new tab in the window it was opened in", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default", windowId: 7 });

    // Ctrl+T in a second window must not move that tab to the first.
    expect(browser.openedTabs[0]!.windowId).toBe(7);
  });

  it("uses a shared suffix when provided", async () => {
    const { browser } = setup();
    const suffixes: string[] = [];
    const suffix = () => { const s = `s${suffixes.length + 1}`; suffixes.push(s); return s; };
    createAutoTemp({ port: browser.port, tmpSuffix: suffix });

    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers[0]!.name).toBe("tmps1");

    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers[1]!.name).toBe("tmps2");
  });

  // A containerize that throws mid-way — here `createTab`, after the identity was minted —
  // is caught, and the next candidate is containerized as if nothing had happened. The
  // orphan tmp container it leaves behind is the known cost; the disposer reclaims it.
  //
  // This case used to open two tabs with nothing failing and call that "handles
  // createIdentity failure gracefully and resets creating flag", which is neither.
  it("a failed containerize does not stop the next tab being containerized", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    browser.tabCreationFails(true);
    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers).toHaveLength(1); // minted, then orphaned
    expect(browser.closedTabIds).toHaveLength(0); // the source tab was never superseded

    browser.tabCreationFails(false);
    await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers).toHaveLength(2);
    expect(browser.closedTabIds).toHaveLength(1);
  });
});

describe("auto-temp — onTabUpdated fallback path", () => {
  it("containerizes when onUpdated fires about:newtab after onCreated with about:blank", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    const tab = await browser.opensTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers).toHaveLength(0);

    await browser.updatesTab(
      { ...tab, url: "about:newtab" },
      { status: "loading" },
    );

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.openedTabs[0]!.url).toBeUndefined(); // Firefox rejects an explicit about:newtab
    expect(browser.closedTabIds).toHaveLength(1);
  });

  it("deduplicates: processed set prevents double-containerization from both events", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    const tab = await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers).toHaveLength(1);

    await browser.updatesTab(
      { ...tab, url: "about:newtab" },
      { status: "loading" },
    );

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("skips a tab already processed, whatever url it reports next", async () => {
    const { browser } = setup();
    createAutoTemp({ port: browser.port });

    const tab = await browser.opensTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers).toHaveLength(1);

    await browser.updatesTab(
      { ...tab, url: "about:home" },
      { status: "loading" },
    );
    expect(browser.createdContainers).toHaveLength(1);
  });
});
