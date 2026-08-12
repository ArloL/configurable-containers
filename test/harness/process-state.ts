import { spawnSync } from "node:child_process";

// Is a process still RUNNING? Asked by the reaper's tests, which assert that something
// the reaper killed is gone.
//
// `process.kill(pid, 0)` cannot answer it. A process that has been killed but whose
// parent has not yet reaped it is a ZOMBIE: it holds its pid, it accepts signal 0, and
// `pgrep -f` still lists it — while being, in every sense the reaper cares about, dead.
// Who reaps it and how fast is the environment's business, not the reaper's: a normal
// init does it in microseconds, and a container whose pid 1 is an application process
// can take a second or more (measured at ~1.7s in one, against tests that waited 200ms).
// Both were reporting a browser the reaper had already killed as still running.
//
// `ps -o stat=` is the portable way to see the difference: a zombie's state starts with
// `Z` on Linux and on macOS alike, and a pid nobody holds prints nothing at all. It adds
// no dependency the harness did not already have — `harness/reaper.ts` shells out to
// `ps` and `pgrep` for the same reason, that there is no portable API for either.
export function isRunning(pid: number | string): boolean {
  const state = (spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).stdout ?? "").trim();
  return state !== "" && !state.startsWith("Z");
}

// The pids of `candidates` that are still running — zombies and pids nobody holds drop
// out. Used to sift `pgrep` output, which lists a zombie under its own name.
export function stillRunning(candidates: string[]): string[] {
  return candidates.filter(isRunning);
}

// Wait for `condition`, rather than for a fixed delay.
//
// The reaper's kill is synchronous, but nothing else on this path is: the process it
// kills has to be scheduled to die, and — for the abandoned-browser cases — the holder
// has to reach its exit hook first. A fixed settle has to be longer than the slowest
// machine the suite will ever run on, or it fails there; polling is as fast as the
// machine is and still correct on the slow one. `what` is the failure message, so a
// genuine regression reads as what did not happen rather than as a timeout.
export async function eventually(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
