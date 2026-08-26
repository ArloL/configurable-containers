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

// What vitest hands a matcher as `this`. Only `isNot` matters here, and it is the whole
// reason this file cannot use arrow functions for its matchers.
interface MatcherContext {
  isNot?: boolean;
}

// One shape for every matcher: poll the reading until the comparison settles the way the
// CALLER asked, and report the LAST reading when it never does — "expected Saved, last saw
// Saving…" is the whole diagnosis, and a matcher that only says it timed out has thrown it
// away.
//
// `isNot` is not a detail of the verdict: it decides what is being waited FOR. Vitest
// inverts a matcher's `pass` for `.not` and nothing else, so a matcher that always polls
// until `holds` is true means the opposite of itself under negation — `.not.toHaveValue("")`
// polls until the field IS empty, then reports that as a failure. Measured: against a field
// that fills on the third read it threw on the first (`toHaveValue #cc-config held`), which
// is exactly the pre-hydration race the assertion was written to wait out; and against one
// already full it burned the entire timeout before passing (10s per `openEditor`, five times
// over in test/e2e/options.test.ts). So the negated form polls until `holds` STOPS holding,
// and `pass` is reported in positive terms for vitest to flip.
async function settle<T>(
  ctx: MatcherContext,
  locator: Locator,
  name: string,
  opts: WaitOpts | undefined,
  read: () => Promise<T>,
  holds: (seen: T) => boolean,
  describe: (seen: T) => string,
): Promise<Verdict> {
  const wanted = ctx.isNot !== true;
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
        return holds(last) === wanted ? undefined : RETRY;
      },
    );
  } catch {
    // Never settled: the last reading is the diagnosis either way.
  }
  const held = last !== undefined && holds(last);
  return {
    pass: held,
    message: () =>
      held
        ? `${name} ${locator.selector} held: ${describe(last as T)}`
        : `${name} ${locator.selector}: ${describe(last as T)}`,
  };
}

const trimmed = (s: string) => s.trim();

expect.extend({
  async toHaveText(locator: Locator, expected: string | RegExp, opts?: WaitOpts) {
    return settle(
      this,
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
      this,
      locator,
      "toContainText",
      opts,
      () => locator.innerText({ timeout: 0 }),
      (seen) => seen.includes(expected),
      (seen) => `expected to contain ${JSON.stringify(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  // string | RegExp, as Playwright's toHaveValue is. A textarea's content is its VALUE and
  // not its text, so this — not toContainText — is what asks about one.
  async toHaveValue(locator: Locator, expected: string | RegExp, opts?: WaitOpts) {
    return settle(
      this,
      locator,
      "toHaveValue",
      opts,
      () => locator.inputValue({ timeout: 0 }),
      (seen) => (expected instanceof RegExp ? expected.test(seen) : seen === expected),
      (seen) => `expected ${String(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toHaveAttribute(locator: Locator, name: string, expected: string | RegExp, opts?: WaitOpts) {
    return settle(
      this,
      locator,
      `toHaveAttribute(${name})`,
      opts,
      () => locator.getAttribute(name, { timeout: 0 }),
      (seen) =>
        seen !== null && (expected instanceof RegExp ? expected.test(seen) : seen === expected),
      (seen) => `expected ${String(expected)}, last saw ${JSON.stringify(seen)}`,
    );
  },

  async toHaveCount(locator: Locator, expected: number, opts?: WaitOpts) {
    return settle(
      this,
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
      this,
      locator,
      "toBeVisible",
      opts,
      () => locator.isVisible(),
      (seen) => seen,
      (seen) => (seen ? "was visible" : "never became visible"),
    );
  },

  async toBeEnabled(locator: Locator, opts?: WaitOpts) {
    return settle(
      this,
      locator,
      "toBeEnabled",
      opts,
      () => locator.isEnabled(),
      (seen) => seen,
      (seen) => (seen ? "was enabled" : "never became enabled"),
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
    toHaveValue(expected: string | RegExp, opts?: WaitOpts): Promise<T>;
    toHaveAttribute(name: string, expected: string | RegExp, opts?: WaitOpts): Promise<T>;
    toHaveCount(expected: number, opts?: WaitOpts): Promise<T>;
    toBeVisible(opts?: WaitOpts): Promise<T>;
    toBeEnabled(opts?: WaitOpts): Promise<T>;
  }
}
