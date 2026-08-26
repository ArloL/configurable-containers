// Fitness function: the e2e cases stay inside the browser layer.
//
// `harness/browser/` exists because the two things every flake in this suite came from —
// Selenium's hidden "current window" and a fixed wait standing in for a condition — are not
// expressible through a Page or a Locator. That was established by a migration whose own
// commit message says "No test refers to `driver` any more" and "every driver.sleep in the
// suite" is gone. Both were false the day it landed: test/e2e/redirector.test.ts kept all of
// it, and kept it for as long as nothing asked.
//
// So this asks. It is the same shape as the rest of this directory: read `test/e2e` as TEXT
// with comments stripped (these files name the very APIs they are careful not to call), and
// pin an exact INVENTORY rather than a bound, so the next exception has to be argued for
// here rather than absorbed.
import { describe, it, expect } from "vitest";
import { filesMatching, sourceFiles } from "./sources";

const e2e = sourceFiles("test/e2e");

describe("fitness — e2e drives the browser through harness/browser", () => {
  it("has cases open at all, so the checks below are about something", () => {
    // Every rule here is a "nothing matches" assertion, and an empty file list satisfies
    // all of them. That is how a check like this stops meaning anything without failing.
    expect(e2e.length).toBeGreaterThan(10);
  });

  it("reaches for `driver` only where the protocol has nothing to offer", () => {
    // A Page acts through its own window handle; `driver` acts through whichever one
    // Selenium was left on, which after a reopen or a close is not a window at all. The
    // exception is the reopen picker's chord: `commands.onCommand` fires on browser-CHROME
    // key events, so it is `driver.actions()` or nothing, and the case is skipped anyway.
    const offenders = filesMatching(e2e, /\bdriver\b/).map((f) => f.path);
    expect(offenders).toEqual(["test/e2e/choice.test.ts"]);
  });

  it("contains no fixed wait outside the one that is a measurement", () => {
    // A sleep is a guess at a condition, and it fails the wrong way: whatever it was
    // standing in for merely being LATE reads as the assertion passing. The exception is
    // the nightly real-delay case, where the sleep is the sampling interval of a
    // measurement rather than a wait for anything — it says so, in those words.
    const offenders = filesMatching(e2e, /\bsleep\s*\(|\bsetTimeout\s*\(/).map((f) => f.path);
    expect(offenders).toEqual(["test/e2e/disposal.realtime.test.ts"]);
  });

  it("asserts on page state through the retrying matchers, never a read-then-compare", () => {
    // `expect(await locator.innerText())` reads once. Playwright's own docs steer text
    // comparisons to the retrying form for exactly this reason, and harness/browser/matchers
    // is that form: the comparison polls, so a page mid-render is a wait rather than a
    // failure. The immediate readers (count/all/isEnabled/isVisible/inputValue) are the
    // sharp ones — they answer 0, [] or "" for a document that has not got there yet, which
    // compares as a real answer.
    const offenders = filesMatching(
      e2e,
      /expect\(\s*await .*\.(count|isEnabled|isVisible|inputValue|innerText|textContent)\(\s*\)/,
    ).map((f) => f.path);
    expect(offenders).toEqual([
      // Its whole subject is which W3C commands answer on a privileged page, so it calls
      // each one directly and by name — after waiting for the element with `waitFor`. The
      // one read there that races the PAGE rather than the protocol (#cc-config's async
      // fill) goes through `toHaveValue`.
      "test/e2e/privileged-protocol.test.ts",
    ]);
  });

  it("keeps its own deadline loops out of the cases", () => {
    // `while (Date.now() < deadline)` is `poll` with the diagnosis left out: it gives up by
    // falling out of the loop, and the assertion that follows fails as "expected false to
    // be true". `poll` reports what it last saw, which is the half that makes a red run
    // readable. The realtime case measures elapsed time, which is a different use of a
    // clock and the reason this matches the LOOP rather than the call.
    const offenders = filesMatching(e2e, /while\s*\(\s*Date\.now\(\)/).map((f) => f.path);
    expect(offenders).toEqual(["test/e2e/disposal.realtime.test.ts"]);
  });
});
