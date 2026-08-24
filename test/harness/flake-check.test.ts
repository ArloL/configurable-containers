// The comparison behind `npm run test:flake`, which is the only gate here whose subject is
// the SUITE rather than the extension.
//
// It gets tests of its own for the reason the reaper does: it runs where nobody is
// watching, on a schedule, and a comparison that quietly answered "all consistent" would
// look exactly like a healthy suite. Everything below is the pure half; the half that
// starts three Firefox runs is exercised by pointing the script at a browser-free target.
import { describe, it, expect } from "vitest";
import { compareRuns, readRun, report, type CaseOutcome } from "../../scripts/flake-check";

const passed = (name: string, durationMs = 1): CaseOutcome => ({ name, status: "passed", durationMs });
const failed = (name: string, durationMs = 1): CaseOutcome => ({ name, status: "failed", durationMs });
const skipped = (name: string): CaseOutcome => ({ name, status: "skipped", durationMs: 0 });

describe("reading a vitest json report", () => {
  it("flattens the cases of every file into one list", () => {
    const report = {
      testResults: [
        {
          name: "/repo/test/e2e/routing.test.ts",
          assertionResults: [
            { fullName: "routing reopens into Work", status: "passed", duration: 1200 },
            { fullName: "routing leaves an inherit host alone", status: "failed", duration: 900 },
          ],
        },
        {
          name: "/repo/test/e2e/choice.test.ts",
          assertionResults: [{ fullName: "choice shows the picker", status: "passed", duration: 2400 }],
        },
      ],
    };
    expect(readRun(report)).toEqual([
      { name: "routing reopens into Work", status: "passed", durationMs: 1200 },
      { name: "routing leaves an inherit host alone", status: "failed", durationMs: 900 },
      { name: "choice shows the picker", status: "passed", durationMs: 2400 },
    ]);
  });

  it("survives a report with no results, which is what a crashed run writes", () => {
    expect(readRun({})).toEqual([]);
    expect(readRun({ testResults: [{ name: "x" }] })).toEqual([]);
  });
});

describe("comparing runs of the same tier", () => {
  it("says nothing is flaky when every case answered the same way", () => {
    const run = [passed("a"), passed("b"), skipped("c")];
    expect(compareRuns([run, run, run]).flaky).toEqual([]);
  });

  it("names a case that passed once and failed once, with the order it happened in", () => {
    const verdict = compareRuns([[passed("a"), passed("b")], [passed("a"), failed("b")], [passed("a"), passed("b")]]);
    expect(verdict.flaky).toEqual([{ name: "b", statuses: ["passed", "failed", "passed"] }]);
  });

  // The distinction the whole script turns on. Retrying would call this green.
  it("keeps a case that failed every time out of the flaky list, and calls it failing", () => {
    const verdict = compareRuns([[failed("a")], [failed("a")], [failed("a")]]);
    expect(verdict.flaky).toEqual([]);
    expect(verdict.failing).toEqual(["a"]);
  });

  it("treats a case a run never reached as a disagreement, not as unchanged", () => {
    // A file that throws on import answers for none of its cases. Reading the absence as
    // "same as last time" is how a suite that stopped running half of itself stays quiet.
    const verdict = compareRuns([[passed("a"), passed("b")], [passed("a")]]);
    expect(verdict.flaky).toEqual([{ name: "b", statuses: ["passed", null] }]);
  });

  it("does not call a case flaky for being skipped in every run", () => {
    // `it.skip` is deliberate here and owned by test/fitness/suite.test.ts, which allows
    // exactly one. Reporting it every night would train everyone to ignore this job.
    expect(compareRuns([[skipped("a")], [skipped("a")]]).flaky).toEqual([]);
  });

  it("ranks the slowest cases by their WORST run, not their average", () => {
    // The worst run is the one that decides whether CI times out.
    const verdict = compareRuns([
      [passed("quick", 100), passed("spiky", 200)],
      [passed("quick", 120), passed("spiky", 9000)],
    ]);
    expect(verdict.slowest.map((c) => c.name)).toEqual(["spiky", "quick"]);
    expect(verdict.slowest[0]!.worstMs).toBe(9000);
  });
});

describe("what the job prints", () => {
  it("shows each flaky case's run-by-run story", () => {
    const text = report(compareRuns([[passed("a")], [failed("a")], [passed("a")]]), 3);
    expect(text).toContain("1 case(s) did not answer the same way across 3 runs");
    expect(text).toContain("passed → failed → passed");
    // The reader at 3am needs to be told what a disagreement means, not just that there
    // was one — otherwise the obvious next move is to add a retry.
    expect(text).toContain("not noise to be retried away");
  });

  it("shows a run that never reached a case as such, rather than as a status", () => {
    expect(report(compareRuns([[passed("a")], []]), 2)).toContain("passed → never ran");
  });
});
