import { describe, it, expect } from "vitest";
import { aFakeBrowser, aFakeClock } from "./mock-port";
import { startTheBackground, restartTheBackground, GRACE_MS, REDIRECTOR_DELAY_MS } from "./restart";
import { hostMatcher } from "../../src/matcher/matcher";
import { parseConfig } from "../../src/config/parse";
import type { Config } from "../../src/resolver/types";
import type { WebRequestDetails } from "../../src/engine/port";

// work.example opens the permanent "Work" container. Every other host is unmatched,
// so it takes the disposable path and lands in a throwaway.
function workConfig(): Config {
  return {
    rules: [{ match: [hostMatcher("work.example")], action: { kind: "open", containers: ["Work"] } }],
    groups: [],
  };
}

function aNavigationTo(over: Partial<WebRequestDetails> = {}): WebRequestDetails {
  return { requestId: "1", tabId: 1, url: "https://unmatched.example/", type: "main_frame", method: "GET", ...over };
}

function aBrowserWithFakeClock() {
  const browser = aFakeBrowser();
  const { clock, advance } = aFakeClock();
  return { browser, clock, advance };
}

const theTabOtherThan = (browser: ReturnType<typeof aFakeBrowser>, id: number) =>
  [...browser.openTabs.values()].find((t) => t.id !== id)!;

const containerNames = (browser: ReturnType<typeof aFakeBrowser>) =>
  browser.createdContainers.map((c) => c.name);

// F8. A background restart destroys every Map, Set and counter the engine and its
// siblings hold. What the extension knows afterwards is only what it rebuilt from
// browser.* queries — so these cases pin, one mechanism at a time, that the rebuild
// actually happens. It is not a hypothetical MV3 concern: options.ts calls
// runtime.reload() on every config save, so the user triggers this in the shipping
// MV2 build whenever they hit save.
describe("a background restart — state that must be reconstructed", () => {
  it("resumes the throwaway counter past a container that is still live", async () => {
    const { browser, clock } = aBrowserWithFakeClock();
    const firstSourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, workConfig());

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: firstSourceTab.id }));
    expect(containerNames(browser)).toEqual(["tmp1"]);

    session = await restartTheBackground(session, browser, clock, workConfig());

    const secondSourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    await browser.navigates(aNavigationTo({ requestId: "2", tabId: secondSourceTab.id, url: "https://other.example/" }));

    // A second tmp1 would collide by name with the live one, and CC identifies its
    // own throwaways by name — the counter is in memory, the names are not.
    expect(containerNames(browser)).toEqual(["tmp1", "tmp2"]);
  });

  it("still disposes a throwaway it created before the restart", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, workConfig());

    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));
    const throwaway = [...browser.containers.values()].find((c) => c.name === "tmp1")!;
    const onlyTabInTheThrowaway = theTabOtherThan(browser, sourceTab.id);

    session = await restartTheBackground(session, browser, clock, workConfig());
    await advance(0); // let the new disposer's startup query settle

    // The tab closes on the far side of the restart, so the container it names was
    // learned by a background that no longer exists.
    await browser.closesTab(onlyTabInTheThrowaway);
    await advance(GRACE_MS - 1);
    expect(browser.removedContainers).toEqual([]); // not yet
    await advance(1);
    // Inside the grace, so the 10-minute GC sweep cannot be what passes this.
    expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]);
  });

  it("does not containerize a new-tab page it already containerized", async () => {
    const { browser, clock } = aBrowserWithFakeClock();
    const newTabPage = browser.existingTab({ url: "about:newtab", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, workConfig());
    await browser.settle();

    expect(containerNames(browser)).toEqual(["tmp1"]);
    expect(browser.closedTabIds).toEqual([newTabPage.id]);

    session = await restartTheBackground(session, browser, clock, workConfig());
    await browser.settle();

    // The replacement is on about:newtab too, so auto-temp's startup sweep sees it
    // again with no `processed` set left to remember it. What keeps the sweep off it
    // is that the tab is no longer in firefox-default.
    expect(containerNames(browser)).toEqual(["tmp1"]);
  });

  it("leaves a tab that already committed in its right container alone", async () => {
    const { browser, clock } = aBrowserWithFakeClock();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, workConfig());

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: sourceTab.id, url: "https://work.example/" }));
    const workTab = theTabOtherThan(browser, sourceTab.id); // on work.example: committed
    expect(browser.openedTabs).toHaveLength(1);

    session = await restartTheBackground(session, browser, clock, workConfig());

    const blockingResponse = await browser.navigates(
      aNavigationTo({ requestId: "2", tabId: workTab.id, url: "https://work.example/inbox" }),
    );

    // Once a tab's url has committed, tabs.get carries everything the guard state did:
    // the F2 answer is reconstructible in full, so a restart is not observable here.
    expect(blockingResponse).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(1);
  });
});

describe("a background restart — state that cannot be", () => {
  // reopenedNav holds a tab whose url has not committed, which is exactly why nothing
  // can rebuild it: at restart that tab reads about:blank in some container, and so
  // does a middle-clicked link — which inherits its opener's container and must still
  // be isolated. The requestId that separates them exists nowhere else. So the bound
  // is what gets pinned, not the state: one wasted hop, and it converges.
  it("costs one extra reopen mid-flight, then converges and leaks nothing", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, workConfig());

    await browser.navigates(aNavigationTo({ requestId: "1", tabId: sourceTab.id }));
    const reopenedTab = theTabOtherThan(browser, sourceTab.id);
    // Real Firefox fires the reopened tab's own onBeforeRequest before its url
    // commits, which is the window the guard exists to cover.
    reopenedTab.url = "about:blank";
    expect(containerNames(browser)).toEqual(["tmp1"]);

    session = await restartTheBackground(session, browser, clock, workConfig());

    // Its own request now reaches an engine with no memory of having opened it.
    const wastedHop = await browser.navigates(
      aNavigationTo({ requestId: "2", tabId: reopenedTab.id }),
    );
    expect(wastedHop).toEqual({ cancel: true });
    expect(containerNames(browser)).toEqual(["tmp1", "tmp2"]);

    // The fresh engine guards the reopen it just performed, which is what stops this
    // being the F1 runaway rather than a single wasted hop. Change how resolve()
    // treats a pre-commit tab and this count is the assertion that goes red.
    const secondThrowawayTab = theTabOtherThan(browser, sourceTab.id);
    const settled = await browser.navigates(
      aNavigationTo({ requestId: "3", tabId: secondThrowawayTab.id }),
    );
    expect(settled).toBeUndefined();
    expect(browser.openedTabs).toHaveLength(2);

    // tmp1 was abandoned mid-flight, so the disposer has to be what cleans it up.
    await advance(GRACE_MS);
    expect([...browser.containers.values()].map((c) => c.name)).toEqual(["tmp2"]);
  });

  // The restart here is the one users actually cause: a config save calls
  // runtime.reload(). Before the grace was written down, that reload lost every pending
  // one AND ran a startup sweep that reclaimed empty containers at grace 0 — so hitting
  // Save destroyed whichever throwaways happened to be mid-grace, which is F10's
  // "disposed too early" arriving by the most ordinary route there is. The remaining
  // grace is what has to survive; both halves are asserted, because a disposer that
  // simply never removed anything would also pass the first one.
  it("resumes the remaining grace of a throwaway emptied before the restart", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, workConfig());

    await browser.navigates(aNavigationTo({ tabId: sourceTab.id }));
    const throwaway = [...browser.containers.values()].find((c) => c.name === "tmp1")!;
    const onlyTabInTheThrowaway = theTabOtherThan(browser, sourceTab.id);

    // The last tab closes: the grace starts, and the cookies are meant to outlive it by
    // five minutes so an undo-close lands back in the same session.
    await browser.closesTab(onlyTabInTheThrowaway);
    await advance(1000); // one second in — nowhere near GRACE_MS
    expect(browser.removedContainers).toEqual([]);

    // A suspend/wake cycle. Nothing the user did, and nothing they can see.
    session = await restartTheBackground(session, browser, clock, workConfig());
    await advance(0);
    expect(browser.removedContainers).toEqual([]); // the grace is NOT restarted from zero

    // Still nothing at one tick short of the ORIGINAL deadline — the second the tab
    // closed, not the second the background came back.
    await advance(GRACE_MS - 1000 - 1);
    expect(browser.removedContainers).toEqual([]);
    await advance(1);
    expect(browser.removedContainers).toEqual([throwaway.cookieStoreId]);
  });

  it("drops a redirector close it had already scheduled", async () => {
    const { browser, clock, advance } = aBrowserWithFakeClock();
    const redirectorConfig = parseConfig("rules:\n  - match: t.co\n    redirector: true\n");
    const shimTab = browser.existingTab({ url: "https://t.co/abc", cookieStoreId: "firefox-default" });
    let session = await startTheBackground(browser, clock, redirectorConfig);

    await browser.updatesTab(shimTab, { status: "complete" }); // close scheduled for later
    session = await restartTheBackground(session, browser, clock, redirectorConfig);
    await advance(REDIRECTOR_DELAY_MS * 2);

    // A pending setTimeout dies with the background page that scheduled it, so a
    // stranded shim tab survives a config save. Correct, and worth pinning: it is
    // also what proves the harness retires a dead session's timers — without that
    // the suite would report state surviving a restart that never happened.
    expect(browser.closedTabIds).toEqual([]);
  });

  it("warns about a declined form submission again — the rules may have just changed", async () => {
    const { browser, clock } = aBrowserWithFakeClock();
    const sourceTab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    const submitsAForm = (requestId: string) =>
      browser.navigates(aNavigationTo({ requestId, tabId: sourceTab.id, url: "https://work.example/sso", method: "POST" }));
    let session = await startTheBackground(browser, clock, workConfig());

    await submitsAForm("1");
    await browser.settle();
    expect(browser.notifications).toHaveLength(1);

    await submitsAForm("2"); // same host, same session: already said
    await browser.settle();
    expect(browser.notifications).toHaveLength(1);

    session = await restartTheBackground(session, browser, clock, workConfig());

    await submitsAForm("3");
    await browser.settle();
    // warnedHosts clearing is wanted, not incidental: a restart means a config save,
    // so the rule that went unapplied may not be the one the user was told about.
    expect(browser.notifications).toHaveLength(2);
  });
});

describe("restart — a paused container", () => {
  it("keeps the container paused, and its recording, across a background restart", async () => {
    const browser = aFakeBrowser();
    const clock = aFakeClock();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    let session = await startTheBackground(browser, clock.clock, workConfig());
    await session.pause.arm(shop.cookieStoreId);
    session.pause.record(shop.cookieStoreId, "https://payment.acme.test/", { kind: "reopen", into: { kind: "temporary" } });
    await browser.settle();

    // Every config save calls runtime.reload(), so this is the ordinary path — and
    // reviewing a recording is what leads to a save.
    session = await restartTheBackground(session, browser, clock.clock, workConfig());

    expect(session.pause.isPaused(shop.cookieStoreId)).toBe(true);
    expect(session.pause.snapshot().recordings[0].hosts.map((h) => h.host)).toEqual(["payment.acme.test"]);

    // The dedupe set is rebuilt from the stored recording, so a host the PREVIOUS
    // session already recorded must not come back as a second row.
    session.pause.record(shop.cookieStoreId, "https://payment.acme.test/again", { kind: "reopen", into: { kind: "temporary" } });
    expect(session.pause.snapshot().recordings[0].hosts).toHaveLength(1);
  });

  it("still seeds cookies in a paused container — an overlay never decides a container", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const tab = browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const config: Config = {
      rules: [
        {
          match: [hostMatcher("payment.acme.test")],
          action: { kind: "open", containers: ["Work"] },
          cookies: [{ name: "consent", url: "https://payment.acme.test/", value: "1" }],
        },
      ],
      groups: [],
    };
    const session = await startTheBackground(browser, aFakeClock().clock, config);
    await session.pause.arm(shop.cookieStoreId);

    await browser.sendsHeaders({
      requestId: "1",
      tabId: tab.id,
      url: "https://payment.acme.test/",
      type: "main_frame",
      requestHeaders: [],
    });
    await browser.settle();

    // The pause suspends ROUTING, not the within-container conveniences: an overlay acts
    // inside whatever container the tab is already in and never moves identity across
    // one, so a paused checkout should still get its consent banner pre-dismissed.
    expect(browser.seededCookies.map((c) => c.name)).toContain("consent");
  });
});

// The other half of what a restart has to retire. Timers are the obvious one — the
// disposer's re-arming sweep would otherwise keep running through a closure holding a
// live port — but listeners are the same problem: `mock-port` is additive, exactly as
// Firefox is, so wiring a second background ADDS handlers rather than replacing them.
// Firefox retires the old ones by destroying the context they live in; `aSessionPort`
// models that by gating them.
describe("restart — the dead session stops hearing the browser", () => {
  it("hands a message to the background that is running, not the one that was", async () => {
    const { browser, clock } = aBrowserWithFakeClock();
    const shop = browser.addContainerNamed({ name: "Shop" });
    browser.existingTab({ url: "https://shop.example/", cookieStoreId: shop.cookieStoreId });

    const first = await startTheBackground(browser, clock, workConfig());
    const second = await restartTheBackground(first, browser, clock, workConfig());

    await browser.receivesMessage({ type: "cc-pause-toggle", cookieStoreId: shop.cookieStoreId });

    // Answered by the live session — its armed set is the one the blocking handler will
    // consult. An ungated dead listener would claim the reply channel first (it registered
    // first) and arm a set nothing reads any more: the options page would report routing
    // paused while every navigation carried on being routed.
    expect(second.pause.isPaused(shop.cookieStoreId)).toBe(true);
    expect(first.pause.isPaused(shop.cookieStoreId)).toBe(false);
  });
});
