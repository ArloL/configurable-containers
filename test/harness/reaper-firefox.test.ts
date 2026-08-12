import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "../../harness/firefox";
import { eventually, stillRunning } from "./process-state";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ABANDON = fileURLToPath(new URL("./abandon-session.ts", import.meta.url));

// The end-to-end half of the reaper's guarantee: test/harness/reaper.test.ts proves the
// kill mechanism against stand-in processes, and this proves the mechanism is actually
// pointed at a real browser — that Firefox does carry the harness's profile path in its
// argv, and that a launched session leaves no process of any kind behind.
//
// Worth stating what "no stray" has to mean here: killing the Firefox parent is not
// enough on its own. One session is ~8 processes (parent plus a plugin-container per
// tab/utility/rdd), and geckodriver — which Selenium `unref()`s — is a stray in its own
// right. `pgrep -f <profileDir>` sees the whole browser side of that; the driver side is
// asserted separately, because geckodriver's own command line carries only a port.

// Every process whose command line mentions this profile — the browser and every content
// process under it.
//
// `stillRunning` sifts out the ones that are only zombies: a process the reaper killed
// keeps its pid, and its name, until whatever inherited it reaps it — and `pgrep` lists
// it throughout. How long that takes is the environment's business (see
// ./process-state.ts), so counting a zombie here made the reaper look broken on a
// machine where it had worked perfectly.
function processesIn(profileDir: string): string[] {
  return stillRunning(pgrep(profileDir));
}

function geckodriverPids(): Set<string> {
  return new Set(stillRunning(pgrep("geckodriver")));
}

function pgrep(pattern: string): string[] {
  return spawnSync("pgrep", ["-f", pattern], { encoding: "utf-8" }).stdout?.split("\n").filter(Boolean) ?? [];
}

// Strays that were already there are not this test's to account for: a developer's own
// Firefox, a concurrent `npm run manual`.
const straysBesides = (before: Set<string>) => [...geckodriverPids()].filter((pid) => !before.has(pid));

describe("a launched Firefox", () => {
  it("is gone, with its geckodriver and its profile, once the session closes", async () => {
    // A developer's own Firefox and any concurrent `npm run manual` are running in
    // profiles of their own; only geckodrivers started *during* this test may be
    // claimed by it.
    const geckodriversBefore = geckodriverPids();

    const session = await launch();
    expect(processesIn(session.profileDir).length).toBeGreaterThan(0);
    const ours = straysBesides(geckodriversBefore);
    expect(ours.length).toBeGreaterThan(0);

    await session.close();

    await eventually(() => processesIn(session.profileDir).length === 0, "the browser was still running");
    await eventually(
      () => [...geckodriverPids()].filter((pid) => ours.includes(pid)).length === 0,
      "the session's geckodriver was still running",
    );
    expect(existsSync(session.profileDir)).toBe(false);
  });

  it("is gone, with its geckodriver, when the process holding it is killed", async () => {
    // A session nobody ever closes, in a process that is then terminated — a run cut
    // short, an IDE stop button. TERMINATION is what makes this the reaper's case and
    // not Selenium's: Selenium kills its geckodriver from a `process.once("exit")` hook
    // of its own (selenium-webdriver/io/exec.js, `onProcessExit`), which covers a clean
    // exit and an uncaught throw, but node emits no "exit" for a signalled process.
    // Only the reaper's signal handlers run here. (Ctrl+C in a terminal is the benign
    // version: geckodriver shares the foreground process group and is signalled too.)
    const geckodriversBefore = geckodriverPids();

    // `node --import tsx`, not the tsx CLI: the CLI runs the script in a child process
    // of its own, so a SIGTERM aimed at it would not reach the process that owns the
    // reaper. Plain node cannot run the harness at all — it imports its own modules
    // without file extensions, which node's native TypeScript support rejects.
    const proc = spawn(process.execPath, ["--import", "tsx", ABANDON], {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: REPO,
    });
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      proc.stdout.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\n")) resolve(buf.trim());
      });
      proc.once("exit", (code) => reject(new Error(`child exited (${code}) without launching`)));
    });
    const { profileDir } = JSON.parse(line);
    expect(processesIn(profileDir).length).toBeGreaterThan(0);

    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));

    await eventually(() => processesIn(profileDir).length === 0, "the abandoned browser was still running");
    await eventually(() => straysBesides(geckodriversBefore).length === 0, "its geckodriver was still running");
    expect(existsSync(profileDir)).toBe(false);
  }, 60_000);
});
