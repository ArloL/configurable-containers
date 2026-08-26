// Does the expensive tier give the same answer twice? (`npm run test:flake`, nightly.)
//
// Every other gate asks whether the suite is green. This asks whether "green" means
// anything — whether a case that passed would pass again. L4/L5 drive a real Firefox
// through a real network stack with real timers, which is where a 1-in-20 case lives, and
// a single run cannot tell one apart from a solid one. Left unmeasured, the way that gets
// resolved is someone deciding the suite is unreliable and stopping reading it, which
// takes the invariants with it — the same failure `test/fitness/`'s no-false-alarms rule
// is written against.
//
// The alternative most suites reach for is `--retry`, which converts a flake into a pass
// and destroys the evidence. This runs the tier N times and fails ONLY on disagreement:
// a case that fails every time is the suite being red, which is somebody else's job to
// report and not this script's to hide.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface CaseOutcome {
  /** Vitest's `fullName`: the describe chain plus the case name. */
  name: string;
  status: string;
  durationMs: number;
}

/** One run of the tier: what it said about each case, and whether it succeeded AT ALL. */
export interface Run {
  cases: CaseOutcome[];
  /**
   * The report's own `success`. Kept because the case level cannot answer it: a `beforeAll`
   * that throws records every case it owns as **"skipped"** — measured, and byte-identical
   * to a deliberate `it.skip`. So a launch that dies in every run gives every case the same
   * status in every run, which is agreement, which used to be reported as
   * "All cases answered the same way 3 times." `launch()` is a beforeAll in every e2e file,
   * and no Firefox, no geckodriver, no harness server and no `mac/` checkout all arrive
   * that way — the whole tier not running, reported as the tier being solid.
   */
  success: boolean;
  /**
   * The `--sequence.seed` this run was given, when the caller chose one. `readRun` cannot
   * know it — it reads a report, and the report does not carry it — so `main` attaches it.
   * Without this a disagreement caused by ORDER names no order, and the shuffle that found
   * it is unreproducible: vitest picks its own seed and prints it into a log nobody keeps.
   */
  seed?: string;
}

/** One case's story across the runs, in run order. `null` where the run never reached it. */
export interface CaseHistory {
  name: string;
  statuses: (string | null)[];
}

export interface Verdict {
  /** Cases that did not answer the same way every time. The flake signal. */
  flaky: CaseHistory[];
  /** Cases that failed in every run: red, not flaky. Reported so the two never get confused. */
  failing: string[];
  /** Slowest cases by their longest observed run, for reading rather than for gating. */
  slowest: { name: string; worstMs: number }[];
  /**
   * Per run, whether vitest called it a success — COMPARED, never merely checked. Checking
   * would be wrong: a genuinely flaky case makes exactly one run exit non-zero, and that
   * run is the thing to report as a race rather than as red.
   */
  runSucceeded: boolean[];
  /** Indices of runs that reported no cases at all. A green verdict over nothing is not one. */
  emptyRuns: number[];
  /** The order each run was given, in run order. Empty entries where nobody chose one. */
  seeds: (string | undefined)[];
}

/** A vitest `--reporter=json` file: its `success`, and its `assertionResults` flattened. */
export function readRun(report: unknown): Run {
  const files = (report as { testResults?: unknown[] }).testResults ?? [];
  // Absent `success` reads as FAILURE. A report that does not say it succeeded is not
  // evidence that it did, and this gate exists to stop exactly that inference.
  const success = (report as { success?: boolean }).success === true;
  const cases = files.flatMap((file) => {
    const cases = (file as { assertionResults?: unknown[] }).assertionResults ?? [];
    return cases.map((c) => {
      const a = c as { fullName?: string; title?: string; status?: string; duration?: number };
      return {
        name: a.fullName ?? a.title ?? "<unnamed>",
        status: a.status ?? "unknown",
        durationMs: a.duration ?? 0,
      };
    });
  });
  return { cases, success };
}

export function compareRuns(runs: Run[]): Verdict {
  const cases = runs.map((run) => run.cases);
  const names = [...new Set(cases.flat().map((c) => c.name))].sort();
  const flaky: CaseHistory[] = [];
  const failing: string[] = [];
  const slowest: { name: string; worstMs: number }[] = [];

  for (const name of names) {
    // null, not "missing": a run that never reached a case is a disagreement of its own —
    // a file that crashed on load answers for none of its cases, and reading that as
    // "unchanged" is how a suite that stopped running half of itself stays green.
    const statuses = cases.map((run) => run.find((c) => c.name === name)?.status ?? null);
    const seen = [...new Set(statuses)];
    // A case skipped in every run is a deliberate `it.skip`, which `suite.test.ts` owns.
    if (seen.length > 1) flaky.push({ name, statuses });
    else if (seen[0] === "failed") failing.push(name);

    const worstMs = Math.max(...cases.flatMap((run) => run.filter((c) => c.name === name).map((c) => c.durationMs)), 0);
    slowest.push({ name, worstMs });
  }

  slowest.sort((a, b) => b.worstMs - a.worstMs);
  return {
    flaky,
    failing,
    slowest: slowest.slice(0, 10),
    runSucceeded: runs.map((run) => run.success),
    emptyRuns: runs.flatMap((run, i) => (run.cases.length === 0 ? [i] : [])),
    seeds: runs.map((run) => run.seed),
  };
}

/** Did anything at all go wrong? What `main` exits on, and what a caller should ask. */
export function isRed(verdict: Verdict): boolean {
  return (
    verdict.flaky.length > 0 ||
    verdict.failing.length > 0 ||
    verdict.emptyRuns.length > 0 ||
    verdict.runSucceeded.some((ok) => !ok)
  );
}

const DEFAULT_TARGET = "test/e2e";
const DEFAULT_RUNS = 3;

export function report(verdict: Verdict, runs: number, target: string = DEFAULT_TARGET): string {
  const lines: string[] = [];
  if (verdict.flaky.length > 0) {
    lines.push(`${verdict.flaky.length} case(s) did not answer the same way across ${runs} runs:`);
    for (const c of verdict.flaky) {
      lines.push(`  ${c.name}`);
      lines.push(`    ${c.statuses.map((s) => s ?? "never ran").join(" → ")}`);
      // The orders those answers came from. Without them a disagreement that is really an
      // ORDER dependence — the kind shuffling exists to expose — names no order, and the
      // reader is left bisecting a suite by hand.
      if (verdict.seeds.some((seed) => seed !== undefined)) {
        lines.push(`    seeds ${verdict.seeds.map((seed) => seed ?? "?").join(" → ")}`);
        // The first run that did not pass: the one worth replaying, and the only one of
        // them that is a question rather than a control.
        const odd = c.statuses.findIndex((s) => s !== "passed");
        const seed = verdict.seeds[odd === -1 ? 0 : odd];
        if (seed !== undefined) {
          lines.push(`    replay that order: npx vitest run ${target} --sequence.seed=${seed}`);
        }
      }
    }
    lines.push("");
    // Said here rather than in a comment nobody reads at 3am: the fix is the case, not
    // the runner. Every "flaky" case in this suite so far has been a real race — a probe
    // reply beating a navigation commit, an assertion made before the probe reported.
    lines.push("A disagreement is a race in the case, not noise to be retried away.");
    lines.push("See TESTING.md's e2e section for the ones this harness has already had.");
  }
  for (const i of verdict.emptyRuns) {
    lines.push("");
    lines.push(`Run ${i + 1} of ${runs} reported NO CASES AT ALL.`);
    lines.push("Agreement over nothing is not agreement. Look at that run's own output:");
    lines.push("nothing here can tell you why a suite did not collect.");
  }

  const broken = verdict.runSucceeded.flatMap((ok, i) => (ok ? [] : [i]));
  if (broken.length === runs && verdict.flaky.length === 0 && verdict.failing.length === 0) {
    lines.push("");
    lines.push(`All ${runs} runs failed as a whole, and NO CASE says why.`);
    // The shape this exists for, spelled out because it is the one that used to read green.
    lines.push("That is what a dead `beforeAll` looks like: it records the cases it owns as");
    lines.push('"skipped", which is what a deliberate it.skip looks like too — so every run');
    lines.push("agrees, case by case, while none of them ran. `launch()` is a beforeAll in");
    lines.push("every e2e file: no Firefox, no geckodriver, no harness server, no mac/");
    lines.push("checkout. Read the first run's output, not this summary.");
  } else if (broken.length > 0 && verdict.flaky.length === 0) {
    lines.push("");
    lines.push(
      `${broken.length} of ${runs} runs failed as a whole while every case agreed: ` +
        `run(s) ${broken.map((i) => i + 1).join(", ")}.`,
    );
    lines.push("A hook or a teardown that dies SOMETIMES — a race no per-case comparison");
    lines.push("can see, because the cases it takes down are recorded as skipped.");
  }

  if (verdict.failing.length > 0) {
    lines.push("");
    lines.push(`${verdict.failing.length} case(s) failed in every run — red, not flaky:`);
    for (const name of verdict.failing) lines.push(`  ${name}`);
  }
  lines.push("");
  lines.push("Slowest cases by their worst run:");
  for (const c of verdict.slowest) lines.push(`  ${(c.worstMs / 1000).toFixed(1)}s  ${c.name}`);
  return lines.join("\n");
}

// --- the part that needs a browser -------------------------------------------------

function main(): void {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const runs = Number(process.env.FLAKE_RUNS ?? DEFAULT_RUNS);
  // A fresh base per invocation, so two nights do not sample the same ten orders.
  const base = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), "cc-flake-"));
  try {
    const outcomes: Run[] = [];
    for (let i = 0; i < runs; i++) {
      const outFile = path.join(dir, `run-${i}.json`);
      console.log(`\n=== flake run ${i + 1}/${runs}: ${target} (seed ${base + i}) ===`);
      // A DIFFERENT order per run, and one this script knows. `vitest.config.ts` shuffles
      // the file order, which is what lets the comparison below see an order dependence at
      // all — but left to itself vitest invents a seed and only prints it, so the run that
      // disagreed could not be run again. Choosing them here makes each order both varied
      // (a fresh base per invocation, so nights do not repeat) and reproducible.
      const seed = String(base + i);
      const proc = spawnSync(
        "npx",
        ["vitest", "run", target, `--sequence.seed=${seed}`,
         "--reporter=json", `--outputFile=${outFile}`, "--reporter=default"],
        { stdio: "inherit" },
      );
      const run = readRun(JSON.parse(readFileSync(outFile, "utf8")));
      // Belt and braces: the report says whether the SUITE succeeded, the exit code says
      // whether the PROCESS did, and a crash after the report was written is only visible
      // in the second. Neither is allowed to vouch for the other.
      outcomes.push({ ...run, success: run.success && proc.status === 0, seed });
    }

    const verdict = compareRuns(outcomes);
    console.log("\n" + report(verdict, runs, target));
    if (isRed(verdict)) process.exitCode = 1;
    else console.log(`\nAll ${runs} runs succeeded, and every case answered the same way.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Same guard as scripts/dev-updates.js: importing this file for its pure half must not
// start three Firefox suites.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
