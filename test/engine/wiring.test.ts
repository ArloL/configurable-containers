import { describe, it, expect } from "vitest";
import { aFakeBrowser } from "./mock-port";
import { startTheBackground } from "./restart";
import { parseConfig } from "../../src/config/parse";
import type { Clock } from "../../src/engine/port";

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
