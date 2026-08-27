// Fitness function: what a navigation pays to be decided.
//
// The one quality criterion here that a user feels. `onBeforeRequest` is BLOCKING: Firefox
// holds the request until the returned promise settles, so every async call the handler
// makes first is latency in front of a page load, on every navigation. The design is shaped
// around that — a synchronous `isPaused`, an armed set hydrated at startup, a `record` that
// returns void, a MAC handshake after the decision.
//
// Nothing measures it. An added `await port.getIdentity(...)` is not a failure, not a
// coverage change and not a mutant — just the same answer, slower, forever. So this counts
// ROUND TRIPS, not milliseconds: a wall-clock budget in CI is a flake generator, and the
// count is what the design is about.
import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "../engine/mock-port";
import { createEngine, type PauseRecorder } from "../../src/engine/engine";
import { hostMatcher, matchRule, matchGroup } from "../../src/matcher/matcher";
import { sameSite } from "../../src/psl/same-site";
import type { BrowserPort, WebRequestDetails } from "../../src/engine/port";
import type { Config, Deps } from "../../src/resolver/types";

const deps: Deps = { matchRule, matchGroup, sameSite };
const noPause: PauseRecorder = { isPaused: () => false, record: () => {} };
const ignoreChoices = (): void => {};

function sequentialTmpSuffixes(): () => string {
  let n = 0;
  return () => String(++n);
}

// Every port method the engine can await, in call order. Registrations are not counted:
// they run once at startup, not per navigation.
function countingPort(port: BrowserPort): { port: BrowserPort; awaited: string[] } {
  const awaited: string[] = [];
  const registrations = /^on[A-Z]/;
  const wrapped = new Proxy(port, {
    get(target, prop: string) {
      const value = (target as unknown as Record<string, unknown>)[prop];
      if (typeof value !== "function" || registrations.test(prop)) return value;
      return (...args: unknown[]) => {
        awaited.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { port: wrapped, awaited };
}

function aNavigationTo(url: string, over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url, type: "main_frame", method: "GET", ...over };
}

// One rule: work.example belongs in the permanent "Work" container.
const workConfig = (): Config => ({
  rules: [{ match: [hostMatcher("work.example")], action: { kind: "open", containers: ["Work"] } }],
  groups: [],
});

describe("fitness — the blocking path's round-trip budget", () => {
  it("costs a tab lookup and one container lookup for a navigation that stays put", () => {
    // The common case by a wide margin: a tab already in the container its rules name,
    // clicking from page to page. Each one runs the full handler and must come out having
    // asked the browser as little as possible.
    const browser = aFakeBrowser();
    const work = browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://work.example/one", cookieStoreId: work.cookieStoreId });
    const counted = countingPort(browser.port);
    createEngine({ port: counted.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    return browser.navigates(aNavigationTo("https://work.example/two", { tabId: tab.id })).then((response) => {
      expect(response).toBeUndefined(); // stayed put, nothing cancelled

      // getTab: which tab is this. getIdentity: which container is it in. Nothing else is
      // worth asking about a navigation already where it belongs — least of all the MAC
      // handshake, a round trip to ANOTHER EXTENSION. The engine asks MAC only about a
      // navigation it is about to act on, and that ordering is what this pins.
      expect(counted.awaited).toEqual(["getTab", "getIdentity"]);
    });
  });

  it("asks another extension only once it has decided to act, and only then", async () => {
    // `sendExternalMessage` is a cross-extension round trip: MAC has to wake and answer
    // before the navigation continues. "Ask MAC first, then decide" reads reasonable and
    // would put that cost in front of every navigation, including the ones that were always
    // going to stay put.
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const counted = countingPort(browser.port);
    createEngine({ port: counted.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo("https://work.example/", { tabId: tab.id }));

    // The whole navigation, in order. The tab is in the default container, which
    // `registry.toRef` answers without asking anyone, so the DECISION costs one `getTab` and
    // MAC comes after it. Everything from `queryIdentities` on is the effect, which only a
    // navigation actually being reopened reaches.
    expect(counted.awaited).toEqual([
      "getTab", // (2) which tab is this
      "sendExternalMessage", // (4) F7 — MAC asked only now, having decided to act
      "queryIdentities", // find-or-create the "Work" container
      "createIdentity",
      "createTab",
    ]);
  });

  it("adds no round trip at all when the container is paused", async () => {
    // The pause seam is synchronous BY CONTRACT so arming a container costs a navigation
    // nothing. An `await` in either method would be paid on every navigation in an armed
    // container — the one place the user has said they want CC doing less, not more.
    const browser = aFakeBrowser();
    const work = browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: work.cookieStoreId });
    const counted = countingPort(browser.port);
    createEngine({
      port: counted.port,
      config: workConfig(),
      deps,
      onChoice: ignoreChoices,
      pause: { isPaused: () => true, record: () => {} },
      tmpSuffix: sequentialTmpSuffixes(),
    });

    await browser.navigates(aNavigationTo("https://work.example/", { tabId: tab.id }));

    // The same two lookups the decision needs and nothing after: no MAC handshake, no
    // container creation, no storage write for the recording.
    expect(counted.awaited).toEqual(["getTab", "getIdentity"]);
  });

  it("pays for a reopen once, and never re-asks on the hops of the navigation it opened", async () => {
    // A reopen is expensive on purpose: a container to find or create, a tab to open, maybe
    // one to close. What must NOT be expensive is the navigation after it — `reopenedNav`
    // answers the reopened tab's request, and every redirect hop, without touching the
    // browser. That is why a redirect chain costs one reopen and not one per hop (F1).
    const browser = aFakeBrowser();
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const counted = countingPort(browser.port);
    createEngine({ port: counted.port, config: workConfig(), deps, onChoice: ignoreChoices, pause: noPause, tmpSuffix: sequentialTmpSuffixes() });

    await browser.navigates(aNavigationTo("https://work.example/", { tabId: tab.id }));
    const reopened = browser.openedTabs.at(-1)!;
    const reopenedTabId = [...browser.openTabs.values()].find((t) => t.url === reopened.url)!.id;

    counted.awaited.length = 0;
    await browser.navigates(aNavigationTo("https://work.example/", { requestId: "2", tabId: reopenedTabId }));
    await browser.navigates(aNavigationTo("https://work.example/after-redirect", { requestId: "2", tabId: reopenedTabId }));

    expect(counted.awaited).toEqual([]);
  });
});
