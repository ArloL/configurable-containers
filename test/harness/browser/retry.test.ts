import { describe, it, expect } from "vitest";
import { error as seleniumError } from "selenium-webdriver";
import { RETRY, poll, isRetryable, type PollOpts } from "../../../harness/browser/retry";

const opts = (over: Partial<PollOpts> = {}): PollOpts => ({
  timeout: 1000,
  interval: 0,
  what: "click #cc-save",
  diagnose: async () => "url=moz-extension://cc/options.html ids=[cc-config]",
  ...over,
});

describe("poll", () => {
  it("returns the first answer that is not RETRY", async () => {
    let calls = 0;
    const answer = await poll(opts(), async () => (++calls < 3 ? RETRY : "done"));
    expect(answer).toBe("done");
    expect(calls).toBe(3);
  });

  // Every "not yet" Selenium has a word for: the tab is mid-teardown, the document has
  // not parsed, the element was replaced, the click landed on an overlay.
  it.each([
    ["NoSuchWindowError", new seleniumError.NoSuchWindowError("gone")],
    ["NoSuchElementError", new seleniumError.NoSuchElementError("absent")],
    ["StaleElementReferenceError", new seleniumError.StaleElementReferenceError("stale")],
    ["ElementNotInteractableError", new seleniumError.ElementNotInteractableError("busy")],
    ["ElementClickInterceptedError", new seleniumError.ElementClickInterceptedError("covered")],
  ])("polls through %s", async (_name, thrown) => {
    let calls = 0;
    const answer = await poll(opts(), async () => {
      if (++calls < 2) throw thrown;
      return "done";
    });
    expect(answer).toBe("done");
  });

  // A broken browser is not something to wait out: swallowing this would turn it into a
  // ten-second timeout and hide what actually happened.
  it("propagates anything else at once", async () => {
    let calls = 0;
    await expect(
      poll(opts(), async () => {
        calls++;
        throw new Error("geckodriver died");
      }),
    ).rejects.toThrow(/geckodriver died/);
    expect(calls).toBe(1);
  });

  it("returns a void answer rather than polling forever", async () => {
    await expect(poll(opts(), async () => undefined)).resolves.toBeUndefined();
  });

  it("says what it was doing, where, and for how long", async () => {
    await expect(poll(opts({ timeout: 0 }), async () => RETRY)).rejects.toThrow(
      /click #cc-save.*timed out.*ids=\[cc-config\]/s,
    );
  });

  it("tries once even with no time left", async () => {
    let calls = 0;
    await poll(opts({ timeout: 0 }), async () => {
      calls++;
      return "done";
    });
    expect(calls).toBe(1);
  });
});

describe("isRetryable", () => {
  it("is false for an ordinary error", () => {
    expect(isRetryable(new Error("nope"))).toBe(false);
  });

  it("is true for a stale element", () => {
    expect(isRetryable(new seleniumError.StaleElementReferenceError("stale"))).toBe(true);
  });
});
