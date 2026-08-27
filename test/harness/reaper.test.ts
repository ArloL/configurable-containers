import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { claimProfileDir, liveProfileDirs, reapAll, reapProfile } from "../../harness/reaper";
import { eventually, isRunning } from "./process-state";

// The reaper's kill mechanism, exercised against stand-in processes rather than real
// Firefoxes: what is under test is "a process carrying this profile path in its argv
// does not survive", and a `node` that sleeps carries one exactly the way Firefox's
// `-profile <dir>` does — in milliseconds, and without needing a launch to have got as
// far as a session, which is precisely the case (harness/reaper.ts, the macOS re-exec
// flake) that cannot be staged on demand with a real browser. That a real Firefox is
// reaped this way is covered by test/harness/reaper-firefox.test.ts.

const REAPER = new URL("../../harness/reaper.ts", import.meta.url).href;

const spawned: ChildProcess[] = [];

// A process whose command line contains `dir`, standing in for a browser running in it.
// Awaited on its `spawn` event rather than a settle: "has it started" has an exact answer
// and a fixed delay is only a guess at one, which on a slow machine is the wrong guess.
// The path goes in as a bare argument rather than after a `-profile` flag the way
// Firefox's does — node rejects an unknown dash option and would exit on the spot,
// leaving a test that passes against a process that was never alive. What the reaper
// matches on is the path, not the flag.
async function sleeperIn(dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", dir], {
    stdio: "ignore",
  });
  spawned.push(child);
  await once(child, "spawn");
  return child;
}

// "Still running", NOT `process.kill(pid, 0)`: a process the reaper has killed keeps its
// pid until its parent reaps it, and answers signal 0 the whole time. See
// ./process-state.ts — reading that as alive is what made these cases environment-
// dependent rather than reaper-dependent.
const alive = isRunning;

// For asserting that something did NOT happen: give the thing that must not happen a
// chance to, then look. The assertions in the other direction poll (`gone`) instead.
const settle = () => new Promise((r) => setTimeout(r, 200));

const gone = (pid: number, what = `pid ${pid}`) => eventually(() => !alive(pid), `${what} was still running`);

afterEach(() => {
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
  reapAll();
});

describe("the harness reaper", () => {
  it("kills a process still running in a profile it reaps", async () => {
    const dir = claimProfileDir();
    const child = await sleeperIn(dir);
    expect(alive(child.pid!)).toBe(true);

    reapProfile(dir);

    await gone(child.pid!, "the process in the reaped profile");
  });

  it("deletes the profile directory it reaps", () => {
    const dir = claimProfileDir();
    expect(existsSync(dir)).toBe(true);

    reapProfile(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a process running in a profile it is not reaping", async () => {
    const mine = claimProfileDir();
    const theirs = claimProfileDir(); // stands in for a concurrent `npm run manual`
    const child = await sleeperIn(theirs);

    reapProfile(mine);
    await settle();

    expect(alive(child.pid!)).toBe(true);
  });

  it("refuses a path that is not a harness profile directory", () => {
    // The guard that keeps `pkill -9 -f <pattern>` from being handed something broad
    // enough to match the rest of the process table.
    expect(() => reapProfile("/tmp")).toThrow(/not a harness profile/);
    expect(() => reapProfile("")).toThrow(/not a harness profile/);
  });

  it("forgets a profile once reaped, so a later sweep does not revisit it", () => {
    const dir = claimProfileDir();
    expect(liveProfileDirs()).toContain(dir);

    reapProfile(dir);

    expect(liveProfileDirs()).not.toContain(dir);
  });

  it("kills every outstanding profile in one sweep", async () => {
    const dirs = [claimProfileDir(), claimProfileDir()];
    const children = await Promise.all(dirs.map(sleeperIn));

    reapAll();

    for (const child of children) await gone(child.pid!, "a process the sweep should have killed");
    expect(liveProfileDirs()).toEqual([]);
  });
});

// The leak with no owner: a `beforeAll` that blows vitest's hookTimeout, a worker that
// crashes, a run cut short with SIGTERM. Nothing calls close(), so the only thing
// between that and a stray browser is the exit hook claimProfileDir() installs — which
// launch() triggers whether or not anyone ends up holding the session. Driven through
// real child processes because surviving node's own exit is not observable from inside it.
describe("a process that abandons the browser it launched", () => {
  // Claims a profile, leaves a detached process running in it (what an unclosed
  // Firefox is), reports both, then meets its end according to `ending`.
  function abandon(ending: string): ChildProcess {
    return spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { claimProfileDir } from ${JSON.stringify(REAPER)};
         import { spawn } from "node:child_process";
         const dir = claimProfileDir();
         const browser = spawn(process.execPath,
           ["-e", "setTimeout(() => {}, 60000)", dir], { stdio: "ignore" });
         browser.unref();
         console.log(JSON.stringify({ dir, pid: browser.pid }));
         ${ending}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  }

  // The reported pid, read as soon as the child announces it.
  async function browserPidOf(proc: ChildProcess): Promise<number> {
    const line = await new Promise<string>((resolve) => {
      let buf = "";
      proc.stdout!.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\n")) resolve(buf.trim());
      });
    });
    return JSON.parse(line).pid as number;
  }

  const ended = (proc: ChildProcess): Promise<unknown> => new Promise((r) => proc.once("exit", r));

  // Both cases assert the pid before waiting on it, and it is not ceremony: `isRunning`
  // answers false for a pid nobody holds, so `gone(undefined)` — a harness that stopped
  // printing the pid — passes instantly, on a browser nothing ever looked at. Alive-before
  // is not available here the way it is below: these holders exit at once, so the reaper
  // may have done its work already.
  it("takes it down on a clean exit", async () => {
    const proc = abandon("process.exit(0);");
    const pid = await browserPidOf(proc);
    expect(pid).toBeGreaterThan(0);

    await ended(proc);

    await gone(pid, "the abandoned browser");
  });

  it("takes it down when it dies of an unhandled throw", async () => {
    const proc = abandon('throw new Error("worker crashed");');
    const pid = await browserPidOf(proc);
    expect(pid).toBeGreaterThan(0);

    await ended(proc);

    await gone(pid, "the abandoned browser");
  });

  it("takes it down when it is terminated", async () => {
    // A signalled process never reaches `process.on("exit")` on its own, which is the
    // whole reason the reaper installs signal handlers as well.
    const proc = abandon("setTimeout(() => {}, 60000);");
    const pid = await browserPidOf(proc);
    expect(alive(pid)).toBe(true);

    proc.kill("SIGTERM");
    await ended(proc);

    await gone(pid, "the abandoned browser");
  });
});
