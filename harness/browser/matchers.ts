// Playwright's web-first assertions, in vitest's idiom: the comparison retries, so a page
// that has not finished rendering is a wait rather than a failure. Its own docs steer text
// comparisons here rather than to `expect(await locator.innerText())`, precisely because
// the read-then-compare form flakes. Imported for effect by the files that use them.
import { expect } from "vitest";
import type { Locator } from "./locator";
import { ASSERTION_TIMEOUT_MS, RETRY, poll } from "./retry";
import type { WaitOpts } from "./types";

interface Verdict {
  pass: boolean;
  message: () => string;
}

// One shape for every matcher: poll the reading until the comparison holds, and report the
// LAST reading when it never does — "expected Saved, last saw Saving…" is the whole
// diagnosis, and a matcher that only says it timed out has thrown it away.
async function settle<T>(
  locator: Locator,
  name: string,
  opts: WaitOpts | undefined,
  read: () => Promise<T>,
  holds: (seen: T) => boolean,
  describe: (seen: T) => string,
): Promise<Verdict> {
  let last: T | undefined;
  try {
    await poll(
      {
        timeout: opts?.timeout ?? ASSERTION_TIMEOUT_MS,
        what: `${name} ${locator.selector}`,
        diagnose: async () => "",
      },
      async () => {
        last = await read();
        return holds(last) ? undefined : RETRY;
      },
    );
    return { pass: true, message: () => `${name} ${locator.selector} held` };
  } catch {
    return { pass: false, message: () => `${name} ${locator.selector}: ${describe(last as T)}` };
  }
}

const trimmed = (s: string) => s.trim();

expect.extend({
  async toHaveText(locator: Locator, expected: string | RegExp, opts?: WaitOpts) {
    return settle(
      locator,
      "toHaveText",
      opts,
      () => locator.innerText({ timeout: 0 }),
      (seen) =>
        expected instanceof RegExp ? expected.test(seen) : trimmed(seen) === trimmed(expected),
      (seen) => `expected ${String(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toContainText(locator: Locator, expected: string, opts?: WaitOpts) {
    return settle(
      locator,
      "toContainText",
      opts,
      () => locator.innerText({ timeout: 0 }),
      (seen) => seen.includes(expected),
      (seen) => `expected to contain ${JSON.stringify(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toHaveValue(locator: Locator, expected: string, opts?: WaitOpts) {
    return settle(
      locator,
      "toHaveValue",
      opts,
      () => locator.inputValue({ timeout: 0 }),
      (seen) => seen === expected,
      (seen) => `expected ${JSON.stringify(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toHaveCount(locator: Locator, expected: number, opts?: WaitOpts) {
    return settle(
      locator,
      "toHaveCount",
      opts,
      () => locator.count(),
      (seen) => seen === expected,
      (seen) => `expected ${expected}, last saw ${seen}`,
    );
  },

  async toBeVisible(locator: Locator, opts?: WaitOpts) {
    return settle(
      locator,
      "toBeVisible",
      opts,
      () => locator.isVisible(),
      (seen) => seen,
      () => "never became visible",
    );
  },

  async toBeEnabled(locator: Locator, opts?: WaitOpts) {
    return settle(
      locator,
      "toBeEnabled",
      opts,
      () => locator.isEnabled(),
      (seen) => seen,
      () => "never became enabled",
    );
  },
});

// The parameter list must match @vitest/expect's own `interface Matchers<T = any>`
// exactly, or TS refuses the merge (TS2428) even though the matchers work.
declare module "vitest" {
  // oxlint-disable-next-line typescript/no-explicit-any -- see above
  interface Matchers<T = any> {
    toHaveText(expected: string | RegExp, opts?: WaitOpts): Promise<T>;
    toContainText(expected: string, opts?: WaitOpts): Promise<T>;
    toHaveValue(expected: string, opts?: WaitOpts): Promise<T>;
    toHaveCount(expected: number, opts?: WaitOpts): Promise<T>;
    toBeVisible(opts?: WaitOpts): Promise<T>;
    toBeEnabled(opts?: WaitOpts): Promise<T>;
  }
}
