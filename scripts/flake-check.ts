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
}

/** The `assertionResults` of a vitest `--reporter=json` file, flattened across its suites. */
export function readRun(report: unknown): CaseOutcome[] {
  const files = (report as { testResults?: unknown[] }).testResults ?? [];
  return files.flatMap((file) => {
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
}

export function compareRuns(runs: CaseOutcome[][]): Verdict {
  const names = [...new Set(runs.flat().map((c) => c.name))].sort();
  const flaky: CaseHistory[] = [];
  const failing: string[] = [];
  const slowest: { name: string; worstMs: number }[] = [];

  for (const name of names) {
    // null, not "missing": a run that never reached a case is a disagreement of its own —
    // a file that crashed on load answers for none of its cases, and reading that as
    // "unchanged" is how a suite that stopped running half of itself stays green.
    const statuses = runs.map((run) => run.find((c) => c.name === name)?.status ?? null);
    const seen = [...new Set(statuses)];
    // A case skipped in every run is a deliberate `it.skip`, which `suite.test.ts` owns.
    if (seen.length > 1) flaky.push({ name, statuses });
    else if (seen[0] === "failed") failing.push(name);

    const worstMs = Math.max(...runs.flatMap((run) => run.filter((c) => c.name === name).map((c) => c.durationMs)), 0);
    slowest.push({ name, worstMs });
  }

  slowest.sort((a, b) => b.worstMs - a.worstMs);
  return { flaky, failing, slowest: slowest.slice(0, 10) };
}

export function report(verdict: Verdict, runs: number): string {
  const lines: string[] = [];
  if (verdict.flaky.length > 0) {
    lines.push(`${verdict.flaky.length} case(s) did not answer the same way across ${runs} runs:`);
    for (const c of verdict.flaky) {
      lines.push(`  ${c.name}`);
      lines.push(`    ${c.statuses.map((s) => s ?? "never ran").join(" → ")}`);
    }
    lines.push("");
    // Said here rather than in a comment nobody reads at 3am: the fix is the case, not
    // the runner. Every "flaky" case in this suite so far has been a real race — a probe
    // reply beating a navigation commit, an assertion made before the probe reported.
    lines.push("A disagreement is a race in the case, not noise to be retried away.");
    lines.push("See TESTING.md's e2e section for the ones this harness has already had.");
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

const DEFAULT_TARGET = "test/e2e";
const DEFAULT_RUNS = 3;

function main(): void {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const runs = Number(process.env.FLAKE_RUNS ?? DEFAULT_RUNS);
  const dir = mkdtempSync(path.join(tmpdir(), "cc-flake-"));
  try {
    const outcomes: CaseOutcome[][] = [];
    for (let i = 0; i < runs; i++) {
      const outFile = path.join(dir, `run-${i}.json`);
      console.log(`\n=== flake run ${i + 1}/${runs}: ${target} ===`);
      spawnSync(
        "npx",
        ["vitest", "run", target, "--reporter=json", `--outputFile=${outFile}`, "--reporter=default"],
        { stdio: "inherit" },
      );
      outcomes.push(readRun(JSON.parse(readFileSync(outFile, "utf8"))));
    }

    const verdict = compareRuns(outcomes);
    console.log("\n" + report(verdict, runs));
    if (verdict.flaky.length > 0 || verdict.failing.length > 0) process.exitCode = 1;
    else console.log(`\nAll cases answered the same way ${runs} times.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Same guard as scripts/dev-updates.js: importing this file for its pure half must not
// start three Firefox suites.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
