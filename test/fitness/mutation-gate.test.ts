// Fitness function: the mutation gate runs on a vitest Stryker can still filter with.
//
// The gate's whole value is that a survivor MEANS something. On 2026-09-21 it reported
// 769 of them across five modules and every one was a phantom: the same suite scored
// 100.00% (1172 killed, 0 survived) once vitest went back to 4. Nothing was untested.
//
// What broke is the per-test filter. With `coverageAnalysis: "perTest"` Stryker runs a
// mutant only against the tests that covered it, and it names them by writing a regex
// into `testNamePattern` built from the suite chain and the test name joined with a
// single SPACE. Vitest 4 matched that against `getTaskFullName(task)`, built the same
// way. Vitest 5 matches it against the new precomputed `task.fullTestName`, which
// `createTaskName()` joins with `" > "` — so the regex selects no test at all, the
// mutant run executes nothing, and a mutant no test ran is recorded as SURVIVED. Every
// test here lives inside a `describe`, which is why it took the whole gate down rather
// than a corner of it: the 406 that still died were the static ones, mutants in
// module-level code that Stryker runs against the whole suite because no test owns them.
//
// That is the failure worth a check of its own — not a gate that goes red, but a gate
// that stops measuring and reports the silence as work to do. `coverageAnalysis: "all"`
// does not route around it (measured: the same 769, Stryker builds the filter either
// way), so the pin is the remedy until stryker-mutator/stryker-js#6210 ships. Nightly is
// where the gate runs; this is `npm test`, so a bump fails in seconds with the reason
// instead of a day later with a list of tests nobody needs to write.
//
// Removal condition is in FOLLOWUPS.md, and it is one line: unpin, delete this file.
import { describe, it, expect } from "vitest";
import { readRepoFile } from "./sources";

interface PackageJson {
  version?: string;
  devDependencies?: Record<string, string>;
}

function packageJson(path: string): PackageJson {
  return JSON.parse(readRepoFile(path)) as PackageJson;
}

const why =
  "vitest 5 broke Stryker's per-test filter, so every covered mutant survives and the " +
  "mutation gate measures nothing — see FOLLOWUPS.md and stryker-mutator/stryker-js#6210";

const declared = packageJson("package.json").devDependencies ?? {};

describe("fitness — the mutation gate's vitest", () => {
  // The declaration and the tree are separate failures: a range that permits 5 is a
  // bump waiting to happen, and an installed 5 under a 4 range is the gate already
  // broken. Renovate moves the monorepo as a pair, so both names are pinned.
  it("declares vitest and its coverage sibling on 4.x", () => {
    expect(declared["vitest"], why).toMatch(/^\^4\./);
    expect(declared["@vitest/coverage-v8"], why).toMatch(/^\^4\./);
  });

  it("has 4.x installed, which is the tree the gate actually runs on", () => {
    expect(packageJson("node_modules/vitest/package.json").version, why).toMatch(/^4\./);
  });
});
