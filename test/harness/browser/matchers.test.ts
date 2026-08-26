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

// The same, for the matchers that read a VALUE rather than text.
const valueSaying = (value: (n: number) => string) =>
  locatorOn({ elements: (n) => [anElement({ getProperty: async () => value(n) })] });

describe("retrying matchers", () => {
  it("waits for the text to arrive", async () => {
    await expect(saying((n) => (n < 3 ? "Saving…" : "Saved"))).toHaveText("Saved", { timeout: 5_000 });
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

  // A textarea's content is its value, not its text: toContainText reads innerText and
  // sees "" there, which is how the migration found this.
  it("matches a value by regular expression", async () => {
    await expect(
      locatorOn({ elements: () => [anElement({ getProperty: async () => "version: 2\nrules:\n" })] }),
    ).toHaveValue(/version: 2/, { timeout: 0 });
  });

  it("waits for an attribute to take a value", async () => {
    let polls = 0;
    const locator = locatorOn({
      elements: () => {
        polls++;
        return [anElement({ getDomAttribute: async () => (polls < 3 ? "false" : "true") })];
      },
    });
    await expect(locator).toHaveAttribute("data-cc-armed", "true", { timeout: 5_000 });
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

  // `.not` decides what is being waited FOR, not just how the verdict is read. Vitest
  // inverts `pass` and nothing else, so a matcher that always polled until its condition
  // held meant the opposite of itself under negation. Both halves are measured below,
  // because both were real: test/e2e/options.test.ts guarded the editor's async fill with
  // `not.toHaveValue("")` and got a hard failure on the very race it was waiting out, and
  // paid the full timeout on every run where it did not fire.
  it("waits for a negated condition to stop holding, rather than for it to hold", async () => {
    // Empty for the first two reads — the pre-hydration window — then filled.
    await expect(valueSaying((n) => (n < 3 ? "" : "rules:\n"))).not.toHaveValue("", {
      timeout: 5_000,
    });
  });

  it("fails a negated assertion whose condition never stops holding, saying what it saw", async () => {
    await expect(
      expect(saying(() => "")).not.toHaveText("", { timeout: 0 }),
    ).rejects.toThrow(/last saw ""/);
  });

  // It must also RETURN as soon as the condition stops holding. The inverted version passed
  // this case too — after burning its entire budget, which is 10s a time in the e2e suite.
  // Counted in READS rather than milliseconds: wall clock in CI is a flake generator, and
  // one read is the exact claim ("it did not poll again").
  it("does not go on reading once a negated assertion is satisfied", async () => {
    let reads = 0;
    const locator = locatorOn({
      elements: () => {
        reads++;
        return [anElement({ getText: async () => "Saved" })];
      },
    });
    await expect(locator).not.toHaveText("", { timeout: 5_000 });
    expect(reads).toBe(1);
  });

  // The reader is given a zero budget because the waiting is the MATCHER's job, so it gives
  // up the instant the element is not resolvable. Reading that as a verdict means a matcher
  // that waits for an element's text but not for the element — and a page reached by url is
  // routinely there before its document is. It cost a red run in CI on #cc-sync.
  it("waits for the element itself, not only for what it says", async () => {
    const locator = locatorOn({
      elements: (n) => (n < 3 ? [] : [anElement({ getText: async () => "Saved" })]),
    });
    await expect(locator).toHaveText("Saved", { timeout: 5_000 });
  });

  // …and an element that never turns up is a failure in BOTH directions. Reporting it as
  // "the condition did not hold" would make `.not` pass for a page that rendered nothing.
  it("fails an element that never appears, negated or not", async () => {
    const missing = () => locatorOn({ elements: () => [] });
    await expect(expect(missing()).toHaveText("Saved", { timeout: 0 })).rejects.toThrow(
      /no element matched/,
    );
    await expect(expect(missing()).not.toHaveText("", { timeout: 0 })).rejects.toThrow(
      /no element matched/,
    );
  });

  // That promise was one matcher short of true. `toBeEnabled` read through `isEnabled()`,
  // which answers `false` for an element that is not there — so "disabled" and "never
  // rendered" arrived as the same reading, the "no element matched" branch was dead code
  // for this matcher, and `.not.toBeEnabled()` passed on an empty document. One live call
  // site (test/e2e/options.test.ts, asserting Save goes disabled on an invalid config),
  // safe only because the line above it waits on #cc-error first.
  it("fails a negated toBeEnabled on an element that never appears", async () => {
    await expect(
      expect(locatorOn({ elements: () => [] })).not.toBeEnabled({ timeout: 0 }),
    ).rejects.toThrow(/no element matched/);
  });

  it("still waits for an element that arrives late before calling it enabled", async () => {
    const locator = locatorOn({
      elements: (n) => (n < 3 ? [] : [anElement({ isEnabled: async () => true })]),
    });
    await expect(locator).toBeEnabled({ timeout: 5_000 });
  });

  it("still passes a negated toBeEnabled on an element that IS there and disabled", async () => {
    await expect(
      locatorOn({ elements: () => [anElement({ isEnabled: async () => false })] }),
    ).not.toBeEnabled({ timeout: 0 });
  });

  // The other two boolean-ish readers stay as they are, and that is a decision rather than
  // an oversight: Playwright's `isVisible()` does not wait either, and `toHaveCount(0)` is
  // the ordinary way to assert a list is empty. Reading a missing element as an ANSWER is
  // what both callers are asking for; `toBeEnabled` was the only one where it was an
  // accident of how the reading was taken.
  it("lets toBeVisible and toHaveCount read a missing element as an answer, as Playwright does", async () => {
    await expect(locatorOn({ elements: () => [] })).not.toBeVisible({ timeout: 0 });
    await expect(locatorOn({ elements: () => [] })).toHaveCount(0, { timeout: 0 });
  });

  // "expected Saved, got Saving…" is the whole diagnosis; a matcher that only says it
  // timed out has thrown the useful half away.
  it("reports what it last saw when it gives up", async () => {
    await expect(expect(saying(() => "Saving…")).toHaveText("Saved", { timeout: 0 })).rejects.toThrow(
      /Saving…/,
    );
  });
});
