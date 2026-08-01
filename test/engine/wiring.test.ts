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
