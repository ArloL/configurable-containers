import { Builder, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startServer, type TestServer } from "./server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = path.resolve(HERE, "../extensions/probe");

export interface Session {
  driver: WebDriver;
  serverUrl: string;
  close(): Promise<void>;
}

// Package the unpacked probe extension into a temporary .xpi (a zip), because
// geckodriver's installAddon expects an addon file, not a directory.
function buildProbeXpi(): { xpiPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-e2e-xpi-"));
  const xpiPath = path.join(dir, "probe.xpi");
  execFileSync("zip", ["-r", "-FS", xpiPath, ".", "-x", ".*"], { cwd: PROBE_DIR });
  return { xpiPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function launch(): Promise<Session> {
  const server: TestServer = await startServer();
  const { xpiPath, cleanup } = buildProbeXpi();

  const options = new firefox.Options();
  options.addArguments("-headless");
  // Enable the containers feature so the probe's contextualIdentities call works.
  options.setPreference("privacy.userContext.enabled", true);
  options.setPreference("xpinstall.signatures.required", false);

  // In CI the runner's default Firefox is a snap geckodriver can't drive; point
  // Selenium at the real Firefox the workflow installed when FIREFOX_BIN is set.
  // Unset locally, this is a no-op and the system Firefox is used.
  const firefoxBin = process.env.FIREFOX_BIN;
  if (firefoxBin) {
    options.setBinary(firefoxBin);
  }

  let driver: WebDriver;
  try {
    driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
    // Temporary install of the unsigned probe; runs its startup (creates a container tab).
    // installAddon is defined on firefox.Driver (a WebDriver subclass); the Builder's
    // return type is the base WebDriver, so narrow it here for the call.
    await (driver as unknown as firefox.Driver).installAddon(xpiPath, true);
  } catch (err) {
    await server.close();
    cleanup();
    throw err;
  }

  return {
    driver,
    serverUrl: server.url,
    async close() {
      await driver.quit();
      await server.close();
      cleanup();
    },
  };
}

// Poll the CURRENT window's title until the probe has written "CSID:<store>".
export async function readCookieStoreId(driver: WebDriver, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = "";
  while (Date.now() < deadline) {
    lastTitle = await driver.getTitle();
    const m = lastTitle.match(/^CSID:(.+)$/);
    if (m) return m[1];
    await driver.sleep(100);
  }
  throw new Error(`Timed out waiting for probe report; last title: ${JSON.stringify(lastTitle)}`);
}

// Navigate every window handle to `url` (triggering a probe report on each) and
// collect their cookieStoreIds. Retries until a container store appears or the
// deadline passes, tolerating the probe's container tab arriving asynchronously.
export async function collectStoresUntilContainer(
  driver: WebDriver,
  url: string,
  timeoutMs = 15_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let stores: string[] = [];
  while (Date.now() < deadline) {
    stores = [];
    const handles = await driver.getAllWindowHandles();
    for (const handle of handles) {
      try {
        await driver.switchTo().window(handle);
        await driver.get(url);
        stores.push(await readCookieStoreId(driver, 2000));
      } catch {
        // A handle may have closed mid-loop; skip it this round.
      }
    }
    if (stores.some((s) => /^firefox-container-\d+$/.test(s))) return stores;
    await driver.sleep(500);
  }
  return stores;
}
