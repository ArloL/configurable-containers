import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createEngine, type PauseRecorder } from "../../src/engine/engine";
import type { RecordedNav } from "../../src/engine/port";
import { createPicker } from "../../src/engine/picker";
import { parseConfig } from "../../src/config/parse";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Decision, Deps } from "../../src/resolver/types";
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

// Every case that is not about pausing passes this. `pause` is REQUIRED rather than
// optional so it shows up here: an optional field is one a mock forgets to set, and
// coverage quietly stops.
const noPause: PauseRecorder = { isPaused: () => false, record: () => {} };

// An armed container, plus a log of what the engine handed the recorder.
function armedFor(cookieStoreId: string) {
  const recorded: { csid: string; nav: RecordedNav; decision: Decision }[] = [];
  return {
    isPaused: (id: string) => id === cookieStoreId,
    record: (csid: string, nav: RecordedNav, decision: Decision) => void recorded.push({ csid, nav, decision }),
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
    const created = browser.openedTabs[0]!;
    const work = (await browser.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(created.cookieStoreId).toBe(work.cookieStoreId);
    // index+1 = right after the source, whose id becomes the new tab's opener.
    expect(created).toMatchObject({ url: "https://example.com/", index: 4, active: true, openerTabId: sourceTab.id });
    // Reading start.test survives the click: history does not span containers, so
    // replacing this tab loses the page with no way back.
    expect(browser.closedTabIds).toEqual([]);
    expect(browser.openTabs.get(sourceTab.id)?.url).toBe("https://start.test/");
  });

  it("replaces a source tab with nothing to lose, preserving its placement", async () => {
    const browser = aFakeBrowser();
    // about:blank is a pre-commit tab, which is what a middle-clicked or target=_blank
    // link is. Keeping it strands an empty tab beside every one.
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
    expect(browser.openedTabs[0]!.windowId).toBe(7);
  });

  it("keeps a window.open popup alive: its replacement opens in the popup's own window", async () => {
    const browser = aFakeBrowser();
    // A share-button popup: window.open(url, "…", "width=640,height=480"). Its tab is
    // pre-commit, so it takes the replace branch. Without a window the replacement landed
    // in the last focused normal window, and removing the original closed the popup.
    const popup = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default", windowId: 42, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: popup.id }));

    expect(browser.openedTabs[0]!.windowId).toBe(42);
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

  it("keeps a tab showing CC's own options page, so a half-written config survives", async () => {
    const browser = aFakeBrowser();
    // The editor holds text that is not in storage until Save. Replacing the tab discards
    // it with no way back, which is worse than what CC does for any stranger's website.
    const editor = browser.existingTab({ url: browser.port.getURL("options.html"), cookieStoreId: "firefox-default", index: 3, active: true, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: editor.id }));

    expect(browser.closedTabIds).toEqual([]);
    expect(browser.openedTabs[0]).toMatchObject({ url: "https://example.com/", index: 4, openerTabId: editor.id });
  });

  it("replaces the choice page, whose whole purpose is to be navigated away from", async () => {
    const browser = aFakeBrowser();
    // Picking a container IS this page leaving. Keeping it strands the picker beside the
    // tab it just opened. It carries an encoded payload, hence the fragment.
    const choice = browser.existingTab({ url: browser.port.getURL("choice.html") + "#eyJ1cmwiOiJ4In0", cookieStoreId: "firefox-default", index: 3 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: choice.id }));

    expect(browser.closedTabIds).toEqual([choice.id]);
    expect(browser.openedTabs[0]).toMatchObject({ index: 3 });
  });

  it("replaces a fresh tab that reports an empty url rather than about:blank", async () => {
    const browser = aFakeBrowser();
    // Tab.url is documented as `"" / about:blank for a fresh tab`. Both are pre-commit;
    // keeping either strands an empty tab beside every link opened in a new tab.
    const fresh = browser.existingTab({ url: "", cookieStoreId: "firefox-default", index: 3, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: fresh.id }));

    expect(browser.closedTabIds).toEqual([fresh.id]);
  });

  it("replaces about:privatebrowsing, which is the new-tab page of a private window", async () => {
    const browser = aFakeBrowser();
    const fresh = browser.existingTab({ url: "about:privatebrowsing", cookieStoreId: "firefox-default", index: 3, openerTabId: 7 });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: fresh.id }));

    expect(browser.closedTabIds).toEqual([fresh.id]);
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
    // Firefox fires the reopened tab's onBeforeRequest BEFORE its url commits, so the tab
    // still reads about:blank even though it is already in Work.
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

    // Its own request, absorbed by reopenedNav, then a 301 hop arriving on the same
    // requestId with a different url and no guard left.
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://linked.test/a" }));
    const hop = await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://www.linked.test/a" }));

    expect(hop).toBeUndefined(); // the hop lands where the navigation already is
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("a redirect hop to an unmatched OTHER site stays in the one throwaway opened for the chain", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const tab = browser.existingTab({ url: "https://kottke.org/", cookieStoreId: tmp1.cookieStoreId });
    const suffix = sequentialTmpSuffixes();
    suffix(); // tmp1 above was issued by this counter
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    await browser.navigates(aNavigationTo({ requestId: "10", tabId: tab.id, url: "https://linked.test/a" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank"; // pre-commit for the whole redirect chain, as in real Firefox
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://linked.test/a" }));

    // A 302 to ANOTHER site, on the same requestId. Resolved on its own it is an unmatched
    // site and buys a throwaway — but one click must not buy one per hop (tmp2 -> tmp3), and
    // the user never sees an intermediate hop.
    const hop = await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://hop.test/b" }));

    expect(hop).toBeUndefined();
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("a redirect hop to another site in the SAME container is not reopened into it again", async () => {
    const browser = aFakeBrowser();
    // One rule, two hosts: the hop crosses a site boundary without changing container.
    const config = parseConfig("rules:\n  - match: [github.com, github.dev]\n    open: GitHub\n");
    browser.addContainerNamed({ name: "GitHub" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ requestId: "10", tabId: tab.id, url: "https://github.com/x" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank";
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://github.com/x" }));

    const hop = await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://github.dev/x" }));

    expect(hop).toBeUndefined(); // already correctly contained — no second tab, no churn
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.closedTabIds).toEqual([]);
  });

  it("routes a redirect hop that leaves the site the tab was reopened for — the SSO callback home", async () => {
    const browser = aFakeBrowser();
    const sonar = browser.addContainerNamed({ name: "SonarCloud" });
    browser.addContainerNamed({ name: "GitHub" });
    const config = parseConfig("rules:\n  - match: github.com\n    open: GitHub\n  - match: sonarcloud.io\n    open: SonarCloud\n");
    const tab = browser.existingTab({ url: "https://sonarcloud.io/projects", cookieStoreId: sonar.cookieStoreId });
    createEngine({ port: browser.port, config, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    // "Log in with GitHub": reopened into GitHub, where the user's github session lives.
    await browser.navigates(aNavigationTo({ requestId: "10", tabId: tab.id, url: "https://github.com/login/oauth/authorize?client_id=x" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank"; // pre-commit for the whole redirect chain, as in real Firefox
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://github.com/login/oauth/authorize?client_id=x" }));

    // GitHub answers 302 back to SonarCloud: a hop of the SAME navigation, on the same
    // requestId, at a site the GitHub container has no session for.
    const hop = await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://sonarcloud.io/sessions/callback/github?code=c" }));

    expect(hop).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(2);
    expect(browser.openedTabs[1]).toMatchObject({
      url: "https://sonarcloud.io/sessions/callback/github?code=c",
      cookieStoreId: sonar.cookieStoreId,
    });
    // The pre-commit GitHub tab had nothing to lose, so it is replaced rather than stranded.
    expect(browser.closedTabIds).toEqual([newTab.id]);
  });

  it("F1: a link opened in a new tab buys one throwaway even when its navigation is requested twice", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const readingTab = browser.existingTab({ url: "https://daringfireball.net/", cookieStoreId: tmp1.cookieStoreId, index: 3 });
    // "Open Link in New Tab": Firefox makes a tab that inherits the opener's container and
    // reads about:blank until it commits.
    const linkTab = browser.existingTab({ url: "about:blank", cookieStoreId: tmp1.cookieStoreId, index: 4, openerTabId: readingTab.id });
    const suffix = sequentialTmpSuffixes();
    suffix(); // tmp1 above was issued by this counter
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    // One click, but the load reaches webRequest twice: a second request for the same url,
    // on its own requestId, while the first is still inside createIdentity/createTab. Read
    // concurrently, both see the same pre-commit tab and both mint a throwaway.
    const [first, second] = await Promise.all([
      browser.navigates(aNavigationTo({ requestId: "1", tabId: linkTab.id, url: "https://linked.test/a" })),
      browser.navigates(aNavigationTo({ requestId: "2", tabId: linkTab.id, url: "https://linked.test/a" })),
    ]);

    expect(first).toEqual({ cancel: true });
    // By the time the second is looked at, the tab it belonged to has been superseded, so
    // there is nothing left to route and nothing to cancel.
    expect(second).toBeUndefined();
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
    expect(browser.openedTabs).toHaveLength(1);
  });

  it("routes a later navigation in a reopened tab whose own request never arrived", async () => {
    const browser = aFakeBrowser();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: sourceTab.id, url: "https://example.com/" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== sourceTab.id)!;
    // The reopened tab's own request never arrives (load aborted, or the user typed
    // elsewhere first), so it never committed and still reads about:blank.
    newTab.url = "about:blank";

    // That later navigation is real, to a site no rule matches: it needs its own
    // throwaway, not a ride in Work on a stale guard.
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

    // ...but HSTS upgrades the scheme BEFORE onBeforeRequest, so the tab's first request
    // arrives on a url we never asked for. It is still the navigation we reopened the tab
    // to perform; treating it as new buys a second throwaway.
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

    // Middle-click, ctrl-click or target=_blank: Firefox opens a tab that INHERITS the
    // opener's container and reads about:blank until the navigation commits.
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
    expect(browser.createdContainers[0]!.name).toMatch(/^tmp/);
  });

  it("two independent blank tabs to the same unmatched site are isolated from each other", async () => {
    const browser = aFakeBrowser();
    // Two new tabs, neither opened from the other: no page of their own, no opener, nothing
    // in common but the address typed into both. Every other isolation case drives one tab
    // or a link from an opener, so nothing else says the same site in two unrelated tabs is
    // two sessions — the whole promise of a throwaway.
    const first = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    const second = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: first.id, url: "https://unmatched.test/" }));
    await browser.navigates(aNavigationTo({ requestId: "2", tabId: second.id, url: "https://unmatched.test/" }));

    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp1", "tmp2"]);
    const [forFirst, forSecond] = browser.openedTabs;
    expect(forFirst!.cookieStoreId).not.toBe(forSecond!.cookieStoreId);
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

// A tab the browser opened FOR a link has no page of its own, so `current` cannot answer
// "may this navigation keep the throwaway it is in" — but the tab starts in the container
// of the page the click came from, and that page can. Reported: opening a video from a
// YouTube search result in a new tab put it in a SECOND throwaway, logged out, where
// clicking the same link in place stays put.
describe("engine — a link opened in a new tab", () => {
  const noRules = () => ({ rules: [], groups: [] });

  // What Firefox leaves behind for "Open Link in New Tab": a tab pre-commit on
  // about:blank, in its opener's container, pointing back at the page clicked.
  function aLinkTabFrom(browser: ReturnType<typeof aFakeBrowser>, opener: Tab): Tab {
    return browser.existingTab({ url: "about:blank", cookieStoreId: opener.cookieStoreId, openerTabId: opener.id, index: opener.index + 1 });
  }

  it("keeps the throwaway it was clicked from when it stays on the same site", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const search = browser.existingTab({ url: "https://youtube.test/results?q=cc", cookieStoreId: tmp1.cookieStoreId });
    const linkTab = aLinkTabFrom(browser, search);
    const suffix = sequentialTmpSuffixes();
    suffix(); // tmp1 above was issued by this counter
    createEngine({ port: browser.port, config: noRules(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: linkTab.id, url: "https://youtube.test/watch?v=1" }));

    expect(blockingResponse).toBeUndefined(); // the tab is already where it belongs
    expect(browser.createdContainers).toEqual([]);
    expect(browser.openedTabs).toEqual([]);
    expect(browser.closedTabIds).toEqual([]);
  });

  it("still gets a throwaway of its own when it crosses a site boundary", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const article = browser.existingTab({ url: "https://daringfireball.net/", cookieStoreId: tmp1.cookieStoreId });
    const linkTab = aLinkTabFrom(browser, article);
    const suffix = sequentialTmpSuffixes();
    suffix();
    createEngine({ port: browser.port, config: noRules(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: linkTab.id, url: "https://x.com/gruber" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
  });

  // `tabs.create` can name an opener in any container, and CC's reopens do exactly that —
  // a reopen exists BECAUSE the containers differ. Reading the opener's page as this tab's
  // own would answer for a container the tab is not in.
  it("ignores the opener's page for a tab that is not in the opener's container", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const tmp2 = browser.addContainerNamed({ name: "tmp2" });
    const article = browser.existingTab({ url: "https://linked.test/a", cookieStoreId: tmp1.cookieStoreId });
    // A tab CC reopened out of `article`: same site, pre-commit, opener carried by
    // `supersede`, but in a throwaway of its own whose first request never arrived.
    const reopened = browser.existingTab({ url: "about:blank", cookieStoreId: tmp2.cookieStoreId, openerTabId: article.id });
    const suffix = sequentialTmpSuffixes();
    suffix();
    suffix();
    createEngine({ port: browser.port, config: noRules(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: reopened.id, url: "https://linked.test/b" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp3"]);
  });

  // The disposable path reads a non-http url as "a throwaway nobody has browsed in yet"
  // and keeps the tab in it, so handing it such an opener would park the link tab in its
  // opener's throwaway whatever site it was headed for.
  it("ignores an opener that is not on a page of its own", async () => {
    const browser = aFakeBrowser();
    const tmp1 = browser.addContainerNamed({ name: "tmp1" });
    const newTab = browser.existingTab({ url: "about:newtab", cookieStoreId: tmp1.cookieStoreId });
    const linkTab = aLinkTabFrom(browser, newTab);
    const suffix = sequentialTmpSuffixes();
    suffix();
    createEngine({ port: browser.port, config: noRules(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: suffix });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: linkTab.id, url: "https://x.com/gruber" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.createdContainers.map((c) => c.name)).toEqual(["tmp2"]);
  });

  // Rules still decide for a tab with no page of its own: `inheritedFrom` feeds the
  // disposable path only. F14's chain opens exactly this way — a Slack link in a new tab,
  // in Slack's container, to a host with a multi-open rule — and must still ask.
  it("does not let the opener's page answer for a rule that would ask", async () => {
    const browser = aFakeBrowser();
    const haeger = browser.addContainerNamed({ name: "Haeger" });
    const slackTab = browser.existingTab({ url: "https://slack.example/", cookieStoreId: haeger.cookieStoreId });
    const linkTab = aLinkTabFrom(browser, slackTab);
    const asked: string[][] = [];
    createEngine({
      port: browser.port,
      config: parseConfig("rules:\n  - match: azure.example\n    open: [Haeger, HSP]\n"),
      deps,
      onChoice: (options) => void asked.push(options),
      pause: noPause,
      tmpSuffix: sequentialTmpSuffixes(),
    });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: linkTab.id, url: "https://portal.azure.example/" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(asked).toEqual([["Haeger", "HSP"]]);
  });
});

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
    // The picker arrives with the tab on the choice page, a moz-extension url and so a tab
    // with nothing to lose: the replacing path.
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
    expect(browser.createdContainers[0]!.name).toMatch(/^tmp/);
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
        // The whole navigation, method included: the record is written at a URL now, and a
        // POST is the hop no rule can move, so both are facts the recorder needs.
        nav: expect.objectContaining({ url: "https://example.com/", method: "GET" }),
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

    // F9's toast announces a rule that went UNAPPLIED. Under a pause nothing did — the
    // user turned routing off. This pins the step ahead of F9's.
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
    expect(pause.recorded[0]!.decision).toEqual({ kind: "choice", options: ["Personal", "Work"] });
  });
});

// Ctrl+U. Firefox loads `view-source:https://example.com/` into a tab of its own and
// fetches the document to print, so webRequest is handed an ordinary main_frame GET for the
// INNER url with the tab pre-commit on about:blank — nothing says the user asked for source
// rather than the page. Routing it cancels the fetch, reopens the plain url elsewhere,
// loses the `view-source:` wrapper and, the tab having nothing to lose, takes the source tab
// down with it. webNavigation.onBeforeNavigate is the one event that names the wrapped url,
// and Firefox fires it before the request that navigation issues.
describe("engine — a view-source load", () => {
  const viewSourceOf = (url: string) => `view-source:${url}`;

  it("is left alone: the fetch behind Ctrl+U is not a navigation to route", async () => {
    const browser = aFakeBrowser();
    // A brand new pre-commit tab: from the request alone, indistinguishable from a
    // middle-clicked link, which is why the mark has to come from elsewhere.
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

    // One navigation, one onBeforeNavigate, several requests: a redirect chain reuses the
    // requestId and announces no second navigation, so the mark must outlive hop 1.
    browser.startsNavigating({ tabId: sourceTab.id, url: viewSourceOf("https://example.com/hop") });
    await browser.navigates(aNavigationTo({ tabId: sourceTab.id, url: "https://example.com/hop" }));
    const lastHop = await browser.navigates(aNavigationTo({ tabId: sourceTab.id, url: "https://example.com/" }));

    expect(lastHop).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
  });

  it("does not stop the tab being routed once it navigates somewhere for real", async () => {
    const browser = aFakeBrowser();
    // A tab that is ON a page: `view_source.tab=false` puts the source in the current tab,
    // and that tab is the one still to be routed afterwards.
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    browser.startsNavigating({ tabId: sourceTab.id, url: viewSourceOf("https://example.com/") });
    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));
    expect(browser.openedTabs).toEqual([]);

    // Typing a url into that same tab. Nothing expires the mark on a timer: the next
    // top-level navigation announcing itself clears it.
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

// `initiator` answers "which container did this navigation come FROM". A tab's opener
// answers that only while the tab has no page of its own: once it commits, the page it is
// on is where the navigation comes from, and the opener is a tab the user left behind —
// Firefox keeps `openerTabId` for the life of the tab, and `supersede` carries it across
// every reopen.
//
// Reported (F14): on slack.com in "Haeger", a link to portal.azure.com asked which
// container, and picking "HSP" then opened login.microsoftonline.com tab after tab,
// alternating Haeger and HSP. Opening portal.azure.com directly worked, because such tabs
// have no opener.
//
// The loop needs no second bug: reading the initiator off a stale opener sends the HSP tab
// to Haeger, and `supersede` makes the tab it came from the new one's opener, so the next
// hop reads HSP and goes back. Each hop keeps the tab it left, which is the tab-after-tab
// part.
describe("engine — an inherit host in a tab that has an opener", () => {
  const ssoConfig = () =>
    parseConfig(`
rules:
  - match: login.sso.example
    inherit: true
  - match: azure.example
    open: [Haeger, HSP]
`);

  it("inherits from the page the tab is on, not from the tab that opened it", async () => {
    const browser = aFakeBrowser();
    const haeger = browser.addContainerNamed({ name: "Haeger" });
    const hsp = browser.addContainerNamed({ name: "HSP" });
    // The tab the user is in, still pointing back at the Slack tab it came from.
    const slackTab = browser.existingTab({ url: "https://slack.example/", cookieStoreId: haeger.cookieStoreId });
    const azureTab = browser.existingTab({
      url: "https://portal.azure.example/",
      cookieStoreId: hsp.cookieStoreId,
      openerTabId: slackTab.id,
    });
    createEngine({ port: browser.port, config: ssoConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(
      aNavigationTo({ tabId: azureTab.id, url: "https://login.sso.example/oauth2/authorize" })
    );

    // The login belongs to the session HSP just started, not to Haeger.
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(0);
  });

  it("still inherits from the opener for a tab that has no page of its own", async () => {
    const browser = aFakeBrowser();
    const haeger = browser.addContainerNamed({ name: "Haeger" });
    const opener = browser.existingTab({ url: "https://slack.example/", cookieStoreId: haeger.cookieStoreId });
    // target=_blank or middle-click: pre-commit on about:blank, so the opener is the only
    // thing that says where this navigation came from.
    const blank = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default", openerTabId: opener.id });
    createEngine({ port: browser.port, config: ssoConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: blank.id, url: "https://login.sso.example/oauth2/authorize" }));

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs[0]!.cookieStoreId).toBe(haeger.cookieStoreId);
  });

  it("F14: the reported chain — slack link, choice, HSP — leaves the login in HSP", async () => {
    const browser = aFakeBrowser();
    const haeger = browser.addContainerNamed({ name: "Haeger" });
    const hsp = browser.addContainerNamed({ name: "HSP" });
    const config = ssoConfig();
    // Wired as `wireBackground` does: the picker reopens through the engine's F1-guarded
    // `reopen`, which carries the opener along.
    let picker: ReturnType<typeof createPicker>;
    const engine = createEngine({
      port: browser.port,
      config,
      deps,
      onChoice: (options, nav) => void picker.showChoice(nav.tabId, nav.url, options),
      pause: noPause,
      tmpSuffix: sequentialTmpSuffixes(),
    });
    picker = createPicker({ port: browser.port, config, deps, reopen: engine.reopen });
    browser.port.onMessage((msg, sender) => picker.handleMessage(msg, sender));

    const slackTab = browser.existingTab({ url: "https://slack.example/", cookieStoreId: haeger.cookieStoreId });
    // Slack opens the link in a tab of its own: Haeger, pre-commit, opener set.
    const linkTab = browser.existingTab({ url: "about:blank", cookieStoreId: haeger.cookieStoreId, openerTabId: slackTab.id });

    const portal = "https://portal.azure.example/";
    expect(await browser.navigates(aNavigationTo({ requestId: "1", tabId: linkTab.id, url: portal }))).toEqual({ cancel: true });
    await browser.settle();

    const choiceTab = [...browser.openTabs.values()].find((t) => t.url.startsWith("moz-extension://"))!;
    expect(await browser.receivesMessage({ type: "cc-pick", url: portal, container: "HSP" }, choiceTab)).toEqual({ ok: true });

    const azureTab = [...browser.openTabs.values()].find((t) => t.url === portal)!;
    expect(azureTab.cookieStoreId).toBe(hsp.cookieStoreId);
    // The opener rode along through both supersedes: this is the stale pointer.
    expect(azureTab.openerTabId).toBe(slackTab.id);

    // Its own navigation, which reopenedNav owns from its first request.
    expect(await browser.navigates(aNavigationTo({ requestId: "2", tabId: azureTab.id, url: portal }))).toBeUndefined();

    // The portal then sends the user to the identity provider: a fresh navigation, no longer
    // ours. Before the fix this reopened into Haeger and the ping-pong started.
    const openedSoFar = browser.openedTabs.length;
    const blockingResponse = await browser.navigates(
      aNavigationTo({ requestId: "3", tabId: azureTab.id, url: "https://login.sso.example/common/oauth2/authorize" })
    );

    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(openedSoFar);
  });
});

// `reopenedNav` guards ONE navigation. Every case above is a hop of it; these two are what
// happens when it is over — the marker has to stop applying, or the tab it guarded never
// routes again.
describe("engine — the reopen guard letting go", () => {
  it("routes a LATER navigation to the site the tab was reopened for", async () => {
    const browser = aFakeBrowser();
    // Path-scoped: the same site answers differently depending on where in it you are, so
    // "same site as the awaited url" is not enough to leave a navigation alone.
    const config = parseConfig('rules:\n  - match: "*://shop.test/work*"\n    open: Work\n');
    browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ requestId: "10", tabId: tab.id, url: "https://shop.test/browse" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank";
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://shop.test/browse" }));
    newTab.url = "https://shop.test/browse"; // committed: the navigation the marker owned is done

    // A new click, a new requestId, still shop.test. Absorbing it because the site matches
    // would leave the marker owning this tab for the rest of its life.
    const later = await browser.navigates(aNavigationTo({ requestId: "12", tabId: newTab.id, url: "https://shop.test/work/a" }));

    expect(later).toEqual({ cancel: true });
    const work = (await browser.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(browser.openedTabs.at(-1)!.cookieStoreId).toBe(work.cookieStoreId);
  });

  it("shows the choice screen for a hop that leaves the site into a rule offering several", async () => {
    const browser = aFakeBrowser();
    const config = parseConfig("rules:\n  - match: figma.example\n    open: [Personal, Work]\n");
    browser.addContainerNamed({ name: "Personal" });
    browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const offered: string[][] = [];
    createEngine({
      port: browser.port,
      config,
      deps,
      onChoice: (options) => void offered.push(options),
      pause: noPause,
      tmpSuffix: sequentialTmpSuffixes(),
    });

    await browser.navigates(aNavigationTo({ requestId: "10", tabId: tab.id, url: "https://sso.test/go" }));
    const newTab = [...browser.openTabs.values()].find((t) => t.id !== tab.id)!;
    newTab.url = "about:blank";
    await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://sso.test/go" }));

    // The hop leaves sso.test for a rule that names two containers. `aHopBuysNoThrowaway`
    // vetoes a hop whose only answer is another throwaway; a choice is not one, and asking
    // is the whole point of a multi-container rule.
    const hop = await browser.navigates(aNavigationTo({ requestId: "11", tabId: newTab.id, url: "https://figma.example/f" }));

    expect(hop).toEqual({ cancel: true });
    expect(offered).toEqual([["Personal", "Work"]]);
  });
});

describe("engine — the per-tab queue outliving a failed decision", () => {
  it("hands the throw to Firefox and still decides the next navigation on that tab", async () => {
    const browser = aFakeBrowser();
    browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });
    browser.tabLookupFails(true);

    // `tabs.get` rejecting is a race, not a fault: the tab closed between the request
    // reaching webRequest and the lookup landing. The engine lets it go to Firefox, which
    // fails the navigation open.
    await expect(browser.navigates(aNavigationTo({ requestId: "1", tabId: tab.id }))).rejects.toThrow();

    // What the NEXT request waits on is a promise that swallowed that outcome. Without it,
    // one rejection leaves every later navigation in the tab chained behind a rejected
    // promise, and the tab stops routing for the life of the browser.
    browser.tabLookupFails(false);
    const next = await browser.navigates(aNavigationTo({ requestId: "2", tabId: tab.id }));

    expect(next).toEqual({ cancel: true });
    const work = (await browser.port.queryIdentities()).find((c) => c.name === "Work")!;
    expect(browser.openedTabs.at(-1)!.cookieStoreId).toBe(work.cookieStoreId);
  });
});
