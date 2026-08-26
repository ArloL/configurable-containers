// The comparison behind `npm run test:flake`, which is the only gate here whose subject is
// the SUITE rather than the extension.
//
// It gets tests of its own for the reason the reaper does: it runs where nobody is
// watching, on a schedule, and a comparison that quietly answered "all consistent" would
// look exactly like a healthy suite. Everything below is the pure half; the half that
// starts three Firefox runs is exercised by pointing the script at a browser-free target.
import { describe, it, expect } from "vitest";
import { compareRuns, isRed, parseRuns, readRun, readRunText, report, type CaseOutcome, type Run } from "../../scripts/flake-check";

const passed = (name: string, durationMs = 1): CaseOutcome => ({ name, status: "passed", durationMs });
const failed = (name: string, durationMs = 1): CaseOutcome => ({ name, status: "failed", durationMs });
const skipped = (name: string): CaseOutcome => ({ name, status: "skipped", durationMs: 0 });

// A run that vitest called a success. `broke` is the same cases from a run that did not —
// which is a different fact, and one no case status can carry.
const ok = (...cases: CaseOutcome[]): Run => ({ cases, success: true });
const broke = (...cases: CaseOutcome[]): Run => ({ cases, success: false });
/** The same, for the cases about which ORDER produced which answer. */
const inOrder = (seed: string, run: Run): Run => ({ ...run, seed });

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
    expect(readRun(report).cases).toEqual([
      { name: "routing reopens into Work", status: "passed", durationMs: 1200 },
      { name: "routing leaves an inherit host alone", status: "failed", durationMs: 900 },
      { name: "choice shows the picker", status: "passed", durationMs: 2400 },
    ]);
  });

  it("survives a report with no results, which is what a crashed run writes", () => {
    expect(readRun({}).cases).toEqual([]);
    expect(readRun({ testResults: [{ name: "x" }] }).cases).toEqual([]);
  });

  // A report that does not SAY it succeeded is not evidence that it did, and this whole
  // gate exists to stop that inference being made about a suite.
  it("reads a missing or false `success` as failure, and only true as success", () => {
    expect(readRun({}).success).toBe(false);
    expect(readRun({ success: false, testResults: [] }).success).toBe(false);
    expect(readRun({ success: true, testResults: [] }).success).toBe(true);
  });
});

// The report vitest was asked to write may not exist. `main` read it with a bare
// `readFileSync` until 2026-08-26, so a run that died before writing one took the whole
// comparison down with an ENOENT — and the runs that HAD completed went with it.
describe("a report vitest never wrote", () => {
  it("reads a missing file as the empty run it is, rather than throwing", () => {
    const run = readRunText(null);
    expect(run.cases).toEqual([]);
    expect(run.success).toBe(false);
  });

  it("reads a half-written report the same way", () => {
    // A process killed with the report still buffered. Not evidence of anything.
    expect(readRunText('{"testResults": [')).toEqual({ cases: [], success: false });
  });

  it("still reads a report that IS there", () => {
    const text = JSON.stringify({ success: true, testResults: [{ assertionResults: [{ fullName: "a", status: "passed", duration: 5 }] }] });
    expect(readRunText(text)).toEqual({ cases: [{ name: "a", status: "passed", durationMs: 5 }], success: true });
  });

  // The point of not throwing: the empty run is COUNTED, so the comparison gets to say the
  // thing it has words for instead of dying before it can.
  it("makes the comparison call that run empty, which is red", () => {
    const verdict = compareRuns([ok(passed("a")), readRunText(null)]);
    expect(verdict.emptyRuns).toEqual([1]);
    expect(isRed(verdict)).toBe(true);
    expect(report(verdict, 2)).toContain("NO CASES AT ALL");
  });
});

// `Number("")` is 0 and `Number("thre")` is NaN, and `for (let i = 0; i < runs; i++)` runs
// zero times for both. The job then compared nothing, exited 0, and printed "All NaN runs
// succeeded, and every case answered the same way."
describe("how many times to run", () => {
  it("defaults when nobody said", () => {
    expect(parseRuns(undefined)).toBe(3);
  });

  it("takes a count the workflow named", () => {
    expect(parseRuns("10")).toBe(10);
  });

  it("refuses an empty value, which Number reads as zero", () => {
    expect(() => parseRuns("")).toThrow(/at least 2/);
  });

  it("refuses a typo, which Number reads as NaN", () => {
    // The shape this is written against: FLAKE_RUNS mistyped in a workflow's env, where
    // nobody is watching and the job's own summary said everything agreed.
    expect(() => parseRuns("thre")).toThrow(/"thre"/);
  });

  it("refuses one run, because a run cannot disagree with itself", () => {
    expect(() => parseRuns("1")).toThrow(/at least 2/);
  });

  it("refuses a fraction and a negative", () => {
    expect(() => parseRuns("2.5")).toThrow();
    expect(() => parseRuns("-3")).toThrow();
  });
});

describe("comparing runs of the same tier", () => {
  it("says nothing is flaky when every case answered the same way", () => {
    const run = ok(passed("a"), passed("b"), skipped("c"));
    expect(compareRuns([run, run, run]).flaky).toEqual([]);
  });

  it("names a case that passed once and failed once, with the order it happened in", () => {
    const verdict = compareRuns([
      ok(passed("a"), passed("b")),
      broke(passed("a"), failed("b")),
      ok(passed("a"), passed("b")),
    ]);
    expect(verdict.flaky).toEqual([{ name: "b", statuses: ["passed", "failed", "passed"] }]);
  });

  // The distinction the whole script turns on. Retrying would call this green.
  it("keeps a case that failed every time out of the flaky list, and calls it failing", () => {
    const verdict = compareRuns([broke(failed("a")), broke(failed("a")), broke(failed("a"))]);
    expect(verdict.flaky).toEqual([]);
    expect(verdict.failing).toEqual(["a"]);
  });

  it("treats a case a run never reached as a disagreement, not as unchanged", () => {
    // A file that throws on import answers for none of its cases. Reading the absence as
    // "same as last time" is how a suite that stopped running half of itself stays quiet.
    const verdict = compareRuns([ok(passed("a"), passed("b")), broke(passed("a"))]);
    expect(verdict.flaky).toEqual([{ name: "b", statuses: ["passed", null] }]);
  });

  it("does not call a case flaky for being skipped in every run", () => {
    // `it.skip` is deliberate here and owned by test/fitness/suite.test.ts, which allows
    // exactly one. Reporting it every night would train everyone to ignore this job.
    expect(compareRuns([ok(skipped("a")), ok(skipped("a"))]).flaky).toEqual([]);
  });

  it("ranks the slowest cases by their WORST run, not their average", () => {
    // The worst run is the one that decides whether CI times out.
    const verdict = compareRuns([
      ok(passed("quick", 100), passed("spiky", 200)),
      ok(passed("quick", 120), passed("spiky", 9000)),
    ]);
    expect(verdict.slowest.map((c) => c.name)).toEqual(["spiky", "quick"]);
    expect(verdict.slowest[0]!.worstMs).toBe(9000);
  });
});

// The failure this comparison could not see, and the reason a run now carries `success`.
//
// Measured against vitest 4: a `beforeAll` that throws records every case it owns as
// **"skipped"** and leaves `numFailedTests` at 0, while the report's own `success` is false.
// At the case level that is byte-identical to a deliberate `it.skip` — so a launch that
// dies in EVERY run has every case agreeing in every run, and the job used to print
// "All cases answered the same way 3 times." `launch()` is a beforeAll in every e2e file.
describe("a tier that did not run at all", () => {
  const deadLaunch = () => broke(skipped("routing reopens into Work"));

  it("is red, even though every run agreed about every case", () => {
    const verdict = compareRuns([deadLaunch(), deadLaunch(), deadLaunch()]);
    expect(verdict.flaky).toEqual([]);
    expect(verdict.failing).toEqual([]);
    // Neither list can carry it. The run-level answer is the one that can.
    expect(verdict.runSucceeded).toEqual([false, false, false]);
    expect(isRed(verdict)).toBe(true);
  });

  it("says a dead hook is what this looks like, rather than leaving it to be guessed", () => {
    const text = report(compareRuns([deadLaunch(), deadLaunch()]), 2);
    expect(text).toContain("All 2 runs failed as a whole, and NO CASE says why");
    expect(text).toContain("beforeAll");
  });

  it("is red when a run reports no cases at all, which is agreement over nothing", () => {
    const verdict = compareRuns([ok(), ok()]);
    expect(verdict.emptyRuns).toEqual([0, 1]);
    expect(isRed(verdict)).toBe(true);
    expect(report(verdict, 2)).toContain("NO CASES AT ALL");
  });

  // The other half: a hook that dies SOMETIMES takes its cases down as "skipped" too, so
  // the disagreement is visible per case — but a run can also fail as a whole with every
  // case passing (an unhandled rejection, a teardown that throws), and nothing per-case
  // will ever show it.
  it("names a run that failed as a whole while every case passed", () => {
    const verdict = compareRuns([ok(passed("a")), broke(passed("a")), ok(passed("a"))]);
    expect(verdict.flaky).toEqual([]);
    expect(isRed(verdict)).toBe(true);
    expect(report(verdict, 3)).toContain("1 of 3 runs failed as a whole while every case agreed");
  });

  // …and the thing it must NOT do: a run failing because of a case that is already
  // reported as flaky is the same finding twice, and the run-level note would bury it.
  it("does not repeat itself when a flaky case is why the run failed", () => {
    const text = report(compareRuns([ok(passed("a")), broke(failed("a")), ok(passed("a"))]), 3);
    expect(text).toContain("did not answer the same way");
    expect(text).not.toContain("failed as a whole");
  });

  it("stays green when every run succeeded and every case agreed", () => {
    const run = () => ok(passed("a"), skipped("b"));
    expect(isRed(compareRuns([run(), run(), run()]))).toBe(false);
  });

  // The emptiness one step further out than `emptyRuns`, which guards a run that produced
  // nothing rather than the absence of runs. Over no runs every list in the verdict is
  // empty, and "nothing went wrong" is exactly the wrong reading of that.
  it("is red over no runs at all, where every list is empty for want of evidence", () => {
    const verdict = compareRuns([]);
    expect(verdict.flaky).toEqual([]);
    expect(verdict.failing).toEqual([]);
    expect(verdict.emptyRuns).toEqual([]);
    expect(verdict.runSucceeded).toEqual([]);
    expect(isRed(verdict)).toBe(true);
  });

  it("is red over a single run, where every case agrees with itself", () => {
    expect(isRed(compareRuns([ok(passed("a"))]))).toBe(true);
  });

  it("says nothing was compared, rather than summarising no evidence", () => {
    const text = report(compareRuns([]), 0);
    expect(text).toContain("NOTHING WAS COMPARED: 0 run(s).");
    expect(text).toContain("FLAKE_RUNS");
    // And specifically NOT the dead-`beforeAll` speech: over zero runs "every run failed"
    // and "no run failed" are the same empty list, and that branch used to fire.
    expect(text).not.toContain("failed as a whole");
    expect(text).not.toContain("beforeAll");
  });
});

describe("what the job prints", () => {
  it("shows each flaky case's run-by-run story", () => {
    const text = report(compareRuns([ok(passed("a")), broke(failed("a")), ok(passed("a"))]), 3);
    expect(text).toContain("1 case(s) did not answer the same way across 3 runs");
    expect(text).toContain("passed → failed → passed");
    // The reader at 3am needs to be told what a disagreement means, not just that there
    // was one — otherwise the obvious next move is to add a retry.
    expect(text).toContain("not noise to be retried away");
  });

  it("shows a run that never reached a case as such, rather than as a status", () => {
    expect(report(compareRuns([ok(passed("a")), broke()]), 2)).toContain("passed → never ran");
  });

  // The file order is shuffled (vitest.config.ts), which is what lets the comparison see an
  // ORDER dependence at all — a case that leans on state an earlier file left behind answers
  // the same way every run in a fixed order, so it lands under "red, not flaky" instead. But
  // a disagreement that names no order is one nobody can reproduce: vitest invents a seed and
  // only prints it, so `main` chooses them and they come back out here.
  it("names the order each answer came from", () => {
    const text = report(
      compareRuns([
        inOrder("100", ok(passed("a"))),
        inOrder("101", broke(failed("a"))),
        inOrder("102", ok(passed("a"))),
      ]),
      3,
      "test/e2e",
    );
    expect(text).toContain("seeds 100 → 101 → 102");
  });

  it("offers the order of the run that did NOT pass, since that is the one worth running again", () => {
    const text = report(
      compareRuns([
        inOrder("100", ok(passed("a"))),
        inOrder("101", broke(failed("a"))),
        inOrder("102", ok(passed("a"))),
      ]),
      3,
      "test/e2e",
    );
    expect(text).toContain("npx vitest run test/e2e --sequence.seed=101");
    // Not one of the runs that agreed: replaying a control reproduces nothing.
    expect(text).not.toContain("--sequence.seed=100");
  });

  it("says nothing about orders when nobody chose one", () => {
    // compareRuns is pure and its own cases pass no seeds; a line of "?" would be noise.
    const text = report(compareRuns([ok(passed("a")), broke(failed("a"))]), 2);
    expect(text).not.toContain("seeds");
    expect(text).not.toContain("--sequence.seed");
  });
});
