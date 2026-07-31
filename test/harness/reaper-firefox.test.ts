import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "../../harness/firefox";

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
function processesIn(profileDir: string): string[] {
  return (
    spawnSync("pgrep", ["-f", profileDir], { encoding: "utf-8" }).stdout
      ?.split("\n")
      .filter(Boolean) ?? []
  );
}

function geckodriverPids(): Set<string> {
  return new Set(
    spawnSync("pgrep", ["-f", "geckodriver"], { encoding: "utf-8" }).stdout
      ?.split("\n")
      .filter(Boolean) ?? [],
  );
}

const settle = () => new Promise((r) => setTimeout(r, 500));

describe("a launched Firefox", () => {
  it("is gone, with its geckodriver and its profile, once the session closes", async () => {
    // A developer's own Firefox and any concurrent `npm run manual` are running in
    // profiles of their own; only geckodrivers started *during* this test may be
    // claimed by it.
    const geckodriversBefore = geckodriverPids();

    const session = await launch();
    expect(processesIn(session.profileDir).length).toBeGreaterThan(0);
    const ours = [...geckodriverPids()].filter((pid) => !geckodriversBefore.has(pid));
    expect(ours.length).toBeGreaterThan(0);

    await session.close();
    await settle();

    expect(processesIn(session.profileDir)).toEqual([]);
    expect([...geckodriverPids()].filter((pid) => ours.includes(pid))).toEqual([]);
    expect(existsSync(session.profileDir)).toBe(false);
  });

  it("is gone, with its geckodriver, when the process holding it is killed", async () => {
    // A session nobody ever closes, in a process that is then terminated — a run cut
    // short, an IDE stop button. TERMINATION is what makes this the reaper's case and
    // not Selenium's: Selenium kills its geckodriver from a `process.once("exit")` hook
    // of its own (selenium-webdriver/io/exec.js:134), which covers a clean exit and an
    // uncaught throw, but node does not emit "exit" for a process killed by a signal.
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
    await settle();

    expect(processesIn(profileDir)).toEqual([]);
    expect([...geckodriverPids()].filter((pid) => !geckodriversBefore.has(pid))).toEqual([]);
    expect(existsSync(profileDir)).toBe(false);
  }, 60_000);
});
