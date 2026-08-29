// Playwright's web-first assertions, in vitest's idiom: the comparison retries, so a page
// that has not finished rendering is a wait rather than a failure. Its own docs steer text
// comparisons here rather than to `expect(await locator.innerText())`, precisely because
// the read-then-compare form flakes. Imported for effect by the files that use them.
import { expect } from "vitest";
import type { Locator } from "./locator";
import { ASSERTION_TIMEOUT_MS, PollTimeoutError, RETRY, poll } from "./retry";
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
  // A BOX rather than a `T | undefined`, so "never read" stays distinguishable from a
  // reading that is legitimately falsy, and so nothing has to assume which matchers can
  // answer undefined.
  let reading: { value: T } | undefined;
  try {
    await poll(
      {
        timeout: opts?.timeout ?? ASSERTION_TIMEOUT_MS,
        what: `${name} ${locator.selector}`,
        diagnose: async () => "",
      },
      async () => {
        try {
          reading = { value: await read() };
        } catch (e) {
          // The reader is given a zero budget — the waiting is THIS poll's job — so it
          // gives up the moment the element is not resolvable. That is "not in the document
          // yet", which is the normal state of a page the driver reached by url: measured on
          // the options page, whose #cc-sync arrived after `pageAt` had answered. Retry it.
          // Anything else (a dead driver, a closed session) is not something to wait out.
          if (e instanceof PollTimeoutError) return RETRY;
          throw e;
        }
        return holds(reading.value) === wanted ? undefined : RETRY;
      },
    );
  } catch {
    // Never settled: the last reading is the diagnosis either way.
  }
  // An element that never appeared fails in BOTH directions. Reporting it as "the condition
  // did not hold" would make `.not` pass for a page that rendered nothing at all, which is
  // the failure this whole layer is against.
  //
  // Reaching here is the READER's decision, not this function's: it means every attempt
  // threw `PollTimeoutError`, which the locator raises when the element is not resolvable.
  // So the promise above holds for a matcher whose reader asks about an ELEMENT, and only
  // for those — `toBeVisible` and `toHaveCount` deliberately read a missing element as an
  // answer (`false`, `0`) rather than an absence, which is Playwright's behaviour for both
  // and what a caller of `.not.toBeVisible()` or `toHaveCount(0)` is asking. `toBeEnabled`
  // used to be in that group by accident rather than by choice, through `isEnabled()`
  // answering `false` for an element that is not there; it asks `enabledState()` now.
  if (reading === undefined) {
    return {
      pass: ctx.isNot === true,
      message: () => `${name} ${locator.selector}: no element matched`,
    };
  }
  const seen = reading.value;
  const held = holds(seen);
  return {
    pass: held,
    message: () =>
      held
        ? `${name} ${locator.selector} held: ${describe(seen)}`
        : `${name} ${locator.selector}: ${describe(seen)}`,
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

  // The one matcher of the three boolean-ish readers that must NOT read a missing element
  // as an answer. Playwright's `toBeEnabled` waits for the element; ours could not tell
  // "disabled" from "not rendered", because `isEnabled()` answers `false` for both — so
  // `.not.toBeEnabled()` passed on a document that had rendered nothing, which is exactly
  // the inference `settle`'s "no element matched" branch exists to refuse. It was dead code
  // for this matcher.
  async toBeEnabled(locator: Locator, opts?: WaitOpts) {
    return settle(
      this,
      locator,
      "toBeEnabled",
      opts,
      async () => {
        const state = await locator.enabledState();
        // Absence is raised as the error `settle` already knows how to treat — the same one
        // the other element-reading matchers get from their zero-budget reader — so it is
        // retried while the page renders and fails in both directions if it never does.
        if (state === null) throw new PollTimeoutError(`toBeEnabled ${locator.selector}: no element`);
        return state;
      },
      (seen) => seen,
      (seen) => (seen ? "was enabled" : "never became enabled"),
    );
  },
});

// The parameter list must match @vitest/expect's own `interface Matchers<T = any>`
// exactly, or TS refuses the merge (TS2428) even though the matchers work. So the `any`
// stays; it needs no suppression, because `typescript/no-explicit-any` is a pedantic rule
// and `.oxlintrc.json` enables `correctness` plus a named list that does not include it.
declare module "vitest" {
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
