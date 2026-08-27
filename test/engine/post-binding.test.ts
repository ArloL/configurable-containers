import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { createEngine, type PauseRecorder } from "../../src/engine/engine";
import { matchRule, matchGroup, hostMatcher } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Config, Deps } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

const deps: Deps = { matchRule, matchGroup, sameSite };
const ignoreChoices = () => {};
// Required, not optional: an optional field is one a mock forgets to set.
const noPause: PauseRecorder = { isPaused: () => false, record: () => {} };

function sequentialTmpSuffixes(): () => string {
  let n = 0;
  return () => String(++n);
}

function aNavigationTo(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://example.com/", type: "main_frame", method: "POST", ...over };
}

// example.com opens the permanent "Work" container.
function workConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Work"] } }], groups: [] };
}

// example.com offers two containers and no default — resolve() returns a choice.
function choiceConfig(): Config {
  return { rules: [{ match: [hostMatcher("example.com")], action: { kind: "open", containers: ["Personal", "Work"] } }], groups: [] };
}

describe("engine — a non-GET navigation is never reopened (F9)", () => {
  it("declines to reopen a POST into a permanent container, and says where it stayed", async () => {
    const browser = aFakeBrowser();
    const tmp = browser.addContainerNamed({ name: "tmp1" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: tmp.cookieStoreId });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));
    await browser.settle();

    // tabs.create can only issue a GET, so reopening would drop the body. The POST
    // proceeds where it is: no cancel, no new tab.
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
    expect(browser.closedTabIds).toEqual([]);
    expect(browser.notifications).toHaveLength(1);
    expect(browser.notifications[0]!.message).toBe(
      "A form submission to example.com stayed in tmp1 instead of Work — moving it would have dropped the form data.",
    );
  });

  it("declines a POST that would have bought a fresh throwaway — silently", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: { rules: [], groups: [] }, deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));
    await browser.settle();

    // The decline is unconditional — the body would be dropped whatever the target.
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
    // But there is nothing to say: no rule named this destination, so the message would
    // have been "instead of a new temporary container" — a state the user cannot tell
    // from the one they are in, and cannot act on.
    expect(browser.notifications).toEqual([]);
  });

  it("stays silent when a POST out of a named container would only have been isolated", async () => {
    const browser = aFakeBrowser();
    const work = browser.addContainerNamed({ name: "Work" });
    // In Work, posting to a host no rule matches: the disposable path wants a throwaway.
    const tab = browser.existingTab({ url: "https://example.com/a", cookieStoreId: work.cookieStoreId });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id, url: "https://nomatch.test/pay" }));
    await browser.settle();

    // This is the payment-return shape, and the one that would fire most often in
    // ordinary use: staying put is what makes the checkout work, so there is no
    // unapplied rule to report.
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toEqual([]);
    expect(browser.notifications).toEqual([]);
  });

  it("declines a POST that would have raised the choice screen", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const offered: string[][] = [];
    createEngine({ port: browser.port, config: choiceConfig(), deps, onChoice: (o) => void offered.push(o), pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));
    await browser.settle();

    // The choice screen reopens through engine.reopen too, so it drops the body just
    // as surely — decline before showing it.
    expect(blockingResponse).toBeUndefined();
    expect(offered).toEqual([]);
    expect(browser.openedTabs).toEqual([]);
    expect(browser.notifications[0]!.message).toContain("instead of one of: Personal, Work");
  });

  it("leaves a POST that was already going to stay put alone, and stays silent", async () => {
    const browser = aFakeBrowser();
    const work = browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://example.com/a", cookieStoreId: work.cookieStoreId });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));
    await browser.settle();

    expect(blockingResponse).toBeUndefined();
    expect(browser.notifications).toEqual([]);
  });

  it("still reopens a GET", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id, method: "GET" }));
    await browser.settle();

    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.notifications).toEqual([]);
  });

  it("warns once per host, not once per attempt", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: tab.id, requestId: "1" }));
    await browser.navigates(aNavigationTo({ tabId: tab.id, requestId: "2", url: "https://example.com/other" }));
    await browser.settle();

    expect(browser.notifications).toHaveLength(1);
  });

  it("says nothing about a POST inside a navigation the engine itself reopened", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo({ tabId: tab.id, method: "GET" })); // reopens into Work
    const created = browser.openedTabs[0]!;
    const openedTab = [...browser.openTabs.values()].find((t) => t.cookieStoreId === created.cookieStoreId)!;

    // A form POST arriving as the reopened tab's own first request is ours already —
    // it returns at the reopenedNav guard and never reaches the F9 check.
    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: openedTab.id, requestId: "2" }));
    await browser.settle();

    expect(blockingResponse).toBeUndefined();
    expect(browser.notifications).toEqual([]);
  });
});

describe("engine — a toast that cannot be raised", () => {
  it("lets the POST through when the notification itself fails", async () => {
    const browser = aFakeBrowser();
    const tmp = browser.addContainerNamed({ name: "tmp1" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: tmp.cookieStoreId });
    createEngine({ port: browser.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });
    browser.notificationsFail(true);

    const blockingResponse = await browser.navigates(aNavigationTo({ tabId: tab.id }));
    await browser.settle();

    // The toast is floated out of the blocking handler precisely so it cannot decide a
    // navigation. Without its catch, a missing `notifications` permission is an unhandled
    // rejection on every declined form submission.
    expect(blockingResponse).toBeUndefined();
    expect(browser.notifications).toEqual([]);
  });
});
