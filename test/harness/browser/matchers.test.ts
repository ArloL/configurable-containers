import { describe, it, expect } from "vitest";
import { Locator } from "../../../harness/browser/locator";
import type { PageContext } from "../../../harness/browser/types";
import { fakeDriver, anElement, type FakeScript } from "./fake-driver";
import "../../../harness/browser/matchers";

function locatorOn(script: FakeScript) {
  const { driver } = fakeDriver(script);
  const page: PageContext = {
    driver,
    handle: "w1",
    defaultTimeout: 500,
    async switchHere() {},
    async diagnose() {
      return "ids=[cc-status]";
    },
  };
  return new Locator(page, "#cc-status", 0);
}

const saying = (text: (n: number) => string) =>
  locatorOn({ elements: (n) => [anElement({ getText: async () => text(n) })] });

describe("retrying matchers", () => {
  it("waits for the text to arrive", async () => {
    await expect(saying((n) => (n < 3 ? "Saving…" : "Saved"))).toHaveText("Saved", { timeout: 500 });
  });

  // Exact, as Playwright's toHaveText is — this suite has a "Saved — a script could not be
  // registered: …" that must not satisfy a wait for "Saved".
  it("does not accept a longer message as the text", async () => {
    await expect(
      expect(saying(() => "Saved — a script could not be registered: x")).toHaveText("Saved", {
        timeout: 0,
      }),
    ).rejects.toThrow(/toHaveText/);
  });

  it("accepts the substring form when that is what was asked", async () => {
    await expect(saying(() => "Saved — a script could not be registered: x")).toContainText("Saved", {
      timeout: 0,
    });
  });

  it("matches a regular expression", async () => {
    await expect(saying(() => "Synced via Firefox Sync (1 part)")).toHaveText(/Synced via/, {
      timeout: 0,
    });
  });

  it("waits for a value, a count, visibility and enabledness", async () => {
    await expect(
      locatorOn({ elements: () => [anElement({ getProperty: async () => "rules:\n" })] }),
    ).toHaveValue("rules:\n", { timeout: 0 });
    await expect(locatorOn({ elements: () => [anElement(), anElement()] })).toHaveCount(2, {
      timeout: 0,
    });
    await expect(locatorOn({ elements: () => [anElement()] })).toBeVisible({ timeout: 0 });
    await expect(locatorOn({ elements: () => [anElement()] })).toBeEnabled({ timeout: 0 });
  });

  // "expected Saved, got Saving…" is the whole diagnosis; a matcher that only says it
  // timed out has thrown the useful half away.
  it("reports what it last saw when it gives up", async () => {
    await expect(expect(saying(() => "Saving…")).toHaveText("Saved", { timeout: 0 })).rejects.toThrow(
      /Saving…/,
    );
  });
});
