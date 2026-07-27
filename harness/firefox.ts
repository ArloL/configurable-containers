import { Builder, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startServer, type TestServer } from "./server";
import { buildExtension } from "./build-extension";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIRS: Record<"probe" | "cc", string> = {
  probe: path.resolve(HERE, "../extensions/probe"),
  cc: path.resolve(HERE, "../extensions/cc"),
};

export interface Session {
  driver: WebDriver;
  serverUrl: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensions?: ("probe" | "cc")[];
  ccGraceMs?: number; // grace passed to the cc build (default: production 300000)
}

// Zip an unpacked extension directory into a temporary .xpi (geckodriver's
// installAddon wants a file, not a directory).
function zipDir(dir: string): { xpiPath: string; cleanup: () => void } {
  const out = mkdtempSync(path.join(tmpdir(), "cc-e2e-xpi-"));
  const xpiPath = path.join(out, "addon.xpi");
  execFileSync("zip", ["-r", "-FS", xpiPath, ".", "-x", ".*"], { cwd: dir });
  return { xpiPath, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

// Build (cc only) then zip the given extension into an installable .xpi.
async function buildXpiFor(ext: "probe" | "cc", ccGraceMs?: number): Promise<{ xpiPath: string; cleanup: () => void }> {
  if (ext === "cc") await buildExtension({ graceMs: ccGraceMs });
  return zipDir(EXT_DIRS[ext]);
}

export async function launch(opts: LaunchOptions = {}): Promise<Session> {
  const extensions = opts.extensions ?? ["probe"];
  const server: TestServer = await startServer();

  const xpis: { xpiPath: string; cleanup: () => void }[] = [];
  for (const ext of extensions) {
    xpis.push(await buildXpiFor(ext, opts.ccGraceMs));
  }
  const cleanupXpis = () => xpis.forEach((x) => x.cleanup());

  const options = new firefox.Options();
  options.addArguments("-headless");
  options.setPreference("privacy.userContext.enabled", true);
  options.setPreference("xpinstall.signatures.required", false);
  // Resolve the test's fake domains straight to loopback (cross-platform, no DNS).
  options.setPreference("network.dns.localDomains", "work.example,nomatch.example");

  const firefoxBin = process.env.FIREFOX_BIN;
  if (firefoxBin) {
    options.setBinary(firefoxBin);
  }

  let driver: WebDriver;
  try {
    driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
    for (const { xpiPath } of xpis) {
      await (driver as unknown as firefox.Driver).installAddon(xpiPath, true);
    }
  } catch (err) {
    await server.close();
    cleanupXpis();
    throw err;
  }

  return {
    driver,
    serverUrl: server.url,
    async close() {
      await driver.quit();
      await server.close();
      cleanupXpis();
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

// Read the container name the probe wrote into the current tab's DOM.
export async function readContainerName(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-container') || '';"
  )) as string;
}

// Read the live container-name list the probe wrote into the current tab's DOM.
export async function readContainerList(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-containers') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}

// The Cookie header the server received (F12 wire side), reflected into the body.
export async function readSeenCookie(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.body.getAttribute('data-seen-cookie') || '';"
  )) as string;
}

// Cookie names visible in the tab's OWN store for its URL (probe getAll).
export async function readCookieNamesHere(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-cookies-here') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}

// Cookie names visible in the DEFAULT store for the tab's URL — the F11 counter-check.
export async function readCookieNamesDefault(driver: WebDriver): Promise<string[]> {
  const raw = (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-cookies-default') || '';"
  )) as string;
  return raw ? raw.split(",") : [];
}

// Poll window handles (WITHOUT re-navigating them — CC does the reopening) until a
// tab shows `url` in a non-default container; return its store + reported name.
export async function awaitContainerTab(
  driver: WebDriver,
  url: string,
  timeoutMs = 15_000,
): Promise<{ store: string; name: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const handle of await driver.getAllWindowHandles()) {
      try {
        await driver.switchTo().window(handle);
        const m = (await driver.getTitle()).match(/^CSID:(.+)$/);
        if (m && /^firefox-container-\d+$/.test(m[1]) && (await driver.getCurrentUrl()).startsWith(url)) {
          return { store: m[1], name: await readContainerName(driver) };
        }
      } catch {
        // A handle may have closed mid-loop; skip it this round.
      }
    }
    await driver.sleep(300);
  }
  throw new Error(`no container tab for ${url} within ${timeoutMs}ms`);
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
