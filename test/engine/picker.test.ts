import { describe, it, expect } from "vitest";
import { aFakeBrowser, DEFAULT_WINDOW_ID, type MockPort } from "./mock-port";
import { createPicker } from "../../src/engine/picker";
import { decodePayload } from "../../src/extension/picker-protocol";
import { parseConfig } from "../../src/config/parse";
import { matchRule, matchGroup } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { Tab } from "../../src/engine/port";
import type { Target } from "../../src/resolver/types";

const deps = { matchRule, matchGroup, sameSite };
const config = parseConfig(`
rules:
  - match: figma.example
    open: [Personal, Work]
  - match: youtube.example
    open: [Temporary, Personal]
    default: Temporary
  - match: work.example
    open: Work
`);

const CHOICE_PAGE = "moz-extension://test/choice.html";

function fakeReopen(): {
  reopen: (tab: Tab, url: string, t: Target) => Promise<void>;
  calls: Array<{ tabId: number; url: string; target: Target }>;
} {
  const calls: Array<{ tabId: number; url: string; target: Target }> = [];
  return {
    reopen: async (tab, url, target) => {
      calls.push({ tabId: tab.id, url, target });
    },
    calls,
  };
}

function decodeChoiceUrl(url: string | undefined) {
  return decodePayload(url!.split("#")[1]!);
}

// The picker no longer registers runtime.onMessage — the wiring owns the single
// registration and dispatches by type. These cases mount the handler themselves so they
// still drive it through the port; that the WIRING dispatches cc-pick to it is pinned
// separately, in wiring.test.ts.
function mountedPicker(browser: MockPort, reopen: (tab: Tab, url: string, t: Target) => Promise<void>) {
  const picker = createPicker({ port: browser.port, config, deps, reopen });
  browser.port.onMessage((msg, sender) => picker.handleMessage(msg, sender));
  return picker;
}

describe("picker — choice screen (onChoice flow)", () => {
  it("shows the choice in a tab of its own, leaving the page the user was on intact", async () => {
    const browser = aFakeBrowser();
    const readingSomething = browser.existingTab({ url: "https://kottke.example/", cookieStoreId: "firefox-default", index: 3, active: true });
    const picker = createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await picker.showChoice(readingSomething.id, "https://figma.example/", ["Personal", "Work"]);

    // The choice page is a NEW tab beside it — the article is still open, and nothing
    // navigated the user's own tab anywhere.
    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.openedTabs[0]!.url).toContain(CHOICE_PAGE + "#");
    expect(browser.openedTabs[0]!.index).toBe(readingSomething.index + 1);
    expect(browser.openedTabs[0]!.openerTabId).toBe(readingSomething.id);
    expect(browser.closedTabIds).toEqual([]);
    expect(browser.openTabs.get(readingSomething.id)?.url).toBe("https://kottke.example/");
  });

  it("replaces a triggering tab that has nothing to lose, so no empty tab is stranded", async () => {
    const browser = aFakeBrowser();
    // What a middle-clicked / target=_blank link is: pre-commit, in its opener's container.
    const middleClicked = browser.existingTab({ url: "about:blank", cookieStoreId: "firefox-default", index: 4, openerTabId: 99 });
    const picker = createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await picker.showChoice(middleClicked.id, "https://figma.example/", ["Personal", "Work"]);

    expect(browser.openedTabs[0]!.index).toBe(middleClicked.index);
    expect(browser.openedTabs[0]!.openerTabId).toBe(99);
    expect(browser.closedTabIds).toEqual([middleClicked.id]);
  });

  it("opens the choice in the window its triggering tab is in", async () => {
    const browser = aFakeBrowser();
    const inAnotherWindow = browser.existingTab({ url: "https://kottke.example/", cookieStoreId: "firefox-default", windowId: 7 });
    const picker = createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await picker.showChoice(inAnotherWindow.id, "https://figma.example/", ["Personal", "Work"]);

    expect(browser.openedTabs[0]!.windowId).toBe(7);
  });

  it("carries the destination and the eligible containers to the page, and no tab id", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://figma.example/", cookieStoreId: "firefox-default" });
    const picker = createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await picker.showChoice(tab.id, "https://figma.example/", ["Personal", "Work"]);

    expect(decodeChoiceUrl(browser.openedTabs[0]!.url)).toEqual({
      url: "https://figma.example/",
      options: ["Personal", "Work"],
    });
  });

  it("shows nothing when the triggering tab has raced away", async () => {
    const browser = aFakeBrowser();
    const picker = createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await picker.showChoice(999, "https://figma.example/", ["Personal", "Work"]);

    expect(browser.openedTabs).toEqual([]);
  });
});

describe("picker — a selection (cc-pick)", () => {
  it("reopens the tab that spoke into the chosen container, and returns {ok:true}", async () => {
    const browser = aFakeBrowser();
    const choiceTab = browser.existingTab({ url: CHOICE_PAGE + "#x", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    mountedPicker(browser, fr.reopen);

    const reply = await browser.receivesMessage({ type: "cc-pick", url: "https://figma.example/", container: "Work" }, choiceTab);

    expect(reply).toEqual({ ok: true });
    expect(fr.calls).toEqual([{ tabId: choiceTab.id, url: "https://figma.example/", target: { kind: "permanent", name: "Work" } }]);
  });

  it("maps 'Temporary' to a fresh-throwaway target", async () => {
    const browser = aFakeBrowser();
    const choiceTab = browser.existingTab({ url: CHOICE_PAGE + "#x", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    mountedPicker(browser, fr.reopen);

    await browser.receivesMessage({ type: "cc-pick", url: "https://youtube.example/", container: "Temporary" }, choiceTab);

    expect(fr.calls[0]!.target).toEqual({ kind: "temporary" });
  });

  it("declines a sender that is not a tab — the page cannot name a tab it is not", async () => {
    const browser = aFakeBrowser();
    const fr = fakeReopen();
    mountedPicker(browser, fr.reopen);

    const reply = await browser.receivesMessage({ type: "cc-pick", url: "https://figma.example/", container: "Work" });

    expect(reply).toEqual({ ok: false });
    expect(fr.calls).toEqual([]);
  });

  it("declines a url that is not http(s) — the hash payload it came from is attacker-reachable", async () => {
    const browser = aFakeBrowser();
    const choiceTab = browser.existingTab({ url: CHOICE_PAGE + "#x", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    mountedPicker(browser, fr.reopen);

    const reply = await browser.receivesMessage({ type: "cc-pick", url: "javascript:alert(1)", container: "Work" }, choiceTab);

    expect(reply).toEqual({ ok: false });
    expect(fr.calls).toEqual([]);
  });

  it("returns {ok:false} when the reopen throws, so the page can say so", async () => {
    const browser = aFakeBrowser();
    const choiceTab = browser.existingTab({ url: CHOICE_PAGE + "#x", cookieStoreId: "firefox-default" });
    const fr = fakeReopen();
    fr.reopen = async () => {
      throw new Error("boom");
    };
    mountedPicker(browser, fr.reopen);

    const reply = await browser.receivesMessage({ type: "cc-pick", url: "https://figma.example/", container: "Work" }, choiceTab);

    expect(reply).toEqual({ ok: false });
  });

  it("returns {ok:false} when the sending tab has raced away", async () => {
    const browser = aFakeBrowser();
    const choiceTab = browser.existingTab({ url: CHOICE_PAGE + "#x", cookieStoreId: "firefox-default" });
    mountedPicker(browser, fakeReopen().reopen);
    await browser.port.removeTab(choiceTab.id);

    const reply = await browser.receivesMessage({ type: "cc-pick", url: "https://figma.example/", container: "Work" }, choiceTab);

    expect(reply).toEqual({ ok: false });
  });

  it("leaves a message that is not cc-pick unanswered, SYNCHRONOUSLY", () => {
    const browser = aFakeBrowser();
    const picker = createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    // Deliberately not awaited, and this is the whole point: `await` flattens a
    // Promise<undefined> to undefined, so an awaited assertion passes whether the
    // handler answered or not. Firefox does not flatten — a returned Promise means
    // "I will answer this", claiming the reply channel from the sibling the message was
    // actually for. Only a synchronous undefined leaves it free.
    expect(picker.handleMessage({ type: "cc-pause-status" }, {})).toBeUndefined();
  });
});

describe("picker — reopen picker (command flow)", () => {
  it("offers the active tab's rule containers, without disturbing the page it is on", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "http://figma.example:1234/", cookieStoreId: "firefox-default", active: true });
    browser.activeTabIs(tab);
    createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await browser.receivesCommand("reopen-picker");

    expect(browser.openedTabs).toHaveLength(1);
    expect(browser.openedTabs[0]!.windowId).toBe(DEFAULT_WINDOW_ID);
    expect(browser.closedTabIds).toEqual([]);
    expect(decodeChoiceUrl(browser.openedTabs[0]!.url)).toEqual({
      url: "http://figma.example:1234/",
      options: ["Personal", "Work"],
    });
  });

  it("does nothing for a single-open rule (nothing to choose)", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "http://work.example:1234/", cookieStoreId: "firefox-default" });
    browser.activeTabIs(tab);
    createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await browser.receivesCommand("reopen-picker");

    expect(browser.openedTabs).toEqual([]);
  });

  it("does nothing when no rule matches (the undecided unmatched case)", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "http://nomatch.example:1234/", cookieStoreId: "firefox-default" });
    browser.activeTabIs(tab);
    createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });

    await browser.receivesCommand("reopen-picker");

    expect(browser.openedTabs).toEqual([]);
  });

  it("does nothing when there is no active tab", async () => {
    const browser = aFakeBrowser();
    createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });
    await browser.receivesCommand("reopen-picker");
    expect(browser.openedTabs).toEqual([]);
  });

  it("ignores an unknown command name", async () => {
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "http://figma.example:1234/", cookieStoreId: "firefox-default" });
    browser.activeTabIs(tab);
    createPicker({ port: browser.port, config, deps, reopen: fakeReopen().reopen });
    await browser.receivesCommand("something-else");
    expect(browser.openedTabs).toEqual([]);
  });
});
