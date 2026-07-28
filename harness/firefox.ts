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

// Default fake domains resolved to loopback for e2e tests.
const DEFAULT_LOCAL_DOMAINS = [
  "work.example", "nomatch.example", "redirect.example", "figma.example", "youtube.example",
];

export interface Session {
  driver: WebDriver;
  serverUrl: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  extensions?: ("probe" | "cc")[];
  ccGraceMs?: number; // grace passed to the cc build (default: production 300000)
  ccRedirectorDelayMs?: number; // redirector-close delay (default: production 2000)
  headless?: boolean; // default true; set false for manual/interactive testing
  configYaml?: string; // override the bundled config (manual launcher passes the real one)
  localDomains?: string[] | null; // domains resolved to loopback; default = test domains, null = none
  // Page the first tab opens on. Marionette otherwise starts every session at
  // about:blank, which auto-temp deliberately ignores — pass "about:newtab" to
  // exercise (or, in manual mode, actually see) the auto-temp startup sweep.
  startupUrl?: string;
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
async function buildXpiFor(
  ext: "probe" | "cc",
  opts: { graceMs?: number; redirectorDelayMs?: number; configYaml?: string },
): Promise<{ xpiPath: string; cleanup: () => void }> {
  if (ext === "cc") await buildExtension(opts);
  return zipDir(EXT_DIRS[ext]);
}

export async function launch(opts: LaunchOptions = {}): Promise<Session> {
  const extensions = opts.extensions ?? ["probe"];
  const server: TestServer = await startServer();

  const xpis: { xpiPath: string; cleanup: () => void }[] = [];
  for (const ext of extensions) {
    xpis.push(
      await buildXpiFor(ext, {
        graceMs: opts.ccGraceMs,
        redirectorDelayMs: opts.ccRedirectorDelayMs,
        configYaml: opts.configYaml,
      }),
    );
  }
  const cleanupXpis = () => xpis.forEach((x) => x.cleanup());

  const options = new firefox.Options();
  if (opts.headless !== false) options.addArguments("-headless");
  options.setPreference("privacy.userContext.enabled", true);
  options.setPreference("xpinstall.signatures.required", false);
  if (opts.startupUrl) {
    options.setPreference("browser.startup.page", 1); // 1 = open the homepage
    options.setPreference("browser.startup.homepage", opts.startupUrl);
  }
  // Resolve the test's fake domains straight to loopback (cross-platform, no DNS).
  // Skipped when localDomains is null (live-site manual testing).
  const domains = opts.localDomains !== undefined ? opts.localDomains : DEFAULT_LOCAL_DOMAINS;
  if (domains && domains.length > 0) {
    options.setPreference("network.dns.localDomains", domains.join(","));
  }

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

// The localStorage.cc_script value the page's own first script observed — "1" iff CC's
// document_start script ran before the page's scripts (F12 timing proof).
export async function readScriptAtStart(driver: WebDriver): Promise<string> {
  return (await driver.executeScript(
    "return document.documentElement.getAttribute('data-cc-script-at-start') || '';"
  )) as string;
}

// Generic localStorage read in the current tab (containers partition localStorage, so
// this reads the current tab's own container partition).
export async function readLocalStorage(driver: WebDriver, key: string): Promise<string | null> {
  return (await driver.executeScript(
    `return localStorage.getItem(${JSON.stringify(key)});`
  )) as string | null;
}

export interface ProbeTab {
  id: number;
  url: string;
  cookieStoreId: string;
  container: string;
}

// Send a command to the probe extension and return its reply.
//
// The driver must currently be on a probe-reported http(s) page: the probe injects a
// `cc-probe-cmd` DOM listener there that relays to its background (which holds the
// privileged APIs) and writes the reply back into data-cc-result. This is the only way
// a test can reach browser.* — WebDriver has no extension APIs.
export async function probeCommand<T>(
  driver: WebDriver,
  cmd: string,
  params: Record<string, unknown> = {},
  timeoutMs = 8000,
): Promise<T> {
  const detail = JSON.stringify({ cmd, ...params });
  await driver.executeScript(
    "document.documentElement.removeAttribute('data-cc-result');" +
    `document.dispatchEvent(new CustomEvent('cc-probe-cmd', { detail: ${detail} }));`
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = (await driver.executeScript(
      "return document.documentElement.getAttribute('data-cc-result');"
    )) as string | null;
    if (raw) return JSON.parse(raw) as T;
    await driver.sleep(100);
  }
  throw new Error(`probe command ${JSON.stringify(cmd)} timed out after ${timeoutMs}ms`);
}

// Open a REAL new tab — `browser.tabs.create({})`, exactly what Ctrl/Cmd+T does:
// about:newtab in the default container. WebDriver's switchTo().newWindow("tab")
// makes an about:blank tab instead, which auto-temp deliberately ignores, so it
// cannot exercise auto-temp at all. Note WebDriver also cannot *navigate* to
// about:newtab ("Navigation to about:newtab is not allowed in this context").
export function openRealNewTab(driver: WebDriver): Promise<{ id: number; url: string; cookieStoreId: string }> {
  return probeCommand(driver, "newTab");
}

// Every tab's id/url/cookieStoreId/container name, straight from browser.tabs.query.
// Needed because about: pages take no content script, so the probe's usual
// title/attribute reporting can't see a new-tab page's container.
export function listTabs(driver: WebDriver): Promise<ProbeTab[]> {
  return probeCommand(driver, "tabs");
}

// Navigate a specific tab by its browser.tabs id — what typing a URL into that tab's
// address bar does. WebDriver can only drive the tab it is switched to, and offers no
// way to map a window handle to a tab id, so an about:newtab tab is otherwise
// unaddressable.
export function navigateTab(driver: WebDriver, tabId: number, url: string): Promise<{ ok: boolean }> {
  return probeCommand(driver, "nav", { id: tabId, url });
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
