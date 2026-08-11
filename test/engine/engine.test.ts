import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createEngine, type PauseRecorder } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Decision, Deps, Target } from "../../src/resolver/types";
import type { Tab, WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };

function sequentialTmpSuffixes(): () => string {
  let n = 0;
  return () => String(++n);
}

function aNavigationTo(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "GET", ...over };
}

// A config with one rule: example.com opens the permanent "Work" container.
function workConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work"] } }], groups: [] };
}

const ignoreChoices = () => {};

// Every case that is not about pausing passes this. `pause` is a REQUIRED option rather
// than an optional one precisely so it shows up here: an optional field is one a mock
// forgets to set, and the coverage quietly stops.
const noPause: PauseRecorder = { isPaused: () => false, record: () => {} };

// An armed container, plus a log of what the engine handed the recorder.
function armedFor(cookieStoreId: string) {
  const recorded: { csid: string; url: string; decision: Decision }[] = [];
  return {
    isPaused: (id: string) => id === cookieStoreId,
    record: (csid: string, url: string, decision: Decision) => void recorded.push({ csid, url, decision }),
    recorded,
  };
}

describe("engine — reopen/stay/leaveAlone + F1 guard", () => {
  it("opens the container tab beside a source tab that is ON a page, and keeps that tab", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1);
    const created = browser.openedTabs[0];
    const work = (await browser.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(created.cookieStoreId).toBe(work.cookieStoreId);
    // index+1 = right after the source, whose id becomes the new tab's opener.
    expect(created).toMatchObject({ url: "https://example.com/", index: 4, active: true, openerTabId: sourceTab.id });
    // Reading start.test survives the click: history does not span containers, so
    // replacing this tab would lose the page with no way back.
    expect(browser.closedTabIds).toEqual([]);
    expect(browser.openTabs.get(sourceTab.id)?.url).toBe("https://start.test/");
  });

  it("replaces a source tab with nothing to lose, preserving its placement", async () => {
    const browser = aFakeBrowser();
    // about:blank = a tab still pre-commit, which is what a middle-clicked or
    // target=_blank link is. Keeping it would strand an empty tab beside every one.
    const sourceTab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs[0]).toMatchObject({ url: "https://example.com/", index: 3, active: true, openerTabId: 7 });
    expect(browser.closedTabIds).toEqual([sourceTab.id]);
  });

  it("opens the container tab in the window the source tab is in, not the focused one", async () => {
    const browser = aFakeBrowser();
    const inAnotherWindow = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default", windowId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: inAnotherWindow.id }));

    // Omitting the window sends the tab to the last focused NORMAL window instead.
    expect(browser.openedTabs[0].windowId).toBe(7);
  });

  it("keeps a window.open popup alive: its replacement opens in the popup's own window", async () => {
    const browser = aFakeBrowser();
    // A share-button popup — window.open(url, "…", "width=640,height=480"). Its tab is
    // pre-commit, so it takes the replace branch; without a window the replacement
    // landed in the last focused normal window and removing the original closed the
    // popup, taking the navigation with it.
    const popup = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default", windowId: 42, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: popup.id }));

    expect(browser.openedTabs[0].windowId).toBe(42);
    expect(browser.closedTabIds).toEqual([popup.id]);
  });

  it("replaces an auto-temp tab sitting on about:newtab", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const sourceTab = browser.existingTab({ url: "about:newtab", cookieStoreId: tmp1.cookieStoreId });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));

    expect(browser.closedTabIds).toEqual([sourceTab.id]);
  });

  it("F1: a re-fire of the same request+url does not open a second tab", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));
    const again = await browser.navigates(aNavigationTo({ tabId: sourceTab.id })); // same requestId + url

    expect(again).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1); // still just one
  });

  it("F1 termination: the reopened tab (now in target) yields stay, no further effects", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== sourceTab.id)!;
    const blockingResponse = await browser.navigates(aNavigationTo({ requestId: "2", tabId: newTab.id }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(1); // no second reopen
  });

  it("F1: the freshly reopened tab does not re-reopen when its first request fires before the url commits", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: sourceTab.id }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== sourceTab.id)!;
    // Real Firefox fires the reopened tab's onBeforeRequest BEFORE its url commits,
    // so the tab still reads as about:blank even though it is already in Work.
    newTab.url = "about:blank";
    await browser.navigates(aNavigationTo({ requestId: "2", tabId: newTab.id }));

    expect(browser.openedTabs).toHaveLength(1); // no second reopen — loop broken
  });

  it("a redirect hop in a reopened throwaway tab stays put — one throwaway per navigation", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const tab = browser.existingTab({ url: "https://kottke.org/", cookieStoreId: tmp1.cookieStoreId });
    const suffix = sequentialTmpSuffixes();
    suffix(); // tmp1 above was issued by this counter
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    // Click a link to another site: reopened into a fresh throwaway, tmp2.
    await browser.navigates(aNavigationTo({ requestId: "10", tabId: tab.id, url: "https://linked.test/a" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank"; // pre-commit for the whole redirect chain, as in real Firefox

    // Its own request (reopenedNav absorbs this one) and then a 301 hop, which
    // arrives on the same requestId with a different url and no guard left.
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://linked.test/a" }));
    const hop = await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://www.linked.test/a" }));

    expect(hop).toBeUndefined(); // the hop lands where the navigation already is
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("routes a later navigation in a reopened tab whose own request never arrived", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: sourceTab.id, url: "https://example.com/" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== sourceTab.id)!;
    // The reopened tab's own request never arrives — load aborted, or the user typed
    // somewhere else first — so it never committed and still reads about:blank.
    newTab.url = "about:blank";

    // That later navigation is a real one, to a site no rule matches: it must get its
    // own throwaway, not ride along in Work on the strength of a stale guard.
    const blockingResponse = await browser.navigates(aNavigationTo({ requestId: "9", tabId: newTab.id, url: "https://other.test/" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["Work", "tmp1"]);
    expect(browser.openedTabs).toHaveLength(2);
  });

  it("still absorbs the reopened tab's first request when HSTS rewrote its url", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const tab = browser.existingTab({ url: "https://kottke.org/", cookieStoreId: tmp1.cookieStoreId });
    const suffix = sequentialTmpSuffixes();
    suffix(); // tmp1 above was issued by this counter
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    // Reopened to the http url the click carried...
    await browser.navigates(aNavigationTo({ requestId: "30", tabId: tab.id, url: "http://linked.test/a" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank";

    // ...but HSTS upgrades the scheme BEFORE onBeforeRequest, so the tab's own first
    // request arrives on a url we never asked for. It is still the navigation we
    // reopened the tab to perform; treating it as a new one buys a second throwaway.
    const own = await browser.navigates(aNavigationTo({ requestId: "31", tabId: newTab.id, url: "https://linked.test/a" }));

    expect(own).toBeUndefined();
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("a link opened in a NEW tab from a throwaway gets its own throwaway", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const opener = browser.existingTab({ url: "https://kottke.org/", cookieStoreId: tmp1.cookieStoreId });
    const suffix = sequentialTmpSuffixes();
    suffix(); // tmp1 above was issued by this counter
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    // Middle-click / ctrl-click / target=_blank: Firefox opens a tab that INHERITS the
    // opener's container and reads about:blank until the click's navigation commits.
    const opened = browser.existingTab({ url: "about:blank", cookieStoreId: tmp1.cookieStoreId, openerTabId: opener.id });
    const blockingResponse = await browser.navigates(aNavigationTo({ requestId: "20", tabId: opened.id, url: "https://dannykatch.substack.com/p/x" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]); // NOT left in tmp1
  });

  it("F2: a tab already in the target container stays (no effects)", async () => {
    const browser = aFakeBrowser();
    const work = browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://example.com/old", cookieStoreId: work.cookieStoreId });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(0);
    expect(browser.closedTabIds).toHaveLength(0);
  });

  it("no matching rule reopens into a fresh tmp-prefixed container", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id, url: "https://unmatched.test/" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.createdContainers[0].name).toMatch(/^tmp/);
  });

  it("skips non-http(s) navigations", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id, url: "about:preferences" }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(0);
  });

  it("skips sub_frame requests", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id, type: "sub_frame" }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(0);
  });

  it("fails open when the tab has raced away (getTab null)", async () => {
    const browser = aFakeBrowser();
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: 999 }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(0);
  });

  it("fails open (no cancel) when createTab throws, and clears the guard for retry", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    browser.tabCreationFails(true);
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));
    expect(blockingResponse).toBeUndefined(); // NOT { cancel: true }

    browser.tabCreationFails(false);
    const retry = await browser.navigates(aNavigationTo({ tabId: tab.id })); // same key retried
    expect(retry).toEqual({ cancel: true }); // guard was cleared, retry works
  });
});

// Config: example.com opens Work OR Personal with no default -> choice.
function choiceConfig(): Config {
  return {
    rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work", "Personal"] } }],
    groups: [],
  };
}

describe("engine — F7 MAC defer + choice", () => {
  it("F7: defers (no reopen) when MAC owns the URL", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    browser.macAssigns("https://example.com/", { userContextId: 5 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(0);
  });

  it("F7: reopens normally when MAC is absent (sendExternalMessage throws)", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    browser.macIsAbsent(true);
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("choice: emits onChoice with the options and cancels, opening no tab", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const seen: Array<{ options: string[]; nav: { tabId: number; url: string } }> = [];
    createEngine({
      port: browser.port,
      config: choiceConfig(),
      deps,
      onChoice: (options, nav) => seen.push({ options, nav }),
      pause: noPause,
      tmpSuffix: sequentialTmpSuffixes(),
    });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(0);
    expect(seen).toEqual([{ options: ["Work", "Personal"], nav: { tabId: tab.id, url: "https://example.com/" } }]);
  });

  it("choice: defers to MAC (no emit) when MAC owns the URL", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    browser.macAssigns("https://example.com/", { userContextId: 5 });
    let called = false;
    createEngine({ port: browser.port, config: choiceConfig(), deps, onChoice: () => (called = true), pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("engine.reopen — extracted F1-guarded effect", () => {
  it("reopens a tab into the target container, preserving placement, and guards the reopened tab's first nav", async () => {
    const browser = aFakeBrowser();
    // The picker reaches here with the tab sitting on the choice page (a moz-extension
    // url), which is a tab with nothing to lose — so this is the replacing path.
    const sourceTab = browser.existingTab({ url: "moz-extension://test/choice.html#x", cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    const engine = createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await engine.reopen(sourceTab, "https://example.com/", { kind: "permanent", name: "Work" });

    expect(browser.openedTabs).toHaveLength(1);
    const created = browser.openedTabs[0];
    const work = (await browser.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(created).toMatchObject({ url: "https://example.com/", cookieStoreId: work.cookieStoreId, index: 3, active: true, openerTabId: 7 });
    expect(browser.closedTabIds).toEqual([sourceTab.id]);

    // F1 guard: the reopened tab's first onBeforeRequest is a no-op (it fires before url commits).
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== sourceTab.id)!;
    newTab.url = "about:blank";
    const blockingResponse = await browser.navigates(aNavigationTo({ requestId: "2", tabId: newTab.id }));
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(1); // no second reopen
  });

  it("reopen into Temporary creates a tmp-prefixed container", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const engine = createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await engine.reopen(sourceTab, "https://example.com/", { kind: "temporary" });

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.createdContainers[0].name).toMatch(/^tmp/);
    expect(browser.closedTabIds).toEqual([]); // start.test is a real page — kept
  });

  it("reopen throws when createTab fails (does not swallow); old tab not removed", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    browser.tabCreationFails(true);
    const engine = createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await expect(engine.reopen(sourceTab, "https://example.com/", { kind: "permanent", name: "Work" })).rejects.toThrow();
    expect(browser.closedTabIds).toEqual([]); // old tab not removed on failure
  });
});

describe("engine — a paused container", () => {
  it("does not reopen, does not cancel, and records what it would have done", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-1" });
    const pause = armedFor("firefox-container-1");
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    // No cancel: the navigation proceeds where it already is, which is the point.
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
    expect(pause.recorded).toEqual([
      {
        csid: "firefox-container-1",
        url: "https://example.com/",
        decision: { kind: "reopen", into: { kind: "permanent", name: "Work" } },
      },
    ]);
  });

  it("still routes an UNARMED container — the anchor for the case above", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-2" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: armedFor("firefox-container-1"), tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("raises no declination notification for a POST — staying put is what was asked for", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-1" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: armedFor("firefox-container-1"), tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: tab.id, method: "POST" }));
    await browser.settle();

    // F9's toast announces a routing rule that went UNAPPLIED. Under a pause nothing
    // went unapplied — the user turned routing off. This pins the step ahead of F9's.
    expect(browser.notifications).toEqual([]);
  });

  it("shows no choice screen in a paused container, and records that one was due", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-container-1" });
    const offered: string[][] = [];
    const pause = armedFor("firefox-container-1");
    const config: Config = {
      rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Personal", "Work"] } }],
      groups: [],
    };
    createEngine({ port: browser.port, config, deps, onChoice: (o) => void offered.push(o), pause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));

    expect(offered).toEqual([]);
    expect(blockingResponse).toBeUndefined();
    expect(pause.recorded[0].decision).toEqual({ kind: "choice", options: ["Personal", "Work"] });
  });
});

// Ctrl+U. Firefox loads `view-source:https://example.com/` into a tab of its own and
// fetches the document to print, so webRequest is handed an ordinary main_frame GET for
// the INNER url with the tab still pre-commit on about:blank — nothing there says the
// user asked for source rather than for the page. Routing it cancels the fetch and
// reopens the plain url elsewhere, which loses the `view-source:` wrapper and (the tab
// having nothing to lose yet) takes the source tab down with it.
//
// webNavigation.onBeforeNavigate is the one event that names the wrapped url, and
// Firefox fires it before the request that navigation issues.
describe("engine — a view-source load", () => {
  const viewSourceOf = (url: string) => `view-source:${url}`;

  it("is left alone: the fetch behind Ctrl+U is not a navigation to route", async () => {
    const browser = aFakeBrowser();
    // A brand new tab, pre-commit — indistinguishable, from the request alone, from a
    // middle-clicked link, which is exactly why the mark has to come from elsewhere.
    const sourceTab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    browser.startsNavigating({ tabId: sourceTab.id, url: viewSourceOf("https://example.com/") });
    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));

    expect(blockingResponse).toBeUndefined(); // no cancel — the source is allowed to load
    expect(browser.openedTabs).toEqual([]);
    expect(browser.closedTabIds).toEqual([]); // and the tab showing it survives
  });

  it("stays left alone across a redirect of the very load being viewed", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    // One navigation, one onBeforeNavigate, several requests: a redirect chain reuses
    // the requestId and announces no second navigation, so the mark must outlive hop 1.
    browser.startsNavigating({ tabId: sourceTab.id, url: viewSourceOf("https://example.com/hop") });
    await browser.navigates(aNavigationTo({ tabId: sourceTab.id, url: "https://example.com/hop" }));
    const lastHop = await browser.navigates(aNavigationTo({ tabId: sourceTab.id, url: "https://example.com/" }));

    expect(lastHop).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
  });

  it("does not stop the tab being routed once it navigates somewhere for real", async () => {
    const browser = aFakeBrowser();
    // A tab that is ON a page: `view_source.tab=false` puts the source in the current
    // tab instead of a new one, and that tab is the one still to be routed afterwards.
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    browser.startsNavigating({ tabId: sourceTab.id, url: viewSourceOf("https://example.com/") });
    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));
    expect(browser.openedTabs).toEqual([]);

    // Typing a url into that same tab. Nothing expires the mark on a timer — the next
    // top-level navigation announcing itself is what clears it.
    browser.startsNavigating({ tabId: sourceTab.id, url: "https://example.com/" });
    const blockingResponse = await browser.navigates(aNavigationTo({ requestId: "2", tabId: sourceTab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1); // routed once, for the real navigation only
  });

  it("is not un-marked by a sub-frame the source page is still loading", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    browser.startsNavigating({ tabId: sourceTab.id, url: viewSourceOf("https://example.com/") });
    browser.startsNavigating({ tabId: sourceTab.id, url: "https://frame.test/", frameId: 7 });
    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
  });

  it("routes an ordinary navigation exactly as before — the anchor for the cases above", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    browser.startsNavigating({ tabId: sourceTab.id, url: "https://example.com/" });
    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1);
  });
});
