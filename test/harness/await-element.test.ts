import { describe, it, expect } from "vitest";
import type { WebDriver } from "selenium-webdriver";
import { awaitElement } from "../../harness/firefox";

// `switchToUrl` returns on the tab's COMMITTED url, which precedes its document — so a read
// landing in that window finds no element at all. `findElement` answers that with a throw,
// which escapes a loop written to poll for text and fails the case outright (CI, 2026-08-25:
// `NoSuchElementError: Unable to locate element: *[id="cc-sync"]`, on the latest leg only,
// with ESR and every local run green). This is the wait that closes the window, so it is
// tested where a real browser's timing cannot be arranged: against a driver that answers
// "not yet" a fixed number of times.
function driverAnsweringAfter(polls: number) {
  let seen = 0;
  return {
    async findElements() {
      seen++;
      return seen >= polls ? ["the element"] : [];
    },
    async getCurrentUrl() {
      return "moz-extension://cc/options.html";
    },
    async sleep() {},
    get polls() {
      return seen;
    },
  };
}

describe("awaitElement", () => {
  it("polls until the document has the element", async () => {
    const driver = driverAnsweringAfter(3);
    expect(await awaitElement(driver as unknown as WebDriver, "cc-sync")).toBe("the element");
    expect(driver.polls).toBe(3);
  });

  it("returns the first answer when the document is already there", async () => {
    const driver = driverAnsweringAfter(1);
    await awaitElement(driver as unknown as WebDriver, "cc-sync");
    expect(driver.polls).toBe(1);
  });

  // Naming the element and the page it was not on: the failure this replaces named a CSS
  // selector and left which page it was looking at to be inferred.
  it("says what it waited for, and where, when it never arrives", async () => {
    const driver = driverAnsweringAfter(Number.MAX_SAFE_INTEGER);
    await expect(awaitElement(driver as unknown as WebDriver, "cc-sync", 0)).rejects.toThrow(
      /cc-sync.*options\.html/,
    );
  });
});
