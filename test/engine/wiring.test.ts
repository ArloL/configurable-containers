import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { startTheBackground } from "./restart";
import { parseConfig } from "../../src/config/parse";
import type { Clock } from "../../src/engine/port";
import type { PauseStatusResponse, PauseToggleResponse } from "../../src/extension/pause-protocol";

const config = parseConfig(`
rules:
  - match: figma.example
    open: [Personal, Work]
`);

function aFakeClock(): Clock {
  return { setTimeout: () => {}, now: () => 0 };
}

// The wiring owns the single runtime.onMessage registration. Each sibling exposes a
// handler instead of registering its own, so what has to be pinned here is that the
// dispatch still reaches them — a sibling whose branch is missing looks exactly like a
// sibling that declined the message.
describe("wiring — message dispatch", () => {
  it("routes cc-pick to the picker", async () => {
    const browser = aFakeBrowser();
    const choiceTab = browser.existingTab({ url: "moz-extension://test/choice.html#x", cookieStoreId: "firefox-default" });
    await startTheBackground(browser, aFakeClock(), config);

    const reply = await browser.receivesMessage(
      { type: "cc-pick", url: "https://figma.example/", container: "Work" },
      choiceTab,
    );

    expect(reply).toEqual({ ok: true });
  });

  it("leaves a message no sibling owns unanswered", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), config);

    expect(await browser.receivesMessage({ type: "cc-nobody-owns-this" })).toBeUndefined();
  });
});

describe("wiring — the choice screen", () => {
  it("opens the choice page for a navigation the engine cannot answer alone", async () => {
    const browser = aFakeBrowser();
    browser.addContainerNamed({ name: "Personal" });
    browser.addContainerNamed({ name: "Work" });
    const tab = browser.existingTab({ url: "https://start.test/", cookieStoreId: "firefox-default" });
    await startTheBackground(browser, aFakeClock(), config);

    const blockingResponse = await browser.navigates({
      requestId: "1",
      tabId: tab.id,
      url: "https://figma.example/f",
      type: "main_frame",
      method: "GET",
    });
    await browser.settle();

    // The engine hands the options to a callback and does not wait for it — the navigation
    // is cancelled either way. Wiring that callback to a picker that is constructed AFTER
    // the engine is what makes the two reachable from each other, and a callback that
    // floats nothing leaves the user on a cancelled navigation with no page.
    expect(blockingResponse).toEqual({ cancel: true });
    expect(browser.openedTabs.at(-1)!.url).toContain("choice.html#");
  });
});

describe("wiring — the options page's pause conversation", () => {
  it("lists only containers that have tabs, annotated so a tmp name is identifiable", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    browser.addContainerNamed({ name: "tmp8" }); // no tabs — you cannot arm a flow you are not in
    browser.existingTab({ url: "https://shop.test/cart", cookieStoreId: shop.cookieStoreId });
    await startTheBackground(browser, aFakeClock(), config);

    const status = (await browser.receivesMessage({ type: "cc-pause-status" })) as PauseStatusResponse;

    expect(status.containers.map((c) => c.name)).toEqual(["tmp3"]);
    // "tmp3" alone says nothing about which flow it holds; the host is what identifies it.
    expect(status.containers[0]).toMatchObject({ tabCount: 1, hosts: ["shop.test"], armed: false, armable: true });
  });

  it("marks the default container unarmable, with the reason to show inline", async () => {
    const browser = aFakeBrowser();
    browser.existingTab({ url: "https://shop.test/", cookieStoreId: "firefox-default" });
    await startTheBackground(browser, aFakeClock(), config);

    const status = (await browser.receivesMessage({ type: "cc-pause-status" })) as PauseStatusResponse;
    const row = status.containers.find((c) => c.cookieStoreId === "firefox-default")!;

    expect(row.armable).toBe(false);
    expect(row.reason).toBeTruthy();
  });

  it("toggles a container the message names, after validating it", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    browser.existingTab({ url: "https://shop.test/", cookieStoreId: shop.cookieStoreId });
    const session = await startTheBackground(browser, aFakeClock(), config);

    await browser.receivesMessage({ type: "cc-pause-toggle", cookieStoreId: shop.cookieStoreId });
    expect(session.pause.isPaused(shop.cookieStoreId)).toBe(true);

    await browser.receivesMessage({ type: "cc-pause-toggle", cookieStoreId: shop.cookieStoreId });
    expect(session.pause.isPaused(shop.cookieStoreId)).toBe(false);
  });

  it("refuses a cookieStoreId that is not a real container", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), config);

    // This is the ONE message in CC that names a container instead of deriving it from
    // the sender, so the background validates the payload rather than trusting it.
    const reply = (await browser.receivesMessage({
      type: "cc-pause-toggle",
      cookieStoreId: "firefox-container-99",
    })) as PauseToggleResponse;

    expect(reply.ok).toBe(false);
  });

  it("refuses the default container even when the message asks directly", async () => {
    const browser = aFakeBrowser();
    const session = await startTheBackground(browser, aFakeClock(), config);

    const reply = (await browser.receivesMessage({
      type: "cc-pause-toggle",
      cookieStoreId: "firefox-default",
    })) as PauseToggleResponse;

    expect(reply.ok).toBe(false);
    expect(session.pause.isPaused("firefox-default")).toBe(false);
  });

  it("clears the recordings, disarming whatever was still running", async () => {
    const browser = aFakeBrowser();
    const shop = browser.addContainerNamed({ name: "tmp3" });
    const session = await startTheBackground(browser, aFakeClock(), config);
    await session.pause.arm(shop.cookieStoreId);

    await browser.receivesMessage({ type: "cc-pause-clear" });

    expect(session.pause.snapshot().recordings).toEqual([]);
    expect(session.pause.isPaused(shop.cookieStoreId)).toBe(false);
  });
});

// Two events have TWO listeners each in the composed background — `onTabRemoved` (pause,
// then the disposer) and `onTabUpdated` (auto-temp, then the redirector-closer). Firefox
// runs both; `mock-port` did not, until it was made additive. Neither behaviour below
// had a case at this level while the mock held one handler slot per event: each sibling's
// own tests build it on a port of its own, where nothing else is registered, so both
// passed while the wired-up extension was the thing that could not be observed.
describe("wiring — siblings that share a browser event", () => {
  it("disarms a container whose last tab closes, with the disposer listening on the same event", async () => {
    const browser = aFakeBrowser();
    const work = browser.addContainerNamed({ name: "Work" });
    const tab = await browser.opensTab({ url: "https://figma.example/", cookieStoreId: work.cookieStoreId });
    const background = await startTheBackground(browser, aFakeClock(), config);

    expect((await background.pause.arm(work.cookieStoreId)).ok).toBe(true);
    expect(background.pause.isPaused(work.cookieStoreId)).toBe(true);

    await browser.closesTab(tab);
    await browser.settle();

    // An armed container the user can no longer see is an armed container they will
    // forget about — and a forgotten one is routing silently off for as long as it
    // lives. Pause disarms on empty for that reason; the disposer registering after it
    // is what used to make this unobservable here.
    expect(background.pause.isPaused(work.cookieStoreId)).toBe(false);
  });

  it("containerizes a new tab that only reveals about:newtab on update, with the redirector-closer listening on the same event", async () => {
    const browser = aFakeBrowser();
    await startTheBackground(browser, aFakeClock(), config);

    // Firefox bug 1586612: tabs.onCreated sometimes fires with "about:blank" before the
    // real url arrives on tabs.onUpdated. Auto-temp listens on both events for exactly
    // this, and an onCreated-only draft passed L3 and failed in real Firefox — which is
    // the state L3 was quietly back in while the redirector-closer's registration was
    // displacing auto-temp's.
    const tab = await browser.opensTab({ url: "about:blank", cookieStoreId: "firefox-default" });
    expect(browser.createdContainers).toHaveLength(0); // about:blank is not a candidate

    await browser.updatesTab({ ...tab, url: "about:newtab" }, { status: "complete" });
    await browser.settle();

    expect(browser.createdContainers).toHaveLength(1);
    expect(browser.createdContainers[0]!.name).toBe("tmp1");
  });
});
