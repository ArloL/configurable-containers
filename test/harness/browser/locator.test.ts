import { describe, it, expect } from "vitest";
import { error as seleniumError } from "selenium-webdriver";
import { Locator } from "../../../harness/browser/locator";
import type { PageContext } from "../../../harness/browser/types";
import { fakeDriver, anElement, type FakeScript } from "./fake-driver";

function locatorOn(script: FakeScript) {
  const { driver, calls } = fakeDriver(script);
  const page: PageContext = {
    driver,
    handle: "w1",
    defaultTimeout: 500,
    async switchHere() {
      calls.push("switchHere");
    },
    async diagnose() {
      return "url=moz-extension://cc/options.html ids=[cc-config]";
    },
  };
  return { locator: new Locator(page, "#cc-save", 0), calls };
}

describe("Locator", () => {
  it("pins its own tab before every resolve", async () => {
    const { locator, calls } = locatorOn({
      elements: () => [anElement({ getText: async () => "Save" })],
    });
    await locator.innerText();
    expect(calls.slice(0, 2)).toEqual(["switchHere", "findElements#1"]);
  });

  // The element is re-resolved per attempt, so a tab CC tore down and reopened is found
  // again rather than answered as a dead handle.
  it("polls until the document has the element", async () => {
    const { locator } = locatorOn({
      elements: (n) => (n < 3 ? [] : [anElement({ getText: async () => "Save" })]),
    });
    expect(await locator.innerText()).toBe("Save");
  });

  it("re-resolves after a stale element rather than reusing it", async () => {
    let handed = 0;
    const { locator } = locatorOn({
      elements: () => {
        handed++;
        return [
          anElement({
            getText: async () => {
              if (handed < 2) throw new seleniumError.StaleElementReferenceError("stale");
              return "Save";
            },
          }),
        ];
      },
    });
    expect(await locator.innerText()).toBe("Save");
    expect(handed).toBe(2);
  });

  it("waits for enabled before clicking", async () => {
    let clicked = false;
    const { locator } = locatorOn({
      elements: (n) => [
        anElement({
          isEnabled: async () => n >= 3,
          click: async () => {
            clicked = true;
          },
        }),
      ],
    });
    await locator.click();
    expect(clicked).toBe(true);
  });

  // Playwright's definition of visible: a non-empty box, and not visibility:hidden.
  it("waits for a real box before clicking", async () => {
    const { locator } = locatorOn({
      elements: (n) => [
        anElement({
          getRect: async () => ({ width: n < 2 ? 0 : 40, height: 20, x: 0, y: 0 }),
          click: async () => {},
        }),
      ],
    });
    await expect(locator.click()).resolves.toBeUndefined();
  });

  it("does not click something visibility:hidden", async () => {
    const { locator } = locatorOn({ elements: () => [anElement({ getCssValue: async () => "hidden" })] });
    await expect(locator.click()).rejects.toThrow(/click #cc-save timed out/);
  });

  it("fills by clearing and typing, which is what fires the page's input handler", async () => {
    const typed: string[] = [];
    const { locator } = locatorOn({
      elements: () => [
        anElement({
          clear: async () => {
            typed.push("<clear>");
          },
          sendKeys: async (...keys) => {
            typed.push(...keys);
          },
          getDomAttribute: async () => null,
        }),
      ],
    });
    await locator.fill("rules:\n");
    expect(typed).toEqual(["<clear>", "rules:\n"]);
  });

  it("does not fill a readonly field", async () => {
    const { locator } = locatorOn({
      elements: () => [anElement({ getDomAttribute: async (n) => (n === "readonly" ? "" : null) })],
    });
    await expect(locator.fill("x")).rejects.toThrow(/fill #cc-save timed out/);
  });

  // Matching Playwright, where press requires no actionability at all.
  it("presses without waiting for visible or enabled", async () => {
    const sent: string[] = [];
    const { locator } = locatorOn({
      elements: () => [
        anElement({
          getRect: async () => ({ width: 0, height: 0, x: 0, y: 0 }),
          isEnabled: async () => false,
          sendKeys: async (...keys) => {
            sent.push(...keys);
          },
        }),
      ],
    });
    await locator.press("Enter");
    expect(sent).toEqual(["Enter"]);
  });

  it("reads a dom attribute and an input value", async () => {
    const { locator } = locatorOn({
      elements: () => [
        anElement({
          getDomAttribute: async () => "Work",
          getProperty: async (name) => (name === "value" ? "rules:\n" : undefined),
        }),
      ],
    });
    expect(await locator.getAttribute("data-container")).toBe("Work");
    expect(await locator.inputValue()).toBe("rules:\n");
  });

  it("counts without waiting", async () => {
    const { locator } = locatorOn({ elements: () => [] });
    expect(await locator.count()).toBe(0);
  });

  it("answers isVisible false for an element that is not there, rather than waiting", async () => {
    const { locator } = locatorOn({ elements: () => [] });
    expect(await locator.isVisible()).toBe(false);
  });

  it.each([
    ["attached", (n: number) => (n < 2 ? [] : [anElement()])],
    ["detached", (n: number) => (n < 2 ? [anElement()] : [])],
    ["visible", (n: number) => (n < 2 ? [] : [anElement()])],
    ["hidden", (n: number) => (n < 2 ? [anElement()] : [])],
  ])("waits for state %s", async (state, elements) => {
    const { locator } = locatorOn({ elements });
    await expect(
      locator.waitFor({ state: state as "attached" | "detached" | "visible" | "hidden" }),
    ).resolves.toBeUndefined();
  });

  it("narrows to the nth match, and hands out one locator per match", async () => {
    const { locator } = locatorOn({
      elements: () => [
        anElement({ getText: async () => "Personal" }),
        anElement({ getText: async () => "Work" }),
      ],
    });
    expect(await locator.nth(1).innerText()).toBe("Work");
    expect(await Promise.all((await locator.all()).map((l) => l.innerText()))).toEqual([
      "Personal",
      "Work",
    ]);
  });

  it("names the selector and the page when it gives up", async () => {
    const { locator } = locatorOn({ elements: () => [] });
    await expect(locator.innerText()).rejects.toThrow(/innerText #cc-save.*ids=\[cc-config\]/s);
  });
});
