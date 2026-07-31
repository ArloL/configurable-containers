// Nothing this harness launches may outlive the process that launched it.
//
// Selenium `unref()`s the geckodriver it spawns (selenium-webdriver/io/exec.js), so
// geckodriver — and the Firefox under it — survive node exiting. Several paths then
// leak a browser nobody holds a handle to any more:
//
//   * `installAddon` throws, and the catch tears down the server but not the driver;
//   * session creation itself throws while Firefox is ALREADY running. On macOS this
//     is a real flake ("Process (pid=…) unexpectedly closed with status 0"): Firefox
//     re-execs, geckodriver loses the pid it was watching, and the surviving browser
//     re-parents to init. There is no capability to read a pid out of — the session
//     never existed;
//   * a `beforeAll` blows vitest's hookTimeout, so `launch()` resolves into nobody's
//     hands and the file's `afterAll` closes an `undefined` session;
//   * the worker is killed, or crashes, before any `afterAll` runs.
//
// So the harness does not ask the browser to identify itself — it stamps it. Every
// launch gets a profile directory of its own, created here and passed to Firefox as
// `-profile`, which puts a unique path on the command line of the browser process and
// every content process under it. That token exists BEFORE Firefox does, which is what
// makes the "session never came up" case reachable at all, and it is specific enough
// that reaping can never touch the developer's own Firefox or a concurrent
// `npm run manual` — each has a profile of its own.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import * as path from "node:path";

// The stamp. Also the guard: the path becomes a `pgrep -f` pattern whose matches are
// killed, so one that did not come from claimProfileDir() must never reach it — an empty
// or short pattern would match half the process table.
const PROFILE_PREFIX = "cc-e2e-profile-";

const live = new Set<string>();

// Create a profile directory for one browser and put it under the reaper's care.
export function claimProfileDir(): string {
  installExitHooks();
  const dir = mkdtempSync(path.join(tmpdir(), PROFILE_PREFIX));
  live.add(dir);
  return dir;
}

// Profile directories with a browser still (potentially) running in them.
export function liveProfileDirs(): string[] {
  return [...live];
}

function assertReapable(dir: string): void {
  if (!path.basename(dir).startsWith(PROFILE_PREFIX)) {
    throw new Error(`refusing to reap ${JSON.stringify(dir)}: not a harness profile directory`);
  }
}

// Kill whatever is still running in `dir` and delete it. Synchronous on purpose: this
// runs from `process.on("exit")`, where nothing asynchronous is ever scheduled again.
// Idempotent — the normal path calls it after a clean `driver.quit()`, when there is
// nothing left to kill.
export function reapProfile(dir: string): void {
  assertReapable(dir);
  live.delete(dir);
  // Firefox's own processes carry the profile path in their argv. macOS reports the
  // parent's as /var/folders/… and the content processes' as /private/var/folders/…,
  // so the pattern is a substring of both.
  const browser = pidsMatching(dir);
  for (const pid of geckodriversOwning(browser)) kill(pid);
  for (const pid of browser) kill(pid);
  rmSync(dir, { recursive: true, force: true });
}

export function reapAll(): void {
  for (const dir of [...live]) {
    try {
      reapProfile(dir);
    } catch {
      // One unreapable profile must not stop the others; we are on the way out.
    }
  }
}

// Processes whose command line contains `pattern`. Killing is done with process.kill on
// what this returns rather than by handing the pattern to `pkill`, so there is exactly
// one external tool to depend on — and so a missing one is heard: `spawnSync` reports an
// absent binary in `error` instead of throwing, which would otherwise reap nothing,
// quietly, forever.
function pidsMatching(pattern: string): number[] {
  const run = spawnSync("pgrep", ["-f", pattern], { encoding: "utf-8" });
  if (run.error) throw new Error(`the harness reaper needs pgrep: ${run.error.message}`);
  return (run.stdout ?? "").split("\n").map(Number).filter(Boolean);
}

// The geckodriver that started this browser, found through the browser rather than
// remembered: Selenium exposes no pid for the service it spawns, and geckodriver's own
// command line carries only a port, so it cannot be matched directly. It is however the
// PARENT of the Firefox process — verified against geckodriver 0.37.1. A miss costs an
// idle stray geckodriver, never a wrong kill: nothing is killed unless `ps` says
// "geckodriver".
function geckodriversOwning(browserPids: number[]): number[] {
  if (browserPids.length === 0) return [];
  const parents = new Set(column(ps(["-o", "ppid=", "-p", browserPids.join(",")]), 0));
  if (parents.size === 0) return [];

  return ps(["-o", "pid=,command=", "-p", [...parents].join(",")])
    .filter((line) => line.includes("geckodriver"))
    .flatMap((line) => column([line], 0));
}

const ps = (args: string[]): string[] =>
  (spawnSync("ps", args, { encoding: "utf-8" }).stdout ?? "").split("\n").filter(Boolean);

const column = (lines: string[], n: number): number[] =>
  lines.map((line) => Number(line.trim().split(/\s+/)[n])).filter(Boolean);

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone — the clean path usually got there first.
  }
}

let hooked = false;

// `exit` is the one that covers a forgotten `close()`: whatever the run did, the
// process cannot leave without passing through here. The signal handlers exist because
// a signalled process never reaches `exit` on its own.
function installExitHooks(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", reapAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      reapAll();
      process.exit(128 + constants.signals[signal]);
    });
  }
}
