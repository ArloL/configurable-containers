// The one loop every operation in this layer runs. See
// docs/superpowers/specs/2026-08-25-browser-session-design.md §4.
import { error as seleniumError } from "selenium-webdriver";

export const RETRY: unique symbol = Symbol("retry");

export const DEFAULT_TIMEOUT_MS = 10_000;
export const ASSERTION_TIMEOUT_MS = 5_000;
export const POLL_INTERVAL_MS = 100;

export interface PollOpts {
  timeout: number;
  interval?: number;
  /** What the caller was doing, in the words the failure should use: `click #cc-save`. */
  what: string;
  diagnose: () => Promise<string>;
}

// The five ways Selenium says "not yet": the tab is mid-teardown, the document has not
// parsed, the element was replaced under us, it is not ready for input, something is on
// top of it. Anything else is a real failure — a driver that has died is not something to
// wait out, and waiting turns it into a timeout that explains nothing.
const RETRYABLE = [
  seleniumError.NoSuchWindowError,
  seleniumError.NoSuchElementError,
  seleniumError.StaleElementReferenceError,
  seleniumError.ElementNotInteractableError,
  seleniumError.ElementClickInterceptedError,
];

// Thrown when a poll runs out of budget, and only then. A matcher polling a locator has to
// tell "the element is not in the document YET" from "the driver is gone", and the two
// arrive at the same `catch`.
export class PollTimeoutError extends Error {}

export function isRetryable(e: unknown): boolean {
  return RETRYABLE.some((kind) => e instanceof kind);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll<T>(opts: PollOpts, attempt: () => Promise<T | typeof RETRY>): Promise<T> {
  const started = Date.now();
  const deadline = started + opts.timeout;
  for (;;) {
    try {
      const outcome = await attempt();
      if (outcome !== RETRY) return outcome;
    } catch (e) {
      if (!isRetryable(e)) throw e;
    }
    // Checked after the attempt, so a zero timeout still tries once.
    if (Date.now() >= deadline) {
      throw new PollTimeoutError(
        `${opts.what} timed out after ${Date.now() - started}ms\n${await opts.diagnose()}`,
      );
    }
    await sleep(opts.interval ?? POLL_INTERVAL_MS);
  }
}
