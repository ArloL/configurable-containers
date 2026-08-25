// Fitness function: the suite itself.
//
// Every other gate in this repo asks whether the code is right. This one asks whether
// the run that just went green actually ran — the failure mode where CI reports success
// because it executed one test, or because a case that used to assert something is now
// skipped and nobody is counting.
import { describe, it, expect } from "vitest";
import { sourceFiles, filesMatching } from "./sources";

const tests = sourceFiles("test");

describe("fitness — the run that says green ran everything", () => {
  it("contains no .only, which would shrink CI to one case and still report success", () => {
    // The worst green in this repo is not a wrong assertion, it is a run that skipped the
    // assertion. A committed `it.only` turns the whole file into that one case; vitest
    // says "1 passed" and CI is happy. There is no other check anywhere that would notice.
    // Matched on the CALL syntax — the trailing "(" — rather than the bare word, so
    // that this file, which has to spell the pattern out, is not its own first offender.
    const offenders = filesMatching(tests, /\b(it|test|describe|bench)\.only\s*\(/);
    expect(offenders).toEqual([]);
  });

  it("skips exactly the one case that is documented as undriveable, and no others", () => {
    // TESTING.md states the suite "skips nothing" and backs it up by EXCLUDING the
    // realtime cases by filename rather than skipping them. The single exception is the
    // reopen picker's e2e: `commands.onCommand` is a chrome-level key event that
    // WebDriver cannot deliver at all, so the case is kept as an executable description
    // of what the L3 test already pins (CLAUDE.md, "e2e: what the driver cannot do").
    //
    // There was a second: options.test.ts's config-save case, unobservable on a build where
    // `runtime.reload()` does not bring a temporarily installed extension back (140.14.0esr).
    // It went away by removing the reload rather than the case — a save applies its config in
    // place now, so the case runs on every channel.
    //
    // The pattern below still catches an argument-less `.skip()` as well as `it.skip(`,
    // because that one skipped at RUNTIME from the browser version: the easier kind to add
    // in a hurry, and an inventory that only knew the static form would have been evaded by
    // it. Pinned as an exact list so either kind has to be argued for here.
    const skips = filesMatching(tests, /\b(it|test|describe)\.skip\s*\(|\b\w+\.skip\s*\(\s*\)/).map(
      (f) => f.path,
    );
    expect(skips).toEqual(["test/e2e/choice.test.ts"]);
  });

  it("keeps the realtime cases out of `npm test` by filename, not by a skip", () => {
    // The exclusion is what makes the rule above enforceable: a `*.realtime.test.ts` file
    // is excluded by `vitest.config.ts` and run by `vitest.realtime.config.ts`, so the
    // nightly run executes it in full rather than reporting a skip nobody reads.
    const realtime = tests.filter((f) => f.path.endsWith(".realtime.test.ts"));
    expect(realtime.length).toBeGreaterThan(0);
    expect(filesMatching(realtime, /\b(it|test|describe)\.skip\s*\(/)).toEqual([]);
  });
});

describe("fitness — the reasons stay attached to the code", () => {
  it("gives every Stryker suppression a written justification", () => {
    // A survivor has two honest exits (write the L1/L2 case, or mark an equivalent
    // mutant) and TESTING.md is explicit that lowering the threshold is not one of them.
    // A bare `// Stryker disable` is the third, dishonest exit: it looks like the second
    // one and asserts nothing. The `:` is what separates a suppression from a claim.
    // Read from the RAW text: `sources.ts` blanks comments before any other check looks
    // at a file, and a suppression is a comment.
    const unjustified = sourceFiles("src")
      .flatMap((f) =>
        f.raw
          .split("\n")
          .map((line, i) => ({ line: line.trim(), n: i + 1 }))
          .filter(({ line }) => /Stryker disable/.test(line) && !/Stryker disable[^\n]*:/.test(line))
          .map(({ line, n }) => `${f.path}:${n} — ${line}`)
      );
    expect(unjustified).toEqual([]);
  });
});
